/**
 * Harness app — score the prusa-fdm-mixer model against measured prints.
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
  mixHueforgeStyle,
  mixCam16Ucs,
  mixYuleNielsen,
  deltaE2000,
  hexToLab,
  type LAB,
  type FilamentPart,
  type HueforgeStylePart,
  type MixResult,
} from '@/index.js';

// Vite-friendly raw imports. Both data files live in /data and get bundled.
import fittingText from '../../data/fitting-set.jsonl?raw';
import holdoutText from '../../data/holdout-set.jsonl?raw';
import hueforgeText from '../../data/filament-library-hueforge.json?raw';

// ---- Types ----------------------------------------------------------------
type SourceTag = 'fitting' | 'holdout';

interface DatasetEntry {
  hex: string;
  lab: LAB;
  note?: string;
  combinations: Array<{ hex: string; ratio: number; lab?: LAB }>;
  source: SourceTag;
}

type ModelFn = (parts: FilamentPart[]) => MixResult;

interface ModelDef {
  id: string;
  name: string;
  /** Compact label for narrow table headers; falls back to `name`. */
  shortName?: string;
  desc: string;
  fn: ModelFn;
  /** If true, omit from the per-pair recipe table (still shown in summary + histograms). */
  summaryOnly?: boolean;
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
  source: SourceTag;
}

// ---- Models ---------------------------------------------------------------
// Order: prusa-fdm-mixer (this work), filament-mixer (current BS /
// FullSpectrum), HueForge-style, BambuStudio (legacy), Kubelka-Munk,
// CAM16-UCS, Yule-Nielsen (base). "BambuStudio (legacy)" is the naive 0–255
// sRGB ratio average — verified verbatim in commit a6ea01991 (`blend_colors`
// in MixedFilamentDialog). Since that's the same as a generic textbook
// "linear sRGB" baseline, no separate entry for the latter. CAM16-UCS is the
// perceptual-appearance-model baseline (uniform color space averaging).
// Yule-Nielsen (base) is the uncorrected ancestor of prusa-fdm-mixer —
// summary/histogram only, omitted from the recipe table to keep it readable.
const MODELS: ModelDef[] = [
  {
    id: 'prusa-fdm-mixer',
    name: 'prusa-fdm-mixer (this work)',
    shortName: 'PFM',
    desc: 'Yule-Nielsen + lightness + chroma + cyan-band hue. Calibrated and shipped by Prusa Research s.r.o.',
    fn: mixFilaments,
  },
  {
    id: 'filament-mixer',
    name: 'filament-mixer',
    shortName: 'FM',
    desc: 'Polynomial Mixbox approximation by justinh-rahb (MIT). Originated in OrcaSlicer-FullSpectrum; BambuStudio adopted it on 2026-04-17',
    fn: mixFilamentMixer,
  },
  {
    id: 'hueforge-style',
    name: 'HueForge-style (TD)',
    shortName: 'HF-style',
    desc: 'TD-weighted linear-RGB blend. Uses HueForge transmission distance (manual TD for Fiberlogy) so opaque filaments dominate translucent ones at the same ratio. Heuristic — HueForge\'s real model targets layered prints, not extrusion mixing',
    fn: mixHueforgeStyle,
  },
  {
    id: 'bambu-legacy',
    name: 'BambuStudio (legacy)',
    shortName: 'BS legacy',
    desc: 'Verbatim port of `blend_colors` from BS pre-2026-04-17: naive 0–255 sRGB ratio average, no gamma. Most non-BS slicers still use this',
    fn: mixLinearRgb,
  },
  {
    id: 'km',
    name: 'Kubelka-Munk',
    shortName: 'KM',
    desc: 'Textbook subtractive pigment model — physics baseline, no calibration',
    fn: mixKubelkaMunk,
  },
  {
    id: 'cam16-ucs',
    name: 'CAM16-UCS',
    shortName: 'CAM16',
    desc: 'Linear average in CAM16-UCS uniform color space (D65, average surround, La=64, Yb=20). Perceptual-appearance-model baseline — like gamma RGB but with chromatic adaptation and contrast modelling. No calibration; emissive averaging, not subtractive pigment math',
    fn: mixCam16Ucs,
  },
  {
    id: 'yule-nielsen',
    name: 'Yule-Nielsen (base)',
    shortName: 'YN',
    desc: 'Pure Yule-Nielsen base prediction (n = 3.0) in linear-light RGB, no empirical corrections. Step 1 of prusa-fdm-mixer in isolation — the delta vs. PFM shows what the v7 lightness/chroma/hue corrections buy',
    fn: mixYuleNielsen,
    summaryOnly: true,
  },
];

