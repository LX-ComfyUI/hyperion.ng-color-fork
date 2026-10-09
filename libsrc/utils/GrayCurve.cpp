#include <algorithm>

#include <utils/GrayCurve.h>
#include <utils/ColorSys.h>

bool GrayCurveTransform::gains(const GrayCurve& curve, uint8_t red, uint8_t green, uint8_t blue,
                               float& gainRed, float& gainGreen, float& gainBlue)
{
	gainRed = gainGreen = gainBlue = 1.0F;
	if (!curve.enabled || curve.points.isEmpty() || curve.saturationLimit <= 0.0)
	{
		return false;
	}

	// black stays black, and Okhsv has no saturation for it (NaN, which would turn the factors into
	// NaN and the precise output into full white)
	if (red == 0 && green == 0 && blue == 0)
	{
		return false;
	}

	// only near-neutral colors: full effect at saturation 0, none at saturationLimit
	double hue = 0.0;
	double saturation = 0.0;
	double value = 0.0;
	ColorSys::rgb2okhsv(red, green, blue, hue, saturation, value);
	const double weight = 1.0 - std::clamp(saturation / curve.saturationLimit, 0.0, 1.0);
	if (!(weight > 0.0))
	{
		return false;
	}

	// brightness of the input in percent, the same scale as the points
	const double level = std::max({ red, green, blue }) * 100.0 / 255.0;

	const QVector<GrayCurvePoint>& points = curve.points;
	double r = points.first().gainRed;
	double g = points.first().gainGreen;
	double b = points.first().gainBlue;
	if (level >= points.last().level)
	{
		r = points.last().gainRed;
		g = points.last().gainGreen;
		b = points.last().gainBlue;
	}
	else if (level > points.first().level)
	{
		for (int i = 0; i + 1 < points.size(); ++i)
		{
			const GrayCurvePoint& lower = points[i];
			const GrayCurvePoint& upper = points[i + 1];
			if (level <= upper.level)
			{
				const double span = upper.level - lower.level;
				const double t = span > 0.0 ? (level - lower.level) / span : 1.0;
				r = lower.gainRed   + (upper.gainRed   - lower.gainRed)   * t;
				g = lower.gainGreen + (upper.gainGreen - lower.gainGreen) * t;
				b = lower.gainBlue  + (upper.gainBlue  - lower.gainBlue)  * t;
				break;
			}
		}
	}

	gainRed   = static_cast<float>(1.0 + weight * (r - 1.0));
	gainGreen = static_cast<float>(1.0 + weight * (g - 1.0));
	gainBlue  = static_cast<float>(1.0 + weight * (b - 1.0));
	return true;
}
