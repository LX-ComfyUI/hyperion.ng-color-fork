#pragma once

#include <QString>
#include <QVector>
#include <QSharedPointer>
#include <QLoggingCategory>

// Utils includes
#include <utils/Image.h>

// Hyperion includes
#include <hyperion/LedString.h>
#include <hyperion/ImageToLedsMap.h>
#include <utils/Logger.h>

// settings
#include <utils/settings.h>

// Black border includes
#include <blackborder/BlackBorderProcessor.h>

// Gray still-image detector (fork extension)
#include <hyperion/GrayStillImageDetector.h>

Q_DECLARE_LOGGING_CATEGORY(imageProcessor_track);

class Hyperion;

///
/// The ImageProcessor translates an RGB-image to RGB-values for the LEDs. The processing is
/// performed in two steps. First the average color per led-region is computed. Second a
/// color-transform is applied based on a gamma-correction.
///
class ImageProcessor : public QObject
{
	Q_OBJECT

public:
	///
	/// Constructs an image-processor for translating an image to led-color values based on the
	/// given led-string specification
	///	@param[in] ledString    LedString data
	/// @param[in] hyperion     Hyperion instance pointer
	///
	explicit ImageProcessor(const LedString& ledString, const QSharedPointer<Hyperion>& hyperionInstance);
	~ImageProcessor() override;

	///
	/// Specifies the width and height of 'incoming' images. This will resize the buffer-image to
	/// match the given size.
	/// NB All earlier obtained references will be invalid.
	///
	/// @param[in] width   The new width of the buffer-image
	/// @param[in] height  The new height of the buffer-image
	///
	void setSize(int width, int height);

	///
	/// @brief Update the led string (eg on settings change)
	///
	void setLedString(const LedString& ledString);

	/// Returns state of black border detector
	bool blackBorderDetectorEnabled() const;

	///
	///  Factor to reduce the number of pixels evaluated during processing
	///
	/// @param[in] count  Use every "count" pixel
	void setReducedPixelSetFactorFactor(int count);

	///
	/// Set the accuracy used during processing
	/// (only for selected types)
	///
	/// @param[in] level  The accuracy level (0-4)
	void setAccuracyLevel(int level);

	/// Returns the current _userMappingType, this may not be the current applied type!
	int getUserLedMappingType() const { return _userMappingType; }

	/// Returns the current _mappingType
	int ledMappingType() const { return _mappingType; }

	static int mappingTypeToInt(const QString& mappingType);
	static QString mappingTypeToStr(int mappingType);

	///
	/// @brief Set the Hyperion::update() request LED mapping type. This type is used in favour of type set with setLedMappingType.
	/// 	   If you don't want to force a mapType set this to -1 (user choice will be set)
	/// @param  mapType   The new mapping type
	///
	void setHardLedMappingType(int mapType);

public slots:
	/// Enable or disable the black border detector based on component
	void setBlackbarDetectDisable(bool enable);

	///
	/// @brief Set the user requested led mapping.
	/// 	   The type set with setHardLedMappingType() will be used in favour to respect comp specific settings
	/// @param  mapType   The new mapping type
	///
	void setLedMappingType(int mapType);

public:
	///
	/// Specifies the width and height of 'incoming' images. This will resize the buffer-image to
	/// match the given size.
	/// NB All earlier obtained references will be invalid.
	///
	/// @param[in] image   The dimensions taken from image
	///
	template <typename Pixel_T>
	void setSize(const Image<Pixel_T> &image)
	{
		setSize(image.width(), image.height());
	}

