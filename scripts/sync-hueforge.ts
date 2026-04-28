#!/usr/bin/env node
/**
 * Sync the HueForge vendor filament libraries.
 *
 * Strategy:
 *   1. For each affiliate vendor, fetch the JSON shipped from HueForge's
 *      Shopify CDN (linked from shop.thehueforge.com/pages/affiliates).
 *   2. Normalize each entry into the same shape produced by sync-library.ts
 *      so the playground can merge both libraries trivially. HueForge entries
 *      additionally carry a `td` (Transmissivity / Transmission Distance).
 *   3. Write data/filament-library-hueforge.json with a `lastSynced` stamp.
 *
 * Defensive: a single bad vendor URL doesn't fail the whole sync — it gets
 * logged and skipped, the other 8 still complete. If every vendor fails the
 * existing JSON on disk is preserved (caller sees non-zero exit).
 *
 * Run with: `npm run sync:hueforge`
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT = join(REPO_ROOT, 'data', 'filament-library-hueforge.json');

const CDN_BASE = 'https://cdn.shopify.com/s/files/1/0737/9632/1561/files';

// Affiliate vendors listed at https://shop.thehueforge.com/pages/affiliates.
// Adding a new vendor is one line — the schema is the same across all of them.
const VENDORS: { label: string; file: string }[] = [
  { label: 'Polymaker',  file: 'Polymaker.json'         },
  { label: 'Sunlu',      file: 'Sunlu.json'             },
  { label: 'BambuLab',   file: 'BambuLab.json'          },
  { label: '3D Fuel',    file: '3D-Fuel_Filaments.json' },
  { label: 'IIIDMax',    file: 'IIIDMax.json'           },
  { label: 'Prusament',  file: 'Prusament.json'         },
  { label: 'Protopasta', file: 'Protopasta.json'        },
  { label: 'Numakers',   file: 'Numakers.json'          },
  { label: 'Overture',   file: 'Overture.json'          },
];

// -----------------------------------------------------------------------------
// Output schema (mirrors scripts/sync-library.ts; td is HueForge-specific)
// -----------------------------------------------------------------------------

interface FilamentEntry {
  id: string;
  brand: string;
  material: string;
  name: string;
  hex: string;
  finish?: string;
  td?: number;        // Transmissivity / Transmission Distance (HueForge)
  searchText: string;
}

interface Library {
  version: 1;
  source: 'hueforge';
  sourceUrl: 'https://shop.thehueforge.com/pages/affiliates';
  lastSynced: string;
  entryCount: number;
  entries: FilamentEntry[];
}

// HueForge's per-vendor JSON shape.
interface HueForgeFile {
  Filaments: HueForgeEntry[];
}
interface HueForgeEntry {
  Brand?: unknown;
  Color?: unknown;
  Name?: unknown;
  Type?: unknown;
  Transmissivity?: unknown;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function log(msg: string): void {
  process.stderr.write(`[sync-hueforge] ${msg}\n`);
}
function warn(msg: string): void {
  process.stderr.write(`[sync-hueforge] WARN: ${msg}\n`);
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
  return withHash.substring(0, 7).toLowerCase();
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// Fetch + normalize
// -----------------------------------------------------------------------------

async function fetchVendor(file: string): Promise<HueForgeFile> {
  const url = `${CDN_BASE}/${file}`;
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'prusa-fdm-mixer-sync' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.Filaments)) {
    throw new Error(`unexpected shape — missing top-level "Filaments" array`);
  }
  return parsed as HueForgeFile;
}

function entryToShared(e: HueForgeEntry): FilamentEntry | null {
  const brand = asString(e.Brand);
  const material = asString(e.Type);
  const name = asString(e.Name);
  const hex = normalizeHex(e.Color);
  if (!brand || !material || !name || !hex) return null;

  const td = asNumber(e.Transmissivity);
  const id = slug([brand, material, name].join('-'));
  return {
    id,
    brand,
    material,
    name,
    hex,
    ...(td !== undefined ? { td } : {}),
    searchText: [brand, material, name].filter(Boolean).join(' ').toLowerCase(),
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const all: FilamentEntry[] = [];
  const seen = new Set<string>();
  let okVendors = 0;

  for (const v of VENDORS) {
    try {
      log(`Fetching ${v.label}...`);
      const file = await fetchVendor(v.file);
      let kept = 0;
      let skipped = 0;
      for (const raw of file.Filaments) {
        const entry = entryToShared(raw);
        if (!entry) {
          skipped++;
          continue;
        }
        if (seen.has(entry.id)) {
          skipped++;
          continue;
        }
        seen.add(entry.id);
        all.push(entry);
        kept++;
      }
      log(`  ${v.label}: ${kept} entries (${skipped} skipped)`);
      okVendors++;
    } catch (err) {
      warn(`  ${v.label}: ${(err as Error).message}`);
    }
  }

  if (okVendors === 0) {
    throw new Error('no vendor JSONs fetched successfully — preserving existing file');
  }

  all.sort((a, b) => {
    if (a.brand !== b.brand) return a.brand.localeCompare(b.brand);
    if (a.material !== b.material) return a.material.localeCompare(b.material);
    return a.name.localeCompare(b.name);
  });

  const library: Library = {
    version: 1,
    source: 'hueforge',
    sourceUrl: 'https://shop.thehueforge.com/pages/affiliates',
    lastSynced: new Date().toISOString(),
    entryCount: all.length,
    entries: all,
  };

  if (!existsSync(dirname(OUTPUT))) mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(library, null, 2) + '\n');
  log(`Wrote ${OUTPUT} (${all.length} entries from ${okVendors}/${VENDORS.length} vendors)`);
}

main().catch((err) => {
  warn(`Sync failed: ${(err as Error).message}`);
  warn('Existing data/filament-library-hueforge.json (if any) is preserved.');
  process.exit(1);
});
