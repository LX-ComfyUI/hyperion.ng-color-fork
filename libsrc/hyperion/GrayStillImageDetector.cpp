#include <hyperion/GrayStillImageDetector.h>

#include <algorithm>
#include <cstdlib>

#include <QJsonObject>

#include <hyperion/Hyperion.h>

using namespace hyperion;

GrayStillImageDetector::GrayStillImageDetector(const QSharedPointer<Hyperion>& hyperionInstance, QObject* parent)
	: QObject(parent)
	, _hyperionWeak(hyperionInstance)
	, _enabled(false)
	, _stillTimeSeconds(5)
	, _brightnessDropThreshold(40)
	, _dropWindowSeconds(1.0)
	, _changeThreshold(6)
	, _mode("freeze")
	, _hasPrevColors(false)
	, _stillActive(false)
	, _dropWindowStartBrightness(0.0)
	, _dropWindowActive(false)
	, _triggered(false)
	, _minBrightnessSinceTrigger(0.0)
{
	QString subComponent{ "__" };

	QSharedPointer<Hyperion> hyperion = _hyperionWeak.toStrongRef();
	if (hyperion)
	{
		subComponent = hyperion->property("instance").toString();
	}
	_log = Logger::getInstance("GRAYSTILL", subComponent);

	if (hyperion)
	{
		// init
		handleSettingsUpdate(settings::BLACKBORDER, hyperion->getSetting(settings::BLACKBORDER));

		// listen for settings updates (gray-still-image detection lives inside the
		// black-border detector's settings section, see schema-blackborderdetector.json)
		connect(hyperion.get(), &Hyperion::settingsChanged, this, &GrayStillImageDetector::handleSettingsUpdate);
	}
}

GrayStillImageDetector::~GrayStillImageDetector()
{
}

void GrayStillImageDetector::handleSettingsUpdate(settings::type type, const QJsonDocument& config)
{
	if (type == settings::BLACKBORDER)
	{
		const QJsonObject& obj = config.object()["grayStillImageDetector"].toObject();

		_enabled                  = obj["enabled"].toBool(false);
		_stillTimeSeconds         = obj["stillTimeSeconds"].toInt(5);
		_brightnessDropThreshold  = obj["brightnessDropThreshold"].toInt(40);
		_dropWindowSeconds        = obj["dropWindowSeconds"].toDouble(1.0);
		_changeThreshold          = obj["changeThreshold"].toInt(6);
		_mode                     = obj["mode"].toString("freeze");

		if (!_enabled)
		{
			reset();
		}

		Debug(_log, "Gray still-image detector is %s (still>=%ds, drop>=%d/%.1fs, changeTol=%d, mode=%s)",
			(_enabled ? "enabled" : "disabled"), _stillTimeSeconds, _brightnessDropThreshold, _dropWindowSeconds, _changeThreshold, QSTRING_CSTR(_mode));
	}
}

void GrayStillImageDetector::reset()
{
	_hasPrevColors = false;
	_stillActive = false;
	_dropWindowActive = false;
	_triggered = false;
}

double GrayStillImageDetector::meanBrightness(const QVector<ColorRgb>& colors) const
{
	if (colors.isEmpty())
	{
		return 0.0;
	}

	quint64 brightnessSum = 0;
	for (const ColorRgb& c : colors)
	{
		brightnessSum += std::max({ c.red, c.green, c.blue });
	}
	return static_cast<double>(brightnessSum) / colors.size();
}

bool GrayStillImageDetector::hasChanged(const QVector<ColorRgb>& colors) const
{
	if (!_hasPrevColors || _prevColors.size() != colors.size())
	{
		return true;
	}

	quint64 deltaSum = 0;
	for (int i = 0; i < colors.size(); ++i)
	{
		const ColorRgb& a = _prevColors[i];
		const ColorRgb& b = colors[i];
		deltaSum += std::abs(int(a.red) - int(b.red)) + std::abs(int(a.green) - int(b.green)) + std::abs(int(a.blue) - int(b.blue));
	}
	const double meanDelta = (static_cast<double>(deltaSum) / colors.size()) / 3.0;
	return meanDelta > _changeThreshold;
}

