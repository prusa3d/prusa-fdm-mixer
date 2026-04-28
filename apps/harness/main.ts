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
  mixPolyMixer,
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
    desc: 'BambuStudio default — naive ratio average',
    fn: mixLinearRgb,
  },
  {
    id: 'km',
    name: 'Kubelka-Munk',
    desc: 'Textbook subtractive pigment model',
    fn: mixKubelkaMunk,
  },
  {
    id: 'poly',
    name: 'PolyMixer',
    desc: 'YN n=2.5 approximation of FilamentMixer',
    fn: mixPolyMixer,
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

function renderHistogram(scores: Score[], modelName: string): string {
  const binWidth = 2;
  const maxBin = 40;
  const numBins = Math.ceil(maxBin / binWidth);
  const bins = new Array<number>(numBins).fill(0);
  for (const s of scores) {
    const idx = Math.min(numBins - 1, Math.floor(s.dE / binWidth));
    bins[idx]!++;
  }
  const maxCount = Math.max(...bins, 1);
  const bars = bins
    .map((c, i) => {
      const center = i * binWidth + binWidth / 2;
      const cls = center < 5 ? 'good' : center < 10 ? 'warn' : 'bad';
      const h = c === 0 ? 0 : Math.max(2, Math.round((c / maxCount) * 140));
      return `<div class="bar ${cls}" style="height:${h}px"><span class="count">${c || ''}</span></div>`;
    })
    .join('');
  const axis = bins
    .map((_, i) => `<span>${i * binWidth}</span>`)
    .concat([`<span>${maxBin}</span>`])
    .join('');
  return `
    <div class="card">
      <h2>${escape(modelName)} <em>· ΔE distribution</em></h2>
      <div class="histo">${bars}</div>
      <div class="axis">${axis}</div>
      <div class="axis-title">ΔE2000 bin</div>
    </div>
  `;
}

interface PairSummary {
  label: string;
  hexes: [string, string];
  n: number;
  median: number;
  max: number;
}
function renderPairTable(scores: Score[]): string {
  const groups = new Map<string, Score[]>();
  for (const s of scores.filter((s) => s.nParts === 2)) {
    if (!groups.has(s.pairLabel)) groups.set(s.pairLabel, []);
    groups.get(s.pairLabel)!.push(s);
  }
  const rows: PairSummary[] = [];
  for (const [label, items] of groups) {
    const dEs = items.map((s) => s.dE);
    const hexes = items[0]!.pairKey.split('|') as [string, string];
    rows.push({
      label,
      hexes,
      n: items.length,
      median: median(dEs),
      max: Math.max(...dEs),
    });
  }
  rows.sort((a, b) => b.median - a.median);
  const body = rows
    .map(
      (r) => `
    <tr>
      <td>
        <span class="mini-swatch" style="background:${r.hexes[0]}"></span>
        <span class="mini-swatch" style="background:${r.hexes[1]}"></span>
        ${escape(r.label)}
      </td>
      <td class="num">${r.n}</td>
      <td class="num ${deClass(r.median)}">${r.median.toFixed(2)}</td>
      <td class="num">${r.max.toFixed(2)}</td>
    </tr>
  `
    )
    .join('');
  return `
    <div class="card">
      <h2>v7 per-pair breakdown <em>· worst-median first</em></h2>
      <table>
        <thead>
          <tr>
            <th>Pair</th>
            <th class="num">n</th>
            <th class="num">median ΔE</th>
            <th class="num">max ΔE</th>
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

const scoresByModel: Record<string, Score[]> = {};
for (const m of MODELS) {
  scoresByModel[m.id] = scoreModel(m, [...twoColor, ...threeColor]);
}

const v7Scores = scoresByModel['v7']!;

app.innerHTML = `
  <p class="meta">${twoColor.length} two-color samples · ${threeColor.length} three-color samples · ${BASES.size} base filaments</p>
  ${renderSummary(scoresByModel)}
  ${MODELS.map((m) => renderHistogram(scoresByModel[m.id]!, m.name)).join('')}
  ${renderPairTable(v7Scores)}
`;
