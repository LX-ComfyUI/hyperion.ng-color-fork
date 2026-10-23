#pragma once

// fork: "No Signal" still image detection of the video grabber. Many capture cards show their own
// picture while no HDMI signal arrives (a logo, "No Signal" text, a counter) instead of a black
// frame. The user calibrates that picture once: the detector stores it as a coarse grid of cell
// means and later compares every decoded frame (before the grabber color correction) with it.
// A frame matches when nearly all cells are within the tolerance per color channel, the "feature"
// cells that are not black (text, logo, colored areas) included, so a dark film scene does not
// count as "no signal".
//
// Settings live in the global setting grabberTest:
//   noSignal: { enable, action: "black" (default) | "release", delay (s), tolerance (0-255),
//               match (%), grabbers: { "<device name>": { active, slots: [ slot | null, ... ] } } }
//   slot:     { name, savedAt, cols, rows, ref: base64 RGB per cell, unstable: base64 0/1 per cell }
// The frames of a device use the active slot of that device, so a grabber change switches the
// calibration by itself; a device without one is not checked.

#include <QJsonObject>
#include <QString>

#include <cstdint>
#include <vector>

#include <utils/ColorRgb.h>
#include <utils/Image.h>

class NoSignalDetector
{
public:
	enum class Verdict
	{
		Pass,  ///< forward the frame
		Drop,  ///< forward nothing: the capture input turns inactive, the next source takes over
		Black  ///< forward a black frame instead
	};

	static constexpr int COLS = 64;
	static constexpr int ROWS = 36;

	/// grabberTest = the whole global setting
	static void configure(const QJsonObject& grabberTest);

	/// Called by the video grabber for every decoded frame, before the color correction.
	static Verdict check(const Image<ColorRgb>& image, const QString& device);

	/// State for the WebUI and the test page; withImage adds a small JPEG of the newest frame.
	static QJsonObject status(bool withImage);

	/// Starts a calibration over the next durationMs; the result comes with calibration().
	static QJsonObject startCalibration(int durationMs);

	/// Progress of the running calibration, or its result (a slot without name) when done.
	static QJsonObject calibration();

	// --- the math, public for tests ---

	/// RGB mean per cell, row-major, COLS * ROWS * 3 bytes
	static std::vector<uint8_t> measureGrid(const Image<ColorRgb>& image);

	struct Reference
	{
		std::vector<uint8_t> ref;      ///< COLS * ROWS * 3
		std::vector<uint8_t> unstable; ///< COLS * ROWS, 1 = ignored
	};

	/// share of matching cells (0..1) over all checked cells and over the feature cells
	struct Match
	{
		double all = 0.0;
		double features = 1.0;
		int featureCells = 0;
		double score() const { return all < features ? all : features; }
	};
	static Match compare(const std::vector<uint8_t>& grid, const Reference& reference, int tolerance);

	/// a cell whose reference is this bright in any channel is a feature (text, logo, colored area)
	static constexpr int FEATURE_LEVEL = 24;
};
