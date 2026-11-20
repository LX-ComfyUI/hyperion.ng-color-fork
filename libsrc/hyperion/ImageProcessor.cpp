#include <hyperion/ImageProcessor.h>

#include <QSharedPointer>
#include <QRgb>
#include <QLoggingCategory>

// Hyperion includes
#include <hyperion/Hyperion.h>
#include <hyperion/ImageToLedsMap.h>

// Blackborder includes
#include <blackborder/BlackBorderProcessor.h>

#include "utils/MemoryTracker.h"

Q_LOGGING_CATEGORY(imageProcessor_track, "hyperion.imageProcessor.track");

using namespace hyperion;

void ImageProcessor::registerProcessingUnit(
		int width,
		int height,
		int horizontalBorder,
		int verticalBorder)
{

	if (_imageToLedColors && _imageToLedColors->width() == width && _imageToLedColors->height() == height &&
		_imageToLedColors->horizontalBorder() == horizontalBorder && _imageToLedColors->verticalBorder() == verticalBorder)
	{
		qCDebug(imageProcessor_track) << "No change in size/border detected.";
	}

	qCDebug(imageProcessor_track) << "Size" << width << "x" << height
								  << "horiz. border:" << horizontalBorder << "vert. border:" << verticalBorder
								  << "pixel factor:" << _reducedPixelSetFactorFactor << "accuracy level:" << _accuracyLevel
								  << "#LEDs:" << _ledString.leds().size();

	if (width > 0 && height > 0)
	{
		_imageToLedColors = MAKE_TRACKED_SHARED(ImageToLedsMap,
								_log,
								width,
								height,
								horizontalBorder,
								verticalBorder,
								_areaLeds,
								_reducedPixelSetFactorFactor,
								_accuracyLevel,
								barFullHeightLeds(horizontalBorder)
		);
		updateBarFillSources();
	}
	else
	{
		qCDebug(imageProcessor_track) << "Invalid size, resetting ImageToLedsMap.";
		_imageToLedColors = MAKE_TRACKED_SHARED(ImageToLedsMap, _log, 0, 0, 0, 0, _ledString.leds());
	}
}

// global transform method
int ImageProcessor::mappingTypeToInt(const QString& mappingType)
{
	if (mappingType == "multicolor_mean" )
	{
		return 0;
	}
	else if (mappingType == "multicolor_mean_squared" )
	{
		return 1;
	}
	else if (mappingType == "unicolor_mean" )
	{
		return 2;
	}
	else if (mappingType == "dominant_color" )
	{
		return 3;
	}
	else if (mappingType == "unicolor_dominant" )
	{
		return 4;
	}
	else if (mappingType == "dominant_color_advanced" )
	{
		return 5;
	}
	else if (mappingType == "unicolor_dominant_advanced" )
	{
		return 6;
	}
	return 0;
}
// global transform method
QString ImageProcessor::mappingTypeToStr(int mappingType)
{
	QString typeText;
	switch (mappingType) {

	case 0:
		typeText = "multicolor_mean";
		break;
	case 1:
		typeText = "multicolor_mean_squared";
		break;
	case 2:
		typeText = "unicolor_mean";
		break;
	case 3:
		typeText = "dominant_color";
		break;
	case 4:
		typeText = "unicolor_dominant";
		break;
	case 5:
		typeText = "dominant_color_advanced";
		break;
	case 6:
		typeText = "unicolor_dominant_advanced";
		break;
	default:
		typeText = "multicolor_mean";
		break;
	}

	return typeText;
}