	///
	/// Processes the image to a list of LED colors. This will update the size of the buffer-image
	/// if required and call the image-to-LEDs mapping to determine the color per LED.
	///
	/// @param[in] image  The image to translate to LED values
	/// @param[out] means  Fork extension, optional: the mean per LED with its fractions, for the
	///                    16-bit path. Empty when switched off (fractionalMean) or for the mapping
	///                    types "dominant color" (their result is a pixel color, no fractions).
	///                    LEDs the gray-still handling changed get NaN (no mean).
	///
	/// @return The color value per LED
	///
	template <typename Pixel_T>
	QVector<ColorRgb> process(const Image<Pixel_T>& image, QVector<ColorRgbFloat>* means = nullptr)
	{
		QVector<ColorRgb> colors;
		if (means != nullptr)
		{
			means->clear();
			if (!_fractionalMean)
			{
				means = nullptr;
			}
		}
		qCDebug(image_track) << "Image [" << image.id() << "]";

		if (image.width()>0 && image.height()>0)
		{
			// Ensure that the buffer-image is the proper size
			setSize(image);

			assert(!_imageToLedColors.isNull());

			// Check black border detection
			verifyBorder(image);

			// Create a result vector and call the 'in place' function
			switch (_mappingType)
			{
			case 1:
				colors = (means != nullptr) ? _imageToLedColors->getUniLedColor(image, *means)
				                            : _imageToLedColors->getUniLedColor(image);
				break;
			case 2:
				colors = (means != nullptr) ? _imageToLedColors->getMeanSqrtLedColor(image, *means)
				                            : _imageToLedColors->getMeanSqrtLedColor(image);
				break;
			case 3:
				colors = _imageToLedColors->getDominantLedColor(image);
				break;
			case 4:
				colors = _imageToLedColors->getDominantUniLedColor(image);
				break;
			case 5:
				colors = (means != nullptr) ? _imageToLedColors->getDominantAdvLedColor(image, *means)
				                            : _imageToLedColors->getDominantAdvLedColor(image);
				break;
			case 6:
				colors = (means != nullptr) ? _imageToLedColors->getDominantAdvUniLedColor(image, *means)
				                            : _imageToLedColors->getDominantAdvUniLedColor(image);
				break;
			default:
				colors = (means != nullptr) ? _imageToLedColors->getMeanLedColor(image, *means)
				                            : _imageToLedColors->getMeanLedColor(image);
			}

			// Fork extension: detect/handle a gray, dimmed still image (e.g. a paused
			// streaming player fading out) and override colors in place if confirmed
			const QVector<ColorRgb> mapped = (means != nullptr && !means->isEmpty()) ? colors : QVector<ColorRgb>();
			processGrayStill(image, colors);

			// Fork extension: LEDs the gray-still handling changed keep no mean
			if (!mapped.isEmpty() && mapped.size() == colors.size() && means->size() == colors.size())
			{
				for (int i = 0; i < colors.size(); ++i)
				{
					if (colors[i] != mapped[i])
					{
						(*means)[i] = ColorRgbFloat{ NAN, NAN, NAN };
					}
				}
			}
		}
		else
		{
			Warning(_log, "ImageProcessor::process called with image size 0");
		}

		// return the computed colors
		return colors;
	}

	///
	/// Determines the led colors of the image in the buffer.
	///
	/// @param[in] image  The image to translate to LED values
	/// @param[out] ledColors  The color value per LED
	///
	template <typename Pixel_T>
	void process(const Image<Pixel_T>& image, QVector<ColorRgb>& ledColors)
	{
		qCDebug(image_track).noquote() << "Image  [" << image.id() << "], ledColors";

		if ( image.width()>0 && image.height()>0)
		{
			// Ensure that the buffer-image is the proper size
			setSize(image);

			// Check black border detection
			verifyBorder(image);

			// Determine the mean or uni colors of each led (using the existing mapping)
			switch (_mappingType)
			{
			case 1:
				_imageToLedColors->getUniLedColor(image, ledColors);
				break;
			case 2:
				_imageToLedColors->getMeanSqrtLedColor(image, ledColors);
				break;
			case 3:
				_imageToLedColors->getDominantLedColor(image, ledColors);
				break;
			case 4:
				_imageToLedColors->getDominantUniLedColor(image, ledColors);
				break;
			case 5:
				_imageToLedColors->getDominantAdvLedColor(image, ledColors);
				break;
			case 6:
				_imageToLedColors->getDominantAdvUniLedColor(image, ledColors);
				break;

			default:
				_imageToLedColors->getMeanLedColor(image, ledColors);
			}

			// Fork extension: detect/handle a gray, dimmed still image (e.g. a paused
			// streaming player fading out) and override colors in place if confirmed
			processGrayStill(image, ledColors);
		}
		else
		{
			Warning(_log, "Called with image size 0");
		}
	}

	///
	/// Get the hscan and vscan parameters for a single LED
	///
	/// @param[in] led Index of the LED
	/// @param[out] hscanBegin begin of the hscan
	/// @param[out] hscanEnd end of the hscan
	/// @param[out] vscanBegin begin of the hscan
	/// @param[out] vscanEnd end of the hscan
	/// @return true if the parameters could be retrieved
	bool getScanParameters(size_t led, double & hscanBegin, double & hscanEnd, double & vscanBegin, double & vscanEnd) const;

	///
	/// Fork extension: state snapshot of the black-border and gray-still-image detectors for
	/// debugging tools (JSON-API command "forkdebug"). Thread safe.
	///
	QJsonObject getDebugState() const
	{
		return QJsonObject{
			{ "blackborder", _borderProcessor->debugState() },
			{ "grayStill", _grayStillDetector->debugState() }
		};
	}

private:

	///
	/// Fork extension: runs the gray-still-image detector, either on the LED colors or - with an
	/// edge width configured - on a sampled frame along the picture edges.
	///
	template <typename Pixel_T>
	void processGrayStill(const Image<Pixel_T>& image, QVector<ColorRgb>& ledColors)
	{
		const int edgePercent = _grayStillDetector->edgeWidthPercent();
		if (edgePercent <= 0)
		{
			_grayStillDetector->process(ledColors);
			return;
		}
		const QVector<ColorRgb> samples = grayStillEdgeSamples(image, edgePercent);
		_grayStillDetector->process(ledColors, &samples);
	}

