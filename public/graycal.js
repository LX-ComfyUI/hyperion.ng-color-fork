// Guided gray curve calibration: the math shared by the test server (runs the calibration) and the
// control page (labels, level choice). No dependencies.
//
// The answer to a gray level is a tint the LEDs show too much or too little of. Every tint is a
// direction in red/green/blue ("too much"), "too little" is its complement. One answer lowers the
// factors of the gray curve point along that direction and lifts all factors again so that the
// largest one stays where it was: the hue moves, the brightness hardly. When the answers swing to
// the other side (first "too green", then "too purple") the step is halved, so it settles quickly.
//
// The weight is the share of the gray curve Hyperion applies to the measured color, like
// GrayCurveTransform::gainsPrecise: 1 - Okhsv saturation / saturation limit (ok_color.h of the fork).
(function (global) {
  "use strict";

  // excess of each tint, per channel (the order is the color circle)
  const TINTS = [
    { id: "red", d: [1, 0, 0], hex: "#e5484d" },
    { id: "orange", d: [1, 0.5, 0], hex: "#f08c2e" },
    { id: "yellow", d: [1, 1, 0], hex: "#e6c619" },
    { id: "green", d: [0, 1, 0], hex: "#2fa36b" },
    { id: "cyan", d: [0, 1, 1], hex: "#1fb5c4" },
    { id: "blue", d: [0, 0, 1], hex: "#3b82f6" },
    { id: "purple", d: [0.5, 0, 1], hex: "#8b5cf6" },
    { id: "magenta", d: [1, 0, 1], hex: "#d946c8" },
  ];
  const STRENGTHS = { 1: 0.03, 2: 0.07, 3: 0.15 };
  const MIN_SCALE = 0.25;
  const GAIN_MIN = 0;
  const GAIN_MAX = 2;
  // the levels offered, in the order they are calibrated (bright to dark)
  const LEVELS = [100, 50, 25, 14, 10, 7, 5, 3, 1];
  // below this many 16-bit steps on a channel one step of a factor is coarse
  const COARSE_COUNTS = 20;

  const round2 = (v) => Math.round(v * 100) / 100;
  const clampGain = (v) => Math.min(GAIN_MAX, Math.max(GAIN_MIN, round2(v)));

  // too much (dir "more") or too little ("less") of a tint as the excess per channel
  function direction(tint, dir) {
    const t = TINTS.find((x) => x.id === tint);
    if (!t) return null;
    return dir === "less" ? t.d.map((v) => 1 - v) : t.d.slice();
  }

  // memo = { scale, last } of the level, changed in place; returns the new [r, g, b] factors
  function applyAnswer(gains, tint, dir, strength, memo) {
    const d = direction(tint, dir);
    if (!d) throw new Error("Unbekannte Farbe");
    const s = STRENGTHS[strength];
    if (!s) throw new Error("Unbekannte Stärke");
    const mean = (d[0] + d[1] + d[2]) / 3;
    const centered = d.map((v) => v - mean);
    if (memo.last && centered.reduce((sum, v, c) => sum + v * memo.last[c], 0) < 0) memo.scale = Math.max(MIN_SCALE, (memo.scale ?? 1) / 2);
    memo.last = centered;
    const step = s * (memo.scale ?? 1);
    const top = Math.max(...gains);
    let next = gains.map((g, c) => g * (1 - step * d[c]));
    const k = top / Math.max(...next);
    next = next.map((g) => clampGain(g * k));
    // at least one step of 0.01 where the tint is strongest, or the answer would change nothing
    if (next.every((g, c) => g === round2(gains[c]))) {
      const c = d.indexOf(Math.max(...d));
      next[c] = clampGain(next[c] - 0.01);
    }
    return next;
  }

  // ---- Okhsv saturation (ok_color.h: srgb_to_okhsv), only what the weight needs ----
  const srgbInv = (a) => (a > 0.04045 ? Math.pow((a + 0.055) / 1.055, 2.4) : a / 12.92);
  function linearToOklab(r, g, b) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
  }
  function oklabToLinear(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ];
  }
  function maxSaturation(a, b) {
    let k, w;
    if (-1.88170328 * a - 0.80936493 * b > 1) { k = [1.19086277, 1.76576728, 0.59662641, 0.75515197, 0.56771245]; w = [4.0767416621, -3.3077115913, 0.2309699292]; }
    else if (1.81444104 * a - 1.19445276 * b > 1) { k = [0.73956515, -0.45954404, 0.08285427, 0.12541070, 0.14503204]; w = [-1.2684380046, 2.6097574011, -0.3413193965]; }
    else { k = [1.35733652, -0.00915799, -1.15130210, -0.50559606, 0.00692167]; w = [-0.0041960863, -0.7034186147, 1.7076147010]; }
    let S = k[0] + k[1] * a + k[2] * b + k[3] * a * a + k[4] * a * b;
    const kl = 0.3963377774 * a + 0.2158037573 * b;
    const km = -0.1055613458 * a - 0.0638541728 * b;
    const ks = -0.0894841775 * a - 1.2914855480 * b;
    const l_ = 1 + S * kl, m_ = 1 + S * km, s_ = 1 + S * ks;
    const f = w[0] * l_ ** 3 + w[1] * m_ ** 3 + w[2] * s_ ** 3;
    const f1 = w[0] * 3 * kl * l_ * l_ + w[1] * 3 * km * m_ * m_ + w[2] * 3 * ks * s_ * s_;
    const f2 = w[0] * 6 * kl * kl * l_ + w[1] * 6 * km * km * m_ + w[2] * 6 * ks * ks * s_;
    S -= (f * f1) / (f1 * f1 - 0.5 * f * f2);
    return S;
  }
  const toeInv = (x) => {
    const k1 = 0.206, k2 = 0.03, k3 = (1 + k1) / (1 + k2);
    return (x * x + k1 * x) / (k3 * (x + k2));
  };

  // Okhsv saturation of an RGB color on the 0..255 scale (fractions allowed)
  function okhsvSaturation(rgb) {
    const [L, A, B] = linearToOklab(...rgb.map((v) => srgbInv(Math.max(0, v) / 255)));
    const C = Math.hypot(A, B);
    if (!(C > 1e-12) || !(L > 0)) return 0;
    const a_ = A / C, b_ = B / C;
    const S_cusp = maxSaturation(a_, b_);
    const rgbMax = oklabToLinear(1, S_cusp * a_, S_cusp * b_);
    const L_cusp = Math.cbrt(1 / Math.max(...rgbMax));
    const C_cusp = L_cusp * S_cusp;
    const S_max = C_cusp / L_cusp, T_max = C_cusp / (1 - L_cusp);
    const S_0 = 0.5;
    const k = 1 - S_0 / S_max;
    const t = T_max / (C + L * T_max);
    const C_v = t * C;
    return ((S_0 + T_max) * C_v) / (T_max * S_0 + T_max * k * C_v);
  }

  // share of the gray curve Hyperion applies to this color (1 = full)
  function curveWeight(rgb, saturationLimit) {
    if (!(saturationLimit > 0)) return 0;
    if (rgb.every((v) => v <= 0)) return 0;
    return 1 - Math.min(1, Math.max(0, okhsvSaturation(rgb) / saturationLimit));
  }

  // the gains of the curve at a level (GrayCurveTransform: constant outside, linear between points)
  function gainsAt(points, level) {
    const sorted = (points ?? []).slice().sort((a, b) => a.level - b.level);
    if (!sorted.length) return [1, 1, 1];
    const pick = (p) => [p.gainRed, p.gainGreen, p.gainBlue].map(Number);
    if (level <= sorted[0].level) return pick(sorted[0]);
    if (level >= sorted.at(-1).level) return pick(sorted.at(-1));
    for (let i = 0; i + 1 < sorted.length; ++i) {
      const lo = sorted[i], hi = sorted[i + 1];
      if (level <= hi.level) {
        const t = hi.level > lo.level ? (level - lo.level) / (hi.level - lo.level) : 1;
        return pick(lo).map((v, c) => v + (pick(hi)[c] - v) * t);
      }
    }
    return pick(sorted.at(-1));
  }

  // points with the gains of `level` set (a new point if none has this level), sorted by level
  function withPoint(points, level, gains) {
    const list = (points ?? []).map((p) => ({ ...p }));
    const at = list.findIndex((p) => p.level === level);
    const point = { level, gainRed: gains[0], gainGreen: gains[1], gainBlue: gains[2] };
    if (at >= 0) list[at] = point;
    else list.push(point);
    return list.sort((a, b) => a.level - b.level);
  }

  global.GrayCal = { TINTS, STRENGTHS, LEVELS, COARSE_COUNTS, direction, applyAnswer, okhsvSaturation, curveWeight, gainsAt, withPoint };
})(typeof window !== "undefined" ? window : globalThis);
