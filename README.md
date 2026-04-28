# prusa-fdm-mixer

A calibrated color-mixing model for FDM 3D printers that interleave filaments
at the layer level. Predicts the visible color of a multi-filament print
from the source filament hexes and their ratios, calibrated against
**107 measured 2-color samples** printed on a Prusa XL.

> **Median error ΔE 5.7** on the fitting set.
> ~45% of predictions land under the just-noticeable-difference threshold (ΔE 5).
> No runtime dataset, ~50 lines of math, MIT-licensed — vendor it freely.

## Why this exists

This work started while integrating the
[OrcaSlicer-FullSpectrum](https://github.com/ratdoux/OrcaSlicer-FullSpectrum)
multi-color FDM fork into **Prusa EasyPrint** and **PrusaSlicer**. Once the
toolpath was producing real multi-filament prints, the slicer's preview
colors visibly disagreed with the parts coming off the bed — bright
complementary mixes in particular looked nothing like reality.

Digging in surfaced two compounding errors that any naive per-channel blend
has:

1. sRGB is gamma-encoded, so averaging in it adds spurious brightness.
2. Real FDM prints darken by ~5–10% from inter-layer shadows that pure-RGB
   math doesn't see at all.

The result: previews come out brighter and more washed-out than the print
actually does, especially for saturated complementary mixes (cyan + magenta,
etc.) where the prediction is laughably wrong.

In parallel, BambuStudio shipped their own per-channel linear RGB mixing
for multi-filament previews — same family of approach, same underlying
issues. The gap is industry-wide, not a Prusa-specific quirk.

This repo ships a model that fixes both errors — empirically tuned against
real measurements rather than from physics first-principles — and the
infrastructure to keep extending it.

## Development

Requires **Node 20+** (matches the version pinned in
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)).

```sh
git clone https://github.com/<owner>/prusa-fdm-mixer.git
cd prusa-fdm-mixer
npm install
npm run dev      # vite dev server with hot reload
npm test         # vitest
npm run build    # production build to dist/
```

For the drop-in C++17 implementation and its build instructions, see
[`cpp/README.md`](./cpp/README.md).

## Quick links

| App | What it does |
|-----|--------------|
| [Playground](./apps/playground/) | Interactive palette generator: pick extruders, set ratios, see predicted colors sorted by hue |
| [Harness](./apps/harness/) | Score the v7 model against measured prints; compare against linear RGB, Kubelka-Munk, PolyMixer |
| [Gatherer](./apps/gatherer/) | Standalone tool to enter your own LAB measurements and export JSONL |

The static GitHub Pages build serves all three under one URL.

## Filament libraries

The playground browses real spools from two sources:

