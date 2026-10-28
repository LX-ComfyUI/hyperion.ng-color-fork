#include <QMetaType>

#include <grabber/video/VideoWrapper.h>

#include <utils/GlobalSignals.h>
#include <utils/UsbReset.h>

// qt includes
#include <QCoreApplication>
#include <QPointer>
#include <QThread>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QTimer>

namespace {
	constexpr int RECONNECT_INTERVAL_MS = 2000;
	constexpr int SWITCH_AFTER_MS = 5000; // a missing device this long: look for a known grabber
}

#if defined(ENABLE_V4L2)
namespace {
	// a V4L2 node whose sysfs name matches the device name the grabber is configured with
	bool videoNodeWithNameExists(const QString& deviceName)
	{
		for (const QString& node : QDir("/sys/class/video4linux").entryList({ "video*" }, QDir::Dirs | QDir::System))
		{
			QFile file("/sys/class/video4linux/" + node + "/name");
			if (file.open(QIODevice::ReadOnly) && QString::fromUtf8(file.readAll()).trimmed() == deviceName)
			{
				return true;
			}
		}
		return false;
	}

	// the capture nodes (index 0, not the metadata node of the same USB device) with another name
	void otherCaptureNodes(const QString& deviceName, QStringList& paths, QStringList& names)
	{
		for (const QString& node : QDir("/sys/class/video4linux").entryList({ "video*" }, QDir::Dirs | QDir::System))
		{
			QFile nameFile("/sys/class/video4linux/" + node + "/name");
			QFile indexFile("/sys/class/video4linux/" + node + "/index");
			if (!nameFile.open(QIODevice::ReadOnly) || !indexFile.open(QIODevice::ReadOnly))
			{
				continue;
			}
			const QString name = QString::fromUtf8(nameFile.readAll()).trimmed();
			if (name != deviceName && QString::fromUtf8(indexFile.readAll()).trimmed() == "0")
			{
				paths << "/dev/" + node;
				names << name;
			}
		}
	}
}
#endif


VideoWrapper::VideoWrapper()
#if defined(ENABLE_V4L2)
	: GrabberWrapper("V4L2", &_grabber)
#elif defined(ENABLE_MF)
	: GrabberWrapper("V4L2:MEDIA_FOUNDATION", &_grabber)
#endif
	, _grabber()
{
	// register the image type
	qRegisterMetaType<Image<ColorRgb>>("Image<ColorRgb>");
	qRegisterMetaType<Event>("Event");

	// Handle the image in the captured thread (Media Foundation/V4L2) using a direct connection
	connect(&_grabber, SIGNAL(newFrame(const Image<ColorRgb>&)), this, SLOT(newFrame(const Image<ColorRgb>&)), Qt::DirectConnection);
	connect(&_grabber, SIGNAL(readError(const char*)), this, SLOT(readError(const char*)), Qt::DirectConnection);

	_reconnectTimer.setInterval(RECONNECT_INTERVAL_MS);
	connect(&_reconnectTimer, &QTimer::timeout, this, &VideoWrapper::tryReconnect);

	// fork: "Reconnect grabber (USB)" from the JSON API (other thread, hence queued)
	connect(GlobalSignals::getInstance(), &GlobalSignals::requestGrabberUsbReconnect, this, &VideoWrapper::usbReconnect, Qt::QueuedConnection);
}

VideoWrapper::~VideoWrapper()
{
	VideoWrapper::stop();
}

bool VideoWrapper::start()
{
	return (_grabber.prepare() && _grabber.start() && GrabberWrapper::start());
}

void VideoWrapper::stop()
{
	_reconnectTimer.stop();
	_grabber.stop();
	GrabberWrapper::stop();
}

void VideoWrapper::handleSettingsUpdate(settings::type type, const QJsonDocument& config)
{
	if(type == settings::V4L2 && _grabber.getGrabberName().startsWith("V4L2"))
	{
		// extract settings
		const QJsonObject& obj = config.object();

		// set global grabber state
		setV4lGrabberState(obj["enable"].toBool(false));

		if (getV4lGrabberState())
		{
#if defined(ENABLE_MF)
			// Device path
			_grabber.setDevice(obj["device"].toString("none"));
#endif

#if defined(ENABLE_V4L2)
			// Device path and name
			_devicePath = obj["device"].toString("none");
			_deviceName = obj["available_devices"].toString("none");
			_grabber.setDevice(_devicePath, _deviceName);
#endif

			// Device input
			_grabber.setInput(obj["input"].toInt(0));

			// Device resolution
			_grabber.setWidthHeight(obj["width"].toInt(0), obj["height"].toInt(0));

			// Device encoding format
			_grabber.setEncoding(obj["encoding"].toString("NO_CHANGE"));

			// Video standard
			_grabber.setVideoStandard(parseVideoStandard(obj["standard"].toString("NO_CHANGE")));

			// Image size decimation
			_grabber.setPixelDecimation(obj["sizeDecimation"].toInt(8));

			// Flip mode
			_grabber.setFlipMode(parseFlipMode(obj["flip"].toString("NO_CHANGE")));

			// Image cropping
			_grabber.setCropping(
				obj["cropLeft"].toInt(0),
				obj["cropRight"].toInt(0),
				obj["cropTop"].toInt(0),
				obj["cropBottom"].toInt(0));

			// Brightness, Contrast, Saturation, Hue
			_grabber.setBrightnessContrastSaturationHue(
				obj["hardware_brightness"].toInt(0),
				obj["hardware_contrast"].toInt(0),
				obj["hardware_saturation"].toInt(0),
				obj["hardware_hue"].toInt(0));

			// Software frame skipping
			_grabber.setFpsSoftwareDecimation(obj["fpsSoftwareDecimation"].toInt(1));

			// fork: the threshold signal detection is replaced by the "No Signal" still image
			// detection (NoSignalDetector, setting grabberTest.noSignal)
			_grabber.setSignalDetectionEnable(false);

			// Device framerate
			_grabber.setFramerate(obj["fps"].toInt(15));

			updateTimer(getGrabber()->getUpdateInterval());

			// Reload the Grabber if any settings have been changed that require it
			const bool started = _grabber.reload(getV4lGrabberState());
#if defined(ENABLE_V4L2)
			// fork: a device that is not there yet (plugged in later, or another grabber is plugged in)
			// is waited for like one that vanished
			if (!started && !_reconnectTimer.isActive() && !videoNodeWithNameExists(_deviceName))
			{
				Info(_log, "Video device '%s' is not there, waiting for it, retrying every %d s", QSTRING_CSTR(_deviceName), RECONNECT_INTERVAL_MS / 1000);
				_missingTimer.restart();
				_reconnectTimer.start();
			}
#else
			Q_UNUSED(started)
#endif
		}
		else
			stop();
	}
}

