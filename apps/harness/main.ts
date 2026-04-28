/**
 * Harness app — score the v7 model against measured prints.
 *
 * Loads `data/fitting-set.jsonl` (vendored at build time), runs each candidate
 * model on every 2-color and 3-color sample, and renders:
 *
 *   - Summary cards per model (n, median, mean, p90, hits at <5/<8/<10)
 *   - ΔE distribution histograms (one per model)
 *   - Per-pair breakdown table sorted by worst-case
 *   - Head-to-head comparison
 */

import {
  mixFilaments,
  mixLinearRgb,
  mixKubelkaMunk,
  mixFilamentMixer,
  deltaE2000,
  type LAB,
  type FilamentPart,
  type MixResult,
} from '@/index.js';

// Vite-friendly raw import. The data file lives in /data and gets bundled.
import datasetText from '../../data/fitting-set.jsonl?raw';

// ---- Types ----------------------------------------------------------------
interface DatasetEntry {
  hex: string;
  lab: LAB;
  note?: string;
  combinations: Array<{ hex: string; ratio: number; lab?: LAB }>;
}

type ModelFn = (parts: FilamentPart[]) => MixResult;

interface ModelDef {
  id: string;
  name: string;
  desc: string;
  fn: ModelFn;
}

interface Score {
  measured: { hex: string; lab: LAB };
  predicted: MixResult;
  dE: number;
  dL: number;
  da: number;
  db: number;
  pairLabel: string;
  pairKey: string;
  ratioStr: string;
  nParts: number;
}

// ---- Models ---------------------------------------------------------------
const MODELS: ModelDef[] = [
  {
    id: 'v7',
    name: 'v7 (this work)',
    desc: 'Yule-Nielsen + lightness + chroma + cyan-band hue',
    fn: mixFilaments,
  },
  {
    id: 'linear',
    name: 'Linear sRGB',
    desc: 'Naive 0–255 sRGB ratio average. What BambuStudio used before 2026-04-17 and most other slicers still use',
    fn: mixLinearRgb,
  },
  {
    id: 'filament-mixer',
    name: 'filament-mixer',
    desc: 'Polynomial Mixbox approximation by justinh-rahb (MIT). Originated in OrcaSlicer-FullSpectrum; adopted by BambuStudio on 2026-04-17',
    fn: mixFilamentMixer,
  },
  {
    id: 'km',
    name: 'Kubelka-Munk',
    desc: 'Textbook subtractive pigment model — physics baseline, no calibration',
    fn: mixKubelkaMunk,
  },
];

// ---- Data ------------------------------------------------------------------
function parseDataset(text: string): DatasetEntry[] {
  const lines = text.trim().split(/\r?\n/);
  const out: DatasetEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line) as DatasetEntry);
  }
  return out;
}

const ENTRIES = parseDataset(datasetText);
const BASES = new Map<string, DatasetEntry>();
const MIXES: DatasetEntry[] = [];
for (const e of ENTRIES) {
  const isBase =
    e.combinations.length === 1 &&
    e.combinations[0]!.hex === e.hex &&
    e.combinations[0]!.ratio === 1;
  if (isBase) BASES.set(e.hex, e);
  else MIXES.push(e);
}

function baseName(hex: string): string {
  const b = BASES.get(hex);
  return b?.note ?? hex;
}

// ---- Scoring --------------------------------------------------------------
function scoreModel(model: ModelDef, mixes: DatasetEntry[]): Score[] {
  return mixes.map((m) => {
    const parts: FilamentPart[] = m.combinations.map((c) => ({
      hex: c.hex,
      ratio: c.ratio,
    }));
    const predicted = model.fn(parts);
    const measuredLab = m.lab;
    const dE = deltaE2000(measuredLab, predicted.lab);
    const sorted = [...m.combinations].sort((a, b) => b.ratio - a.ratio);
    return {
      measured: { hex: m.hex, lab: measuredLab },
      predicted,
      dE,
      dL: measuredLab.L - predicted.lab.L,
      da: measuredLab.a - predicted.lab.a,
      db: measuredLab.b - predicted.lab.b,
      pairLabel: m.combinations
        .map((c) => baseName(c.hex))
        .sort()
        .join(' + '),
      pairKey: m.combinations
        .map((c) => c.hex)
        .sort()
        .join('|'),
      ratioStr: sorted.map((c) => Math.round(c.ratio * 100)).join(':'),
      nParts: m.combinations.length,
    };
  });
}

