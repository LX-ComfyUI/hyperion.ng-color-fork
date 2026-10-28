#ifdef _WIN32

	#include <QCoreApplication>
	#include <QProcess>
	#include <utils/Logger.h>
	#include <QString>
	#include <QByteArray>
	#include <QFile>
	#include <QDir>

	namespace Process
	{
		void restartHyperion(int exitCode)
		{
			QSharedPointer<Logger> log = Logger::getInstance("Process");
			Info(log, "Restarting hyperion ...");

			QFile(skipBootSequenceMarkerPath()).open(QIODevice::WriteOnly);

			auto arguments = QCoreApplication::arguments();
			if (!arguments.contains("--wait-hyperion"))
				arguments << "--wait-hyperion";

			QProcess::startDetached(QCoreApplication::applicationFilePath(), arguments);

			//Exit with non-zero code to ensure service deamon restarts hyperion
			QCoreApplication::exit(exitCode);
		}

		QByteArray command_exec(const QString& /*cmd*/, const QByteArray& /*data*/)
		{
			return QSTRING_CSTR(QString());
		}
	};

#else

	#include <utils/Process.h>
	#include <utils/Logger.h>

	#include <QCoreApplication>
	#include <QProcess>
	#include <QStringList>
	#include <QFile>
	#include <QDir>

	#include <unistd.h>
	#include <cstdio>
	#include <iostream>
	#include <memory>
	#include <stdexcept>

	#include <csignal>

	#include <QDebug>
	#include <QMetaObject>

	namespace Process
	{
		void restartHyperion(int exitCode)
		{
			QSharedPointer<Logger> log = Logger::getInstance("Process");
			Info(log, "Restarting hyperion ...");

			std::cout << std::endl
				<< "      *******************************************" << std::endl
				<< "      *      hyperion will restart now          *" << std::endl
				<< "      *******************************************" << std::endl << std::endl;

			QFile(skipBootSequenceMarkerPath()).open(QIODevice::WriteOnly);

			// Fork: under systemd (INVOCATION_ID is set for service processes) the service
			// manager restarts Hyperion on the non-zero exit code. A self-relaunched copy
			// would run alongside the exiting process, consume the restart markers (boot
			// effect skip, USB reset) and then be killed by systemd with the old cgroup.
			if (qEnvironmentVariableIsEmpty("INVOCATION_ID"))
			{
				auto arguments = QCoreApplication::arguments();
				if (!arguments.contains("--wait-hyperion"))
					arguments << "--wait-hyperion";

				QProcess::startDetached(QCoreApplication::applicationFilePath(), arguments);
			}

			//Exit with non-zero code to ensure service deamon restarts hyperion
			QCoreApplication::exit(exitCode);
		}

		QByteArray command_exec(const QString& cmd, const QByteArray& /*data*/)
		{
			char buffer[128];
			QString result;

			std::shared_ptr<FILE> pipe(popen(cmd.toLocal8Bit().constData(), "r"), pclose);
			if (pipe)
			{
				while (!feof(pipe.get()))
				{
					if (fgets(buffer, 128, pipe.get()) != nullptr)
						result += buffer;
				}
			}
			return QSTRING_CSTR(result);
		}
	};

#endif

QString Process::skipBootSequenceMarkerPath()
{
	return QDir::tempPath() + "/hyperion-skip-bootsequence";
}
