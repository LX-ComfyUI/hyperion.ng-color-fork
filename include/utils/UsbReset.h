#pragma once

#include <QJsonObject>
#include <QSharedPointer>
#include <QString>

class Logger;

// Fork: "Reset grabber (USB) + restart". Resets the USB device of the video grabber, as if it was
// unplugged and plugged in again, so a capture card that hangs on a flat no-signal frame recovers
// without a replug. Only the grabber's own USB device is reset, nothing else on the bus.
//
// The reset runs in the restarted process, before the grabber opens its device (resetting while a
// process holds the node makes the kernel re-create it under a new number). It needs Linux, a
// grabber on USB and either write access to its USB device node (root or a udev rule; then the
// reset is a plain ioctl) or `usbreset` (usbutils) that sudo allows without a password.
namespace UsbReset
{
	// The grabber setting (grabberV4L2) of the daemon; the check and the reset follow it.
	void setGrabberSettings(const QJsonObject& v4l2);

	// Whether the reset can run now; otherwise whyKey (notLinux, noGrabber, notFound, notUsb,
	// noTool, noRight) and an English reason.
	bool possible(QString* whyKey = nullptr, QString* why = nullptr);

	// For sysinfo: { possible, whyKey, why, device } plus the result of the last reset of this
	// process, last: { ok, at (ms since epoch), whyKey, error }.
	QJsonObject status();

	// Asks the next start of Hyperion to reset the grabber (marker file, see Process).
	void request();

	// Called by the restarted process before the video grabber starts.
	void runIfRequested(const QSharedPointer<Logger>& log);
}
