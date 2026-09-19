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

**Removed 2026-09-19, per explicit request:** the arbitrary hue
control-point system (former features 1-3: free hue anchors, per-anchor
gamma, brightness-gated luma-gate color shift) and the "(Not yet designed)
smarter source-side classification" idea that built on it (former feature
5) were deliberately torn out of the fork entirely — code, schema, i18n,
WebUI. The user's own words: *"lass uns die Erweiterte Farbkalibrierung
(Fork-Erweiterung) komplett entfernen ... lass sie komplett entfernen aus
dem fork"*. The full pre-removal state (structs, transform logic, schema,
WebUI panel, `huePicker`/`turnsPercent` JSONEditor formats) is preserved at
git tag `archive/extended-color-calibration-controlpoints` (last commit
`517ae806`) for reference or restoration; see
[[hyperion-fork-schema-change-gotcha]] before restoring it against a config
that has since moved on. Everything below describes the fork as it exists
after that removal — only the gray-axis trim remains.

**Independent gray-axis / white-balance trim** — the concrete/green defect
described in Motivation above is a white-balance problem (a
low-saturation/neutral-axis tint from the capture sensor), not a
hue-mapping problem; routing the fix through a saturated hue anchor (the
removed control-point system) was a workaround with real side effects on
genuine saturated greens. `GrayAxisTrim` corrects only near-neutral,
low-chroma pixels directly in RGB, never touching saturated colors.

**Staged gray-axis gain ("Grauachsen-Stufen")** — the trim's original
single `saturationThreshold`/`gainRed/Green/Blue` quartet only allowed one
gain for the whole near-neutral band. Real captures often need different
corrections at different shades of near-gray (e.g. true black-level noise
vs. a slightly warmer dark gray a bit further out on the saturation axis).
It's driven by an ordered list of `GrayAxisTrimStop` entries
(`saturationUpTo`, `gainRed/Green/Blue`), each an anchor point on a
piecewise-linear gain curve over saturation — see `GrayAxisTrimStop` in
Architecture below. Deliberately a smooth ramp between stops, not a flat
staircase: a hard step at a band boundary reproduces the exact flicker bug
the single-threshold version had before its own smoothing fix (commit
`a6c62488`).
`hyperion::createGrayAxisTrim` sorts stops ascending defensively
server-side regardless of input order, but `content_colors.js` also
actively *enforces* strictly-ascending `saturationUpTo` in the WebUI itself
(blocking warning + disabled Speichern-button on violation, offending rows
outlined) — a user was able to enter stop 1 with a higher `saturationUpTo`
than stop 2 and only notice the visual list order didn't match the applied
curve, so relying on the silent server-side sort alone was confusing and
got upgraded to a hard UI block.

## Architecture

- **`GrayAxisTrim`** (`include/utils/GrayAxisTrim.h`) — independent
  near-neutral RGB gain correction. Driven by an ordered
  `QVector<GrayAxisTrimStop>` (`saturationUpTo`, `gainRed/Green/Blue`), the
  "Grauachsen-Stufen" staged gain curve.
- **`GrayAxisTrimStop`** — one Stuetzstelle of the trim's staged gain curve:
  flat at the first stop's gain from saturation 0 up to its `saturationUpTo`;
  linearly blended between two consecutive stops across the saturation span
  between them; no effect above the last stop's `saturationUpTo` (saturated
  colors always stay untouched). `hyperion::createGrayAxisTrim` sorts the
  vector ascending by `saturationUpTo` once at config-parse time, so the
  per-pixel transform never re-sorts.
- **`GrayAxisTrimTransform`** (`libsrc/utils/GrayAxisTrimTransform.cpp`) —
  the engine. Operates per-pixel in Okhsv space (`ColorSys::rgb2okhsv`) just
  to read the pixel's saturation; the actual correction is a per-channel RGB
  multiply, no re-encode through `okhsv2rgb` needed. Skips pixels above the
  last stop's `saturationUpTo` entirely, leaving them byte-identical to
  stock Hyperion.

