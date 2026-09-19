#include <cmath>
#include <algorithm>

#include <utils/GrayAxisTrimTransform.h>
#include <utils/ColorSys.h>

namespace
{
	inline double clamp01(double value)
	{
		return std::max(0.0, std::min(value, 1.0));
	}
}

void GrayAxisTrimTransform::apply(uint8_t & red, uint8_t & green, uint8_t & blue,
                                   const GrayAxisTrim & trim)
{
	if (!trim.enabled || trim.stops.isEmpty())
	{
		return;
	}

	double hue, saturation, value;
	ColorSys::rgb2okhsv(red, green, blue, hue, saturation, value);
	(void) hue;
	(void) value;

	if (saturation > trim.stops.last().saturationUpTo)
	{
		// Strongly saturated pixel: outside the trim's range entirely, leave
		// it fully untouched.
		return;
	}

	// Near-neutral pixel: correct sensor/white-balance tint directly in RGB.
	//
	// `trim.stops` is a staged gain curve (fork feature 4b,
	// "Grauachsen-Stufen"), pre-sorted ascending by `saturationUpTo` at
	// config-parse time: flat at the first stop's gain from saturation 0 up
	// to its `saturationUpTo`, then linearly blended between each pair of
	// consecutive stops across the span between them. This is a deliberate
	// ramp, not a flat staircase -- a hard step at a band boundary
	// reproduces the exact flicker bug that the old single-threshold cutoff
	// had (saturation noise hovering around a boundary toggles the
	// correction frame to frame). Above the last stop's `saturationUpTo`
	// (guarded above) strongly saturated colors stay completely untouched.
	const GrayAxisTrimStop * lower = &trim.stops.first();
	const GrayAxisTrimStop * upper = &trim.stops.first();
	for (int i = 0; i + 1 < trim.stops.size(); ++i)
	{
		if (saturation <= trim.stops[i].saturationUpTo)
		{
			break;
		}
		lower = &trim.stops[i];
		upper = &trim.stops[i + 1];
	}

	double t = 0.0;
	if (lower != upper)
	{
		const double span = upper->saturationUpTo - lower->saturationUpTo;
		t = (span > 0.0) ? clamp01((saturation - lower->saturationUpTo) / span) : 1.0;
	}
	const double scaleRed   = lower->gainRed   + (upper->gainRed   - lower->gainRed)   * t;
	const double scaleGreen = lower->gainGreen + (upper->gainGreen - lower->gainGreen) * t;
	const double scaleBlue  = lower->gainBlue  + (upper->gainBlue  - lower->gainBlue)  * t;
	red   = static_cast<uint8_t>(std::lround(std::min(255.0, red   * scaleRed)));
	green = static_cast<uint8_t>(std::lround(std::min(255.0, green * scaleGreen)));
	blue  = static_cast<uint8_t>(std::lround(std::min(255.0, blue  * scaleBlue)));
}
