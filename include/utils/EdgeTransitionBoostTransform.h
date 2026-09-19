#pragma once

#include <QVector>

#include <utils/ColorRgb.h>
#include <utils/EdgeTransitionBoost.h>

///
/// Engine for EdgeTransitionBoost (fork extension, "LED-Bereichsuebergangs-
/// verstaerkung"). Operates on the full, already color-adjusted per-LED
/// array so it can see spatial neighbors along the strip -- unlike
/// GrayAxisTrimTransform, this cannot work pixel-by-pixel in isolation.
///
class EdgeTransitionBoostTransform
{
public:
	///
	/// Apply the edge-transition boost (if enabled) to the given LED
	/// colors, in place.
	///
	/// @param ledColors The final per-LED colors for this frame, updated in place
	/// @param settings   The profile's edge-transition-boost settings
	///
	static void apply(QVector<ColorRgb>& ledColors, const EdgeTransitionBoost& settings);
};
