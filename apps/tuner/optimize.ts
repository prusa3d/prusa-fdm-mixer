/**
 * Optimizers — coordinate descent (golden-section line search) and
 * Nelder-Mead simplex. Both work on a numeric vector clipped to bounds.
 *
 * The loss callback returns a scalar; both optimizers minimize it.
 */

import { BOUNDS, PARAM_KEYS, clipToBounds, perturb } from './params.js';

export type LossFn = (v: number[]) => number;

export interface OptimizeResult {
  best: number[];
  bestLoss: number;
  iterations: number;
  evaluations: number;
}

// ---------------------------------------------------------------------------
// Coordinate descent with golden-section line search
// ---------------------------------------------------------------------------

const PHI = (Math.sqrt(5) - 1) / 2; // ≈ 0.618

/** Golden-section search on a single component, restricted to its bounds. */
function goldenSection(
  v: number[],
  index: number,
  loss: LossFn,
  tol: number,
  maxIter: number,
): { x: number; f: number; evaluations: number } {
  const b = BOUNDS[PARAM_KEYS[index]!]!;
  let a = b.min;
  let c = b.max;
  let evals = 0;
  const evalAt = (x: number) => {
    const v2 = v.slice();
    v2[index] = x;
    evals++;
    return loss(v2);
  };
  let x1 = c - PHI * (c - a);
  let x2 = a + PHI * (c - a);
  let f1 = evalAt(x1);
  let f2 = evalAt(x2);
  for (let i = 0; i < maxIter && c - a > tol; i++) {
    if (f1 < f2) {
      c = x2;
      x2 = x1;
      f2 = f1;
      x1 = c - PHI * (c - a);
      f1 = evalAt(x1);
    } else {
      a = x1;
      x1 = x2;
      f1 = f2;
      x2 = a + PHI * (c - a);
      f2 = evalAt(x2);
    }
  }
  const x = f1 < f2 ? x1 : x2;
  const f = f1 < f2 ? f1 : f2;
  return { x, f, evaluations: evals };
}

export interface CoordinateDescentOpts {
  /** Convergence: stop when a full pass improves loss by less than this. */
  tol?: number;
  /** Per-axis line-search tolerance (in axis units). */
  axisTol?: number;
  /** Max passes over all axes. */
  maxPasses?: number;
  /** Max line-search iterations per axis. */
  maxLineIters?: number;
}

export function coordinateDescent(
  start: number[],
  loss: LossFn,
  opts: CoordinateDescentOpts = {},
): OptimizeResult {
  const { tol = 1e-4, axisTol = 1e-4, maxPasses = 20, maxLineIters = 60 } = opts;
  let best = clipToBounds(start.slice());
  let bestLoss = loss(best);
  let evaluations = 1;
  let iterations = 0;
  for (let pass = 0; pass < maxPasses; pass++) {
    const lossBefore = bestLoss;
    for (let i = 0; i < best.length; i++) {
      const r = goldenSection(best, i, loss, axisTol, maxLineIters);
      evaluations += r.evaluations;
      if (r.f < bestLoss) {
        best[i] = r.x;
        bestLoss = r.f;
      }
    }
    iterations++;
    if (lossBefore - bestLoss < tol) break;
  }
  return { best, bestLoss, iterations, evaluations };
}

// ---------------------------------------------------------------------------
// Nelder-Mead simplex
// ---------------------------------------------------------------------------

export interface NelderMeadOpts {
  /** Initial simplex spread relative to BOUNDS[k].step (default 1.0). */
  initialStepScale?: number;
  /** Max iterations (each iter is at most one extra eval beyond best). */
  maxIter?: number;
  /** Convergence: stop when simplex spread (max - min vertex loss) < this. */
  tol?: number;
  /** Standard NM coefficients. */
  alpha?: number; // reflection
  gamma?: number; // expansion
  rho?: number; // contraction
  sigma?: number; // shrink
}

interface Vertex {
  x: number[];
  f: number;
}

function add(a: number[], b: number[]): number[] {
  return a.map((v, i) => v + b[i]!);
}
function sub(a: number[], b: number[]): number[] {
  return a.map((v, i) => v - b[i]!);
}
function scale(a: number[], s: number): number[] {
  return a.map((v) => v * s);
}
function centroidExcluding(simplex: Vertex[], idx: number): number[] {
  const n = simplex[0]!.x.length;
  const c = new Array(n).fill(0) as number[];
  for (let i = 0; i < simplex.length; i++) {
    if (i === idx) continue;
    for (let j = 0; j < n; j++) c[j]! += simplex[i]!.x[j]!;
  }
  for (let j = 0; j < n; j++) c[j]! /= simplex.length - 1;
  return c;
}

