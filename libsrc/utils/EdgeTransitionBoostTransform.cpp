#include <cmath>
#include <algorithm>

#include <utils/EdgeTransitionBoostTransform.h>

namespace
{
	inline double clamp01(double value)
	{
		return std::max(0.0, std::min(value, 1.0));
	}

	inline int brightness(const ColorRgb& c)
	{
		return std::max({ static_cast<int>(c.red), static_cast<int>(c.green), static_cast<int>(c.blue) });
	}

	/// Raised-cosine falloff across the boosted LED width: 1.0 right at the
	/// edge (k=0), smoothly down to (but never quite reaching) 0 once k
	/// reaches `width` -- same shape convention used elsewhere in this fork
	/// for edge-less blending (see DESIGN.md).
	inline double spatialWeight(int k, int width)
	{
		if (width <= 0)
		{
			return 0.0;
		}
		const double a = static_cast<double>(k) / width;
		if (a >= 1.0)
		{
			return 0.0;
		}
		return 0.5 * (1.0 + std::cos(a * M_PI));
	}

	/// "Screen" blend: lifts a channel toward 255, scaled by its remaining
	/// headroom -- self-limiting by construction (can never overflow, and
	/// naturally tapers off as the channel nears full brightness) instead of
	/// a flat multiplicative gain that would clip/blow out bright scenes.
	inline uint8_t boostChannel(uint8_t value, double intensity)
	{
		const double boosted = value + (255.0 - value) * clamp01(intensity);
		return static_cast<uint8_t>(std::lround(std::min(255.0, boosted)));
	}
}

void EdgeTransitionBoostTransform::apply(QVector<ColorRgb>& ledColors, const EdgeTransitionBoost& settings)
{
	const int n = ledColors.size();
	if (!settings.enabled || n < 2 || settings.ledWidth <= 0)
	{
		return;
	}

	// Per-LED boost weight, in [0,1]. Accumulated as the *strongest* nearby
	// edge's contribution, not summed -- an isolated bright LED sitting
	// between two dark neighbors should get one strong boost, not a
	// runaway double one from both sides at once.
	QVector<double> weight(n, 0.0);
	const double sensitivity = static_cast<double>(std::max(1, settings.edgeSensitivity));

	for (int i = 0; i + 1 < n; ++i)
	{
		const int drop = brightness(ledColors[i]) - brightness(ledColors[i + 1]);
		const double edgeStrength = clamp01(std::abs(drop) / sensitivity);
		if (edgeStrength <= 0.0)
		{
			continue;
		}

		if (drop > 0)
		{
			// LED i is the bright side, i+1 is darker: boost the LEDs
			// approaching the boundary from the bright side, i.e. i, i-1, ...
			for (int k = 0; k < settings.ledWidth; ++k)
			{
				const int idx = i - k;
				if (idx < 0)
				{
					break;
				}
				const double w = spatialWeight(k, settings.ledWidth) * edgeStrength;
				if (w > weight[idx])
				{
					weight[idx] = w;
				}
			}
		}
		else
		{
			// LED i+1 is the bright side, i is darker: boost i+1, i+2, ...
			for (int k = 0; k < settings.ledWidth; ++k)
			{
				const int idx = i + 1 + k;
				if (idx >= n)
				{
					break;
				}
				const double w = spatialWeight(k, settings.ledWidth) * edgeStrength;
				if (w > weight[idx])
				{
					weight[idx] = w;
				}
			}
		}
	}

	for (int i = 0; i < n; ++i)
	{
		if (weight[i] <= 0.0)
		{
			continue;
		}
		const double intensity = weight[i] * settings.boostStrength;
		if (intensity <= 0.0)
		{
			continue;
		}

		ColorRgb& c = ledColors[i];
		c.red   = boostChannel(c.red,   intensity);
		c.green = boostChannel(c.green, intensity);
		c.blue  = boostChannel(c.blue,  intensity);
	}
}
