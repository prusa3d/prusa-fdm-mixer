/**
 * Playground · palette generator.
 *
 * Configure extruders, check which to include, manage a set of 2-color
 * ratios (preset + custom), and the prusa-fdm-mixer model predicts every resulting
 * shade. Optional 3-color triples are shown at 50:25:25 rotations.
 *
 * Cells are sorted by predicted hue angle so the palette reads as a
 * rainbow rather than as a list of recipes.
 */

import { mixFilaments, hueDegrees, type FilamentPart } from '@/index.js';
import openprinttagLibrary from '../../data/filament-library-openprinttag.json';
import hueforgeLibrary from '../../data/filament-library-hueforge.json';

// ---------------------------------------------------------------------------
// Library types (mirrors scripts/sync-library.ts and scripts/sync-hueforge.ts)
// ---------------------------------------------------------------------------

type LibrarySource = 'openprinttag' | 'hueforge';

interface LibraryEntry {
  id: string;
  brand: string;
  material: string;
  name: string;
  hex: string;
  finish?: string;
  td?: number;
  searchText: string;
  source: LibrarySource;
}

interface LibraryFile {
  version: 1;
  source: string;
  sourceUrl: string;
  lastSynced: string;
  entryCount: number;
  entries: Omit<LibraryEntry, 'source'>[];
}

const SOURCES: LibraryFile[] = [
  openprinttagLibrary as LibraryFile,
  hueforgeLibrary as LibraryFile,
];

// Merged, in-memory view of every library entry tagged with its source. The
// modal renders from this array; the on-disk JSONs stay separate so each can
// sync on its own cadence.
const LIBRARY: LibraryEntry[] = SOURCES.flatMap((file) =>
  file.entries.map((e) => ({ ...e, source: file.source as LibrarySource })),
);

