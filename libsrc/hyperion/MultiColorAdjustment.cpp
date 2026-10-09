#include <algorithm>
#include <utility>
#include <cmath>

// Hyperion includes

#include <utils/Logger.h>
#include <utils/GrayAxisTrimTransform.h>
#include <utils/EdgeTransitionBoostTransform.h>
#include <hyperion/MultiColorAdjustment.h>

MultiColorAdjustment::MultiColorAdjustment(int ledCnt)
	: _ledAdjustments(static_cast<size_t>(ledCnt), nullptr)
	, _log(Logger::getInstance("ADJUSTMENT"))
{
	TRACK_SCOPE();
}

MultiColorAdjustment::~MultiColorAdjustment()
{
	TRACK_SCOPE();
	for (ColorAdjustment* adjustment : _adjustment)
	{
		delete adjustment;
	}
	_adjustment.clear();
}

void MultiColorAdjustment::addAdjustment(ColorAdjustment * adjustment)
{
	_adjustmentIds.push_back(adjustment->_id);
	_adjustment.push_back(adjustment);
}

void MultiColorAdjustment::setAdjustmentForLed(const QString& adjutmentId, int startLed, int endLed)
{
	// abort
	if(startLed > endLed)
	{
		Error(_log,"startLed > endLed -> %d > %d", startLed, endLed);
		return;
	}
	// catch wrong values
	if(endLed > static_cast<int>(_ledAdjustments.size()-1))
	{
		Warning(_log,"The color calibration 'LED index' field has LEDs specified which aren't part of your led layout");
		endLed = static_cast<int>(_ledAdjustments.size()-1);
	}

	// Get the identified adjustment (don't care if is nullptr)
	ColorAdjustment * adjustment = getAdjustment(adjutmentId);
	for (size_t iLed=static_cast<size_t>(startLed); iLed<=static_cast<size_t>(endLed); ++iLed)
	{
		_ledAdjustments[iLed] = adjustment;
	}
}

bool MultiColorAdjustment::verifyAdjustments() const
{
	bool isAdjustmentDefined = true;
	for (unsigned iLed=0; iLed<_ledAdjustments.size(); ++iLed)
	{
		const ColorAdjustment * adjustment = _ledAdjustments[iLed];

		if (adjustment == nullptr)
		{
			Warning(_log, "No calibration set for LED %d", iLed);
			isAdjustmentDefined = false;
		}
	}
	return isAdjustmentDefined;
}

QStringList MultiColorAdjustment::getAdjustmentIds() const
{
	return _adjustmentIds;
}

ColorAdjustment* MultiColorAdjustment::getAdjustment(const QString& adjustmentId)
{
	auto adjustmentIter = std::find_if(_adjustment.begin(), _adjustment.end(), [&adjustmentId](const ColorAdjustment* adjustment) {
		return adjustment->_id == adjustmentId;
	});

	if (adjustmentIter != _adjustment.end()) {
		return *adjustmentIter;
	}

	// The ColorAdjustment was not found
	return nullptr;
}

void MultiColorAdjustment::setBacklightEnabled(bool enable)
{
	for (ColorAdjustment* adjustment : _adjustment)
	{
		adjustment->_rgbTransform.setBackLightEnabled(enable);
	}
}

