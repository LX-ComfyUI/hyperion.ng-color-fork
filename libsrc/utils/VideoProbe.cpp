#include <utils/VideoProbe.h>

#include <QDateTime>
#include <QJsonArray>
#include <QMutex>
#include <QMutexLocker>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>

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

	// average since the last reset
	quint64 n = 0;
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

void VideoProbe::offer(const Image<ColorRgb>& image, const QString& device)
{
	const qint64 now = QDateTime::currentMSecsSinceEpoch();
	if (now > activeUntilMs.load(std::memory_order_relaxed) || image.width() < 4 || image.height() < 4)
	{
		return;
	}

	const FrameStats stats = measure(image);

	const QMutexLocker locker(&mutex);
	state.device = device;
	state.width = image.width();
	state.height = image.height();
	state.lastFrameMs = now;
	++state.frames;
	state.last = stats;

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
	result["last"] = last;

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
	}
	result["avg"] = avg;
	return result;
}