	///
	/// Fork extension: mean colors of cells in a frame of `percent` depth along the edges of the
	/// picture, inside the applied black border (like the LED areas). Top and bottom strips are
	/// split into 16 cells, the side strips between them into 9, each cell sparsely sampled.
	///
	template <typename Pixel_T>
	QVector<ColorRgb> grayStillEdgeSamples(const Image<Pixel_T>& image, int percent) const
	{
		const int x0 = _imageToLedColors->verticalBorder();
		const int y0 = _imageToLedColors->horizontalBorder();
		const int w = image.width() - 2 * x0;
		const int h = image.height() - 2 * y0;
		QVector<ColorRgb> cells;
		if (w <= 0 || h <= 0)
		{
			return cells;
		}
		const int depthY = qMax(1, (h * percent + 50) / 100);
		const int depthX = qMax(1, (w * percent + 50) / 100);

		auto meanOf = [&image](int left, int top, int right, int bottom) {
			const int stepX = qMax(1, (right - left) / 16);
			const int stepY = qMax(1, (bottom - top) / 8);
			quint64 r = 0, g = 0, b = 0, n = 0;
			for (int y = top; y < bottom; y += stepY)
			{
				for (int x = left; x < right; x += stepX)
				{
					const Pixel_T& p = image(x, y);
					r += p.red; g += p.green; b += p.blue; ++n;
				}
			}
			ColorRgb c;
			if (n > 0)
			{
				c.red = static_cast<uint8_t>(r / n);
				c.green = static_cast<uint8_t>(g / n);
				c.blue = static_cast<uint8_t>(b / n);
			}
			return c;
		};

		constexpr int H_CELLS = 16;
		constexpr int V_CELLS = 9;
		cells.reserve(2 * H_CELLS + 2 * V_CELLS);
		for (int i = 0; i < H_CELLS; ++i)
		{
			const int left = x0 + w * i / H_CELLS;
			const int right = x0 + w * (i + 1) / H_CELLS;
			cells.append(meanOf(left, y0, right, y0 + depthY));                 // top
			cells.append(meanOf(left, y0 + h - depthY, right, y0 + h));         // bottom
		}
		const int sideTop = y0 + depthY;
		const int sideHeight = h - 2 * depthY;
		for (int i = 0; i < V_CELLS && sideHeight > 0; ++i)
		{
			const int top = sideTop + sideHeight * i / V_CELLS;
			const int bottom = sideTop + sideHeight * (i + 1) / V_CELLS;
			cells.append(meanOf(x0, top, x0 + depthX, bottom));                 // left
			cells.append(meanOf(x0 + w - depthX, top, x0 + w, bottom));         // right
		}
		return cells;
	}

	void registerProcessingUnit(
		int width,
		int height,
		int horizontalBorder,
		int verticalBorder);

	///
	/// Performs black-border detection (if enabled) on the given image
	///
	/// @param[in] image  The image to perform black-border detection on
	///
	template <typename Pixel_T>
	void verifyBorder(const Image<Pixel_T> & image)
	{
		if (!_borderProcessor->enabled() && ( _imageToLedColors->horizontalBorder()!=0 || _imageToLedColors->verticalBorder()!=0 ))
		{
			Debug(_log, "Black border disabled; resetting to no border");
			_borderProcessor->process(image);
			registerProcessingUnit(image.width(), image.height(), 0, 0);
		}

		if(_borderProcessor->enabled() && _borderProcessor->process(image))
		{
			const hyperion::BlackBorder border = _borderProcessor->getCurrentBorder();

			if (border.unknown)
			{
				qCDebug(imageProcessor_track) << "Detected unknown black border setup; resetting to no border";
				registerProcessingUnit(image.width(), image.height(), 0, 0);
			}
			else
			{
				if (border.horizontalSize != _imageToLedColors->horizontalBorder() || border.verticalSize != _imageToLedColors->verticalBorder())
				{
					qCDebug(imageProcessor_track) << "Detected change in black border setup - horizontal:" << border.horizontalSize << " vertical:" << border.verticalSize;
					registerProcessingUnit(image.width(), image.height(), border.horizontalSize, border.verticalSize);
				}
				else
				{
					qCDebug(imageProcessor_track) << "Border detection setup has not changed - horizontal:" << border.horizontalSize << " vertical:" << border.verticalSize;
				}
			}
		}
	}

private slots:
	void handleSettingsUpdate(settings::type type, const QJsonDocument& config);

private:
	/// Logger instance
	QSharedPointer<Logger> _log;

	/// The Led-string specification
	LedString _ledString;

	/// The processor for black border detection
	QScopedPointer <hyperion::BlackBorderProcessor> _borderProcessor;

	/// Fork extension: detector for a gray, dimmed still image (e.g. paused streaming players)
	QScopedPointer <hyperion::GrayStillImageDetector> _grayStillDetector;

	/// The mapping of image-pixels to LEDs
	QSharedPointer<hyperion::ImageToLedsMap> _imageToLedColors;

	/// Type of image to LED mapping
	int _mappingType;
	/// Type of last requested user type
	int _userMappingType;
	/// Type of last requested hard type
	int _hardMappingType;

	int _accuracyLevel;
	int _reducedPixelSetFactorFactor;

	/// Fork extension: hand the LED means with their fractions to the 16-bit path (setting
	/// color.fractionalMean)
	bool _fractionalMean;

	/// Hyperion instance pointer
	QWeakPointer<Hyperion> _hyperionWeak;
};
