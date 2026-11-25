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
								barFullHeightLeds(horizontalBorder),
								barFullWidthLeds(verticalBorder)
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

ImageProcessor::BarAxis ImageProcessor::readBarAxis(const QJsonObject& obj, const char* besideValue, const char* ledsKey)
{
	BarAxis axis;
	const QString light = obj["lightAtBars"].toString("normal");
	axis.light = light == "off" ? BarLight::Off : light == besideValue ? BarLight::Beside : BarLight::Normal;
	axis.oneToOne = obj[ledsKey].toString("stretched") == "oneToOne";
	axis.fillCorner = obj["fillCornerColor"].toBool(true);
	return axis;
}

void ImageProcessor::handleBarDisplaySettings(const QJsonObject& obj)
{
	BarAxis letterbox;
	BarAxis pillarbox;
	if (obj.contains("letterbox") || obj.contains("pillarbox"))
	{
		letterbox = readBarAxis(obj["letterbox"].toObject(), "sidesOnly", "sideLeds");
		pillarbox = readBarAxis(obj["pillarbox"].toObject(), "topBottomOnly", "topBottomLeds");
	}
	else if (obj.contains("lightAtBars"))
	{
		// first version of the setting (letterbox only, fill as a choice), normally migrated at startup
		letterbox = readBarAxis(obj, "sidesOnly", "sideLeds");
		letterbox.fillCorner = obj["barSideFill"].toString("dark") == "cornerColor";
	}
	if (letterbox == _barLetterbox && pillarbox == _barPillarbox)
	{
		return;
	}
	_barLetterbox = letterbox;
	_barPillarbox = pillarbox;
	const auto lightText = [](BarLight light, const char* beside) {
		return light == BarLight::Off ? "off" : light == BarLight::Beside ? beside : "normal";
	};
	Info(_log, "Picture with black bars at the top/bottom: light %s, side LEDs %s%s",
		 lightText(letterbox.light, "sides only"), letterbox.oneToOne ? "1:1" : "stretched",
		 letterbox.oneToOne ? (letterbox.fillCorner ? ", bar height in the corner colour" : ", bar height dark") : "");
	Info(_log, "Picture with black bars at the left/right: light %s, top/bottom LEDs %s%s",
		 lightText(pillarbox.light, "top/bottom only"), pillarbox.oneToOne ? "1:1" : "stretched",
		 pillarbox.oneToOne ? (pillarbox.fillCorner ? ", bar width in the corner colour" : ", bar width dark") : "");
	if (!_imageToLedColors.isNull())
	{
		// keep the current black border, the border detection only reports changes
		registerProcessingUnit(_imageToLedColors->width(), _imageToLedColors->height(),
		                       _imageToLedColors->horizontalBorder(), _imageToLedColors->verticalBorder());
	}
}

void ImageProcessor::updateLedEdges()
{
	// The picture edge each LED belongs to. LEDs far from every edge (a matrix behind the picture)
	// count as inner: never switched off as an edge row, mapped 1:1 in both directions.
	// The edge an LED's area comes closest to decides, not its centre: in a corner an LED of the side
	// column reaching deep into the picture has its centre nearer to the top than to the side, but its
	// area touches the side. Same distance (a corner LED touching both): the nearer centre decides,
	// and an exact corner belongs to the top/bottom row.
	constexpr double INNER_DISTANCE = 0.25;
	constexpr double SAME = 1e-3;
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
		if (qMin(qMin(cy, 1.0 - cy), qMin(cx, 1.0 - cx)) > INNER_DISTANCE)
		{
			continue;
		}
		const bool nearTop = cy <= 1.0 - cy;
		const bool nearLeft = cx <= 1.0 - cx;
		const double areaY = nearTop ? qMax(0.0, led.minY_frac) : qMax(0.0, 1.0 - led.maxY_frac);
		const double areaX = nearLeft ? qMax(0.0, led.minX_frac) : qMax(0.0, 1.0 - led.maxX_frac);
		const double centreY = nearTop ? cy : 1.0 - cy;
		const double centreX = nearLeft ? cx : 1.0 - cx;
		bool row;
		if (qAbs(areaY - areaX) > SAME)
		{
			row = areaY < areaX;
		}
		else
		{
			row = centreY <= centreX;
		}
		_ledEdge[i] = row ? (nearTop ? EdgeTop : EdgeBottom) : (nearLeft ? EdgeLeft : EdgeRight);
	}
}

