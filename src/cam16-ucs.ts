/**
 * CAM16-UCS color mixing — perceptually-uniform appearance-model baseline.
 *
 * Maps each filament sRGB → CAM16 (Li & Luo 2017) under fixed viewing
 * conditions, transforms to the CAM16-UCS Uniform Color Space coordinates
 * (J', a', b'), takes a ratio-weighted Cartesian average, and inverts back
 * to sRGB. Like `mixGammaRgb`, this is a "perceptual averaging" baseline:
 * strictly better than naive sRGB averaging for smooth gradients and
 * accounts for chromatic adaptation, but still wrong for subtractive
 * pigment mixing in printed filament. Useful for showing that even the
 * most sophisticated *uncalibrated* perceptual averaging cannot reproduce
 * subtractive print behaviour.
 *
 * Viewing conditions are hardcoded to the standard CAM16 defaults:
 *   - D65 reference white (Yw=100), matching `xyzToLab` in color.ts
 *   - average surround (F=1.0, c=0.69, Nc=1.0)
 *   - La=64 cd/m² (typical sRGB display adapting luminance)
 *   - Yb=20 (neutral-gray background)
 *
 * Reference: Li, Li, Wang, Cui, Luo, Melgosa, Brill & Pointer (2017),
 *   "Comprehensive color solutions: CAM16, CAT16, and CAM16-UCS,"
 *   Color Research & Application, vol. 42 no. 6.
 */

import {
  hexToRgb,
  rgbToHex,
  hexToLab,
  rgbToXyz,
  xyzToRgb,
  type LAB,
  type RGB,
} from './color.js';
import type { FilamentPart, MixResult } from './prusa-fdm-mixer.js';

// CAT16 forward matrix (XYZ → cone-like response). Li 2017, Table 1.
const M_CAT16 = [
  [0.401288, 0.650173, -0.051461],
  [-0.250268, 1.204414, 0.045854],
  [-0.002079, 0.048952, 0.953127],
] as const;
const M_CAT16_INV = [
  [1.86206786, -1.01125463, 0.14918677],
  [0.38752654, 0.62144744, -0.00897398],
  [-0.0158415, -0.03412294, 1.04996444],
] as const;

const Xw = 95.047;
const Yw = 100;
const Zw = 108.883;
const La = 64;
const Yb = 20;
const F = 1.0;
const c = 0.69;
const Nc = 1.0;

const Rw = M_CAT16[0][0] * Xw + M_CAT16[0][1] * Yw + M_CAT16[0][2] * Zw;
const Gw = M_CAT16[1][0] * Xw + M_CAT16[1][1] * Yw + M_CAT16[1][2] * Zw;
const Bw = M_CAT16[2][0] * Xw + M_CAT16[2][1] * Yw + M_CAT16[2][2] * Zw;

const D = Math.max(0, Math.min(1, F * (1 - (1 / 3.6) * Math.exp((-La - 42) / 92))));
const D_R = (D * Yw) / Rw + 1 - D;
const D_G = (D * Yw) / Gw + 1 - D;
const D_B = (D * Yw) / Bw + 1 - D;

const k = 1 / (5 * La + 1);
const k4 = k * k * k * k;
const F_L = 0.2 * k4 * (5 * La) + 0.1 * (1 - k4) ** 2 * Math.cbrt(5 * La);
const F_L_025 = Math.pow(F_L, 0.25);

const n = Yb / Yw;
const z = 1.48 + Math.sqrt(n);
const N_bb = 0.725 * Math.pow(1 / n, 0.2);
const N_cb = N_bb;
const surroundChromaTerm = Math.pow(1.64 - Math.pow(0.29, n), 0.73);

function postAdapt(x: number): number {
  const s = Math.sign(x) || 1;
  const t = Math.pow((F_L * Math.abs(x)) / 100, 0.42);
  return s * 400 * (t / (t + 27.13)) + 0.1;
}

function postAdaptInv(xa: number): number {
  const v = xa - 0.1;
  const s = Math.sign(v) || 1;
  const av = Math.abs(v);
  // |v| = 400 t / (t + 27.13) ⇒ t = |v| 27.13 / (400 - |v|).
  const denom = Math.max(400 - av, 1e-9);
  const t = (av * 27.13) / denom;
  return s * (100 / F_L) * Math.pow(Math.max(t, 0), 1 / 0.42);
}

const Raw_ = postAdapt(D_R * Rw);
const Gaw_ = postAdapt(D_G * Gw);
const Baw_ = postAdapt(D_B * Bw);
const A_w = (2 * Raw_ + Gaw_ + Baw_ / 20 - 0.305) * N_bb;

interface UCS {
  Jp: number;
  ap: number;
  bp: number;
}