const SOURCE_META: Record<LibrarySource, { label: string; short: string; sourceUrl: string; lastSynced: string; count: number }> = {
  openprinttag: {
    label: 'OpenPrintTag',
    short: 'OPT',
    sourceUrl: (openprinttagLibrary as LibraryFile).sourceUrl,
    lastSynced: (openprinttagLibrary as LibraryFile).lastSynced,
    count: (openprinttagLibrary as LibraryFile).entryCount,
  },
  hueforge: {
    label: 'HueForge',
    short: 'HF',
    sourceUrl: (hueforgeLibrary as LibraryFile).sourceUrl,
    lastSynced: (hueforgeLibrary as LibraryFile).lastSynced,
    count: (hueforgeLibrary as LibraryFile).entryCount,
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface Extruder {
  id: string;
  hex: string;
  label: string;
  enabled: boolean;
  /** Set when added from a filament library; lets the UI show a badge. */
  libraryRef?: { brand: string; material: string; finish?: string; td?: number; source: LibrarySource };
}

const DEFAULT_EXTRUDERS: Extruder[] = [
  { id: 'c', hex: '#009bc3', label: 'Cyan',    enabled: true },
  { id: 'm', hex: '#c9378c', label: 'Magenta', enabled: true },
  { id: 'y', hex: '#f6b921', label: 'Yellow',  enabled: true },
  { id: 'k', hex: '#252e2e', label: 'Black',   enabled: true },
  { id: 'w', hex: '#e4e4e5', label: 'White',   enabled: true },
];

const DEFAULT_RATIOS = [25, 50, 75]; // percent of the "second" color in a pair

let extruders: Extruder[] = DEFAULT_EXTRUDERS.map((e) => ({ ...e }));
let ratios: number[] = [...DEFAULT_RATIOS];
let show3Color = false;

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
function normalizeHex(s: string): string | null {
  let v = s.trim();
  if (v && !v.startsWith('#')) v = '#' + v;
  return HEX_RE.test(v) ? v.toLowerCase() : null;
}

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Render: extruder list
// ---------------------------------------------------------------------------

function renderExtruders(): void {
  const root = $('extruder-list');
  root.innerHTML = extruders
    .map(
      (ext) => {
        const ref = ext.libraryRef;
        const badge = ref
          ? `<span class="ext-badge" title="From ${SOURCE_META[ref.source].label} library">${escape(ref.material)}${ref.finish ? ' · ' + escape(ref.finish) : ''}${ref.td !== undefined ? ' · TD ' + ref.td : ''}</span>`
          : '';
        return `
      <div class="extruder" data-id="${ext.id}">
        <input type="checkbox" class="ext-enabled" ${ext.enabled ? 'checked' : ''} />
        <input type="color" class="ext-color" value="${ext.hex}" />
        <input type="text" class="ext-hex" value="${ext.hex}" maxlength="7" />
        <input type="text" class="ext-label" value="${escape(ext.label)}" placeholder="label" />
        ${badge}
        <button class="ext-remove" title="Remove">×</button>
      </div>
    `;
      }
    )
    .join('');

  // Wire up handlers per row.
  root.querySelectorAll<HTMLElement>('.extruder').forEach((row) => {
    const id = row.dataset.id!;
    const ext = extruders.find((e) => e.id === id)!;
    const cb = row.querySelector<HTMLInputElement>('.ext-enabled')!;
    const color = row.querySelector<HTMLInputElement>('.ext-color')!;
    const hex = row.querySelector<HTMLInputElement>('.ext-hex')!;
    const label = row.querySelector<HTMLInputElement>('.ext-label')!;
    const remove = row.querySelector<HTMLButtonElement>('.ext-remove')!;

    cb.addEventListener('change', () => {
      ext.enabled = cb.checked;
      renderPalette();
    });
    color.addEventListener('input', () => {
      ext.hex = color.value;
      hex.value = color.value;
      renderPalette();
    });
    hex.addEventListener('input', () => {
      const norm = normalizeHex(hex.value);
      if (norm) {
        ext.hex = norm;
        color.value = norm;
        renderPalette();
      }
    });
    hex.addEventListener('blur', () => {
      const norm = normalizeHex(hex.value);
      hex.value = norm ?? ext.hex;
    });
    label.addEventListener('input', () => {
      ext.label = label.value;
      renderPalette();
    });
    remove.addEventListener('click', () => {
      extruders = extruders.filter((e) => e.id !== id);
      renderExtruders();
      renderPalette();
    });
  });
}

$('add-extruder').addEventListener('click', () => {
  extruders.push({
    id: uid(),
    hex: '#888888',
    label: 'New',
    enabled: true,
  });
  renderExtruders();
  renderPalette();
});

// ---------------------------------------------------------------------------
// Render: ratio chips + custom slider
// ---------------------------------------------------------------------------

function renderRatios(): void {
  const root = $('ratio-chips');
  // Show ratios in canonical "first:second" order, with the "second" being the
  // ratio percentage. Sort ascending for visual consistency.
  const sorted = [...ratios].sort((a, b) => a - b);
  root.innerHTML = sorted
    .map(
      (r) => `
      <span class="chip" data-ratio="${r}">
        ${100 - r}:${r}
        <button class="chip-remove" title="Remove">×</button>
      </span>
    `
    )
    .join('');

  root.querySelectorAll<HTMLElement>('.chip').forEach((chip) => {
    const r = parseInt(chip.dataset.ratio!, 10);
    chip.querySelector('.chip-remove')!.addEventListener('click', () => {
      ratios = ratios.filter((x) => x !== r);
      renderRatios();
      renderPalette();
    });
  });
}

const slider = $<HTMLInputElement>('custom-slider');
const customReadout = $('custom-readout');
slider.addEventListener('input', () => {
  const r = parseInt(slider.value, 10);
  customReadout.textContent = `${100 - r}% · ${r}%`;
});
customReadout.textContent = `${100 - parseInt(slider.value, 10)}% · ${slider.value}%`;

$('add-ratio').addEventListener('click', () => {
  const r = parseInt(slider.value, 10);
  if (r === 0 || r === 100) return; // pure colors aren't useful as a ratio
  if (!ratios.includes(r)) {
    ratios.push(r);
    renderRatios();
    renderPalette();
  }
});

$<HTMLInputElement>('show-3color').addEventListener('change', (e) => {
  show3Color = (e.target as HTMLInputElement).checked;
  renderPalette();
});

// ---------------------------------------------------------------------------
// Palette generation
// ---------------------------------------------------------------------------

interface PaletteCell {
  predHex: string;
  predHue: number; // 0..360 for sorting
  predLightness: number; // for tiebreak
  ratioLabel: string;
  parts: FilamentPart[];
  partExtruders: Extruder[]; // matches parts 1:1
}

function buildPalette(): PaletteCell[] {
  const active = extruders.filter((e) => e.enabled);
  const cells: PaletteCell[] = [];

  // Pure single-extruder cells.
  for (const e of active) {
    const parts: FilamentPart[] = [{ hex: e.hex, ratio: 1 }];
    const r = mixFilaments(parts);
    cells.push({
      predHex: r.hex,
      predHue: hueDegrees(r.lab),
      predLightness: r.lab.L,
      ratioLabel: 'pure',
      parts,
      partExtruders: [e],
    });
  }

  // 2-color combos: every unordered pair × every ratio.
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!;
      const b = active[j]!;
      for (const r of ratios) {
        const tA = (100 - r) / 100;
        const tB = r / 100;
        const parts: FilamentPart[] = [
          { hex: a.hex, ratio: tA },
          { hex: b.hex, ratio: tB },
        ];
        const result = mixFilaments(parts);
        cells.push({
          predHex: result.hex,
          predHue: hueDegrees(result.lab),
          predLightness: result.lab.L,
          ratioLabel: `${100 - r}:${r}`,
          parts,
          partExtruders: [a, b],
        });
      }
    }
  }

  // 3-color combos at 50:25:25 rotations (one per triple, per dominant).
  if (show3Color) {
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        for (let k = j + 1; k < active.length; k++) {
          const triple = [active[i]!, active[j]!, active[k]!];
          // 3 rotations: each extruder takes the dominant 50% slot once.
          for (let dom = 0; dom < 3; dom++) {
            const parts: FilamentPart[] = triple.map((e, idx) => ({
              hex: e.hex,
              ratio: idx === dom ? 0.5 : 0.25,
            }));
            const result = mixFilaments(parts);
            const ratioLabelParts = parts.map((p) =>
              p.ratio === 0.5 ? '50' : '25'
            );
            cells.push({
              predHex: result.hex,
              predHue: hueDegrees(result.lab),
              predLightness: result.lab.L,
              ratioLabel: ratioLabelParts.join(':'),
              parts,
              partExtruders: triple,
            });
          }
        }
      }
    }
  }

  // Sort: hue first (primary), then lightness light→dark within a hue.
  // The result reads like a paint deck — walk through the rainbow once,
  // and inside each hue you see the value range from highlight to shadow.
  // Achromatic cells cluster at the end (after the chromatic rainbow),
  // sorted light→dark so whites/grays/blacks form their own sequence.
  cells.sort((x, y) => {
    const xAchroma = isAchromatic(x);
    const yAchroma = isAchromatic(y);
    if (xAchroma !== yAchroma) return xAchroma ? 1 : -1;
    if (xAchroma && yAchroma) return y.predLightness - x.predLightness;

    // Bucket hues into ~10° bands so small predicted-hue jitter between
    // similar mixes doesn't split the "red strip" or "blue strip" apart.
    const xBand = Math.round(x.predHue / 10);
    const yBand = Math.round(y.predHue / 10);
    if (xBand !== yBand) return xBand - yBand;

    return y.predLightness - x.predLightness;
  });

  return cells;
}

