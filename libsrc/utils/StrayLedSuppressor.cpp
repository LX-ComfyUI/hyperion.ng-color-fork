#include <cmath>
#include <algorithm>

#include <QJsonArray>

#include <utils/StrayLedSuppressor.h>
#include <utils/ColorSys.h>

namespace
{
	inline double clamp01(double value)
	{
		return std::max(0.0, std::min(value, 1.0));
	}

	/// Shortest signed circular distance from `hue` to `center`, turns in [-0.5, 0.5].
	inline double circularHueDistance(double hue, double center)
	{
		double d = hue - center;
		d -= std::floor(d + 0.5);
		return d;
	}
}

StrayLedSuppressorSettings createStrayLedSuppressorSettings(const QJsonObject& deviceConfig)
{
	StrayLedSuppressorSettings settings;
	const QJsonObject s = deviceConfig["strayLedSuppressor"].toObject();

	settings.enabled                 = s["enabled"].toBool(false);
	settings.brightnessThreshold     = s["brightnessThreshold"].toInt(30);
	settings.hueToleranceDegrees     = s["hueToleranceDegrees"].toInt(30);
	settings.saturationThreshold     = s["saturationThreshold"].toDouble(0.15);
	settings.maxAffectedRatioPercent = s["maxAffectedRatioPercent"].toInt(15);
	settings.debounceFrames          = s["debounceFrames"].toInt(15);

	const QJsonArray colorArray = s["targetColor"].toArray();
	settings.targetColor = ColorRgb(
		static_cast<uint8_t>(colorArray.size() > 0 ? colorArray[0].toInt(255) : 255),
		static_cast<uint8_t>(colorArray.size() > 1 ? colorArray[1].toInt(0) : 0),
		static_cast<uint8_t>(colorArray.size() > 2 ? colorArray[2].toInt(0) : 0)
	);

	return settings;
}

void StrayLedSuppressor::configure(const StrayLedSuppressorSettings& settings)
{
	_settings = settings;
}

void StrayLedSuppressor::apply(QVector<ColorRgb>& ledColors)
{
	if (!_settings.enabled || ledColors.isEmpty())
	{
		return;
	}

	if (_state.size() != ledColors.size())
	{
		_state.fill(LedState{}, ledColors.size());
	}

	double targetHue, targetSaturation, targetValue;
	ColorSys::rgb2okhsv(_settings.targetColor.red, _settings.targetColor.green, _settings.targetColor.blue,
		targetHue, targetSaturation, targetValue);
	(void) targetSaturation;
	(void) targetValue;

	const double toleranceTurns = clamp01(_settings.hueToleranceDegrees / 360.0);
	const double brightnessLimit = clamp01(_settings.brightnessThreshold / 255.0);

	// Pass 1: determine per-LED candidacy and count it, without touching
	// any color yet -- the global ratio gate below needs the full-frame
	// count before any suppression decision can be made.
	QVector<bool> candidate(ledColors.size(), false);
	int candidateCount = 0;

	for (int i = 0; i < ledColors.size(); ++i)
	{
		const ColorRgb& c = ledColors[i];
		double hue, saturation, value;
		ColorSys::rgb2okhsv(c.red, c.green, c.blue, hue, saturation, value);

		const bool isCandidate = value <= brightnessLimit
			&& saturation >= _settings.saturationThreshold
			&& std::fabs(circularHueDistance(hue, targetHue)) <= toleranceTurns;

		candidate[i] = isCandidate;
		if (isCandidate)
		{
			++candidateCount;
		}
	}

	// Global gate: an intentionally widespread scene in the target color
	// (e.g. a dark red tail-light shot) must pass through untouched, not
	// be mistaken for scattered stray light.
	const double maxRatio = clamp01(_settings.maxAffectedRatioPercent / 100.0);
	const bool globalGateOpen = candidateCount <= maxRatio * ledColors.size();

	// Pass 2: debounce each LED's candidacy into a stable suppressed/normal
	// state, then apply it.
	for (int i = 0; i < ledColors.size(); ++i)
	{
		const bool wantsSuppressed = globalGateOpen && candidate[i];
		LedState& state = _state[i];

		if (wantsSuppressed == state.suppressed)
		{
			state.consecutiveFrames = 0;
		}
		else
		{
			++state.consecutiveFrames;
			if (state.consecutiveFrames >= _settings.debounceFrames)
			{
				state.suppressed = wantsSuppressed;
				state.consecutiveFrames = 0;
			}
		}

		if (state.suppressed)
		{
			ledColors[i] = ColorRgb::BLACK;
		}
	}
}