ImageProcessor::ImageProcessor(const LedString& ledString, const QSharedPointer<Hyperion>& hyperionInstance)
	: QObject()
	, _log(nullptr)
	, _ledString(ledString)
	, _borderProcessor(nullptr)
	, _grayStillDetector(nullptr)
	, _imageToLedColors(nullptr)
	, _mappingType(0)
	, _userMappingType(0)
	, _hardMappingType(-1)
	, _accuracyLevel(0)
	, _reducedPixelSetFactorFactor(1)
	, _fractionalMean(true)
	, _depthTopBottom(0.0)
	, _depthLeftRight(0.0)
	, _areaLeds(ledString.leds())
	, _barLight(BarLight::Normal)
	, _barOneToOne(false)
	, _barFillCorner(false)
	, _barActive(false)
	, _barDarkCount(0)
	, _barFilledCount(0)
	, _hyperionWeak(hyperionInstance)
{
	QString subComponent{ "__" };

	QSharedPointer<Hyperion> hyperion = _hyperionWeak.toStrongRef();
	if (hyperion)
	{
		subComponent = hyperion->property("instance").toString();
	}
	_log = Logger::getInstance("IMAGETOLED", subComponent);
	TRACK_SCOPE_SUBCOMPONENT();

	_borderProcessor.reset(new BlackBorderProcessor(hyperion));
	_grayStillDetector.reset(new GrayStillImageDetector(hyperion));

	// init
	updateLedEdges();
	handleSettingsUpdate(settings::COLOR, hyperion->getSetting(settings::COLOR));
	handleSettingsUpdate(settings::BLACKBORDER, hyperion->getSetting(settings::BLACKBORDER));
	// listen for changes in color - ledmapping
	connect(hyperion.get(), &Hyperion::settingsChanged, this, &ImageProcessor::handleSettingsUpdate);
}

ImageProcessor::~ImageProcessor()
{
	TRACK_SCOPE_SUBCOMPONENT();
}

void ImageProcessor::handleSettingsUpdate(settings::type type, const QJsonDocument& config)
{
	if(type == settings::COLOR)
	{
		qCDebug(imageProcessor_track) << "Handling settings update for COLOR";
		const QJsonObject& obj = config.object();
		int newType = mappingTypeToInt(obj["imageToLedMappingType"].toString());
		if(_userMappingType != newType)
		{
			setLedMappingType(newType);
		}

		int reducedPixelSetFactorFactor = obj["reducedPixelSetFactorFactor"].toString().toInt();
		setReducedPixelSetFactorFactor(reducedPixelSetFactorFactor);

		int accuracyLevel = obj["accuracyLevel"].toInt();
		setAccuracyLevel(accuracyLevel);

		// Fork extension: LED means with fractions for the 16-bit path, on when missing
		const bool fractionalMean = obj["fractionalMean"].toBool(true);
		if (fractionalMean != _fractionalMean)
		{
			Info(_log, "LED means with fractions for the 16-bit output: %s", fractionalMean ? "on" : "off");
		}
		_fractionalMean = fractionalMean;

		// Fork extension: depth of the LED areas, 0 = as in the layout
		const QJsonObject depth = obj["ledAreaDepth"].toObject();
		const double depthTopBottom = depth["topBottom"].toDouble(0.0);
		const double depthLeftRight = depth["leftRight"].toDouble(0.0);
		if (!qFuzzyCompare(1.0 + depthTopBottom, 1.0 + _depthTopBottom) || !qFuzzyCompare(1.0 + depthLeftRight, 1.0 + _depthLeftRight))
		{
			_depthTopBottom = depthTopBottom;
			_depthLeftRight = depthLeftRight;
			Info(_log, "LED area depth: top/bottom %.1f %%, left/right %.1f %% (0 = as in the layout)", _depthTopBottom, _depthLeftRight);
			updateAreaLeds();
			if (!_imageToLedColors.isNull())
			{
				// keep the current black border, the border detection only reports changes
				registerProcessingUnit(_imageToLedColors->width(), _imageToLedColors->height(),
				                       _imageToLedColors->horizontalBorder(), _imageToLedColors->verticalBorder());
			}
		}
	}
	else if (type == settings::BLACKBORDER)
	{
		handleBarDisplaySettings(config.object()["barDisplay"].toObject());
	}
}

