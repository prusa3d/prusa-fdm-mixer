/**
 * Kubelka-Munk subtractive mixing.
 *
 * Models each filament's reflectance through the K/S relationship, mixes the
 * K and S components ratio-weighted, then re-derives reflectance. Closer to
 * actual pigment physics than linear RGB, but still falls down on saturated
 * complementaries because real prints are layered (a directional structure)
 * not a homogeneous pigment paste.
 *
 * Reference: Kubelka, P. (1948). "New Contributions to the Optics of
 * Intensely Light-Scattering Materials. Part I."
 */

import {
  hexToRgb,
  rgbToHex,
  srgbToLinear,
  linearToSrgb,
  hexToLab,
  type LAB,
  type RGB,
} from './color.js';
import type { FilamentPart, MixResult } from './prusa-fdm-mixer.js';

/**
 * Reflectance R → K/S (the "Kubelka-Munk function"). Higher means more
 * absorbing relative to scattering.
 */
function kOverS(R: number): number {
  const Rc = Math.max(0.001, Math.min(0.999, R));
  return Math.pow(1 - Rc, 2) / (2 * Rc);
}

/** K/S → reflectance. */
function reflectanceFromKS(KS: number): number {
  return 1 + KS - Math.sqrt(KS * KS + 2 * KS);
}

export function mixKubelkaMunk(parts: FilamentPart[]): MixResult {
  if (parts.length === 0) throw new Error('mixKubelkaMunk: empty parts');
  const total = parts.reduce((s, p) => s + p.ratio, 0);

  // Pure-input early return: KM has small numerical drift from clamping
  // reflectance away from 0/1 (to avoid div-by-zero in K/S), so a pure
  // component would otherwise round-trip with a 1-channel offset.
  for (const p of parts) {
    if (p.ratio / total >= 0.9999) {
      const rgb = hexToRgb(p.hex);
      const hex = rgbToHex(rgb);
      return { hex, lab: hexToLab(hex), rgb };
    }
  }

  // Mix K/S per channel ratio-weighted, then convert back to reflectance.
  let ksR = 0;
  let ksG = 0;
  let ksB = 0;
  for (const p of parts) {
    const rgb = hexToRgb(p.hex);
    const w = p.ratio / total;
    ksR += kOverS(srgbToLinear(rgb.r)) * w;
    ksG += kOverS(srgbToLinear(rgb.g)) * w;
    ksB += kOverS(srgbToLinear(rgb.b)) * w;
  }

  const r = linearToSrgb(reflectanceFromKS(ksR));
  const g = linearToSrgb(reflectanceFromKS(ksG));
  const b = linearToSrgb(reflectanceFromKS(ksB));
  const rgb: RGB = { r, g, b };
  const hex = rgbToHex(rgb);
  const lab: LAB = hexToLab(hex);
  return { hex, lab, rgb };
}
