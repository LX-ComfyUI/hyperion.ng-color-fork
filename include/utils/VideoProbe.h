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

	/// The device the grabber delivers frames from (also without a measurement) and how old its
	/// newest frame is; does not start a measurement.
	static QJsonObject current();
};

// fork: color correction of the video grabber, a 3x3 matrix the grabber test computes from the
// measured test colors. It undoes a color matrix mismatch of the capture chain (e.g. BT.709 sent,
// BT.601 decoded). Every row sums up to 1, so grays pass unchanged and gamma, white point and gray
// curve keep their calibration.
// Each grabber model (V4L2 device name) has its own calibrations in the global setting grabberTest:
//   grabbers: { "<device name>": { "enable": bool, "active": slot, "slots": [ { "matrix": [9] } | null, ... ] } }
// The frames of a device use the active slot of that device, so a grabber change switches the
// calibration by itself. Without "grabbers" the older single "correction" applies to every device.
class GrabberColorCorrection
{
public:
	/// grabberTest = the whole global setting; a matrix is 9 numbers, row-major, output = matrix * input
	static void configure(const QJsonObject& grabberTest);

	/// whether the latest frame was corrected
	static bool isActive();

	/// Writes the frame of device corrected to out. Returns false and leaves out alone while that
	/// device has no active correction.
	static bool apply(const Image<ColorRgb>& in, Image<ColorRgb>& out, const QString& device);
};
