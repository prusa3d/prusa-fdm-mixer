# Methodology

This is the longer-form companion to the README. It walks through the dataset,
how the prusa-fdm-mixer model was derived, what alternatives were tried and rejected, and
the honest limitations.

## Dataset

The fitting set lives at [`data/fitting-set.jsonl`](../data/fitting-set.jsonl).
146 entries: 24 base filaments + 107 two-color mixes + 15 three-color mixes.

All measurements were taken with a colorimeter on flat-printed swatches under
controlled lighting and entered into the gatherer app
([`apps/gatherer/`](../apps/gatherer/)) in CIELAB. The original raw export had
167 entries; 21 were removed during cleaning for one of three reasons:

- **Duplicate-recipe disagreement** — the same recipe was printed twice and
  the two measurements differed by more than the model's typical error
  (ΔE > 5). One of the two is a misprint or mismeasure; we removed both
  rather than guess which.
- **Hex/LAB mismatch** — the entered LAB values didn't round-trip to the
  recorded hex within ΔE 5. Almost certainly typos during entry.
- **Confirmed mislabeling** — Ondrej reviewed the worst-error samples and
  identified three where the print itself was made with the wrong recipe
  (the slicer config was edited after the print started).

These are confirmed data errors, not predictions the model couldn't handle.
A separate `data/flagged.jsonl` will eventually carry the removed entries with
their reasons for full transparency.

## Model derivation

### Step 1: Yule-Nielsen base (n = 3.0)

We started from a Yule-Nielsen mix in linear-light RGB. YN is the standard
halftone-printing formula and has one tunable parameter `n`: at `n = 1` it
collapses to linear-light averaging; at higher `n` the prediction darkens
monotonically. Grid search over `n ∈ [1.5, 7.0]` on the cleaned dataset
gave optimal `n ≈ 3.0` for FDM (median ΔE 7.3).

### Step 2: Lightness correction

YN-only residuals showed a strong systematic shift: every prediction was
**lighter** than measured, and the gap grew with the L* span of the inputs.
Fitting `ΔL = α · L_gap + β` on the working zone gave
`α = -0.0477, β = -2.112`. After application, the worst-case zone
(L_gap > 15) still showed structure, so a piecewise knee was added:
`extra ΔL = -0.060 · (L_gap - 15)` when L_gap exceeds 15.

### Step 3: Chroma correction

After the L correction, residuals on chroma showed `ΔC` correlated with
predicted L (R² ≈ 0.39): bright mixes desaturated faster than dark ones.
Fitting `ΔC = a · L_pred + b` on the working zone gave `a = 0.2780, b = -15.580`.
The chroma is then applied by scaling `(a*, b*)` so the new magnitude is
`max(0, C_pred + ΔC)`.

### Step 4: Cyan-band hue rotation

Even after L and C correction, predictions in the hue range 180–240°
(the cyan-blue band) drifted warm by ~10° on average. Other hue bands
showed no consistent rotation. Applied as a triangular-window correction
peaking `+10.38°` at hue 210° with linear fall-off ±30°.

### Step 5: Bell-curve correction weight

All corrections are scaled by a weight `w = N^N · ∏ratios`. For 2 parts at
ratios `(t, 1-t)`, this is `4·t·(1-t)` — peaks at `t = 0.5` and falls to
zero at `t = 0` or `t = 1`. For 3 parts at uniform `1/3`, it's `27/27 = 1`.
The weight ensures:

- Pure components (`ratio = 1`) round-trip exactly. Critical for slicer
  gradient previews where the prediction must equal the source filament at
  the endpoints.
- Gradients are smooth — no abrupt jumps when one component dominates.

A multiplier `PEAK_STRENGTH = 1.375` was added to the weight after fitting,
because uniform mixes were systematically still under-corrected.

## Alternatives tried and rejected

### Per-pigment K/S calibration

A full Kubelka-Munk fit with per-filament K and S coefficients was tried.
Required ~40 samples per filament for stable fits — the dataset is short
on coverage for that. With the available data, the per-filament KM was no
better than YN globally and significantly worse on saturated complementaries.

### Hybrid YN + KM (best-of)

For some samples KM beats prusa-fdm-mixer (e.g., black + magenta). We
investigated a hybrid that picks YN or KM per sample based on input features
(min chroma, L gap, hue distance). Best simple rule got 42/69/79 hits at
ΔE < 5/<8/<10 — worse than prusa-fdm-mixer's 48/74/85. The features
available are too weakly predictive to build a clean classifier.

### kNN residual correction

Treating the dataset as a lookup and predicting via kNN on the residuals
got median ΔE ~4.5 (vs prusa-fdm-mixer's 5.7), but it requires shipping the
dataset at runtime. The prusa-fdm-mixer design constraint was "closed-form,
no runtime data," so kNN
is out of scope for the deliverable but useful as an upper bound on what's
extractable from the data.

### Higher-order polynomial fits

Tried up to degree-3 polynomials in `(L_gap, L_pred, C_min, hue_dist)` for
each of `dL, dC, dh`. Marginal improvement on the working zone (median ΔE
5.5 vs 5.7), no improvement on the struggling zone, and the resulting
constants were less interpretable. Not worth the complexity.

## Honest critique

A few attacks on this work that deserve direct answers:

**"Median ΔE 5.7 is just barely below the JND threshold."**
Correct. About half the predictions are perceptibly off. The win isn't
"perfect predictions" — it's "predictions that are perceptibly closer to
reality than what slicers ship today." Linear sRGB has median ΔE 14.5;
any prediction in the JND-or-better range is a meaningful step.

**"In-sample median is optimistic."**
Correct, and we don't claim otherwise. The +60 held-out samples will land
the honest number. Until they exist, treat the headline as a fitting-set
score, not a generalization claim.

**"Special-effect filaments (bronze, galaxy, glitter) are over-represented
in the worst samples."**
Yes. The model assumes uniform pigments; effect filaments have orientation-
dependent reflectance that none of the candidate models capture. They show
up disproportionately in the ΔE > 10 tail. A future version may need a
"this-is-a-special-effect-filament" flag.

**"Brand and material generalization."**
Untested. All measurements are from Prusament PLA. PETG, ABS, and
non-Prusa brands may need refit constants. The structure of the model
(YN base + L/C/hue corrections) should transfer; the exact coefficients
probably won't.

## Future work

- Held-out evaluation once the +60 samples land
- Per-filament tinting strength (currently all filaments are treated the
  same, which under-fits highly-pigmented vs sheer/translucent ones)
- More 3-color samples — currently 15, which is enough for direction but
  not for a separate fit
- Material-conditional refit (separate constants for PETG, ABS)