// ---- Data ------------------------------------------------------------------
function parseDataset(text: string, source: SourceTag): DatasetEntry[] {
  const lines = text.trim().split(/\r?\n/);
  const out: DatasetEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line) as Omit<DatasetEntry, 'source'>;
    out.push({ ...raw, source });
  }
  return out;
}

// Load fitting (training) and holdout sets together so the harness can
// score both, with a top-of-page toggle to filter the active view.
const ENTRIES = [
  ...parseDataset(fittingText, 'fitting'),
  ...parseDataset(holdoutText, 'holdout'),
];
const BASES = new Map<string, DatasetEntry>();
const MIXES: DatasetEntry[] = [];
for (const e of ENTRIES) {
  const isBase =
    e.combinations.length === 1 &&
    e.combinations[0]!.hex === e.hex &&
    e.combinations[0]!.ratio === 1;
  // If a hex appears in both files (different LAB readings of the same product
  // across batches), keep the first occurrence — fitting wins because we
  // listed it first. Today's data has no collisions; this is just a safety net.
  if (isBase) {
    if (!BASES.has(e.hex)) BASES.set(e.hex, e);
  } else {
    MIXES.push(e);
  }
}

function baseName(hex: string): string {
  const b = BASES.get(hex);
  return b?.note ?? hex;
}

// HueForge cross-reference: their library carries vendor hex + transmission
// distance for ~625 filaments. We match each base by `{brand} {material} {name}`
// (lowercased, alphanum-only) so the bases table can show the vendor's nominal
// hex/td next to our measured ground truth.
interface HueforgeEntry { brand: string; material: string; name: string; hex: string; td: number }
interface HueforgeFile { entries: HueforgeEntry[] }
const HF_KEY = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const HUEFORGE = new Map<string, { hex: string; td: number }>();
for (const e of (JSON.parse(hueforgeText) as HueforgeFile).entries) {
  HUEFORGE.set(HF_KEY(`${e.brand} ${e.material} ${e.name}`), { hex: e.hex, td: e.td });
}

// HueForge doesn't carry Fiberlogy. These TDs are user-supplied estimates from
// observed opacity behaviour; the hex falls back to our measurement (set when
// looking up — see `findHueforge`). Keyed by the same normalized name as HUEFORGE.
const MANUAL_TD = new Map<string, number>([
  [HF_KEY('Fiberlogy Easy PLA White'), 5.1],
  [HF_KEY('Fiberlogy Easy PLA Cyan'), 5.5],
  [HF_KEY('Fiberlogy Easy PLA Yellow'), 7.6],
  [HF_KEY('Fiberlogy Easy PLA Magenta'), 4.1],
]);