function isAchromatic(cell: PaletteCell): boolean {
  // hueDegrees returns 0 for chroma < 0.01 (defined as "no hue"). Use a
  // looser threshold here so muted near-grays still cluster together.
  const { r, g, b } = parseRgb(cell.predHex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 12; // RGB spread < 12 ≈ visually neutral
}

function parseRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.substring(0, 2), 16),
    g: parseInt(h.substring(2, 4), 16),
    b: parseInt(h.substring(4, 6), 16),
  };
}

// ---------------------------------------------------------------------------
// Render: palette
// ---------------------------------------------------------------------------

function renderPalette(): void {
  const cells = buildPalette();
  const root = $('palette');
  $('palette-count').textContent = `· ${cells.length} cells`;

  if (cells.length === 0) {
    root.innerHTML = `<p class="hint">Check at least one extruder to generate a palette.</p>`;
    return;
  }

  root.innerHTML = cells
    .map((c) => {
      const legend = c.partExtruders
        .map(
          (e, idx) => {
            const ratio = c.parts[idx]!.ratio;
            const pct = Math.round(ratio * 100);
            return `
            <div class="legend-item">
              <span class="legend-swatch" style="background:${e.hex}"></span>
              <span class="legend-label">${escape(e.label || e.hex)} ${pct}%</span>
            </div>
          `;
          }
        )
        .join('');
      return `
      <div class="cell">
        <div class="cell-swatch" style="background:${c.predHex}"></div>
        <div class="cell-meta">
          <div class="cell-hex">${c.predHex}</div>
          <div class="cell-ratio">${escape(c.ratioLabel)}</div>
        </div>
        <div class="cell-legend">${legend}</div>
      </div>
    `;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Copy hex codes
// ---------------------------------------------------------------------------

$('copy-palette').addEventListener('click', async () => {
  const cells = buildPalette();
  if (cells.length === 0) return;
  const text = cells
    .map((c) => {
      const recipe = c.parts
        .map((p, idx) => {
          const e = c.partExtruders[idx]!;
          return `${e.label || e.hex} ${Math.round(p.ratio * 100)}%`;
        })
        .join(' + ');
      return `${c.predHex}\t${c.ratioLabel}\t${recipe}`;
    })
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    const btn = $('copy-palette') as HTMLButtonElement;
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => {
      btn.textContent = orig;
    }, 1200);
  } catch {
    // Clipboard blocked (e.g., insecure context). Fall back to a textarea select.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
});

// ---------------------------------------------------------------------------
// Library browser modal
// ---------------------------------------------------------------------------

const modal = $('library-modal');
const modalSearch = $<HTMLInputElement>('library-search');
const modalMaterial = $<HTMLSelectElement>('library-material');
const modalBrand = $<HTMLSelectElement>('library-brand');
const modalSource = $<HTMLSelectElement>('library-source');
const modalResults = $('library-results');
const modalMeta = $('library-meta');

function openLibrary(): void {
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  modalSearch.value = '';
  modalMaterial.value = '';
  modalBrand.value = '';
  modalSource.value = '';
  renderLibraryResults();
  // Defer focus so the browser doesn't fight the click handler.
  setTimeout(() => modalSearch.focus(), 0);
}
function closeLibrary(): void {
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

$('browse-library').addEventListener('click', openLibrary);
$('library-close').addEventListener('click', closeLibrary);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeLibrary();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeLibrary();
});

// Populate filter dropdowns once.
function populateFilters(): void {
  const materials = new Set<string>();
  const brands = new Set<string>();
  for (const e of LIBRARY) {
    materials.add(e.material);
    brands.add(e.brand);
  }
  for (const m of [...materials].sort()) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    modalMaterial.appendChild(opt);
  }
  for (const b of [...brands].sort()) {
    const opt = document.createElement('option');
    opt.value = b;
    opt.textContent = b;
    modalBrand.appendChild(opt);
  }
  for (const src of Object.keys(SOURCE_META) as LibrarySource[]) {
    const opt = document.createElement('option');
    opt.value = src;
    opt.textContent = SOURCE_META[src].label;
    modalSource.appendChild(opt);
  }
}
populateFilters();

