#!/usr/bin/env node
/**
 * Sync the filament library from OpenPrintTag.
 *
 * Strategy:
 *   1. Download the openprinttag-database repo as a tarball from codeload.
 *   2. Extract to a temp directory.
 *   3. Walk the YAML files, parse each, normalize into a flat entry shape.
 *   4. Write data/filament-library-openprinttag.json with a `lastSynced` timestamp.
 *
 * Defensive: a single bad YAML doesn't fail the sync, just gets logged. If
 * the upstream is unreachable, the existing library file is preserved (the
 * caller — typically the GitHub Action — will see the script exit non-zero
 * but the JSON on disk stays valid).
 *
 * Run with: `npm run sync:openprinttag`
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  createReadStream,
} from 'node:fs';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { extract } from 'tar';
import yaml from 'js-yaml';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT = join(REPO_ROOT, 'data', 'filament-library-openprinttag.json');
const TMP = join(REPO_ROOT, '.sync-tmp');

const TARBALL_URL =
  'https://codeload.github.com/OpenPrintTag/openprinttag-database/tar.gz/refs/heads/main-pr';
const TARBALL_ROOT = 'openprinttag-database-main-pr';

// -----------------------------------------------------------------------------
// Output schema
// -----------------------------------------------------------------------------

interface FilamentEntry {
  id: string;            // stable slug, e.g. "prusament-pla-galaxy-black"
  brand: string;
  material: string;      // 'PLA' | 'PETG' | 'ABS' | ...
  name: string;          // product display name
  hex: string;           // primary color, normalized lowercase #rrggbb
  finish?: string;       // 'matte' | 'silk' | 'galaxy' | ... when known
  searchText: string;    // precomputed lowercased "brand material name finish" for fuzzy filter
}

interface Library {
  version: 1;
  source: 'openprinttag';
  sourceUrl: 'https://github.com/OpenPrintTag/openprinttag-database';
  lastSynced: string;    // ISO 8601
  entryCount: number;
  entries: FilamentEntry[];
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[sync] ${msg}\n`);
}
function warn(msg: string): void {
  process.stderr.write(`[sync] WARN: ${msg}\n`);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const HEX_RE = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
function normalizeHex(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!HEX_RE.test(trimmed)) return null;
  const withHash = trimmed.startsWith('#') ? trimmed : '#' + trimmed;
  // Strip alpha if present.
  return withHash.substring(0, 7).toLowerCase();
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function pickFromObj(v: unknown, keys: string[]): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  return pickString(v as Record<string, unknown>, keys);
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function downloadTarball(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'prusa-fdm-mixer-sync' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body) throw new Error(`Empty body from ${url}`);
  const out = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, out);
}

async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  await pipeline(createReadStream(tarballPath), createGunzip(), extract({ cwd: destDir }));
}

// -----------------------------------------------------------------------------
// OpenPrintTag YAML parser
// -----------------------------------------------------------------------------
//
// The repo stores per-spool YAML files under data/. Field names follow the
// OpenPrintTag Architecture schema. We try the common spellings and skip any
// document that's missing required fields rather than guessing.

function parseBrands(brandsDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(brandsDir)) {
    warn(`brands/ not found at ${brandsDir} — display names will fall back to slugs`);
    return index;
  }
  for (const path of walk(brandsDir)) {
    const ext = extname(path);
    if (ext !== '.yaml' && ext !== '.yml') continue;
    try {
      const doc = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
      if (!doc || typeof doc !== 'object') continue;
      const brandSlug = pickString(doc, ['slug']);
      const displayName = pickString(doc, ['name', 'display_name']);
      if (brandSlug && displayName) index.set(brandSlug, displayName);
    } catch (e) {
      warn(`${path}: ${(e as Error).message}`);
    }
  }
  return index;
}

function docToEntry(
  doc: Record<string, unknown>,
  brandIndex: Map<string, string>,
): FilamentEntry | null {
  // Materials reference their brand by slug; resolve to the display name from
  // data/brands/. Fall back to legacy flat-string forms for forward-compat.
  const brandSlug =
    pickFromObj(doc.brand, ['slug']) ?? pickFromObj(doc.manufacturer, ['slug']);
  const brand =
    (brandSlug ? brandIndex.get(brandSlug) : undefined) ??
    pickString(doc, ['brand', 'manufacturer', 'vendor']) ??
    pickFromObj(doc.brand, ['name', 'display_name', 'slug']) ??
    pickFromObj(doc.manufacturer, ['name', 'display_name', 'slug']);

  const material = pickString(doc, ['material', 'material_type', 'type', 'abbreviation']);
  const name = pickString(doc, ['name', 'product_name', 'display_name']);

  // OpenPrintTag stores hex as `primary_color.color_rgba` with an alpha byte;
  // normalizeHex strips it down to #rrggbb.
  const hex =
    normalizeHex(pickString(doc, ['color_hex', 'colorHex', 'hex'])) ??
    normalizeHex(pickFromObj(doc.color, ['hex', 'color_rgba'])) ??
    normalizeHex(pickFromObj(doc.primary_color, ['hex', 'color_rgba']));

  const finish = pickString(doc, ['finish', 'visual_finish'])?.toLowerCase();

  if (!brand || !material || !name || !hex) return null;

  const id = pickString(doc, ['slug', 'id']) ?? slug([brand, material, name].join('-'));
  return {
    id,
    brand,
    material,
    name,
    hex,
    ...(finish ? { finish } : {}),
    searchText: [brand, material, name, finish].filter(Boolean).join(' ').toLowerCase(),
  };
}

function parseAll(dataDir: string, brandIndex: Map<string, string>): FilamentEntry[] {
  const out: FilamentEntry[] = [];
  let scanned = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const path of walk(dataDir)) {
    const ext = extname(path);
    if (ext !== '.yaml' && ext !== '.yml') continue;
    scanned++;
    try {
      const doc = yaml.load(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
      if (!doc || typeof doc !== 'object') {
        skipped++;
        continue;
      }
      const entry = docToEntry(doc, brandIndex);

      if (!entry) {
        skipped++;
        continue;
      }
      if (seen.has(entry.id)) continue; // dedup on slug
      seen.add(entry.id);
      out.push(entry);
    } catch (e) {
      warn(`${path}: ${(e as Error).message}`);
      skipped++;
    }
  }
  log(`Scanned ${scanned} YAML files; ${out.length} entries, ${skipped} skipped`);
  return out;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  log(`Downloading ${TARBALL_URL}...`);
  const tarPath = join(TMP, 'openprinttag.tar.gz');
  await downloadTarball(TARBALL_URL, tarPath);

  log('Extracting...');
  const extractDir = join(TMP, 'openprinttag');
  await extractTarball(tarPath, extractDir);

  const dataDir = join(extractDir, TARBALL_ROOT, 'data', 'materials');
  if (!existsSync(dataDir)) {
    throw new Error(`data/ directory not found in tarball — did the upstream layout change?`);
  }

  const brandIndex = parseBrands(join(extractDir, TARBALL_ROOT, 'data', 'brands'));
  log(`Loaded ${brandIndex.size} brands`);
  const entries = parseAll(dataDir, brandIndex);
  // Sort by brand, then material, then name for stable diffs.
  entries.sort((a, b) => {
    if (a.brand !== b.brand) return a.brand.localeCompare(b.brand);
    if (a.material !== b.material) return a.material.localeCompare(b.material);
    return a.name.localeCompare(b.name);
  });

  const library: Library = {
    version: 1,
    source: 'openprinttag',
    sourceUrl: 'https://github.com/OpenPrintTag/openprinttag-database',
    lastSynced: new Date().toISOString(),
    entryCount: entries.length,
    entries,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(library, null, 2) + '\n');
  log(`Wrote ${OUTPUT} (${entries.length} entries)`);

  rmSync(TMP, { recursive: true, force: true });
}

main().catch((err) => {
  warn(`Sync failed: ${(err as Error).message}`);
  warn('Existing data/filament-library-openprinttag.json (if any) is preserved.');
  process.exit(1);
});
