#pragma once

#include <cstdint>

#include <utils/GrayAxisTrim.h>

///
/// Engine that applies the gray-axis trim (fork feature 4/4b, see
/// DESIGN.md) to one pixel at a time, operating in Okhsv space via
/// ColorSys::rgb2okhsv/okhsv2rgb.
///
class GrayAxisTrimTransform
{
public:
	///
	/// Apply the gray-axis trim (if enabled) to a single pixel, in place.
	///
	/// @param red, green, blue     The pixel, updated in place
	/// @param trim                  The profile's gray-axis trim
	///
	static void apply(uint8_t & red, uint8_t & green, uint8_t & blue,
	                   const GrayAxisTrim & trim);
};
