#pragma once

// Utils includes
#include <utils/Image.h>
#include <QString>
#include <initializer_list>

namespace hyperion
{
	///
	/// Result structure of the detected blackborder.
	///
	struct BlackBorder
	{
		/// Flag indicating if the border is unknown
		bool unknown;

		/// The size of the detected horizontal border
		int horizontalSize;

		/// The size of the detected vertical border
		int verticalSize;

		///
		/// Compares this BlackBorder to the given other BlackBorder
		///
		/// @param[in] other  The other BlackBorder
		///
		/// @return True if this is the same border as other
		///
		inline bool operator== (const BlackBorder& other) const
		{
			if (unknown)
			{
				return other.unknown;
			}

			return other.unknown==false && horizontalSize==other.horizontalSize && verticalSize==other.verticalSize;
		}
	};

	///
	/// Fork extension: the brightest colour channel (0-255) at the outermost picture edge, where the
	/// detection mode looks for bars. A bar can only be detected while this stays below the black
	/// threshold. -1 = this edge is not checked by the mode.
	///
	struct EdgeLevels
	{
		int top = -1;
		int bottom = -1;
		int left = -1;
		int right = -1;

		void raise(const EdgeLevels& other)
		{
			top = qMax(top, other.top);
			bottom = qMax(bottom, other.bottom);
			left = qMax(left, other.left);
			right = qMax(right, other.right);
		}
	};
	///
	/// The BlackBorderDetector performs detection of black-borders on a single image.
	/// The detector will search for the upper left corner of the picture in the frame.
	/// Based on detected black pixels it will give an estimate of the black-border.
	///
	class BlackBorderDetector
	{
	public:
		///
		/// Constructs a black-border detector
		/// @param[in] threshold The threshold which the black-border detector should use
		///
		BlackBorderDetector(double threshold);

		///
		/// Performs the actual black-border detection on the given image
		///
		/// @param[in] image  The image on which detection is performed
		///
		/// @return The detected (or not detected) black border info
		///

		uint8_t calculateThreshold(double blackborderThreshold) const;

		///
		/// default detection mode (3lines 4side detection)
		template <typename Pixel_T>
		BlackBorder process(const Image<Pixel_T> & image) const
		{
			qCDebug(image_track) << "Image [" << image.id() << "]";
			// test centre and 33%, 66% of width/height
			// 33 and 66 will check left and top
			// centre will check right and bottom sides
			int width = image.width();
			int height = image.height();
			int width33percent = width / 3;
			int height33percent = height / 3;
			int width66percent = width33percent * 2;
			int height66percent = height33percent * 2;
			int xCenter = width / 2;
			int yCenter = height / 2;


			int firstNonBlackXPixelIndex = -1;
			int firstNonBlackYPixelIndex = -1;

			width--; // remove 1 pixel to get end pixel index
			height--;

			// find first X pixel of the image
			for (int x = 0; x < width33percent; ++x)
			{
				if (!isBlack(image((width - x), yCenter))
					|| !isBlack(image(x, height33percent))
				 	|| !isBlack(image(x, height66percent)))
				{
					firstNonBlackXPixelIndex = x;
					break;
				}
			}

			// find first Y pixel of the image
			for (int y = 0; y < height33percent; ++y)
			{
				if (!isBlack(image(xCenter, (height - y)))
					|| !isBlack(image(width33percent, y))
					|| !isBlack(image(width66percent, y)))
				{
					firstNonBlackYPixelIndex = y;
					break;
				}
			}

			// Construct result
			BlackBorder detectedBorder{};
			detectedBorder.unknown = firstNonBlackXPixelIndex == -1 || firstNonBlackYPixelIndex == -1;
			detectedBorder.horizontalSize = firstNonBlackYPixelIndex;
			detectedBorder.verticalSize = firstNonBlackXPixelIndex;
			return detectedBorder;
		}