// ---- Scoring --------------------------------------------------------------
function scoreModel(model: ModelDef, mixes: DatasetEntry[]): Score[] {
  return mixes.map((m) => {
    // HueforgeStylePart is structurally a superset of FilamentPart (extra
    // optional `td`). All other models ignore the `td` field; the harness
    // attaches it once here so the HueForge-style model can read it.
    const parts: HueforgeStylePart[] = m.combinations.map((c) => ({
      hex: c.hex,
      ratio: c.ratio,
      td: TD_BY_HEX.get(c.hex),
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
      source: m.source,
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

// Tiny T/H pill rendered next to each recipe so set membership is visible
// even when the toggle is set to "All". Matches the .set-badge styles.
function renderSetBadge(source: SourceTag): string {
  const letter = source === 'fitting' ? 'T' : 'H';
  const title = source === 'fitting' ? 'Training set' : 'Holdout set';
  return `<span class="set-badge set-badge-${letter}" title="${title}">${letter}</span>`;
}

function renderSummary(scoresByModel: Record<string, Score[]>): string {
  const cards = MODELS.map((m) => {
    const all = scoresByModel[m.id]!;
    const s2 = statsOf(all.filter((s) => s.nParts === 2));
    const s3 = statsOf(all.filter((s) => s.nParts === 3));
    const sA = statsOf(all);
    // Each row: label + value for 2-color, 3-color, overall. Median ΔE is
    // the headline metric so it keeps its colored deClass; the rest stay
    // monochrome to avoid a wall of color in a 3-column table.
    const row = (label: string, fmt: (s: Stats) => string, color = false) => `
      <tr>
        <th>${label}</th>
        <td${color ? ` class="${deClass(s2.median)}"` : ''}>${fmt(s2)}</td>
        <td${color ? ` class="${deClass(s3.median)}"` : ''}>${fmt(s3)}</td>
        <td${color ? ` class="${deClass(sA.median)}"` : ''}>${fmt(sA)}</td>
      </tr>`;
    return `
      <div class="card stat-card">
        <h3>${escape(m.name)}</h3>
        <p class="model-desc">${escape(m.desc)}</p>
        <table class="stat-split">
          <thead>
            <tr><th></th><th>2-color</th><th>3-color</th><th>all</th></tr>
          </thead>
          <tbody>
            ${row('median ΔE', (s) => s.median.toFixed(2), true)}
            ${row('mean', (s) => s.mean.toFixed(2))}
            ${row('p90', (s) => s.p90.toFixed(1))}
            ${row('max', (s) => s.max.toFixed(1))}
            ${row('&lt; 5', (s) => `${s.under5}/${s.n}`)}
            ${row('&lt; 8', (s) => `${s.under8}/${s.n}`)}
            ${row('&lt; 10', (s) => `${s.under10}/${s.n}`)}
          </tbody>
        </table>
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
// eyeball the actual color error, not just the number. Sorted by
// prusa-fdm-mixer ΔE (descending) so its worst recipes float to the top.
// Filament notes in the data file are formatted as "<batch> - <name>", e.g.
// "3 - Prusament PLA Army Green". The batch number is meaningful provenance
// (which print run produced the swatch), but it doesn't belong inline with
// the name — split it out so we can show it in a dedicated column.
function parseFilamentNote(note: string): { batch: number | null; name: string } {
  const m = note.match(/^(\d+)\s*-\s*(.+)$/);
  if (m) return { batch: parseInt(m[1]!, 10), name: m[2]!.trim() };
  return { batch: null, name: note };
}
function cleanFilamentName(name: string): string {
  return parseFilamentNote(name).name;
}
function noteBatch(note: string): number | null {
  return parseFilamentNote(note).batch;
}

// Two known mismatches between our note convention and HueForge's product
// names: we record `Prusa Galaxy Black` (HueForge calls it just `Galaxy Black`)
// and `Blend Viva La Bronze` (HueForge drops the `Blend` qualifier).
// `fallbackHex` is used when the match comes from MANUAL_TD (no vendor hex
// available) — we substitute our measured hex so the mixing model still has
// a color to work with. `manual=true` flags those rows for the bases table.
interface HueforgeMatch { hex: string; td: number; manual: boolean }
function findHueforge(note: string, fallbackHex: string): HueforgeMatch | null {
  const name = parseFilamentNote(note).name
    .replace(/\bPrusa Galaxy\b/g, 'Galaxy')
    .replace(/\bBlend Viva La Bronze\b/g, 'Viva La Bronze');
  const k = HF_KEY(name);
  const hf = HUEFORGE.get(k);
  if (hf) return { hex: hf.hex, td: hf.td, manual: false };
  const td = MANUAL_TD.get(k);
  if (td !== undefined) return { hex: fallbackHex, td, manual: true };
  return null;
}

// Lookup table for the mixing pipeline: each base hex → its TD. Built once
// here so `scoreModel` can inject TD into FilamentPart for `mixHueforgeStyle`.
const TD_BY_HEX = new Map<string, number>();
for (const b of BASES.values()) {
  const m = findHueforge(b.note ?? '', b.hex);
  if (m) TD_BY_HEX.set(b.hex, m.td);
}

// Compact LAB pretty-printer for the small "source of truth" lines under each
// measured hex. The column header reads "Hex / LAB", so the order (L, a, b)
// is implied — drop the letter labels to keep the line tight in narrow cells.
// Mid-dot separator is wider than space but visually disambiguates the
// triple. One decimal place is enough to spot bad readings.
function fmtLab(lab: LAB): string {
  return `${lab.L.toFixed(1)} · ${lab.a.toFixed(1)} · ${lab.b.toFixed(1)}`;
}

function renderBasesTable(): string {
  const rows = [...BASES.values()]
    .map((b) => {
      const parsed = parseFilamentNote(b.note ?? b.hex);
      return {
        hex: b.hex,
        batch: parsed.batch,
        name: parsed.name,
        lab: b.lab,
        hf: findHueforge(b.note ?? '', b.hex),
      };
    })
    // Sort by batch first, then by name within each batch — keeps rows from
    // the same print run grouped together.
    .sort((a, b) => {
      const ba = a.batch ?? Infinity;
      const bb = b.batch ?? Infinity;
      if (ba !== bb) return ba - bb;
      return a.name.localeCompare(b.name);
    });

  const body = rows
    .map((r) => {
      // Fiberlogy bases use a manual TD with the measured hex as the HF hex —
      // ΔE against ourselves is meaningless (always 0), so render `—` and
      // italicize the HF Hex/TD cells to flag the manual provenance.
      const hfHex = r.hf
        ? r.hf.manual
          ? `<em><span class="mini-swatch" style="background:${r.hf.hex}"></span>${r.hf.hex}</em>`
          : `<span class="mini-swatch" style="background:${r.hf.hex}"></span>${r.hf.hex}`
        : '—';
      const hfTd = r.hf
        ? (r.hf.manual ? `<em>${r.hf.td.toFixed(1)}</em>` : r.hf.td.toFixed(1))
        : '—';
      const hfDeRaw = r.hf && !r.hf.manual ? deltaE2000(r.lab, hexToLab(r.hf.hex)) : null;
      const hfDe =
        hfDeRaw !== null
          ? `<span class="${deClass(hfDeRaw)}">${hfDeRaw.toFixed(2)}</span>`
          : '—';
      return `
      <tr>
        <td class="batch-cell">${r.batch ?? ''}</td>
        <td class="base-cell"><span class="mini-swatch" style="background:${r.hex}"></span><span>${escape(r.name)}</span></td>
        <td class="hex-cell">${r.hex}</td>
        <td class="num">${r.lab.L.toFixed(2)}</td>
        <td class="num">${r.lab.a.toFixed(2)}</td>
        <td class="num">${r.lab.b.toFixed(2)}</td>
        <td class="hex-cell">${hfHex}</td>
        <td class="num">${hfTd}</td>
        <td class="num">${hfDe}</td>
      </tr>
    `;
    })
    .join('');

  return `
    <div class="card">
      <h2>Base filaments <em>· measured ground truth vs. HueForge nominal · ${rows.length} entries</em></h2>
      <table class="bases-table">
        <colgroup>
          <col style="width:64px" />
          <col style="width:auto" />
          <col style="width:96px" />
          <col style="width:80px" />
          <col style="width:80px" />
          <col style="width:80px" />
          <col style="width:120px" />
          <col style="width:64px" />
          <col style="width:72px" />
        </colgroup>
        <thead>
          <tr>
            <th class="num">Batch</th>
            <th>Filament</th>
            <th class="num">Hex</th>
            <th class="num"><span class="icon-inline" title="Measured (ground truth)">${FLASK_ICON}</span> L*</th>
            <th class="num">a*</th>
            <th class="num">b*</th>
            <th class="num" title="HueForge vendor-published hex">HF Hex</th>
            <th class="num" title="HueForge transmission distance (mm)">HF TD</th>
            <th class="num" title="ΔE2000 between measured LAB and HueForge nominal hex">ΔE</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

// Inline SVG flask — used as the visual anchor for the Measured column. Stroke
// uses currentColor so the icon inherits the surrounding text color, and
// stays consistent with the dark monochrome aesthetic.
const FLASK_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M5.5 2v4L3 12.5A1.2 1.2 0 0 0 4.1 14.5h7.8A1.2 1.2 0 0 0 13 12.5L10.5 6V2"/>
  <path d="M5 2h6"/>
  <path d="M4.7 10.5h6.6"/>
</svg>`;

function renderRecipeTable(
  mixes: DatasetEntry[],
  scoresByModel: Record<string, Score[]>,
): string {
  // Models that opt out (e.g. uncorrected baselines) appear in the summary +
  // histograms only, not as columns in this already-wide table.
  const tableModels = MODELS.filter((m) => !m.summaryOnly);
  const rows = mixes.map((m, idx) => {
    const sorted = [...m.combinations].sort((a, b) => b.ratio - a.ratio);
    const components = sorted.map((c) => ({
      hex: c.hex,
      pct: Math.round(c.ratio * 100),
    }));
    // Collect the unique batch numbers across all component filaments. Most
    // recipes are within one batch; mixed-batch recipes show e.g. "1+2".
    const batches = Array.from(
      new Set(
        m.combinations
          .map((c) => noteBatch(baseName(c.hex)))
          .filter((b): b is number => b !== null),
      ),
    ).sort((a, b) => a - b);
    return {
      measuredHex: m.hex,
      measuredLab: m.lab,
      components,
      batchLabel: batches.length === 0 ? '' : batches.join('+'),
      label: m.combinations
        .map((c) => cleanFilamentName(baseName(c.hex)))
        .sort()
        .join(' + '),
      ratioStr: components.map((c) => c.pct).join(':'),
      nParts: m.combinations.length,
      source: m.source,
      perModel: Object.fromEntries(
        tableModels.map((mod) => [mod.id, scoresByModel[mod.id]![idx]!]),
      ) as Record<string, Score>,
    };
  });
  rows.sort((a, b) => b.perModel['prusa-fdm-mixer']!.dE - a.perModel['prusa-fdm-mixer']!.dE);

  // Two header rows: top groups the swatches and the deltas; bottom names each
  // model under its own swatch + delta column. The first three columns
  // (Recipe / Ratio / Measured) span both header rows via rowspan.
  // The FIRST cell of each new column-group carries `.boundary-left` so we
  // draw a vertical divider between the three regions of the table.
  const swatchHeaders = tableModels.map(
    (m, i) => `<th class="swatch-head${i === 0 ? ' boundary-left' : ''}">${escape(m.shortName ?? m.name)}</th>`,
  ).join('');
  const deltaHeaders = tableModels.map(
    (m, i) => `<th class="num${i === 0 ? ' boundary-left' : ''}">${escape(m.shortName ?? m.name)}</th>`,
  ).join('');

  // Column order, left → right: visual signal first (measured swatch,
  // predicted swatches, deltas), then metadata trailing (components, ratio,
  // hex+lab, recipe name, batch). Swatch-only cells are tight (the 22px chip);
  // delta cells hold up to ~5 chars of mono ("99.99"); recipe-name column
  // flexes to absorb extra width.
  const colgroup = `
    <colgroup>
      <col style="width:40px" />
      ${tableModels.map(() => `<col style="width:40px" />`).join('')}
      ${tableModels.map(() => `<col style="width:64px" />`).join('')}
      <col style="width:96px" />
      <col style="width:64px" />
      <col style="width:148px" />
      <col style="width:auto" />
      <col style="width:48px" />
    </colgroup>
  `;

  const body = rows
    .map((r) => {
      // Width proportional to ratio percent — 75% chip is 3× as wide as 25%,
      // 33:33:33 chips are equal thirds. Px factor chosen so total ≤ column width.
      const recipeSwatches = r.components
        .map(
          (c) =>
            `<span class="mini-swatch component-swatch" style="background:${c.hex};width:${(c.pct * 0.8).toFixed(1)}px" title="${c.pct}%"></span>`,
        )
        .join('');
      const swatchCells = tableModels.map((mod, i) => {
        const s = r.perModel[mod.id]!;
        return `<td class="swatch-cell${i === 0 ? ' boundary-left' : ''}"><span class="mini-swatch" style="background:${s.predicted.hex}"></span></td>`;
      }).join('');
      const deltaCells = tableModels.map((mod, i) => {
        const s = r.perModel[mod.id]!;
        return `<td class="delta-cell${i === 0 ? ' boundary-left' : ''}"><span class="${deClass(s.dE)}">${s.dE.toFixed(2)}</span></td>`;
      }).join('');
      return `
      <tr>
        <td class="swatch-cell"><span class="mini-swatch" style="background:${r.measuredHex}"></span></td>
        ${swatchCells}
        ${deltaCells}
        <td class="components-cell boundary-left">${recipeSwatches}</td>
        <td class="ratio-cell">${escape(r.ratioStr)}</td>
        <td class="measured-info-cell">
          <div class="measured-meta">
            <span class="hex-mono">${r.measuredHex}</span>
            <span class="lab-mono" title="L* a* b*">${fmtLab(r.measuredLab)}</span>
          </div>
        </td>
        <td class="recipe-cell">${renderSetBadge(r.source)}${escape(r.label)}</td>
        <td class="batch-cell">${escape(r.batchLabel)}</td>
      </tr>
    `;
    })
    .join('');

  return `
    <div class="card">
      <h2>Per-recipe breakdown <em>· sorted by prusa-fdm-mixer ΔE, worst first</em></h2>
      <p class="meta" style="margin-bottom:10px;">
        Components and measured/predicted swatches form a continuous strip on
        the left; ΔE2000 per model on the right.
      </p>
      <table class="recipe-table">
        ${colgroup}
        <thead>
          <tr>
            <th class="icon-head" rowspan="2" title="Measured (ground truth)">${FLASK_ICON}</th>
            <th class="group-head" colspan="${tableModels.length}">Predicted swatch</th>
            <th class="group-head num" colspan="${tableModels.length}">ΔE2000</th>
            <th class="boundary-left" rowspan="2">Components</th>
            <th class="num" rowspan="2">Ratio</th>
            <th class="num" rowspan="2"><span class="icon-inline" title="Measured (ground truth)">${FLASK_ICON}</span> Hex / LAB</th>
            <th rowspan="2">Recipe</th>
            <th class="num" rowspan="2">Batch</th>
          </tr>
          <tr>
            ${swatchHeaders}
            ${deltaHeaders}
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

// Score every mix once on the full set; toggle filtering happens at render
// time on the resulting Score arrays (each Score carries its source tag).
// 5 models × ~228 mixes is trivial — no need to re-score on toggle.
const scoresByModel: Record<string, Score[]> = {};
for (const m of MODELS) {
  scoresByModel[m.id] = scoreModel(m, allMixes);
}

// Counts for the toggle pills — reflect the underlying data, not the
// currently-active filter, so the user sees what each option will yield.
const countAll = allMixes.length;
const countFitting = allMixes.filter((m) => m.source === 'fitting').length;
const countHoldout = allMixes.filter((m) => m.source === 'holdout').length;

type ActiveSet = 'all' | 'fitting' | 'holdout';
let activeSet: ActiveSet = 'all';

function filterByActive<T extends { source: SourceTag }>(items: T[]): T[] {
  if (activeSet === 'all') return items;
  return items.filter((it) => it.source === activeSet);
}

function renderToggle(): string {
  const opt = (set: ActiveSet, label: string, count: number) =>
    `<button data-set="${set}" class="${activeSet === set ? 'active' : ''}">${label} <em>· ${count}</em></button>`;
  return `
    <div class="set-toggle" role="tablist" aria-label="Active dataset">
      ${opt('all', 'All measurements', countAll)}
      ${opt('fitting', 'Training set', countFitting)}
      ${opt('holdout', 'Holdout set', countHoldout)}
    </div>
  `;
}

function activeMetaLine(activeMixes: DatasetEntry[]): string {
  const two = activeMixes.filter((m) => m.combinations.length === 2).length;
  const three = activeMixes.filter((m) => m.combinations.length === 3).length;
  const setName =
    activeSet === 'all' ? 'All measurements' :
    activeSet === 'fitting' ? 'Training set' : 'Holdout set';
  return `${setName} · ${two} two-color · ${three} three-color · ${BASES.size} base filaments (across all batches)`;
}

function render(): void {
  const activeMixes = filterByActive(allMixes);
  const activeScores: Record<string, Score[]> = {};
  for (const m of MODELS) {
    activeScores[m.id] = filterByActive(scoresByModel[m.id]!);
  }

  // Recompute per-kind y-axis ceilings against the active slice so a small
  // holdout subset isn't crushed by an all-set y-max.
  let yMaxTwo = 1;
  let yMaxThree = 1;
  for (const m of MODELS) {
    const all = activeScores[m.id]!;
    yMaxTwo = Math.max(yMaxTwo, ...bucketize(all.filter((s) => s.nParts === 2)));
    yMaxThree = Math.max(yMaxThree, ...bucketize(all.filter((s) => s.nParts === 3)));
  }

  app!.innerHTML = `
    ${renderToggle()}
    <p class="meta">${activeMetaLine(activeMixes)}</p>
    ${renderSummary(activeScores)}
    ${renderModelHistograms(activeScores, { two: yMaxTwo, three: yMaxThree })}
    ${renderRecipeTable(activeMixes, activeScores)}
    ${renderBasesTable()}
  `;
}

// Click delegation: any toggle button updates activeSet and re-renders.
// Re-attached once here because the toggle markup is rebuilt on every
// render — bubbling from #app catches the new buttons too.
app.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const btn = target?.closest('.set-toggle button[data-set]') as HTMLButtonElement | null;
  if (!btn) return;
  const set = btn.dataset['set'] as ActiveSet | undefined;
  if (!set || set === activeSet) return;
  activeSet = set;
  render();
});

render();
