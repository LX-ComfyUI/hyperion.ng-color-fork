#include <utils/VideoProbe.h>

#include <utils/Logger.h>

#include <QDateTime>
#include <QHash>
#include <QJsonArray>
#include <QMutex>
#include <QMutexLocker>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>

#if defined(__ARM_NEON)
#include <arm_neon.h>
#endif

namespace {

// a measurement stays active this long after the last request
constexpr qint64 ACTIVE_MS = 5000;

using Rgb = std::array<double, 3>;

struct FrameStats
{
	Rgb mean {};
	Rgb noise {}; // spatial standard deviation within the measured area
};

struct State
{
	QString device;
	int width = 0;
	int height = 0;
	qint64 lastFrameMs = 0;
	quint64 frames = 0;
	FrameStats last;
	bool lastCorrected = false;
	Rgb lastCorrectedMean {};

	// average since the last reset
	quint64 n = 0;
	quint64 correctedN = 0;
	Rgb correctedSum {};
	Rgb sum {};
	Rgb sumSq {};
	Rgb noiseSum {};
	Rgb min {};
	Rgb max {};
};

std::atomic<qint64> activeUntilMs { 0 };
QMutex mutex;
State state;

// the device of the newest frame, kept also while no measurement runs
QMutex seenMutex;
QString seenDevice;
std::atomic<qint64> seenMs { 0 };

// the middle half of the frame in both directions: away from overscan and noisy borders
FrameStats measure(const Image<ColorRgb>& image)
{
	const int x0 = image.width() / 4;
	const int x1 = image.width() - x0;
	const int y0 = image.height() / 4;
	const int y1 = image.height() - y0;

	std::array<quint64, 3> sum {};
	std::array<quint64, 3> sumSq {};
	for (int y = y0; y < y1; ++y)
	{
		for (int x = x0; x < x1; ++x)
		{
			const ColorRgb& c = image(x, y);
			sum[0] += c.red;   sumSq[0] += quint64(c.red) * c.red;
			sum[1] += c.green; sumSq[1] += quint64(c.green) * c.green;
			sum[2] += c.blue;  sumSq[2] += quint64(c.blue) * c.blue;
		}
	}

	FrameStats stats;
	const double count = double(x1 - x0) * double(y1 - y0);
	if (count <= 0)
	{
		return stats;
	}
	for (int i = 0; i < 3; ++i)
	{
		stats.mean[i] = double(sum[i]) / count;
		stats.noise[i] = std::sqrt(std::max(0.0, double(sumSq[i]) / count - stats.mean[i] * stats.mean[i]));
	}
	return stats;
}

QJsonArray toJson(const Rgb& v)
{
	const auto round3 = [](double d) { return std::round(d * 1000.0) / 1000.0; };
	return QJsonArray { round3(v[0]), round3(v[1]), round3(v[2]) };
}

} // namespace

void VideoProbe::offer(const Image<ColorRgb>& image, const QString& device, const Image<ColorRgb>* corrected)
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	seenMs.store(now, std::memory_order_relaxed);
	{
		const QMutexLocker locker(&seenMutex);
		if (seenDevice != device)
		{
			seenDevice = device;
		}
	}
	if (now > activeUntilMs.load(std::memory_order_relaxed) || image.width() < 4 || image.height() < 4)
	{
		return;
	}

	const FrameStats stats = measure(image);
	const bool hasCorrected = corrected != nullptr && corrected->width() == image.width() && corrected->height() == image.height();
	const Rgb correctedMean = hasCorrected ? measure(*corrected).mean : Rgb {};

	const QMutexLocker locker(&mutex);
	state.device = device;
	state.width = image.width();
	state.height = image.height();
	state.lastFrameMs = now;
	++state.frames;
	state.last = stats;
	state.lastCorrected = hasCorrected;
	state.lastCorrectedMean = correctedMean;
	if (hasCorrected)
	{
		++state.correctedN;
		for (int i = 0; i < 3; ++i)
		{
			state.correctedSum[i] += correctedMean[i];
		}
	}

	if (state.n == 0)
	{
		state.min = stats.mean;
		state.max = stats.mean;
	}
	++state.n;
	for (int i = 0; i < 3; ++i)
	{
		state.sum[i] += stats.mean[i];
		state.sumSq[i] += stats.mean[i] * stats.mean[i];
		state.noiseSum[i] += stats.noise[i];
		state.min[i] = std::min(state.min[i], stats.mean[i]);
		state.max[i] = std::max(state.max[i], stats.mean[i]);
	}
}