		///
		/// classic detection mode (topleft single line mode)
		template <typename Pixel_T>
		BlackBorder process_classic(const Image<Pixel_T> & image) const
		{
			qCDebug(image_track) <<"Image [" << image.id() << "]";
			// only test the topleft third of the image
			int width = image.width() /3;
			int height = image.height() / 3;
			int maxSize = qMax(width, height);

			int firstNonBlackXPixelIndex = -1;
			int firstNonBlackYPixelIndex = -1;

			// find some pixel of the image
			for (int i = 0; i < maxSize; ++i)
			{
				int x = qMin(i, width);
				int y = qMin(i, height);

				const Pixel_T & color = image(x, y);
				if (!isBlack(color))
				{
					firstNonBlackXPixelIndex = x;
					firstNonBlackYPixelIndex = y;
					break;
				}
			}

			// expand image to the left
			for(; firstNonBlackXPixelIndex > 0; --firstNonBlackXPixelIndex)
			{
				const Pixel_T & color = image(firstNonBlackXPixelIndex-1, firstNonBlackYPixelIndex);
				if (isBlack(color))
				{
					break;
				}
			}

			// expand image to the top
			for(; firstNonBlackYPixelIndex > 0; --firstNonBlackYPixelIndex)
			{
				const Pixel_T & color = image(firstNonBlackXPixelIndex, firstNonBlackYPixelIndex-1);
				if (isBlack(color))
				{
					break;
				}
			}

			// Construct result
			BlackBorder detectedBorder{};
			detectedBorder.unknown = firstNonBlackXPixelIndex == -1 || firstNonBlackYPixelIndex == -1;
			detectedBorder.horizontalSize = firstNonBlackYPixelIndex;
			detectedBorder.verticalSize = firstNonBlackXPixelIndex;
			return detectedBorder;
		}


		///
		/// osd detection mode (find x then y at detected x to avoid changes by osd overlays)
		template <typename Pixel_T>
		BlackBorder process_osd(const Image<Pixel_T> & image) const
		{
			qCDebug(image_track) << "Image [" << image.id() << "]";

			// find X position at height33 and height66 we check from the left side, Ycenter will check from right side
			// then we try to find a pixel at this X position from top and bottom and right side from top
			int width = image.width();
			int height = image.height();
			int width33percent = width / 3;
			int height33percent = height / 3;
			int height66percent = height33percent * 2;
			int yCenter = height / 2;


			int firstNonBlackXPixelIndex = -1;
			int firstNonBlackYPixelIndex = -1;

			width--; // remove 1 pixel to get end pixel index
			height--;

			// find first X pixel of the image
			int x;
			for (x = 0; x < width33percent; ++x)
			{
				if (!isBlack(image((width - x), yCenter))
					|| !isBlack(image(x, height33percent))
					|| !isBlack(image(x, height66percent)))
				{
					firstNonBlackXPixelIndex = x;
					break;
				}
			}

			// find first Y pixel of the image
			for (int y = 0; y < height33percent; ++y)
			{
				// left side top + left side bottom + right side top  +  right side bottom
				if (!isBlack(image(x, y))
					|| !isBlack(image(x, (height - y)))
					|| !isBlack(image((width - x), y))
					|| !isBlack(image((width - x), (height - y))))
				{
					firstNonBlackYPixelIndex = y;
					break;
				}
			}

			// Construct result
			BlackBorder detectedBorder{};
			detectedBorder.unknown = firstNonBlackXPixelIndex == -1 || firstNonBlackYPixelIndex == -1;
			detectedBorder.horizontalSize = firstNonBlackYPixelIndex;
			detectedBorder.verticalSize = firstNonBlackXPixelIndex;
			return detectedBorder;
		}


		///
		/// letterbox detection mode (5lines top-bottom only detection)
		template <typename Pixel_T>
		BlackBorder process_letterbox(const Image<Pixel_T> & image) const
		{
			qCDebug(image_track) << "Image [" << image.id() << "]";
			// test center and 25%, 75% of width
			// 25 and 75 will check both top and bottom
			// center will only check top (minimise false detection of captions)
			int width = image.width();
			int height = image.height();
			int width25percent = width / 4;
			int height33percent = height / 3;
			int width75percent = width25percent * 3;
			int xCenter = width / 2;


			int firstNonBlackYPixelIndex = -1;

			height--; // remove 1 pixel to get end pixel index

			// find first Y pixel of the image
			for (int y = 0; y < height33percent; ++y)
			{
				if (!isBlack(image(xCenter, y))
					|| !isBlack(image(width25percent, y))
					|| !isBlack(image(width75percent, y))
					|| !isBlack(image(width25percent, (height - y)))
					|| !isBlack(image(width75percent, (height - y))))
				{
					firstNonBlackYPixelIndex = y;
					break;
				}
			}

			// Construct result
			BlackBorder detectedBorder{};
			detectedBorder.unknown = firstNonBlackYPixelIndex == -1;
			detectedBorder.horizontalSize = firstNonBlackYPixelIndex;
			detectedBorder.verticalSize = 0;
			return detectedBorder;
		}



