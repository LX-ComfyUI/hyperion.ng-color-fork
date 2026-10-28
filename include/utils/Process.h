#pragma once

#include <QString>
#include <QByteArray>

namespace Process
{
	void restartHyperion(int exitCode = 0);
	QByteArray command_exec(const QString& cmd, const QByteArray& data = {});

	// Path to a marker file restartHyperion() touches before exiting. Whichever
	// process ends up actually serving afterwards (the one it self-relaunches,
	// or systemd's own independent respawn via Restart=on-failure racing it)
	// checks this on startup to tell a restart apart from a real cold boot,
	// e.g. to skip the foreground boot effect only on restarts.
	QString skipBootSequenceMarkerPath();
}
