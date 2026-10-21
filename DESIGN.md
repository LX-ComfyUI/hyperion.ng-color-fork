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
that has since moved on.

**Removed 2026-10-19, per explicit request:** three later fork features were
taken out completely — code, schema, defaults, stored settings, i18n, WebUI
and the TV test page:

- **Gray-axis trim** (`grayAxisTrim` per color profile, "Grauachsen-Korrektur"):
  saturation-gated RGB gains for near-neutral pixels, the same for every
  brightness. Superseded by the **gray curve** (`grayCurve`, channel factors
  per brightness for grays) and the **grabber color correction** (3x3 matrix
  per grabber model, see `GrabberColorCorrection` in `VideoProbe.h`), which
  fixes the capture chain's color error at its source.
- **Edge transition boost** (`edgeTransitionBoost`, "Bereichsübergangsverstärkung"):
  brightened the last 1-3 LEDs on the bright side of a sharp bright/dark edge.
  Never kept on; the LED capture depth and the fractional LED mean handle
  edges better.
- **Stray LED suppressor** (device `strayLedSuppressor`, "Störlicht-Filter"):
  dimmed isolated faint, wrongly colored (mostly dark red) LEDs in black
  scenes. Its cause is gone: the current grabber delivers black as 0 without
  noise, and the 16-bit black threshold (`blackThreshold`) switches off what
  is left; the filter could also dim genuine dark red content.

All three were off in the live configuration when they were removed. The
last commit that still contains them is `21e9211d`; restoring one means
bringing back its files and schema entries from there (see
[[hyperion-fork-schema-change-gotcha]] for the stored settings).

**Replaced 2026-10-21: "No Signal" still image detection.** The upstream
threshold signal detection (`grabberV4L2.signalDetection`, color thresholds,
area offsets, frame counter) only recognized a dark area and failed with
capture cards that show their own "No Signal" picture (text, logo, serial
number). It is gone from the schema, defaults, stored settings, i18n and the
LED preview overlay; its code in `V4L2Grabber` stays only for the standalone
`hyperion-v4l2` tool (off in `hyperiond`). Its replacement, `NoSignalDetector`
(`include/utils/NoSignalDetector.h`), learns the card's no-signal picture once
(calibration over 3 s, grid of 64x36 cell means of the frame as decoded, cells
that move are ignored) and checks every frame against it. A frame matches when
the share of matching cells reaches the minimum both over all cells and over
the bright "feature" cells (the text); a dark film scene matches the black
background but not the text, so it does not count. After the delay the
detection releases the capture input (next source or LEDs off), sends black,
or only reports. Settings and up to three calibrations per grabber model live
in `grabberTest.noSignal`; the WebUI (USB capture panel) and the TV test page
share `nosignal-ui.js`. JSON-API: `grabbertest` with `nosignal` =
`status` | `calibrate` | `calibration`.

## Flicker safety (critical constraint)

This Hyperion install has hard-won flicker fixes (star grounding, SPI clock
rate tuning — see the project's `hyperion-good-state-2026-09-16-1mhz` /
`hyperion-flicker-*` history). Every fork transform that depends on the
picture content must therefore blend smoothly instead of switching at a hard
threshold: noise around a boundary would otherwise toggle the result frame to
frame. The gray curve, for example, fades out with rising saturation
(`saturationLimit`) instead of cutting off.

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
