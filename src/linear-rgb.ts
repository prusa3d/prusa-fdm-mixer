/**
 * Linear sRGB mixing — naive ratio-weighted average in 0–255 sRGB space.
 *
 * This is what BambuStudio and most slicers use today. It's a useful
 * baseline because it requires no calibration, but it consistently
 * over-predicts brightness (mixes look too light/washed out vs reality).
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