function rgbToUcs(rgb: RGB): UCS {
  // sRGB → linear → XYZ (Y in 0..1) → scale to Yw=100 used by CAM16.
  const xyz0 = rgbToXyz(rgb);
  const X = xyz0.x * 100;
  const Y = xyz0.y * 100;
  const Z = xyz0.z * 100;
  const R = M_CAT16[0][0] * X + M_CAT16[0][1] * Y + M_CAT16[0][2] * Z;
  const G = M_CAT16[1][0] * X + M_CAT16[1][1] * Y + M_CAT16[1][2] * Z;
  const B = M_CAT16[2][0] * X + M_CAT16[2][1] * Y + M_CAT16[2][2] * Z;
  const Ra = postAdapt(D_R * R);
  const Ga = postAdapt(D_G * G);
  const Ba = postAdapt(D_B * B);
  const a = Ra - (12 * Ga) / 11 + Ba / 11;
  const b = (Ra + Ga - 2 * Ba) / 9;
  const h = Math.atan2(b, a);
  const A = (2 * Ra + Ga + Ba / 20 - 0.305) * N_bb;
  const J = 100 * Math.pow(Math.max(A / A_w, 0), c * z);
  const e_t = 0.25 * (Math.cos(h + 2) + 3.8);
  const tDen = Ra + Ga + (21 * Ba) / 20;
  const tRaw =
    Math.abs(tDen) > 1e-9
      ? ((50000 / 13) * Nc * N_cb * e_t * Math.hypot(a, b)) / tDen
      : 0;
  const t = Math.max(tRaw, 0);
  const C = Math.pow(t, 0.9) * Math.sqrt(J / 100) * surroundChromaTerm;
  // CAM16-UCS uses M (colorfulness), NOT C (chroma) for a'/b' — easy bug.
  const M = C * F_L_025;
  const Jp = (1.7 * J) / (1 + 0.007 * J);
  const Mp = Math.log(1 + 0.0228 * M) / 0.0228;
  return { Jp, ap: Mp * Math.cos(h), bp: Mp * Math.sin(h) };
}

function ucsToRgb(ucs: UCS): RGB {
  const { Jp, ap, bp } = ucs;
  const Mp = Math.hypot(ap, bp);
  const M = (Math.exp(0.0228 * Mp) - 1) / 0.0228;
  const h = Math.atan2(bp, ap);
  // Floor J before division by sqrt(J/100); avoids blow-up at near-black.
  const J = Math.max(Jp / (1.7 - 0.007 * Jp), 1e-6);
  const C = M / F_L_025;
  const e_t = 0.25 * (Math.cos(h + 2) + 3.8);
  const A = A_w * Math.pow(J / 100, 1 / (c * z));
  const tBase = C / (Math.sqrt(J / 100) * surroundChromaTerm);
  const t = Math.pow(Math.max(tBase, 0), 1 / 0.9);
  const p2 = A / N_bb + 0.305;
  const p3 = 21 / 20;
  let aOpp = 0;
  let bOpp = 0;
  if (t > 1e-9) {
    const p1 = ((50000 / 13) * Nc * N_cb * e_t) / t;
    const hSin = Math.sin(h);
    const hCos = Math.cos(h);
    if (Math.abs(hSin) >= Math.abs(hCos)) {
      const p4 = p1 / hSin;
      const num = p2 * (2 + p3) * (460 / 1403);
      const den =
        p4 +
        (2 + p3) * (220 / 1403) * (hCos / hSin) -
        27 / 1403 +
        p3 * (6300 / 1403);
      bOpp = num / den;
      aOpp = bOpp * (hCos / hSin);
    } else {
      const p5 = p1 / hCos;
      const num = p2 * (2 + p3) * (460 / 1403);
      const den =
        p5 +
        (2 + p3) * (220 / 1403) -
        (27 / 1403 - p3 * (6300 / 1403)) * (hSin / hCos);
      aOpp = num / den;
      bOpp = aOpp * (hSin / hCos);
    }
  }
  const Ra = (460 * p2 + 451 * aOpp + 288 * bOpp) / 1403;
  const Ga = (460 * p2 - 891 * aOpp - 261 * bOpp) / 1403;
  const Ba = (460 * p2 - 220 * aOpp - 6300 * bOpp) / 1403;
  const R = postAdaptInv(Ra) / D_R;
  const G = postAdaptInv(Ga) / D_G;
  const B = postAdaptInv(Ba) / D_B;
  // CAT16 inverse → XYZ; descale to Y in 0..1 for xyzToRgb.
  const X = (M_CAT16_INV[0][0] * R + M_CAT16_INV[0][1] * G + M_CAT16_INV[0][2] * B) / 100;
  const Y = (M_CAT16_INV[1][0] * R + M_CAT16_INV[1][1] * G + M_CAT16_INV[1][2] * B) / 100;
  const Z = (M_CAT16_INV[2][0] * R + M_CAT16_INV[2][1] * G + M_CAT16_INV[2][2] * B) / 100;
  return xyzToRgb(X, Y, Z);
}

export function mixCam16Ucs(parts: FilamentPart[]): MixResult {
  if (parts.length === 0) throw new Error('mixCam16Ucs: empty parts');
  const total = parts.reduce((s, p) => s + p.ratio, 0);
  // Average in Cartesian (J', a', b'); never weight-average h directly —
  // doing so corrupts the 350°/10° wrap-around.
  let Jp = 0;
  let ap = 0;
  let bp = 0;
  for (const p of parts) {
    const w = p.ratio / total;
    const u = rgbToUcs(hexToRgb(p.hex));
    Jp += w * u.Jp;
    ap += w * u.ap;
    bp += w * u.bp;
  }
  const rgb = ucsToRgb({ Jp, ap, bp });
  const hex = rgbToHex(rgb);
  const lab: LAB = hexToLab(hex);
  return { hex, lab, rgb };
}