void ImageProcessor::handleBarDisplaySettings(const QJsonObject& obj)
{
	const QString light = obj["lightAtBars"].toString("normal");
	const BarLight barLight = light == "off" ? BarLight::Off : light == "sidesOnly" ? BarLight::SidesOnly : BarLight::Normal;
	const bool oneToOne = obj["sideLeds"].toString("stretched") == "oneToOne";
	const bool fillCorner = obj["barSideFill"].toString("dark") == "cornerColor";
	if (barLight == _barLight && oneToOne == _barOneToOne && fillCorner == _barFillCorner)
	{
		return;
	}
	_barLight = barLight;
	_barOneToOne = oneToOne;
	_barFillCorner = fillCorner;
	Info(_log, "Picture with black bars: light at bars %s, side LEDs %s, bar height at the sides %s",
		 QSTRING_CSTR(light), oneToOne ? "1:1" : "stretched", fillCorner ? "corner colour" : "dark");
	if (!_imageToLedColors.isNull())
	{
		// keep the current black border, the border detection only reports changes
		registerProcessingUnit(_imageToLedColors->width(), _imageToLedColors->height(),
		                       _imageToLedColors->horizontalBorder(), _imageToLedColors->verticalBorder());
	}
}

void ImageProcessor::updateLedEdges()
{
	// the nearest picture edge of each LED centre in the layout; LEDs far from every edge (a matrix
	// behind the picture) count as inner: never switched off as top/bottom, mapped 1:1 like the sides
	constexpr double INNER_DISTANCE = 0.25;
	const QVector<Led>& leds = _ledString.leds();
	_ledEdge.fill(EdgeInner, leds.size());
	for (int i = 0; i < leds.size(); ++i)
	{
		const Led& led = leds[i];
		if ((led.maxX_frac - led.minX_frac) < 1e-6 || (led.maxY_frac - led.minY_frac) < 1e-6)
		{
			continue;
		}
		const double cx = (led.minX_frac + led.maxX_frac) / 2.0;
		const double cy = (led.minY_frac + led.maxY_frac) / 2.0;
		const double top = cy, bottom = 1.0 - cy, left = cx, right = 1.0 - cx;
		const double nearest = qMin(qMin(top, bottom), qMin(left, right));
		if (nearest > INNER_DISTANCE)
		{
			continue;
		}
		// a corner LED (same distance) belongs to the top/bottom row
		if (top <= nearest) _ledEdge[i] = EdgeTop;
		else if (bottom <= nearest) _ledEdge[i] = EdgeBottom;
		else if (left <= nearest) _ledEdge[i] = EdgeLeft;
		else _ledEdge[i] = EdgeRight;
	}
}

QVector<bool> ImageProcessor::barFullHeightLeds(int horizontalBorder) const
{
	QVector<bool> fullHeight;
	if (horizontalBorder <= 0 || !_barOneToOne || _barLight == BarLight::Off || _ledEdge.size() != _areaLeds.size())
	{
		return fullHeight;
	}
	fullHeight.fill(false, _ledEdge.size());
	for (int i = 0; i < _ledEdge.size(); ++i)
	{
		fullHeight[i] = _ledEdge[i] != EdgeTop && _ledEdge[i] != EdgeBottom;
	}
	return fullHeight;
}

void ImageProcessor::updateBarFillSources()
{
	_barFillSource.clear();
	const QVector<int>& barSide = _imageToLedColors->barSide();
	if (barSide.isEmpty())
	{
		return;
	}
	const QVector<double>& rows = _imageToLedColors->centerRow();
	_barFillSource.fill(-1, barSide.size());
	if (!_barFillCorner)
	{
		return;
	}
	// per side and bar: the LED of the same side in the picture nearest to that bar
	for (int edge : { int(EdgeLeft), int(EdgeRight) })
	{
		int topmost = -1, bottommost = -1;
		for (int i = 0; i < barSide.size(); ++i)
		{
			if (_ledEdge[i] != edge || barSide[i] != 0 || rows[i] < 0)
			{
				continue;
			}
			if (topmost < 0 || rows[i] < rows[topmost]) topmost = i;
			if (bottommost < 0 || rows[i] > rows[bottommost]) bottommost = i;
		}
		for (int i = 0; i < barSide.size(); ++i)
		{
			if (_ledEdge[i] == edge && barSide[i] != 0)
			{
				_barFillSource[i] = barSide[i] < 0 ? topmost : bottommost;
			}
		}
	}
}

