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
	settings.brightnessSoftZone      = s["brightnessSoftZone"].toInt(20);
	settings.hueToleranceDegrees     = s["hueToleranceDegrees"].toInt(30);
	settings.saturationThreshold     = s["saturationThreshold"].toDouble(0.15);
	settings.maxAffectedRatioPercent = s["maxAffectedRatioPercent"].toInt(15);
	settings.debounceFrames          = s["debounceFrames"].toInt(15);
	settings.fadeFrames              = s["fadeFrames"].toInt(10);

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

	// Brightness is no longer a single hard cutoff: a LED's suppression
	// weight ramps linearly from 1 at/below brightnessLowerEdge to 0 at/above
	// brightnessUpperEdge, instead of snapping between "candidate" and "not"
	// at one exact value. brightnessSoftZone==0 reproduces the old hard cut.
	const double brightnessUpperEdge = clamp01(_settings.brightnessThreshold / 255.0);
	const double brightnessLowerEdge = clamp01((_settings.brightnessThreshold - _settings.brightnessSoftZone) / 255.0);
	const double brightnessRampSpan = std::max(brightnessUpperEdge - brightnessLowerEdge, 1.0 / 255.0);

	// Pass 1: determine per-LED candidacy/brightness weight and count
	// candidates, without touching any color yet -- the global ratio gate
	// below needs the full-frame count before any suppression decision can
	// be made.
	QVector<bool> candidate(ledColors.size(), false);
	QVector<double> brightnessWeight(ledColors.size(), 0.0);
	int candidateCount = 0;

	for (int i = 0; i < ledColors.size(); ++i)
	{
		const ColorRgb& c = ledColors[i];
		double hue, saturation, value;
		ColorSys::rgb2okhsv(c.red, c.green, c.blue, hue, saturation, value);

		const bool hueSatMatch = saturation >= _settings.saturationThreshold
			&& std::fabs(circularHueDistance(hue, targetHue)) <= toleranceTurns;

		const double weight = hueSatMatch
			? clamp01((brightnessUpperEdge - value) / brightnessRampSpan)
			: 0.0;

		brightnessWeight[i] = weight;

		const bool isCandidate = weight > 0.0;
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

	// Pass 2: debounce each LED's candidacy into a stable armed/disarmed
	// state (unchanged purpose -- ignore brief noise blips before even
	// starting a fade), then ease the actually-applied strength towards its
	// target over fadeFrames instead of snapping straight to fully
	// suppressed/restored.
	const double maxStepPerFrame = 1.0 / std::max(_settings.fadeFrames, 1);

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

		const double targetWeight = state.suppressed ? brightnessWeight[i] : 0.0;
		const double delta = targetWeight - state.currentWeight;
		if (std::fabs(delta) <= maxStepPerFrame)
		{
			state.currentWeight = targetWeight;
		}
		else
		{
			state.currentWeight += (delta > 0.0 ? maxStepPerFrame : -maxStepPerFrame);
		}

		if (state.currentWeight > 0.0)
		{
			const ColorRgb& c = ledColors[i];
			const double w = state.currentWeight;
			ledColors[i] = ColorRgb(
				static_cast<uint8_t>(c.red   * (1.0 - w)),
				static_cast<uint8_t>(c.green * (1.0 - w)),
				static_cast<uint8_t>(c.blue  * (1.0 - w)));
		}
	}
}