## Integration into stock Hyperion

- `ColorAdjustment` (`include/hyperion/ColorAdjustment.h`) gained
  `_grayAxisTrim`.
- `hyperion::createColorAdjustment` (`include/utils/hyperion.h`) parses the
  `grayAxisTrim` JSON key from the color adjustment config, defaulting to
  disabled — **when absent/disabled, this profile is byte-identical to
  stock Hyperion.**
- `MultiColorAdjustment::applyAdjustment` calls
  `GrayAxisTrimTransform::apply(...)` right after `_okhsvTransform` and
  before `_rgbTransform.applyGamma`, i.e. after the existing global HSV
  saturation/value transform but before the final gamma/brightness-component
  split.
- `libsrc/hyperion/schema/schema-color.json` exposes `grayAxisTrim` as a
  JSON-schema object.
- `assets/webconfig/i18n/{de,en}.json` has full title+description text for
  every field; `content_colors.js` builds a dedicated WebUI panel (own
  Stufen list with add/remove rows, live tooltips, and the ascending-order
  enforcement described above) — not just the raw JSON editor.

## Flicker safety (critical constraint)

This Hyperion install has hard-won flicker fixes (star grounding, SPI clock
rate tuning — see the project's `hyperion-good-state-2026-09-16-1mhz` /
`hyperion-flicker-*` history). `GrayAxisTrim`'s staged gain curve is
designed around that constraint: a hard on/off or stop-to-stop step would
itself be a flicker source, since saturation noise hovering around a
boundary would toggle the correction frame to frame. That's why every
transition — the original single-threshold cutoff *and* every boundary
between `GrayAxisTrimStop` entries — is a smooth blend
(`GrayAxisTrimTransform::apply`), never a hard switch. See "Staged gray-axis
gain" above for the concrete mechanism and its commit history.

## Edge transition boost (added 2026-09-19)

Independent fork feature, added under "Bildverarbeitung" right after the
gray-axis trim on the WebUI's Farbe page: **`EdgeTransitionBoost`**
(`include/utils/EdgeTransitionBoost.h` +
`EdgeTransitionBoostTransform.h`/`.cpp`) brightens the last 1-3 LEDs on the
bright side of a sharp brightness edge along the LED strip (e.g. a
saturated object against a dark/black background), where the mapped camera
pixels often carry too little clean color, producing a dull or slightly
dark-reddish edge.

**Architecturally distinct from `GrayAxisTrim`/the removed control-point
system**: those operate per-pixel in isolation (Okhsv saturation of a
single LED's own color). This needs the *spatial neighbors* along the
strip to find brightness edges, so it cannot live inside `ColorAdjustment`
(a per-profile, per-pixel struct). Instead it's a single
`EdgeTransitionBoost` member on `MultiColorAdjustment` itself, parsed from
a new top-level `edgeTransitionBoost` property in `schema-color.json`
(sibling of `channelAdjustment`, not nested inside it), and applied as a
whole-array second pass at the end of `MultiColorAdjustment::
applyAdjustment()`, after every LED's per-profile color adjustment (gamma,
gray-axis trim, channel adjustment) has already run. No wraparound: LED 0
and the last LED are never treated as neighbors, since most physical
layouts (unlike this specific room-perimeter install) are not closed
loops.

**Math, same anti-flicker doctrine as the gray-axis trim:**
- Edge detection is stepless, not a hard threshold: `edgeStrength =
  clamp01(|drop| / edgeSensitivity)` where `drop` is the brightness
  (`max(R,G,B)`) difference between two adjacent LEDs. A hard cutoff here
  would reproduce the exact class of flicker bug already fixed once for
  `GrayAxisTrim`.
- Spatial falloff across `ledWidth` reuses the same raised-cosine shape
  the (now-removed) control-point system used for its hue-influence
  windows.
- When a LED sits near more than one qualifying edge, the *strongest*
  weight wins, not a sum — same "don't blend competing effects" principle
  documented above for control points.
