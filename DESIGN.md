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
4b. **Staged gray-axis gain ("Grauachsen-Stufen")** — feature 4's single
    `saturationThreshold`/`gainRed/Green/Blue` quartet only allowed one gain
    for the whole near-neutral band. Real captures often need different
    corrections at different shades of near-gray (e.g. true black-level noise
    vs. a slightly warmer dark gray a bit further out on the saturation
    axis). Replaced with an ordered list of `GrayAxisTrimStop` entries
    (`saturationUpTo`, `gainRed/Green/Blue`), each an anchor point on a
    piecewise-linear gain curve over saturation — see `GrayAxisTrimStop` in
    Architecture below. Deliberately a smooth ramp between stops, not a flat
    staircase: a hard step at a band boundary reproduces the exact flicker
    bug the single-threshold version had before its own smoothing fix
    (commit `a6c62488`).
    `hyperion::createGrayAxisTrim` sorts stops ascending defensively
    server-side regardless of input order, but `content_colors.js` also
    actively *enforces* strictly-ascending `saturationUpTo` in the WebUI
    itself (blocking warning + disabled Speichern-button on violation,
    offending rows outlined) — a user was able to enter stop 1 with a
    higher `saturationUpTo` than stop 2 and only notice the visual list
    order didn't match the applied curve, so relying on the silent
    server-side sort alone was confusing and got upgraded to a hard UI
    block.

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
- **`GrayAxisTrim`** — independent near-neutral RGB gain correction, applied
  *before* the control-point pass so it never competes with saturated hue
  anchors. As of feature 4b ("Grauachsen-Stufen") it's driven by an ordered
  `QVector<GrayAxisTrimStop>` (`saturationUpTo`, `gainRed/Green/Blue`)
  instead of one fixed threshold+gain — see feature 4b below.
- **`GrayAxisTrimStop`** — one Stuetzstelle of the trim's staged gain curve:
  flat at the first stop's gain from saturation 0 up to its `saturationUpTo`;
  linearly blended between two consecutive stops across the saturation span
  between them; no effect above the last stop's `saturationUpTo` (saturated
  colors always stay untouched). `hyperion::createGrayAxisTrim` sorts the
  vector ascending by `saturationUpTo` once at config-parse time, so the
  per-pixel transform never re-sorts.
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
- Committed on `fork/extended-color-calibration` (branched from tag
  `1a00360`, "Release 2.2.1") as commit `ec800ba`, plus a required upstream
  build fix in the vendored protobuf submodule (libatomic linking scoped to
  the `libprotobuf` target only), committed inside that submodule as
  `956435f0d` and referenced via the updated gitlink.
- **Baseline regression smoke test passed** (2026-09-16 17:15): ran the fork
  binary against an isolated copy of the live production `hyperion.db`
  (`-u <isolated dir> --readonlyMode --debug`, live service left untouched).
  `DB-CONFIGMGR` validated the config against the extended
  `schema-color.json` with no errors, `LedDevice 'hd108'` loaded with the
  exact known-good values (644 LEDs, brightness 15/48%, SPI 5MHz), no
  `controlPoints`/`grayAxisTrim` log activity (confirming the empty/disabled
  default path was taken, i.e. no behavior change), and the process shut
  down cleanly (`Application ended with code 0`). The only `<ERROR>` lines
  were expected artifacts of running two Hyperion instances against the same
  V4L2 device/ports simultaneously (device busy, port already in use) — not
  related to the fork code.