- **[OpenPrintTag database](https://github.com/OpenPrintTag/openprinttag-database)** — the open NFC standard from Prusa Research that ships hex codes for every spool that follows the spec. Synced into [`data/filament-library-openprinttag.json`](./data/filament-library-openprinttag.json).
- **[HueForge affiliate libraries](https://shop.thehueforge.com/pages/affiliates)** — per-vendor JSONs from HueForge's official affiliate page (Polymaker, Sunlu, BambuLab, 3D Fuel, IIIDMax, Prusament, Protopasta, Numakers, Overture). Each entry includes a Transmission Distance (TD) value. Synced into [`data/filament-library-hueforge.json`](./data/filament-library-hueforge.json).

A daily GitHub Action refreshes both files and commits any changes.

To trigger a sync manually:

```sh
npm run sync             # both libraries
npm run sync:openprinttag # OpenPrintTag only
npm run sync:hueforge     # HueForge only
```

Or run the workflow from the Actions tab on GitHub. If your spool isn't in either library, the playground's "+ Custom hex" button still works for any hex you paste — the libraries are convenience, not a hard dependency.

## Library usage

### TypeScript / JavaScript

```ts
import { mixFilaments } from 'prusa-fdm-mixer';

const result = mixFilaments([
  { hex: '#009bc3', ratio: 0.5 },  // cyan
  { hex: '#f6b921', ratio: 0.5 },  // yellow
]);

console.log(result.hex);  // '#519e5f'
console.log(result.lab);  // { L, a, b }
```

The package also exports comparison models (`mixLinearRgb`,
`mixKubelkaMunk`, `mixPolyMixer`) and color helpers (`hexToLab`,
`deltaE2000`, `chroma`, `hueDegrees`).

### C++ (PrusaSlicer / OrcaSlicer integration)

A drop-in C++17 implementation lives in [`cpp/`](./cpp). Single header +
single source file, no external dependencies:

```cpp
#include "filament_mix.hpp"

const std::vector<filament_mix::Part> parts = {
    {"#009bc3", 0.5},
    {"#f6b921", 0.5},
};
const auto result = filament_mix::mix(parts);
// result.hex, result.lab, result.rgb
```

See [`cpp/README.md`](./cpp/README.md) for vendoring instructions and the
33-test suite.

## How the v7 model works

1. **Yule-Nielsen base** — gamma-decode each filament to linear-light RGB,
   raise to `1/n` (n = 3.0), ratio-average, raise back to `n`. Standard
   halftone math.
2. **Lightness correction** — measured prints are darker than YN predicts,
   especially when the input filaments span a wide L* range. Apply
   `ΔL = -0.0477·L_gap - 2.112`, plus an extra `-0.060·(L_gap - 15)` knee
   when `L_gap > 15`.
3. **Chroma correction** — bright mixes lose saturation faster than dark
   mixes. Apply `ΔC = 0.2780·predicted_L - 15.580` to scale `(a, b)`.
4. **Cyan-band hue rotation** — predictions in the cyan band drift slightly
   warm. Rotate by up to `+10.38°` at hue 210°, with linear fall-off ±30°.
5. **Bell-curve weighting** — corrections scaled by `w = N^N · ∏ratios`
   (peaks at uniform mixing, zero at pure components) so pure colors are
   returned unchanged and gradients stay smooth.

All constants were fitted on the cleaned 107-sample 2-color set. The full
methodology, including which alternatives were tried and rejected, is in
[`docs/methodology.md`](./docs/methodology.md).

## Comparison to other models

Median ΔE2000 on the cleaned dataset (lower is better):

| Model | 2-color median | <5 hits | 3-color median |
|-------|---------------:|--------:|---------------:|
| **v7 (this work)** | **5.7** | **48 / 107** | **9.3** |
| Kubelka-Munk | 7.9 | 30 / 107 | 17.3 |
| PolyMixer (FilamentMixer port) | 9.0 | 22 / 107 | 13.7 |
| Linear sRGB (BambuStudio default) | 14.5 | 6 / 107 | 15.9 |

v7 is the only model where 3-color performance doesn't collapse vs 2-color.
Linear sRGB is on the table here because it's what slicers actually use
today, not because it's a serious physics candidate.

## Repository layout

```
prusa-fdm-mixer/
├── src/                    TypeScript model + comparison models
├── data/                   Fitting set + planned holdout
├── apps/                   Three browser apps (playground, harness, gatherer)
├── cpp/                    Drop-in C++17 implementation + tests
├── tests/                  Vitest unit tests
└── docs/                   Methodology, results
```

## Caveats

- The fitting set is in-sample. A separate held-out batch of ~60 measurements
  is being printed; once collected it will live in `data/holdout-set.jsonl`
  and the harness will report fitting/holdout split.
- Calibrated against Prusament PLA. Other brands and materials may differ.
- 3-color predictions are extrapolated from 2-color fits with only 15
  validation samples. Treat as directional, not precise.
- Bronze/galaxy/glitter "special effect" filaments mix less predictably
  than solid-color ones and are slightly over-represented in the harder
  tail of the error distribution.

## License

MIT — vendor freely. See [`LICENSE`](./LICENSE).

## Acknowledgements

- [justinh-rahb/filament-mixer](https://github.com/justinh-rahb/filament-mixer)
  — the PolyMixer comparison model and the original C++ scaffolding inspiration
- [ratdoux/OrcaSlicer-FullSpectrum](https://github.com/ratdoux/OrcaSlicer-FullSpectrum)
  — multi-color FDM workflow that surfaced the need for better mixing math
