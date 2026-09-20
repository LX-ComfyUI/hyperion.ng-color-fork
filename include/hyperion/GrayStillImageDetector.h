#pragma once

// QT includes
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QVector>
#include <QSharedPointer>
#include <QWeakPointer>

// util
#include <utils/ColorRgb.h>
#include <utils/Logger.h>
#include <utils/settings.h>

class Hyperion;

namespace hyperion
{
	///
	/// @brief Fork extension: detects a "gray still image" as produced by streaming players
	/// (e.g. YouTube and similar) that fade a paused video to a gray, dimmed still image after
	/// a while. Operates on the already mapped per-LED colors (cheap, mapping-mode agnostic)
	/// instead of scanning the raw image.
	///
	/// Detection happens in up to two stages:
	///  1. The image must stay unchanged (within a noise tolerance) without interruption for
	///     `stillTimeSeconds` - this distinguishes a genuinely paused/still image from normal
	///     motion (incl. dark/desaturated motion, which must NOT trigger).
	///  2. Once that stillness is confirmed, the average brightness is watched for a sudden drop
	///     (`brightnessDropThreshold` within `dropWindowSeconds`) - this is the actual "player is
	///     fading out to standby" event.
	///
	/// `brightnessDropThreshold` can be set to 0 to disable stage 2 entirely: the reaction then
	/// applies as soon as stage 1 alone confirms a still image, whether or not it ever dims - for
	/// players that pause on an unchanged, still-bright frame instead of fading to a dark standby.
	///
	/// Only once all enabled stages are satisfied does the configured reaction (freeze the last
	/// real colors, or force the LEDs to black) apply - in place, on the given LED colors. It
	/// releases again as soon as the image changes (real content resumed), or - only while
	/// `brightnessDropThreshold` is > 0 - as soon as the brightness recovers from its post-trigger
	/// low point. The LEDs never freeze permanently.
	///
	class GrayStillImageDetector : public QObject
	{
		Q_OBJECT
	public:
		explicit GrayStillImageDetector(const QSharedPointer<Hyperion>& hyperionInstance, QObject* parent = nullptr);
		~GrayStillImageDetector() override;

		///
		/// @brief Evaluate/apply the gray-still-image detection in place on the given LED colors.
		/// @param ledColors The freshly computed LED colors for the current frame; may be overwritten
		///                  in place if a gray still image has been detected and confirmed.
		///
		void process(QVector<ColorRgb>& ledColors);

	private slots:
		void handleSettingsUpdate(settings::type type, const QJsonDocument& config);

	private:
		void reset();
		double meanBrightness(const QVector<ColorRgb>& colors) const;
		bool hasChanged(const QVector<ColorRgb>& colors) const;
		void applyReaction(QVector<ColorRgb>& ledColors) const;

		/// Hyperion instance
		QWeakPointer<Hyperion> _hyperionWeak;

		/// Logger instance
		QSharedPointer<Logger> _log;

		/// flag for gray-still-image detector usage
		bool _enabled;

		/// how long the image must stay unchanged before watching for a brightness drop
		int _stillTimeSeconds;

		/// minimum brightness drop (0-255) within the drop window to count as "sudden";
		/// 0 disables the brightness-drop requirement entirely (see class comment)
		int _brightnessDropThreshold;

		/// time window within which the drop must happen to count as "sudden"
		double _dropWindowSeconds;

		/// average per-LED color change (0-255) above which an image counts as "changed"
		int _changeThreshold;

		/// reaction once confirmed: "freeze" or "off"
		QString _mode;

		/// previous frame's raw (pre-reaction) LED colors, for change detection
		QVector<ColorRgb> _prevColors;
		bool _hasPrevColors;

		/// timer tracking how long the image has been unchanged
		QElapsedTimer _stillTimer;
		bool _stillActive;

		/// timer/reference for the brightness-drop detection window
		QElapsedTimer _dropWindowTimer;
		double _dropWindowStartBrightness;
		bool _dropWindowActive;

		/// whether a sudden brightness drop has already been observed during the
		/// current still episode -- tracked continuously from the moment stillness
		/// begins (not just after stillTimeSeconds confirms it), so a drop that
		/// completes early (e.g. right after pausing, before confirmation) is not
		/// lost by the time stillTimeSeconds elapses
		bool _dropDetected;

		/// whether a single disqualifying-looking brightness-decrease jump has
		/// already been tolerated as "the dim to standby" during the current still
		/// episode -- limits the tolerance to one such jump per episode, so real
		/// continued motion (which keeps producing further jumps) still resets
		/// normally
		bool _dimJumpTolerated;

		/// whether the reaction (freeze/off) is currently applied
		bool _triggered;

		/// lowest brightness observed since triggering, used to detect recovery
		double _minBrightnessSinceTrigger;

		/// last known-good LED colors (most recent frame before/while not yet triggered)
		QVector<ColorRgb> _lastGoodColors;
	};
} // end namespace hyperion
