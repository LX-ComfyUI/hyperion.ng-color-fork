#include <cmath>
#include <algorithm>

#include <utils/ColorControlPointTransform.h>
#include <utils/ColorSys.h>

namespace
{
	inline double clamp01(double value)
	{
		return std::max(0.0, std::min(value, 1.0));
	}

	inline uint8_t toByte(double value)
	{
		return static_cast<uint8_t>(std::lround(clamp01(value) * 255.0));
	}
}

double ColorControlPointTransform::circularDistance(double hue, double center)
{
	double d = hue - center;
	d -= std::floor(d + 0.5); // wrap into [-0.5, 0.5]
	return d;
}

double ColorControlPointTransform::falloffWeight(double distance, double influence)
{
	if (influence <= 0.0)
	{
		return 0.0;
	}
	const double a = std::fabs(distance) / influence;
	if (a >= 1.0)
	{
		return 0.0;
	}
	// raised cosine: 1 at a=0, 0 at a=1, smooth in between
	return 0.5 * (1.0 + std::cos(a * M_PI));
}

void ColorControlPointTransform::apply(uint8_t & red, uint8_t & green, uint8_t & blue,
                                        const QVector<ColorControlPoint> & points,
                                        QVector<ColorControlPointGateState> & gateStates,
                                        const GrayAxisTrim & trim)
{
	if (points.isEmpty() && !trim.enabled)
	{
		return;
	}

	double hue, saturation, value;
	ColorSys::rgb2okhsv(red, green, blue, hue, saturation, value);

	if (trim.enabled && saturation < trim.saturationThreshold)
	{
		// Near-neutral pixel: correct sensor/white-balance tint directly in
		// RGB and skip the hue-anchor system entirely -- this is the
		// "don't let a saturated hue anchor also govern gray pixels" fix
		// from DESIGN.md item 4/5.
		red   = static_cast<uint8_t>(std::lround(std::min(255.0, red   * trim.gainRed)));
		green = static_cast<uint8_t>(std::lround(std::min(255.0, green * trim.gainGreen)));
		blue  = static_cast<uint8_t>(std::lround(std::min(255.0, blue  * trim.gainBlue)));
		return;
	}

	if (points.isEmpty())
	{
		return;
	}

	// Find the nearest control point whose influence window covers this hue.
	int bestIdx = -1;
	double bestWeight = 0.0;
	double bestDistance = 0.0;
	for (int i = 0; i < points.size(); ++i)
	{
		if (!points[i].enabled)
		{
			continue;
		}
		const double d = circularDistance(hue, points[i].hue);
		const double w = falloffWeight(d, points[i].influence);
		if (w > bestWeight)
		{
			bestWeight = w;
			bestIdx = i;
			bestDistance = d;
		}
	}

	if (bestIdx < 0)
	{
		return;
	}
	(void) bestDistance;

	const ColorControlPoint & point = points[bestIdx];

	// Per-point gamma, blended toward identity (gamma 1.0) at the window edge.
	if (point.gamma != 1.0)
	{
		const double blendedGamma = 1.0 + (point.gamma - 1.0) * bestWeight;
		value = clamp01(std::pow(value, 1.0 / blendedGamma));
	}

	// Luma gate: hysteresis + debounce against `value` (0-1 -> 0-255 scale).
	LumaGateMode effectiveMode = LumaGateMode::HUE_SHIFT; // "not gated" == normal shift below
	bool gated = false;
	if (point.lumaGate.enabled && bestIdx < gateStates.size())
	{
		ColorControlPointGateState & state = gateStates[bestIdx];
		const uint8_t byteValue = toByte(value);
		const bool wantsActive = state.active
			? (byteValue < point.lumaGate.releaseAbove)   // stay active until we clear the release threshold
			: (byteValue < point.lumaGate.triggerBelow);  // become active once under the trigger threshold

		if (wantsActive == state.active)
		{
			state.consecutiveFrames = 0;
		}
		else
		{
			++state.consecutiveFrames;
			if (state.consecutiveFrames >= point.lumaGate.debounceFrames)
			{
				state.active = wantsActive;
				state.consecutiveFrames = 0;
			}
		}

		gated = state.active;
		effectiveMode = point.lumaGate.mode;
	}

	if (gated)
	{
		switch (effectiveMode)
		{
		case LumaGateMode::OFF:
			red = green = blue = 0;
			return;
		case LumaGateMode::MIN_BRIGHTNESS:
			value = std::min(value, point.lumaGate.minBrightness / 255.0);
			break;
		case LumaGateMode::HUE_SHIFT:
			hue = hue + point.lumaGate.gatedHueShift * bestWeight;
			hue -= std::floor(hue);
			break;
		}
	}
	else
	{
		// Normal (non-gated) target shift, blended by influence weight.
		hue = hue + point.targetHueShift * bestWeight;
		hue -= std::floor(hue);
		saturation = clamp01(saturation * (1.0 + (point.targetSaturationGain - 1.0) * bestWeight));
	}

	ColorSys::okhsv2rgb(hue, saturation, value, red, green, blue);
}
