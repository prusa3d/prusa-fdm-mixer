/**
 * filament-mixer — polynomial pigment-mix model by Justin H. Rahb (MIT),
 * https://github.com/justinh-rahb/filament-mixer.
 *
 * The library is a degree-4 polynomial regression in 7 inputs —
 * [r1,g1,b1,r2,g2,b2,t] on 0–255 sRGB — trained to approximate Mixbox's
 * pigment-mix behavior (declared mean ΔE ~2.07 vs Mixbox).
 *
 * Coefficients (POWERS, COEF, INTERCEPT) are auto-generated and copied
 * verbatim from BambuStudio's vendored copy at
 * `src/libslic3r/FilamentMixerModel.hpp` (BS pulled in the library on
 * 2026-04-17, commit bcb67bd5d, after Bambu publicly credited
 * Ratdoux's OrcaSlicer-FullSpectrum fork as the inspiration). Do not
 * hand-edit the coefficients file.
 *
 * For three or more components there is no closed-form formula; the
 * library accumulates pairwise — blend the running result with the next
 * color at t = w_next / (w_running + w_next). We replicate that exactly,
 * matching BS's `blend_color_multi`.
 */

import { hexToRgb, rgbToHex, hexToLab, type LAB, type RGB } from './color.js';
import type { FilamentPart, MixResult } from './filament-mix.js';
import { POWERS, COEF, INTERCEPT, N_FEATURES, N_INPUTS } from './filament-mixer-coefficients.js';

function computePolyFeatures(x: number[]): Float64Array {
  const out = new Float64Array(N_FEATURES);
  for (let i = 0; i < N_FEATURES; i++) {
    let val = 1.0;
    const row = POWERS[i]!;
    for (let j = 0; j < N_INPUTS; j++) {
      const exp = row[j]!;
      if (exp !== 0) {
        const base = x[j]!;
        let p = 1.0;
        for (let e = 0; e < exp; e++) p *= base;
        val *= p;
      }
    }
    out[i] = val;
  }
  return out;
}

// Two-color lerp matching the C++ `filament_mixer::lerp` signature on
// 0–255 unsigned-byte sRGB. t in [0,1]; t=0 returns color1, t=1 returns
// color2. Truncation to int matches `static_cast<int>(sum)` (toward zero).
function lerpBytes(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
  t: number,
): [number, number, number] {
  if (t <= 0) return [r1, g1, b1];
  if (t >= 1) return [r2, g2, b2];

  const features = computePolyFeatures([r1, g1, b1, r2, g2, b2, t]);
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let sum = INTERCEPT[c]!;
    for (let i = 0; i < N_FEATURES; i++) sum += features[i]! * COEF[i]![c]!;
    let v = Math.trunc(sum);
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    out[c] = v;
  }
  return out;
}

export function mixFilamentMixer(parts: FilamentPart[]): MixResult {
  if (parts.length === 0) throw new Error('mixFilamentMixer: empty parts');

  // Drop zero-ratio components, then pairwise-accumulate exactly the way
  // BambuStudio's `blend_color_multi` does: take part[0] as the running
  // result, then for each subsequent part blend at t = w / (acc + w),
  // where weights are the per-part ratios (any units — only the ratio of
  // running-acc to next-weight matters).
  const active = parts.filter((p) => p.ratio > 0);
  if (active.length === 0) throw new Error('mixFilamentMixer: all ratios are zero');

  const first = hexToRgb(active[0]!.hex);
  let r = Math.round(first.r);
  let g = Math.round(first.g);
  let b = Math.round(first.b);
  let acc = active[0]!.ratio;

  for (let i = 1; i < active.length; i++) {
    const next = hexToRgb(active[i]!.hex);
    const w = active[i]!.ratio;
    const t = w / (acc + w);
    [r, g, b] = lerpBytes(
      r, g, b,
      Math.round(next.r), Math.round(next.g), Math.round(next.b),
      t,
    );
    acc += w;
  }

  const rgb: RGB = { r, g, b };
  const hex = rgbToHex(rgb);
  const lab: LAB = hexToLab(hex);
  return { hex, lab, rgb };
}
