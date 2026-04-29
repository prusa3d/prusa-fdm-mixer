/**
 * Tuner CLI — overnight runner + read-only reporting modes.
 *
 * Modes:
 *   --mode=overnight (default)
 *     Run forever. Three-phase rotation per iteration:
 *       a) coordinate descent from current best (cheap refinement);
 *       b) Nelder-Mead from random restart (exploration);
 *       c) Nelder-Mead from a perturbation of current best (exploitation).
 *     Atomic-write a new `best-train-params.{json,ts}` whenever a new global
 *     best is found. Every `--lofo-interval-min` minutes, evaluate LOFO-CV
 *     starting from current best; update `best-lofo-params.{json,ts}` if it
 *     improves. Also re-run the pinned Lipstick-Red fold and update
 *     `best-lipstick-verified-params.{json,ts}` only when both LOFO and the
 *     Lipstick held-out score beat the all-defaults baseline.
 *
 *   --mode=score
 *     Print mean / median / p90 / max ΔE2000 of the dataset using the current
 *     `DEFAULT_V7_PARAMS`. Cross-check that the loss reproduces the harness.
 *
 *   --mode=report
 *     Read the latest output files and print a headline summary, the per-
 *     filament diagnostic table, and the top-20 residuals.
 *
 *   --mode=lofo
 *     One-shot full LOFO-CV starting from `DEFAULT_V7_PARAMS` (or `--seed`).
 *     Use as a strict ship gate after killing the overnight runner.
 *
 *   --mode=sensitivity
 *     Coordinate-descent sensitivity printout: per-constant, the loss curve
 *     across its bound. Reveals which constants matter and which are flat.
 */

import { join } from 'node:path';

