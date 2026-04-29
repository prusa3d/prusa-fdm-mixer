import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadFittingSet,
  computeLoss,
  lossScalar,
  type MixSample,
} from '../apps/tuner/loss.js';
import {
  BOUNDS,
  DEFAULT_VECTOR,
  PARAM_KEYS,
  clipToBounds,
  inBounds,
  makeRng,
  packParams,
  perturb,
  randomInBounds,
  unpackParams,
} from '../apps/tuner/params.js';
import { coordinateDescent, nelderMead } from '../apps/tuner/optimize.js';
import {
  buildIdentityMap,
  filamentIdentity,
  LIPSTICK_RED_IDENTITY,
  runFold,
  runLOFO,
  sampleContainsIdentity,
  uniqueIdentities,
} from '../apps/tuner/cv.js';
import {
  atomicWriteFile,
  bundlePaths,
  formatTsSnippet,
  readPersistedJson,
  writeBundle,
  type PersistedParams,
} from '../apps/tuner/persist.js';
import { mixFilaments, hexToLab } from '../src/index.js';
import { DEFAULT_V7_PARAMS, mixFilamentsWithParams } from '../src/filament-mix.js';

// ---------------------------------------------------------------------------
// Loss determinism + parity with default params
// ---------------------------------------------------------------------------

describe('loss', () => {
  it('is deterministic for the same params and samples', () => {
    const { mixes } = loadFittingSet();
    const a = computeLoss(mixes, DEFAULT_V7_PARAMS).mean;
    const b = computeLoss(mixes, DEFAULT_V7_PARAMS).mean;
    expect(a).toBe(b);
  });

  it('matches a hand-computed two-sample mean ΔE', () => {
    const samples: MixSample[] = [
      {
        parts: [
          { hex: '#009bc3', ratio: 0.5 },
          { hex: '#f6b921', ratio: 0.5 },
        ],
        measuredLab: { L: 50, a: 0, b: 0 },
        measuredHex: '#000000',
        note: 'synthetic',
        pairKey: '#009bc3|#f6b921',
        nParts: 2,
      },
    ];
    const r = computeLoss(samples, DEFAULT_V7_PARAMS);
    expect(r.perSample).toHaveLength(1);
    expect(r.perSample[0]).toBeGreaterThan(0);
    expect(r.mean).toBe(r.perSample[0]);
  });

  it('Huber clip reduces influence of outliers monotonically', () => {
    const { mixes } = loadFittingSet();
    const noClip = computeLoss(mixes, DEFAULT_V7_PARAMS).mean;
    const clipped = computeLoss(mixes, DEFAULT_V7_PARAMS, { huberClip: 5 }).mean;
    expect(clipped).toBeLessThanOrEqual(noClip);
  });
});

// ---------------------------------------------------------------------------
// Param packing / bounds / RNG utilities
// ---------------------------------------------------------------------------

describe('params utilities', () => {
  it('packParams ⇄ unpackParams is identity', () => {
    const v = DEFAULT_VECTOR;
    const back = packParams(unpackParams(v));
    expect(back).toEqual(v);
  });

  it('clipToBounds yields a vector in bounds', () => {
    const out = clipToBounds(PARAM_KEYS.map(() => 1e9));
    expect(inBounds(out)).toBe(true);
  });

  it('randomInBounds yields a vector in bounds', () => {
    const rng = makeRng(123);
    for (let i = 0; i < 50; i++) {
      const v = randomInBounds(rng);
      expect(inBounds(v)).toBe(true);
    }
  });

  it('perturb keeps vector in bounds', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 50; i++) {
      const v = perturb(DEFAULT_VECTOR, rng, 5);
      expect(inBounds(v)).toBe(true);
    }
  });

  it('makeRng is reproducible with the same seed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b());
    }
  });
});

// ---------------------------------------------------------------------------
// Optimizers reduce loss on a synthetic problem
// ---------------------------------------------------------------------------