void VideoWrapper::newFrame(const Image<ColorRgb> &image)
{
	emit systemImage(_grabber.getGrabberName(), image);
}

void VideoWrapper::readError(const char* err)
{
	Error(_log, "Stop grabber, because reading device failed. (%s)", err);
	stop();

	// The device may come back (USB grabber re-plugged), so keep trying to reopen it
	if (getV4lGrabberState())
	{
		Info(_log, "Waiting for the video device to reappear, retrying every %d s", RECONNECT_INTERVAL_MS / 1000);
		_missingTimer.restart();
		_reconnectTimer.start();
	}
}

void VideoWrapper::tryReconnect()
{
	// stop retrying when the grabber was disabled or got restarted elsewhere (e.g. settings save)
	if (!getV4lGrabberState() || isActive())
	{
		_reconnectTimer.stop();
		return;
	}

#if defined(ENABLE_V4L2)
	// the device may also come back under another node number; the grabber then finds it by name
	if (!videoNodeWithNameExists(_deviceName))
	{
		offerOtherDevices();
		return;
	}

	// a failed init() resets the device path to "none", so restore it before every attempt
	_grabber.setDevice(_devicePath, _deviceName);
#endif

	if (start())
	{
		Info(_log, "Video device is back, grabber restarted");
		_reconnectTimer.stop();
	}
}

void VideoWrapper::usbReconnect()
{
	if (_usbReconnecting)
	{
		return;
	}
	_usbReconnecting = true;

	// reopen it afterwards when a LED instance uses it (isActive() does not tell: the V4L2 grabber
	// started from the settings runs without the wrapper's timer); a switched off grabber stays off
	const bool reopen = !GRABBER_V4L_CLIENTS.isEmpty();
	Info(_log, "Reconnecting the video grabber via USB");
	// closes the device first: a node still held while resetting is re-created under a new number
	stop();

	// the reset blocks for up to a few seconds, the grabber runs in this (the main) thread
	const QPointer<VideoWrapper> self(this);
	const QSharedPointer<Logger> log = _log;
	QThread* thread = QThread::create([self, log, reopen]() {
		const QString node = UsbReset::resetNow(log);
		QMetaObject::invokeMethod(qApp, [self, node, reopen]() {
			if (self)
			{
				self->usbReconnectDone(node, reopen);
			}
		}, Qt::QueuedConnection);
	});
	connect(thread, &QThread::finished, thread, &QObject::deleteLater);
	thread->start();
}

void VideoWrapper::usbReconnectDone(const QString& node, bool reopen)
{
	_usbReconnecting = false;
	if (!reopen || !getV4lGrabberState())
	{
		return;
	}

#if defined(ENABLE_V4L2)
	// the node on the same USB port, so that of two identical grabbers (same name) the right one opens
	_grabber.setDevice(node.isEmpty() ? _devicePath : node, _deviceName);
#else
	Q_UNUSED(node)
#endif
	if (start())
	{
		Info(_log, "Video grabber reconnected");
		return;
	}

	// not back (yet): wait for it like for a replugged grabber
	Info(_log, "Waiting for the video device to reappear, retrying every %d s", RECONNECT_INTERVAL_MS / 1000);
	_missingTimer.restart();
	_reconnectTimer.start();
}

void VideoWrapper::offerOtherDevices()
{
#if defined(ENABLE_V4L2)
	if (!_missingTimer.isValid() || _missingTimer.elapsed() < SWITCH_AFTER_MS)
	{
		return;
	}
	QStringList paths;
	QStringList names;
	otherCaptureNodes(_deviceName, paths, names);
	if (!names.isEmpty())
	{
		emit deviceSwitchRequested(paths, names);
	}
#endif
}

void VideoWrapper::action()
{
	// dummy as v4l get notifications from stream
}