void ImageProcessor::applyBarDisplay(QVector<ColorRgb>& colors, QVector<ColorRgbFloat>* means)
{
	const bool bar = !_imageToLedColors.isNull() && _imageToLedColors->horizontalBorder() > 0;
	const bool active = bar && (_barLight != BarLight::Normal || !_barFillSource.isEmpty());
	int dark = 0;
	int filled = 0;
	if (active)
	{
		const bool withMeans = means != nullptr && means->size() == colors.size();
		const auto setDark = [&](int i) {
			colors[i] = ColorRgb::BLACK;
			if (withMeans) (*means)[i] = ColorRgbFloat{ 0.0f, 0.0f, 0.0f };
			++dark;
		};
		if (_barLight == BarLight::Off)
		{
			for (int i = 0; i < colors.size(); ++i) setDark(i);
		}
		else
		{
			// fill first: the sources are side LEDs in the picture, never switched off below
			if (_barFillSource.size() == colors.size())
			{
				const QVector<ColorRgb> source = colors;
				const QVector<ColorRgbFloat> sourceMeans = withMeans ? *means : QVector<ColorRgbFloat>();
				for (int i = 0; i < colors.size(); ++i)
				{
					const int from = _barFillSource[i];
					if (from == -1 && _imageToLedColors->barSide().value(i) == 0)
					{
						continue;
					}
					if (from < 0)
					{
						setDark(i);
						continue;
					}
					colors[i] = source[from];
					if (withMeans) (*means)[i] = sourceMeans[from];
					++filled;
				}
			}
			if (_barLight == BarLight::SidesOnly && _ledEdge.size() == colors.size())
			{
				for (int i = 0; i < colors.size(); ++i)
				{
					if (_ledEdge[i] == EdgeTop || _ledEdge[i] == EdgeBottom) setDark(i);
				}
			}
		}
	}
	QMutexLocker locker(&_barMutex);
	_barActive = active;
	_barDarkCount = dark;
	_barFilledCount = filled;
}

QJsonObject ImageProcessor::barDisplayDebugState() const
{
	QMutexLocker locker(&_barMutex);
	return QJsonObject{
		{ "lightAtBars", _barLight == BarLight::Off ? "off" : _barLight == BarLight::SidesOnly ? "sidesOnly" : "normal" },
		{ "sideLeds", _barOneToOne ? "oneToOne" : "stretched" },
		{ "barSideFill", _barFillCorner ? "cornerColor" : "dark" },
		{ "active", _barActive },
		{ "ledsDark", _barDarkCount },
		{ "ledsFilled", _barFilledCount }
	};
}

void ImageProcessor::setSize(int width, int height)
{
	// Check if the existing buffer-image is already the correct dimensions
	if (!_imageToLedColors.isNull() && _imageToLedColors->width() == width && _imageToLedColors->height() == height)
	{
		return;
	}

	qCDebug(imageProcessor_track) << "Image size changed from ["
								  << (_imageToLedColors.isNull() ? 0 : _imageToLedColors->width())
								  << "x"
								  << (_imageToLedColors.isNull() ? 0 : _imageToLedColors->height())
								  << "] to [" << width << "x" << height << "] - update image processing unit";

	// Construct a new buffer and mapping
	registerProcessingUnit(width, height, 0, 0);
}

void ImageProcessor::setLedString(const LedString& ledString)
{
	if ( !_imageToLedColors.isNull() )
	{
		qCDebug(imageProcessor_track) << "Update LED-String in image processing unit.";
		_ledString = ledString;
		updateAreaLeds();
		updateLedEdges();

		// get current width/height
		int width = _imageToLedColors->width();
		int height = _imageToLedColors->height();

		// Construct a new buffer and mapping
		registerProcessingUnit(width, height, 0, 0);
	}
}

