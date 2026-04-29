/**
 * Tuner — leave-one-filament-out cross-validation.
 *
 * The fitting set contains 24 base entries but only ~18 distinct filament
 * identities (Lipstick Red, Azure Blue, Jet Black, Prusa Orange, Simply Green
 * are each measured in multiple batches with slightly different hex). LOFO
 * groups by identity (the part of `note` after the batch prefix), not by
 * hex — otherwise holding out batch-2 Lipstick Red would leave batch-3
 * Lipstick Red in the training fold and defeat the point.
 *
 * For each unique filament identity F:
 *   1. Mark every mix that contains *any* hex of F as held-out.
 *   2. Tune from `seed` on the remaining mixes.
 *   3. Score on the held-out subset.
 *
 * The aggregate held-out mean ΔE estimates how the tune procedure generalises
 * to a 25th filament outside the fitting set.
 */

import { computeLoss, type MixSample, type DatasetEntry, type LossOptions } from './loss.js';
import { lossScalar } from './loss.js';
import { unpackParams } from './params.js';
import { type V7Params, mixFilamentsWithParams } from '../../src/prusa-fdm-mixer.js';
import { deltaE2000 } from '../../src/delta-e.js';

// ---------------------------------------------------------------------------
// Filament identity
// ---------------------------------------------------------------------------

/** Strip the "1 - " batch prefix; everything after is the filament identity. */
export function filamentIdentity(note: string): string {
  const m = note.match(/^\s*\d+\s*-\s*(.+)$/);
  return m ? m[1]!.trim() : note.trim();
}

/**
 * Map every component hex appearing in the dataset to its filament identity.
 * Built from the pure-base entries; throws if a mix references a hex with no
 * base entry (should never happen in a well-formed dataset).
 */
export function buildIdentityMap(bases: DatasetEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of bases) {
    if (!b.note) continue;
    out.set(b.hex, filamentIdentity(b.note));
  }
  return out;
}

/** All unique filament identities in the dataset. */
export function uniqueIdentities(idMap: Map<string, string>): string[] {
  return Array.from(new Set(idMap.values())).sort();
}

