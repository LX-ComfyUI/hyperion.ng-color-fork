#pragma once

#include <QVector>

///
/// One saturation "Stuetzstelle" (support/anchor point) of the gray-axis
/// trim's staged gain curve (fork feature 4b, "Grauachsen-Stufen"). Reached
/// via GrayAxisTrimTransform as: flat at this stop's gain from saturation 0
/// up to the first stop's `saturationUpTo`; linearly blended between two
/// consecutive stops' gains across the saturation span between them; and no
/// effect at all above the last stop's `saturationUpTo` (so strongly
/// saturated colors always stay completely untouched). The linear blend
/// between stops is deliberate, not a flat staircase: a hard step at a band
/// boundary reproduces the exact flicker bug fixed for the old
/// single-threshold cutoff (see DESIGN.md / commit a6c62488) whenever
/// saturation noise hovers around that boundary frame to frame.
///
struct GrayAxisTrimStop
{
	/// Okhsv saturation (0-1) up to which this stop's gain applies (see
	/// class comment for how stops combine into a curve).
	double saturationUpTo = 0.1;

	/// Multiplicative per-channel gain at this stop.
	double gainRed = 1.0;
	double gainGreen = 1.0;
	double gainBlue = 1.0;
};

///
/// Independent, saturation-gated gray-axis / white-balance trim (fork
/// feature 4, see DESIGN.md). Corrects near-neutral, low-chroma pixels
/// (e.g. concrete/asphalt under a tinted capture sensor) directly in RGB,
/// without touching saturated colors.
///
struct GrayAxisTrim
{
	bool enabled = false;

	/// Ordered list of saturation stops defining the staged gain curve (fork
	/// feature 4b). Sorted ascending by `saturationUpTo` when the config is
	/// parsed (see hyperion::createGrayAxisTrim) so the per-pixel transform
	/// can assume ordering without re-sorting every frame.
	QVector<GrayAxisTrimStop> stops = { { 0.0, 1.0, 1.0, 1.0 }, { 0.12, 1.0, 1.0, 1.0 } };
};
