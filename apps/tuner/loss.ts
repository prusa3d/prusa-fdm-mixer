/**
 * Tuner — fitting-set loader and ΔE2000 loss function.
 *
 * The loss is the metric the optimizer minimizes. To match the harness app
 * exactly, we:
 *   - load `data/fitting-set.jsonl`
 *   - identify pure bases (combinations.length === 1 && ratio === 1) and skip them
 *   - predict each remaining mix via mixFilamentsWithParams(parts, params)
 *   - return mean ΔE2000 against the measured Lab
 *
 * Pure bases are excluded because the gradient-safety guard in mixFilaments
 * returns them exactly, so they contribute zero gradient and would only
 * dilute the metric.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  mixFilamentsWithParams,
  type V7Params,
  type FilamentPart,
} from '../../src/prusa-fdm-mixer.js';
import { deltaE2000 } from '../../src/delta-e.js';
import type { LAB } from '../../src/color.js';

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export interface DatasetEntry {
  hex: string;
  lab: LAB;
  note?: string;
  combinations: Array<{ hex: string; ratio: number }>;
}

/** A single (parts → measured) sample the optimizer cares about. */
export interface MixSample {
  parts: FilamentPart[];
  measuredLab: LAB;
  measuredHex: string;
  /** Free-form text from the JSONL, e.g. "1+2 - Fiberlogy Cyan + Prusament Orange". */
  note: string;
  /** Sorted hex keys joined by `|`, useful for grouping by recipe. */
  pairKey: string;
  /** Number of components in the mix. */
  nParts: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Default path to fitting-set.jsonl (relative to repo root). */
export const DEFAULT_DATASET_PATH = resolve(__dirname, '../../data/fitting-set.jsonl');

/** Parse a JSONL fitting set; returns every entry, including pure bases. */
export function parseDataset(text: string): DatasetEntry[] {
  const out: DatasetEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as DatasetEntry);
  }
  return out;
}

/** Load and split into mix samples (the optimizer's data) + pure-base entries. */
export function loadFittingSet(path: string = DEFAULT_DATASET_PATH): {
  mixes: MixSample[];
  bases: DatasetEntry[];
  all: DatasetEntry[];
} {
  const text = readFileSync(path, 'utf8');
  const all = parseDataset(text);
  const bases: DatasetEntry[] = [];
  const mixes: MixSample[] = [];
  for (const e of all) {
    const isBase =
      e.combinations.length === 1 &&
      e.combinations[0]!.hex === e.hex &&
      e.combinations[0]!.ratio === 1;
    if (isBase) {
      bases.push(e);
      continue;
    }
    mixes.push({
      parts: e.combinations.map((c) => ({ hex: c.hex, ratio: c.ratio })),
      measuredLab: e.lab,
      measuredHex: e.hex,
      note: e.note ?? '',
      pairKey: e.combinations
        .map((c) => c.hex)
        .sort()
        .join('|'),
      nParts: e.combinations.length,
    });
  }
  return { mixes, bases, all };
}

// ---------------------------------------------------------------------------
// Loss
// ---------------------------------------------------------------------------

export interface LossOptions {
  /** Optional Huber-style soft-clip applied to each ΔE before averaging. */
  huberClip?: number;
  /** Multiplier for 3-color samples (default 1 = equal weight with 2-color). */
  threeColorWeight?: number;
}

export interface LossResult {
  mean: number;
  median: number;
  p90: number;
  max: number;
  /** Per-sample ΔE2000 in original sample order. */
  perSample: number[];
}

/** Compute mean ΔE2000 of `mixFilamentsWithParams(params)` against the samples. */
export function computeLoss(
  samples: MixSample[],
  params: V7Params,
  opts: LossOptions = {},
): LossResult {
  const { huberClip, threeColorWeight = 1 } = opts;
  const perSample: number[] = new Array(samples.length);
  let sum = 0;
  let weightSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const predicted = mixFilamentsWithParams(s.parts, params);
    const dE = deltaE2000(s.measuredLab, predicted.lab);
    perSample[i] = dE;

    let contribution = dE;
    if (huberClip !== undefined && contribution > huberClip) {
      // Huber-style soft cap: above the clip the slope drops to 0.5, so
      // outliers still contribute (the optimizer can still see them) but
      // count for half. `contribution` is always strictly ≤ `dE`.
      contribution = huberClip + 0.5 * (contribution - huberClip);
    }
    const weight = s.nParts >= 3 ? threeColorWeight : 1;
    sum += contribution * weight;
    weightSum += weight;
  }
  const sorted = [...perSample].sort((a, b) => a - b);
  const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
  const p90Idx = Math.min(sorted.length - 1, Math.floor(0.9 * sorted.length));
  const p90 = sorted.length === 0 ? 0 : sorted[p90Idx]!;
  const max = sorted.length === 0 ? 0 : sorted[sorted.length - 1]!;
  return {
    mean: weightSum === 0 ? 0 : sum / weightSum,
    median,
    p90,
    max,
    perSample,
  };
}

/** Bare scalar loss for the optimizer's inner loop. */
export function lossScalar(samples: MixSample[], params: V7Params, opts?: LossOptions): number {
  return computeLoss(samples, params, opts).mean;
}

/** Return the K worst residuals, sorted descending by ΔE. */
export function topResiduals(
  samples: MixSample[],
  loss: LossResult,
  k = 20,
): Array<{ sample: MixSample; dE: number }> {
  const indexed = loss.perSample.map((dE, i) => ({ sample: samples[i]!, dE }));
  indexed.sort((a, b) => b.dE - a.dE);
  return indexed.slice(0, k);
}