/** True iff any component of the sample is the held-out identity. */
export function sampleContainsIdentity(
  sample: MixSample,
  idMap: Map<string, string>,
  identity: string,
): boolean {
  for (const p of sample.parts) {
    if (idMap.get(p.hex) === identity) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fold runner
// ---------------------------------------------------------------------------

export interface FoldOptimizer {
  /**
   * Tune V7Params on the training samples and return a vector. The runner
   * passes a starting vector and the per-fold loss closure.
   */
  (start: number[], lossFn: (v: number[]) => number): {
    best: number[];
    bestLoss: number;
    evaluations: number;
  };
}

export interface FoldResult {
  /** Filament identity held out for this fold. */
  identity: string;
  /** Number of training samples used. */
  nTrain: number;
  /** Number of held-out samples. */
  nHeldOut: number;
  /** Tuned V7Params for this fold. */
  tunedParams: V7Params;
  /** Mean ΔE2000 on training samples (post-tune). */
  trainMeanDE: number;
  /** Mean ΔE2000 on held-out samples (post-tune). */
  heldOutMeanDE: number;
  /** Per-held-out-sample ΔE2000. */
  heldOutPerSample: number[];
  /** Optimizer evaluations spent. */
  evaluations: number;
}

/**
 * Run a single fold: hold out all samples whose recipe contains `heldIdentity`,
 * tune on the rest with `optimizer` starting from `seed`, score the held-out
 * subset.
 */
export function runFold(
  samples: MixSample[],
  idMap: Map<string, string>,
  heldIdentity: string,
  seed: number[],
  optimizer: FoldOptimizer,
  lossOpts?: LossOptions,
): FoldResult {
  const train: MixSample[] = [];
  const heldOut: MixSample[] = [];
  for (const s of samples) {
    if (sampleContainsIdentity(s, idMap, heldIdentity)) heldOut.push(s);
    else train.push(s);
  }

  const lossFn = (v: number[]) => lossScalar(train, unpackParams(v), lossOpts);
  const result = optimizer(seed, lossFn);
  const tunedParams = unpackParams(result.best);

  const trainResult = computeLoss(train, tunedParams, lossOpts);
  const heldResult = computeLoss(heldOut, tunedParams, lossOpts);

  return {
    identity: heldIdentity,
    nTrain: train.length,
    nHeldOut: heldOut.length,
    tunedParams,
    trainMeanDE: trainResult.mean,
    heldOutMeanDE: heldResult.mean,
    heldOutPerSample: heldResult.perSample,
    evaluations: result.evaluations,
  };
}

// ---------------------------------------------------------------------------
// Full LOFO
// ---------------------------------------------------------------------------

export interface LOFOResult {
  perFold: FoldResult[];
  /** Mean held-out ΔE2000 across all folds, weighted by fold size. */
  heldOutMeanDE: number;
  /** Median per-fold held-out mean ΔE2000 (robust against one bad fold). */
  heldOutMedianDE: number;
  /** Total optimizer evaluations across all folds. */
  totalEvaluations: number;
  /** Wall-clock seconds for the whole CV. */
  wallClockSec: number;
}

/**
 * Run LOFO across every unique filament identity. Each fold tunes from
 * scratch using `optimizer(seed, lossFn)`. `seed` is the same starting vector
 * for every fold (typically default params or a warm-start best).
 */
export function runLOFO(
  samples: MixSample[],
  idMap: Map<string, string>,
  seed: number[],
  optimizer: FoldOptimizer,
  lossOpts?: LossOptions,
  onFold?: (fold: FoldResult, index: number, total: number) => void,
): LOFOResult {
  const identities = uniqueIdentities(idMap);
  const t0 = Date.now();
  const perFold: FoldResult[] = [];
  let totalEvals = 0;
  let weightedSum = 0;
  let totalHeldOut = 0;
  for (let i = 0; i < identities.length; i++) {
    const id = identities[i]!;
    const fr = runFold(samples, idMap, id, seed, optimizer, lossOpts);
    perFold.push(fr);
    totalEvals += fr.evaluations;
    weightedSum += fr.heldOutMeanDE * fr.nHeldOut;
    totalHeldOut += fr.nHeldOut;
    if (onFold) onFold(fr, i, identities.length);
  }
  const meds = [...perFold.map((f) => f.heldOutMeanDE)].sort((a, b) => a - b);
  const median = meds.length === 0 ? 0 : meds[Math.floor(meds.length / 2)]!;
  return {
    perFold,
    heldOutMeanDE: totalHeldOut === 0 ? 0 : weightedSum / totalHeldOut,
    heldOutMedianDE: median,
    totalEvaluations: totalEvals,
    wallClockSec: (Date.now() - t0) / 1000,
  };
}

// ---------------------------------------------------------------------------
// Lipstick-Red pinned verification
// ---------------------------------------------------------------------------

/** The canonical hard-outlier filament identity used as a strict ship gate. */
export const LIPSTICK_RED_IDENTITY = 'Prusament PLA Lipstick Red';

/**
 * Run a single LOFO fold with Lipstick Red held out. Convenience wrapper
 * around `runFold` that validates the identity exists in the dataset.
 */
export function runLipstickFold(
  samples: MixSample[],
  idMap: Map<string, string>,
  seed: number[],
  optimizer: FoldOptimizer,
  lossOpts?: LossOptions,
): FoldResult {
  if (!Array.from(idMap.values()).includes(LIPSTICK_RED_IDENTITY)) {
    throw new Error(`Lipstick Red identity not in dataset (looked for "${LIPSTICK_RED_IDENTITY}")`);
  }
  return runFold(samples, idMap, LIPSTICK_RED_IDENTITY, seed, optimizer, lossOpts);
}

/**
 * Score a fixed `params` set on the held-out Lipstick Red samples without
 * any tuning — used to compare tuned-without-Lipstick params to the
 * default-params baseline on the same held-out subset.
 */
export function scoreOnLipstickHeldOut(
  samples: MixSample[],
  idMap: Map<string, string>,
  params: V7Params,
  lossOpts?: LossOptions,
): { mean: number; perSample: number[]; n: number } {
  const heldOut = samples.filter((s) => sampleContainsIdentity(s, idMap, LIPSTICK_RED_IDENTITY));
  const r = computeLoss(heldOut, params, lossOpts);
  return { mean: r.mean, perSample: r.perSample, n: heldOut.length };
}

// ---------------------------------------------------------------------------
// Per-filament held-out diagnostic table
// ---------------------------------------------------------------------------

export interface PerFilamentDiagnostic {
  identity: string;
  /** Number of mixes containing this identity. */
  nSamples: number;
  /** Mean ΔE on that subset using the given params. */
  meanDE: number;
  /** Median ΔE on that subset. */
  medianDE: number;
  /** Max ΔE on that subset. */
  maxDE: number;
}

/**
 * For each filament identity, score all mixes containing it using `params`
 * (no per-fold re-tuning). Useful for a "which filaments does the current
 * model struggle with?" diagnostic table — independent of any LOFO procedure.
 */
export function diagnosePerFilament(
  samples: MixSample[],
  idMap: Map<string, string>,
  params: V7Params,
  lossOpts?: LossOptions,
): PerFilamentDiagnostic[] {
  const out: PerFilamentDiagnostic[] = [];
  for (const id of uniqueIdentities(idMap)) {
    const subset = samples.filter((s) => sampleContainsIdentity(s, idMap, id));
    if (subset.length === 0) continue;
    const dEs = subset.map((s) => {
      const pred = mixFilamentsWithParams(s.parts, params);
      return deltaE2000(s.measuredLab, pred.lab);
    });
    void lossOpts; // not used here — raw ΔE only for diagnostic
    const sorted = [...dEs].sort((a, b) => a - b);
    out.push({
      identity: id,
      nSamples: dEs.length,
      meanDE: dEs.reduce((s, x) => s + x, 0) / dEs.length,
      medianDE: sorted[Math.floor(sorted.length / 2)]!,
      maxDE: sorted[sorted.length - 1]!,
    });
  }
  out.sort((a, b) => b.meanDE - a.meanDE);
  return out;
}
