#include <utils/VideoProbe.h>

#include <utils/Logger.h>

#include <QDateTime>
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

// --- grabber color correction ---

namespace {

// coefficients in Q14; |c| < 2 per coefficient and a row's absolute sum <= 2 keep every partial
// sum of the NEON path inside int16
constexpr double MAX_ROW_ABS_SUM = 2.0;

std::atomic<bool> correctionActive { false };
QMutex correctionMutex;
std::array<int16_t, 9> correctionQ14 {};

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

void GrabberColorCorrection::configure(const QJsonObject& correction)
{
	QSharedPointer<Logger> log = Logger::getInstance("V4L2");
	const QJsonArray matrix = correction["matrix"].toArray();
	bool enable = correction["enable"].toBool(false);
	std::array<int16_t, 9> q14 {};
	bool identity = true;

	if (enable)
	{
		bool valid = matrix.size() == 9;
		for (int row = 0; valid && row < 3; ++row)
		{
			double absSum = 0.0;
			for (int col = 0; col < 3; ++col)
			{
				const double v = matrix[3 * row + col].toDouble(NAN);
				valid = valid && std::isfinite(v);
				absSum += std::abs(v);
				if (valid)
				{
					q14[3 * row + col] = static_cast<int16_t>(std::lround(v * 16384.0));
					identity = identity && q14[3 * row + col] == (row == col ? 16384 : 0);
				}
			}
			valid = valid && absSum <= MAX_ROW_ABS_SUM;
		}
		if (!valid)
		{
			Warning(log, "Grabber color correction ignored: the matrix needs 9 numbers and at most %.1f as absolute sum per row", MAX_ROW_ABS_SUM);
			enable = false;
		}
	}

	const bool active = enable && !identity;
	{
		const QMutexLocker locker(&correctionMutex);
		correctionQ14 = q14;
	}
	if (active != correctionActive.exchange(active))
	{
		Info(log, "Grabber color correction %s", active ? "on" : "off");
	}
}

bool GrabberColorCorrection::isActive()
{
	return correctionActive.load(std::memory_order_relaxed);
}

bool GrabberColorCorrection::apply(const Image<ColorRgb>& in, Image<ColorRgb>& out)
{
	if (!isActive() || in.width() <= 0 || in.height() <= 0)
	{
		return false;
	}
	std::array<int16_t, 9> k;
	{
		const QMutexLocker locker(&correctionMutex);
		k = correctionQ14;
	}
	out = Image<ColorRgb>(in.width(), in.height());
	applyQ14(reinterpret_cast<const uint8_t*>(in.memptr()), reinterpret_cast<uint8_t*>(out.memptr()), in.width() * in.height(), k);
	return true;
}
