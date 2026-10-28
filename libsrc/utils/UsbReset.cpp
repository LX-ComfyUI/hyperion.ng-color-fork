#include <utils/UsbReset.h>
#include <utils/global_defines.h>
#include <utils/Logger.h>

#include <QCoreApplication>
#include <QDateTime>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QMutex>
#include <QMutexLocker>
#include <QProcess>
#include <QStandardPaths>
#include <QThread>

#include <atomic>

#ifdef __linux__
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <linux/usbdevice_fs.h>
#include <sys/ioctl.h>
#include <unistd.h>
#endif

namespace
{
	QMutex mutex;
	QJsonObject grabberSettings;
	QJsonObject lastResult;
	std::atomic<bool> running { false };

	// what the reset would do now: an empty whyKey means it can run
	struct Check
	{
		QString whyKey;
		QString why;
		QString usbDir;   // the grabber's USB device in /sys
		QString product;
		QString busDev;   // "BBB/DDD" as in /dev/bus/usb
		bool direct = false; // write access to the USB node: ioctl, else sudo usbreset
		QString usbreset;
	};

	Check fail(const QString& whyKey, const QString& why)
	{
		Check check;
		check.whyKey = whyKey;
		check.why = why;
		return check;
	}

#ifdef __linux__
	QString readSysfsValue(const QString& path)
	{
		QFile file(path);
		if (!file.open(QIODevice::ReadOnly))
		{
			return {};
		}
		return QString::fromLatin1(file.readAll()).trimmed();
	}

	// Walks from a /sys/class/video4linux/videoN entry up to its USB device
	// (the directory carrying idVendor/busnum). Empty if it is not on USB.
	QString usbDeviceDirForVideoNode(const QString& videoNodeName)
	{
		QDir dir(QFileInfo("/sys/class/video4linux/" + videoNodeName + "/device").canonicalFilePath());
		if (dir.path().isEmpty() || dir.path() == ".")
		{
			return {};
		}
		do
		{
			if (QFile::exists(dir.filePath("idVendor")) && QFile::exists(dir.filePath("busnum")))
			{
				return dir.path();
			}
		} while (dir.cdUp() && dir.path() != "/sys/devices");
		return {};
	}

	QStringList videoNodeNames()
	{
		return QDir("/sys/class/video4linux").entryList({ "video*" }, QDir::Dirs | QDir::System, QDir::Name);
	}

	// The video node the grabber uses, found like the V4L2 grabber does: the configured path, or the
	// node that carries the configured device name when the kernel numbered the nodes anew.
	QString grabberVideoNode(const QJsonObject& settings)
	{
		const QString devicePath = settings["device"].toString("none");
		const QString deviceName = settings["available_devices"].toString("none");
		const QString nodePath = QFileInfo(devicePath).canonicalFilePath();
		const QString node = nodePath.startsWith("/dev/video") ? QFileInfo(nodePath).fileName() : QString();
		const bool named = deviceName.compare("none", Qt::CaseInsensitive) != 0 && !deviceName.isEmpty();
		if (!node.isEmpty() && (!named || readSysfsValue("/sys/class/video4linux/" + node + "/name") == deviceName))
		{
			return node;
		}
		if (named)
		{
			for (const QString& candidate : videoNodeNames())
			{
				if (readSysfsValue("/sys/class/video4linux/" + candidate + "/name") == deviceName)
				{
					return candidate;
				}
			}
		}
		return {};
	}

	// /dev paths of the video nodes that belong to a USB device directory
	QStringList videoNodesOfUsbDevice(const QString& usbDir)
	{
		QStringList nodes;
		for (const QString& node : videoNodeNames())
		{
			if (usbDeviceDirForVideoNode(node) == usbDir)
			{
				nodes << "/dev/" + node;
			}
		}
		return nodes;
	}

	// the capture node (index 0) of a USB device; UVC adds a metadata node of the same name
	QString captureNodeOfUsbDevice(const QString& usbDir)
	{
		for (const QString& node : videoNodeNames())
		{
			if (usbDeviceDirForVideoNode(node) == usbDir && readSysfsValue("/sys/class/video4linux/" + node + "/index") == "0")
			{
				return "/dev/" + node;
			}
		}
		return {};
	}

