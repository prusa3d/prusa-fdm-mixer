/**
 * Calibration · NR200 spectrocolorimeter calibration calculator.
 *
 * Three tiers of correction:
 *   - Tier 1: 3-point neutral fit (per-channel linear regression on L, a, b)
 *   - Tier 2: 24-patch ColorChecker fit (least-squares 3×3 matrix in XYZ)
 *   - Tier 3: batch Lab → display-hex converter using the active calibration
 *
 * Each measured Lab is rendered three ways:
 *   - Lab native via CSS lab() — wide-gamut accurate
 *   - MINDE — minimum-ΔE gamut map to sRGB (colorjs.io CSS method)
 *   - Vivid — oklch chroma + lightness boost for marketing-style display
 */

import Color from 'colorjs.io';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type LabTuple = [number, number, number];
type Method = 't1' | 't2' | 'none';
interface LinearFit { m: number; c: number; }
interface T1Correction { L: LinearFit; a: LinearFit; b: LinearFit; }
type Matrix3 = [
  [number, number, number],
  [number, number, number],
  [number, number, number],
];
interface PatchRef { name: string; L: number; a: number; b: number; hex: string; }
interface SavedResult {
  name: string;
  method: Method;
  raw: LabTuple;
  corrected: LabTuple;
  minde: string;
  vivid: string;
  labCss: string;
  when: string;
}
interface BatchRow {
  index: number;
  name: string;
  lab?: LabTuple;
  err?: string;
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
interface T1Preset {
  label: string;
  info: string;
  white: { lab: LabTuple; hint: string; swatch: string };
  gray:  { lab: LabTuple; hint: string; swatch: string };
  black: { lab: LabTuple; hint: string; swatch: string };
}

const T1_PRESETS: Record<string, T1Preset> = {
  munsell: {
    label: 'Munsell N9.5 / N5 / N2',
    info: 'Munsell Book of Color · D65/2° · CIE Lab',
    white: { lab: [95.05, 0.00, -0.10], hint: 'Munsell N9.5 — near-perfect neutral white', swatch: '#f0eeec' },
    gray:  { lab: [51.57, 0.00,  0.00], hint: 'Munsell N5 — perfect mid-gray',             swatch: '#7e7e7e' },
    black: { lab: [20.50, 0.00, -0.10], hint: 'Munsell N2 — neutral low-value (practical black)', swatch: '#2f2f2e' },
  },
  munsell95: {
    label: 'Munsell N9.5 / N5 / N1',
    info: 'Munsell Book of Color · D65/2° · CIE Lab',
    white: { lab: [95.05, 0.00, -0.10], hint: 'Munsell N9.5 — near-perfect neutral white', swatch: '#f0eeec' },
    gray:  { lab: [51.57, 0.00,  0.00], hint: 'Munsell N5 — perfect mid-gray',             swatch: '#7e7e7e' },
    black: { lab: [10.20, 0.00, -0.10], hint: 'Munsell N1 — deep neutral near-black',      swatch: '#1c1c1c' },
  },
  bcra: {
    label: 'BCRA Series II Ceramic Tiles',
    info: 'BCRA Tile Set · D65/2° · UKAS-traceable',
    white: { lab: [94.81, -0.95, 1.46], hint: 'BCRA white tile (typical certified)', swatch: '#eeeae0' },
    gray:  { lab: [50.40, -0.30, 0.20], hint: 'BCRA mid-gray tile',                  swatch: '#7a7977' },
    black: { lab: [4.95,   0.10, -0.20], hint: 'BCRA black tile (matte, low gloss)', swatch: '#0c0c0c' },
  },
  kodak: {
    label: 'Kodak Q-13 Gray Scale',
    info: 'Kodak Q-13 / 18% gray reference · D50/2°',
    white: { lab: [96.00, 0.00, 1.50], hint: 'Q-13 step A — paper white',     swatch: '#f5f1e8' },
    gray:  { lab: [50.00, 0.00, 0.50], hint: 'Q-13 step M — 18% middle gray', swatch: '#7c7b78' },
    black: { lab: [13.00, 0.00, 0.00], hint: 'Q-13 step 19 — densest black',  swatch: '#222020' },
  },
  iso: {
    label: 'ISO 12642 / IT8 Neutrals',
    info: 'IT8.7 chart neutrals · D50/2° · ISO 12642',
    white: { lab: [95.00, 0.00, -2.00], hint: 'IT8 paper white (cold-balanced)', swatch: '#ececef' },
    gray:  { lab: [50.00, 0.00,  0.00], hint: 'IT8 neutral mid',                 swatch: '#7c7c7c' },
    black: { lab: [16.00, 0.00,  0.00], hint: 'IT8 max-density neutral',         swatch: '#272727' },
  },
  office: {
    label: 'Office Paper / Pencil / Toner',
    info: 'Approximations only — not certified',
    white: { lab: [93.00, 1.50, -4.00], hint: 'Standard office paper (OBA-brightened)', swatch: '#ededf2' },
    gray:  { lab: [55.00, 0.00, -0.50], hint: 'HB pencil shading on white paper',       swatch: '#878787' },
    black: { lab: [22.00, 0.00,  0.00], hint: 'Laser printer 100% black on paper',      swatch: '#363636' },
  },
  custom: {
    label: 'Custom',
    info: 'Enter your own certified values manually',
    white: { lab: [96.00, 0.00, 0.00], hint: 'Your white reference', swatch: '#f4f1ea' },
    gray:  { lab: [51.00, 0.00, 0.00], hint: 'Your gray reference',  swatch: '#888888' },
    black: { lab: [3.00,  0.00, 0.00], hint: 'Your black reference', swatch: '#0a0a0a' },
  },
};

// ColorChecker Classic post-Nov 2014 reference (D65/2°).
const COLORCHECKER_2014: PatchRef[] = [
  { name: 'Dark Skin',     L: 38.85, a: 14.44,  b: 14.34,  hex: '#735244' },
  { name: 'Light Skin',    L: 65.66, a: 18.13,  b: 17.81,  hex: '#c29682' },
  { name: 'Blue Sky',      L: 49.08, a: -3.99,  b: -22.66, hex: '#627a9d' },
  { name: 'Foliage',       L: 42.79, a: -12.78, b: 21.83,  hex: '#576c43' },
  { name: 'Blue Flower',   L: 54.71, a: 9.11,   b: -24.65, hex: '#8580b1' },
  { name: 'Bluish Green',  L: 70.73, a: -32.43, b: -0.10,  hex: '#67bdaa' },
  { name: 'Orange',        L: 62.92, a: 35.16,  b: 57.73,  hex: '#d67e2c' },
  { name: 'Purplish Blue', L: 40.20, a: 11.22,  b: -44.86, hex: '#505ba6' },
  { name: 'Moderate Red',  L: 51.06, a: 48.36,  b: 16.79,  hex: '#c15a63' },
  { name: 'Purple',        L: 30.31, a: 21.77,  b: -21.65, hex: '#5e3c6c' },
  { name: 'Yellow Green',  L: 72.46, a: -23.58, b: 57.66,  hex: '#9dbc40' },
  { name: 'Orange Yellow', L: 71.95, a: 18.37,  b: 67.27,  hex: '#e0a32e' },
  { name: 'Blue',          L: 28.86, a: 14.07,  b: -50.05, hex: '#383d96' },
  { name: 'Green',         L: 55.26, a: -40.22, b: 33.69,  hex: '#469449' },
  { name: 'Red',           L: 42.10, a: 53.38,  b: 28.21,  hex: '#af363c' },
  { name: 'Yellow',        L: 81.73, a: 4.04,   b: 79.82,  hex: '#e7c71f' },
  { name: 'Magenta',       L: 51.94, a: 49.99,  b: -14.57, hex: '#bb5695' },
  { name: 'Cyan',          L: 51.04, a: -28.63, b: -28.64, hex: '#0885a1' },
  { name: 'White 9.5',     L: 96.54, a: -0.43,  b: 1.19,   hex: '#f3f3f2' },
  { name: 'Neutral 8',     L: 81.26, a: -0.64,  b: -0.34,  hex: '#c8c8c8' },
  { name: 'Neutral 6.5',   L: 66.77, a: -0.73,  b: -0.50,  hex: '#a0a0a0' },
  { name: 'Neutral 5',     L: 50.87, a: -0.15,  b: -0.27,  hex: '#7a7a7a' },
  { name: 'Neutral 3.5',   L: 35.66, a: -0.42,  b: -1.23,  hex: '#555555' },
  { name: 'Black 2',       L: 20.46, a: -0.08,  b: -0.97,  hex: '#343434' },
];
const COLORCHECKER_ORIG: PatchRef[] = COLORCHECKER_2014.map((p, i) => ({
  ...p,
  L: p.L + (i < 18 ? -0.3 : 0),
  a: p.a + (i < 18 ? 0.4 : 0),
  b: p.b + (i < 18 ? 0.2 : 0),
}));

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let activeMethod: Method = 't1';
let t3Method: Method = 't1';
let activeT1Preset = 'munsell';
let activeT2Preset: 'cc2014' | 'cc-orig' = 'cc2014';
let cachedT2Matrix: Matrix3 | null = null;
const savedResults: SavedResult[] = [];
let batchResults: BatchRow[] = [];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string): T[] =>
  Array.from(document.querySelectorAll(sel)) as T[];