// Fork extension (16-bit HD108 output): the same calculation as the per-LED part of
// applyAdjustment() from the gamma step on, in float and without the cuts to whole numbers. The
// 8-bit path cuts several times (gamma table, corner weights, corner values, temperature), so its
// result can be a few steps below this one. The result is converted to 16 bit only at the end.
ColorRgb16 MultiColorAdjustment::computePrecise(ColorAdjustment* adjustment, uint8_t inRed, uint8_t inGreen, uint8_t inBlue,
                                                float gainRed, float gainGreen, float gainBlue)
{
	float r = 0.0F;
	float g = 0.0F;
	float b = 0.0F;
	adjustment->_rgbTransform.applyGammaPrecise(inRed, inGreen, inBlue, r, g, b);

	uint8_t B_RGB = 0;
	uint8_t B_CMY = 0;
	uint8_t B_W = 0;
	adjustment->_rgbTransform.getBrightnessComponents(B_RGB, B_CMY, B_W);

	// trilinear weights of the 8 corner colors, on the 8-bit scale (they add up to 255)
	const float max = UINT8_MAX;
	const float squared = static_cast<float>(DOUBLE_UINT8_MAX_SQUARED);
	const float nr_ng = (max - r) * (max - g);
	const float r_ng  = r * (max - g);
	const float nr_g  = (max - r) * g;
	const float r_g   = r * g;

	const float black   = nr_ng * (max - b) / squared;
	const float red     = r_ng  * (max - b) / squared;
	const float green   = nr_g  * (max - b) / squared;
	const float blue    = nr_ng * b / squared;
	const float cyan    = nr_g  * b / squared;
	const float magenta = r_ng  * b / squared;
	const float yellow  = r_g   * (max - b) / squared;
	const float white   = r_g   * b / squared;

	struct Part { float r, g, b; };
	Part parts[8];
	adjustment->_rgbBlackAdjustment.applyPrecise  (black  , UINT8_MAX, parts[0].r, parts[0].g, parts[0].b);
	adjustment->_rgbRedAdjustment.applyPrecise    (red    , B_RGB, parts[1].r, parts[1].g, parts[1].b);
	adjustment->_rgbGreenAdjustment.applyPrecise  (green  , B_RGB, parts[2].r, parts[2].g, parts[2].b);
	adjustment->_rgbBlueAdjustment.applyPrecise   (blue   , B_RGB, parts[3].r, parts[3].g, parts[3].b);
	adjustment->_rgbCyanAdjustment.applyPrecise   (cyan   , B_CMY, parts[4].r, parts[4].g, parts[4].b);
	adjustment->_rgbMagentaAdjustment.applyPrecise(magenta, B_CMY, parts[5].r, parts[5].g, parts[5].b);
	adjustment->_rgbYellowAdjustment.applyPrecise (yellow , B_CMY, parts[6].r, parts[6].g, parts[6].b);
	adjustment->_rgbWhiteAdjustment.applyPrecise  (white  , B_W  , parts[7].r, parts[7].g, parts[7].b);

	float outR = 0.0F;
	float outG = 0.0F;
	float outB = 0.0F;
	for (const Part& part : parts)
	{
		outR += part.r;
		outG += part.g;
		outB += part.b;
	}
	// the 8-bit path stores the sum in a byte; with a valid calibration it stays below 256
	outR = qMin(outR, max);
	outG = qMin(outG, max);
	outB = qMin(outB, max);

	adjustment->_rgbTransform.applyTemperaturePrecise(outR, outG, outB);
	// gray curve factors (1.0 when it is off or the color is not near-neutral)
	outR = qMin(outR * gainRed, max);
	outG = qMin(outG * gainGreen, max);
	outB = qMin(outB * gainBlue, max);
	adjustment->_rgbTransform.applyBacklightPrecise(outR, outG, outB);

	return ColorRgb16(ColorRgb16::fromScale255(outR), ColorRgb16::fromScale255(outG), ColorRgb16::fromScale255(outB));
}