void GrayStillImageDetector::applyReaction(QVector<ColorRgb>& ledColors) const
{
	if (_mode == "off" || _lastGoodColors.size() != ledColors.size())
	{
		std::fill(ledColors.begin(), ledColors.end(), ColorRgb::BLACK);
	}
	else
	{
		ledColors = _lastGoodColors;
	}
}

void GrayStillImageDetector::process(QVector<ColorRgb>& ledColors)
{
	if (!_enabled || ledColors.isEmpty())
	{
		reset();
		return;
	}

	// Snapshot of the raw, incoming per-frame colors - used for change/brightness evaluation,
	// independent of whatever we might overwrite ledColors with below.
	const QVector<ColorRgb> raw = ledColors;
	const double brightness = meanBrightness(raw);

	const bool dropThresholdDisabled = (_brightnessDropThreshold <= 0);

	if (_triggered)
	{
		const bool changed = hasChanged(raw);

		// With the brightness-drop requirement disabled, "recovered" has no
		// meaning (there was no drop to recover from) -- release relies
		// solely on `changed` in that case. Without this guard, the formula
		// below would evaluate true on the very frame it triggers (delta 0
		// >= threshold 0), immediately undoing the reaction every frame.
		bool recovered = false;
		if (!dropThresholdDisabled)
		{
			if (brightness < _minBrightnessSinceTrigger)
			{
				_minBrightnessSinceTrigger = brightness;
			}
			recovered = (brightness - _minBrightnessSinceTrigger) >= _brightnessDropThreshold;
		}

		_prevColors = raw;
		_hasPrevColors = true;

		if (changed || recovered)
		{
			// real content resumed (composition changed) or brightness recovered - back to normal
			reset();
			_lastGoodColors = raw;
			return;
		}

		applyReaction(ledColors);
		return;
	}

	const bool changed = hasChanged(raw);
	_prevColors = raw;
	_hasPrevColors = true;

	if (changed)
	{
		_stillActive = false;
		_dropWindowActive = false;
		_lastGoodColors = raw;
		return;
	}

	// image is static relative to the previous frame
	if (!_stillActive)
	{
		_stillActive = true;
		_stillTimer.start();
		_dropWindowActive = false;
	}

	if (!_stillTimer.hasExpired(static_cast<qint64>(_stillTimeSeconds) * 1000))
	{
		// not yet confirmed as a genuine still image - keep tracking as last good
		_lastGoodColors = raw;
		return;
	}

	// confirmed still image
	if (dropThresholdDisabled)
	{
		// No brightness-drop requirement configured: stage 1 alone is enough,
		// whether or not the still image ever dims.
		_triggered = true;
		_minBrightnessSinceTrigger = brightness;
		Debug(_log, "Gray still image confirmed (still for %ds, brightness-drop requirement disabled) - applying mode '%s'",
			_stillTimeSeconds, QSTRING_CSTR(_mode));
		applyReaction(ledColors);
		return;
	}

	// now watch for a sudden brightness drop
	if (!_dropWindowActive || _dropWindowTimer.hasExpired(static_cast<qint64>(_dropWindowSeconds * 1000.0)))
	{
		_dropWindowStartBrightness = brightness;
		_dropWindowTimer.start();
		_dropWindowActive = true;
	}

	if (_dropWindowStartBrightness - brightness >= _brightnessDropThreshold)
	{
		_triggered = true;
		_minBrightnessSinceTrigger = brightness;
		Debug(_log, "Gray still image confirmed (still for %ds, brightness dropped by >=%d within %.1fs) - applying mode '%s'",
			_stillTimeSeconds, _brightnessDropThreshold, _dropWindowSeconds, QSTRING_CSTR(_mode));
		applyReaction(ledColors);
		return;
	}

	// still static, no sudden drop (yet) - keep passing through, keep tracking as last good
	_lastGoodColors = raw;
}
