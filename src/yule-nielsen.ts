/**
 * Yule-Nielsen color mixing — pure baseline, no empirical corrections.
 *
 * Per channel in linear-light RGB:
 *   (Σ ratio · linear^(1/n))^n
 *
 * `yuleNielsenMix` is the primitive (returns RGB) and is reused as step 1 of
 * the v7 model in `prusa-fdm-mixer.ts`. `mixYuleNielsen` is the public
 * comparison-baseline wrapper that returns `MixResult` like the other mixers.
 */

import {
  hexToRgb,
  rgbToHex,
  srgbToLinear,
  linearToSrgb,
  hexToLab,
  type RGB,
} from './color.js';
import type { FilamentPart, MixResult } from './prusa-fdm-mixer.js';

export function yuleNielsenMix(parts: FilamentPart[], n = 3.0): RGB {
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

export function mixYuleNielsen(parts: FilamentPart[]): MixResult {
  const rgb = yuleNielsenMix(parts, 3.0);
  const hex = rgbToHex(rgb);
  const lab = hexToLab(hex);
  return { hex, lab, rgb };
}