	// true while a process (also this one, until the grabber has closed the device) has one of the
	// nodes open; only processes of the same user are visible, which covers Hyperion
	bool videoNodeHeld(const QStringList& nodes)
	{
		for (const QString& pid : QDir("/proc").entryList(QDir::Dirs | QDir::NoDotAndDotDot))
		{
			if (!pid.at(0).isDigit())
			{
				continue;
			}
			const QDir fdDir("/proc/" + pid + "/fd");
			for (const QFileInfo& fd : fdDir.entryInfoList(QDir::Files | QDir::System | QDir::NoDotAndDotDot))
			{
				if (nodes.contains(fd.symLinkTarget()))
				{
					return true;
				}
			}
		}
		return false;
	}

	// sudo -n -l asks sudo without running anything; the answer is kept a minute, the check runs
	// with every sysinfo
	bool sudoAllows(const QString& program)
	{
		static QString cachedFor;
		static bool cached = false;
		static QElapsedTimer age;
		static QMutex cacheMutex;
		QMutexLocker lock(&cacheMutex);
		if (cachedFor == program && age.isValid() && age.elapsed() < 60000)
		{
			return cached;
		}
		QProcess sudo;
		sudo.start("sudo", { "-n", "-l", program });
		cached = sudo.waitForFinished(3000) && sudo.exitStatus() == QProcess::NormalExit && sudo.exitCode() == 0;
		cachedFor = program;
		age.start();
		return cached;
	}
#endif

	Check checkNow(const QJsonObject& settings)
	{
#ifndef __linux__
		Q_UNUSED(settings)
		return fail("notLinux", "only possible on Linux");
#else
		if (!settings["enable"].toBool(false))
		{
			return fail("noGrabber", "the video grabber is switched off");
		}
		const QString node = grabberVideoNode(settings);
		if (node.isEmpty())
		{
			return fail("notFound", "the configured video grabber was not found");
		}
		Check check;
		check.usbDir = usbDeviceDirForVideoNode(node);
		if (check.usbDir.isEmpty())
		{
			return fail("notUsb", "the video grabber is not connected via USB");
		}
		check.product = readSysfsValue(check.usbDir + "/product");
		check.busDev = QString("%1/%2")
			.arg(readSysfsValue(check.usbDir + "/busnum").toInt(), 3, 10, QChar('0'))
			.arg(readSysfsValue(check.usbDir + "/devnum").toInt(), 3, 10, QChar('0'));
		if (access(QSTRING_CSTR(QString("/dev/bus/usb/" + check.busDev)), W_OK) == 0)
		{
			check.direct = true;
			return check;
		}
		check.usbreset = QStandardPaths::findExecutable("usbreset");
		if (check.usbreset.isEmpty())
		{
			check.usbreset = QStandardPaths::findExecutable("usbreset", { "/usr/bin", "/usr/sbin", "/bin", "/sbin" });
		}
		if (check.usbreset.isEmpty())
		{
			return fail("noTool", "no write access to the USB device and usbreset (usbutils) is missing");
		}
		if (!sudoAllows(check.usbreset))
		{
			return fail("noRight", "no write access to the USB device and sudo does not allow usbreset without a password");
		}
		return check;
#endif
	}

	QJsonObject settingsCopy()
	{
		QMutexLocker lock(&mutex);
		return grabberSettings;
	}