function readLabRow(rowKey: string): LabTuple {
  const inputs = $$<HTMLInputElement>(`[data-row="${rowKey}"] .lab-input`);
  return [
    parseFloat(inputs[0].value),
    parseFloat(inputs[1].value),
    parseFloat(inputs[2].value),
  ];
}

function setLabRow(rowKey: string, lab: LabTuple): void {
  const inputs = $$<HTMLInputElement>(`[data-row="${rowKey}"] .lab-input`);
  inputs[0].value = lab[0].toFixed(2);
  inputs[1].value = lab[1].toFixed(2);
  inputs[2].value = lab[2].toFixed(2);
}

function fmt(n: number, d = 2): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 0.005) return '0.00';
  return n.toFixed(d);
}

// ---------------------------------------------------------------------------
// Tier 1 — per-channel linear fit
// ---------------------------------------------------------------------------
function fitLinear(measured: number[], truth: number[]): LinearFit {
  const valid = measured
    .map((m, i) => [m, truth[i]] as const)
    .filter(([m, t]) => Number.isFinite(m) && Number.isFinite(t));
  if (valid.length < 2) return { m: 1, c: 0 };
  const n = valid.length;
  const sumX = valid.reduce((a, [x]) => a + x, 0);
  const sumY = valid.reduce((a, [, y]) => a + y, 0);
  const sumXY = valid.reduce((a, [x, y]) => a + x * y, 0);
  const sumXX = valid.reduce((a, [x]) => a + x * x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return { m: 1, c: sumY / n - sumX / n };
  const m = (n * sumXY - sumX * sumY) / denom;
  const c = (sumY - m * sumX) / n;
  return { m, c };
}

function buildT1Correction(): T1Correction {
  const wm = readLabRow('t1-white-meas'), wr = readLabRow('t1-white-ref');
  const gm = readLabRow('t1-gray-meas'),  gr = readLabRow('t1-gray-ref');
  const bm = readLabRow('t1-black-meas'), br = readLabRow('t1-black-ref');
  return {
    L: fitLinear([wm[0], gm[0], bm[0]], [wr[0], gr[0], br[0]]),
    a: fitLinear([wm[1], gm[1], bm[1]], [wr[1], gr[1], br[1]]),
    b: fitLinear([wm[2], gm[2], bm[2]], [wr[2], gr[2], br[2]]),
  };
}

function applyT1(corr: T1Correction, lab: LabTuple): LabTuple {
  return [
    corr.L.m * lab[0] + corr.L.c,
    corr.a.m * lab[1] + corr.a.c,
    corr.b.m * lab[2] + corr.b.c,
  ];
}

// ---------------------------------------------------------------------------
// Tier 2 — 3×3 XYZ matrix fit
// ---------------------------------------------------------------------------
function labToXYZ([L, a, b]: LabTuple): [number, number, number] {
  const Xn = 95.047, Yn = 100.0, Zn = 108.883;
  const fy = (L + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const eps = 216 / 24389, kappa = 24389 / 27;
  const fx3 = fx ** 3, fz3 = fz ** 3;
  const xr = fx3 > eps ? fx3 : (116 * fx - 16) / kappa;
  const yr = L > kappa * eps ? ((L + 16) / 116) ** 3 : L / kappa;
  const zr = fz3 > eps ? fz3 : (116 * fz - 16) / kappa;
  return [xr * Xn, yr * Yn, zr * Zn];
}

function xyzToLab([X, Y, Z]: [number, number, number]): LabTuple {
  const Xn = 95.047, Yn = 100.0, Zn = 108.883;
  const eps = 216 / 24389, kappa = 24389 / 27;
  const f = (t: number): number => (t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116);
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function invert3x3(m: Matrix3): Matrix3 | null {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-9) return null;
  const id = 1 / det;
  return [
    [(e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id],
    [(f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id],
    [(d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id],
  ];
}

function solveMatrixLS(measRows: [number, number, number][], refRows: [number, number, number][]): Matrix3 | null {
  const N = measRows.length;
  const MtM: Matrix3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < N; i++) {
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        MtM[r][c] += measRows[i][r] * measRows[i][c];
  }
  const RtM: Matrix3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < N; i++) {
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        RtM[r][c] += refRows[i][r] * measRows[i][c];
  }
  const inv = invert3x3(MtM);
  if (!inv) return null;
  const M: Matrix3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        M[r][c] += RtM[r][k] * inv[k][c];
  return M;
}

function applyMatrix(M: Matrix3, v: [number, number, number]): [number, number, number] {
  return [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2],
  ];
}

function deltaE76(a: LabTuple, b: LabTuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

interface T2Fit { matrix: Matrix3 | null; n: number; meanDE: number | null; maxDE: number | null; }
function buildT2Correction(): T2Fit {
  const refSet = activeT2Preset === 'cc-orig' ? COLORCHECKER_ORIG : COLORCHECKER_2014;
  const measRows: [number, number, number][] = [];
  const refRows: [number, number, number][] = [];
  const patches = $$('.patch');
  patches.forEach((el, i) => {
    const inputs = el.querySelectorAll<HTMLInputElement>('.patch-input');
    const L = parseFloat(inputs[0].value);
    const a = parseFloat(inputs[1].value);
    const b = parseFloat(inputs[2].value);
    if (Number.isFinite(L) && Number.isFinite(a) && Number.isFinite(b)) {
      measRows.push(labToXYZ([L, a, b]));
      refRows.push(labToXYZ([refSet[i].L, refSet[i].a, refSet[i].b]));
    }
  });
  if (measRows.length < 8) {
    cachedT2Matrix = null;
    return { matrix: null, n: measRows.length, meanDE: null, maxDE: null };
  }
  const M = solveMatrixLS(measRows, refRows);
  cachedT2Matrix = M;
  if (!M) return { matrix: null, n: measRows.length, meanDE: null, maxDE: null };
  let sumDE = 0, maxDE = 0;
  for (let i = 0; i < measRows.length; i++) {
    const corrected = applyMatrix(M, measRows[i]);
    const corrLab = xyzToLab(corrected);
    const refLab = xyzToLab(refRows[i]);
    const de = deltaE76(corrLab, refLab);
    sumDE += de;
    if (de > maxDE) maxDE = de;
  }
  return { matrix: M, n: measRows.length, meanDE: sumDE / measRows.length, maxDE };
}

function applyT2(matrix: Matrix3, lab: LabTuple): LabTuple {
  const xyz = labToXYZ(lab);
  const corrected = applyMatrix(matrix, xyz);
  return xyzToLab(corrected);
}

// ---------------------------------------------------------------------------
// Rendering — Lab → display hex variants
// ---------------------------------------------------------------------------
interface Render {
  labCss: string;
  mindeHex: string;
  vividHex: string;
  naiveInGamut: boolean;
}
function renderForLab(L: number, a: number, b: number): Render {
  const labCss = `lab(${L}% ${a} ${b})`;
  const labColor = new Color('lab', [L, a, b]);
  const naive = labColor.to('srgb');
  const naiveInGamut = naive.inGamut();
  const minde = labColor.clone().toGamut({ space: 'srgb', method: 'css' });
  const mindeHex = minde.to('srgb').toString({ format: 'hex' });
  const compressed = labColor.clone().toGamut({ space: 'srgb', method: 'css' });
  const ok = compressed.to('oklch');
  const [Lo, Co, Ho] = ok.coords;
  const boosted = new Color('oklch', [Math.min(1, Lo * 1.05), Co * 1.15, Ho])
    .toGamut({ space: 'srgb', method: 'css' });
  const vividHex = boosted.to('srgb').toString({ format: 'hex' });
  return { labCss, mindeHex, vividHex, naiveInGamut };
}

// ---------------------------------------------------------------------------
// Apply correction wrapper (shared between sample section and Tier 3 batch)
// ---------------------------------------------------------------------------
function correctSampleWith(method: Method, rawLab: LabTuple): LabTuple {
  if (method === 't1') {
    return applyT1(buildT1Correction(), rawLab);
  }
  if (method === 't2') {
    if (!cachedT2Matrix) buildT2Correction();
    if (!cachedT2Matrix) return rawLab;
    return applyT2(cachedT2Matrix, rawLab);
  }
  return rawLab;
}

// ---------------------------------------------------------------------------
// UI — Tier 1 preset + status
// ---------------------------------------------------------------------------
function applyT1Preset(key: string): void {
  const p = T1_PRESETS[key];
  activeT1Preset = key;
  if (key !== 'custom') {
    setLabRow('t1-white-ref', p.white.lab);
    setLabRow('t1-gray-ref',  p.gray.lab);
    setLabRow('t1-black-ref', p.black.lab);
  }
  $('#t1-hint-white').textContent = p.white.hint;
  $('#t1-hint-gray').textContent  = p.gray.hint;
  $('#t1-hint-black').textContent = p.black.hint;
  $('#t1-dot-white').style.background = p.white.swatch;
  $('#t1-dot-gray').style.background  = p.gray.swatch;
  $('#t1-dot-black').style.background = p.black.swatch;
  $('#t1-preset-info').textContent = p.info;
  if (readLabRow('t1-white-meas').every((v) => isNaN(v))) setLabRow('t1-white-meas', p.white.lab);
  if (readLabRow('t1-gray-meas').every((v) => isNaN(v)))  setLabRow('t1-gray-meas', p.gray.lab);
  if (readLabRow('t1-black-meas').every((v) => isNaN(v))) setLabRow('t1-black-meas', p.black.lab);
  updateAll();
}

function updateT1Status(): void {
  const corr = buildT1Correction();
  (['L', 'a', 'b'] as const).forEach((ch) => {
    const fit = corr[ch];
    const el = $(`#t1-corr-${ch}`);
    if (Math.abs(fit.m - 1) < 0.001 && Math.abs(fit.c) < 0.01) {
      el.textContent = 'no shift';
      el.className = 'cval';
    } else {
      el.textContent = `× ${fmt(fit.m, 4)}  ${fit.c >= 0 ? '+' : ''}${fmt(fit.c, 3)}`;
      el.className = 'cval ' + (fit.c > 0 ? 'shift-pos' : 'shift-neg');
    }
  });
}

// ---------------------------------------------------------------------------
// UI — Tier 2 patches + status
// ---------------------------------------------------------------------------
function buildPatchesUI(): void {
  const refSet = activeT2Preset === 'cc-orig' ? COLORCHECKER_ORIG : COLORCHECKER_2014;
  const grid = $('#t2-patches');
  grid.innerHTML = refSet.map((p, i) => `
    <div class="patch">
      <div class="patch-head">
        <div class="patch-swatch" style="background:${p.hex}"></div>
        <div class="patch-name">${p.name}</div>
        <div class="patch-num">#${String(i + 1).padStart(2, '0')}</div>
      </div>
      <div class="patch-ref">L ${p.L.toFixed(1)} · a ${p.a.toFixed(1)} · b ${p.b.toFixed(1)}</div>
      <div class="patch-meas">
        <input class="patch-input" type="number" step="0.01" placeholder="L" data-patch="${i}" data-ch="0">
        <input class="patch-input" type="number" step="0.01" placeholder="a" data-patch="${i}" data-ch="1">
        <input class="patch-input" type="number" step="0.01" placeholder="b" data-patch="${i}" data-ch="2">
      </div>
    </div>
  `).join('');
  grid.querySelectorAll<HTMLInputElement>('.patch-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      inp.classList.toggle('filled', inp.value !== '');
      updateAll();
    });
  });
}