QJsonObject VideoProbe::sample(bool reset)
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	activeUntilMs.store(now + ACTIVE_MS, std::memory_order_relaxed);

	const QMutexLocker locker(&mutex);
	if (reset)
	{
		state.n = 0;
		state.sum = {};
		state.sumSq = {};
		state.noiseSum = {};
		state.correctedN = 0;
		state.correctedSum = {};
	}

	QJsonObject result;
	result["device"] = state.device;
	result["width"] = state.width;
	result["height"] = state.height;
	result["frames"] = double(state.frames);
	// age of the newest measured frame, -1 before the first one
	result["ageMs"] = state.lastFrameMs > 0 ? double(now - state.lastFrameMs) : -1.0;

	QJsonObject last;
	last["mean"] = toJson(state.last.mean);
	last["noise"] = toJson(state.last.noise);
	if (state.lastCorrected)
	{
		last["corrected"] = toJson(state.lastCorrectedMean);
	}
	result["last"] = last;
	result["correctionActive"] = GrabberColorCorrection::isActive();

	QJsonObject avg;
	avg["n"] = double(state.n);
	if (state.n > 0)
	{
		const double n = double(state.n);
		Rgb mean {};
		Rgb spread {};
		Rgb noise {};
		for (int i = 0; i < 3; ++i)
		{
			mean[i] = state.sum[i] / n;
			// how much the frame means vary from frame to frame
			spread[i] = std::sqrt(std::max(0.0, state.sumSq[i] / n - mean[i] * mean[i]));
			noise[i] = state.noiseSum[i] / n;
		}
		avg["mean"] = toJson(mean);
		avg["spread"] = toJson(spread);
		avg["noise"] = toJson(noise);
		avg["min"] = toJson(state.min);
		avg["max"] = toJson(state.max);
		// the same frames after the grabber color correction, only if every frame had it
		if (state.correctedN == state.n)
		{
			Rgb corrected {};
			for (int i = 0; i < 3; ++i)
			{
				corrected[i] = state.correctedSum[i] / n;
			}
			avg["corrected"] = toJson(corrected);
		}
	}
	result["avg"] = avg;
	return result;
}

QJsonObject VideoProbe::current()
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	const qint64 seen = seenMs.load(std::memory_order_relaxed);
	QJsonObject result;
	{
		const QMutexLocker locker(&seenMutex);
		result["device"] = seenDevice;
	}
	result["ageMs"] = seen > 0 ? double(now - seen) : -1.0;
	result["correctionActive"] = GrabberColorCorrection::isActive();
	return result;
}

// --- grabber color correction ---

namespace {

// coefficients in Q14; |c| < 2 per coefficient and a row's absolute sum <= 2 keep every partial
// sum of the NEON path inside int16
constexpr double MAX_ROW_ABS_SUM = 2.0;

struct DeviceCorrection
{
	std::array<int16_t, 9> q14 {};
	int slot = -1; // -1: the older single correction for every device
};

std::atomic<bool> anyCorrection { false };
std::atomic<bool> correctionActive { false };
QMutex correctionMutex;
// key = device name; the empty key holds the older single correction that applies to every device
QHash<QString, DeviceCorrection> correctionByDevice;
QString lastLogged; // device and slot of the last log line, logged again on a change

void applyQ14(const uint8_t* src, uint8_t* dst, int pixels, const std::array<int16_t, 9>& k)
{
	int i = 0;
#if defined(__ARM_NEON)
	// 16 pixels at a time: values shifted left by 7 times Q14 via vqrdmulh gives 1/64 steps
	int16x8_t c[9];
	for (int j = 0; j < 9; ++j)
	{
		c[j] = vdupq_n_s16(k[j]);
	}
	for (; i + 16 <= pixels; i += 16)
	{
		const uint8x16x3_t px = vld3q_u8(src + 3 * i);
		int16x8_t lo[3];
		int16x8_t hi[3];
		for (int ch = 0; ch < 3; ++ch)
		{
			lo[ch] = vreinterpretq_s16_u16(vshll_n_u8(vget_low_u8(px.val[ch]), 7));
			hi[ch] = vreinterpretq_s16_u16(vshll_n_u8(vget_high_u8(px.val[ch]), 7));
		}
		uint8x16x3_t out;
		for (int o = 0; o < 3; ++o)
		{
			const int16x8_t a = vqaddq_s16(vqaddq_s16(vqrdmulhq_s16(lo[0], c[3 * o]), vqrdmulhq_s16(lo[1], c[3 * o + 1])), vqrdmulhq_s16(lo[2], c[3 * o + 2]));
			const int16x8_t b = vqaddq_s16(vqaddq_s16(vqrdmulhq_s16(hi[0], c[3 * o]), vqrdmulhq_s16(hi[1], c[3 * o + 1])), vqrdmulhq_s16(hi[2], c[3 * o + 2]));
			out.val[o] = vcombine_u8(vqrshrun_n_s16(a, 6), vqrshrun_n_s16(b, 6));
		}
		vst3q_u8(dst + 3 * i, out);
	}
#endif
	for (; i < pixels; ++i)
	{
		const int32_t r = src[3 * i];
		const int32_t g = src[3 * i + 1];
		const int32_t b = src[3 * i + 2];
		for (int o = 0; o < 3; ++o)
		{
			const int32_t v = (k[3 * o] * r + k[3 * o + 1] * g + k[3 * o + 2] * b + 8192) >> 14;
			dst[3 * i + o] = static_cast<uint8_t>(std::clamp(v, 0, 255));
		}
	}
}

} // namespace

