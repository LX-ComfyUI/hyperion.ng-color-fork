#include <utils/NoSignalDetector.h>

#include <utils/Logger.h>

#include <QBuffer>
#include <QByteArray>
#include <QDateTime>
#include <QHash>
#include <QImage>
#include <QJsonArray>
#include <QMutex>
#include <QMutexLocker>

#include <algorithm>
#include <cmath>

namespace {

constexpr int CELLS = NoSignalDetector::COLS * NoSignalDetector::ROWS;
// samples per cell edge: 5 x 5 pixels give a stable mean at a fraction of the frame's pixels
constexpr int SAMPLES = 5;
// a cell that moves more than this during the calibration is ignored (clock, counter, noise)
constexpr int UNSTABLE_RANGE = 20;
// this many frames in a row that do not match end the "no signal" state
constexpr int MISSES_TO_RECOVER = 2;
// the newest frame is kept as a small picture while somebody looks at the status
constexpr int SNAPSHOT_W = 320;
constexpr int SNAPSHOT_H = 180;
constexpr qint64 SNAPSHOT_EVERY_MS = 200;
constexpr qint64 SNAPSHOT_WANTED_MS = 10000;
constexpr int MIN_CALIBRATION_FRAMES = 5;

enum class Action { Release, Black, Report };

struct Config
{
	bool enable = false;
	Action action = Action::Release;
	qint64 delayMs = 3000;
	int tolerance = 24;
	double match = 0.95;
	// device name -> reference of its active slot
	QHash<QString, NoSignalDetector::Reference> references;
	QHash<QString, QString> slotNames;
};

struct Calibration
{
	bool running = false;
	qint64 endMs = 0;
	qint64 durationMs = 0;
	QString device;
	int frames = 0;
	std::vector<quint32> sum;
	std::vector<uint8_t> min;
	std::vector<uint8_t> max;
	QImage preview;
	QJsonObject result;
	QString error;
};

struct State
{
	QString device;
	qint64 lastFrameMs = 0;
	bool calibrated = false;
	bool noSignal = false;
	qint64 matchSinceMs = 0; // start of the current run of matching frames, 0 = none
	qint64 changedMs = 0;    // last change between signal and no signal
	int misses = 0;
	NoSignalDetector::Match last;
	QImage snapshot;
	qint64 snapshotMs = 0;
	qint64 snapshotWantedUntil = 0;
};

QMutex mutex;
Config config;
Calibration calib;
State state;

QSharedPointer<Logger> log()
{
	return Logger::getInstance("V4L2");
}

QString actionName(Action a)
{
	switch (a)
	{
	case Action::Black: return QStringLiteral("black");
	case Action::Report: return QStringLiteral("report");
	default: return QStringLiteral("release");
	}
}

QImage smallPicture(const Image<ColorRgb>& image)
{
	QImage out(SNAPSHOT_W, SNAPSHOT_H, QImage::Format_RGB888);
	const int w = image.width();
	const int h = image.height();
	for (int y = 0; y < SNAPSHOT_H; ++y)
	{
		uchar* line = out.scanLine(y);
		const int sy = std::min(h - 1, (2 * y + 1) * h / (2 * SNAPSHOT_H));
		for (int x = 0; x < SNAPSHOT_W; ++x)
		{
			const ColorRgb& c = image(std::min(w - 1, (2 * x + 1) * w / (2 * SNAPSHOT_W)), sy);
			line[3 * x] = c.red;
			line[3 * x + 1] = c.green;
			line[3 * x + 2] = c.blue;
		}
	}
	return out;
}

QString toJpeg(const QImage& image)
{
	if (image.isNull())
	{
		return {};
	}
	QByteArray bytes;
	QBuffer buffer(&bytes);
	buffer.open(QIODevice::WriteOnly);
	if (!image.save(&buffer, "JPG", 80))
	{
		return {};
	}
	return QStringLiteral("data:image/jpg;base64,") + QString::fromLatin1(bytes.toBase64());
}

QString toBase64(const std::vector<uint8_t>& data)
{
	return QString::fromLatin1(QByteArray(reinterpret_cast<const char*>(data.data()), qsizetype(data.size())).toBase64());
}

std::vector<uint8_t> fromBase64(const QJsonValue& value, size_t size)
{
	const QByteArray bytes = QByteArray::fromBase64(value.toString().toLatin1());
	if (size_t(bytes.size()) != size)
	{
		return {};
	}
	return std::vector<uint8_t>(bytes.begin(), bytes.end());
}

void resetDetection()
{
	state.noSignal = false;
	state.matchSinceMs = 0;
	state.misses = 0;
	state.changedMs = 0;
}

QJsonObject finishCalibration()
{
	calib.running = false;
	QJsonObject result;
	if (calib.frames < MIN_CALIBRATION_FRAMES)
	{
		calib.error = QStringLiteral("frames");
		return result;
	}

	std::vector<uint8_t> ref(size_t(CELLS) * 3);
	std::vector<uint8_t> unstable(CELLS, 0);
	int unstableCells = 0;
	int featureCells = 0;
	for (int i = 0; i < CELLS; ++i)
	{
		int range = 0;
		int level = 0;
		for (int c = 0; c < 3; ++c)
		{
			const size_t k = size_t(i) * 3 + size_t(c);
			ref[k] = uint8_t(std::lround(double(calib.sum[k]) / calib.frames));
			range = std::max(range, int(calib.max[k]) - int(calib.min[k]));
			level = std::max(level, int(ref[k]));
		}
		if (range > UNSTABLE_RANGE)
		{
			unstable[size_t(i)] = 1;
			++unstableCells;
		}
		else if (level >= NoSignalDetector::FEATURE_LEVEL)
		{
			++featureCells;
		}
	}

	result["device"] = calib.device;
	result["cols"] = NoSignalDetector::COLS;
	result["rows"] = NoSignalDetector::ROWS;
	result["ref"] = toBase64(ref);
	result["unstable"] = toBase64(unstable);
	result["frames"] = calib.frames;
	result["cells"] = CELLS;
	result["unstableCells"] = unstableCells;
	result["featureCells"] = featureCells;
	result["image"] = toJpeg(calib.preview);
	result["savedAt"] = QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs);
	return result;
}

} // namespace