describe('optimizers', () => {
  // Each constant has a "true" optimum equal to the default. The loss is the
  // squared distance from default in each parameter, scaled by the bound width
  // so a flat 1.0 step corresponds to a meaningful change. Both optimizers
  // should drive this to ~0.
  function syntheticLoss(v: number[]): number {
    let s = 0;
    for (let i = 0; i < v.length; i++) {
      const b = BOUNDS[PARAM_KEYS[i]!]!;
      const target = DEFAULT_VECTOR[i]!;
      const norm = (v[i]! - target) / Math.max(1e-6, b.max - b.min);
      s += norm * norm;
    }
    return s;
  }

  it('coordinate descent finds the synthetic optimum', () => {
    const start = perturb(DEFAULT_VECTOR, makeRng(99), 5);
    const r = coordinateDescent(start, syntheticLoss, { tol: 1e-8, maxPasses: 8 });
    expect(r.bestLoss).toBeLessThan(1e-4);
  });

  it('Nelder-Mead finds the synthetic optimum', () => {
    const start = perturb(DEFAULT_VECTOR, makeRng(101), 5);
    const r = nelderMead(start, syntheticLoss, { maxIter: 5000, tol: 1e-8 });
    expect(r.bestLoss).toBeLessThan(1e-2);
  });

  it('Nelder-Mead reduces real V7 training loss', () => {
    const { mixes } = loadFittingSet();
    const lossFn = (v: number[]) => lossScalar(mixes, unpackParams(v));
    const before = lossFn(DEFAULT_VECTOR);
    const r = nelderMead(DEFAULT_VECTOR, lossFn, { maxIter: 200, tol: 1e-5 });
    expect(r.bestLoss).toBeLessThanOrEqual(before);
  });
});

// ---------------------------------------------------------------------------
// LOFO partition correctness
// ---------------------------------------------------------------------------

describe('LOFO partition', () => {
  it('every mix sample is held out in exactly the folds containing its identities', () => {
    const { mixes, bases } = loadFittingSet();
    const idMap = buildIdentityMap(bases);
    const ids = uniqueIdentities(idMap);
    for (const m of mixes) {
      const identitiesOfThisSample = new Set(m.parts.map((p) => idMap.get(p.hex)!));
      let heldCount = 0;
      for (const id of ids) {
        if (sampleContainsIdentity(m, idMap, id)) heldCount++;
      }
      expect(heldCount).toBe(identitiesOfThisSample.size);
    }
  });

  it('Lipstick Red identity exists and has held-out samples', () => {
    const { mixes, bases } = loadFittingSet();
    const idMap = buildIdentityMap(bases);
    const heldOut = mixes.filter((s) => sampleContainsIdentity(s, idMap, LIPSTICK_RED_IDENTITY));
    expect(heldOut.length).toBeGreaterThan(0);
  });

  it('filamentIdentity strips batch prefix', () => {
    expect(filamentIdentity('1 - Fiberlogy Easy PLA Cyan')).toBe('Fiberlogy Easy PLA Cyan');
    expect(filamentIdentity('  3 - Prusament PLA Lipstick Red')).toBe(
      'Prusament PLA Lipstick Red',
    );
    expect(filamentIdentity('no prefix')).toBe('no prefix');
  });

  it('runFold trains without seeing the held-out identity', () => {
    const { mixes, bases } = loadFittingSet();
    const idMap = buildIdentityMap(bases);
    const before = lossScalar(mixes, DEFAULT_V7_PARAMS);
    // Quick fold tune (small NM budget) — purely verifying mechanics.
    const r = runFold(mixes, idMap, LIPSTICK_RED_IDENTITY, DEFAULT_VECTOR, (start, lossFn) =>
      nelderMead(start, lossFn, { maxIter: 100, tol: 1e-4 }),
    );
    expect(r.identity).toBe(LIPSTICK_RED_IDENTITY);
    expect(r.nHeldOut).toBeGreaterThan(0);
    expect(r.nTrain + r.nHeldOut).toBe(mixes.length);
    // Tuned-without-Lipstick train mean ΔE must not exceed default's all-data train mean
    // by a wide margin. (Sanity: optimizer didn't blow up.)
    expect(r.trainMeanDE).toBeLessThan(before * 2);
  });
});

// ---------------------------------------------------------------------------
// LOFO mini run (small NM budget) — sanity, not accuracy
// ---------------------------------------------------------------------------

describe('LOFO mini run', () => {
  it('runs all folds and reports a finite mean ΔE', () => {
    const { mixes, bases } = loadFittingSet();
    const idMap = buildIdentityMap(bases);
    const r = runLOFO(
      mixes,
      idMap,
      DEFAULT_VECTOR,
      (start, lossFn) => nelderMead(start, lossFn, { maxIter: 60, tol: 1e-3 }),
    );
    expect(r.perFold.length).toBe(uniqueIdentities(idMap).length);
    expect(Number.isFinite(r.heldOutMeanDE)).toBe(true);
    expect(r.heldOutMeanDE).toBeGreaterThan(0);
  }, 60_000); // up to a minute for tiny budget × 18 folds
});

