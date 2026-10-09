#pragma once

// STL includes
#include <cstdint>
#include <cmath>
#include <algorithm>

#include <QVector>

#include <utils/ColorRgb.h>

///
/// Fork extension (16-bit HD108 output, see DESIGN.md): red-green-blue color with 16 bit per
/// channel (0..65535). It travels next to the 8-bit ColorRgb from the color adjustment through
/// the smoothing to LED devices that can show more than 8 bit (LedDevice::supportsPrecise).
/// 8-bit value v corresponds to v * 257, so 255 maps to 65535 exactly.
///
struct ColorRgb16
{
	uint16_t red = 0;
	uint16_t green = 0;
	uint16_t blue = 0;

	ColorRgb16() = default;

	ColorRgb16(uint16_t _red, uint16_t _green, uint16_t _blue) : red(_red), green(_green), blue(_blue)
	{
	}

	/// Same color as an 8-bit ColorRgb
	explicit ColorRgb16(const ColorRgb& color)
		: red(static_cast<uint16_t>(color.red * 257))
		, green(static_cast<uint16_t>(color.green * 257))
		, blue(static_cast<uint16_t>(color.blue * 257))
	{
	}

	/// Converts a channel on the 8-bit scale (0.0..255.0, fractions allowed) to 16 bit
	static uint16_t fromScale255(double value)
	{
		return static_cast<uint16_t>(std::lround(std::clamp(value * 257.0, 0.0, 65535.0)));
	}

	bool operator==(const ColorRgb16& other) const
	{
		return red == other.red && green == other.green && blue == other.blue;
	}

	bool operator!=(const ColorRgb16& other) const
	{
		return !(*this == other);
	}
};

///
/// Fork extension: red-green-blue color on the 8-bit scale (0.0..255.0) with fractions, e.g. the
/// mean of many pixels before it is cut to a whole number. Feeds the 16-bit path.
///
struct ColorRgbFloat
{
	float red = 0.0F;
	float green = 0.0F;
	float blue = 0.0F;
};
