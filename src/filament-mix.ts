/**
 * Filament color mixing model — v7
 *
 * Predicts the visible color of a multi-filament FDM print where colors are
 * interleaved at the layer level, calibrated against measured prints.
 *
 * Architecture (in order of application):
 *
 *   1. Yule-Nielsen base prediction (n = 3.0) in linear-light RGB
 *   2. Convert to LAB
 *   3. Lightness correction:  ΔL = -0.0477·L_gap - 2.112,
 *      plus an additional -0.060·(L_gap - 15) when L_gap > 15
 *   4. Chroma correction:     ΔC = 0.2780·predicted_L - 15.580
 *   5. Cyan-band hue rotation: peak +10.38° at hue 210° with linear
 *      fall-off ±30°
 *   6. Bell-curve weight w = N^N · ∏ratios scales the strength of all
 *      corrections so that pure components are returned exactly and 50:50
 *      mixes get the full correction.
 *
 * The corrections were fitted on 107 cleaned 2-color samples printed on
 * Prusa XL filaments. See data/fitting-set.jsonl.
 *
 * All constants live in `V7Params`; `DEFAULT_V7_PARAMS` carries the shipped
 * tuned values. `mixFilamentsWithParams` is exported for the autotuner
 * (apps/tuner) — public consumers should keep using `mixFilaments`.
 *
 * Inference: O(N) per prediction, no runtime dataset access.
 */

import {
  hexToRgb,
  rgbToHex,
  srgbToLinear,
  linearToSrgb,
  hexToLab,
  labToHex,
  chroma,
  hueDegrees,
  type RGB,
  type LAB,
} from './color.js';

/** A single filament part of a recipe. Ratios across all parts should sum to 1. */
export interface FilamentPart {
  /** sRGB hex of the filament (with or without leading `#`). */
  hex: string;
  /** Ratio in the recipe, in [0, 1]. All ratios should sum to 1. */
  ratio: number;
}

/** Result of a mix prediction. */
export interface MixResult {
  /** Predicted sRGB hex. */
  hex: string;
  /** Predicted CIELAB. */
  lab: LAB;
  /** Predicted sRGB (0–255 floats; not yet rounded). */
  rgb: RGB;
}

// ---------------------------------------------------------------------------
// Tunable parameters
// ---------------------------------------------------------------------------

/**
 * All tunable constants of the v7 model. Bundled into a single object so the
 * autotuner can sweep them without having to monkey-patch the module.
 *
 * Public consumers should not touch this — call `mixFilaments(parts)` which
 * uses `DEFAULT_V7_PARAMS`.
 */
export interface V7Params {
  /** Yule-Nielsen exponent for the base prediction. */
  YN_N: number;

  /** Lightness correction: ΔL = L_BASE_SLOPE · L_gap + L_BASE_INTERCEPT */
  L_BASE_SLOPE: number;
  L_BASE_INTERCEPT: number;

  /** Extra lightness pull when L_gap exceeds knee. */
  L_KNEE: number;
  L_KNEE_SLOPE: number;

  /** Chroma correction: ΔC = C_SLOPE · predicted_L + C_INTERCEPT */
  C_SLOPE: number;
  C_INTERCEPT: number;

  /** Cyan-band hue rotation. Peak +HUE_PEAK degrees at HUE_CENTER, linear fall-off ±HUE_FALLOFF. */
  HUE_CENTER: number;
  HUE_FALLOFF: number;
  HUE_PEAK: number;

  /** Bell-curve correction-weight peak multiplier. */
  PEAK_STRENGTH: number;
}