		///
		/// Fork extension: edge levels of one image (see EdgeLevels), measured in a band of 1 % of the
		/// height (top/bottom) or width (left/right), at least one pixel, at the columns/rows the mode
		/// checks. For "osd", top/bottom are measured at the given vertical border.
		///
		template <typename Pixel_T>
		EdgeLevels edgeLevels(const Image<Pixel_T> & image, const QString & mode, int verticalBorder = 0) const
		{
			EdgeLevels levels;
			const int width = image.width();
			const int height = image.height();
			if (width < 4 || height < 4)
			{
				return levels;
			}
			const int bandY = qMax(1, height / 100);
			const int bandX = qMax(1, width / 100);
			const auto level = [](const Pixel_T & p) { return int(qMax(p.red, qMax(p.green, p.blue))); };
			const auto rowsAt = [&](std::initializer_list<int> xs, bool bottom) {
				int v = 0;
				for (int x : xs)
				{
					x = qBound(0, x, width - 1);
					for (int d = 0; d < bandY; ++d)
					{
						v = qMax(v, level(image(x, bottom ? height - 1 - d : d)));
					}
				}
				return v;
			};
			const auto colsAt = [&](std::initializer_list<int> ys, bool right) {
				int v = 0;
				for (int y : ys)
				{
					y = qBound(0, y, height - 1);
					for (int d = 0; d < bandX; ++d)
					{
						v = qMax(v, level(image(right ? width - 1 - d : d, y)));
					}
				}
				return v;
			};

			if (mode == "classic")
			{
				// one diagonal from the top left corner
				int v = 0;
				for (int d = 0; d < qMax(bandX, bandY); ++d)
				{
					v = qMax(v, level(image(qMin(d, width - 1), qMin(d, height - 1))));
				}
				levels.top = levels.left = v;
			}
			else if (mode == "letterbox")
			{
				levels.top = rowsAt({ width / 4, width / 2, width / 4 * 3 }, false);
				levels.bottom = rowsAt({ width / 4, width / 4 * 3 }, true);
			}
			else if (mode == "osd")
			{
				const int x = qBound(0, verticalBorder, width / 3);
				levels.top = rowsAt({ x, width - 1 - x }, false);
				levels.bottom = rowsAt({ x, width - 1 - x }, true);
				levels.left = colsAt({ height / 3, height / 3 * 2 }, false);
				levels.right = colsAt({ height / 2 }, true);
			}
			else
			{
				levels.top = rowsAt({ width / 3, width / 3 * 2 }, false);
				levels.bottom = rowsAt({ width / 2 }, true);
				levels.left = colsAt({ height / 3, height / 3 * 2 }, false);
				levels.right = colsAt({ height / 2 }, true);
			}
			return levels;
		}

		/// Fork extension: the black threshold in colour steps, a channel below it counts as black
		int blackLevel() const { return _blackborderThreshold; }

	private:

		///
		/// Checks if a given color is considered black and therefore could be part of the border.
		///
		/// @param[in] color  The color to check
		///
		/// @return True if the color is considered black else false
		///
		template <typename Pixel_T>
		inline bool isBlack(const Pixel_T & color) const
		{
			// Return the simple compare of the color against black
			return color.red < _blackborderThreshold && color.green < _blackborderThreshold && color.blue < _blackborderThreshold;
		}

	private:
		/// Threshold for the black-border detector [0 .. 255]
		const uint8_t _blackborderThreshold;

	};
} // end namespace hyperion
