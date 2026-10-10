#include <hyperion/ImageToLedsMap.h>

Q_LOGGING_CATEGORY(imageToLedsMap_track, "hyperion.imageToLedsMap.track");
Q_LOGGING_CATEGORY(imageToLedsMap_calc, "hyperion.imageToLedsMap.calc");

using namespace hyperion;

ImageToLedsMap::ImageToLedsMap(
		QSharedPointer<Logger> log,
		int width,
		int height,
		int horizontalBorder,
		int verticalBorder,
		const QVector<Led>& leds,
		int reducedPixelSetFactor,
		int accuracyLevel)
	: _log(log)
	, _width(width)
	, _height(height)
	, _horizontalBorder(horizontalBorder)
	, _verticalBorder(verticalBorder)
	, _nextPixelCount(reducedPixelSetFactor)
	, _clusterCount()
	, _colorsMap()
{
	TRACK_SCOPE();

	setAccuracyLevel(accuracyLevel);

	// Sanity check of the size of the borders (and width and height)
	Q_ASSERT(_width  > 2*_verticalBorder);
	Q_ASSERT(_height > 2*_horizontalBorder);
	Q_ASSERT(_width  < 10000);
	Q_ASSERT(_height < 10000);

	// Reserve enough space in the map for the leds
	_colorsMap.reserve(leds.size());

	const int xOffset      = _verticalBorder;
	const int actualWidth  = _width  - 2 * _verticalBorder;
	const int yOffset      = _horizontalBorder;
	const int actualHeight = _height - 2 * _horizontalBorder;

	size_t	totalCount = 0;
	int     ledCounter = 0;
	QList<int> ledsWithForcedSkippedPixels;

	for (const Led& led : leds)
	{
		// skip leds without area
		if ((led.maxX_frac-led.minX_frac) < 1e-6 || (led.maxY_frac-led.minY_frac) < 1e-6)
		{
			_colorsMap.append(QVector<int>());
			continue;
		}

		// Compute the index boundaries for this led
		int minX_idx = xOffset + int32_t(qRound(actualWidth  * led.minX_frac));
		int maxX_idx = xOffset + int32_t(qRound(actualWidth  * led.maxX_frac));
		int minY_idx = yOffset + int32_t(qRound(actualHeight * led.minY_frac));
		int maxY_idx = yOffset + int32_t(qRound(actualHeight * led.maxY_frac));

		// make sure that the area is at least a single led large
		minX_idx = qMin(minX_idx, xOffset + actualWidth - 1);
		if (minX_idx == maxX_idx)
		{
			maxX_idx++;
		}
		minY_idx = qMin(minY_idx, yOffset + actualHeight - 1);
		if (minY_idx == maxY_idx)
		{
			maxY_idx++;
		}

		// Add all the indices in the above defined rectangle to the indices for this led
		const int maxYLedCount = qMin(maxY_idx, yOffset+actualHeight);
		const int maxXLedCount = qMin(maxX_idx, xOffset+actualWidth);

		const int realYLedCount = qAbs(maxYLedCount - minY_idx);
		const int realXLedCount = qAbs(maxXLedCount - minX_idx);
		auto totalSize =realYLedCount * realXLedCount;

		_nextPixelCount = reducedPixelSetFactor + 1;
		if (_nextPixelCount == 1 && totalSize > 1600)
		{
			_nextPixelCount = 2;
			ledsWithForcedSkippedPixels.append(ledCounter);
		}

		QVector<int> ledColors;
		ledColors.reserve(totalSize);
		for (int y = minY_idx; y < maxYLedCount; y += _nextPixelCount)
		{
			for (int x = minX_idx; x < maxXLedCount; x += _nextPixelCount)
			{
				// fork fix: image rows are _width long, also with a black border
				ledColors.append( y * _width + x);
			}
		}

		_colorsMap.append(ledColors);
		qCDebug(imageToLedsMap_track) << "-> LED/light [" << ledCounter << "] pixels:" << totalSize << ", Skipping every" << _nextPixelCount << "pixels =>" << _colorsMap.last().size() << "pixels mapped";	

		totalCount += ledColors.size();

		ledCounter++;
	}

	WarningIf(!ledsWithForcedSkippedPixels.isEmpty(), _log,
			  "[%d] LED mapping area(s) have a huge number of pixels to be processed. "
			  "Every %d pixels will be skipped to improve performance. Enable reduced processing to hide this warning.",
			  ledsWithForcedSkippedPixels.size(), _nextPixelCount);

	qCDebug(imageToLedsMap_track) << "LED areas:" << leds.size() << ", #indicies:" << totalCount
					 			 << ", H-border:" << horizontalBorder << ", V-border:" << verticalBorder
								  << ", Reduced pixel factor:" << reducedPixelSetFactor << ", Accuracy:" << accuracyLevel
								  << ", Image size:" << width << "x" << height;
}

ImageToLedsMap::~ImageToLedsMap()
{
	TRACK_SCOPE();
}

int ImageToLedsMap::width() const
{
	return _width;
}

int ImageToLedsMap::height() const
{
	return _height;
}

void ImageToLedsMap::setAccuracyLevel (int accuracyLevel)
{
	if (accuracyLevel > 4 )
	{
		Warning(_log, "Accuracy level %d is too high, it will be set to 4", accuracyLevel);
		accuracyLevel = 4;
	}
	//Set cluster number for dominant color advanced
	_clusterCount  = accuracyLevel + 1;

}


QVector<Led> hyperion::applyLedAreaDepth(const QVector<Led>& leds, double topBottomPercent, double leftRightPercent)
{
	const double depthY = qBound(0.0, topBottomPercent, 50.0) / 100.0;
	const double depthX = qBound(0.0, leftRightPercent, 50.0) / 100.0;
	QVector<Led> result = leds;
	if (depthY <= 0.0 && depthX <= 0.0)
	{
		return result;
	}

	constexpr double EDGE = 1e-4;
	for (Led& led : result)
	{
		const double width = led.maxX_frac - led.minX_frac;
		const double height = led.maxY_frac - led.minY_frac;
		if (led.isBlacklisted || width < 1e-6 || height < 1e-6)
		{
			continue;
		}

		const bool top = led.minY_frac <= EDGE;
		const bool bottom = led.maxY_frac >= 1.0 - EDGE;
		const bool left = led.minX_frac <= EDGE;
		const bool right = led.maxX_frac >= 1.0 - EDGE;

		// an area reaching from one edge to the opposite one has no depth to change on that axis;
		// along the top/bottom edge the depth is the height, along the sides the width
		const bool onTopOrBottom = top != bottom;
		const bool onSide = left != right;
		const bool horizontalEdge = onTopOrBottom && (!onSide || height >= width);
		const bool verticalEdge = onSide && !horizontalEdge;

		if (horizontalEdge && depthY > 0.0)
		{
			if (top)
			{
				led.minY_frac = 0.0;
				led.maxY_frac = depthY;
			}
			else
			{
				led.minY_frac = 1.0 - depthY;
				led.maxY_frac = 1.0;
			}
		}
		else if (verticalEdge && depthX > 0.0)
		{
			if (left)
			{
				led.minX_frac = 0.0;
				led.maxX_frac = depthX;
			}
			else
			{
				led.minX_frac = 1.0 - depthX;
				led.maxX_frac = 1.0;
			}
		}
	}
	return result;
}