QVector<bool> ImageProcessor::barFullHeightLeds(int horizontalBorder) const
{
	QVector<bool> fullHeight;
	if (horizontalBorder <= 0 || !_barLetterbox.oneToOne || _barLetterbox.light == BarLight::Off || _ledEdge.size() != _areaLeds.size())
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

QVector<bool> ImageProcessor::barFullWidthLeds(int verticalBorder) const
{
	QVector<bool> fullWidth;
	if (verticalBorder <= 0 || !_barPillarbox.oneToOne || _barPillarbox.light == BarLight::Off || _ledEdge.size() != _areaLeds.size())
	{
		return fullWidth;
	}
	fullWidth.fill(false, _ledEdge.size());
	for (int i = 0; i < _ledEdge.size(); ++i)
	{
		fullWidth[i] = _ledEdge[i] != EdgeLeft && _ledEdge[i] != EdgeRight;
	}
	return fullWidth;
}

void ImageProcessor::updateBarFillSources()
{
	_barFillSource.clear();
	const QVector<int>& barY = _imageToLedColors->barSide();
	const QVector<int>& barX = _imageToLedColors->barSideX();
	const int count = _ledEdge.size();
	if ((barY.isEmpty() && barX.isEmpty()) || (!barY.isEmpty() && barY.size() != count) || (!barX.isEmpty() && barX.size() != count))
	{
		return;
	}
	const auto inBarY = [&](int i) { return !barY.isEmpty() && barY[i] != 0; };
	const auto inBarX = [&](int i) { return !barX.isEmpty() && barX[i] != 0; };
	_barFillSource.fill(-2, count);
	for (int i = 0; i < count; ++i)
	{
		if (inBarY(i) || inBarX(i))
		{
			_barFillSource[i] = -1;
		}
	}

	// per edge and bar: the LED of the same edge in the picture nearest to that bar
	const auto fill = [&](const QVector<int>& bar, const QVector<double>& pos, int edge) {
		int first = -1, last = -1;
		for (int i = 0; i < count; ++i)
		{
			if (_ledEdge[i] != edge || inBarY(i) || inBarX(i) || pos[i] < 0)
			{
				continue;
			}
			if (first < 0 || pos[i] < pos[first]) first = i;
			if (last < 0 || pos[i] > pos[last]) last = i;
		}
		for (int i = 0; i < count; ++i)
		{
			if (_ledEdge[i] == edge && bar[i] != 0)
			{
				_barFillSource[i] = bar[i] < 0 ? first : last;
			}
		}
	};
	if (!barY.isEmpty() && _barLetterbox.fillCorner)
	{
		fill(barY, _imageToLedColors->centerRow(), EdgeLeft);
		fill(barY, _imageToLedColors->centerRow(), EdgeRight);
	}
	if (!barX.isEmpty() && _barPillarbox.fillCorner)
	{
		fill(barX, _imageToLedColors->centerCol(), EdgeTop);
		fill(barX, _imageToLedColors->centerCol(), EdgeBottom);
	}
}

void ImageProcessor::applyBarDisplay(QVector<ColorRgb>& colors, QVector<ColorRgbFloat>* means)
{
	const bool hBar = !_imageToLedColors.isNull() && _imageToLedColors->horizontalBorder() > 0;
	const bool vBar = !_imageToLedColors.isNull() && _imageToLedColors->verticalBorder() > 0;
	const bool allOff = (hBar && _barLetterbox.light == BarLight::Off) || (vBar && _barPillarbox.light == BarLight::Off);
	const bool rowsOff = hBar && _barLetterbox.light == BarLight::Beside;
	const bool sidesOff = vBar && _barPillarbox.light == BarLight::Beside;
	const bool withFill = (hBar || vBar) && _barFillSource.size() == colors.size();
	const bool active = allOff || rowsOff || sidesOff || withFill;
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
		if (allOff)
		{
			for (int i = 0; i < colors.size(); ++i) setDark(i);
		}
		else
		{
			// fill first: the sources are LEDs in the picture, their colour before anything is switched off
			if (withFill)
			{
				const QVector<ColorRgb> source = colors;
				const QVector<ColorRgbFloat> sourceMeans = withMeans ? *means : QVector<ColorRgbFloat>();
				for (int i = 0; i < colors.size(); ++i)
				{
					const int from = _barFillSource[i];
					if (from == -2)
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
			if ((rowsOff || sidesOff) && _ledEdge.size() == colors.size())
			{
				for (int i = 0; i < colors.size(); ++i)
				{
					const int edge = _ledEdge[i];
					if ((rowsOff && (edge == EdgeTop || edge == EdgeBottom)) || (sidesOff && (edge == EdgeLeft || edge == EdgeRight)))
					{
						setDark(i);
					}
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
	const auto lightText = [](BarLight light, const char* beside) {
		return QString(light == BarLight::Off ? "off" : light == BarLight::Beside ? beside : "normal");
	};
	QMutexLocker locker(&_barMutex);
	return QJsonObject{
		{ "letterbox", QJsonObject{
			{ "lightAtBars", lightText(_barLetterbox.light, "sidesOnly") },
			{ "sideLeds", _barLetterbox.oneToOne ? "oneToOne" : "stretched" },
			{ "fillCornerColor", _barLetterbox.fillCorner } } },
		{ "pillarbox", QJsonObject{
			{ "lightAtBars", lightText(_barPillarbox.light, "topBottomOnly") },
			{ "topBottomLeds", _barPillarbox.oneToOne ? "oneToOne" : "stretched" },
			{ "fillCornerColor", _barPillarbox.fillCorner } } },
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