std::vector<uint8_t> NoSignalDetector::measureGrid(const Image<ColorRgb>& image)
{
	std::vector<uint8_t> grid(size_t(CELLS) * 3, 0);
	const int w = image.width();
	const int h = image.height();
	if (w < COLS || h < ROWS)
	{
		return grid;
	}
	for (int row = 0; row < ROWS; ++row)
	{
		const int y0 = row * h / ROWS;
		const int y1 = (row + 1) * h / ROWS;
		for (int col = 0; col < COLS; ++col)
		{
			const int x0 = col * w / COLS;
			const int x1 = (col + 1) * w / COLS;
			quint32 sum[3] = { 0, 0, 0 };
			for (int sy = 0; sy < SAMPLES; ++sy)
			{
				const int y = y0 + (2 * sy + 1) * (y1 - y0) / (2 * SAMPLES);
				for (int sx = 0; sx < SAMPLES; ++sx)
				{
					const ColorRgb& c = image(x0 + (2 * sx + 1) * (x1 - x0) / (2 * SAMPLES), y);
					sum[0] += c.red;
					sum[1] += c.green;
					sum[2] += c.blue;
				}
			}
			uint8_t* cell = &grid[size_t(row * COLS + col) * 3];
			for (int c = 0; c < 3; ++c)
			{
				cell[c] = uint8_t((sum[c] + SAMPLES * SAMPLES / 2) / (SAMPLES * SAMPLES));
			}
		}
	}
	return grid;
}