	void setLast(bool ok, const QString& whyKey, const QString& error)
	{
		QMutexLocker lock(&mutex);
		lastResult = QJsonObject {
			{ "ok", ok },
			{ "at", QDateTime::currentMSecsSinceEpoch() },
			{ "whyKey", whyKey },
			{ "error", error },
		};
	}

#ifdef __linux__
	// the reset itself; empty on success, else what went wrong
	QString reset(const Check& check)
	{
		if (check.direct)
		{
			const int fd = open(QSTRING_CSTR(QString("/dev/bus/usb/" + check.busDev)), O_WRONLY);
			if (fd < 0)
			{
				return QString("open: %1").arg(strerror(errno));
			}
			const int rc = ioctl(fd, USBDEVFS_RESET, 0);
			const int err = errno;
			close(fd);
			return rc < 0 ? QString("ioctl: %1").arg(strerror(err)) : QString();
		}
		QProcess sudo;
		sudo.setProcessChannelMode(QProcess::MergedChannels);
		sudo.start("sudo", { "-n", check.usbreset, check.busDev });
		if (!sudo.waitForFinished(10000))
		{
			sudo.kill();
			return "usbreset did not finish within 10 s";
		}
		if (sudo.exitStatus() != QProcess::NormalExit || sudo.exitCode() != 0)
		{
			const QString out = QString::fromLocal8Bit(sudo.readAll()).trimmed();
			return out.isEmpty() ? QString("usbreset exited with %1").arg(sudo.exitCode()) : out;
		}
		return {};
	}
#endif
}

namespace UsbReset
{
	void setGrabberSettings(const QJsonObject& v4l2)
	{
		QMutexLocker lock(&mutex);
		grabberSettings = v4l2;
	}

	bool possible(QString* whyKey, QString* why)
	{
		const Check check = checkNow(settingsCopy());
		if (whyKey != nullptr)
		{
			*whyKey = check.whyKey;
		}
		if (why != nullptr)
		{
			*why = check.why;
		}
		return check.whyKey.isEmpty();
	}

	QJsonObject status()
	{
		const Check check = checkNow(settingsCopy());
		QJsonObject info {
			{ "possible", check.whyKey.isEmpty() },
			{ "whyKey", check.whyKey },
			{ "why", check.why },
			{ "device", check.product },
			{ "running", running.load() },
		};
		QMutexLocker lock(&mutex);
		if (!lastResult.isEmpty())
		{
			info["last"] = lastResult;
		}
		return info;
	}

	QString resetNow(const QSharedPointer<Logger>& log)
	{
		if (running.exchange(true))
		{
			Warning(log, "USB reset of the video grabber is already running");
			return {};
		}
		const Check check = checkNow(settingsCopy());
		if (!check.whyKey.isEmpty())
		{
			Warning(log, "USB reset of the video grabber skipped: %s", QSTRING_CSTR(check.why));
			setLast(false, check.whyKey, check.why);
			running = false;
			return {};
		}
#ifndef __linux__
		running = false;
		return {};
#else
		QElapsedTimer waited;
		waited.start();
		const QStringList nodes = videoNodesOfUsbDevice(check.usbDir);
		while (videoNodeHeld(nodes) && waited.elapsed() < 2000)
		{
			QThread::msleep(20);
		}
		if (waited.elapsed() >= 20)
		{
			Info(log, "Waited %lld ms until no process held the capture device", waited.elapsed());
		}

		Info(log, "Resetting USB capture device %s:%s (%s, bus/dev %s) %s",
			QSTRING_CSTR(readSysfsValue(check.usbDir + "/idVendor")),
			QSTRING_CSTR(readSysfsValue(check.usbDir + "/idProduct")),
			QSTRING_CSTR(check.product), QSTRING_CSTR(check.busDev),
			check.direct ? "directly" : "via sudo usbreset");
		const QString error = reset(check);
		if (!error.isEmpty())
		{
			Error(log, "USB reset of the capture device failed: %s", QSTRING_CSTR(error));
			setLast(false, "failed", error);
			running = false;
			return {};
		}

		// The UVC driver re-probes and udev re-creates the node shortly after the reset; the USB
		// device directory (its port) stays the same
		QElapsedTimer timer;
		timer.start();
		while (timer.elapsed() < 5000)
		{
			const QString node = captureNodeOfUsbDevice(check.usbDir);
			if (!node.isEmpty() && QFileInfo(node).isReadable())
			{
				Info(log, "Capture device is back as '%s' after %lld ms", QSTRING_CSTR(node), timer.elapsed());
				setLast(true, {}, {});
				running = false;
				return node;
			}
			QThread::msleep(20);
		}
		Warning(log, "Capture device did not come back within 5 s after the USB reset");
		setLast(false, "notBack", "the capture device did not come back within 5 s");
		running = false;
		return {};
#endif
	}
}
