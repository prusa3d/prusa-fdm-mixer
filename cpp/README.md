# prusa-fdm-mixer — C++ implementation

Predicts the apparent color of FDM filament mixes for use in slicer software.

By **Prusa Research s.r.o.** Calibrated against measured prints (median ΔE2000 ≈ 5.7 vs measured truth, compared to ~14.5 for naive linear-RGB mixing — the current default in BambuStudio and similar slicers).

## Files

- `prusa_fdm_mixer.hpp` — public API
- `prusa_fdm_mixer.cpp` — implementation

## Requirements

- C++17 or newer (uses `std::clamp`, `<cmath>`)
- No external dependencies (only standard library)
- Tested with GCC, Clang, MSVC

## Integration into PrusaSlicer / OrcaSlicer

1. Drop `prusa_fdm_mixer.hpp` and `prusa_fdm_mixer.cpp` into your source tree (e.g., `src/libslic3r/Color/`).

2. Add the `.cpp` file to your CMakeLists.txt source list:

   ```cmake
   set(SLIC3R_SOURCES
       ...
       Color/prusa_fdm_mixer.cpp
       Color/prusa_fdm_mixer.hpp
       ...
   )
   ```

3. Replace the existing color-mixing call site:

   ```cpp
   // Before (linear RGB mix):
   ColorRGB mixed = (1 - ratio) * color_a + ratio * color_b;

   // After:
   #include "Color/prusa_fdm_mixer.hpp"

   std::vector<prusa_fdm_mixer::Part> parts = {
       { color_a_hex, 1.0 - ratio },
       { color_b_hex, ratio },
   };
   std::string mixed_hex = prusa_fdm_mixer::mix(parts);
   ```

## API

```cpp
namespace prusa_fdm_mixer {

struct Part { std::string hex; double ratio; };
struct RGB { uint8_t r, g, b; };
struct LAB { double L, a, b; };

// Main entry point — predicts the apparent mixed color.
std::string mix(const std::vector<Part>& parts);
RGB         mix_rgb(const std::vector<Part>& parts);

// Color-space helpers (D65 white point throughout).
RGB         hex_to_rgb(const std::string& hex);
std::string rgb_to_hex(const RGB& rgb);
LAB         rgb_to_lab(const RGB& rgb);
RGB         lab_to_rgb(const LAB& lab);
double      delta_e_2000(const LAB& a, const LAB& b);

}
```

## Properties

- **Gradient-safe**: a part with `ratio >= 1.0` returns its hex exactly. Calling repeatedly along a gradient (varying ratio from 0 to 1) produces a smooth color path.
- **Works for 2 or 3+ components**. Ratios across all parts should sum to 1.0.
- **Deterministic**: pure function, no global state, thread-safe.

## Performance

The model is essentially a few `std::pow` calls plus a couple of color-space conversions. On a modern x86 CPU it runs in single-digit microseconds per call. Suitable for real-time gradient rendering.

## Verification

The accompanying `test_prusa_fdm_mixer.cpp` (in the development repo) verifies the implementation against reference predictions from the Python and TypeScript ports. Build with:

```
g++ -std=c++17 -O2 prusa_fdm_mixer.cpp test_prusa_fdm_mixer.cpp -o test
./test
```

All 33 tests should pass with the published implementation.

## Model details

The model is a 4-step transformation:

1. **Yule-Nielsen base** (n=3.0): `pow(linear_rgb, 1/n)` weighted average, then `pow(_, n)` back. Captures non-linear pigment opacity.

2. **Piecewise lightness correction**: `ΔL = -0.0477·L_gap − 2.112` (with extra slope when L_gap > 15) — corrects systematic darkening seen in real prints.

3. **Chroma correction**: `ΔC = 0.278·L_pred − 15.580` — bright mixes lose saturation, dark mixes gain it.

4. **Cyan-band hue rotation**: ~10° rotation peaking at hue 210° with linear ±30° fall-off — corrects observed green-shift in cyan-region predictions.

Steps 2-4 are scaled by a bell-curve weight `w = N^N · ∏ratios` that peaks at equal-mixing and falls to 0 at endpoints, ensuring the corrections vanish at gradient endpoints.

Coefficients were fit against 107 measured 2-color samples and 15 measured 3-color samples.

## License

Copyright (c) Prusa Research s.r.o. MIT — free for any use, commercial or non-commercial. Attribution appreciated.
