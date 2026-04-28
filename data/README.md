# Data

## Files

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

### `holdout-set.jsonl` (placeholder)

Reserved for an independent held-out set. Until populated, the model's
reported error is in-sample. After +60 measurements arrive, this will hold
the unseen samples and the harness will report fitting/holdout split.

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
