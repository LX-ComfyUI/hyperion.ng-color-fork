#pragma once

#include <cstdint>
#include <QVector>

///
/// One point of the gray curve (fork extension, "Graukurve"): the channel factors that apply to
/// grays of this brightness.
///
struct GrayCurvePoint
{
	/// Brightness of the input color in percent (max of red, green and blue, 0..100)
	double level = 50.0;
	/// Factors on the LED channels (1.0 = unchanged)
	double gainRed = 1.0;
	double gainGreen = 1.0;
	double gainBlue = 1.0;
};

///
/// Fork extension (2026-10, "Graukurve"): brightness-dependent white balance for grays. A single
/// gamma per channel cannot make dark and medium grays neutral at the same time; the gray curve
/// sets channel factors per brightness instead. It works on the LED output (after the color
/// mapping and the temperature), so a factor of 0.9 means 10 % less of that channel on the LEDs.
/// Only near-neutral colors are affected: the effect fades out with the Okhsv saturation of the
/// input and is gone at saturationLimit, so saturated colors stay untouched.
///
struct GrayCurve
{
	bool enabled = false;
	/// Okhsv saturation (0..1) of the input at which the curve has no effect any more
	double saturationLimit = 0.15;
	/// Points sorted ascending by level (see hyperion::createGrayCurve). Between two points the
	/// factors are blended linearly, below the first and above the last point they are held.
	QVector<GrayCurvePoint> points;
};

namespace GrayCurveTransform
{
	///
	/// Channel factors for one LED, from its input color (as grabbed, before any other step).
	/// Returns false (and factors of 1.0) when the curve is off or has no effect on this color.
	///
	bool gains(const GrayCurve& curve, uint8_t red, uint8_t green, uint8_t blue,
	           float& gainRed, float& gainGreen, float& gainBlue);

	///
	/// The same for an input color with fractions on the 8-bit scale (0.0..255.0), e.g. the mean
	/// of an LED area before it is cut to whole numbers.
	///
	bool gainsPrecise(const GrayCurve& curve, double red, double green, double blue,
	                  float& gainRed, float& gainGreen, float& gainBlue);
}