// Library footer status: "1,247 entries · synced 14h ago" or empty-library hint.
function renderLibraryMeta(): void {
  if (LIBRARY.length === 0) {
    modalMeta.innerHTML = `
      Library is empty. The repo's daily sync workflow populates it.
      Until it runs, use <em>+ Custom hex</em> to add spools manually.
    `;
    return;
  }
  const parts = (Object.keys(SOURCE_META) as LibrarySource[]).map((src) => {
    const m = SOURCE_META[src];
    return `<a href="${m.sourceUrl}" target="_blank" rel="noopener">${m.label}</a> ${m.count.toLocaleString()} (${humanizeAge(m.lastSynced)})`;
  });
  modalMeta.innerHTML = `${LIBRARY.length.toLocaleString()} entries · ${parts.join(' · ')}`;
}
renderLibraryMeta();

function humanizeAge(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const ageMs = Date.now() - t;
  if (ageMs < 0) return 'in the future';
  const h = Math.floor(ageMs / 3_600_000);
  if (h < 1) return 'just now';
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function renderLibraryResults(): void {
  const q = modalSearch.value.trim().toLowerCase();
  const mat = modalMaterial.value;
  const brand = modalBrand.value;
  const source = modalSource.value as LibrarySource | '';

  let filtered = LIBRARY;
  if (source) filtered = filtered.filter((e) => e.source === source);
  if (mat) filtered = filtered.filter((e) => e.material === mat);
  if (brand) filtered = filtered.filter((e) => e.brand === brand);
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    filtered = filtered.filter((e) => tokens.every((t) => e.searchText.includes(t)));
  }

  // Cap at 200 results so a wide-open search doesn't render thousands of nodes.
  const capped = filtered.slice(0, 200);

  if (LIBRARY.length === 0) {
    modalResults.innerHTML = `
      <p class="hint" style="padding:24px;text-align:center;">
        The libraries haven't been synced yet. Run <code>npm run sync</code>
        locally or wait for the daily GitHub Action.
      </p>
    `;
    return;
  }

  if (capped.length === 0) {
    modalResults.innerHTML = `<p class="hint" style="padding:24px;text-align:center;">No matches.</p>`;
    return;
  }

  modalResults.innerHTML = capped
    .map(
      (e) => {
        const meta = SOURCE_META[e.source];
        const sub = [
          escape(e.brand),
          escape(e.material),
          e.finish ? escape(e.finish) : null,
          e.td !== undefined ? `TD ${e.td}` : null,
        ].filter(Boolean).join(' · ');
        return `
      <button class="lib-row" data-id="${e.id}" data-source="${e.source}">
        <span class="lib-swatch" style="background:${e.hex}"></span>
        <span class="lib-meta">
          <span class="lib-name">${escape(e.name)}</span>
          <span class="lib-sub">${sub}</span>
        </span>
        <span class="lib-source-badge lib-source-${e.source}" title="${meta.label}">${meta.short}</span>
        <span class="lib-hex">${e.hex}</span>
      </button>
    `;
      },
    )
    .join('') +
    (filtered.length > capped.length
      ? `<p class="hint" style="padding:8px 12px;">Showing ${capped.length} of ${filtered.length}. Refine the search to see more.</p>`
      : '');

  modalResults.querySelectorAll<HTMLButtonElement>('.lib-row').forEach((row) => {
    row.addEventListener('click', () => {
      const e = LIBRARY.find((x) => x.id === row.dataset.id && x.source === row.dataset.source);
      if (!e) return;
      addExtruderFromLibrary(e);
      closeLibrary();
    });
  });
}

function addExtruderFromLibrary(e: LibraryEntry): void {
  // If this exact library entry is already added, just enable it instead of
  // duplicating. Otherwise append.
  const existing = extruders.find(
    (x) => x.libraryRef && x.hex === e.hex && x.label === `${e.brand} · ${e.name}`
  );
  if (existing) {
    existing.enabled = true;
  } else {
    extruders.push({
      id: uid(),
      hex: e.hex,
      label: `${e.brand} · ${e.name}`,
      enabled: true,
      libraryRef: {
        brand: e.brand,
        material: e.material,
        source: e.source,
        ...(e.finish ? { finish: e.finish } : {}),
        ...(e.td !== undefined ? { td: e.td } : {}),
      },
    });
  }
  renderExtruders();
  renderPalette();
}

modalSearch.addEventListener('input', renderLibraryResults);
modalMaterial.addEventListener('change', renderLibraryResults);
modalBrand.addEventListener('change', renderLibraryResults);
modalSource.addEventListener('change', renderLibraryResults);

// ---------------------------------------------------------------------------
// Initial render
// ---------------------------------------------------------------------------

renderExtruders();
renderRatios();
renderPalette();
