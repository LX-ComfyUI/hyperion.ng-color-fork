// LED layout correction from the guided position test. Shared by the server (writes the layout) and
// the control page (shows the result).
//
// An answer is an offset in LED numbers: offset +3 at LED 91 means the LED that lights up sits
// where the marker of LED 94 would be. LED 91 then has to sample the picture area LED 94 has now.
// Between the measured points of an edge run the offset is interpolated linearly, beyond the outer
// points it is extended along the line of the two outer points. At the end of a run the area stops
// at the picture corner: LEDs beyond the picture take the corner's color.

import { applyLedAreaDepth, ledSegments } from "./overlay.js";

// measuring points per edge run: near both ends, at a quarter, the middle and three quarters
export const GUIDE_FRACTIONS = [0.04, 0.27, 0.5, 0.73, 0.96];
export const MAX_ANSWER = 8;

// edge runs of a layout, as the position test shows them (runs without an edge are left out)
export function layoutRuns(leds) {
  const areas = applyLedAreaDepth(leds.map((l) => (Array.isArray(l) ? l : [l.hmin, l.hmax, l.vmin, l.vmax])), 0, 0);
  return ledSegments(areas).filter((s) => s.edge !== "other" && s.end - s.start >= 2);
}

export function guidePoints(runs) {
  const out = [];
  for (const r of runs) {
    const len = r.end - r.start;
    for (const f of GUIDE_FRACTIONS) {
      const i = r.start + Math.round(f * len);
      if (!out.includes(i)) out.push(i);
    }
  }
  return out;
}

// measured points of one run, sorted: [[index, offset], ...] (skipped points are left out)
function runPoints(run, answers) {
  return Object.entries(answers ?? {})
    .map(([i, o]) => [Number(i), o])
    .filter(([i, o]) => i >= run.start && i <= run.end && typeof o === "number" && Number.isFinite(o))
    .sort((a, b) => a[0] - b[0]);
}

// offset of LED i in its run from the measured points
function curve(pts, i) {
  if (!pts.length) return 0;
  if (pts.length === 1) return pts[0][1];
  let a = pts[0], b = pts[1];
  if (i > pts[pts.length - 1][0]) [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
  else for (let k = 1; k < pts.length; k++) if (i <= pts[k][0]) { [a, b] = [pts[k - 1], pts[k]]; break; }
  return a[1] + ((b[1] - a[1]) * (i - a[0])) / (b[0] - a[0]);
}

// offset of every LED (0 for LEDs outside the measured runs)
export function offsetsFromAnswers(n, runs, answers) {
  const out = new Array(n).fill(0);
  for (const r of runs) {
    const pts = runPoints(r, answers);
    for (let i = r.start; i <= r.end; i++) out[i] = curve(pts, i);
  }
  return out;
}

const runOf = (runs, i) => runs.find((r) => i >= r.start && i <= r.end);
const clampTo = (r, t) => Math.min(r.end, Math.max(r.start, t));
function lerpAt(values, t) {
  const lo = Math.floor(t), hi = Math.ceil(t);
  return lo === hi ? values[lo] : values[lo] + (values[hi] - values[lo]) * (t - lo);
}

// A second round measures on the corrected layout. LED i shows up at the corrected marker of
// j = i + residual, and that marker samples the original area of j + previous(j).
export function composeOffsets(previous, residual, runs) {
  return residual.map((r, i) => {
    const run = runOf(runs, i);
    if (!run) return 0;
    const j = clampTo(run, i + r);
    return j + lerpAt(previous, j) - i;
  });
}

const round4 = (v) => Math.round(v * 10000) / 10000;

// The corrected layout: each LED gets the original area at its position plus offset (fractional
// positions interpolate between the two neighbouring areas), the other properties stay as they are
export function correctedLeds(baseLeds, runs, offsets) {
  return baseLeds.map((led, i) => {
    const run = runOf(runs, i);
    if (!run || !offsets[i]) return { ...led };
    const t = clampTo(run, i + offsets[i]);
    const lo = baseLeds[Math.floor(t)], hi = baseLeds[Math.ceil(t)], f = t - Math.floor(t);
    const mix = (k) => round4(lo[k] + (hi[k] - lo[k]) * f);
    return { ...led, hmin: mix("hmin"), hmax: mix("hmax"), vmin: mix("vmin"), vmax: mix("vmax") };
  });
}

// same areas (rounded like the layout), to see whether Hyperion still has the layout we wrote
export function sameLayout(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((l, i) => ["hmin", "hmax", "vmin", "vmax"].every((k) => Math.abs(Number(l[k]) - Number(b[i][k])) < 2e-4));
}

// Straight line through the points of one run (least squares) and how far the points are off it:
// a small spread means an even stretch or shift (picture smaller or shifted against the LED frame),
// a large one a step somewhere (joint, gap at a corner)
export function runSummary(run, answers) {
  const pts = runPoints(run, answers);
  if (pts.length < 2) return { points: pts, start: pts[0]?.[1] ?? null, end: pts[0]?.[1] ?? null, spread: 0 };
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const slope = sxx ? pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
  const at = (i) => my + slope * (i - mx);
  const spread = Math.max(...pts.map((p) => Math.abs(p[1] - at(p[0]))));
  return { points: pts, start: at(run.start), end: at(run.end), slope, spread };
}
