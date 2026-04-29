/**
 * Parameter bounds, vector packing/unpacking, and small utilities for
 * working with `V7Params` as a numeric vector inside the optimizer.
 */

import { DEFAULT_V7_PARAMS, type V7Params } from '../../src/filament-mix.js';

export type ParamKey = keyof V7Params;

/** Order matters — this is the canonical packing order for vector ops. */
export const PARAM_KEYS: ParamKey[] = [
  'YN_N',
  'L_BASE_SLOPE',
  'L_BASE_INTERCEPT',
  'L_KNEE',
  'L_KNEE_SLOPE',
  'C_SLOPE',
  'C_INTERCEPT',
  'HUE_CENTER',
  'HUE_FALLOFF',
  'HUE_PEAK',
  'PEAK_STRENGTH',
];

export interface ParamBound {
  min: number;
  max: number;
  /** A reasonable initial step for line search / simplex / random restart. */
  step: number;
}

/**
 * Bounds for each constant. Picked conservatively wide enough to give the
 * optimizer room, narrow enough to keep absurd values out:
 *   - YN_N: well-known printing range
 *   - HUE_CENTER: full hue circle
 *   - others: ±5x the current value, with a sensible step
 */
export const BOUNDS: Record<ParamKey, ParamBound> = {
  YN_N: { min: 1.5, max: 5.0, step: 0.1 },
  L_BASE_SLOPE: { min: -0.5, max: 0.5, step: 0.01 },
  L_BASE_INTERCEPT: { min: -10, max: 10, step: 0.5 },
  L_KNEE: { min: 5, max: 40, step: 1 },
  L_KNEE_SLOPE: { min: -0.5, max: 0.5, step: 0.01 },
  C_SLOPE: { min: -1, max: 1, step: 0.02 },
  C_INTERCEPT: { min: -50, max: 30, step: 1 },
  HUE_CENTER: { min: 0, max: 360, step: 5 },
  HUE_FALLOFF: { min: 5, max: 90, step: 2 },
  HUE_PEAK: { min: -30, max: 30, step: 0.5 },
  PEAK_STRENGTH: { min: 0.5, max: 3.0, step: 0.05 },
};

/** Pack a V7Params object into a numeric vector in canonical key order. */
export function packParams(p: V7Params): number[] {
  return PARAM_KEYS.map((k) => p[k]);
}

/** Unpack a numeric vector back into a V7Params object. */
export function unpackParams(v: number[]): V7Params {
  const out = {} as V7Params;
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    out[PARAM_KEYS[i]!] = v[i]!;
  }
  return out;
}

/** Clip a vector componentwise into [min, max] per key. */
export function clipToBounds(v: number[]): number[] {
  return v.map((x, i) => {
    const b = BOUNDS[PARAM_KEYS[i]!]!;
    return Math.max(b.min, Math.min(b.max, x));
  });
}

/** True iff every component is inside its bounds. */
export function inBounds(v: number[]): boolean {
  for (let i = 0; i < v.length; i++) {
    const b = BOUNDS[PARAM_KEYS[i]!]!;
    if (v[i]! < b.min || v[i]! > b.max) return false;
  }
  return true;
}

/** A reproducible PRNG: mulberry32. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random vector inside the bounds. */
export function randomInBounds(rng: () => number): number[] {
  return PARAM_KEYS.map((k) => {
    const b = BOUNDS[k]!;
    return b.min + rng() * (b.max - b.min);
  });
}

/** Perturb a vector by a per-component Gaussian-ish jitter scaled by `step`. */
export function perturb(v: number[], rng: () => number, scale = 1): number[] {
  return v.map((x, i) => {
    const b = BOUNDS[PARAM_KEYS[i]!]!;
    // Box-Muller for one normal-ish sample.
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    const n = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const jitter = n * b.step * scale;
    return Math.max(b.min, Math.min(b.max, x + jitter));
  });
}

export const DEFAULT_VECTOR = packParams(DEFAULT_V7_PARAMS);