- Brightening uses a "screen" blend (`value + (255-value) * intensity`)
  per channel instead of a multiplicative gain: self-limiting by
  construction (can't overflow/clip), gives large absolute lift to dark
  LEDs and very little to already-bright ones, so bright scenes can't blow
  out at boosted edges.

Performance: one read-only O(n) pass building a per-LED weight buffer,
capped at `ledWidth` (max 3) neighbor writes per detected edge, then one
O(n) apply pass — negligible relative to typical LED counts (~600-650 on
this install) at real-time frame rates. Allocates one `QVector<double>`
scratch buffer per frame; not pooled/reused, since profiling never showed
a need to.

## Stray LED suppressor (added 2026-09-19)

Post-processing filter, architecturally distinct from every other fork
feature so far: instead of sitting in the color-adjustment pipeline, it
runs as the *very last* step before LED values reach the hardware, device-
agnostic, in `LedDevice` itself (`include/utils/StrayLedSuppressor.h` +
`libsrc/utils/StrayLedSuppressor.cpp`, applied in
`LedDevice::updateLeds()` right after the incoming values are copied into
`_ledUpdateBuffer`, before `write()` is ever called). Settings live in
`schema-device.json` (sibling of `hardwareLedCount`/`colorOrder`/...), so
they show up on the WebUI's LED-hardware page using that page's existing
`options.infoText` tooltip mechanism, not the fork's own custom hover-icon
system used on the Farbe page (`content_leds.js` needed zero changes).

**Problem it solves**: isolated LEDs glowing faintly in a wrong color
(typically dark red) in scenes that should render fully black — sensor/
quantization noise near black, not real content.

**Detection** (Okhsv per LED, `ColorSys::rgb2okhsv`): a candidate is a LED
whose value is at/below `brightnessThreshold`, saturation at/above
`saturationThreshold`, and hue within `hueToleranceDegrees` of
`targetColor`'s hue.

**Global ratio gate**: candidates are counted once per frame; if more than
`maxAffectedRatioPercent` of all LEDs qualify, the filter is skipped
entirely for that frame. Cheap (one O(n) counting pass, no spatial
clustering/connected-components needed) and sufficient to tell "a handful
of scattered stray pixels" apart from "an intentional, widespread dark-red
scene" (e.g. tail lights) without ever touching the latter.

**Debounce**: per-LED persistent state (`suppressed` + `consecutiveFrames`
counter, `QVector<LedState>` owned by the `StrayLedSuppressor` instance,
resized lazily on first use / LED-count change) — mirrors the
hysteresis+debounce pattern the fork's removed `LumaGate` used, just
symmetric (`debounceFrames` applies to entering and leaving suppression
alike, no separate trigger/release values) since the underlying condition
here is already a single combined candidate test, not two independent
thresholds.

**Action**: full off (R=G=B=0) only, deliberately not a selective single-
channel zero — a stray dark-red LED is almost always broadband near-black
noise, not "correct G/B with a wrong R channel"; zeroing only R would
likely leave a dim, oddly cyan-tinted glow instead of true black.

## Fork maintenance cost (accepted tradeoff)

No more `apt upgrade` for Hyperion once this ships — self-build and
self-maintain, no automatic upstream bugfixes/security patches, future
upstream releases must be manually merged against this patch. Building on the
Pi 5 itself is feasible but slow (CMake/Qt5 + vendored deps like abseil/
protobuf/mbedtls from scratch: 30-60+ minutes).

## Status as of 2026-09-16

> **This section is a frozen historical snapshot from the fork's first
> implementation session and is known stale** — it predates the
> control-point/luma-gate removal (2026-09-19, see "Requested features"
> above), the staged gray-axis gain work, and the gray-still-image
> detector. Items below mentioning `controlPoints`/`LumaGate` as "not yet
> built" are obsolete, not open — that system was built, then removed
> entirely. For current status, check the project's memory notes
> ([[hyperion-fork-idea]] and linked entries) rather than this section.


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