function updateT2Status(): void {
  const fit = buildT2Correction();
  const info = $('#t2-info');
  if (fit.n < 8) {
    info.innerHTML = `<strong>${fit.n}</strong> of 24 patches measured · need <strong>≥ 8</strong> for fit`;
    info.className = fit.n > 0 ? 'info warn' : 'info';
    $('#t2-fit-de').textContent = '—';
    $('#t2-fit-max').textContent = '—';
    $('#t2-fit-n').textContent = `${fit.n} / 24 (insufficient)`;
  } else {
    info.innerHTML = `<strong>${fit.n}</strong> of 24 · fit successful · mean ΔE76 = <strong>${fmt(fit.meanDE!)}</strong>`;
    info.className = 'info good';
    $('#t2-fit-de').textContent = fmt(fit.meanDE!);
    $('#t2-fit-max').textContent = fmt(fit.maxDE!);
    $('#t2-fit-n').textContent = `${fit.n} / 24`;
  }
}

// ---------------------------------------------------------------------------
// Sample section
// ---------------------------------------------------------------------------
interface SamplePreview {
  name: string;
  raw: LabTuple;
  corrected: LabTuple;
  render: Render;
}
function updateSamplePreview(): SamplePreview | null {
  const name = ($('#sample-name') as HTMLInputElement).value.trim();
  const Lraw = parseFloat(($('#sample-L') as HTMLInputElement).value);
  const araw = parseFloat(($('#sample-a') as HTMLInputElement).value);
  const braw = parseFloat(($('#sample-b') as HTMLInputElement).value);

  const swatchEl = $('#result-swatches');
  const addBtn = $('#add-btn') as HTMLButtonElement;

  if (!Number.isFinite(Lraw) || !Number.isFinite(araw) || !Number.isFinite(braw)) {
    swatchEl.innerHTML = '<div class="swatch-cell placeholder"><span class="swatch-tag">enter Lab to preview</span></div>';
    $('#m-clab').textContent = '—';
    $('#m-shift').textContent = '—';
    $('#m-gamut').textContent = '—';
    addBtn.disabled = true;
    return null;
  }

  const corrected = correctSampleWith(activeMethod, [Lraw, araw, braw]);
  const r = renderForLab(...corrected);

  swatchEl.innerHTML = `
    <div class="swatch-cell">
      <div class="swatch-fill" style="background:${r.labCss}"></div>
      <span class="swatch-tag">Lab native</span>
      <span class="swatch-hex">${r.labCss}</span>
    </div>
    <div class="swatch-cell">
      <div class="swatch-fill" style="background:${r.mindeHex}"></div>
      <span class="swatch-tag">MINDE</span>
      <span class="swatch-hex">${r.mindeHex.toUpperCase()}</span>
    </div>
    <div class="swatch-cell">
      <div class="swatch-fill" style="background:${r.vividHex}"></div>
      <span class="swatch-tag">Vivid Boost</span>
      <span class="swatch-hex">${r.vividHex.toUpperCase()}</span>
    </div>
  `;

  $('#m-clab').innerHTML =
    `L <em>${fmt(corrected[0])}</em> · a <em>${fmt(corrected[1])}</em> · b <em>${fmt(corrected[2])}</em>`;
  $('#m-shift').innerHTML =
    `ΔL <em>${fmt(corrected[0] - Lraw)}</em> · Δa <em>${fmt(corrected[1] - araw)}</em> · Δb <em>${fmt(corrected[2] - braw)}</em>`;
  $('#m-gamut').innerHTML = r.naiveInGamut
    ? `<em style="color:var(--good)">in gamut — direct sRGB safe</em>`
    : `<em style="color:var(--warn)">outside sRGB — gamut mapping applied</em>`;

  addBtn.disabled = !name;
  return { name, raw: [Lraw, araw, braw], corrected, render: r };
}