- **Pushed to GitHub**: fork `LX-ComfyUI/hyperion.ng-color-fork` (forked from
  `hyperion-project/hyperion.ng`, renamed from the fork's default name),
  branch `fork/extended-color-calibration` pushed and tracking `myfork`
  remote.
- **Live-hardware smoke test, running now** (2026-09-16 17:31): stopped the
  real `hyperion@alexo` systemd service (`sudo systemctl stop`) and started
  the fork binary directly (`build/bin/hyperiond --service --debug`, real
  `~/.hyperion` userdata, **not** read-only this time) against the actual
  SPI LED strip and V4L2 capture card, which are now free. Result so far:
  clean startup, `LedDevice 'hd108'` ON with the same known-good values, V4L2
  grabber initializes without the earlier "device busy" errors (real device,
  no longer contested), JSON API on port 19444 answers `serverinfo` with
  correct adjustment data, no SPI/exception/segfault lines in the log.
  **This is the first time the fork has driven the real LEDs.**

**Web UI now shows the new fields, plus UX polish (2026-09-16, commit
`ddf5205`):** the fields were being served correctly but not rendered —
root cause was that `controlPoints`/`grayAxisTrim` lacked this schema's
`"required": true` convention (every other property has it), which this
project's JSONEditor treats as "always show". Fixing that surfaced a second
issue: `"required": true` also makes it a real JSON-schema requirement on
the backend, so the live (pre-existing) config failed validation on the next
boot — but Hyperion's own `DBConfigManager::updateConfiguration()` already
has a self-healing correction pass for exactly this (schema evolution) case:
it auto-backfills missing required fields with their schema defaults,
writes an automatic timestamped backup first
(`~/.hyperion/archive/HyperionBackup_*.json`), then persists the corrected
config — no manual DB surgery needed. Also updated the bundled
`settings/hyperion.settings.json.default` template so brand-new instances
validate cleanly too. On top of that, added: user-friendly German titles for
every new field (was raw internal names like `hue`, `lumaGate`), full
title+description i18n text (function, value range, step) in German and
English for both the new fields and the pre-existing stock fields (which
were also missing range/step info), a small hover-info icon next to every
field on the color page (custom-built since this JSONEditor build's own
info-button plumbing turned out to be dead/unwired code), and a CSS-only fix
to keep the "LED-Instances" sidebar section permanently expanded.

**Known gap surfaced by the live test — companion services are offline:**
`hyperion-shelly-control.service` (Shelly-PSU auto-control, see
[[hrpg-300-5-psu-control]]) and `video-signal-monitor.service` (see
[[video-signal-monitor]]) both declare `Requires=hyperion@alexo.service` in
their systemd units, so stopping that unit auto-stopped both. Restarting them
normally would also re-trigger systemd to start the *stock* `hyperion@alexo`
unit (fighting the fork for the same SPI/V4L2 device) because of that
`Requires=`. Worse, `video_signal_monitor.py` hard-codes
`journalctl -u hyperion@alexo` to track V4L2 start/stop and USB error events
— even hand-started, it cannot see equivalent events from a fork process
running outside that unit. A true parity test needs the fork to run *as*
the `hyperion@alexo` unit (temporarily repointing that unit's `ExecStart`),
not as a bare background process. **Deferred by user decision (2026-09-16):
PSU control + flicker monitor integration is explicitly out of scope for
now** — current live test only covers core Hyperion (LED output, capture,
JSON API), not the PSU/monitor companion services.

**Not started:**
- Feature 5 (source-side color classification) — idea only, no design.
- Web-config UI panel/widget for editing control points and gray-axis trim
  visually (currently schema-only, so only the raw JSON editor can touch it).
- Reconnecting PSU control (`hyperion-shelly-control`) and flicker/video
  monitoring (`video-signal-monitor`) to the fork — see gap above, deferred.
- Making the live-hardware test durable/observed over time (current test is
  a fresh, short-lived manual run, not yet watched through a TV-pause cycle
  or over an extended period the way [[hyperion-flicker-2026-09-15]] and
  related flicker investigations required).
- Replacing the apt-installed `hyperion@alexo` service definition with this
  self-built fork (i.e. making the swap durable/reboot-safe via the actual
  systemd unit, vs. today's manual foreground run).
- Exposing/documenting the capture device's V4L2 `saturation` control
  (currently 255, driver default 180) as a tunable, to reduce how hard any
  calibration workaround has to fight the amplified sensor tint at the
  source.

## Next steps

1. ~~Let the current build finish~~ — done, zero errors.
2. ~~Commit the current working-tree changes~~ — done (`ec800ba`).
3. ~~Smoke-test with an empty `controlPoints`/disabled `grayAxisTrim` config
   against the baseline~~ — done, passed.
4. ~~Push to GitHub~~ — done (`LX-ComfyUI/hyperion.ng-color-fork`).
5. ~~Run against real hardware~~ — done, core Hyperion functionality
   confirmed healthy; PSU control + flicker monitor integration explicitly
   deferred.
6. Watch the live-hardware run for stability over time, including a TV-pause
   cycle (known past flicker trigger, see
   [[hyperion-flicker-2026-09-15]]) — not yet observed against the fork.
7. Add a minimal control point + gray-axis trim config reproducing the
   concrete/green fix without the global-anchor side effect on real greens,
   validate against the same video source used to find the original bug.
8. Extend the web-config UI panel for the new schema sections.
9. Reconnect PSU control + flicker monitor (see deferred gap above) — decide
   whether to adapt the scripts to work against a bare fork process, or to
   make the fork assume the `hyperion@alexo` unit identity.
10. Only then consider making the fork the permanent, reboot-safe service.