void ImageProcessor::updateAreaLeds()
{
	_areaLeds = hyperion::applyLedAreaDepth(_ledString.leds(), _depthTopBottom, _depthLeftRight);
}

void ImageProcessor::setBlackbarDetectDisable(bool enable)
{
	qCDebug(imageProcessor_track) << (enable ? "Disable" : "Enable") << "black border detection";
	_borderProcessor->setHardDisable(enable);
}

bool ImageProcessor::blackBorderDetectorEnabled() const
{
	qCDebug(imageProcessor_track) << "Black border detector is" << (_borderProcessor->enabled() ? "enabled" : "disabled");
	return _borderProcessor->enabled();
}

void ImageProcessor::setReducedPixelSetFactorFactor(int count)
{

	int currentReducedPixelSetFactor= _reducedPixelSetFactorFactor;

	_reducedPixelSetFactorFactor = count;
	Debug(_log, "Set reduced pixel set factor to %d", _reducedPixelSetFactorFactor);

	if (currentReducedPixelSetFactor != _reducedPixelSetFactorFactor && !_imageToLedColors.isNull())
	{
		qCDebug(imageProcessor_track) << "Set reduced pixel set factor to" << count << "- update image processing unit";
		int width = _imageToLedColors->width();
		int height = _imageToLedColors->height();

		// Construct a new buffer and mapping
		registerProcessingUnit(width, height, 0, 0);
	}
}

void ImageProcessor::setAccuracyLevel(int level)
{
	qCDebug(imageProcessor_track) << "Set accuracy level to" << level;
	_accuracyLevel = level;
	Debug(_log, "Set processing accuracy level to %d", _accuracyLevel);

	if (!_imageToLedColors.isNull())
	{
		_imageToLedColors->setAccuracyLevel(_accuracyLevel);
	}
}

void ImageProcessor::setLedMappingType(int mapType)
{
	int currentMappingType = _mappingType;

	// if the _hardMappingType is >-1 we aren't allowed to overwrite it
	_userMappingType = mapType;

	Debug(_log, "Set user LED mapping to [%d] - %s", mapType, QSTRING_CSTR(mappingTypeToStr(mapType)));

	if(_hardMappingType == -1)
	{
		_mappingType = mapType;
	}

	if (currentMappingType != _mappingType && !_imageToLedColors.isNull())
	{
		qCDebug(imageProcessor_track) << "Set LED mapping to [" << mapType << "] -" << mappingTypeToStr(mapType) << "- update image processing unit";
		int width = _imageToLedColors->width();
		int height = _imageToLedColors->height();

		registerProcessingUnit(width, height, 0, 0);
	}
}

void ImageProcessor::setHardLedMappingType(int mapType)
{
	qCDebug(imageProcessor_track) << "Set hard LED mapping to [" << mapType << "] -" << mappingTypeToStr(mapType) ;

	// force the maptype, if set to -1 we use the last requested _userMappingType
	_hardMappingType = mapType;
	if(mapType == -1)
	{
		_mappingType = _userMappingType;
	}
	else
	{
		_mappingType = mapType;
	}
}

bool ImageProcessor::getScanParameters(size_t led, double &hscanBegin, double &hscanEnd, double &vscanBegin, double &vscanEnd) const
{
	qCDebug(imageProcessor_track) << "Get scan parameters for LED" << led;
	if (led < static_cast<size_t>(_ledString.leds().size()))
	{
		const Led & l = _ledString.leds()[led];
		hscanBegin = l.minX_frac;
		hscanEnd = l.maxX_frac;
		vscanBegin = l.minY_frac;
		vscanEnd = l.maxY_frac;
	}
	else
	{
		qCWarning(imageProcessor_track) << "Requested LED index" << led << "is out of bounds, max is" << _ledString.leds().size();
		return false;
	}

	return true;
}
