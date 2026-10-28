#pragma once

#include <HyperionConfig.h> // Required to determine the cmake options
#include <hyperion/GrabberWrapper.h>

#include <QElapsedTimer>
#include <QStringList>
#include <QTimer>

#if defined(ENABLE_MF)
	#include <grabber/video/mediafoundation/MFGrabber.h>
#elif defined(ENABLE_V4L2)
	#include <grabber/video/v4l2/V4L2Grabber.h>
#endif

class VideoWrapper : public GrabberWrapper
{
	Q_OBJECT

public:
	VideoWrapper();
	~VideoWrapper() override;

signals:
	/// fork: the configured video device is gone for a while; other grabbers are plugged in (node paths and sysfs names)
	void deviceSwitchRequested(const QStringList& paths, const QStringList& names);

public slots:
	bool start() override;
	void stop() override;

	void handleSettingsUpdate(settings::type type, const QJsonDocument& config) override;

	///
	/// @brief Fork: closes the grabber, resets its USB device (UsbReset) in a thread of its own and opens
	/// it again on the same USB port - like unplugging and plugging it in, without a restart of Hyperion
	///
	void usbReconnect();

private slots:
	void newFrame(const Image<ColorRgb> & image);
	void readError(const char* err);
	void tryReconnect();
	void offerOtherDevices();
	void usbReconnectDone(const QString& node, bool reopen);

	void action() override;

private:
	/// Retries opening the device after it vanished (e.g. USB grabber unplugged)
	QTimer _reconnectTimer;
	QElapsedTimer _missingTimer; // how long the configured device has been missing
	QString _devicePath;
	QString _deviceName;
	bool _usbReconnecting = false;

	/// The Media Foundation or V4L2 grabber
#if defined(ENABLE_MF)
	MFGrabber _grabber;
#elif defined(ENABLE_V4L2)
	V4L2Grabber _grabber;
#endif
};