void MultiColorAdjustment::applyAdjustment(QVector<ColorRgb>& ledColors, QVector<ColorRgb16>* preciseColors)
{
	// The edge boost has no precise version: the LED device then gets the 8-bit values only
	const bool precise = preciseColors != nullptr && !_edgeTransitionBoost.enabled;
	if (preciseColors != nullptr)
	{
		preciseColors->clear();
	}
	if (precise)
	{
		// LEDs without a calibration keep their input color, like in the 8-bit path
		preciseColors->reserve(ledColors.size());
		for (const ColorRgb& color : std::as_const(ledColors))
		{
			preciseColors->append(ColorRgb16(color));
		}
	}

	const size_t itCnt = qMin(_ledAdjustments.size(), ledColors.size());
	for (size_t i=0; i<itCnt; ++i)
	{
		ColorAdjustment* adjustment = _ledAdjustments[i];
		if (adjustment == nullptr)
		{
			// No transform set for this LED (do nothing)
			continue;
		}
		ColorRgb& color = ledColors[i];

		uint8_t ored   = color.red;
		uint8_t ogreen = color.green;
		uint8_t oblue  = color.blue;

		// Fork extension: gray curve factors from the color as grabbed, before any other step
		float gainRed = 1.0F;
		float gainGreen = 1.0F;
		float gainBlue = 1.0F;
		const bool grayCurve = GrayCurveTransform::gains(adjustment->_grayCurve, ored, ogreen, oblue, gainRed, gainGreen, gainBlue);
		uint8_t B_RGB = 0;
		uint8_t B_CMY = 0;
		uint8_t B_W = 0;

		if (!adjustment->_okhsvTransform.isIdentity())
		{
			adjustment->_okhsvTransform.transform(ored, ogreen, oblue);
		}

		if (adjustment->_grayAxisTrim.enabled)
		{
			GrayAxisTrimTransform::apply(ored, ogreen, oblue, adjustment->_grayAxisTrim);
		}

		if (precise)
		{
			// the precise path starts from the same input, after the steps that only see 8-bit input
			(*preciseColors)[i] = computePrecise(adjustment, ored, ogreen, oblue, gainRed, gainGreen, gainBlue);
		}

		adjustment->_rgbTransform.applyGamma(ored,ogreen,oblue);
		adjustment->_rgbTransform.getBrightnessComponents(B_RGB, B_CMY, B_W);

		uint32_t nr_ng = static_cast<uint32_t>((UINT8_MAX - ored) * (UINT8_MAX - ogreen));
		uint32_t r_ng  = static_cast<uint32_t>(ored * (UINT8_MAX - ogreen));
		uint32_t nr_g  = static_cast<uint32_t>((UINT8_MAX - ored) * ogreen);
		uint32_t r_g   = static_cast<uint32_t>(ored * ogreen);

		uint8_t black   = static_cast<uint8_t>(nr_ng * (UINT8_MAX - oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t red     = static_cast<uint8_t>(r_ng * (UINT8_MAX - oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t green   = static_cast<uint8_t>(nr_g * (UINT8_MAX - oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t blue    = static_cast<uint8_t>(nr_ng * (oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t cyan    = static_cast<uint8_t>(nr_g * (oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t magenta = static_cast<uint8_t>(r_ng * (oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t yellow  = static_cast<uint8_t>(r_g * (UINT8_MAX - oblue) / DOUBLE_UINT8_MAX_SQUARED);
		uint8_t white   = static_cast<uint8_t>(r_g * (oblue) / DOUBLE_UINT8_MAX_SQUARED);

		uint8_t OR, OG, OB;  // Original Colors
		uint8_t RR, RG, RB;  // Red Adjustments
		uint8_t GR, GG, GB;  // Green Adjustments
		uint8_t BR, BG, BB;  // Blue Adjustments
		uint8_t CR, CG, CB;  // Cyan Adjustments
		uint8_t MR, MG, MB;  // Magenta Adjustments
		uint8_t YR, YG, YB;  // Yellow Adjustments
		uint8_t WR, WG, WB;  // White Adjustments

		adjustment->_rgbBlackAdjustment.apply  (black  , UINT8_MAX, OR, OG, OB);
		adjustment->_rgbRedAdjustment.apply    (red    , B_RGB, RR, RG, RB);
		adjustment->_rgbGreenAdjustment.apply  (green  , B_RGB, GR, GG, GB);
		adjustment->_rgbBlueAdjustment.apply   (blue   , B_RGB, BR, BG, BB);
		adjustment->_rgbCyanAdjustment.apply   (cyan   , B_CMY, CR, CG, CB);
		adjustment->_rgbMagentaAdjustment.apply(magenta, B_CMY, MR, MG, MB);
		adjustment->_rgbYellowAdjustment.apply (yellow , B_CMY, YR, YG, YB);
		adjustment->_rgbWhiteAdjustment.apply  (white  , B_W  , WR, WG, WB);

		color.red   = OR + RR + GR + BR + CR + MR + YR + WR;
		color.green = OG + RG + GG + BG + CG + MG + YG + WG;
		color.blue  = OB + RB + GB + BB + CB + MB + YB + WB;

		adjustment->_rgbTransform.applyTemperature(color);
		if (grayCurve)
		{
			color.red   = static_cast<uint8_t>(qMin(std::lround(color.red   * gainRed),   255L));
			color.green = static_cast<uint8_t>(qMin(std::lround(color.green * gainGreen), 255L));
			color.blue  = static_cast<uint8_t>(qMin(std::lround(color.blue  * gainBlue),  255L));
		}
		adjustment->_rgbTransform.applyBacklight(color.red, color.green, color.blue);
	}

	if (_edgeTransitionBoost.enabled)
	{
		EdgeTransitionBoostTransform::apply(ledColors, _edgeTransitionBoost);
	}
}
