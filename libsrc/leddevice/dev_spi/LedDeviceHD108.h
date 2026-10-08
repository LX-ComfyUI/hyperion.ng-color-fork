#ifndef LEDDEVICEHD108_H
#define LEDDEVICEHD108_H

#include "ProviderSpi.h"

/// The maximal level supported by the HD108 brightness control field, 31
const int HD108_BRIGHTNESS_MAX_LEVEL = 31;


class LedDeviceHD108 : public ProviderSpi
{

public:

	///
	/// @brief Constructs an HD108 LED-device
	///
	/// @param deviceConfig Device's configuration as JSON-Object
	///
    explicit LedDeviceHD108(const QJsonObject &deviceConfig);

	///
	/// @brief Constructs the LED-device
	///
	/// @param[in] deviceConfig Device's configuration as JSON-Object
	/// @return LedDevice constructed
	///
	static LedDevice* construct(const QJsonObject &deviceConfig);

private:

	///
	/// @brief Initialise the device's configuration
	///
	/// @param[in] deviceConfig the JSON device configuration
	/// @return True, if success
	///
	bool init(const QJsonObject &deviceConfig) override;

	///
	/// @brief Writes the RGB-Color values to the LEDs.
	///
	/// @param[in] ledValues The RGB-color per LED
	/// @return Zero on success, else negative
	///
    int write(const QVector<ColorRgb> & ledValues) override;

	///
	/// @brief Fork extension: the HD108 takes 16 bit per channel, so the precise frame from the
	/// color adjustment is written as it is instead of the 8-bit values stretched to 16 bit.
	///
	bool supportsPrecise() const override { return true; }
	int writePrecise(const QVector<ColorRgb16> & ledValues) override;

	/// Builds and sends one SPI frame from 16-bit values (used by write and writePrecise)
	int writeFrame16(const QVector<ColorRgb16> & ledValues);

	/// The brighness level. Possibile values 1 .. 31.
	int _brightnessControlMaxLevel;
	uint16_t _global_brightness;
};

#endif // LEDDEVICEHD108_H