NoSignalDetector::Match NoSignalDetector::compare(const std::vector<uint8_t>& grid, const Reference& reference, int tolerance)
{
	Match match;
	int checked = 0;
	int ok = 0;
	int featureOk = 0;
	for (int i = 0; i < CELLS; ++i)
	{
		if (reference.unstable[size_t(i)] != 0)
		{
			continue;
		}
		const uint8_t* cur = &grid[size_t(i) * 3];
		const uint8_t* ref = &reference.ref[size_t(i) * 3];
		int diff = 0;
		int level = 0;
		for (int c = 0; c < 3; ++c)
		{
			diff = std::max(diff, std::abs(int(cur[c]) - int(ref[c])));
			level = std::max(level, int(ref[c]));
		}
		const bool same = diff <= tolerance;
		++checked;
		ok += same ? 1 : 0;
		if (level >= FEATURE_LEVEL)
		{
			++match.featureCells;
			featureOk += same ? 1 : 0;
		}
	}
	match.all = checked > 0 ? double(ok) / checked : 0.0;
	match.features = match.featureCells > 0 ? double(featureOk) / match.featureCells : 1.0;
	return match;
}

void NoSignalDetector::configure(const QJsonObject& grabberTest)
{
	const QJsonObject ns = grabberTest["noSignal"].toObject();
	Config next;
	next.enable = ns["enable"].toBool(false);
	const QString action = ns["action"].toString("release");
	next.action = action == "black" ? Action::Black : action == "report" ? Action::Report : Action::Release;
	next.delayMs = qint64(std::lround(std::clamp(ns["delay"].toDouble(3.0), 0.5, 120.0) * 1000.0));
	next.tolerance = std::clamp(ns["tolerance"].toInt(24), 4, 100);
	next.match = std::clamp(ns["match"].toDouble(95.0), 50.0, 100.0) / 100.0;

	const QJsonObject grabbers = ns["grabbers"].toObject();
	for (auto it = grabbers.begin(); it != grabbers.end(); ++it)
	{
		const QJsonObject g = it.value().toObject();
		const QJsonArray slotList = g["slots"].toArray();
		const int active = g["active"].toInt(-1);
		if (active < 0 || active >= slotList.size() || !slotList[active].isObject())
		{
			continue;
		}
		const QJsonObject slot = slotList[active].toObject();
		if (slot["cols"].toInt() != COLS || slot["rows"].toInt() != ROWS)
		{
			continue;
		}
		Reference reference { fromBase64(slot["ref"], size_t(CELLS) * 3), fromBase64(slot["unstable"], size_t(CELLS)) };
		if (reference.ref.empty() || reference.unstable.empty())
		{
			Warning(log(), "No-signal calibration of '%s' is damaged, ignored", QSTRING_CSTR(it.key()));
			continue;
		}
		next.references.insert(it.key(), std::move(reference));
		next.slotNames.insert(it.key(), slot["name"].toString());
	}

	const QMutexLocker locker(&mutex);
	const bool was = config.enable;
	config = std::move(next);
	resetDetection();
	if (was != config.enable)
	{
		Info(log(), "No-signal detection %s", config.enable ? "enabled" : "disabled");
	}
}

NoSignalDetector::Verdict NoSignalDetector::check(const Image<ColorRgb>& image, const QString& device)
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	const QMutexLocker locker(&mutex);

	if (state.device != device)
	{
		state.device = device;
		resetDetection();
	}
	state.lastFrameMs = now;

	if (now < state.snapshotWantedUntil && now - state.snapshotMs >= SNAPSHOT_EVERY_MS)
	{
		state.snapshot = smallPicture(image);
		state.snapshotMs = now;
	}

	const auto ref = config.references.constFind(device);
	state.calibrated = ref != config.references.constEnd();
	const bool calibrating = calib.running;
	if (!calibrating && !state.calibrated)
	{
		return Verdict::Pass;
	}

	const std::vector<uint8_t> grid = measureGrid(image);

	if (calibrating)
	{
		if (calib.device.isEmpty())
		{
			calib.device = device;
		}
		if (calib.device == device)
		{
			for (size_t k = 0; k < grid.size(); ++k)
			{
				calib.sum[k] += grid[k];
				calib.min[k] = calib.frames == 0 ? grid[k] : std::min(calib.min[k], grid[k]);
				calib.max[k] = calib.frames == 0 ? grid[k] : std::max(calib.max[k], grid[k]);
			}
			++calib.frames;
			calib.preview = smallPicture(image);
		}
		if (now >= calib.endMs)
		{
			calib.result = finishCalibration();
		}
		// a calibration is no detection: the frames pass while it runs
		resetDetection();
		return Verdict::Pass;
	}

	state.last = compare(grid, ref.value(), config.tolerance);
	const bool match = state.last.all >= config.match && state.last.features >= config.match;
	if (match)
	{
		state.misses = 0;
		if (state.matchSinceMs == 0)
		{
			state.matchSinceMs = now;
		}
		if (!state.noSignal && now - state.matchSinceMs >= config.delayMs)
		{
			state.noSignal = true;
			state.changedMs = now;
			Info(log(), "No-signal picture of '%s' detected (match %.0f %%)%s", QSTRING_CSTR(device), state.last.score() * 100.0,
				config.enable ? "" : ", detection is off");
		}
	}
	else
	{
		state.matchSinceMs = 0;
		if (state.noSignal && ++state.misses >= MISSES_TO_RECOVER)
		{
			state.noSignal = false;
			state.misses = 0;
			state.changedMs = now;
			Info(log(), "Signal of '%s' is back", QSTRING_CSTR(device));
		}
	}

	if (!state.noSignal || !config.enable)
	{
		return Verdict::Pass;
	}
	return config.action == Action::Release ? Verdict::Drop : config.action == Action::Black ? Verdict::Black : Verdict::Pass;
}

