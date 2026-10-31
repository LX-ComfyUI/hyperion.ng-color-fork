// "In Grundeinstellung übernehmen": moves what the gray curve corrects into the white value and the
// gamma per channel, so it also acts on colored pictures, and leaves only the rest in the curve.
//
// For a gray input Hyperion computes (MultiColorAdjustment::computePrecise, modelled exactly by
// GrayCurveGraph.math.grayOutput): gamma per channel → mix of the 8 corners (white value) → color
// temperature → gray curve factor. The target is today's LED output at every level of the curve.
//   - white: at 100 % only the white corner counts, so white' = white · curve factor at 100 %
//     (scaled down as a whole when a channel would go above 255)
//   - gamma: per channel the value whose output, with white' and without curve, is closest to the
//     target over the curve's levels (least squares of the log ratio; the corner mix couples the
//     channels a little, so a few rounds one channel at a time), rounded to the schema step 0.05
//   - rest: the factor each curve point still needs to hit the target exactly, so the picture at
//     the calibrated levels stays as it is
// The color temperature, the brightness and the other corners stay untouched.
(function (global) {
  "use strict";

  const GAMMA_MIN = 1;
  const GAMMA_MAX = 4;
  const GAMMA_STEP = 0.05;
  const GAIN_MAX = 2;
  // outputs below this (0..255 scale) are too dark to judge a tint, those levels do not steer gamma
  const MIN_OUTPUT = 0.05;

  const round2 = (v) => Math.round(v * 100) / 100;
  const roundGamma = (g) => Math.round(Math.min(GAMMA_MAX, Math.max(GAMMA_MIN, g)) / GAMMA_STEP) * GAMMA_STEP;

  // entry = channelAdjustment entry; null when the curve is off or has no points
  function fitBase(entry) {
    const M = global.GrayCurveGraph?.math;
    const curve = entry?.grayCurve;
    const points = (curve?.points ?? []).map((p) => ({ level: Number(p.level), gainRed: Number(p.gainRed), gainGreen: Number(p.gainGreen), gainBlue: Number(p.gainBlue) }));
    if (!M || curve?.enabled !== true || !points.length) return null;

    // the black threshold and the backlight come after the factor and do not change, so they stay out
    const model = M.makeModel(entry, null);
    const outOf = (m, level, gains) => M.grayOutput(m, level * 2.55, gains).pre.map((v, c) => v * gains[c]);
    const levels = [...new Set([100, ...points.map((p) => p.level)])].sort((a, b) => b - a);
    const want = new Map(levels.map((l) => [l, outOf(model, l, M.gainsAt(points, l))]));

    let white = model.corners.white.map((w, c) => w * M.gainsAt(points, 100)[c]);
    const top = Math.max(...white);
    if (top > 255) white = white.map((w) => (w * 255) / top);
    white = white.map((w) => Math.min(255, Math.max(0, Math.round(w))));

    const trial = (gamma) => ({ ...model, gamma, corners: { ...model.corners, white } });
    const fitLevels = levels.filter((l) => l < 100 && want.get(l).every((v) => v > MIN_OUTPUT));
    const error = (gamma, c) => fitLevels.reduce((sum, l) => {
      const out = outOf(trial(gamma), l, [1, 1, 1])[c];
      return sum + (out > 0 ? Math.log(out / want.get(l)[c]) ** 2 : 1e6);
    }, 0);
    const gamma = model.gamma.slice();
    if (fitLevels.length) {
      for (let round = 0; round < 4; ++round) {
        for (let c = 0; c < 3; ++c) {
          let best = gamma[c];
          let bestError = Infinity;
          for (let g = GAMMA_MIN; g <= GAMMA_MAX + 1e-9; g += 0.01) {
            const next = gamma.slice();
            next[c] = g;
            const e = error(next, c);
            if (e < bestError) { bestError = e; best = g; }
          }
          gamma[c] = best;
        }
      }
    }
    const gammaOut = gamma.map((g) => Number(roundGamma(g).toFixed(2)));

    const result = trial(gammaOut);
    const rest = points.map((p) => {
      const out = outOf(result, p.level, [1, 1, 1]);
      const g = out.map((o, c) => (o > 0 ? want.get(p.level)[c] / o : 1));
      const [gainRed, gainGreen, gainBlue] = g.map((v) => Math.min(GAIN_MAX, Math.max(0, round2(v))));
      return { level: p.level, gainRed, gainGreen, gainBlue };
    });
    const spread = (list) => Math.max(0, ...list.flatMap((p) => [p.gainRed, p.gainGreen, p.gainBlue].map((v) => Math.abs(v - 1))));

    return {
      before: { gamma: model.gamma.map((g) => Number(g.toFixed(2))), white: model.corners.white.slice(), points, spread: spread(points) },
      after: { gamma: gammaOut, white, points: rest, spread: spread(rest) },
      changed: gammaOut.some((g, c) => Math.abs(g - model.gamma[c]) >= GAMMA_STEP / 2) || white.some((w, c) => w !== model.corners.white[c]),
      // worth it when gamma and white take over a good part of the curve; a tint only in the middle
      // levels (none at the bright and the dark end) is nothing gamma can follow
      useful: spread(points) > 0.015 && spread(rest) <= spread(points) * 0.7,
    };
  }

  global.ColorFit = { fitBase };
})(typeof window !== "undefined" ? window : globalThis);
