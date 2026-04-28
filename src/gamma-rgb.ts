/**
 * Gamma-corrected linear RGB mixing.
 *
 * Converts each filament's sRGB hex to linear-light using the sRGB EOTF
 * (gamma 2.4 with the linear toe), takes the ratio-weighted average in
 * linear space, and re-encodes to sRGB. This is what most people *think*
 * BambuStudio does (and what naive intuition suggests "linear RGB" should
 * mean) — but BambuStudio actually ships a polynomial pigment-mix model;
 * see `mixBambuStudio`.
 *
 * Useful as a baseline that's strictly better than naive sRGB averaging
 * for emissive blending but still wrong for subtractive pigment mixing
 * (printed filament): it keeps mixes too bright and too neutral.
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
import type { FilamentPart, MixResult } from './filament-mix.js';

export function mixGammaRgb(parts: FilamentPart[]): MixResult {
  if (parts.length === 0) throw new Error('mixGammaRgb: empty parts');
  const total = parts.reduce((s, p) => s + p.ratio, 0);
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of parts) {
    const rgb = hexToRgb(p.hex);
    const w = p.ratio / total;
    r += srgbToLinear(rgb.r) * w;
    g += srgbToLinear(rgb.g) * w;
    b += srgbToLinear(rgb.b) * w;
  }
  const out: RGB = {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(b),
  };
  const hex = rgbToHex(out);
  const lab: LAB = hexToLab(hex);
  return { hex, lab, rgb: out };
}
