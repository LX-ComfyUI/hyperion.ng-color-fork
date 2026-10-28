#pragma once

#include <QJsonObject>
#include <QSharedPointer>
#include <QString>

class Logger;

// Fork: "Reconnect grabber (USB)". Resets the USB device of the video grabber, as if it was
// unplugged and plugged in again, so a capture card that hangs on a flat no-signal frame recovers
// without a replug and without a restart of Hyperion. Only the grabber's own USB device is reset,
// nothing else on the bus.
//
// The grabber is closed before (VideoWrapper::usbReconnect): resetting while a process holds the
// node makes the kernel re-create it under a new number. It needs Linux, a grabber on USB and
// either write access to its USB device node (root or a udev rule; then the reset is a plain
// ioctl) or `usbreset` (usbutils) that sudo allows without a password.
namespace UsbReset
{
	// The grabber setting (grabberV4L2) of the daemon; the check and the reset follow it.
	void setGrabberSettings(const QJsonObject& v4l2);

	// Whether the reset can run now; otherwise whyKey (notLinux, noGrabber, notFound, notUsb,
	// noTool, noRight) and an English reason.
	bool possible(QString* whyKey = nullptr, QString* why = nullptr);

	// For sysinfo: { possible, whyKey, why, device, running } plus the result of the last reset,
	// last: { ok, at (ms since epoch), whyKey, error }.
	QJsonObject status();

	// Resets the grabber's USB device and waits until it is back. Blocks for up to a few seconds,
	// so it runs in a thread of its own; the caller has closed the grabber before. Returns the
	// capture node on the same USB port afterwards (identical grabbers have identical names, the
	// port tells them apart), empty when the reset was not possible or the device did not come back.
	QString resetNow(const QSharedPointer<Logger>& log);
}