/** Shipped tuned constants (v7). */
export const DEFAULT_V7_PARAMS: V7Params = {
  YN_N: 3.0,
  L_BASE_SLOPE: -0.0477,
  L_BASE_INTERCEPT: -2.112,
  L_KNEE: 15,
  L_KNEE_SLOPE: -0.06,
  C_SLOPE: 0.278,
  C_INTERCEPT: -15.58,
  HUE_CENTER: 210,
  HUE_FALLOFF: 30,
  HUE_PEAK: 10.38,
  PEAK_STRENGTH: 1.375,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Predict the color of a filament mix using the shipped v7 constants.
 *
 * @param parts Array of {hex, ratio}. Ratios should sum to 1.
 * @returns Predicted color as { hex, lab, rgb }.
 *
 * Throws if `parts` is empty or any ratio is negative.
 */
export function mixFilaments(parts: FilamentPart[]): MixResult {
  return mixFilamentsWithParams(parts, DEFAULT_V7_PARAMS);
}

/**
 * Same as `mixFilaments`, but with explicit `V7Params`. Used by the autotuner
 * (apps/tuner) to evaluate candidate parameter sets against the fitting set.
 */
export function mixFilamentsWithParams(parts: FilamentPart[], params: V7Params): MixResult {
  if (parts.length === 0) {
    throw new Error('mixFilaments: parts must not be empty');
  }

  // Normalize ratios in case they don't quite sum to 1.
  const total = parts.reduce((s, p) => s + p.ratio, 0);
  if (total <= 0) {
    throw new Error('mixFilaments: ratios must sum to a positive value');
  }
  const normalized: FilamentPart[] = parts.map((p) => {
    if (p.ratio < 0) {
      throw new Error(`mixFilaments: negative ratio for ${p.hex}`);
    }
    return { hex: p.hex, ratio: p.ratio / total };
  });

  // Gradient-safety guard: if a single part has effectively all the weight,
  // return it exactly. Avoids the constant intercept term shifting pure colors.
  for (const p of normalized) {
    if (p.ratio >= 0.9999) {
      const lab = hexToLab(p.hex);
      const rgb = hexToRgb(p.hex);
      return { hex: rgbToHex(rgb), lab, rgb };
    }
  }

  // 1. Yule-Nielsen base in linear-light RGB.
  const baseRgb = yuleNielsenMix(normalized, params.YN_N);
  const baseLab = hexToLab(rgbToHex(baseRgb));

  // 2. Compute per-mix features used by the corrections.
  const Ls = normalized.map((p) => hexToLab(p.hex).L);
  const lGap = Math.max(...Ls) - Math.min(...Ls);

  // 3. Bell-curve weight: peaks at uniform mixing, zero at pure components.
  //    w = N^N * product(ratios), scaled so the peak hits PEAK_STRENGTH.
  //    For N parts at uniform 1/N each: w_raw = N^N * (1/N)^N = 1.
  const N = normalized.length;
  const ratioProduct = normalized.reduce((s, p) => s * p.ratio, 1);
  const wRaw = Math.pow(N, N) * ratioProduct; // 1 at uniform, 0 at pure.
  const w = Math.max(0, Math.min(1, wRaw)) * params.PEAK_STRENGTH;

  // 4. Lightness correction.
  let dL = params.L_BASE_SLOPE * lGap + params.L_BASE_INTERCEPT;
  if (lGap > params.L_KNEE) {
    dL += params.L_KNEE_SLOPE * (lGap - params.L_KNEE);
  }
  const newL = baseLab.L + dL * w;

  // 5. Chroma correction. Scale the (a, b) magnitude by the desired ΔC.
  const baseC = chroma(baseLab);
  let aOut = baseLab.a;
  let bOut = baseLab.b;
  if (baseC >= 0.01) {
    const targetDC = (params.C_SLOPE * newL + params.C_INTERCEPT) * w;
    const newC = Math.max(0, baseC + targetDC);
    const scale = newC / baseC;
    aOut = baseLab.a * scale;
    bOut = baseLab.b * scale;
  }

  // 6. Cyan-band hue rotation. Linear fall-off from peak at HUE_CENTER.
  const newC = Math.hypot(aOut, bOut);
  if (newC >= 1) {
    const predHue = ((Math.atan2(bOut, aOut) * 180) / Math.PI + 360) % 360;
    const distFromCenter = Math.abs(predHue - params.HUE_CENTER);
    const inBand = distFromCenter < params.HUE_FALLOFF;
    if (inBand) {
      const hCorr = params.HUE_PEAK * (1 - distFromCenter / params.HUE_FALLOFF) * w;
      const newHueRad = (((predHue + hCorr) % 360) * Math.PI) / 180;
      aOut = newC * Math.cos(newHueRad);
      bOut = newC * Math.sin(newHueRad);
    }
  }

  const lab: LAB = { L: newL, a: aOut, b: bOut };
  const hex = labToHex(lab);
  const rgb = hexToRgb(hex);
  return { hex, lab, rgb };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Yule-Nielsen mixing in linear-light RGB.
 * Each channel: `(Σ ratio · linear^(1/n))^n`.
 */
function yuleNielsenMix(parts: FilamentPart[], n: number): RGB {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of parts) {
    const rgb = hexToRgb(p.hex);
    r += Math.pow(srgbToLinear(rgb.r), 1 / n) * p.ratio;
    g += Math.pow(srgbToLinear(rgb.g), 1 / n) * p.ratio;
    b += Math.pow(srgbToLinear(rgb.b), 1 / n) * p.ratio;
  }
  return {
    r: linearToSrgb(Math.pow(Math.max(0, r), n)),
    g: linearToSrgb(Math.pow(Math.max(0, g), n)),
    b: linearToSrgb(Math.pow(Math.max(0, b), n)),
  };
}

// Internal helpers are exported for the harness and playground apps to reuse
// instead of re-implementing them.
export { chroma, hueDegrees };