export function nelderMead(
  start: number[],
  loss: LossFn,
  opts: NelderMeadOpts = {},
): OptimizeResult {
  const {
    initialStepScale = 1.0,
    maxIter = 2000,
    tol = 1e-5,
    alpha = 1,
    gamma = 2,
    rho = 0.5,
    sigma = 0.5,
  } = opts;

  const dim = start.length;
  const x0 = clipToBounds(start.slice());

  // Build initial simplex by perturbing each axis by its `step * initialStepScale`.
  const simplex: Vertex[] = [{ x: x0, f: loss(x0) }];
  let evaluations = 1;
  for (let i = 0; i < dim; i++) {
    const x = x0.slice();
    const b = BOUNDS[PARAM_KEYS[i]!]!;
    // If we're near the upper bound, step downward instead.
    const dir = x[i]! + b.step * initialStepScale > b.max ? -1 : 1;
    x[i] = Math.max(b.min, Math.min(b.max, x[i]! + dir * b.step * initialStepScale));
    const f = loss(x);
    evaluations++;
    simplex.push({ x, f });
  }

  let iterations = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations++;
    simplex.sort((a, b) => a.f - b.f);
    const best = simplex[0]!;
    const worst = simplex[simplex.length - 1]!;
    const spread = worst.f - best.f;
    if (spread < tol) break;

    const c = centroidExcluding(simplex, simplex.length - 1);
    // Reflection
    const xr = clipToBounds(add(c, scale(sub(c, worst.x), alpha)));
    const fr = loss(xr);
    evaluations++;
    if (fr < simplex[simplex.length - 2]!.f && fr >= best.f) {
      simplex[simplex.length - 1] = { x: xr, f: fr };
      continue;
    }
    if (fr < best.f) {
      // Expansion
      const xe = clipToBounds(add(c, scale(sub(xr, c), gamma)));
      const fe = loss(xe);
      evaluations++;
      simplex[simplex.length - 1] = fe < fr ? { x: xe, f: fe } : { x: xr, f: fr };
      continue;
    }
    // Contraction
    const xc = clipToBounds(add(c, scale(sub(worst.x, c), rho)));
    const fc = loss(xc);
    evaluations++;
    if (fc < worst.f) {
      simplex[simplex.length - 1] = { x: xc, f: fc };
      continue;
    }
    // Shrink toward best
    for (let i = 1; i < simplex.length; i++) {
      const x = clipToBounds(add(best.x, scale(sub(simplex[i]!.x, best.x), sigma)));
      const f = loss(x);
      evaluations++;
      simplex[i] = { x, f };
    }
  }
  simplex.sort((a, b) => a.f - b.f);
  const best = simplex[0]!;
  return { best: best.x, bestLoss: best.f, iterations, evaluations };
}

// ---------------------------------------------------------------------------
// Restart wrapper
// ---------------------------------------------------------------------------

export interface RestartOpts {
  /** Number of random restarts after the initial run. */
  restarts?: number;
  /** Per-run optimizer options for Nelder-Mead. */
  nm?: NelderMeadOpts;
  /** PRNG. */
  rng: () => number;
  /** Optional callback after each restart so the runner can checkpoint. */
  onImprove?: (r: OptimizeResult) => void;
}

/** Run Nelder-Mead from `start`, then `restarts` times from perturbed re-inits. */
export function nelderMeadRestart(
  start: number[],
  loss: LossFn,
  opts: RestartOpts,
): OptimizeResult {
  const { restarts = 5, nm = {}, rng, onImprove } = opts;
  let best = nelderMead(start, loss, nm);
  if (onImprove) onImprove(best);
  let evaluations = best.evaluations;
  let iterations = best.iterations;
  for (let i = 0; i < restarts; i++) {
    const seed = perturb(best.best, rng, 2 + i * 0.5);
    const r = nelderMead(seed, loss, nm);
    evaluations += r.evaluations;
    iterations += r.iterations;
    if (r.bestLoss < best.bestLoss) {
      best = r;
      if (onImprove) onImprove(best);
    }
  }
  return { best: best.best, bestLoss: best.bestLoss, iterations, evaluations };
}