interface Stats {
  n: number;
  median: number;
  mean: number;
  p90: number;
  max: number;
  under5: number;
  under8: number;
  under10: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx]!;
}
function statsOf(scores: Score[]): Stats {
  const dEs = scores.map((s) => s.dE);
  return {
    n: dEs.length,
    median: median(dEs),
    mean: dEs.reduce((s, x) => s + x, 0) / Math.max(1, dEs.length),
    p90: percentile(dEs, 90),
    max: dEs.length === 0 ? 0 : Math.max(...dEs),
    under5: dEs.filter((d) => d < 5).length,
    under8: dEs.filter((d) => d < 8).length,
    under10: dEs.filter((d) => d < 10).length,
  };
}

// ---- Render ---------------------------------------------------------------
function deClass(d: number): string {
  if (d < 5) return 'de-good';
  if (d < 10) return 'de-warn';
  return 'de-bad';
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSummary(scoresByModel: Record<string, Score[]>): string {
  const cards = MODELS.map((m) => {
    const s = statsOf(scoresByModel[m.id]!);
    return `
      <div class="card stat-card">
        <h3>${escape(m.name)}</h3>
        <p class="model-desc">${escape(m.desc)}</p>
        <div class="stat-grid">
          <div><span class="lbl">median ΔE</span><span class="val ${deClass(s.median)}">${s.median.toFixed(2)}</span></div>
          <div><span class="lbl">mean</span><span class="val">${s.mean.toFixed(2)}</span></div>
          <div><span class="lbl">p90</span><span class="val">${s.p90.toFixed(1)}</span></div>
          <div><span class="lbl">max</span><span class="val">${s.max.toFixed(1)}</span></div>
          <div><span class="lbl">&lt; 5</span><span class="val">${s.under5}/${s.n}</span></div>
          <div><span class="lbl">&lt; 8</span><span class="val">${s.under8}/${s.n}</span></div>
          <div><span class="lbl">&lt; 10</span><span class="val">${s.under10}/${s.n}</span></div>
        </div>
      </div>
    `;
  }).join('');
  return `<section class="summary-grid">${cards}</section>`;
}

// ΔE-bin histogram. yMax is supplied externally so every histogram on the page
// renders against the same scale — that's the only way to compare distribution
// shapes across models / 2-color vs 3-color side-by-side.
const HISTO_BIN_WIDTH = 2;
const HISTO_MAX_BIN = 40;
const HISTO_NUM_BINS = Math.ceil(HISTO_MAX_BIN / HISTO_BIN_WIDTH);

function bucketize(scores: Score[]): number[] {
  const bins = new Array<number>(HISTO_NUM_BINS).fill(0);
  for (const s of scores) {
    const idx = Math.min(HISTO_NUM_BINS - 1, Math.floor(s.dE / HISTO_BIN_WIDTH));
    bins[idx]!++;
  }
  return bins;
}

function renderHistogram(bins: number[], yMax: number, subtitle: string): string {
  const bars = bins
    .map((c, i) => {
      const center = i * HISTO_BIN_WIDTH + HISTO_BIN_WIDTH / 2;
      const cls = center < 5 ? 'good' : center < 10 ? 'warn' : 'bad';
      const h = c === 0 ? 0 : Math.max(2, Math.round((c / yMax) * 140));
      return `<div class="bar ${cls}" style="height:${h}px"><span class="count">${c || ''}</span></div>`;
    })
    .join('');
  const axis = bins
    .map((_, i) => `<span>${i * HISTO_BIN_WIDTH}</span>`)
    .concat([`<span>${HISTO_MAX_BIN}</span>`])
    .join('');
  const total = bins.reduce((s, x) => s + x, 0);
  return `
    <div class="histo-cell">
      <h4>${escape(subtitle)} <em>· n=${total}</em></h4>
      <div class="histo">${bars}</div>
      <div class="axis">${axis}</div>
    </div>
  `;
}

function renderModelHistograms(
  scoresByModel: Record<string, Score[]>,
  yMaxByKind: { two: number; three: number },
): string {
  const cards = MODELS.map((m) => {
    const all = scoresByModel[m.id]!;
    const two = all.filter((s) => s.nParts === 2);
    const three = all.filter((s) => s.nParts === 3);
    return `
      <div class="card">
        <h2>${escape(m.name)} <em>· ΔE distribution</em></h2>
        <div class="histo-row">
          ${renderHistogram(bucketize(two), yMaxByKind.two, '2-color')}
          ${renderHistogram(bucketize(three), yMaxByKind.three, '3-color (1:1:1)')}
        </div>
        <div class="axis-title">ΔE2000 bin</div>
      </div>
    `;
  }).join('');
  return cards;
}

// Per-recipe breakdown — one row per (pair/triple, ratio). For each recipe we
// show the measured swatch and every model's predicted swatch + ΔE so you can
// eyeball the actual color error, not just the number. Sorted by v7 ΔE
// (descending) so v7's worst recipes float to the top.
// Strip the leading batch-number prefix from filament notes in the data file
// (e.g. "3 - Prusament PLA Army Green" → "Prusament PLA Army Green"). The
// batch number is meaningful provenance in the dataset but visual noise in
// the breakdown table.
function cleanFilamentName(name: string): string {
  return name.replace(/^\d+\s*-\s*/, '');
}

function renderRecipeTable(
  mixes: DatasetEntry[],
  scoresByModel: Record<string, Score[]>,
): string {
  const rows = mixes.map((m, idx) => {
    const sorted = [...m.combinations].sort((a, b) => b.ratio - a.ratio);
    return {
      measuredHex: m.hex,
      hexes: sorted.map((c) => c.hex),
      label: m.combinations
        .map((c) => cleanFilamentName(baseName(c.hex)))
        .sort()
        .join(' + '),
      ratioStr: sorted.map((c) => Math.round(c.ratio * 100)).join(':'),
      nParts: m.combinations.length,
      perModel: Object.fromEntries(
        MODELS.map((mod) => [mod.id, scoresByModel[mod.id]![idx]!]),
      ) as Record<string, Score>,
    };
  });
  rows.sort((a, b) => b.perModel['v7']!.dE - a.perModel['v7']!.dE);

  const modelHeaders = MODELS.map(
    (m) => `<th class="num">${escape(m.name)}</th>`,
  ).join('');

  // Fixed column widths so every model cell lines up cleanly across rows.
  // Tweak these here if a model name grows longer.
  const colgroup = `
    <colgroup>
      <col style="width:auto" />
      <col style="width:64px" />
      <col style="width:108px" />
      ${MODELS.map(() => `<col style="width:88px" />`).join('')}
    </colgroup>
  `;

  const body = rows
    .map((r) => {
      const swatches = r.hexes
        .map((h) => `<span class="mini-swatch" style="background:${h}"></span>`)
        .join('');
      const cells = MODELS.map((mod) => {
        const s = r.perModel[mod.id]!;
        return `
        <td class="model-cell">
          <div class="cell-split">
            <span class="mini-swatch" style="background:${s.predicted.hex}"></span>
            <span class="${deClass(s.dE)}">${s.dE.toFixed(2)}</span>
          </div>
        </td>`;
      }).join('');
      return `
      <tr>
        <td class="recipe-cell">${swatches}<span class="recipe-name">${escape(r.label)}</span></td>
        <td class="ratio-cell">${escape(r.ratioStr)}</td>
        <td class="model-cell">
          <div class="cell-split">
            <span class="mini-swatch" style="background:${r.measuredHex}"></span>
            <span class="hex-mono">${r.measuredHex}</span>
          </div>
        </td>
        ${cells}
      </tr>
    `;
    })
    .join('');

  return `
    <div class="card">
      <h2>Per-recipe breakdown <em>· sorted by v7 ΔE, worst first</em></h2>
      <p class="meta" style="margin-bottom:10px;">
        Each row is one measured recipe. The Measured column is the actual
        swatch; each model column shows its predicted swatch and ΔE2000.
      </p>
      <table class="recipe-table">
        ${colgroup}
        <thead>
          <tr>
            <th>Recipe</th>
            <th class="num">Ratio</th>
            <th class="num">Measured</th>
            ${modelHeaders}
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

// ---- Main render ----------------------------------------------------------
const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

const twoColor = MIXES.filter((m) => m.combinations.length === 2);
const threeColor = MIXES.filter((m) => m.combinations.length === 3);

// Concatenate once and reuse — the per-model score arrays must align
// index-for-index with this same array, so the recipe table can look up
// `scoresByModel[id][i]` for `allMixes[i]` without a key/lookup dance.
const allMixes = [...twoColor, ...threeColor];

const scoresByModel: Record<string, Score[]> = {};
for (const m of MODELS) {
  scoresByModel[m.id] = scoreModel(m, allMixes);
}

// Per-kind y-axis scale: every 2-color histogram shares one ceiling, every
// 3-color histogram shares its own. Cross-model comparison stays valid within
// each kind, but the sparse 3-color set (n=15) doesn't get crushed by the
// dense 2-color one (n=107).
let yMaxTwo = 1;
let yMaxThree = 1;
for (const m of MODELS) {
  const all = scoresByModel[m.id]!;
  yMaxTwo = Math.max(yMaxTwo, ...bucketize(all.filter((s) => s.nParts === 2)));
  yMaxThree = Math.max(yMaxThree, ...bucketize(all.filter((s) => s.nParts === 3)));
}

app.innerHTML = `
  <p class="meta">${twoColor.length} two-color samples · ${threeColor.length} three-color samples · ${BASES.size} base filaments</p>
  ${renderSummary(scoresByModel)}
  ${renderModelHistograms(scoresByModel, { two: yMaxTwo, three: yMaxThree })}
  ${renderRecipeTable(allMixes, scoresByModel)}
`;
