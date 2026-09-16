# Hyperion.NG fork: extended color calibration

Status: **implementation in progress**, on branch `fork/extended-color-calibration`.
This file was reconstructed on 2026-09-16 after the terminal session that
originally held it was closed unexpectedly; it is inferred from code comments
in this tree plus the project's own memory notes, not a verbatim recovery.

## Motivation

Stock Hyperion.NG 2.2.1's color calibration (`RgbChannelAdjustment` /
`ColorAdjustment`) is a **fixed, compiled-in** set of exactly 6 hue anchors
(red, yellow, green, cyan, blue, magenta, plus white/black) — confirmed via
`strings /usr/bin/hyperiond`. It is not dynamic or config-extensible; reaching
past it requires a source patch and rebuild.

This was validated as a real limitation, not a hypothetical one: while
watching an aerial-highway video source, concrete/asphalt (should read
neutral gray) was visibly green/cyan-tinted on the LEDs. Root-caused via
Hyperion's own `imagestream` (JSON-RPC port 19444): the tint was already
present in the **raw, uncorrected capture** (every sampled region had
G > R > B, e.g. ~[27,35,30]), traced further to the USB capture chip's V4L2
`saturation` control being maxed at 255 (vs. driver default 180), amplifying
a small sensor tint. The only available workaround in stock Hyperion was
shifting the global `green` channel-adjustment anchor toward cyan
(`[0,255,0]` → `[40,250,199]`), which fixed the concrete but, as predicted,
also pulls genuine saturated greens (grass, trees) toward cyan/teal as a side
effect — because one anchor governs both the near-neutral defect and the
fully-saturated color.

That confirmed the lesson driving this fork: **one global hue anchor isn't
enough**, and defects near the gray/neutral axis need a fix path that doesn't
compete with saturated-hue correction.

## Requested features

1. **Arbitrary/more hue anchor points** — not just the fixed 6. E.g. a
   dedicated turquoise anchor between cyan and blue, so intermediate hues get
   independent control instead of pure interpolation between neighbors.
2. **Per-anchor gamma** — today there are only 3 global
   `gammaRed/gammaGreen/gammaBlue` values. The gamma curve itself should be
   able to vary by hue region.
3. **Brightness-gated color shift ("qualifier with luma gate")** — for a given
   hue/anchor, define a brightness threshold below which that color is
   remapped to a different target (including "just go dark"). Concrete case:
   dark brown/dark gray reads as visible red on the LEDs because hue is
   nearly undefined near the gray axis at low saturation; below a threshold
   it should go dark instead of showing a wrong hue.
4. **Independent gray-axis / white-balance trim** — the concrete/green defect
   above is actually a white-balance problem (a low-saturation/neutral-axis
   tint from the capture sensor), not a hue-mapping problem. Routing the fix
   through a saturated hue anchor is a workaround with real side effects.
   Needs its own gain correction that only touches near-neutral, low-chroma
   pixels, orthogonal to the saturated-hue control-point system above.
5. **(Not yet designed) Smarter source-side color classification** — instead
   of only correcting after the fact via a single global anchor, distinguish
   low-saturation "concrete gray" pixels from genuine saturated greens before
   applying any hue shift. Noted as a possible future angle; no code exists
   for this yet.

## Architecture

Rather than patching the old fixed 6-anchor struct three separate times, this
fork introduces one flexible data model that serves features 1-3, plus a
separate orthogonal path for feature 4:

- **`ColorControlPoint`** (`include/utils/ColorControlPoint.h`) — a free list
  entry: `hue` center (turns, matches `ColorSys::rgb2okhsv`), `influence`
  (half-width of a raised-cosine falloff window around `hue`), additive
  `targetHueShift`, multiplicative `targetSaturationGain`, its own `gamma`,
  and an optional `LumaGate`.
- **`LumaGate`** — `triggerBelow` / `releaseAbove` (hysteresis band, not a
  single threshold), `debounceFrames` (consecutive-frame requirement), and a
  `LumaGateMode` (`OFF`, `MIN_BRIGHTNESS`, `HUE_SHIFT`).
- **`GrayAxisTrim`** — independent near-neutral RGB gain correction, gated by
  an Okhsv `saturationThreshold`, applied *before* the control-point pass so
  it never competes with saturated hue anchors.
- **`ColorControlPointTransform`** (`libsrc/utils/ColorControlPointTransform.cpp`)
  — the engine. Operates per-pixel in Okhsv space
  (`ColorSys::rgb2okhsv`/`okhsv2rgb`). Order: gray-axis trim first (pixel
  returned immediately if it applies); otherwise, find the *nearest* control
  point whose influence window covers the pixel's hue.

  **Design choice: nearest-point-wins, not blending.** When a hue falls in
  more than one point's window, only the highest-weight point applies —
  blending independently configured hue shifts from two points can cancel or
  double up in ways that are hard to reason about. Effect strength still
  eases smoothly to 0 at each point's own window edge (raised cosine), so
  there's no hard seam between points, but two points never mix.

## Integration into stock Hyperion

