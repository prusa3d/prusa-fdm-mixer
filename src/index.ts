/**
 * prusa-fdm-mixer — public API
 *
 * Predicts the visible color of multi-color FDM 3D prints, where filaments
 * are interleaved at the layer level. The default `mixFilaments` is the
 * v7 model calibrated against measured Prusa XL prints.
 *
 * Comparison models (`mixLinearRgb`, `mixKubelkaMunk`, `mixFilamentMixer`)
 * are exported so consumers can A/B test against the same input format.
 *
 * @example
 * ```ts
 * import { mixFilaments } from 'prusa-fdm-mixer';
 *
 * const result = mixFilaments([
 *   { hex: '#009bc3', ratio: 0.5 },  // cyan
 *   { hex: '#f6b921', ratio: 0.5 },  // yellow
 * ]);
 * console.log(result.hex);   // '#5c8c5e' or similar (predicted)
 * console.log(result.lab);   // { L, a, b }
 * ```
 */

export {
  mixFilaments,
  type FilamentPart,
  type MixResult,
} from './filament-mix.js';

export { mixLinearRgb } from './linear-rgb.js';
export { mixGammaRgb } from './gamma-rgb.js';
export { mixKubelkaMunk } from './kubelka-munk.js';
export { mixFilamentMixer } from './filament-mixer.js';
export { mixHueforgeStyle, type HueforgeStylePart } from './hueforge-style.js';

export {
  hexToRgb,
  rgbToHex,
  hexToLab,
  labToHex,
  srgbToLinear,
  linearToSrgb,
  chroma,
  hueDegrees,
  type RGB,
  type LAB,
} from './color.js';

export { deltaE2000 } from './delta-e.js';
