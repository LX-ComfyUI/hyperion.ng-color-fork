#pragma once

#include <QJsonObject>
#include <QVector>

#include <utils/ColorRgb.h>

///
/// Fork extension: settings for the "Stray LED Suppressor" ("Post-
/// Processing Stoerlicht-Filter"). Suppresses isolated LEDs that end up
/// showing a faint, wrongly-colored glow (typically a dark red) in scenes
/// that should render as black -- sensor/quantization noise near black
/// rather than intentional content. See StrayLedSuppressor for the engine.
///
struct StrayLedSuppressorSettings
{
	bool enabled = false;

	/// The stray color to watch for, e.g. red.
	ColorRgb targetColor = ColorRgb::RED;

	/// A LED must be at or below this brightness (Okhsv value, 0-255 scale)
	/// to be a suppression candidate.
	int brightnessThreshold = 30;

	/// Maximum circular hue distance (degrees, 0-180) from targetColor's hue
	/// for a LED to still count as matching the stray color.
	int hueToleranceDegrees = 30;

	/// Minimum Okhsv saturation (0.0-1.0) for a LED to count as "colored"
	/// stray light rather than plain neutral near-black.
	double saturationThreshold = 0.15;

	/// If more than this percentage (1-100) of all LEDs are candidates in a
	/// given frame, the whole filter is skipped for that frame -- an
	/// intentionally widespread dark scene in the target color (e.g. a dark
	/// red tail-light shot) must pass through untouched.
	int maxAffectedRatioPercent = 15;

	/// How many consecutive frames a LED's desired suppression state must
	/// hold before it actually flips, in either direction. 0-60; 0 reacts
	/// immediately (no flicker protection), higher values trade
	/// responsiveness for stability.
	int debounceFrames = 15;
};

StrayLedSuppressorSettings createStrayLedSuppressorSettings(const QJsonObject& deviceConfig);

///
/// Stateful engine for StrayLedSuppressorSettings. Owns a small persistent
/// per-LED debounce state (mirrors the hysteresis+debounce pattern
/// previously used by the fork's removed LumaGate feature) so a candidate
/// LED's suppression status only flips after `debounceFrames` consecutive
/// frames of the same desired state, not on every frame a threshold is
/// crossed.
///
class StrayLedSuppressor
{
public:
	void configure(const StrayLedSuppressorSettings& settings);

	///
	/// Apply suppression (if enabled) to the given LED colors, in place.
	/// Intended to run as the very last step before the colors reach
	/// LedDevice::write(), after all image processing and smoothing.
	///
	void apply(QVector<ColorRgb>& ledColors);

private:
	struct LedState
	{
		bool suppressed = false;
		uint8_t consecutiveFrames = 0;
	};

	StrayLedSuppressorSettings _settings;
	QVector<LedState> _state;
};
