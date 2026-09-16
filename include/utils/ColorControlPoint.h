#pragma once

#include <cstdint>
#include <QString>

///
/// What a control point's luma gate switches to once triggered.
///
enum class LumaGateMode
{
	OFF,            ///< force brightness to (near) zero
	MIN_BRIGHTNESS, ///< clamp brightness to a configured floor, keep hue/sat
	HUE_SHIFT       ///< redirect to a different target hue while gated
};

///
/// One brightness-gated color point (fork feature 3, see DESIGN.md).
/// Below `triggerBelow` (for `debounceFrames` consecutive frames) the point's
/// normal target is replaced by `mode`. Above `releaseAbove` (again for
/// `debounceFrames` frames) it releases back to normal. `releaseAbove` must
/// be >= `triggerBelow`; the gap between them is the hysteresis band that
/// keeps compression/noise near the threshold from flapping the gate frame
/// to frame -- this was flagged as a required safeguard in DESIGN.md given
/// the flicker fixes this Hyperion install already depends on.
///
struct LumaGate
{
	bool enabled = false;
	uint8_t triggerBelow = 0;   ///< value (0-255) below which the gate wants to trigger
	uint8_t releaseAbove = 0;   ///< value (0-255) above which the gate wants to release
	uint8_t debounceFrames = 3; ///< consecutive frames required before switching state
	LumaGateMode mode = LumaGateMode::MIN_BRIGHTNESS;
	double gatedHueShift = 0.0;      ///< used when mode == HUE_SHIFT, turns [0,1)
	uint8_t minBrightness = 0;       ///< used when mode == MIN_BRIGHTNESS, 0-255
};

///
/// A single arbitrary hue control point (fork features 1 + 2, see DESIGN.md).
/// Replaces the fixed 6-anchor RgbChannelAdjustment model with a free list:
/// any number of points, each with its own influence window, hue/saturation
/// retarget, and its own gamma -- instead of 6 fixed anchors sharing 3
/// global RGB gammas.
///
struct ColorControlPoint
{
	QString id;

	/// Master on/off switch for this point. When false, the point is skipped
	/// entirely during nearest-point matching, as if it weren't in the list.
	bool enabled = true;

	/// Hue center this point is anchored to, turns in [0.0, 1.0) matching
	/// ColorSys::rgb2okhsv's hue convention.
	double hue = 0.0;

	/// Half-width, in turns, of the falloff window around `hue`. Pixels
	/// further than `influence` from `hue` (shortest circular distance)
	/// are untouched by this point. Within the window, effect strength
	/// eases out to 0 at the edge (raised-cosine) so points don't produce
	/// a hard seam.
	double influence = 1.0 / 12.0; // 30 degrees

	/// Additive hue shift applied at full strength (turns, wraps).
	double targetHueShift = 0.0;
	/// Multiplicative saturation gain applied at full strength.
	double targetSaturationGain = 1.0;

	/// Per-point gamma applied to the value/brightness channel, blended by
	/// this point's falloff weight against no correction (gamma == 1) at
	/// the influence edge. Independent of RgbTransform's global
	/// gammaRed/Green/Blue.
	double gamma = 1.0;

	/// Per-point linear brightness gain, applied to the value/brightness
	/// channel after `gamma` and blended by the same falloff weight.
	/// Distinct from `gamma` (a curve): this is a plain multiplier, mirroring
	/// OkhsvTransform's profile-wide brightnessGain but scoped to this point.
	double brightnessGain = 1.0;

	LumaGate lumaGate;
};

///
/// Independent, saturation-gated gray-axis / white-balance trim (fork
/// feature 4, see DESIGN.md). Applied to near-neutral pixels *before* the
/// ColorControlPoint pass so low-chroma pixels (e.g. concrete/asphalt under
/// a tinted capture sensor) are corrected without competing with, or being
/// dragged around by, the saturated hue anchors above.
///
struct GrayAxisTrim
{
	bool enabled = false;

	/// Okhsv saturation (0-1) below which a pixel is considered "near
	/// neutral" and eligible for this trim.
	double saturationThreshold = 0.12;

	/// Multiplicative per-channel gain applied to eligible pixels.
	double gainRed = 1.0;
	double gainGreen = 1.0;
	double gainBlue = 1.0;
};