namespace {

// Converts a matrix to Q14. Returns false for an invalid matrix; identity is set for a matrix that
// changes nothing (then no correction is needed).
bool toQ14(const QJsonArray& matrix, std::array<int16_t, 9>& q14, bool& identity)
{
	identity = true;
	if (matrix.size() != 9)
	{
		return false;
	}
	for (int row = 0; row < 3; ++row)
	{
		double absSum = 0.0;
		for (int col = 0; col < 3; ++col)
		{
			const double v = matrix[3 * row + col].toDouble(NAN);
			if (!std::isfinite(v))
			{
				return false;
			}
			absSum += std::abs(v);
			q14[3 * row + col] = static_cast<int16_t>(std::lround(v * 16384.0));
			identity = identity && q14[3 * row + col] == (row == col ? 16384 : 0);
		}
		if (absSum > MAX_ROW_ABS_SUM)
		{
			return false;
		}
	}
	return true;
}

} // namespace

void GrabberColorCorrection::configure(const QJsonObject& grabberTest)
{
	QSharedPointer<Logger> log = Logger::getInstance("V4L2");
	QHash<QString, DeviceCorrection> next;
	const auto add = [&](const QString& device, const QJsonObject& entry, int slot) {
		DeviceCorrection c;
		c.slot = slot;
		bool identity = true;
		if (!toQ14(entry["matrix"].toArray(), c.q14, identity))
		{
			Warning(log, "Grabber color correction%s ignored: the matrix needs 9 numbers and at most %.1f as absolute sum per row",
				device.isEmpty() ? "" : QSTRING_CSTR(QString(" for %1").arg(device)), MAX_ROW_ABS_SUM);
			return;
		}
		if (!identity)
		{
			next.insert(device, c);
		}
	};

	const QJsonValue grabbers = grabberTest["grabbers"];
	if (grabbers.isObject())
	{
		const QJsonObject all = grabbers.toObject();
		for (auto it = all.begin(); it != all.end(); ++it)
		{
			const QJsonObject g = it.value().toObject();
			const int slot = g["active"].toInt(-1);
			const QJsonArray slotList = g["slots"].toArray();
			if (!it.key().isEmpty() && g["enable"].toBool(false) && slot >= 0 && slot < slotList.size() && slotList[slot].isObject())
			{
				add(it.key(), slotList[slot].toObject(), slot);
			}
		}
	}
	else
	{
		const QJsonObject correction = grabberTest["correction"].toObject();
		if (correction["enable"].toBool(false))
		{
			add(QString(), correction, -1);
		}
	}

	{
		const QMutexLocker locker(&correctionMutex);
		correctionByDevice = next;
		lastLogged.clear();
	}
	anyCorrection.store(!next.isEmpty(), std::memory_order_relaxed);
	if (next.isEmpty())
	{
		correctionActive.store(false, std::memory_order_relaxed);
	}
	Info(log, "Grabber color correction: %d calibration(s) active", static_cast<int>(next.size()));
}

bool GrabberColorCorrection::isActive()
{
	return correctionActive.load(std::memory_order_relaxed);
}

bool GrabberColorCorrection::apply(const Image<ColorRgb>& in, Image<ColorRgb>& out, const QString& device)
{
	if (!anyCorrection.load(std::memory_order_relaxed) || in.width() <= 0 || in.height() <= 0)
	{
		correctionActive.store(false, std::memory_order_relaxed);
		return false;
	}
	std::array<int16_t, 9> k {};
	bool found = false;
	QString logLine;
	{
		const QMutexLocker locker(&correctionMutex);
		auto it = correctionByDevice.constFind(device);
		if (it == correctionByDevice.constEnd())
		{
			it = correctionByDevice.constFind(QString());
		}
		found = it != correctionByDevice.constEnd();
		if (found)
		{
			k = it->q14;
		}
		const QString key = device + '\n' + (found ? QString::number(it->slot) : QString("off"));
		if (key != lastLogged)
		{
			lastLogged = key;
			logLine = !found ? QString("Grabber color correction off for %1 (no active calibration)").arg(device)
				: it->slot < 0 ? QString("Grabber color correction on for %1").arg(device)
				: QString("Grabber color correction on for %1 (slot %2)").arg(device).arg(it->slot + 1);
		}
	}
	if (!logLine.isEmpty())
	{
		Info(Logger::getInstance("V4L2"), "%s", QSTRING_CSTR(logLine));
	}
	correctionActive.store(found, std::memory_order_relaxed);
	if (!found)
	{
		return false;
	}
	out = Image<ColorRgb>(in.width(), in.height());
	applyQ14(reinterpret_cast<const uint8_t*>(in.memptr()), reinterpret_cast<uint8_t*>(out.memptr()), in.width() * in.height(), k);
	return true;
}