// ---------------------------------------------------------------------------
// Saved-results table
// ---------------------------------------------------------------------------
function renderSavedTable(): void {
  const wrap = $('#results-table-wrap');
  if (savedResults.length === 0) {
    wrap.innerHTML = '<div class="empty-state">No samples saved yet — measure a filament above and save it here.</div>';
  } else {
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Method</th>
            <th>Raw Lab</th>
            <th>Corrected Lab</th>
            <th>MINDE</th>
            <th>Vivid</th>
            <th>Lab Native</th>
            <th class="right">When</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${savedResults.map((r, i) => `
            <tr>
              <td class="name">${escapeHtml(r.name)}</td>
              <td><span class="tbl-method-tag ${r.method}">${r.method.toUpperCase()}</span></td>
              <td>${r.raw.map((v) => v.toFixed(2)).join(' / ')}</td>
              <td>${r.corrected.map((v) => v.toFixed(2)).join(' / ')}</td>
              <td><span class="tbl-swatch" style="background:${r.minde}"></span> ${r.minde.toUpperCase()}</td>
              <td><span class="tbl-swatch" style="background:${r.vivid}"></span> ${r.vivid.toUpperCase()}</td>
              <td><span class="tbl-swatch" style="background:${r.labCss}"></span></td>
              <td class="right" style="color:var(--ink-faint)">${r.when}</td>
              <td><button class="delete-btn" data-del="${i}">×</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        savedResults.splice(parseInt(btn.dataset.del!, 10), 1);
        renderSavedTable();
        updateSavedButtons();
      });
    });
  }
  updateSavedButtons();
}

function updateSavedButtons(): void {
  const has = savedResults.length > 0;
  ($('#export-btn') as HTMLButtonElement).disabled = !has;
  ($('#export-csv-btn') as HTMLButtonElement).disabled = !has;
  ($('#copy-btn') as HTMLButtonElement).disabled = !has;
  ($('#clear-btn') as HTMLButtonElement).disabled = !has;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}

function savedJsonl(): string {
  return savedResults.map((r) => JSON.stringify({
    name: r.name,
    method: r.method,
    measured_lab: { L: r.raw[0], a: r.raw[1], b: r.raw[2] },
    corrected_lab: { L: r.corrected[0], a: r.corrected[1], b: r.corrected[2] },
    hex_minde: r.minde,
    hex_vivid: r.vivid,
    measured_at: r.when,
  })).join('\n');
}

function savedCsv(): string {
  const header = 'name,method,measured_L,measured_a,measured_b,corrected_L,corrected_a,corrected_b,hex_minde,hex_vivid,measured_at';
  const esc = (s: string): string => {
    const str = String(s);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = savedResults.map((r) => [
    esc(r.name),
    r.method,
    r.raw[0].toFixed(2), r.raw[1].toFixed(2), r.raw[2].toFixed(2),
    r.corrected[0].toFixed(4), r.corrected[1].toFixed(4), r.corrected[2].toFixed(4),
    r.minde, r.vivid,
    r.when,
  ].join(','));
  return header + '\n' + rows.join('\n');
}

function downloadBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function copyToClipboard(text: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 1500);
  } catch {
    alert('Could not copy — clipboard access denied.');
  }
}

// ---------------------------------------------------------------------------
// Tier 3 — batch Lab → hex
// ---------------------------------------------------------------------------
function parseBatchInput(text: string): BatchRow[] {
  const lines = text.split(/\r?\n/);
  const rows: BatchRow[] = [];
  let counter = 0;
  for (let i = 0; i < lines.length && rows.length < 500; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (raw.startsWith('#')) continue;
    counter++;
    const tokens = raw.split(/[,\t]|\s{2,}/).map((t) => t.trim()).filter((t) => t !== '');
    if (tokens.length < 3) {
      rows.push({ index: counter, name: `Row ${counter}`, err: 'too few values' });
      continue;
    }
    let name: string;
    let labStrs: string[];
    if (tokens.length === 3) {
      name = `Row ${counter}`;
      labStrs = tokens;
    } else {
      name = tokens.slice(0, -3).join(' ');
      labStrs = tokens.slice(-3);
    }
    const nums = labStrs.map(parseFloat);
    if (nums.some((n) => !Number.isFinite(n))) {
      rows.push({ index: counter, name, err: 'non-numeric Lab' });
      continue;
    }
    rows.push({ index: counter, name, lab: nums as LabTuple });
  }
  return rows;
}

function renderBatchResults(): void {
  const wrap = $('#t3-results-wrap');
  const summary = $('#t3-summary');
  const table = $('#t3-results-table') as HTMLTableElement;

  if (batchResults.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  const total = batchResults.length;
  const valid = batchResults.filter((r) => !r.err).length;
  const errs = total - valid;
  summary.innerHTML = errs > 0
    ? `<strong>${total}</strong> rows parsed · <strong>${valid}</strong> valid · <strong class="err">${errs}</strong> skipped`
    : `<strong>${total}</strong> rows parsed · <strong>${valid}</strong> valid`;

  const rowsHtml = batchResults.map((r) => {
    if (r.err) {
      return `
        <tr>
          <td class="right">${r.index}</td>
          <td class="name bad">${escapeHtml(r.name)}</td>
          <td colspan="5"><span class="t3-err-tag">${r.err}</span></td>
        </tr>`;
    }
    const corrected = correctSampleWith(t3Method, r.lab!);
    const render = renderForLab(...corrected);
    return `
      <tr>
        <td class="right">${r.index}</td>
        <td class="name">${escapeHtml(r.name)}</td>
        <td>${r.lab!.map((v) => v.toFixed(2)).join(' / ')}</td>
        <td>${corrected.map((v) => v.toFixed(2)).join(' / ')}</td>
        <td><span class="tbl-swatch" style="background:${render.labCss}"></span></td>
        <td><span class="tbl-swatch" style="background:${render.mindeHex}"></span> ${render.mindeHex.toUpperCase()}</td>
        <td><span class="tbl-swatch" style="background:${render.vividHex}"></span> ${render.vividHex.toUpperCase()}</td>
      </tr>`;
  }).join('');

  table.innerHTML = `
    <thead>
      <tr>
        <th class="right">#</th>
        <th>Name</th>
        <th>Input Lab</th>
        <th>Corrected Lab</th>
        <th>Lab Native</th>
        <th>MINDE</th>
        <th>Vivid</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  `;
}

function batchCsv(): string {
  const header = '#,name,input_L,input_a,input_b,corrected_L,corrected_a,corrected_b,lab_native,hex_minde,hex_vivid';
  const esc = (s: string): string => {
    const str = String(s);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = batchResults
    .filter((r) => !r.err && r.lab)
    .map((r) => {
      const corrected = correctSampleWith(t3Method, r.lab!);
      const render = renderForLab(...corrected);
      return [
        r.index, esc(r.name),
        r.lab![0].toFixed(2), r.lab![1].toFixed(2), r.lab![2].toFixed(2),
        corrected[0].toFixed(4), corrected[1].toFixed(4), corrected[2].toFixed(4),
        esc(render.labCss),
        render.mindeHex, render.vividHex,
      ].join(',');
    });
  return header + '\n' + rows.join('\n');
}

function batchJsonl(): string {
  return batchResults
    .filter((r) => !r.err && r.lab)
    .map((r) => {
      const corrected = correctSampleWith(t3Method, r.lab!);
      const render = renderForLab(...corrected);
      return JSON.stringify({
        index: r.index,
        name: r.name,
        method: t3Method,
        input_lab: { L: r.lab![0], a: r.lab![1], b: r.lab![2] },
        corrected_lab: { L: corrected[0], a: corrected[1], b: corrected[2] },
        lab_native: render.labCss,
        hex_minde: render.mindeHex,
        hex_vivid: render.vividHex,
      });
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tier 3 status strip — shows the active correction so the user doesn't have
// to flip back to T1/T2 to verify whether calibration is set up.
// ---------------------------------------------------------------------------
function updateT3Status(): void {
  const el = $('#t3-status');
  if (t3Method === 'none') {
    el.innerHTML =
      `<span class="label">Correction</span>` +
      `<span class="val muted">none — input Lab passed through unchanged</span>`;
    return;
  }
  if (t3Method === 't1') {
    const corr = buildT1Correction();
    const channels = ['L', 'a', 'b'] as const;
    const noop = channels.every((ch) =>
      Math.abs(corr[ch].m - 1) < 0.001 && Math.abs(corr[ch].c) < 0.01,
    );
    if (noop) {
      el.innerHTML =
        `<span class="label">Tier 1</span>` +
        `<span class="val muted">no shift — measured = reference, no calibration active</span>`;
      return;
    }
    const parts = channels.map((ch) => {
      const f = corr[ch];
      return `<span class="shift"><span class="ch">${ch}</span>× ${fmt(f.m, 4)} ${f.c >= 0 ? '+' : ''}${fmt(f.c, 3)}</span>`;
    }).join('');
    el.innerHTML = `<span class="label">Tier 1</span>${parts}`;
    return;
  }
  // t2
  const fit = buildT2Correction();
  if (fit.n < 8 || !fit.matrix) {
    el.innerHTML =
      `<span class="label">Tier 2</span>` +
      `<span class="val warn">${fit.n} of 24 patches — need ≥ 8, falling back to raw Lab</span>`;
    return;
  }
  el.innerHTML =
    `<span class="label">Tier 2</span>` +
    `<span class="val good">fit on ${fit.n}/24 · mean ΔE76 ${fmt(fit.meanDE!)} · max ${fmt(fit.maxDE!)}</span>`;
}

// ---------------------------------------------------------------------------
// Master update
// ---------------------------------------------------------------------------
function updateAll(): void {
  updateT1Status();
  updateT2Status();
  updateT3Status();
  updateSamplePreview();
  if (batchResults.length > 0) renderBatchResults();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function wireEvents(): void {
  // Tabs
  $$('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      $$('.tab-pane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      $('#pane-' + t.dataset.tab).classList.add('active');
    });
  });

  // Sample-section method toggle
  $$('#method-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#method-toggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      activeMethod = b.dataset.method as Method;
      updateAll();
    });
  });

  // Tier 3 method toggle
  $$('#t3-method-toggle button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#t3-method-toggle button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      t3Method = b.dataset.method as Method;
      updateT3Status();
      if (batchResults.length > 0) renderBatchResults();
    });
  });

  // Tier 1 preset
  ($('#t1-preset') as HTMLSelectElement).addEventListener('change', (e) => {
    applyT1Preset((e.target as HTMLSelectElement).value);
  });

  // Tier 2 preset
  ($('#t2-preset') as HTMLSelectElement).addEventListener('change', (e) => {
    activeT2Preset = (e.target as HTMLSelectElement).value as 'cc2014' | 'cc-orig';
    buildPatchesUI();
    updateAll();
  });

  // Tier-1 lab inputs
  $$('#pane-t1 .lab-input').forEach((inp) => inp.addEventListener('input', updateAll));

  // Reset buttons
  $$('.reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.reset!;
      const p = T1_PRESETS[activeT1Preset];
      const map: Record<string, LabTuple> = {
        't1-white-ref':  p.white.lab,
        't1-gray-ref':   p.gray.lab,
        't1-black-ref':  p.black.lab,
        't1-white-meas': p.white.lab,
        't1-gray-meas':  p.gray.lab,
        't1-black-meas': p.black.lab,
      };
      if (map[target]) setLabRow(target, map[target]);
      updateAll();
    });
  });

  // Sample inputs
  ['sample-name', 'sample-L', 'sample-a', 'sample-b'].forEach((id) => {
    $('#' + id).addEventListener('input', updateSamplePreview);
  });

  // Add to saved
  $('#add-btn').addEventListener('click', () => {
    const data = updateSamplePreview();
    if (!data) return;
    savedResults.unshift({
      name: data.name,
      method: activeMethod,
      raw: data.raw,
      corrected: data.corrected,
      minde: data.render.mindeHex,
      vivid: data.render.vividHex,
      labCss: data.render.labCss,
      when: new Date().toISOString().replace('T', ' ').slice(0, 19),
    });
    ($('#sample-name') as HTMLInputElement).value = '';
    ($('#sample-L') as HTMLInputElement).value = '';
    ($('#sample-a') as HTMLInputElement).value = '';
    ($('#sample-b') as HTMLInputElement).value = '';
    updateSamplePreview();
    renderSavedTable();
  });

  // Tier 2 demo + clear
  $('#t2-load-demo').addEventListener('click', () => {
    const refSet = activeT2Preset === 'cc-orig' ? COLORCHECKER_ORIG : COLORCHECKER_2014;
    $$('.patch').forEach((el, i) => {
      const inputs = el.querySelectorAll<HTMLInputElement>('.patch-input');
      const ref = refSet[i];
      inputs[0].value = (ref.L - 2 + (Math.random() - 0.5) * 0.5).toFixed(2);
      inputs[1].value = (ref.a * 0.92 + (Math.random() - 0.5) * 0.3).toFixed(2);
      inputs[2].value = (ref.b * 0.94 + (Math.random() - 0.5) * 0.3).toFixed(2);
      inputs.forEach((x) => x.classList.add('filled'));
    });
    updateAll();
  });
  $('#t2-clear').addEventListener('click', () => {
    $$<HTMLInputElement>('.patch-input').forEach((inp) => {
      inp.value = '';
      inp.classList.remove('filled');
    });
    updateAll();
  });

  // Tier 3 buttons
  $('#t3-convert').addEventListener('click', () => {
    const text = ($('#t3-input') as HTMLTextAreaElement).value;
    batchResults = parseBatchInput(text);
    renderBatchResults();
  });
  $('#t3-clear').addEventListener('click', () => {
    ($('#t3-input') as HTMLTextAreaElement).value = '';
    batchResults = [];
    renderBatchResults();
  });
  $('#t3-demo').addEventListener('click', () => {
    ($('#t3-input') as HTMLTextAreaElement).value = `# Demo: Munsell neutrals + a few skin/sky tones
Munsell N9.5, 95.05, 0, -0.10
Munsell N5, 51.57, 0, 0
Munsell N2, 20.50, 0, -0.10
Foliage, 42.79, -12.78, 21.83
Yellow, 81.73, 4.04, 79.82
Cyan, 51.04, -28.63, -28.64
# raw 3-token rows are auto-named
65.66, 18.13, 17.81`;
    batchResults = parseBatchInput(($('#t3-input') as HTMLTextAreaElement).value);
    renderBatchResults();
  });
  $('#t3-copy-csv').addEventListener('click', (e) => {
    copyToClipboard(batchCsv(), e.currentTarget as HTMLButtonElement);
  });
  $('#t3-copy-jsonl').addEventListener('click', (e) => {
    copyToClipboard(batchJsonl(), e.currentTarget as HTMLButtonElement);
  });
  $('#t3-export-csv').addEventListener('click', () => {
    downloadBlob(batchCsv(), 'text/csv;charset=utf-8', `nr200-batch-${new Date().toISOString().slice(0, 10)}.csv`);
  });

  // Saved-results actions
  $('#export-btn').addEventListener('click', () => {
    downloadBlob(savedJsonl(), 'application/x-ndjson', `nr200-results-${new Date().toISOString().slice(0, 10)}.jsonl`);
  });
  $('#export-csv-btn').addEventListener('click', () => {
    downloadBlob(savedCsv(), 'text/csv;charset=utf-8', `nr200-results-${new Date().toISOString().slice(0, 10)}.csv`);
  });
  $('#copy-btn').addEventListener('click', (e) => {
    copyToClipboard(savedJsonl(), e.currentTarget as HTMLButtonElement);
  });
  $('#clear-btn').addEventListener('click', () => {
    if (confirm('Delete all saved results?')) {
      savedResults.length = 0;
      renderSavedTable();
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
wireEvents();
applyT1Preset('munsell');
buildPatchesUI();
updateAll();
renderSavedTable();
