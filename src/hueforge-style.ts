/**
 * HueForge-style mixing — TD-weighted linear-RGB blend.
 *
 * HueForge itself is closed-source and solves a different problem: layered
 * translucent stacking, where light passes through layer A and reflects off
 * layer B. Our domain is bulk extrusion mixing, which has no layer order.
 * This adapter takes the one piece of HueForge's filament model that's
 * publicly defined — Transmission Distance (TD), the thickness at which
 * a filament reaches a fixed transmittance — and folds it into a mixing
 * heuristic: at the same ratio, opaque (low-TD) filaments dominate
 * translucent (high-TD) ones.
 *
 * Algorithm:
 *   weight_i = ratio_i × (1 − exp(−1 / TD_i))      // Beer-Lambert opacity
 *   linear_mix = Σ (weight_i / Σweights) × linear_i
 *
 * Mixing happens in linear-light sRGB (gamma-decoded). Filaments with no
 * supplied TD fall back to TD=1 (effectively maximum opacity), which
 * collapses the model to a plain `mixGammaRgb` baseline.
 */

import {
  hexToRgb,
  rgbToHex,
  hexToLab,
  srgbToLinear,
  linearToSrgb,
  type LAB,
  type RGB,
} from './color.js';
import type { MixResult } from './prusa-fdm-mixer.js';

/**
 * Recipe part with optional transmission distance. Local to this comparison
 * model — not added to the public `FilamentPart` because TD is irrelevant to
 * the prusa-fdm-mixer ship model. Structurally a superset of `FilamentPart`, so a plain
 * `FilamentPart[]` is also a valid input (TD defaults to 1).
 */
export interface HueforgeStylePart {
  hex: string;
  ratio: number;
  td?: number;
}

export function mixHueforgeStyle(parts: HueforgeStylePart[]): MixResult {
  if (parts.length === 0) throw new Error('mixHueforgeStyle: empty parts');

  const enriched = parts.map((p) => {
    const td = p.td ?? 1;
    const opacity = 1 - Math.exp(-1 / td);
    const rgb = hexToRgb(p.hex);
    return {
      weight: p.ratio * opacity,
      lin: {
        r: srgbToLinear(rgb.r),
        g: srgbToLinear(rgb.g),
        b: srgbToLinear(rgb.b),
      },
    };
  });

  const sumW = enriched.reduce((s, e) => s + e.weight, 0);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const e of enriched) {
    const w = e.weight / sumW;
    r += w * e.lin.r;
    g += w * e.lin.g;
    b += w * e.lin.b;
  }

  const rgb: RGB = {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(b),
  };
  const hex = rgbToHex(rgb);
  const lab: LAB = hexToLab(hex);
  return { hex, lab, rgb };
}
