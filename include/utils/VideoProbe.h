#pragma once

// fork: grabber test. Measures the frames of the video grabber as they are decoded, before
// the signal detection and long before any calibration (color profile, gamma, gray curve),
// so the test page can see how the capture card reproduces its test colors.

#include <QJsonObject>
#include <QString>

#include <utils/ColorRgb.h>
#include <utils/Image.h>

class VideoProbe
{
public:
	/// Called by the video grabber for every decoded frame. Does nothing unless a
	/// measurement was requested during the last seconds.
	static void offer(const Image<ColorRgb>& image, const QString& device);

	/// Keeps the measurement running for the next seconds and returns the latest frame and
	/// the average of all frames since the last reset. With reset the average starts anew.
	static QJsonObject sample(bool reset);
};
