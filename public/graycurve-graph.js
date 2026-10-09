// Graph for the gray curve of the Hyperion fork (channelAdjustment[].grayCurve).
//
// The upper chart shows what the LEDs get for every gray of the picture, per channel, like the
// gamma chart of the Hyperion docs (input -> output), but with a logarithmic output axis so the
// dark grays stay readable. The lower strip shows the gray curve factors themselves. The points
// can be dragged in both: up/down changes the factor (1 px = 0.01), sideways the brightness.
//
// Used by the TV test page and by the fork WebUI, so it has no dependencies. The math follows the
// fork source: RgbTransform (gamma, brightness components, temperature, backlight),
// RgbChannelAdjustment::applyPrecise, MultiColorAdjustment::computePrecise,
// GrayCurveTransform::gains and LedDevice::applyBlackThreshold.
//
//   const graph = GrayCurveGraph.create(element, { onChange(points, final), onSelect(index, point) });
//   graph.update({ entry, blackThreshold, writable });
(function (global) {
  "use strict";

  const MAX = 255;
  const MAX_SQUARED = MAX * MAX;
  const CHANNELS = ["r", "g", "b"];
  const GAIN_KEYS = { r: "gainRed", g: "gainGreen", b: "gainBlue" };
  const COLORS = { r: "#e5484d", g: "#2fa36b", b: "#3b82f6" };
  const GAIN_MIN = 0;
  const GAIN_MAX = 2;
  const GAIN_PER_PX = 0.01;
  const MAX_POINTS = 12;
  const LOG_MIN = 0.01; // % of full LED output at the bottom of the log axis
  const STRIP_MIN = 0.5;
  const STRIP_MAX = 1.5;

  const TEXT = {
    all: "Alle",
    red: "Rot",
    green: "Grün",
    blue: "Blau",
    log: "Log",
    linear: "Linear",
    input: "Grau im Bild",
    output: "LED",
    factor: "Faktor",
    point: "Punkt",
    remove: "Punkt löschen",
    off: "Die Graukurve ist aus. Der Graph zeigt, was sie mit diesen Faktoren bewirken würde.",
    hint: "Punkt antippen und hoch/runter ziehen (1 Pixel = 0,01), seitlich verschiebt die Helligkeit. Tippen auf eine freie Stelle legt einen Punkt an.",
    blackThreshold: "Schwarzschwelle",
    withoutCurve: "gestrichelt = ohne Graukurve",
  };

  // ---------------------------------------------------------------- Hyperion math

  // KelvinToRgb.h, with its integer steps
  function kelvinToRgb(kelvin) {
    let t = Math.trunc(Math.min(40000, Math.max(1000, Math.trunc(kelvin))) / 100);
    const clamp = (v) => Math.min(MAX, Math.max(0, Math.trunc(v)));
    const red = t <= 66 ? MAX : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const green = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const blue = t >= 66 ? MAX : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [clamp(red), clamp(green), clamp(blue)];
  }

  // a * b + c with a single rounding, like the FMA instruction the compiler uses for it on the Pi
  // (Dekker's exact product). It matters: brightness 100 gives B_in 0.9999999999999999 instead of 1,
  // so white gets 86 instead of 85.
  function fma(a, b, c) {
    const p = a * b;
    const split = (v) => { const t = 134217729 * v; const hi = t - (t - v); return [hi, v - hi]; };
    const [ah, al] = split(a);
    const [bh, bl] = split(b);
    const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    return (p + c) + e;
  }

  // RgbTransform::updateBrightnessComponents
  function brightnessComponents(brightness, compensation) {
    const b = Math.trunc(brightness);
    if (b <= 0) return { rgb: 0, cmy: 0, w: 0 };
    const fw = compensation * 2.0 / 100.0 + 1.0;
    const fcmy = compensation / 100.0 + 1.0;
    const bIn = b < 50 ? fma(-0.09, b, 7.5) : fma(-0.04, b, 5.0);
    const part = (f) => Math.min(MAX, Math.ceil(Math.min(MAX, MAX / (bIn * f))));
    return { rgb: part(1), cmy: part(fcmy), w: part(fw) };
  }

  function rgbOf(value, fallback) {
    return Array.isArray(value) && value.length === 3 ? value.map(Number) : fallback;
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // everything of a channelAdjustment entry the gray path needs
  function makeModel(entry, blackThreshold) {
    const gammaR = num(entry?.gammaRed, 2.2);
    const gammaG = num(entry?.gammaGreen, -1) < 0 ? gammaR : num(entry?.gammaGreen, gammaR);
    const gammaB = num(entry?.gammaBlue, -1) < 0 ? gammaR : num(entry?.gammaBlue, gammaR);
    const t = Math.min(100, Math.max(0, num(entry?.backlightThreshold, 0))) / 100;
    const shaped = (Math.pow(2, 2 * t) - 1) / (Math.pow(2, 2) - 1);
    const thr = blackThreshold && blackThreshold.enabled !== false ? Math.min(MAX, Math.max(0, num(blackThreshold.threshold, 0.5))) : 0;
    const curve = entry?.grayCurve;
    return {
      gamma: [gammaR, gammaG, gammaB],
      bright: brightnessComponents(num(entry?.brightness, 100), num(entry?.brightnessCompensation, 100)),
      corners: {
        black: rgbOf(entry?.black, [0, 0, 0]),
        red: rgbOf(entry?.red, [255, 0, 0]),
        green: rgbOf(entry?.green, [0, 255, 0]),
        blue: rgbOf(entry?.blue, [0, 0, 255]),
        cyan: rgbOf(entry?.cyan, [0, 255, 255]),
        magenta: rgbOf(entry?.magenta, [255, 0, 255]),
        yellow: rgbOf(entry?.yellow, [255, 255, 0]),
        white: rgbOf(entry?.white, [255, 255, 255]),
      },
      temperature: kelvinToRgb(num(entry?.temperature, 6600)),
      backlightLow: Math.trunc(Math.min(MAX, Math.max(0, MAX * shaped))),
      backlightColored: entry?.backlightColored === true,
      blackThreshold16: Math.round(thr * 257),
      blackThreshold: thr,
      curveEnabled: curve?.enabled === true,
      curveActive: (curve?.saturationLimit ?? 0.15) > 0,
    };
  }

  // GrayCurveTransform::gains for a pure gray (Okhsv saturation 0, so the full factor)
  function gainsAt(points, level) {
    if (!points.length) return [1, 1, 1];
    const sorted = points.slice().sort((a, b) => a.level - b.level);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const pick = (p) => [p.gainRed, p.gainGreen, p.gainBlue].map((g) => Math.min(4, Math.max(0, num(g, 1))));
    if (level >= last.level) return pick(last);
    if (level <= first.level) return pick(first);
    for (let i = 0; i + 1 < sorted.length; ++i) {
      const lower = sorted[i];
      const upper = sorted[i + 1];
      if (level <= upper.level) {
        const span = upper.level - lower.level;
        const t = span > 0 ? (level - lower.level) / span : 1;
        const lo = pick(lower);
        const hi = pick(upper);
        return lo.map((v, c) => v + (hi[c] - v) * t);
      }
    }
    return pick(last);
  }

  // MultiColorAdjustment::computePrecise for the gray input (x, x, x), x on the 0..255 scale.
  // Returns the LED values on the 0..255 scale (float) and the values before the gray curve factor.
  function grayOutput(model, x, gains) {
    const [r, g, b] = model.gamma.map((gamma) => Math.min(MAX, Math.max(0, Math.pow(x / MAX, gamma) * MAX)));
    const nrNg = (MAX - r) * (MAX - g);
    const rNg = r * (MAX - g);
    const nrG = (MAX - r) * g;
    const rG = r * g;
    const weights = [
      ["black", nrNg * (MAX - b) / MAX_SQUARED, MAX],
      ["red", rNg * (MAX - b) / MAX_SQUARED, model.bright.rgb],
      ["green", nrG * (MAX - b) / MAX_SQUARED, model.bright.rgb],
      ["blue", nrNg * b / MAX_SQUARED, model.bright.rgb],
      ["cyan", nrG * b / MAX_SQUARED, model.bright.cmy],
      ["magenta", rNg * b / MAX_SQUARED, model.bright.cmy],
      ["yellow", rG * (MAX - b) / MAX_SQUARED, model.bright.cmy],
      ["white", rG * b / MAX_SQUARED, model.bright.w],
    ];
    const out = [0, 0, 0];
    for (const [corner, weight, brightness] of weights) {
      const adjusted = brightness * weight / MAX_SQUARED;
      model.corners[corner].forEach((v, c) => { out[c] += Math.min(MAX, Math.max(0, v * adjusted)); });
    }
    const pre = out.map((v, c) => Math.min(v, MAX) * model.temperature[c] / MAX);
    const led = pre.map((v, c) => Math.min(v * gains[c], MAX));

    const low = model.backlightLow;
    if (led[0] + led[1] + led[2] < low * 3) {
      for (let c = 0; c < 3; ++c) led[c] = model.backlightColored ? Math.max(led[c], low) : low;
    }
    const t16 = model.blackThreshold16;
    if (t16 > 0 && led.every((v) => Math.round(Math.min(65535, Math.max(0, v * 257))) < t16)) {
      led.fill(0);
    }
    return { pre, led };
  }

  // ---------------------------------------------------------------- helpers

  const fmt = (v, digits) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtPercent = (v) => (v === 0 ? "0" : v >= 10 ? fmt(v, 0) : v >= 1 ? fmt(v, 1) : v >= 0.01 ? fmt(v, 2) : fmt(v, 3));
  const roundGain = (g) => Math.min(GAIN_MAX, Math.max(GAIN_MIN, Math.round(g * 100) / 100));
  const clonePoints = (points) => points.map((p) => ({ level: num(p.level, 50), gainRed: num(p.gainRed, 1), gainGreen: num(p.gainGreen, 1), gainBlue: num(p.gainBlue, 1) }));
  const SVG_NS = "http://www.w3.org/2000/svg";

  // nice upper end for the linear output axis
  function niceMax(v) {
    const steps = [1, 2, 2.5, 5, 10];
    const decade = Math.pow(10, Math.floor(Math.log10(Math.max(v, 0.01))));
    for (const s of steps) if (s * decade >= v) return s * decade;
    return 10 * decade;
  }

  let styleAdded = false;
  function addStyle() {
    if (styleAdded) return;
    styleAdded = true;
    const style = document.createElement("style");
    style.textContent = `
      .gcg { color: inherit; }
      .gcg-bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 4px 0 8px; }
      .gcg-seg { display: inline-flex; border: 1px solid var(--btn-line, rgba(127,127,127,.5)); border-radius: 8px; overflow: hidden; }
      .gcg-seg button { all: unset; cursor: pointer; padding: 6px 11px; font-size: 14px; line-height: 1.2; color: inherit; }
      .gcg-seg button + button { border-left: 1px solid var(--btn-line, rgba(127,127,127,.5)); }
      .gcg-seg button[aria-pressed="true"] { background: var(--accent, #0a74e8); color: var(--accent-text, #fff); }
      .gcg-seg button .gcg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }
      .gcg svg { display: block; width: 100%; touch-action: pan-y; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
      .gcg svg text { font: 11px system-ui, sans-serif; fill: currentColor; opacity: .7; }
      .gcg .gcg-grid { stroke: currentColor; stroke-opacity: .13; stroke-width: 1; }
      .gcg .gcg-axis { stroke: currentColor; stroke-opacity: .35; stroke-width: 1; }
      .gcg .gcg-hit { fill: transparent; touch-action: none; cursor: grab; }
      .gcg .gcg-info { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; min-height: 34px; margin-top: 6px; font-size: 14px; }
      .gcg .gcg-info b { font-weight: 600; }
      .gcg .gcg-info button { font: inherit; font-size: 14px; padding: 6px 10px; margin-left: auto; }
      .gcg .gcg-note { font-size: 13px; opacity: .75; margin: 4px 0 0; }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------- graph

  function create(container, options = {}) {
    addStyle();
    const text = Object.assign({}, TEXT, options.text);
    const state = {
      entry: null,
      model: null,
      points: [],
      channel: "all",
      scale: "log",
      selected: -1,
      writable: false,
      drag: null,
      width: 0,
    };

    container.classList.add("gcg");
    container.innerHTML = `
      <div class="gcg-bar">
        <span class="gcg-seg" data-role="channel">
          <button type="button" data-v="all">${text.all}</button>
          <button type="button" data-v="r"><span class="gcg-dot" style="background:${COLORS.r}"></span>${text.red}</button>
          <button type="button" data-v="g"><span class="gcg-dot" style="background:${COLORS.g}"></span>${text.green}</button>
          <button type="button" data-v="b"><span class="gcg-dot" style="background:${COLORS.b}"></span>${text.blue}</button>
        </span>
        <span class="gcg-seg" data-role="scale">
          <button type="button" data-v="log">${text.log}</button>
          <button type="button" data-v="linear">${text.linear}</button>
        </span>
      </div>
      <svg></svg>
      <div class="gcg-info"></div>
      <p class="gcg-note"></p>`;
    const svg = container.querySelector("svg");
    const info = container.querySelector(".gcg-info");
    const note = container.querySelector(".gcg-note");

    container.querySelector('[data-role="channel"]').addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (b) { state.channel = b.dataset.v; render(); }
    });
    container.querySelector('[data-role="scale"]').addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (b) { state.scale = b.dataset.v; render(); }
    });
    info.addEventListener("click", (ev) => {
      if (!ev.target.closest("button[data-role=remove]")) return;
      if (!state.writable || state.points.length < 2 || state.selected < 0) return;
      state.points.splice(state.selected, 1);
      state.selected = -1;
      render();
      emit(true);
    });

    // ---- layout
    function layout() {
      const W = Math.max(260, Math.round(container.clientWidth || 340));
      const left = 46;
      const right = 12;
      const main = { x: left, y: 8, w: W - left - right, h: Math.round(Math.min(300, Math.max(200, W * 0.62))) };
      const strip = { x: left, y: main.y + main.h + 30, w: main.w, h: 100 };
      return { W, H: strip.y + strip.h + 22, main, strip };
    }

    function xOf(L, level) {
      const f = Math.min(1, Math.max(0, level / 100));
      return L.main.x + L.main.w * (state.scale === "log" ? Math.sqrt(f) : f);
    }
    function levelOfX(L, x) {
      const f = Math.min(1, Math.max(0, (x - L.main.x) / L.main.w));
      return 100 * (state.scale === "log" ? f * f : f);
    }
    function yOfOut(L, percent, linMax) {
      const box = L.main;
      if (state.scale === "log") {
        const v = Math.log10(Math.max(LOG_MIN, Math.min(100, percent)));
        const lo = Math.log10(LOG_MIN);
        return box.y + box.h * (1 - (v - lo) / (2 - lo));
      }
      return box.y + box.h * (1 - Math.min(1, Math.max(0, percent / linMax)));
    }
    function yOfGain(L, g) {
      const f = (Math.min(STRIP_MAX, Math.max(STRIP_MIN, g)) - STRIP_MIN) / (STRIP_MAX - STRIP_MIN);
      return L.strip.y + L.strip.h * (1 - f);
    }

    function activeChannels() {
      return state.channel === "all" ? CHANNELS : [state.channel];
    }

    // ---- drawing
    let rafPending = false;
    function render() {
      container.querySelectorAll('[data-role="channel"] button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.channel)));
      container.querySelectorAll('[data-role="scale"] button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.scale)));
      if (!state.model) {
        svg.innerHTML = "";
        info.innerHTML = "";
        return;
      }
      const L = layout();
      state.layout = L;
      svg.setAttribute("viewBox", `0 0 ${L.W} ${L.H}`);
      svg.setAttribute("height", String(L.H));

      const model = state.model;
      const points = state.points;
      const samples = [];
      let peak = 0;
      for (let x = 0; x <= MAX; ++x) {
        const level = x * 100 / MAX;
        const withCurve = grayOutput(model, x, gainsAt(points, level)).led;
        const without = grayOutput(model, x, [1, 1, 1]).led;
        samples.push({ level, withCurve, without });
        peak = Math.max(peak, ...withCurve, ...without);
      }
      const linMax = niceMax(peak * 100 / MAX * 1.05);
      const parts = [];
      const active = activeChannels();

      // grid + axis labels, upper chart
      const xTicks = state.scale === "log" ? [0, 2, 5, 10, 25, 50, 100] : [0, 25, 50, 75, 100];
      for (const t of xTicks) {
        const x = xOf(L, t);
        parts.push(`<line class="gcg-grid" x1="${x}" y1="${L.main.y}" x2="${x}" y2="${L.main.y + L.main.h}"/>`);
        parts.push(`<line class="gcg-grid" x1="${x}" y1="${L.strip.y}" x2="${x}" y2="${L.strip.y + L.strip.h}"/>`);
        parts.push(`<text x="${x}" y="${L.strip.y + L.strip.h + 15}" text-anchor="middle">${t}</text>`);
      }
      const yTicks = state.scale === "log" ? [0.01, 0.1, 1, 10, 100] : [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => f * linMax);
      for (const t of yTicks) {
        const y = yOfOut(L, t, linMax);
        parts.push(`<line class="gcg-grid" x1="${L.main.x}" y1="${y}" x2="${L.main.x + L.main.w}" y2="${y}"/>`);
        parts.push(`<text x="${L.main.x - 5}" y="${y + 4}" text-anchor="end">${fmtPercent(t)}</text>`);
      }
      parts.push(`<text x="${L.main.x + 4}" y="${L.main.y + 12}" style="opacity:.55">${text.output} %</text>`);
      parts.push(`<rect class="gcg-axis" fill="none" x="${L.main.x}" y="${L.main.y}" width="${L.main.w}" height="${L.main.h}"/>`);

      // black threshold of the LED device
      if (model.blackThreshold > 0) {
        const y = yOfOut(L, model.blackThreshold * 100 / MAX, linMax);
        if (y >= L.main.y && y <= L.main.y + L.main.h) {
          parts.push(`<line x1="${L.main.x}" y1="${y}" x2="${L.main.x + L.main.w}" y2="${y}" stroke="currentColor" stroke-opacity=".45" stroke-dasharray="2 3"/>`);
          parts.push(`<text x="${L.main.x + L.main.w - 4}" y="${y - 4}" text-anchor="end" style="opacity:.6">${text.blackThreshold}</text>`);
        }
      }

      // the curves: dashed = without gray curve, solid = with it
      const curveChanges = samples.some((s) => s.withCurve.some((v, c) => Math.abs(v - s.without[c]) > 1e-6));
      CHANNELS.forEach((ch, c) => {
        const dim = active.includes(ch) ? 1 : 0.22;
        const path = (key) => samples.map((s, i) => `${i ? "L" : "M"}${xOf(L, s.level).toFixed(1)},${yOfOut(L, s[key][c] * 100 / MAX, linMax).toFixed(1)}`).join("");
        if (curveChanges) parts.push(`<path d="${path("without")}" fill="none" stroke="${COLORS[ch]}" stroke-width="1.2" stroke-dasharray="4 3" opacity="${0.55 * dim}"/>`);
        parts.push(`<path d="${path("withCurve")}" fill="none" stroke="${COLORS[ch]}" stroke-width="2" opacity="${dim}"/>`);
      });

      // lower strip: the factors
      for (const g of [0.5, 0.75, 1, 1.25, 1.5]) {
        const y = yOfGain(L, g);
        parts.push(`<line class="${g === 1 ? "gcg-axis" : "gcg-grid"}" x1="${L.strip.x}" y1="${y}" x2="${L.strip.x + L.strip.w}" y2="${y}"/>`);
        if (g !== 0.75 && g !== 1.25) parts.push(`<text x="${L.strip.x - 5}" y="${y + 4}" text-anchor="end">${fmt(g, 1)}</text>`);
      }
      parts.push(`<text x="${L.strip.x + 4}" y="${L.strip.y + 12}" style="opacity:.55">${text.factor}</text>`);
      parts.push(`<text x="${L.strip.x + L.strip.w}" y="${L.strip.y - 8}" text-anchor="end" style="opacity:.55">${text.input} %</text>`);
      parts.push(`<rect class="gcg-axis" fill="none" x="${L.strip.x}" y="${L.strip.y}" width="${L.strip.w}" height="${L.strip.h}"/>`);
      CHANNELS.forEach((ch, c) => {
        const dim = active.includes(ch) ? 1 : 0.22;
        const d = samples.map((s, i) => `${i ? "L" : "M"}${xOf(L, s.level).toFixed(1)},${yOfGain(L, gainsAt(points, s.level)[c]).toFixed(1)}`).join("");
        parts.push(`<path d="${d}" fill="none" stroke="${COLORS[ch]}" stroke-width="2" opacity="${dim}"/>`);
      });

      // selected point: guide line through both charts
      if (state.selected >= 0 && points[state.selected]) {
        const x = xOf(L, points[state.selected].level);
        parts.push(`<line x1="${x}" y1="${L.main.y}" x2="${x}" y2="${L.strip.y + L.strip.h}" stroke="currentColor" stroke-opacity=".5" stroke-dasharray="3 3"/>`);
      }

      // points: a visible dot per channel and a larger invisible hit area
      const handles = [];
      points.forEach((p, i) => {
        const x = xOf(L, p.level);
        const out = grayOutput(model, p.level * MAX / 100, gainsAt(points, p.level)).led;
        CHANNELS.forEach((ch, c) => {
          const on = active.includes(ch);
          const sel = i === state.selected;
          const gain = [p.gainRed, p.gainGreen, p.gainBlue][c];
          for (const [panel, y] of [["main", yOfOut(L, out[c] * 100 / MAX, linMax)], ["strip", yOfGain(L, gain)]]) {
            parts.push(`<circle cx="${x}" cy="${y}" r="${sel ? 6 : 4.5}" fill="${on ? COLORS[ch] : "none"}" stroke="${sel && on ? "currentColor" : COLORS[ch]}" stroke-width="${sel && on ? 2 : 1.2}" opacity="${on ? 1 : 0.35}"/>`);
            if (on) handles.push({ i, ch, panel, x, y });
          }
        });
      });
      if (state.writable) {
        for (const h of handles) parts.push(`<circle class="gcg-hit" data-panel="${h.panel}" cx="${h.x}" cy="${h.y}" r="16"/>`);
      }
      state.handles = handles;
      svg.innerHTML = parts.join("");

      renderInfo();
    }

    function renderInfo() {
      const p = state.points[state.selected];
      note.textContent = state.model && !state.model.curveEnabled ? text.off + " " + text.hint : text.hint;
      if (!p) {
        info.innerHTML = `<span style="opacity:.7">${text.withoutCurve}</span>`;
        return;
      }
      const out = grayOutput(state.model, p.level * MAX / 100, gainsAt(state.points, p.level)).led.map((v) => v * 100 / MAX);
      info.innerHTML = `
        <span><b>${text.point} ${fmt(p.level, 0)} %</b></span>
        <span>${text.factor}: <span style="color:${COLORS.r}">${fmt(p.gainRed, 2)}</span> · <span style="color:${COLORS.g}">${fmt(p.gainGreen, 2)}</span> · <span style="color:${COLORS.b}">${fmt(p.gainBlue, 2)}</span></span>
        <span>${text.output}: <span style="color:${COLORS.r}">${fmtPercent(out[0])}</span> · <span style="color:${COLORS.g}">${fmtPercent(out[1])}</span> · <span style="color:${COLORS.b}">${fmtPercent(out[2])}</span> %</span>
        <button type="button" data-role="remove" ${state.writable && state.points.length > 1 ? "" : "disabled"}>${text.remove}</button>`;
    }

    function scheduleRender() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; render(); });
    }

    function emit(final) {
      if (typeof options.onChange === "function") options.onChange(clonePoints(state.points), final);
    }

    function select(i) {
      state.selected = i;
      if (i >= 0 && typeof options.onSelect === "function") options.onSelect(i, Object.assign({}, state.points[i]));
    }

    // ---- pointer handling
    function svgPoint(ev) {
      const rect = svg.getBoundingClientRect();
      const L = state.layout;
      const k = rect.width > 0 ? L.W / rect.width : 1;
      return { x: (ev.clientX - rect.left) * k, y: (ev.clientY - rect.top) * k };
    }

    // iOS ignores touch-action on SVG children in some versions, so the hit areas stop the scroll themselves
    svg.addEventListener("touchstart", (ev) => {
      if (ev.target.classList?.contains("gcg-hit")) ev.preventDefault();
    }, { passive: false });

    svg.addEventListener("pointerdown", (ev) => {
      if (!state.model || !state.layout) return;
      const pos = svgPoint(ev);
      if (ev.target.classList?.contains("gcg-hit") && state.writable) {
        // the nearest handle of that chart wins, so overlapping points stay reachable
        const panel = ev.target.dataset.panel;
        let best = null;
        for (const h of state.handles) {
          if (h.panel !== panel) continue;
          const d = Math.hypot(h.x - pos.x, h.y - pos.y);
          if (!best || d < best.d) best = { h, d };
        }
        if (!best) return;
        ev.preventDefault();
        svg.setPointerCapture(ev.pointerId);
        const p = state.points[best.h.i];
        const sorted = state.points.map((q, j) => ({ level: q.level, j })).filter((q) => q.j !== best.h.i);
        const below = sorted.filter((q) => q.level < p.level).reduce((m, q) => Math.max(m, q.level), -Infinity);
        const above = sorted.filter((q) => q.level > p.level).reduce((m, q) => Math.min(m, q.level), Infinity);
        state.drag = {
          id: ev.pointerId, i: best.h.i, ch: best.h.ch, start: pos, axis: null, moved: false,
          gains: [p.gainRed, p.gainGreen, p.gainBlue], level: p.level,
          minLevel: Number.isFinite(below) ? below + 1 : 0, maxLevel: Number.isFinite(above) ? above - 1 : 100,
        };
        select(best.h.i);
        render();
        return;
      }
      // a tap on a free spot (no scroll) adds a point there
      state.drag = { id: ev.pointerId, tap: true, start: pos };
    });

    svg.addEventListener("pointermove", (ev) => {
      const d = state.drag;
      if (!d || d.id !== ev.pointerId || d.tap) return;
      const pos = svgPoint(ev);
      const dx = pos.x - d.start.x;
      const dy = pos.y - d.start.y;
      if (!d.axis) {
        if (Math.hypot(dx, dy) < 5) return;
        d.axis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
      }
      const p = state.points[d.i];
      if (d.axis === "y") {
        const delta = -dy * GAIN_PER_PX;
        const chans = state.channel === "all" ? [0, 1, 2] : [CHANNELS.indexOf(d.ch)];
        chans.forEach((c) => { p[GAIN_KEYS[CHANNELS[c]]] = roundGain(d.gains[c] + delta); });
      } else {
        const level = Math.round(levelOfX(state.layout, pos.x));
        p.level = Math.min(d.maxLevel, Math.max(d.minLevel, level));
      }
      d.moved = true;
      scheduleRender();
      emit(false);
    });

    function endDrag(ev, cancelled) {
      const d = state.drag;
      if (!d || d.id !== ev.pointerId) return;
      state.drag = null;
      if (d.tap) {
        if (cancelled || !state.writable) return;
        const pos = svgPoint(ev);
        if (Math.hypot(pos.x - d.start.x, pos.y - d.start.y) > 6) return;
        addPointAt(pos);
        return;
      }
      if (d.moved) {
        render();
        emit(true);
      }
    }
    svg.addEventListener("pointerup", (ev) => endDrag(ev, false));
    svg.addEventListener("pointercancel", (ev) => endDrag(ev, true));

    function addPointAt(pos) {
      const L = state.layout;
      const inside = (box) => pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h;
      if (!inside(L.main) && !inside(L.strip)) return;
      if (state.points.length >= MAX_POINTS) return;
      const level = Math.min(100, Math.max(1, Math.round(levelOfX(L, pos.x))));
      if (state.points.some((p) => Math.abs(p.level - level) < 1)) return;
      // the new point keeps the curve as it is, it only adds a handle there
      const [gr, gg, gb] = gainsAt(state.points, level).map(roundGain);
      const point = { level, gainRed: gr, gainGreen: gg, gainBlue: gb };
      state.points.push(point);
      state.points.sort((a, b) => b.level - a.level);
      select(state.points.indexOf(point));
      render();
      emit(true);
    }

    if (typeof ResizeObserver === "function") {
      let lastWidth = 0;
      new ResizeObserver(() => {
        const w = container.clientWidth;
        if (w && w !== lastWidth) { lastWidth = w; scheduleRender(); }
      }).observe(container);
    }

    return {
      // entry = channelAdjustment entry, blackThreshold = device "blackThreshold" object (optional)
      update({ entry, blackThreshold, writable }) {
        state.entry = entry ?? null;
        state.model = entry ? makeModel(entry, blackThreshold) : null;
        state.writable = !!writable && !!entry;
        // a running drag keeps its own points, the answer of a live save may be older
        if (!state.drag || state.drag.tap) {
          state.points = clonePoints(entry?.grayCurve?.points ?? []);
          if (state.selected >= state.points.length) state.selected = -1;
        }
        render();
      },
      select(i) { state.selected = i; render(); },
      get dragging() { return !!state.drag && !state.drag.tap; },
    };
  }

  global.GrayCurveGraph = { create, math: { kelvinToRgb, brightnessComponents, makeModel, gainsAt, grayOutput } };
})(typeof window !== "undefined" ? window : globalThis);
