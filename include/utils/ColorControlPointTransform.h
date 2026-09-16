#pragma once

#include <cstdint>
#include <QVector>

#include <utils/ColorControlPoint.h>

///
/// Per-point runtime state for the luma gate's hysteresis + debounce, one
/// entry per ColorControlPoint on a given ColorAdjustment profile. Lives
/// alongside the profile (see ColorAdjustment::_gateStates) so it persists
/// frame to frame; it is a v1 simplification that this state is shared by
/// every LED using that profile rather than tracked per physical LED --
/// documented in DESIGN.md.
///
struct ColorControlPointGateState
{
	bool active = false;
	uint8_t consecutiveFrames = 0;
};

///
/// Engine that applies a list of ColorControlPoint entries plus an optional
/// GrayAxisTrim to one pixel at a time, operating in Okhsv space via
/// ColorSys::rgb2okhsv/okhsv2rgb.
///
/// Design choice: when a pixel's hue falls in more than one point's
/// influence window, the *nearest* point wins outright rather than blending
/// multiple points' shifts together -- blending independently-configured
/// hue shifts from two points can cancel or double up in ways that are hard
/// to reason about. Within that single nearest point's window, effect
/// strength still eases smoothly to 0 at the edge, so there is no hard seam
/// between points.
///
class ColorControlPointTransform
{
public:
	///
	/// Apply the gray-axis trim (if enabled) and then the control points
	/// (if any) to a single pixel, in place.
	///
	/// @param red, green, blue     The pixel, updated in place
	/// @param points                The profile's control points (may be empty)
	/// @param gateStates            Parallel per-point gate state, same size as points
	/// @param trim                  The profile's gray-axis trim
	///
	static void apply(uint8_t & red, uint8_t & green, uint8_t & blue,
	                   const QVector<ColorControlPoint> & points,
	                   QVector<ColorControlPointGateState> & gateStates,
	                   const GrayAxisTrim & trim);

private:
	/// Shortest signed circular distance from `hue` to `center`, turns in [-0.5, 0.5].
	static double circularDistance(double hue, double center);

	/// Raised-cosine falloff, 1.0 at distance 0, 0.0 at |distance| >= influence.
	static double falloffWeight(double distance, double influence);
};
