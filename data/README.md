# Data

## Files

### `filament-library-openprinttag.json` (~10k entries)

Synced daily from the [OpenPrintTag database](https://github.com/OpenPrintTag/openprinttag-database)
by [`scripts/sync-openprinttag.ts`](../scripts/sync-openprinttag.ts). Each entry: `{ id, brand, material, name, hex, finish?, searchText }`. Powers the playground's library browser.

### `filament-library-hueforge.json` (~600 entries)

Synced from HueForge's [affiliate vendor JSONs](https://shop.thehueforge.com/pages/affiliates)
by [`scripts/sync-hueforge.ts`](../scripts/sync-hueforge.ts). Same shape as the OpenPrintTag library plus an optional `td` (Transmission Distance) per entry.

### `fitting-set.jsonl` (146 entries)

The cleaned fitting set used to calibrate the v7 model.

- 24 base filaments (single-component entries)
- 107 two-color samples
- 15 three-color samples

Each line is a JSON object:

```json
{
  "hex": "#3e9571",
  "lab": { "L": 55.75, "a": -35.02, "b": 11.34 },
  "note": "optional name for base filaments",
  "combinations": [
    { "hex": "#009bc3", "ratio": 0.5 },
    { "hex": "#f6b921", "ratio": 0.5 }
  ]
}
```

Base filaments self-reference in `combinations` with ratio 1.

### `holdout-set.jsonl` (82 entries)

Independent held-out set, batch 5. None of these samples were used to
calibrate v7 — the model's error against this file is genuine out-of-sample
performance.

- 10 base filaments (single-component entries)
- 59 two-color samples
- 13 three-color samples

Same line schema as `fitting-set.jsonl`. The harness loads both files and
exposes an "All / Training / Holdout" toggle at the top to switch the active
view between them.

### `flagged.jsonl` (planned)

The 21 raw entries that were removed during cleaning, with reasons:
duplicate-recipe disagreements, declared-LAB / declared-hex inconsistencies,
and recipes the user reviewed and identified as mislabeled. Removing these
is not "selectively reporting good results" — they're confirmed data errors,
not predictions the model couldn't handle.

## Provenance

All measurements were taken from prints made on a Prusa XL with PLA filaments.
Color was measured with a colorimeter on flat-printed swatches under
controlled lighting, and entered into the gatherer app (`/apps/gatherer/`)
in CIELAB.