- `ColorAdjustment` (`include/hyperion/ColorAdjustment.h`) gained
  `_controlPoints` (`QVector<ColorControlPoint>`), a parallel
  `_gateStates` (`QVector<ColorControlPointGateState>`) for hysteresis/debounce
  runtime state, and `_grayAxisTrim`.
- `hyperion::createColorAdjustment` (`include/utils/hyperion.h`) parses new
  JSON keys `controlPoints` (array) and `grayAxisTrim` (object) from the color
  adjustment config, defaulting to empty/disabled — **when both are absent,
  this profile is byte-identical to stock Hyperion.**
- `MultiColorAdjustment::applyAdjustment` calls
  `ColorControlPointTransform::apply(...)` right after `_okhsvTransform` and
  before `_rgbTransform.applyGamma`, i.e. after the existing global HSV
  saturation/value transform but before the final gamma/brightness-component
  split.
- `libsrc/hyperion/schema/schema-color.json` exposes both `controlPoints` and
  `grayAxisTrim` as JSON-schema objects (so the config validates and the
  existing web-config JSON-editor can at least show/edit raw values).
- `assets/webconfig/i18n/{de,en}.json` got title strings for the two new
  schema sections; **no dedicated visual panel/widget** (like the existing
  6-anchor color-wheel editor) has been built yet — this is still open work.

## Flicker safety (critical constraint)

This Hyperion install has hard-won flicker fixes (star grounding, SPI clock
rate tuning — see the project's `hyperion-good-state-2026-09-16-1mhz` /
`hyperion-flicker-*` history). A **hard per-frame brightness threshold** for
the luma gate would itself be a flicker source: video noise/compression
artifacts near the threshold would cause frame-by-frame flapping between the
normal color and the gated target. This is why `LumaGate` is *not* a single
threshold:

- **Hysteresis**: `triggerBelow` (enter gate) and `releaseAbove` (leave gate)
  are separate values with a gap between them.
- **Temporal debouncing**: `debounceFrames` consecutive frames past the
  relevant threshold are required before the gate actually switches state,
  implemented via `ColorControlPointGateState::consecutiveFrames` in
  `ColorControlPointTransform::apply`.

**Known v1 simplification**, documented in `ColorControlPointGateState`'s
header comment: gate state is tracked **per `ColorAdjustment` profile, not
per physical LED**. All LEDs sharing the same adjustment profile share one
gate state. Acceptable for now; revisit if per-LED gating is ever needed.

## Fork maintenance cost (accepted tradeoff)

No more `apt upgrade` for Hyperion once this ships — self-build and
self-maintain, no automatic upstream bugfixes/security patches, future
upstream releases must be manually merged against this patch. Building on the
Pi 5 itself is feasible but slow (CMake/Qt5 + vendored deps like abseil/
protobuf/mbedtls from scratch: 30-60+ minutes).

## Status as of 2026-09-16

**Done, and build-verified:**
- `ColorControlPoint.h`, `ColorControlPointTransform.h/.cpp` — features 1, 2, 3.
- `GrayAxisTrim` in the same files — feature 4.
- Wiring into `ColorAdjustment.h`, `hyperion.h`, `MultiColorAdjustment.cpp`,
  `libsrc/utils/CMakeLists.txt`, `schema-color.json`, i18n strings.
- A full from-scratch build (`cmake --build . --target hyperiond -j4`,
  kicked off 16:26, finished 16:43) **succeeded with zero compile errors**,
  including `ColorControlPointTransform.cpp` in the `hyperion-utils` target.
  Binary present at `build/bin/hyperiond` (15MB, linked 16:43).
- Still **uncommitted** (unstaged modifications + untracked new files) on
  `fork/extended-color-calibration`, branched from tag `1a00360`
  ("Release 2.2.1").

**Not started:**
- Feature 5 (source-side color classification) — idea only, no design.
- Web-config UI panel/widget for editing control points and gray-axis trim
  visually (currently schema-only, so only the raw JSON editor can touch it).
- Validation against the known-good baseline config
  (`hyperion-good-state-2026-09-16-1mhz`) once built.
- Replacing the apt-installed `hyperion@alexo` service with this self-built
  fork.
- Exposing/documenting the capture device's V4L2 `saturation` control
  (currently 255, driver default 180) as a tunable, to reduce how hard any
  calibration workaround has to fight the amplified sensor tint at the
  source.

## Next steps

1. Let the current build finish; check for compile errors in the new files
   (`ColorControlPointTransform.cpp` especially — not yet reached by the log
   as of the last check).
2. Commit the current working-tree changes to `fork/extended-color-calibration`.
3. Smoke-test with an empty `controlPoints`/disabled `grayAxisTrim` config to
   confirm byte-identical behavior to stock (no regression on the known-good
   baseline).
4. Add a minimal control point + gray-axis trim config reproducing the
   concrete/green fix without the global-anchor side effect on real greens,
   validate against the same video source used to find the original bug.
5. Extend the web-config UI panel for the new schema sections.
6. Only then consider swapping the apt-installed service for this build.
