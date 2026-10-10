// Shared debug drawing for the TV page and the phone's grabber preview.
// Coordinates are percent of the grabber image (SVG viewBox 0..100, stretched to the picture).

const LINE = "#00e5ff";   // scan lines of the black-border detector
const BORDER = "#ff2bd6"; // the border Hyperion currently applies
const AREA = "#ffb020";   // LED sampling areas, all the gray still detector sees

export const BB_MODE_NAMES = {
  default: "Standard",
  classic: "Klassisch",
  osd: "OSD",
  letterbox: "Letterbox",
};

// Scan lines exactly as BlackBorderDetector.h walks them, as [x1, y1, x2, y2] in percent
export function scanLines(mode, verticalPct = 0) {
  const t = 100 / 3;
  switch (mode) {
    case "classic":
      // one diagonal from the top left corner into the top left third
      return [[0, 0, t, t]];
    case "osd": {
      // x is found like "default", y is then searched at that x on both sides (top and bottom)
      // kept a hair inside the picture, so the lines stay visible when no side border is found
      const x = Math.min(t, Math.max(0.3, verticalPct));
      return [
        [0, t, t, t], [0, 2 * t, t, 2 * t], [100, 50, 100 - t, 50],
        [x, 0, x, t], [x, 100, x, 100 - t], [100 - x, 0, 100 - x, t], [100 - x, 100, 100 - x, 100 - t],
      ];
    }
    case "letterbox":
      // top and bottom only: 1/4 and 3/4 both ways, the center from the top only (subtitles)
      return [[25, 0, 25, t], [75, 0, 75, t], [25, 100, 25, 100 - t], [75, 100, 75, 100 - t], [50, 0, 50, t]];
    default:
      // rows at 1/3 and 2/3 from the left, middle row from the right;
      // columns at 1/3 and 2/3 from the top, middle column from the bottom
      return [
        [0, t, t, t], [0, 2 * t, t, 2 * t], [100, 50, 100 - t, 50],
        [t, 0, t, t], [2 * t, 0, 2 * t, t], [50, 100, 50, 100 - t],
      ];
  }
}

function borderPct(bb, border) {
  if (!bb || !border || border.unknown || !bb.imageWidth || !bb.imageHeight) return null;
  return {
    h: (Math.max(0, border.horizontalSize) / bb.imageHeight) * 100,
    v: (Math.max(0, border.verticalSize) / bb.imageWidth) * 100,
  };
}