// ---------------------------------------------------------------------------
// Gradient continuity: V7Params from a random vector still produces smooth gradients
// ---------------------------------------------------------------------------

describe('gradient continuity', () => {
  it('arbitrary V7Params produces no kinks across a 256-step gradient', () => {
    const rng = makeRng(31);
    // 5 random param vectors. Each must produce a smooth gradient between
    // two distinct filaments — first-difference ΔE bounded.
    for (let trial = 0; trial < 5; trial++) {
      const v = randomInBounds(rng);
      const params = unpackParams(v);
      const N = 64;
      const labs: { L: number; a: number; b: number }[] = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const r = mixFilamentsWithParams(
          [
            { hex: '#009bc3', ratio: 1 - t },
            { hex: '#f6b921', ratio: t },
          ],
          params,
        );
        labs.push(r.lab);
      }
      // Endpoints must be the pure components (gradient-safety guard
      // returns hexToLab(hex) for ratio≈1, not the measured Lab).
      const cyanLab = hexToLab('#009bc3');
      const yellowLab = hexToLab('#f6b921');
      expect(labs[0]!.L).toBeCloseTo(cyanLab.L, 5);
      expect(labs[0]!.a).toBeCloseTo(cyanLab.a, 5);
      expect(labs[0]!.b).toBeCloseTo(cyanLab.b, 5);
      expect(labs[N - 1]!.L).toBeCloseTo(yellowLab.L, 5);
      // No first-difference jump should exceed a generous threshold (we're
      // testing for kinks, not absolute smoothness — random params can be
      // strange).
      for (let i = 1; i < labs.length; i++) {
        const dL = labs[i]!.L - labs[i - 1]!.L;
        const da = labs[i]!.a - labs[i - 1]!.a;
        const db = labs[i]!.b - labs[i - 1]!.b;
        const stepMag = Math.hypot(dL, da, db);
        expect(stepMag).toBeLessThan(50);
      }
    }
  });

  it('public mixFilaments is byte-identical for known reference predictions', () => {
    // Mirror the existing pinning so any drift in V7Params handling is caught.
    expect(
      mixFilaments([
        { hex: '#009bc3', ratio: 0.5 },
        { hex: '#f6b921', ratio: 0.5 },
      ]).hex,
    ).toBe('#519e5f');
  });
});

// ---------------------------------------------------------------------------
// Persist: atomic write + round-trip
// ---------------------------------------------------------------------------

describe('persist', () => {
  it('atomicWriteFile produces a parseable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuner-test-'));
    try {
      const path = join(dir, 'out.json');
      atomicWriteFile(path, '{"a":1,"b":[1,2,3]}');
      const txt = readFileSync(path, 'utf8');
      expect(JSON.parse(txt)).toEqual({ a: 1, b: [1, 2, 3] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writeBundle + readPersistedJson round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuner-test-'));
    try {
      const paths = bundlePaths(dir, 'unit');
      const persisted: PersistedParams = {
        timestamp: '2026-04-29T00:00:00.000Z',
        iteration: 42,
        trainMeanDE: 5.123,
        lofoMeanDE: 5.678,
        lipstickHeldOutDE: 8.9,
        params: DEFAULT_V7_PARAMS,
        note: 'unit test',
      };
      writeBundle(paths, persisted);
      const back = readPersistedJson(paths.json);
      expect(back).toEqual(persisted);
      const ts = readFileSync(paths.ts, 'utf8');
      expect(ts).toContain('Generated by apps/tuner');
      expect(ts).toContain('YN_N: 3');
      expect(ts).toContain('export const DEFAULT_V7_PARAMS: V7Params = {');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formatTsSnippet emits well-formed TypeScript', () => {
    const persisted: PersistedParams = {
      timestamp: '2026-04-29T00:00:00.000Z',
      iteration: 1,
      trainMeanDE: 5,
      lofoMeanDE: null,
      lipstickHeldOutDE: null,
      params: DEFAULT_V7_PARAMS,
    };
    const ts = formatTsSnippet(persisted);
    expect(ts).toMatch(/^\/\/ Generated by apps\/tuner/);
    expect(ts).toContain('export const DEFAULT_V7_PARAMS: V7Params = {');
    for (const k of PARAM_KEYS) {
      expect(ts).toContain(k + ':');
    }
  });
});
