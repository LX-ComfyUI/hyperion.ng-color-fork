// Report of the grabber test of the Hyperion fork: how the video grabber sees known test colors.
//
// The TV test page shows each color full screen on the device that feeds the TV, Hyperion measures
// the decoded grabber frames (VideoProbe, before any calibration) and the test page stores the
// result in the global setting "grabberTest". This file holds the test steps, the evaluation and
// the rendering, shared by the TV test page and the fork WebUI (Aufnahme Hardware), so it has no
// dependencies.
//
//   GrabberTestReport.basicSteps()                       the steps of the basic test, in order
//   GrabberTestReport.analyze(result)                    numbers and findings of a basic test
//   GrabberTestReport.render(element, { basic, custom, current, lang })
//
// result = { date, grabber: { name, device, width, height, fps, encoding, ... }, frame: { width, height },
//            steps: [{ group, name?, sent: [r, g, b], got: [r, g, b], noise: [..], spread: [..], n }] }
(function (global) {
  "use strict";

  const GRAYS = [2, 4, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 160, 192, 224, 235, 245, 255];
  const PRIMARY_LEVELS = [4, 8, 16, 32, 50, 128, 255];
  const SECONDARY_LEVELS = [16, 50, 128, 255];
  const LADDERS = [
    ["red", [1, 0, 0], PRIMARY_LEVELS],
    ["green", [0, 1, 0], PRIMARY_LEVELS],
    ["blue", [0, 0, 1], PRIMARY_LEVELS],
    ["cyan", [0, 1, 1], SECONDARY_LEVELS],
    ["magenta", [1, 0, 1], SECONDARY_LEVELS],
    ["yellow", [1, 1, 0], SECONDARY_LEVELS],
  ];
  const MIXES = [
    ["orange", [255, 128, 0]],
    ["skin", [225, 170, 140]],
  ];
  const CHANNEL_COLORS = ["#e5484d", "#2fa36b", "#3b82f6"];

  // grabber settings that change what the grabber delivers; a result taken with other values is outdated
  const GRABBER_KEYS = ["device", "input", "width", "height", "fps", "encoding", "hardware_brightness", "hardware_contrast", "hardware_saturation", "hardware_hue"];

  const TEXT = {
    de: {
      title: "Grabber-Test",
      none: "Noch kein Grabber-Test gespeichert.",
      measured: "Gemessen am {date}",
      frame: "Bild {w}×{h}",
      stale: "Seit diesem Test wurden Grabber-Einstellungen geändert ({keys}). Wiederhole den Test, damit die Werte wieder stimmen.",
      gray: "Grau",
      red: "Rot", green: "Grün", blue: "Blau", cyan: "Cyan", magenta: "Magenta", yellow: "Gelb",
      orange: "Orange", skin: "Hautton", black: "Schwarz", custom: "Eigene Farbe",
      grayChart: "Graustufen",
      grayChartHint: "Waagerecht die gesendete Stufe, senkrecht was der Grabber liefert. Die gepunktete Linie ist ideal. Beide Achsen sind gestaucht, damit die dunklen Stufen lesbar bleiben.",
      ladders: "Farbleitern",
      laddersHint: "Jede Farbe in mehreren Helligkeiten. Durchgezogen der Kanal der Farbe, gestrichelt die Kanäle, die dunkel bleiben sollten.",
      colLadder: "Farbe", colVisible: "erkennbar ab", colPure: "Farbton stimmt ab", colPurity: "Fremdanteil bei 255",
      never: "nie",
      allValues: "Alle Messwerte",
      colColor: "Farbe", colSent: "gesendet", colGot: "Grabber", colDiff: "Abweichung", colNoise: "Rauschen",
      customTitle: "Eigene Farben",
      customMeasured: "Gemessen am {date}",
      f_blackGood: "Schwarz kommt als {v} an. Ideal ist 0, das passt.",
      f_blackLift: "Schwarz ist angehoben: Es kommt als {v} statt 0 an. Dunkle Szenen wirken an den LEDs dadurch heller und flauer.",
      f_blackHigh: "Schwarz ist deutlich angehoben: Es kommt als {v} statt 0 an. Prüfe den HDMI-Farbbereich des Zuspielgeräts und die Hardware-Helligkeit des Grabbers.",
      f_limited: "Schwarz kommt als etwa {b} und Weiß als etwa {w} an. Das Zuspielgerät sendet sehr wahrscheinlich Limited Range (16–235), und der Grabber rechnet es nicht auf 0–255 um. Stelle am Zuspielgerät Full Range (0–255) ein.",
      f_whiteGood: "Weiß kommt als {v} an. Das passt.",
      f_whiteLow: "Weiß erreicht nur {v} statt 255. Helle Farben kommen etwas dunkler an.",
      f_darkGood: "Auch die dunkelsten Graustufen sind unterscheidbar.",
      f_darkSmall: "Grau 2 lässt sich nicht von Schwarz unterscheiden. Das ist normal, ab Grau 4 ist alles unterscheidbar.",
      f_darkLost: "Dunkle Stufen gehen verloren: Grau 0 bis {v} kommt gleich an.",
      f_darkClipped: "Grau 0 bis {v} kommt gleich an, Schwarz wird abgeschnitten. Wahrscheinlich passen die Farbbereiche nicht zusammen: Das Zuspielgerät sendet Full Range, der Grabber erwartet Limited Range (oder umgekehrt).",
      f_lightLost: "Helle Stufen gehen verloren: Grau {v} bis 255 kommt gleich an.",
      f_tintGood: "Grau bleibt neutral (höchstens {v} Stufen Unterschied zwischen den Kanälen).",
      f_tintWarn: "Grau bekommt einen leichten Farbstich: bei Grau {s} bis zu {v} Stufen, {c} ist am stärksten.",
      f_tintBad: "Grau hat einen deutlichen Farbstich: bei Grau {s} bis zu {v} Stufen, {c} ist am stärksten.",
      f_noiseGood: "Rauschen: ±{v} Stufen. Das Bild ist ruhig.",
      f_noiseWarn: "Rauschen: ±{v} Stufen. Etwas unruhig, die LEDs mitteln das aber weg.",
      f_noiseBad: "Rauschen: ±{v} Stufen. Das Bild ist sehr unruhig.",
      f_drift: "Schwarz hat sich während des Tests um {v} Stufen verändert. Der Grabber war noch nicht stabil, wiederhole den Test.",
      f_darkInvisible: "Sehr dunkle Farben gehen verloren: {list}.",
      f_darkHue: "Dunkle Farben verlieren ihren Farbton: {list}.",
      f_darkHueGood: "Auch dunkle Farben behalten ihren Farbton.",
      f_crosstalk: "Farben sind nicht rein: {list}. Das deutet auf eine abweichende Farbmatrix (BT.601/BT.709) oder eine Farbsättigungs-Einstellung hin.",
      f_unstable: "{n} Schritte wurden nicht ganz ruhig gemessen. Wiederhole den Test, wenn Werte seltsam aussehen.",
      pureFromItem: "{c} erst ab {v}",
      visibleFromItem: "{c} erst ab {v} erkennbar",
      neverItem: "{c} gar nicht",
      crosstalkItem: "{c} {v} %",
      keys: { device: "Gerät", input: "Eingang", width: "Breite", height: "Höhe", fps: "Bildrate", encoding: "Format", hardware_brightness: "Helligkeit", hardware_contrast: "Kontrast", hardware_saturation: "Sättigung", hardware_hue: "Farbton" },
    },
    en: {
      title: "Grabber test",
      none: "No grabber test stored yet.",
      measured: "Measured on {date}",
      frame: "Frame {w}×{h}",
      stale: "Grabber settings changed since this test ({keys}). Repeat the test to get valid values again.",
      gray: "Gray",
      red: "Red", green: "Green", blue: "Blue", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow",
      orange: "Orange", skin: "Skin tone", black: "Black", custom: "Own color",
      grayChart: "Gray levels",
      grayChartHint: "Horizontal the level sent, vertical what the grabber delivers. The dotted line is ideal. Both axes are compressed so the dark levels stay readable.",
      ladders: "Color ladders",
      laddersHint: "Each color at several brightness levels. Solid: the color's channel, dashed: the channels that should stay dark.",
      colLadder: "Color", colVisible: "visible from", colPure: "hue correct from", colPurity: "foreign share at 255",
      never: "never",
      allValues: "All measured values",
      colColor: "Color", colSent: "sent", colGot: "grabber", colDiff: "deviation", colNoise: "noise",
      customTitle: "Own colors",
      customMeasured: "Measured on {date}",
      f_blackGood: "Black arrives as {v}. Ideal is 0, that's fine.",
      f_blackLift: "Black is lifted: it arrives as {v} instead of 0. Dark scenes look brighter and flatter on the LEDs.",
      f_blackHigh: "Black is lifted a lot: it arrives as {v} instead of 0. Check the HDMI color range of the source device and the hardware brightness of the grabber.",
      f_limited: "Black arrives as about {b} and white as about {w}. The source device most likely sends limited range (16–235) and the grabber does not expand it to 0–255. Set the source device to full range (0–255).",
      f_whiteGood: "White arrives as {v}. That's fine.",
      f_whiteLow: "White only reaches {v} instead of 255. Bright colors arrive a bit darker.",
      f_darkGood: "Even the darkest gray levels can be told apart.",
      f_darkSmall: "Gray 2 cannot be told apart from black. That's normal, from gray 4 on every level is distinct.",
      f_darkLost: "Dark levels get lost: gray 0 to {v} arrive the same.",
      f_darkClipped: "Gray 0 to {v} arrive the same, black is clipped. The color ranges probably don't match: the source sends full range and the grabber expects limited range (or the other way round).",
      f_lightLost: "Bright levels get lost: gray {v} to 255 arrive the same.",
      f_tintGood: "Gray stays neutral (at most {v} levels between the channels).",
      f_tintWarn: "Gray gets a slight tint: up to {v} levels at gray {s}, {c} is strongest.",
      f_tintBad: "Gray has a clear tint: up to {v} levels at gray {s}, {c} is strongest.",
      f_noiseGood: "Noise: ±{v} levels. The picture is calm.",
      f_noiseWarn: "Noise: ±{v} levels. A bit restless, the LEDs average it out though.",
      f_noiseBad: "Noise: ±{v} levels. The picture is very restless.",
      f_drift: "Black changed by {v} levels during the test. The grabber was not stable yet, repeat the test.",
      f_darkInvisible: "Very dark colors get lost: {list}.",
      f_darkHue: "Dark colors lose their hue: {list}.",
      f_darkHueGood: "Dark colors keep their hue too.",
      f_crosstalk: "Colors are not pure: {list}. This points to a different color matrix (BT.601/BT.709) or a saturation setting.",
      f_unstable: "{n} steps were not measured quite steadily. Repeat the test if values look odd.",
      pureFromItem: "{c} only from {v}",
      visibleFromItem: "{c} only visible from {v}",
      neverItem: "{c} not at all",
      crosstalkItem: "{c} {v} %",
      keys: { device: "device", input: "input", width: "width", height: "height", fps: "frame rate", encoding: "format", hardware_brightness: "brightness", hardware_contrast: "contrast", hardware_saturation: "saturation", hardware_hue: "hue" },
    },
  };

  function basicSteps() {
    const steps = [{ group: "black", sent: [0, 0, 0] }];
    for (const v of GRAYS) steps.push({ group: "gray", sent: [v, v, v] });
    for (const [name, mask, levels] of LADDERS) {
      for (const v of levels) steps.push({ group: name, sent: mask.map((m) => m * v) });
    }
    for (const [name, rgb] of MIXES) steps.push({ group: "mix", name, sent: rgb.slice() });
    steps.push({ group: "black", sent: [0, 0, 0] });
    return steps;
  }

  const avg = (v) => (v[0] + v[1] + v[2]) / 3;
  const isRgb = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  const validSteps = (result) => (result && Array.isArray(result.steps) ? result.steps.filter((s) => isRgb(s.sent) && isRgb(s.got)) : []);

  function analyze(result) {
    const steps = validSteps(result);
    const blacks = steps.filter((s) => s.group === "black");
    const grays = steps.filter((s) => s.group === "gray").sort((a, b) => a.sent[0] - b.sent[0]);
    if (!blacks.length || !grays.length) return null;

    const black = [0, 1, 2].map((i) => blacks.reduce((sum, s) => sum + s.got[i], 0) / blacks.length);
    const drift = blacks.length > 1 ? Math.max(...[0, 1, 2].map((i) => Math.abs(blacks[blacks.length - 1].got[i] - blacks[0].got[i]))) : 0;
    const whiteStep = grays.find((s) => s.sent[0] === 255) ?? grays[grays.length - 1];
    const white = whiteStep.got;
    const blackLuma = avg(black);
    const whiteLuma = avg(white);
    const gain = (whiteLuma - blackLuma) / 255;

    // the darkest levels that arrive like black, counted from 0 up to the first distinct one
    let darkLostTo = 0;
    for (const s of grays) {
      if (avg(s.got) - blackLuma < 0.5) darkLostTo = s.sent[0];
      else break;
    }
    // the brightest levels below 255 that arrive like white
    let lightLostFrom = null;
    for (const s of grays.slice().reverse()) {
      if (s.sent[0] === 255) continue;
      if (whiteLuma - avg(s.got) < 0.5) lightLostFrom = s.sent[0];
      else break;
    }

    // tint of grays: spread between the channels, measured from 16 up (below that it is noise)
    let tint = { value: 0, sent: null, channel: null };
    for (const s of grays) {
      if (s.sent[0] < 16) continue;
      const spread = Math.max(...s.got) - Math.min(...s.got);
      if (spread > tint.value) {
        const mean = avg(s.got);
        const devs = s.got.map((v) => Math.abs(v - mean));
        tint = { value: spread, sent: s.sent[0], channel: devs.indexOf(Math.max(...devs)) };
      }
    }

    const mid = grays.find((s) => s.sent[0] === 128);
    const noise = mid && isRgb(mid.noise) ? avg(mid.noise) : null;

    const ladders = LADDERS.map(([name, mask]) => {
      const rows = steps.filter((s) => s.group === name).sort((a, b) => Math.max(...a.sent) - Math.max(...b.sent));
      const main = [0, 1, 2].filter((i) => mask[i]);
      const foreign = [0, 1, 2].filter((i) => !mask[i]);
      const graded = rows.map((s) => {
        const rise = s.got.map((v, i) => v - black[i]);
        const mainRise = Math.min(...main.map((i) => rise[i]));
        const foreignRise = Math.max(0, ...foreign.map((i) => rise[i]));
        const visible = mainRise >= 1;
        const pure = visible && foreignRise <= Math.max(1, 0.25 * mainRise);
        return { level: Math.max(...s.sent), got: s.got, mainRise, foreignRise, visible, pure };
      });
      const visibleFrom = graded.find((g) => g.visible)?.level ?? null;
      // lowest level from which on every brighter level keeps its hue
      let pureFrom = null;
      for (const g of graded.slice().reverse()) {
        if (g.pure) pureFrom = g.level;
        else break;
      }
      const top = graded.find((g) => g.level === 255);
      const crosstalk = top && top.mainRise > 0 ? (100 * top.foreignRise) / top.mainRise : null;
      return { name, mask, rows: graded, visibleFrom, pureFrom, crosstalk };
    });

    const unstable = steps.filter((s) => s.unstable).length;

    const findings = [];
    const add = (level, key, params) => findings.push({ level, key, params: params ?? {} });
    const limited = blackLuma >= 10 && whiteLuma <= 242;
    if (limited) add("bad", "f_limited", { b: Math.round(blackLuma), w: Math.round(whiteLuma) });
    else if (blackLuma <= 1.5) add("ok", "f_blackGood", { v: black });
    else if (blackLuma <= 8) add("warn", "f_blackLift", { v: black });
    else add("bad", "f_blackHigh", { v: black });
    if (!limited) add(whiteLuma >= 250 ? "ok" : "warn", whiteLuma >= 250 ? "f_whiteGood" : "f_whiteLow", { v: white });
    if (darkLostTo === 0) add("ok", "f_darkGood");
    else if (darkLostTo <= 2) add("ok", "f_darkSmall");
    else if (darkLostTo < 12) add("warn", "f_darkLost", { v: darkLostTo });
    else add("bad", "f_darkClipped", { v: darkLostTo });
    if (lightLostFrom !== null && lightLostFrom <= 245) add(lightLostFrom <= 235 ? "bad" : "warn", "f_lightLost", { v: lightLostFrom });
    if (tint.value < 2) add("ok", "f_tintGood", { v: tint.value });
    else add(tint.value < 5 ? "warn" : "bad", tint.value < 5 ? "f_tintWarn" : "f_tintBad", { v: tint.value, s: tint.sent, c: tint.channel });
    if (noise !== null) add(noise < 1.5 ? "ok" : noise < 3 ? "warn" : "bad", noise < 1.5 ? "f_noiseGood" : noise < 3 ? "f_noiseWarn" : "f_noiseBad", { v: noise });
    if (drift > 1) add("warn", "f_drift", { v: drift });
    // dark colors: lost completely (not visible at their lower levels) or visible with a wrong hue
    const lost = ladders.filter((l) => l.rows.length && (l.visibleFrom === null || l.visibleFrom > l.rows[0].level * 2));
    if (lost.length) add("warn", "f_darkInvisible", { ladders: lost });
    const lateHue = ladders.filter((l) => l.rows.length && !lost.includes(l) && (l.pureFrom === null || l.pureFrom > Math.max(l.rows[0].level * 2, l.visibleFrom)));
    if (lateHue.length) add("warn", "f_darkHue", { ladders: lateHue });
    if (!lost.length && !lateHue.length && ladders.some((l) => l.rows.length)) add("ok", "f_darkHueGood");
    const impure = ladders.filter((l) => l.crosstalk !== null && l.crosstalk > 10);
    if (impure.length) add("warn", "f_crosstalk", { ladders: impure });
    if (unstable) add("warn", "f_unstable", { n: unstable });

    return { black, white, gain, drift, darkLostTo, lightLostFrom, tint, noise, ladders, findings, limited };
  }

  // grabber settings that differ between the test and now
  function changedKeys(result, current) {
    if (!result?.grabber || !current) return [];
    return GRABBER_KEYS.filter((k) => k in result.grabber && k in current && String(result.grabber[k]) !== String(current[k]));
  }

  // --- rendering ---

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

  const CSS = `
    .gtr { font-size: 14px; line-height: 1.45; }
    .gtr-meta { opacity: .75; font-size: 13px; margin: 0 0 8px; }
    .gtr-stale { border-left: 4px solid #e0a000; background: rgba(224, 160, 0, .12); padding: 8px 10px; border-radius: 4px; margin: 0 0 10px; }
    .gtr-findings { list-style: none; padding: 0; margin: 0 0 12px; }
    .gtr-findings li { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border: none; font-size: 14px; justify-content: flex-start; flex-wrap: nowrap; }
    .gtr-findings .ico { flex: none; width: 20px; height: 20px; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
    .gtr-findings .gtr-ok .ico { background: #2fa36b; }
    .gtr-findings .gtr-warn .ico { background: #d08a00; }
    .gtr-findings .gtr-bad .ico { background: #d93025; }
    .gtr h4 { font-size: 14px; font-weight: 600; margin: 16px 0 4px; text-transform: none; letter-spacing: 0; opacity: 1; color: inherit; }
    .gtr-hint { font-size: 12px; opacity: .7; margin: 0 0 6px; }
    .gtr svg { display: block; width: 100%; height: auto; overflow: visible; }
    .gtr svg text { font: 10px system-ui, sans-serif; fill: currentColor; opacity: .7; }
    .gtr-chart { max-width: 520px; }
    .gtr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 14px; }
    .gtr-grid .cap { font-size: 12px; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
    .gtr-sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(128, 128, 128, .5); vertical-align: -2px; flex: none; }
    .gtr-table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; margin: 6px 0; }
    .gtr-table th, .gtr-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid rgba(128, 128, 128, .25); white-space: nowrap; }
    .gtr-table th { font-weight: 600; opacity: .8; }
    .gtr-scroll { overflow-x: auto; }
    .gtr details summary { cursor: pointer; margin: 14px 0 4px; font-weight: 600; }
  `;

  function ensureStyle(doc) {
    if (doc.getElementById("gtr-style")) return;
    const style = doc.createElement("style");
    style.id = "gtr-style";
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  // square root scale: the dark levels get room, like the eye sees them
  const sq = (v) => Math.sqrt(Math.max(0, Math.min(255, v)) / 255);

  // rows: [{ level, got }], channels: indices drawn solid, dashed: indices drawn dashed
  function chartSvg(rows, solid, dashed, { width = 320, height = 200, small = false } = {}) {
    const pad = small ? { l: 22, r: 6, t: 6, b: 16 } : { l: 30, r: 8, t: 8, b: 22 };
    const w = width - pad.l - pad.r;
    const h = height - pad.t - pad.b;
    const x = (v) => pad.l + sq(v) * w;
    const y = (v) => pad.t + (1 - sq(v)) * h;
    const ticks = small ? [0, 16, 64, 255] : [0, 4, 16, 32, 64, 128, 255];
    let out = `<svg viewBox="0 0 ${width} ${height}" role="img">`;
    for (const t of ticks) {
      out += `<line x1="${x(t)}" y1="${pad.t}" x2="${x(t)}" y2="${pad.t + h}" stroke="currentColor" stroke-opacity=".12"/>`;
      out += `<line x1="${pad.l}" y1="${y(t)}" x2="${pad.l + w}" y2="${y(t)}" stroke="currentColor" stroke-opacity=".12"/>`;
      out += `<text x="${x(t)}" y="${height - 4}" text-anchor="middle">${t}</text>`;
      out += `<text x="${pad.l - 4}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
    }
    out += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(255)}" y2="${y(255)}" stroke="currentColor" stroke-opacity=".45" stroke-dasharray="1 3"/>`;
    const line = (i, dash) => {
      const pts = rows.map((r) => `${x(r.level).toFixed(1)},${y(r.got[i]).toFixed(1)}`).join(" ");
      const dots = rows.map((r) => `<circle cx="${x(r.level).toFixed(1)}" cy="${y(r.got[i]).toFixed(1)}" r="${small ? 1.6 : 2.2}" fill="${CHANNEL_COLORS[i]}"/>`).join("");
      return `<polyline points="${pts}" fill="none" stroke="${CHANNEL_COLORS[i]}" stroke-width="${small ? 1.4 : 1.8}"${dash ? ' stroke-dasharray="4 3"' : ""}/>${dots}`;
    };
    for (const i of dashed) out += line(i, true);
    for (const i of solid) out += line(i, false);
    return out + "</svg>";
  }

  function make(lang) {
    const t = TEXT[lang] ?? TEXT.de;
    const locale = lang === "de" ? "de-DE" : "en-US";
    const num = (v, d = 1) => Number(v).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
    const rgbText = (v, d = 1) => v.map((c) => num(c, d)).join(" / ");
    const fill = (s, params) => s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? params[k] : `{${k}}`));
    const channelName = (i) => [t.red, t.green, t.blue][i];
    const dateText = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
    };
    const stepName = (s) => (s.group === "mix" || s.group === "custom" ? t[s.name] ?? s.name ?? t.custom : t[s.group] ?? s.group);

    function findingText(f) {
      const p = f.params;
      switch (f.key) {
        case "f_blackGood": case "f_blackLift": case "f_blackHigh": case "f_whiteGood": case "f_whiteLow":
          return fill(t[f.key], { v: rgbText(p.v) });
        case "f_tintGood":
          return fill(t[f.key], { v: num(p.v) });
        case "f_tintWarn": case "f_tintBad":
          return fill(t[f.key], { v: num(p.v), s: p.s, c: channelName(p.c) });
        case "f_noiseGood": case "f_noiseWarn": case "f_noiseBad": case "f_drift":
          return fill(t[f.key], { v: num(p.v) });
        case "f_darkHue":
          return fill(t[f.key], { list: p.ladders.map((l) => (l.pureFrom === null ? fill(t.neverItem, { c: t[l.name] }) : fill(t.pureFromItem, { c: t[l.name], v: l.pureFrom }))).join(", ") });
        case "f_darkInvisible":
          return fill(t[f.key], { list: p.ladders.map((l) => (l.visibleFrom === null ? fill(t.neverItem, { c: t[l.name] }) : fill(t.visibleFromItem, { c: t[l.name], v: l.visibleFrom }))).join(", ") });
        case "f_crosstalk":
          return fill(t[f.key], { list: p.ladders.map((l) => fill(t.crosstalkItem, { c: t[l.name], v: num(l.crosstalk, 0) })).join(", ") });
        default:
          return fill(t[f.key], p);
      }
    }

    function metaLine(result) {
      const g = result.grabber ?? {};
      const parts = [fill(t.measured, { date: dateText(result.date) })];
      if (g.name) parts.push(esc(g.name));
      const frame = result.frame ?? g;
      if (frame.width && frame.height) parts.push(fill(t.frame, { w: frame.width, h: frame.height }));
      if (g.encoding) parts.push(esc(g.encoding) + (g.fps ? ` ${g.fps} fps` : ""));
      return parts.join(" · ");
    }

    function valuesTable(steps) {
      let out = `<div class="gtr-scroll"><table class="gtr-table"><thead><tr><th>${t.colColor}</th><th>${t.colSent}</th><th>${t.colGot}</th><th>${t.colDiff}</th><th>${t.colNoise}</th></tr></thead><tbody>`;
      for (const s of steps) {
        const diff = s.got.map((v, i) => v - s.sent[i]);
        const diffText = diff.map((d) => (d > 0 ? "+" : "") + num(d)).join(" / ");
        out += `<tr><td><span class="gtr-sw" style="background:${hex(s.sent)}"></span> <span class="gtr-sw" style="background:${hex(s.got)}"></span> ${esc(stepName(s))}</td>`
          + `<td>${s.sent.join(" / ")}</td><td>${rgbText(s.got)}</td><td>${diffText}</td><td>${isRgb(s.noise) ? "±" + num(avg(s.noise)) : "–"}</td></tr>`;
      }
      return out + "</tbody></table></div>";
    }

    function basicHtml(basic, current) {
      const a = analyze(basic);
      if (!a) return `<p>${t.none}</p>`;
      let out = `<p class="gtr-meta">${metaLine(basic)}</p>`;
      const changed = changedKeys(basic, current);
      if (changed.length) out += `<p class="gtr-stale">${fill(t.stale, { keys: changed.map((k) => t.keys[k] ?? k).join(", ") })}</p>`;
      out += `<ul class="gtr-findings">${a.findings.map((f) => `<li class="gtr-${f.level}"><span class="ico">${f.level === "ok" ? "✓" : f.level === "warn" ? "!" : "✕"}</span><span>${findingText(f)}</span></li>`).join("")}</ul>`;

      const steps = validSteps(basic);
      const grays = [{ level: 0, got: a.black }, ...steps.filter((s) => s.group === "gray").map((s) => ({ level: s.sent[0], got: s.got }))].sort((p, q) => p.level - q.level);
      out += `<h4>${t.grayChart}</h4><p class="gtr-hint">${t.grayChartHint}</p><div class="gtr-chart">${chartSvg(grays, [0, 1, 2], [])}</div>`;

      const ladders = a.ladders.filter((l) => l.rows.length);
      if (ladders.length) {
        out += `<h4>${t.ladders}</h4><p class="gtr-hint">${t.laddersHint}</p><div class="gtr-grid">`;
        for (const l of ladders) {
          const rows = [{ level: 0, got: a.black }, ...l.rows];
          const solid = [0, 1, 2].filter((i) => l.mask[i]);
          const dashed = [0, 1, 2].filter((i) => !l.mask[i]);
          out += `<div><div class="cap"><span class="gtr-sw" style="background:${hex(l.mask.map((m) => m * 255))}"></span>${t[l.name]}</div>${chartSvg(rows, solid, dashed, { width: 170, height: 120, small: true })}</div>`;
        }
        out += `</div><div class="gtr-scroll"><table class="gtr-table"><thead><tr><th>${t.colLadder}</th><th>${t.colVisible}</th><th>${t.colPure}</th><th>${t.colPurity}</th></tr></thead><tbody>`;
        for (const l of ladders) {
          out += `<tr><td><span class="gtr-sw" style="background:${hex(l.mask.map((m) => m * 255))}"></span> ${t[l.name]}</td><td>${l.visibleFrom ?? t.never}</td><td>${l.pureFrom ?? t.never}</td><td>${l.crosstalk === null ? "–" : num(l.crosstalk, 0) + " %"}</td></tr>`;
        }
        out += "</tbody></table></div>";
      }
      out += `<details><summary>${t.allValues}</summary>${valuesTable(steps)}</details>`;
      return out;
    }

    function customHtml(custom) {
      const steps = validSteps(custom);
      if (!steps.length) return "";
      return `<h4>${t.customTitle}</h4><p class="gtr-meta">${fill(t.customMeasured, { date: dateText(custom.date) })}</p>${valuesTable(steps)}`;
    }

    return { t, basicHtml, customHtml, valuesTable, findingText };
  }

  function render(element, { basic, custom, current, lang = "de" } = {}) {
    ensureStyle(element.ownerDocument);
    const r = make(lang);
    element.innerHTML = `<div class="gtr">${basic && validSteps(basic).length ? r.basicHtml(basic, current) : `<p>${r.t.none}</p>`}${custom ? r.customHtml(custom) : ""}</div>`;
  }

  global.GrabberTestReport = { basicSteps, analyze, changedKeys, render, make, GRABBER_KEYS, TEXT };
})(typeof window !== "undefined" ? window : globalThis);
