#pragma once

///
/// Fork extension: settings for boosting the last few LEDs on the bright
/// side of a sharp brightness edge (e.g. a saturated object against a dark
/// or black background), where Hyperion otherwise often renders a dull,
/// slightly off-colored ("dunkles Roeteln") transition. See
/// EdgeTransitionBoostTransform for the actual per-frame math.
///
struct EdgeTransitionBoost
{
	bool enabled = false;

	/// Number of LEDs, counted backward from a detected edge into the
	/// bright region, that get boosted. Range 1-3.
	int ledWidth = 2;

	/// Brightness step (0-255, same scale as GrayStillImageDetector's
	/// brightnessDropThreshold) between two adjacent LEDs at/above which a
	/// transition counts as a full-strength edge. Below this, edge strength
	/// ramps up continuously from 0 rather than switching on/off at a hard
	/// cutoff -- same anti-flicker reasoning as GrayAxisTrim's smoothing.
	int edgeSensitivity = 60;

	/// Overall intensity multiplier on top of the per-LED spatial falloff
	/// and the headroom-aware brightening curve. 1.0 = normal strength,
	/// 0.0 = no effect, up to 2.0 = double strength.
	double boostStrength = 1.0;
};