const fmt = (v, digits = 1) => Number(v).toLocaleString("de-DE", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// SVG with the scan lines and the applied border, to lay over a picture of any aspect ratio
export function blackborderSvg(bb, modeFallback) {
  const mode = bb?.mode ?? modeFallback ?? "default";
  const applied = borderPct(bb, bb?.currentBorder);
  const lines = scanLines(mode, applied?.v ?? 0)
    .map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${LINE}" stroke-width="4" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`)
    .join("");
  const rect = applied
    ? `<rect x="${applied.v}" y="${applied.h}" width="${100 - 2 * applied.v}" height="${100 - 2 * applied.h}" fill="none" stroke="${BORDER}" stroke-width="3" stroke-dasharray="10 6" vector-effect="non-scaling-stroke"/>`
    : "";
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${lines}${rect}</svg>`;
}

// Layout areas [hmin, hmax, vmin, vmax] clamped to 0..1 and swapped into order, as LedString.cpp does it
function normalizeArea(led) {
  const frac = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  let [x1, x2, y1, y2] = led.map(frac);
  if (x1 > x2) [x1, x2] = [x2, x1];
  if (y1 > y2) [y1, y2] = [y2, y1];
  return [x1, x2, y1, y2];
}

const EDGE = 1e-4;

// Which edge an area belongs to, as in hyperion::applyLedAreaDepth (ImageToLedsMap.cpp): an area on
// the top xor bottom edge counts as top/bottom, one on the left xor right edge as a side; a corner
// area belongs to the edge along which it is narrower. null = no edge (inside, or spanning across).
export function areaEdge(area) {
  const [x1, x2, y1, y2] = area;
  const width = x2 - x1;
  const height = y2 - y1;
  if (width < 1e-6 || height < 1e-6) return null;
  const top = y1 <= EDGE, bottom = y2 >= 1 - EDGE, left = x1 <= EDGE, right = x2 >= 1 - EDGE;
  const onTopOrBottom = top !== bottom;
  const onSide = left !== right;
  if (onTopOrBottom && (!onSide || height >= width)) return top ? "top" : "bottom";
  if (onSide) return left ? "left" : "right";
  return null;
}

// The fork setting color.ledAreaDepth: areas on the top/bottom edge reach topBottom percent of the
// picture height into it, side areas leftRight percent of the width; 0 keeps the layout.
// Returns normalized areas [x1, x2, y1, y2].
export function applyLedAreaDepth(leds, topBottom = 0, leftRight = 0) {
  const dy = Math.min(50, Math.max(0, Number(topBottom) || 0)) / 100;
  const dx = Math.min(50, Math.max(0, Number(leftRight) || 0)) / 100;
  return (leds ?? []).map((led) => {
    const a = normalizeArea(led);
    const edge = areaEdge(a);
    if (edge === "top" && dy > 0) return [a[0], a[1], 0, dy];
    if (edge === "bottom" && dy > 0) return [a[0], a[1], 1 - dy, 1];
    if (edge === "left" && dx > 0) return [0, dx, a[2], a[3]];
    if (edge === "right" && dx > 0) return [1 - dx, 1, a[2], a[3]];
    return a;
  });
}

// Depth the layout itself gives each edge (median over the areas of that edge), in percent
export function layoutDepths(leds) {
  const depths = { top: [], bottom: [], left: [], right: [] };
  for (const led of leds ?? []) {
    const a = normalizeArea(led);
    const edge = areaEdge(a);
    if (edge) depths[edge].push(edge === "top" || edge === "bottom" ? a[3] - a[2] : a[1] - a[0]);
  }
  const median = (v) => (v.length ? [...v].sort((p, q) => p - q)[Math.floor(v.length / 2)] * 100 : null);
  return Object.fromEntries(Object.entries(depths).map(([k, v]) => [k, median(v)]));
}

// Pixels per LED as ImageToLedsMap.cpp counts them in an image of w × h with the given border
// (rounded indices, at least one pixel). skip = areas above 1600 pixels, where Hyperion only reads
// every second pixel of every second row (with "reduced pixel processing" off).
export function areaPixelStats(areas, w, h, border) {
  const bh = border && !border.unknown ? Math.max(0, border.horizontalSize) : 0;
  const bv = border && !border.unknown ? Math.max(0, border.verticalSize) : 0;
  const aw = w - 2 * bv;
  const ah = h - 2 * bh;
  const groups = { top: [], bottom: [], left: [], right: [], other: [] };
  for (const a of areas ?? []) {
    const [x1, x2, y1, y2] = a;
    if (x2 - x1 < 1e-6 || y2 - y1 < 1e-6) continue;
    let minX = Math.round(aw * x1), maxX = Math.round(aw * x2);
    let minY = Math.round(ah * y1), maxY = Math.round(ah * y2);
    minX = Math.min(minX, aw - 1); if (minX === maxX) maxX++;
    minY = Math.min(minY, ah - 1); if (minY === maxY) maxY++;
    const px = Math.abs(Math.min(maxX, aw) - minX) * Math.abs(Math.min(maxY, ah) - minY);
    groups[areaEdge(a) ?? "other"].push(px);
  }
  const out = {};
  for (const [k, v] of Object.entries(groups)) {
    if (!v.length) continue;
    out[k] = { count: v.length, mean: v.reduce((s, x) => s + x, 0) / v.length, max: Math.max(...v), skip: v.filter((x) => x > 1600).length };
  }
  return out;
}

// The picture areas the LEDs sample, placed like ImageToLedsMap.cpp does it: the layout fractions
// (clamped and swapped as in LedString.cpp) lie inside the picture minus the applied black border.
// The gray still detector works on the LED colors, so these areas are all it evaluates.
// One path with a subpath per LED, so overlapping areas fill evenly.
// depth = { topBottom, leftRight } of color.ledAreaDepth (missing or 0 = the layout)
export function ledAreasSvg(leds, bb, depth, color = AREA) {
  if (!leds?.length) return "";
  const b = borderPct(bb, bb?.currentBorder) ?? { h: 0, v: 0 };
  const w = 100 - 2 * b.v;
  const h = 100 - 2 * b.h;
  const n = (v) => +v.toFixed(2);
  const d = applyLedAreaDepth(leds, depth?.topBottom, depth?.leftRight).map(([x1, x2, y1, y2]) => {
    if (x2 - x1 < 1e-6 || y2 - y1 < 1e-6) return ""; // LEDs without area are skipped by Hyperion too
    return `M${n(b.v + w * x1)} ${n(b.h + h * y1)}h${n(w * (x2 - x1))}v${n(h * (y2 - y1))}h${n(-w * (x2 - x1))}z`;
  }).join("");
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="${color}" fill-opacity=".4"/></svg>`;
}

// Capture depth view: the LED areas (with the depth setting applied) plus a dashed line along the
// inner edge of the depth on every side, so the depth itself is readable over the picture
export const DEPTH_COLOR = "#7dff3a";
export function depthAreaSvg(leds, bb, depth) {
  const areas = ledAreasSvg(leds, bb, depth, DEPTH_COLOR);
  if (!areas) return "";
  const b = borderPct(bb, bb?.currentBorder) ?? { h: 0, v: 0 };
  const w = 100 - 2 * b.v;
  const h = 100 - 2 * b.h;
  const lay = layoutDepths(leds);
  const tb = Number(depth?.topBottom) || 0;
  const lr = Number(depth?.leftRight) || 0;
  const dTop = tb > 0 ? tb : lay.top ?? 0;
  const dBottom = tb > 0 ? tb : lay.bottom ?? 0;
  const dLeft = lr > 0 ? lr : lay.left ?? 0;
  const dRight = lr > 0 ? lr : lay.right ?? 0;
  const n = (v) => +v.toFixed(2);
  const yT = b.h + (h * dTop) / 100, yB = 100 - b.h - (h * dBottom) / 100;
  const xL = b.v + (w * dLeft) / 100, xR = 100 - b.v - (w * dRight) / 100;
  const line = (x1, y1, x2, y2) => `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${DEPTH_COLOR}" stroke-width="2" stroke-dasharray="8 5" vector-effect="non-scaling-stroke"/>`;
  const lines = line(b.v, yT, 100 - b.v, yT) + line(b.v, yB, 100 - b.v, yB) + line(xL, b.h, xL, 100 - b.h) + line(xR, b.h, xR, 100 - b.h);
  return areas.replace("</svg>", lines + "</svg>");
}

// What the gray still detector evaluates: with an edge width set (fork setting
// edgeWidthPercent) a frame of that depth along the picture edges, inside the applied black
// border; otherwise the LED areas (with the capture depth setting applied).
export function grayStillAreaSvg(gs, leds, bb, depth) {
  const pct = Number(gs?.edgeWidthPercent) || 0;
  if (pct <= 0) return ledAreasSvg(leds, bb, depth);
  const b = borderPct(bb, bb?.currentBorder) ?? { h: 0, v: 0 };
  const w = 100 - 2 * b.v;
  const h = 100 - 2 * b.h;
  const dx = (w * pct) / 100;
  const dy = (h * pct) / 100;
  const n = (v) => +v.toFixed(2);
  // outer rectangle minus inner rectangle (even-odd), the same frame ImageProcessor samples
  const d = `M${n(b.v)} ${n(b.h)}h${n(w)}v${n(h)}h${n(-w)}z` +
    `M${n(b.v + dx)} ${n(b.h + dy)}h${n(w - 2 * dx)}v${n(h - 2 * dy)}h${n(-(w - 2 * dx))}z`;
  return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="${AREA}" fill-opacity=".4" fill-rule="evenodd"/></svg>`;
}

// One-line status of the border detection
export function blackborderText(bb) {
  if (!bb) return "Keine Daten von Hyperion";
  if (!bb.enabled) return "Schwarzbalken-Erkennung ist aus";
  const cur = bb.currentBorder ?? {};
  const name = BB_MODE_NAMES[bb.mode] ?? bb.mode;
  if (cur.unknown) return `${name}: kein Balken übernommen`;
  const h = bb.imageHeight ? fmt((cur.horizontalSize / bb.imageHeight) * 100) : "?";
  const v = bb.imageWidth ? fmt((cur.verticalSize / bb.imageWidth) * 100) : "?";
  return `${name}: oben/unten ${cur.horizontalSize} px (${h} %), links/rechts ${cur.verticalSize} px (${v} %)`;
}

// HTML status box of the gray still image detector (stages as in GrayStillImageDetector.cpp)
export function grayStillHtml(gs) {
  if (!gs) return `<div class="gs-title">Graues Standbild</div><div>Keine Daten von Hyperion</div>`;
  if (!gs.enabled) return `<div class="gs-title">Graues Standbild</div><div>Erkennung ist in Hyperion aus</div>`;
  const stillMs = gs.stillTimeSeconds * 1000;
  const progress = gs.triggered ? 100 : Math.min(100, (gs.stillElapsedMs / stillMs) * 100);
  const dropOn = gs.brightnessDropThreshold > 0;
  const dropNow = gs.dropWindowActive ? Math.max(0, gs.dropWindowStartBrightness - gs.brightness) : 0;
  const reaction = gs.mode === "off" ? "LEDs aus" : "Farben einfrieren";
  const step = (ok, text) => `<div class="gs-step ${ok ? "ok" : ""}">${ok ? "✔" : "○"} ${text}</div>`;
  return `
    <div class="gs-title">Graues Standbild${gs.triggered ? ` <span class="gs-hit">greift: ${reaction}</span>` : ""}</div>
    <div class="gs-bar"><span style="width:${progress}%"></span></div>
    ${step(gs.stillActive && progress >= 100, `Standbild ${fmt(gs.stillActive ? gs.stillElapsedMs / 1000 : 0)} / ${gs.stillTimeSeconds} s`)}
    ${dropOn
      ? step(gs.dropDetected, `Helligkeitsabfall ≥ ${gs.brightnessDropThreshold} in ${fmt(gs.dropWindowSeconds)} s (jetzt ${fmt(dropNow, 0)})`)
      : step(true, "Helligkeitsabfall nicht gefordert")}
    <div class="gs-meta">Helligkeit ${fmt(gs.brightness, 0)} · Änderung ${fmt(gs.changeDelta)} (Grenze ${gs.changeThreshold})</div>`;
}

// One-line status of the gray still image detector
export function grayStillText(gs) {
  if (!gs) return "Keine Daten von Hyperion";
  if (!gs.enabled) return "Graues-Standbild-Erkennung ist aus";
  if (gs.triggered) return `Greift: ${gs.mode === "off" ? "LEDs aus" : "Farben eingefroren"}`;
  const secs = fmt(gs.stillActive ? gs.stillElapsedMs / 1000 : 0);
  const drop = gs.brightnessDropThreshold > 0 ? ` · Abfall ${gs.dropDetected ? "erkannt" : "noch nicht erkannt"}` : "";
  return `Standbild ${secs} von ${gs.stillTimeSeconds} s${drop}`;
}

// Styles for the status box, shared so TV and phone look the same (sizes come from the host page)
export const GRAY_STILL_CSS = `
  .gs-title { font-weight: 700; margin-bottom: .4em; }
  .gs-hit { color: #ffb020; }
  .gs-bar { height: .5em; border-radius: .25em; background: rgba(255,255,255,.2); overflow: hidden; margin-bottom: .5em; }
  .gs-bar span { display: block; height: 100%; background: #00e5ff; }
  .gs-step { opacity: .75; }
  .gs-step.ok { opacity: 1; color: #7dff9b; }
  .gs-meta { margin-top: .4em; opacity: .75; font-variant-numeric: tabular-nums; }
`;

// Compact one-line variant for small previews: progress bar plus the stage flags
export function grayStillCompactHtml(gs) {
  if (!gs) return `<div class="gsc-line">Graues Standbild: keine Daten</div>`;
  if (!gs.enabled) return `<div class="gsc-line">Graues Standbild: Erkennung aus</div>`;
  const progress = gs.triggered ? 100 : Math.min(100, (gs.stillElapsedMs / (gs.stillTimeSeconds * 1000)) * 100);
  const secs = fmt(gs.stillActive ? gs.stillElapsedMs / 1000 : 0);
  const drop = gs.brightnessDropThreshold > 0 ? ` · Abfall ${gs.dropDetected ? "✔" : "○"}` : "";
  const hit = gs.triggered ? ` · <b>greift</b>` : "";
  return `<div class="gs-bar"><span style="width:${progress}%"></span></div>
    <div class="gsc-line">Standbild ${secs}/${gs.stillTimeSeconds} s${drop}${hit}</div>`;
}
