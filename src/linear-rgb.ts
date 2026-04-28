/**
 * Linear sRGB mixing — naive ratio-weighted average in 0–255 sRGB space.
 *
 * Historical baseline: this is what BambuStudio shipped until 2026-04-17,
 * when commit bcb67bd5d replaced it with the FilamentMixer polynomial
 * pigment-mix model (see `mixBambuStudio`). Most other slicers still use
 * this naive approach. Useful as a no-calibration baseline, but it
 * consistently over-predicts brightness — mixes look too light/washed
 * out vs reality. For "linear RGB done correctly" with proper gamma
 * decoding, see `mixGammaRgb`.
 */

import {
  hexToRgb,
  rgbToHex,
  hexToLab,
  type LAB,
  type RGB,
} from './color.js';
import type { FilamentPart, MixResult } from './filament-mix.js';

export function mixLinearRgb(parts: FilamentPart[]): MixResult {
  if (parts.length === 0) throw new Error('mixLinearRgb: empty parts');
  const total = parts.reduce((s, p) => s + p.ratio, 0);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of parts) {
    const rgb = hexToRgb(p.hex);
    const w = p.ratio / total;
    r += rgb.r * w;
    g += rgb.g * w;
    b += rgb.b * w;
  }
  const rgb: RGB = { r, g, b };
  const hex = rgbToHex(rgb);
  const lab: LAB = hexToLab(hex);
  return { hex, lab, rgb };
}