QJsonObject NoSignalDetector::status(bool withImage)
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	const QMutexLocker locker(&mutex);
	if (withImage)
	{
		state.snapshotWantedUntil = now + SNAPSHOT_WANTED_MS;
	}

	QJsonObject result;
	result["enable"] = config.enable;
	result["action"] = actionName(config.action);
	result["device"] = state.device;
	result["ageMs"] = state.lastFrameMs > 0 ? double(now - state.lastFrameMs) : -1.0;
	result["calibrated"] = state.calibrated;
	result["slotName"] = config.slotNames.value(state.device);
	result["calibrating"] = calib.running;
	result["noSignal"] = state.noSignal;
	// what the LEDs get now: the detection only acts while it is on
	result["acting"] = state.noSignal && config.enable && config.action != Action::Report;
	result["changedMs"] = double(state.changedMs);
	result["matchSinceMs"] = double(state.matchSinceMs);
	result["match"] = state.calibrated ? std::round(state.last.score() * 1000.0) / 10.0 : -1.0;
	result["matchAll"] = state.calibrated ? std::round(state.last.all * 1000.0) / 10.0 : -1.0;
	result["matchFeatures"] = state.calibrated ? std::round(state.last.features * 1000.0) / 10.0 : -1.0;
	result["featureCells"] = state.last.featureCells;
	result["now"] = double(now);
	if (withImage)
	{
		result["image"] = toJpeg(state.snapshot);
	}
	return result;
}

QJsonObject NoSignalDetector::startCalibration(int durationMs)
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	const QMutexLocker locker(&mutex);
	calib = Calibration {};
	calib.running = true;
	calib.durationMs = std::clamp(durationMs, 1000, 10000);
	calib.endMs = now + calib.durationMs;
	calib.sum.assign(size_t(CELLS) * 3, 0);
	calib.min.assign(size_t(CELLS) * 3, 0);
	calib.max.assign(size_t(CELLS) * 3, 0);
	Info(log(), "No-signal calibration started (%d ms)", int(calib.durationMs));
	QJsonObject result;
	result["running"] = true;
	result["durationMs"] = double(calib.durationMs);
	return result;
}

QJsonObject NoSignalDetector::calibration()
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	const QMutexLocker locker(&mutex);
	// no frames arrive (grabber off or unplugged): the calibration ends anyway
	if (calib.running && now >= calib.endMs + 2000)
	{
		calib.result = finishCalibration();
	}
	QJsonObject result;
	result["running"] = calib.running;
	result["frames"] = calib.frames;
	result["durationMs"] = double(calib.durationMs);
	result["leftMs"] = calib.running ? double(std::max<qint64>(0, calib.endMs - now)) : 0.0;
	if (!calib.running)
	{
		if (!calib.error.isEmpty())
		{
			result["error"] = calib.error;
		}
		if (!calib.result.isEmpty())
		{
			result["result"] = calib.result;
		}
	}
	return result;
}