import {
  DEFAULT_V7_PARAMS,
  type V7Params,
} from '../../src/filament-mix.js';
import {
  computeLoss,
  loadFittingSet,
  lossScalar,
  topResiduals,
  type LossOptions,
} from './loss.js';
import {
  BOUNDS,
  DEFAULT_VECTOR,
  PARAM_KEYS,
  makeRng,
  packParams,
  perturb,
  randomInBounds,
  unpackParams,
} from './params.js';
import {
  coordinateDescent,
  nelderMead,
  type OptimizeResult,
} from './optimize.js';
import {
  buildIdentityMap,
  diagnosePerFilament,
  LIPSTICK_RED_IDENTITY,
  runLOFO,
  runFold,
  scoreOnLipstickHeldOut,
  type FoldOptimizer,
} from './cv.js';
import {
  appendProgress,
  bundlePaths,
  DEFAULT_OUTPUT_DIR,
  ensureOutputDir,
  installShutdownHandler,
  readPersistedJson,
  resumeOrDefault,
  writeBundle,
  type PersistedParams,
} from './persist.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliArgs {
  mode: 'overnight' | 'score' | 'report' | 'lofo' | 'sensitivity';
  outputDir: string;
  /** Seed for the PRNG (default 42 for reproducibility). */
  rngSeed: number;
  /** How many minutes between LOFO checks during overnight (default 30). */
  lofoIntervalMin: number;
  /** Per-fold Nelder-Mead iteration cap (default 800). */
  foldNmIters: number;
  /** Use a Huber-style soft-cap on per-sample ΔE in the loss. */
  huberClip: number | undefined;
  /** Three-color sample weight in the loss. */
  threeColorWeight: number;
  /** Skip the (slow) baseline-default LOFO computation at startup. */
  skipBaselineLofo: boolean;
  /** Limit total iterations (for testing); 0 = unlimited. */
  maxIters: number;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    mode: 'overnight',
    outputDir: DEFAULT_OUTPUT_DIR,
    rngSeed: 42,
    lofoIntervalMin: 30,
    foldNmIters: 800,
    huberClip: undefined,
    threeColorWeight: 1,
    skipBaselineLofo: false,
    maxIters: 0,
  };
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) a.mode = arg.slice(7) as CliArgs['mode'];
    else if (arg.startsWith('--output-dir=')) a.outputDir = arg.slice(13);
    else if (arg.startsWith('--rng-seed=')) a.rngSeed = parseInt(arg.slice(11), 10);
    else if (arg.startsWith('--lofo-interval-min='))
      a.lofoIntervalMin = parseFloat(arg.slice(20));
    else if (arg.startsWith('--fold-nm-iters=')) a.foldNmIters = parseInt(arg.slice(16), 10);
    else if (arg.startsWith('--huber-clip=')) a.huberClip = parseFloat(arg.slice(13));
    else if (arg.startsWith('--three-color-weight='))
      a.threeColorWeight = parseFloat(arg.slice(21));
    else if (arg === '--skip-baseline-lofo') a.skipBaselineLofo = true;
    else if (arg.startsWith('--max-iters=')) a.maxIters = parseInt(arg.slice(12), 10);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(
    [
      'V7 Autotuner',
      '',
      'Usage:',
      '  tsx apps/tuner/main.ts [--mode=MODE] [options]',
      '',
      'Modes:',
      '  overnight       Default. Run continuously, checkpoint best params to disk.',
      '  score           Print baseline loss with DEFAULT_V7_PARAMS. Sanity check.',
      '  report          Read latest output files and print summary.',
      '  lofo            One-shot LOFO-CV from defaults. Strict ship gate.',
      '  sensitivity     Coordinate-descent sensitivity scan per parameter.',
      '',
      'Options:',
      '  --output-dir=PATH         Default: apps/tuner/output',
      '  --rng-seed=N              PRNG seed (default 42)',
      '  --lofo-interval-min=N     Minutes between LOFO checks (default 30)',
      '  --fold-nm-iters=N         Per-fold Nelder-Mead cap (default 800)',
      '  --huber-clip=N            Soft-clip ΔE in loss above N (default off)',
      '  --three-color-weight=N    Loss weight for 3-color samples (default 1)',
      '  --skip-baseline-lofo      Skip baseline-default LOFO at startup',
      '  --max-iters=N             Stop after N outer iterations (0 = unlimited)',
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function fmt(n: number, digits = 4): string {
  return Number.isFinite(n) ? n.toFixed(digits) : String(n);
}

function pct(after: number, before: number): string {
  if (!isFinite(before) || before === 0) return '?';
  const d = ((after - before) / before) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(2) + '%';
}

function makePersistedParams(
  iteration: number,
  params: V7Params,
  trainMeanDE: number,
  lofoMeanDE: number | null,
  lipstickHeldOutDE: number | null,
  note?: string,
): PersistedParams {
  return {
    timestamp: nowIso(),
    iteration,
    trainMeanDE,
    lofoMeanDE,
    lipstickHeldOutDE,
    params,
    note,
  };
}

function makeFoldOptimizer(nmIters: number): FoldOptimizer {
  return (start, lossFn) =>
    nelderMead(start, lossFn, { maxIter: nmIters, tol: 1e-5 });
}

// ---------------------------------------------------------------------------
// Mode: score
// ---------------------------------------------------------------------------

function recipeLabel(sample: { parts: { hex: string; ratio: number }[] }, idMap: Map<string, string>): string {
  const sorted = [...sample.parts].sort((a, b) => b.ratio - a.ratio);
  const ratios = sorted.map((p) => Math.round(p.ratio * 100)).join(':');
  const names = sorted.map((p) => idMap.get(p.hex) ?? p.hex).join(' + ');
  return ratios + '  ' + names;
}

function runScore(args: CliArgs): void {
  const { mixes, bases } = loadFittingSet();
  const idMap = buildIdentityMap(bases);
  const lossOpts: LossOptions = {
    huberClip: args.huberClip,
    threeColorWeight: args.threeColorWeight,
  };
  const r = computeLoss(mixes, DEFAULT_V7_PARAMS, lossOpts);
  console.log('Loss with DEFAULT_V7_PARAMS over ' + mixes.length + ' mix samples:');
  console.log('  mean   ΔE = ' + fmt(r.mean));
  console.log('  median ΔE = ' + fmt(r.median));
  console.log('  p90    ΔE = ' + fmt(r.p90));
  console.log('  max    ΔE = ' + fmt(r.max));
  const top = topResiduals(mixes, r, 10);
  console.log('\nTop-10 worst residuals:');
  for (const t of top) {
    console.log('  ΔE=' + fmt(t.dE) + '  ' + recipeLabel(t.sample, idMap));
  }
}

// ---------------------------------------------------------------------------
// Mode: sensitivity
// ---------------------------------------------------------------------------

function runSensitivity(args: CliArgs): void {
  const { mixes } = loadFittingSet();
  const lossOpts: LossOptions = {
    huberClip: args.huberClip,
    threeColorWeight: args.threeColorWeight,
  };
  console.log('Sensitivity scan around DEFAULT_V7_PARAMS:');
  console.log('  (loss = mean ΔE2000; default value marked with *)');
  console.log();
  for (const k of PARAM_KEYS) {
    const b = BOUNDS[k]!;
    const dflt = DEFAULT_V7_PARAMS[k];
    const samples: Array<[number, number]> = [];
    const N = 11;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const x = b.min + t * (b.max - b.min);
      const params = { ...DEFAULT_V7_PARAMS, [k]: x };
      samples.push([x, lossScalar(mixes, params, lossOpts)]);
    }
    console.log(k + ' (default ' + fmt(dflt, 4) + ', bounds [' + b.min + ', ' + b.max + ']):');
    for (const [x, l] of samples) {
      const marker = Math.abs(x - dflt) < (b.max - b.min) / (N * 2) ? ' *' : '  ';
      console.log('  x=' + fmt(x, 4).padStart(10) + marker + ' loss=' + fmt(l));
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// Mode: report
// ---------------------------------------------------------------------------

function runReport(args: CliArgs): void {
  const { mixes, bases } = loadFittingSet();
  const idMap = buildIdentityMap(bases);
  const lossOpts: LossOptions = {
    huberClip: args.huberClip,
    threeColorWeight: args.threeColorWeight,
  };

  const dir = args.outputDir;
  const files: Array<[string, string]> = [
    ['best-train', 'Best by training loss'],
    ['best-lofo', 'Best by LOFO-CV held-out mean'],
    ['best-lipstick-verified', 'Best with Lipstick-Red gate (strictest)'],
  ];
  console.log('Report from ' + dir);
  console.log('='.repeat(60));
  for (const [prefix, label] of files) {
    const path = join(dir, prefix + '-params.json');
    const p = readPersistedJson(path);
    console.log();
    console.log(label + '  [' + prefix + ']');
    if (!p) {
      console.log('  (no file at ' + path + ')');
      continue;
    }
    console.log('  written: ' + p.timestamp + '  iter=' + p.iteration);
    console.log('  train mean ΔE = ' + fmt(p.trainMeanDE));
    if (p.lofoMeanDE !== null) console.log('  LOFO  mean ΔE = ' + fmt(p.lofoMeanDE));
    if (p.lipstickHeldOutDE !== null)
      console.log('  Lipstick held-out mean ΔE = ' + fmt(p.lipstickHeldOutDE));
    if (p.note) console.log('  note: ' + p.note);

    const r = computeLoss(mixes, p.params, lossOpts);
    console.log(
      '  re-scored now: mean=' + fmt(r.mean) + '  median=' + fmt(r.median) + '  p90=' + fmt(r.p90),
    );
  }

  console.log();
  console.log('Per-filament held-out diagnostic with DEFAULT_V7_PARAMS:');
  console.log(
    '  identity                                            n   mean    median  max',
  );
  const diag = diagnosePerFilament(mixes, idMap, DEFAULT_V7_PARAMS, lossOpts);
  for (const d of diag) {
    console.log(
      '  ' +
        d.identity.padEnd(50) +
        d.nSamples.toString().padStart(3) +
        '  ' +
        fmt(d.meanDE).padStart(6) +
        '  ' +
        fmt(d.medianDE).padStart(6) +
        '  ' +
        fmt(d.maxDE).padStart(6),
    );
  }

  const r = computeLoss(mixes, DEFAULT_V7_PARAMS, lossOpts);
  const top = topResiduals(mixes, r, 20);
  console.log();
  console.log('Top-20 worst residuals (DEFAULT_V7_PARAMS):');
  for (const t of top) {
    console.log('  ΔE=' + fmt(t.dE) + '  ' + recipeLabel(t.sample, idMap));
  }
}

// ---------------------------------------------------------------------------
// Mode: lofo (one-shot full LOFO-CV)
// ---------------------------------------------------------------------------

function runLofoOneShot(args: CliArgs): void {
  const { mixes, bases } = loadFittingSet();
  const idMap = buildIdentityMap(bases);
  const lossOpts: LossOptions = {
    huberClip: args.huberClip,
    threeColorWeight: args.threeColorWeight,
  };

  const optimizer = makeFoldOptimizer(args.foldNmIters);
  console.log('LOFO-CV from DEFAULT_V7_PARAMS, ' + args.foldNmIters + ' NM iters per fold');
  console.log('-'.repeat(60));
  const t0 = Date.now();
  const r = runLOFO(
    mixes,
    idMap,
    DEFAULT_VECTOR,
    optimizer,
    lossOpts,
    (fold, i, total) => {
      console.log(
        '[' +
          (i + 1) +
          '/' +
          total +
          '] ' +
          fold.identity.padEnd(45) +
          '  train=' +
          fmt(fold.trainMeanDE) +
          '  held-out=' +
          fmt(fold.heldOutMeanDE) +
          '  n=' +
          fold.nHeldOut,
      );
    },
  );
  const dt = (Date.now() - t0) / 1000;
  console.log('-'.repeat(60));
  console.log(
    'LOFO-CV mean held-out ΔE = ' +
      fmt(r.heldOutMeanDE) +
      '  (median ' +
      fmt(r.heldOutMedianDE) +
      ')',
  );
  console.log('Total wall time: ' + dt.toFixed(1) + 's');
}

// ---------------------------------------------------------------------------
// Mode: overnight
// ---------------------------------------------------------------------------

function runOvernight(args: CliArgs): void {
  ensureOutputDir(args.outputDir);
  const { mixes, bases } = loadFittingSet();
  const idMap = buildIdentityMap(bases);
  const lossOpts: LossOptions = {
    huberClip: args.huberClip,
    threeColorWeight: args.threeColorWeight,
  };
  const lossFn = (v: number[]) => lossScalar(mixes, unpackParams(v), lossOpts);

  // Baselines for honest before/after reporting.
  const baselineDefault = computeLoss(mixes, DEFAULT_V7_PARAMS, lossOpts);
  const baselineLipstick = scoreOnLipstickHeldOut(mixes, idMap, DEFAULT_V7_PARAMS, lossOpts);
  console.log('Baseline (DEFAULT_V7_PARAMS):');
  console.log('  training mean ΔE = ' + fmt(baselineDefault.mean));
  console.log('  Lipstick held-out mean ΔE = ' + fmt(baselineLipstick.mean));

  const foldOptimizer = makeFoldOptimizer(args.foldNmIters);
  let baselineLofo = Infinity;
  if (!args.skipBaselineLofo) {
    console.log('Computing baseline LOFO-CV (this can take a few minutes)...');
    const lofo = runLOFO(mixes, idMap, DEFAULT_VECTOR, foldOptimizer, lossOpts);
    baselineLofo = lofo.heldOutMeanDE;
    console.log('  baseline LOFO mean held-out ΔE = ' + fmt(baselineLofo));
  } else {
    console.log('Skipped baseline LOFO (--skip-baseline-lofo).');
  }

  const paths = {
    train: bundlePaths(args.outputDir, 'best-train'),
    lofo: bundlePaths(args.outputDir, 'best-lofo'),
    lipstick: bundlePaths(args.outputDir, 'best-lipstick-verified'),
  };
  const progressPath = join(args.outputDir, 'progress.log');

  // Resume or start fresh.
  const seed = resumeOrDefault(args.outputDir);
  if (seed.resumed) {
    console.log('Resuming from previous best-train (iter=' + seed.meta?.iteration + ').');
  } else {
    console.log('No previous best found. Seeding from DEFAULT_V7_PARAMS.');
    // Write the baseline as iter 0 so the file always exists post-startup.
    writeBundle(
      paths.train,
      makePersistedParams(
        0,
        DEFAULT_V7_PARAMS,
        baselineDefault.mean,
        args.skipBaselineLofo ? null : baselineLofo,
        baselineLipstick.mean,
        'baseline (DEFAULT_V7_PARAMS, no tuning)',
      ),
    );
  }

  let bestVector = packParams(seed.params);
  let bestTrainLoss = lossFn(bestVector);
  console.log(
    'Starting at training mean ΔE = ' +
      fmt(bestTrainLoss) +
      ' (' +
      pct(bestTrainLoss, baselineDefault.mean) +
      ' vs baseline)',
  );

  // Best LOFO loss seen so far (starts at baseline). Same for Lipstick.
  let bestLofoLoss = baselineLofo;
  let bestLipstickLoss = baselineLipstick.mean;

  // Shutdown plumbing.
  const isShutdownRequested = installShutdownHandler(() => {
    console.log('\nShutdown requested — finishing current iteration and exiting cleanly.');
  });

  const rng = makeRng(args.rngSeed);
  let iteration = seed.meta?.iteration ?? 0;
  let lastLofoTime = Date.now();
  let lastAlivePingTime = Date.now();
  const lofoIntervalMs = args.lofoIntervalMin * 60 * 1000;
  const alivePingIntervalMs = 60_000; // 1 min — keeps the user reassured
  const t0 = Date.now();

  /**
   * Stagnation counter: how many iterations since the last *training-loss*
   * improvement. Drives the perturbation-scale ladder below — small jitter
   * when fresh, big jumps when stuck, full re-randomization when very stuck.
   */
  let stagnation = 0;
  /**
   * Coord-descent gets one shot right after every improvement; once it has
   * polished the new basin we don't run it again until the next improvement
   * (it's deterministic — repeated runs return the same point).
   */
  let coordPolishPending = true;

  // ----- Main loop -----
  while (!isShutdownRequested()) {
    iteration++;
    if (args.maxIters > 0 && iteration > args.maxIters + (seed.meta?.iteration ?? 0)) break;

    let result: OptimizeResult;
    let optimizerName: string;

    if (coordPolishPending) {
      // Polish the current basin with coordinate descent (only useful when
      // we have a fresh best to refine).
      optimizerName = 'coord-descent';
      result = coordinateDescent(bestVector, lossFn, {
        maxPasses: 4,
        tol: 1e-6,
        axisTol: 1e-5,
      });
      coordPolishPending = false;
    } else if (stagnation < 5) {
      // Tight basin search — we're still refining.
      optimizerName = 'nm-perturb-1';
      const x0 = perturb(bestVector, rng, 1);
      result = nelderMead(x0, lossFn, { maxIter: 1200, tol: 1e-5 });
    } else if (stagnation < 15) {
      // Medium jump — try to escape this basin.
      optimizerName = 'nm-perturb-3';
      const x0 = perturb(bestVector, rng, 3);
      result = nelderMead(x0, lossFn, { maxIter: 1800, tol: 1e-5 });
    } else if (stagnation < 40) {
      // Large jump — almost certainly a different basin.
      optimizerName = 'nm-perturb-8';
      const x0 = perturb(bestVector, rng, 8);
      result = nelderMead(x0, lossFn, { maxIter: 2500, tol: 1e-5 });
    } else {
      // Very stuck — full random restart in bounds, longest budget.
      optimizerName = 'nm-random';
      const x0 = randomInBounds(rng);
      result = nelderMead(x0, lossFn, { maxIter: 4000, tol: 1e-5 });
      // Reset to "large jump" tier — full random is expensive, don't repeat
      // it back-to-back. We're not guaranteed to have improved; if we did,
      // stagnation drops to 0 below; if not, we go back through perturb-8.
      stagnation = 16;
    }

    // Meaningful-improvement threshold: tiny ΔE deltas (< 5e-4 ΔE2000) are
    // floating-point noise from golden-section line search; they're "real"
    // in the sense that the new vector is better, but they don't represent
    // exploring a new region. We update best-so-far either way, but only
    // *meaningful* improvements reset the stagnation counter and re-trigger
    // coord-descent. Otherwise the runner gets stuck in an endless coord-
    // descent ↔ tiny-perturb loop and never escalates to bigger jumps.
    const MEANINGFUL_IMPROVEMENT = 5e-4;
    if (result.bestLoss < bestTrainLoss - 1e-9) {
      const improvement = bestTrainLoss - result.bestLoss;
      bestTrainLoss = result.bestLoss;
      bestVector = result.best;
      const params = unpackParams(bestVector);
      const persisted = makePersistedParams(
        iteration,
        params,
        bestTrainLoss,
        bestLofoLoss === Infinity ? null : bestLofoLoss,
        bestLipstickLoss,
        'optimizer=' + optimizerName,
      );
      writeBundle(paths.train, persisted);

      if (improvement > MEANINGFUL_IMPROVEMENT) {
        stagnation = 0;
        coordPolishPending = true;
        lastAlivePingTime = Date.now();
        const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
        console.log(
          '[iter ' +
            iteration +
            ' +' +
            elapsedMin +
            'm] ' +
            optimizerName +
            ' new best train ΔE=' +
            fmt(bestTrainLoss) +
            ' (' +
            pct(bestTrainLoss, baselineDefault.mean) +
            ', Δ ' +
            fmt(improvement, 5) +
            ')',
        );
      } else {
        // Tiny improvement — keep it but advance stagnation so we eventually
        // escalate to bigger jumps. Don't spam the log.
        stagnation++;
      }
    } else {
      stagnation++;
    }

    // Periodic alive ping when we haven't logged a meaningful improvement
    // recently. Reassures the user the process is still working and shows
    // which tier of perturbation we're currently on.
    if (Date.now() - lastAlivePingTime > alivePingIntervalMs) {
      lastAlivePingTime = Date.now();
      const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
      console.log(
        '[iter ' +
          iteration +
          ' +' +
          elapsedMin +
          'm] alive — best train ΔE=' +
          fmt(bestTrainLoss) +
          ', stagnation=' +
          stagnation +
          ', last optimizer=' +
          optimizerName,
      );
    }

    appendProgress(progressPath, {
      timestamp: nowIso(),
      iteration,
      optimizer: optimizerName,
      trainMeanDE: bestTrainLoss,
      lofoMeanDE: bestLofoLoss === Infinity ? null : bestLofoLoss,
      lipstickHeldOutDE: bestLipstickLoss,
      evaluations: result.evaluations,
    });

    // Periodic LOFO + Lipstick re-evaluation on current best.
    if (Date.now() - lastLofoTime > lofoIntervalMs) {
      lastLofoTime = Date.now();
      console.log(
        '[iter ' + iteration + '] LOFO check (warm-start from current best)…',
      );
      const lofo = runLOFO(mixes, idMap, bestVector, foldOptimizer, lossOpts);
      const lipstick = runFold(
        mixes,
        idMap,
        LIPSTICK_RED_IDENTITY,
        bestVector,
        foldOptimizer,
        lossOpts,
      );
      console.log(
        '  LOFO mean held-out ΔE = ' +
          fmt(lofo.heldOutMeanDE) +
          ' (best so far ' +
          fmt(bestLofoLoss) +
          ')',
      );
      console.log(
        '  Lipstick held-out ΔE = ' +
          fmt(lipstick.heldOutMeanDE) +
          ' (baseline ' +
          fmt(baselineLipstick.mean) +
          ')',
      );

      const lofoImproved = lofo.heldOutMeanDE < bestLofoLoss - 1e-6;
      if (lofoImproved) {
        bestLofoLoss = lofo.heldOutMeanDE;
        const persisted = makePersistedParams(
          iteration,
          unpackParams(bestVector),
          bestTrainLoss,
          bestLofoLoss,
          lipstick.heldOutMeanDE,
          'LOFO-CV improvement',
        );
        writeBundle(paths.lofo, persisted);
      }

      // Lipstick verified gate: LOFO must improve AND Lipstick held-out
      // must beat the baseline-default Lipstick held-out.
      if (lofoImproved && lipstick.heldOutMeanDE < baselineLipstick.mean - 1e-6) {
        bestLipstickLoss = lipstick.heldOutMeanDE;
        const persisted = makePersistedParams(
          iteration,
          lipstick.tunedParams,
          lipstick.trainMeanDE,
          bestLofoLoss,
          bestLipstickLoss,
          'Lipstick-verified: LOFO ✓ AND Lipstick held-out ' +
            fmt(bestLipstickLoss) +
            ' < baseline ' +
            fmt(baselineLipstick.mean),
        );
        writeBundle(paths.lipstick, persisted);
        console.log(
          '  ★ Lipstick-verified update: held-out ΔE ' +
            fmt(bestLipstickLoss) +
            ' < baseline ' +
            fmt(baselineLipstick.mean),
        );
      }
    }
  }

  console.log();
  console.log('Final summary:');
  console.log('  iterations           : ' + iteration);
  console.log('  best train mean ΔE   : ' + fmt(bestTrainLoss));
  console.log('  baseline train ΔE    : ' + fmt(baselineDefault.mean));
  console.log('  best LOFO mean ΔE    : ' + (bestLofoLoss === Infinity ? '(not measured)' : fmt(bestLofoLoss)));
  console.log('  baseline LOFO ΔE     : ' + (baselineLofo === Infinity ? '(not measured)' : fmt(baselineLofo)));
  console.log('  best Lipstick ΔE     : ' + fmt(bestLipstickLoss));
  console.log('  baseline Lipstick ΔE : ' + fmt(baselineLipstick.mean));
  console.log();
  console.log('Output files in ' + args.outputDir + ':');
  console.log('  best-train-params.ts        — diagnostic, lowest train loss');
  console.log('  best-lofo-params.ts         — default ship target');
  console.log('  best-lipstick-verified-params.ts — strictest: ship for max confidence');
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  switch (args.mode) {
    case 'score':
      runScore(args);
      return;
    case 'report':
      runReport(args);
      return;
    case 'lofo':
      runLofoOneShot(args);
      return;
    case 'sensitivity':
      runSensitivity(args);
      return;
    case 'overnight':
      runOvernight(args);
      return;
    default:
      console.error('Unknown mode: ' + args.mode);
      printHelp();
      process.exit(1);
  }
}

main();
