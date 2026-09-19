#pragma once

// STL includes
#include <vector>
#include <QStringList>
#include <QString>

// Hyperion includes
#include <utils/ColorRgb.h>
#include <utils/EdgeTransitionBoost.h>
#include <hyperion/ColorAdjustment.h>

///
/// The LedColorTransform is responsible for performing color transformation from 'raw' colors
/// received as input to colors mapped to match the color-properties of the LEDs.
///
class MultiColorAdjustment
{
public:
	MultiColorAdjustment(int ledCnt);
	~MultiColorAdjustment();

	/**
	 * Adds a new ColorAdjustment to this MultiColorTransform
	 *
	 * @param adjustment The new ColorAdjustment (ownership is transferred)
	 */
	void addAdjustment(ColorAdjustment * adjustment);

	void setAdjustmentForLed(const QString& adjutmentId, int startLed, int endLed);

	bool verifyAdjustments() const;

	void setBacklightEnabled(bool enable);

	///
	/// Returns the identifier of all the unique ColorAdjustment
	///
	/// @return The list with unique id's of the ColorAdjustment
	QStringList getAdjustmentIds() const;

	///
	/// Returns the pointer to the ColorAdjustment with the given id
	///
	/// @param adjutmentId The identifier of the ColorAdjustment
	///
	/// @return The ColorAdjustment with the given id (or nullptr if it does not exist)
	///
	ColorAdjustment* getAdjustment(const QString& adjutmentId);

	///
	/// Performs the color adjustment from raw-color to led-color
	///
	/// @param ledColors The list with raw colors
	///
	void applyAdjustment(QVector<ColorRgb>& ledColors);

	/// Fork extension: settings for the whole-strip edge-transition boost
	/// pass, applied at the end of applyAdjustment(). Not per-LED like
	/// ColorAdjustment's fields -- this needs neighbor access along the
	/// strip, so it lives here rather than on an individual profile.
	EdgeTransitionBoost _edgeTransitionBoost;

private:
	/// List with transform ids
	QStringList _adjustmentIds;

	/// List with unique ColorTransforms
	QVector<ColorAdjustment*> _adjustment;

	/// List with a pointer to the ColorAdjustment for each individual led
	QVector<ColorAdjustment*> _ledAdjustments;

	// logger instance
	QSharedPointer<Logger> _log;
};
