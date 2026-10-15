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
	/// measurement was requested during the last seconds. corrected is the same frame after
	/// the grabber color correction, nullptr while the correction is off.
	static void offer(const Image<ColorRgb>& image, const QString& device, const Image<ColorRgb>* corrected = nullptr);

	/// Keeps the measurement running for the next seconds and returns the latest frame and
	/// the average of all frames since the last reset. With reset the average starts anew.
	static QJsonObject sample(bool reset);
};

// fork: color correction of the video grabber, a 3x3 matrix the grabber test computes from the
// measured test colors (global setting grabberTest.correction). It undoes a color matrix mismatch
// of the capture chain (e.g. BT.709 sent, BT.601 decoded). Every row sums up to 1, so grays pass
// unchanged and gamma, white point and gray curve keep their calibration.
class GrabberColorCorrection
{
public:
	/// correction = { "enable": bool, "matrix": [9 numbers, row-major, output = matrix * input] }
	static void configure(const QJsonObject& correction);

	static bool isActive();

	/// Writes the corrected frame to out. Returns false and leaves out alone while the correction is off.
	static bool apply(const Image<ColorRgb>& in, Image<ColorRgb>& out);
};
