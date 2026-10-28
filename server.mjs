// Hyperion TV test page: small LAN server on the Pi, no dependencies.
// Serves the TV page (any TV browser, laptop or tablet) and the control page, keeps the
// shared state, syncs both via Server-Sent Events and writes DB backups.
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";

import { createMedia } from "./media.mjs";
import { createSources } from "./sources.mjs";
import { layoutRuns, offsetsFromAnswers, composeOffsets, correctedLeds, sameLayout, MAX_ANSWER } from "./public/layoutfix.js";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-generator");

// the port: TVTEST_PORT (test copies), else Hyperion's setting webConfig.testPagePort (fork, changeable
// in the WebUI and on this page), else 8093. See configuredPort below.
const DEFAULT_PORT = 8093;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
// TVTEST_DATA_DIR lets a test copy keep its own state and backups
const DATA_DIR = process.env.TVTEST_DATA_DIR ?? HERE;
// whether Hyperion has a password of its own (then the control page asks for it, see "Login" below);
// up here because the state goes out from early on
let authRequired = true;
let authCheckedAt = 0;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
// overridable so a test copy can run against a mock Hyperion and a copy of the database
const HYPERION_DB = process.env.TVTEST_HYPERION_DB ?? "/home/alexo/.hyperion/db/hyperion.db";
// Hyperion writes in rollback-journal mode: a read during its write would fail at once with
// "database is locked", so a read waits for the write to finish
const HYPERION_DB_READ = { readOnly: true, timeout: 2000 };
const MAX_BAR = 50; // percent of screen per edge
const TOKEN_FILE = path.join(DATA_DIR, "hyperion-token");
const HYPERION_HOST = "127.0.0.1";
const HYPERION_JSON_PORT = Number(process.env.TVTEST_HYPERION_PORT ?? 19444);
const TOKEN_REQUEST_TIMEOUT_MS = 180_000; // Hyperion drops unanswered token requests after 180 s

const validPort = (v) => (Number.isInteger(Number(v)) && Number(v) >= 1024 && Number(v) <= 65535 ? Number(v) : null);
function configuredPort() {
  if (process.env.TVTEST_PORT) return Number(process.env.TVTEST_PORT);
  try {
    const db = new DatabaseSync(HYPERION_DB, HYPERION_DB_READ);
    try {
      const row = db.prepare("SELECT config FROM settings WHERE type = 'webConfig' AND hyperion_inst IS NULL").get();
      return validPort(row && JSON.parse(row.config).testPagePort) ?? DEFAULT_PORT;
    } finally {
      db.close();
    }
  } catch {
    return DEFAULT_PORT;
  }
}
const CONFIGURED_PORT = configuredPort();
let PORT = CONFIGURED_PORT; // the port in use; DEFAULT_PORT when the configured one was taken

const MAX_CUSTOM_COLORS = 24;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Test guard rules: which Hyperion features each kind of test switches off while it runs. Features a
// test is about stay on and cannot be chosen (black bars: black border detection, gray still image:
// gray still detection, capture depth: capture depth).
const GUARD_FEATURES = ["grayStill", "blackborder", "backlight", "signal", "depth"];
const GUARD_TESTS = ["color", "bars", "gray", "depth", "frac", "pos"];
const GUARD_FIXED = { bars: ["blackborder"], gray: ["grayStill"], depth: ["depth"] };
const DEFAULT_GUARD_RULES = {
  color: ["grayStill", "blackborder", "backlight", "signal"],
  bars: ["grayStill", "backlight"],
  gray: ["backlight", "signal"],
  depth: ["grayStill", "blackborder", "backlight", "signal"],
  frac: ["grayStill", "blackborder", "backlight", "signal"],
  pos: ["grayStill", "blackborder", "backlight", "depth", "signal"],
};

const DEFAULT_STATE = {
  color: "#000000",
  // false = no test color is on: the TV shows black, or the idle hint while a control page is connected
  // (the on/off button per test color); true shows `color`, black too
  colorActive: false,
  bars: { top: 0, bottom: 0, left: 0, right: 0 },
  customColors: [],
  // edited preset colors, id -> hex (missing id = standard color from PRESETS)
  presetColors: {},
  // gray still image test pattern: a still gray that optionally dims after a delay, like a paused player
  // dropDuration: seconds the fade takes (0 = instant)
  grayTest: { active: false, tone: 128, dropEnabled: true, dropAfter: 3, dropPercent: 50, dropDuration: 0.4, startedAt: 0 },
  // capture depth test pattern. frame: a band of `outer` along the edges (topBottom % of the height,
  // leftRight % of the width) around `inner`; sweep: a line of `outer` on `inner` that runs from the
  // edges inwards to sweepMax % within sweepSeconds and starts again
  depthTest: { active: false, pattern: "frame", outer: "#ff0000", inner: "#0000ff", topBottom: 5, leftRight: 8, sweepMax: 20, sweepSeconds: 8, lineWidth: 1, startedAt: 0 },
  // fractional LED mean test pattern: a dark tone between two whole levels, drawn as a fine dither of
  // both, so the mean over an LED area has fractions. ramp: from -> to and back, rampSeconds per way;
  // toggle: base and base + delta alternately, toggleSeconds each. tint: which channels light up
  fracTest: { active: false, pattern: "ramp", tint: "gray", from: 20, to: 30, rampSeconds: 20, base: 25, delta: 0.5, toggleSeconds: 2, startedAt: 0 },
  // LED position test pattern: a marker exactly in the sampling area of LED `index` (width LEDs
  // around it) on `background`. run: the marker moves on by speed LEDs per second from index
  posTest: { active: false, mode: "single", index: 0, width: 1, speed: 10, color: "#ffffff", background: "black", startedAt: 0 },
  // LED position calibration: it steps posTest through `points`, answers = offset per LED (null = skipped).
  // round: "measure" on the layout as it is, "control" after a correction. cursor: where the arrow
  // on the TV points now, in LED numbers from the marked LED
  posGuide: { active: false, round: "measure", points: [], step: 0, answers: {}, done: false, cursor: 0 },
  // own colors of the grabber test, measured one after the other
  grabberColors: [],
  // saved settings per test (name, favorite star): { [test]: [{ id, name, fav, settings, savedAt }] }
  testPresets: {},
  // switch Hyperion features off that would falsify the running test, and back on afterwards
  testGuard: true,
  guardRules: DEFAULT_GUARD_RULES,
  // language chosen last on a control page; the TV page follows it
  lang: "de",
  // where the debug views are drawn: on the TV picture (captured by the grabber!) or on the phone preview
  overlays: { bbTv: false, bbPreview: true, gsTv: false, gsPreview: true, dpTv: false, dpPreview: true },
  // gray curve memory slot last used per grabber (device name -> slot id, "default" = standard)
  grayCurveByGrabber: {},
  // the grabber the gray curve belonged to at the last check (a change while the server was off counts too)
  curveGrabber: "",
  // picture or video of the media library on the TV (media.mjs; "builtin:*" = test pictures drawn by
  // testimages.js). A video plays from `position` seconds at `startedAt` (server time) while playing.
  media: { active: false, id: "", fit: "contain", playing: true, loop: true, muted: true, position: 0, startedAt: 0 },
  // the port this server ran on last time: a change is told in the bell with what to check
  lastPort: 0,
  // the hint "ffmpeg is missing" was given at the first video upload / the first video played
  ffmpegHint: { upload: false, play: false },
};

const num = (v, min, max, fallback, step = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // toFixed removes float noise like 2.3000000000000003 from steps of 0.1
  const snapped = Number((Math.round(n / step) * step).toFixed(6));
  return Math.min(max, Math.max(min, snapped));
};

// id = stable key for edits, color = standard value (the reset target)
const PRESETS = [
  { id: "white", color: "#ffffff", name: "Weiß" },
  { id: "red", color: "#ff0000", name: "Rot" },
  { id: "green", color: "#00ff00", name: "Grün" },
  { id: "blue", color: "#0000ff", name: "Blau" },
  { id: "yellow", color: "#ffff00", name: "Gelb" },
  { id: "cyan", color: "#00ffff", name: "Cyan" },
  { id: "magenta", color: "#ff00ff", name: "Magenta" },
  { id: "gray50", color: "#808080", name: "Grau 50 %" },
  { id: "black", color: "#000000", name: "Schwarz" },
];
const PRESET_IDS = PRESETS.map((p) => p.id);

// Tests whose settings can be saved as presets; the settings are the test's state without the run state.
// "grayCurve" is no test: its slots hold the gray curve of Hyperion (saturation limit, points). Whether the
// curve is on belongs to the whole function, not to a slot (old slots lose their "enabled" on load).
// "blackThreshold" likewise: its slots hold the threshold of the LED device (the switch stays global).
// "hyColor": its slots hold the color values of a color entry (colors, brightness and saturation, gamma
// and color temperature), the fields of the Hyperion column in the test colors card.
const PRESET_TESTS = ["bars", "grayTest", "depthTest", "fracTest", "posTest", "grayCurve", "blackThreshold", "hyColor"];
const MAX_TEST_PRESETS = 50;
const MAX_PRESETS = { grayCurve: 10, blackThreshold: 10, hyColor: 10 };
const SLOT_TESTS = ["grayCurve", "blackThreshold", "hyColor"];
const maxPresets = (test) => MAX_PRESETS[test] ?? MAX_TEST_PRESETS;
function grayCurveSettings(input) {
  const gain = (v) => num(v, 0, 2, 1, 0.01);
  const points = (Array.isArray(input?.points) ? input.points : []).filter((p) => p && typeof p === "object").slice(0, 12)
    .map((p) => ({ gainBlue: gain(p.gainBlue), gainGreen: gain(p.gainGreen), gainRed: gain(p.gainRed), level: num(p.level, 0, 100, 50) }));
  return { saturationLimit: num(input?.saturationLimit, 0.01, 1, 0.15, 0.01), points };
}
// schema-device.json: blackThreshold.threshold 0 to 10 in steps of 0.05, default 0.5
const blackThresholdSettings = (input) => ({ threshold: num(input?.threshold, 0, 10, 0.5, 0.05) });
// ranges like COLOR_FIELDS; a field missing in the input stays out (an older Hyperion may lack one)
const HY_COLOR_SPECS = {
  white: ["rgb"], red: ["rgb"], green: ["rgb"], blue: ["rgb"], cyan: ["rgb"], magenta: ["rgb"], yellow: ["rgb"],
  brightness: ["num", 0, 100, 1], saturationGain: ["num", 0, 10, 0.1], backlightThreshold: ["num", 0, 100, 1], backlightColored: ["bool"],
  gammaRed: ["num", 0.1, 100, 0.05], gammaGreen: ["num", 0.1, 100, 0.05], gammaBlue: ["num", 0.1, 100, 0.05], temperature: ["num", 1000, 40000, 100],
};
function hyColorSettings(input) {
  const out = {};
  for (const [key, [kind, min, max, step]] of Object.entries(HY_COLOR_SPECS)) {
    const v = input?.[key];
    if (v === undefined) continue;
    if (kind === "rgb") { if (Array.isArray(v) && v.length === 3) out[key] = v.map((c) => num(c, 0, 255, 0, 1)); }
    else if (kind === "bool") out[key] = v === true;
    else out[key] = num(v, min, max, min, step);
  }
  return out;
}
function presetSettings(test, settings) {
  if (test === "grayCurve") return grayCurveSettings(settings);
  if (test === "blackThreshold") return blackThresholdSettings(settings);
  if (test === "hyColor") return hyColorSettings(settings);
  if (test === "bars") return sanitize({ bars: settings }).bars;
  const { active, startedAt, ...rest } = sanitize({ [test]: { ...settings, active: false } })[test];
  return rest;
}
function applyPresetOp(op, presets) {
  const test = op?.test;
  if (!PRESET_TESTS.includes(test)) throw new Error("Unbekannter Test");
  const list = [...(presets[test] ?? [])];
  const at = list.findIndex((p) => p.id === op.id);
  const name = typeof op.name === "string" ? op.name.trim().slice(0, 60) : "";
  if (op.op === "save") {
    if (!name) throw new Error("Bitte einen Namen eingeben");
    if (list.length >= maxPresets(test)) throw new Error(SLOT_TESTS.includes(test) ? `Maximal ${maxPresets(test)} Speicherplätze` : `Maximal ${maxPresets(test)} Vorlagen je Test`);
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, fav: false, settings: presetSettings(test, op.settings ?? {}), savedAt: Date.now() });
  } else {
    if (at < 0) throw new Error("Vorlage nicht gefunden");
    if (op.op === "delete") list.splice(at, 1);
    else if (op.op === "fav") list[at] = { ...list[at], fav: !list[at].fav };
    else if (op.op === "rename") { if (!name) throw new Error("Bitte einen Namen eingeben"); list[at] = { ...list[at], name }; }
    else if (op.op === "update") list[at] = { ...list[at], settings: presetSettings(test, op.settings ?? {}), savedAt: Date.now() };
    else throw new Error("Unbekannte Aktion");
  }
  return { ...presets, [test]: list };
}

let state = loadState();
const clients = new Map(); // response -> role ("tv" | "phone")

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return sanitize({ ...DEFAULT_STATE, ...raw });
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function sanitize(input) {
  const out = structuredClone(DEFAULT_STATE);
  if (typeof input.color === "string" && HEX_COLOR.test(input.color)) out.color = input.color.toLowerCase();
  if (typeof input.colorActive === "boolean") out.colorActive = input.colorActive;
  for (const edge of ["top", "bottom", "left", "right"]) {
    const v = Number(input.bars?.[edge]);
    if (Number.isFinite(v)) out.bars[edge] = Math.min(MAX_BAR, Math.max(0, Math.round(v * 10) / 10));
  }
  const g = { ...DEFAULT_STATE.grayTest, ...(input.grayTest ?? {}) };
  out.grayTest = {
    active: g.active === true,
    tone: num(g.tone, 0, 255, 128),
    dropEnabled: g.dropEnabled !== false,
    dropAfter: num(g.dropAfter, 0, 120, 3, 0.5),
    dropPercent: num(g.dropPercent, 1, 100, 50),
    dropDuration: num(g.dropDuration, 0, 5, 0.4, 0.1),
    startedAt: num(g.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
  const d = { ...DEFAULT_STATE.depthTest, ...(input.depthTest ?? {}) };
  const hex = (c, fallback) => (typeof c === "string" && HEX_COLOR.test(c) ? c.toLowerCase() : fallback);
  out.depthTest = {
    active: d.active === true,
    pattern: d.pattern === "sweep" ? "sweep" : "frame",
    outer: hex(d.outer, DEFAULT_STATE.depthTest.outer),
    inner: hex(d.inner, DEFAULT_STATE.depthTest.inner),
    topBottom: num(d.topBottom, 0, 50, 5, 0.5),
    leftRight: num(d.leftRight, 0, 50, 8, 0.5),
    sweepMax: num(d.sweepMax, 1, 50, 20, 1),
    sweepSeconds: num(d.sweepSeconds, 2, 60, 8, 1),
    lineWidth: num(d.lineWidth, 0.5, 5, 1, 0.5),
    startedAt: num(d.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
  const f = { ...DEFAULT_STATE.fracTest, ...(input.fracTest ?? {}) };
  out.fracTest = {
    active: f.active === true,
    pattern: f.pattern === "toggle" ? "toggle" : "ramp",
    tint: ["gray", "red", "green", "blue"].includes(f.tint) ? f.tint : "gray",
    from: num(f.from, 0, 255, 20),
    to: num(f.to, 0, 255, 30),
    rampSeconds: num(f.rampSeconds, 2, 120, 20),
    base: num(f.base, 0, 254, 25),
    delta: num(f.delta, 0.125, 1, 0.5, 0.125),
    toggleSeconds: num(f.toggleSeconds, 0.5, 10, 2, 0.5),
    startedAt: num(f.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
  const lp = { ...DEFAULT_STATE.posTest, ...(input.posTest ?? {}) };
  out.posTest = {
    active: lp.active === true,
    mode: lp.mode === "run" ? "run" : "single",
    index: num(lp.index, 0, 9999, 0),
    width: [1, 3, 5].includes(Number(lp.width)) ? Number(lp.width) : 1,
    speed: num(lp.speed, 1, 60, 10),
    color: hex(lp.color, DEFAULT_STATE.posTest.color),
    background: lp.background === "gray" ? "gray" : "black",
    startedAt: num(lp.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
  const pg = { ...DEFAULT_STATE.posGuide, ...(input.posGuide ?? {}) };
  const points = Array.isArray(pg.points) ? pg.points.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < 10000).slice(0, 200) : [];
  const answers = {};
  for (const [i, v] of Object.entries(pg.answers ?? {})) {
    if (!points.includes(Number(i))) continue;
    answers[i] = v === null ? null : num(v, -MAX_ANSWER, MAX_ANSWER, 0);
  }
  out.posGuide = {
    active: pg.active === true && points.length > 0,
    round: pg.round === "control" ? "control" : "measure",
    points,
    step: num(pg.step, 0, points.length, 0),
    answers,
    done: pg.done === true,
    cursor: num(pg.cursor, -MAX_ANSWER, MAX_ANSWER, 0),
  };
  const o = { ...DEFAULT_STATE.overlays, ...(input.overlays ?? {}) };
  out.overlays = Object.fromEntries(Object.keys(DEFAULT_STATE.overlays).map((k) => [k, o[k] === true]));
  if (input.presetColors && typeof input.presetColors === "object") {
    out.presetColors = Object.fromEntries(
      Object.entries(input.presetColors)
        .filter(([id, c]) => PRESET_IDS.includes(id) && typeof c === "string" && HEX_COLOR.test(c))
        .map(([id, c]) => [id, c.toLowerCase()]),
    );
  }
  if (input.lang === "en" || input.lang === "de") out.lang = input.lang;
  out.testGuard = input.testGuard !== false;
  out.guardRules = Object.fromEntries(GUARD_TESTS.map((t) => {
    const list = Array.isArray(input.guardRules?.[t]) ? input.guardRules[t] : DEFAULT_GUARD_RULES[t];
    return [t, GUARD_FEATURES.filter((f) => list.includes(f) && !(GUARD_FIXED[t] ?? []).includes(f))];
  }));
  for (const test of PRESET_TESTS) {
    const list = Array.isArray(input.testPresets?.[test]) ? input.testPresets[test] : [];
    const clean = list.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && p.settings && typeof p.settings === "object")
      .slice(0, maxPresets(test))
      .map((p) => ({ id: p.id.slice(0, 40), name: p.name.trim().slice(0, 60) || "?", fav: p.fav === true, settings: presetSettings(test, p.settings), savedAt: num(p.savedAt, 0, Number.MAX_SAFE_INTEGER, 0) }));
    if (clean.length) out.testPresets[test] = clean;
  }
  if (input.grayCurveByGrabber && typeof input.grayCurveByGrabber === "object") {
    out.grayCurveByGrabber = Object.fromEntries(Object.entries(input.grayCurveByGrabber)
      .filter(([d, id]) => typeof id === "string" && d.length <= 200 && id.length <= 40).slice(0, 30));
  }
  if (typeof input.curveGrabber === "string") out.curveGrabber = input.curveGrabber.slice(0, 200);
  out.lastPort = num(input.lastPort, 0, 65535, 0);
  out.ffmpegHint = { upload: input.ffmpegHint?.upload === true, play: input.ffmpegHint?.play === true };
  const md = { ...DEFAULT_STATE.media, ...(input.media ?? {}) };
  out.media = {
    active: md.active === true && typeof md.id === "string" && md.id.length > 0,
    id: typeof md.id === "string" ? md.id.slice(0, 600) : "",
    // a file of another source: what it is, for the TV (the list of the source is not kept here)
    src: md.src && typeof md.src === "object" ? { kind: md.src.kind === "image" ? "image" : "video", name: String(md.src.name ?? "").slice(0, 200) } : null,
    fit: ["contain", "cover", "fill"].includes(md.fit) ? md.fit : "contain",
    playing: md.playing !== false,
    loop: md.loop !== false,
    muted: md.muted !== false,
    position: num(md.position, 0, 86400 * 2, 0, 0.001),
    startedAt: num(md.startedAt, 0, Number.MAX_SAFE_INTEGER, 0),
  };
  if (Array.isArray(input.grabberColors)) {
    const colors = input.grabberColors.filter((c) => typeof c === "string" && HEX_COLOR.test(c)).map((c) => c.toLowerCase());
    out.grabberColors = [...new Set(colors)].slice(0, MAX_CUSTOM_COLORS);
  }
  if (Array.isArray(input.customColors)) {
    const colors = input.customColors.filter((c) => typeof c === "string" && HEX_COLOR.test(c)).map((c) => c.toLowerCase());
    out.customColors = [...new Set(colors)].slice(0, MAX_CUSTOM_COLORS);
  }
  return out;
}

// write to a temp file and rename, so a crash mid-write never leaves a broken state.json behind
// (loadState would then fall back to the defaults and the custom colors would be gone)
function saveState() {
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function phoneCount() {
  let n = 0;
  for (const role of clients.values()) if (role === "phone") n++;
  return n;
}

// --- notices of the bell: every change of state the control page should tell about (kind, level
// "info" | "critical", params for the text, target = id of the card to jump to). The pages write the
// texts, so they follow the language of each page. Kept in notices.json, the newest last.
const NOTICES_FILE = path.join(DATA_DIR, "notices.json");
const NOTICE_MAX = 60;
let notices = [];
try { notices = JSON.parse(fs.readFileSync(NOTICES_FILE, "utf8")).filter((n) => n && Number.isInteger(n.id)).slice(-NOTICE_MAX); } catch {}
let health = { hyperionUp: true, noSignal: false, grabberStuck: false, noGrabber: false, nsCalibrating: false }; // shown in the bar of the control page

function addNotice(kind, level, params = {}, target = "") {
  const id = (notices.at(-1)?.id ?? 0) + 1;
  notices.push({ id, ts: Date.now(), kind, level, params, target });
  notices = notices.slice(-NOTICE_MAX);
  try { fs.writeFileSync(NOTICES_FILE, JSON.stringify(notices)); } catch {}
  broadcast();
}

const hasTv = () => [...clients.values()].includes("tv");

// media library (media.mjs); the pages read the list again when mediaStamp changes
let mediaStamp = 0;
const media = createMedia({ dataDir: DATA_DIR, onChange: () => { mediaStamp++; broadcast(); }, onUpload: (it) => ffmpegHint(it, "upload") });
// without ffmpeg/ffprobe videos still work, but codec, HDR and length stay unknown: the bell says so
// once at the first video uploaded and once at the first video played
function ffmpegHint(it, when) {
  if (it?.kind !== "video" || media.info().ffprobe || state.ffmpegHint?.[when]) return;
  state = sanitize({ ...state, ffmpegHint: { ...state.ffmpegHint, [when]: true } });
  saveState();
  addNotice("ffmpegMissing", "info", { when }, "card-media");
}
// sources the user added (folder/NAS, Plex, Jellyfin): browsed and streamed through this server
const sources = createSources({ dataDir: DATA_DIR, thumbsDir: path.join(DATA_DIR, "media", "thumbs") });
let tvCaps = null;   // what the TV page's browser can play (canPlayType), sent by the TV page
let tvMedia = null;  // what the TV page reports about the shown media: position, length, errors
function mediaItemOf(id) {
  if (!id) return null;
  if (id.startsWith("builtin:")) return { id, kind: "builtin" };
  if (id.startsWith("src:")) return sources.item(id, state.media?.src);
  return media.find(id);
}

// port of Hyperion's WebUI (global setting webConfig), for the link on the control page
let webuiPortCache = { at: 0, port: 8090 };
function webuiPort() {
  if (Date.now() - webuiPortCache.at > 60_000) {
    try { webuiPortCache = { at: Date.now(), port: Number(readGlobalSetting("webConfig")?.port) || 8090 }; } catch { webuiPortCache.at = Date.now(); }
  }
  return webuiPortCache.port;
}

// the computer Hyperion and this server run on, for the power menu: its name and whether it can be
// restarted / shut down from here (Linux with systemd, and root or sudo without a password for
// systemctl); otherwise the reason (whyKey for the WebUI's texts), and the buttons stay disabled
const hostDevice = { name: os.hostname(), power: false, why: "", whyKey: "" };
const runQuiet = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stderr || stdout || err?.message || "").trim() })));
const powerCommand = (action) => (process.getuid?.() === 0 ? ["systemctl", [action]] : ["sudo", ["-n", "systemctl", action]]);
async function checkPower() {
  if (process.platform !== "linux") return Object.assign(hostDevice, { why: "Nur unter Linux möglich", whyKey: "notLinux" });
  if (!fs.existsSync("/run/systemd/system")) return Object.assign(hostDevice, { why: "Kein systemd (z. B. in Docker)", whyKey: "noSystemd" });
  if (process.getuid?.() !== 0) {
    for (const action of ["reboot", "poweroff"]) {
      if (!(await runQuiet("sudo", ["-n", "-l", "systemctl", action])).ok) return Object.assign(hostDevice, { why: "Kein Recht dazu (sudo ohne Passwort für systemctl fehlt)", whyKey: "noRight" });
    }
  }
  hostDevice.power = true;
}
checkPower().then(() => broadcast());

// the state with everything the pages show besides it
function publicState() {
  return { ...state, tvVersion, mediaItem: state.media?.active ? mediaItemOf(state.media.id) : null, mediaStamp, tvCaps, tvMedia,
    webuiPort: webuiPort(), port: PORT, portFixed: !!process.env.TVTEST_PORT, grabberRun, gcGuide, colorStamp, grabberCorrection, layoutFix: layoutFixInfo, guard: guardInfo, paused, graceUntil, tvConnected: hasTv(), health, notices, rgbWizard, device: hostDevice, hyperionLink: !!monitor, usbReset, authRequired };
}

// what runs now, per card: { "card-…": "test" | "calib" } — for the symbols in the menu of the WebUI;
// the control page has the same rules in sideRunning() (plus the white point, which only it knows).
// The ids are the ones of the guide (content/guide.html in the WebUI).
function runningCards() {
  const pattern = ["grayTest", "depthTest", "fracTest", "posTest"].some((t) => state[t]?.active) || state.posGuide?.active;
  const fullScreen = (grabberRun.running && grabberRun.color) || gcGuide.active;
  const r = {
    "card-gx": grabberRun.running && "calib",
    "card-ns": health.nsCalibrating && "calib",
    "card-color": state.colorActive !== false && !pattern && !fullScreen && !state.media?.active && "test",
    "card-gcg": gcGuide.active && "calib",
    "card-rgb": rgbWizard && "test",
    "card-bars": Object.values(state.bars ?? {}).some((v) => v > 0) && "test",
    "card-gs": state.grayTest?.active && "test",
    "card-dt": state.depthTest?.active && "test",
    "card-ft": state.fracTest?.active && "test",
    "card-lp": (state.posGuide?.active && "calib") || (state.posTest?.active && "test"),
    "card-media": state.media?.active && "test",
  };
  return Object.fromEntries(Object.entries(r).filter(([, v]) => v));
}

// Every event carries the full state plus how many phones are connected (the TV hides its QR code then)
function broadcast() {
  // serverNow lets the TV time the gray test against the Pi's clock, not its own
  const payload = `data: ${JSON.stringify({ ...publicState(), phones: phoneCount(), serverNow: Date.now() })}\n\n`;
  for (const res of clients.keys()) res.write(payload);
}

// A restart or shutdown that was asked for, as a named "system" event: every control page shows its
// loading layer with the right text, also the ones that did not press the button
function broadcastSystem(kind) {
  const payload = `event: system\ndata: ${JSON.stringify({ kind })}\n\n`;
  for (const [res, role] of clients) if (role === "phone") res.write(payload);
}

// Debug data from Hyperion goes to every event stream as a named "debug" event
function broadcastDebug(debug) {
  const payload = `event: debug\ndata: ${JSON.stringify(debug)}\n\n`;
  for (const res of clients.keys()) res.write(payload);
}

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  // margin is in pixels: 4 modules of quiet zone, which scanners need
  return qr.createSvgTag({ cellSize: 8, margin: 32, scalable: true });
}

function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png" };

function serveStatic(res, file) {
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) return sendJson(res, 403, { error: "forbidden" });
  fs.readFile(full, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

// --- browser settings per device (language, theme, folds, bell …): the pages keep them in localStorage,
// which belongs to one address with its port, so after a port change they were gone. A cookie (cookies
// belong to the host name, not to the port) names the device; the server keeps its "tvtest-*" keys in
// prefs.json and puts them into the page it serves, prefs.js mirrors every change back.
const PREFS_FILE = path.join(DATA_DIR, "prefs.json");
const PREFS_MAX_DEVICES = 50;
const PREFS_MAX_BYTES = 20_000;
let prefs = {};
try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, "utf8")) ?? {}; } catch {}
let prefsTimer = null;
function savePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const tmp = PREFS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(prefs));
    fs.renameSync(tmp, PREFS_FILE);
  }, 300);
}
// version of the files the TV page loads: a TV page that was served older files reloads itself as soon
// as nothing is shown (tv.html compares it with the version written into it when it was served)
const TV_FILES = ["tv.html", "i18n.js", "i18n-en.js", "overlay.js", "testimages.js", "tvmedia.js", "prefs.js"];
function tvFilesVersion() {
  const parts = TV_FILES.map((f) => { try { const st = fs.statSync(path.join(PUBLIC, f)); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return f; } });
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}
let tvVersion = tvFilesVersion();
setInterval(() => { const v = tvFilesVersion(); if (v !== tvVersion) { tvVersion = v; broadcast(); } }, 5000);

const deviceOf = (req) => /(?:^|;\s*)tvtest-device=([\w-]{8,40})/.exec(req.headers.cookie ?? "")?.[1] ?? null;

function changePrefs(req, changes) {
  const id = deviceOf(req);
  if (!id) throw new Error("Kein Geräte-Cookie");
  const entry = prefs[id] ?? { keys: {}, seen: 0 };
  for (const [k, v] of Object.entries(changes ?? {})) {
    if (!/^tvtest-[\w-]{1,60}$/.test(k)) continue;
    if (v === null) entry.keys[k] = null; // removed: the other ports remove it too
    else entry.keys[k] = String(v).slice(0, 4000);
  }
  if (JSON.stringify(entry.keys).length > PREFS_MAX_BYTES) throw new Error("Zu viele Einstellungen");
  entry.seen = Date.now();
  prefs[id] = entry;
  // the devices not seen for the longest time go first
  const ids = Object.keys(prefs).sort((a, b) => prefs[b].seen - prefs[a].seen);
  for (const old of ids.slice(PREFS_MAX_DEVICES)) delete prefs[old];
  savePrefs();
}

// phone.html / tv.html with the device's settings in front of everything else
function servePage(req, res, file) {
  let id = deviceOf(req);
  const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" };
  if (!id) {
    id = createHash("sha1").update(String(Math.random()) + Date.now()).digest("hex").slice(0, 20);
    headers["Set-Cookie"] = `tvtest-device=${id}; Max-Age=315360000; Path=/; SameSite=Lax; HttpOnly`;
  }
  fs.readFile(path.join(PUBLIC, file), "utf8", (err, html) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    const keys = JSON.stringify(prefs[id]?.keys ?? {}).replace(/</g, "\\u003c");
    const inject = `<script>window.TVTEST_PREFS=${keys};window.TVTEST_VERSION=${JSON.stringify(tvFilesVersion())};</script><script src="/static/prefs.js"></script>`;
    res.writeHead(200, headers);
    res.end(html.replace("<head>", "<head>" + inject));
  });
}

function makeBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `hyperion-${stamp}.db`;
  const target = path.join(BACKUP_DIR, name);
  const db = new DatabaseSync(HYPERION_DB, HYPERION_DB_READ);
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  // The backup is downloadable on the LAN, so drop the login data from the copy
  const copy = new DatabaseSync(target);
  try {
    copy.exec("DELETE FROM auth");
  } finally {
    copy.close();
  }
  return name;
}

function listBackups() {
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => ({ name: f, size: fs.statSync(path.join(BACKUP_DIR, f)).size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

// --- Hyperion JSON-API (port 19444, one JSON message per line) ---

function openHyperion() {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: HYPERION_HOST, port: HYPERION_JSON_PORT });
    const waiting = new Map(); // tan -> { resolve, reject, timer }
    let buf = "";
    let nextTan = 1;
    const failAll = (err) => {
      for (const w of waiting.values()) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      waiting.clear();
    };
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const w = waiting.get(msg.tan);
        if (!w) continue; // subscriptions or unrelated replies
        waiting.delete(msg.tan);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    });
    sock.on("error", (err) => {
      failAll(err);
      reject(err);
    });
    sock.on("close", () => failAll(new Error("Verbindung zu Hyperion getrennt")));
    sock.on("connect", () =>
      resolve({
        call(message, timeoutMs = 15_000) {
          const tan = nextTan++;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              waiting.delete(tan);
              rej(new Error(`Hyperion antwortet nicht (${message.command})`));
            }, timeoutMs);
            waiting.set(tan, { resolve: res, reject: rej, timer });
            sock.write(JSON.stringify({ ...message, tan }) + "\n");
          });
        },
        close() {
          sock.end();
        },
      }),
    );
  });
}

function readToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function loginHyperion(api) {
  const token = readToken();
  if (!token) throw new Error("Nicht mit Hyperion verbunden. Zuerst „Mit Hyperion verbinden“ ausführen.");
  const reply = await api.call({ command: "authorize", subcommand: "login", token });
  if (!reply.success) throw new Error("Hyperion hat den Token abgelehnt. Bitte neu verbinden.");
}

// One token request at a time; the phone polls its state
let tokenRequest = { status: "idle", id: null, error: null };

async function requestToken() {
  const id = Math.random().toString(36).slice(2, 7).padEnd(5, "0");
  tokenRequest = { status: "pending", id, error: null };
  let api;
  try {
    api = await openHyperion();
    const reply = await api.call(
      { command: "authorize", subcommand: "requestToken", comment: "Hyperion TV-Testseite", id },
      TOKEN_REQUEST_TIMEOUT_MS + 5_000,
    );
    if (!reply.success || !reply.info?.token) throw new Error(reply.error ?? "Anfrage abgelehnt oder abgelaufen");
    fs.writeFileSync(TOKEN_FILE, reply.info.token + "\n", { mode: 0o600 });
    tokenRequest = { status: "ok", id, error: null };
  } catch (err) {
    tokenRequest = { status: "failed", id, error: err.message };
  } finally {
    api?.close();
  }
}

async function hyperionStatus() {
  if (!readToken()) return { connected: false, request: tokenRequest };
  let api;
  try {
    api = await openHyperion();
    await loginHyperion(api);
    return { connected: true, request: tokenRequest };
  } catch (err) {
    return { connected: false, request: tokenRequest, error: err.message };
  } finally {
    api?.close();
  }
}

// --- Live monitor: one persistent JSON-API connection for the fork's "forkdebug" state and the grabber image ---

const DEBUG_POLL_MS = 250;
const PREVIEW_INTERVAL_MS = 50; // up to 20 frames per second, as fast as Hyperion sends them to the WebUI
const previewClients = new Set();
let monitor = null; // { sock, call, imageStreaming }
let latestFrame = null;
let latestFrameSent = null;
let lastDebug = null;

function connectMonitor() {
  const sock = net.createConnection({ host: HYPERION_HOST, port: HYPERION_JSON_PORT });
  const waiting = new Map();
  let buf = "";
  let nextTan = 1;
  sock.setEncoding("utf8");
  const m = {
    sock,
    imageStreaming: false,
    call(message, timeoutMs = 5_000) {
      const tan = nextTan++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(tan); reject(new Error("timeout " + message.command)); }, timeoutMs);
        waiting.set(tan, (msg) => { clearTimeout(timer); resolve(msg); });
        sock.write(JSON.stringify({ ...message, tan }) + "\n");
      });
    },
  };
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.command === "ledcolors-imagestream-update") {
        latestFrame = msg.data?.image ?? null;
        continue;
      }
      const w = waiting.get(msg.tan);
      if (w) { waiting.delete(msg.tan); w(msg); }
    }
  });
  // hyperionLink in the state follows this connection at once: the loading layer of the control page
  // waits for it after a restart of Hyperion
  sock.on("connect", () => { monitor = m; usbResetPolls = 0; syncImageStream(); broadcast(); });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (monitor === m) { monitor = null; broadcast(); }
    lastDebug = null;
    setTimeout(connectMonitor, 3000); // Hyperion restarts (e.g. after a restore) are expected
  });
}

// Subscribe to Hyperion's image stream only while somebody looks at the preview
async function syncImageStream() {
  if (!monitor) return;
  const want = previewClients.size > 0;
  if (want === monitor.imageStreaming) return;
  monitor.imageStreaming = want;
  try {
    await monitor.call({ command: "ledcolors", subcommand: want ? "imagestream-start" : "imagestream-stop", instance: 0 });
  } catch { monitor.imageStreaming = !want; }
  if (!want) latestFrame = latestFrameSent = null;
}

setInterval(async () => {
  if (!monitor || clients.size === 0) return;
  try {
    const reply = await monitor.call({ command: "forkdebug", instance: 0 });
    lastDebug = reply.success ? { ok: true, ...reply.info, at: Date.now() } : { ok: false, error: reply.error ?? "forkdebug fehlgeschlagen" };
  } catch (err) {
    lastDebug = { ok: false, error: err.message };
  }
  broadcastDebug(lastDebug);
}, DEBUG_POLL_MS);

setInterval(() => {
  if (!latestFrame || latestFrame === latestFrameSent) return;
  latestFrameSent = latestFrame;
  const payload = `data: ${latestFrame}\n\n`;
  for (const res of previewClients) res.write(payload);
}, PREVIEW_INTERVAL_MS);

connectMonitor();

// --- Grabber test: the TV shows known colors full screen, Hyperion measures the decoded grabber
// frames (fork command "grabbertest", before any calibration), the result goes to Hyperion's global
// setting "grabberTest" and is shown in the WebUI (Aufnahme Hardware). The server runs the test, so
// it goes on when the phone's screen turns off.

require("./public/grabbertest-report.js");
require("./public/nosignal-ui.js");
require("./public/notice-text.js");
const NoSignal = globalThis.NoSignalUI;
const Report = globalThis.GrabberTestReport;
const NoticeText = globalThis.NoticeText;

const GT_POLL_MS = 100;
const GT_MIN_WAIT_MS = 600;     // TV page, HDMI and grabber need a moment for the new color
const GT_STABLE_POLLS = 4;      // frame means that agree in a row
const GT_STABLE_DELTA = 0.4;
const GT_MAX_SETTLE_MS = 6000;  // measured anyway after this, marked as unstable
const GT_MEASURE_MS = 1000;     // averaged over this long
const GT_MAX_AGE_MS = 1000;     // newest grabber frame must be younger

// transient, not in state.json: what the TV shows and how far the test is
let grabberRun = { running: false, kind: null, index: 0, total: 0, color: null, label: null, error: null, finishedAt: 0, aborted: false };
let grabberAbort = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toHex = (rgb) => "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

async function probeGrabber(reset = false) {
  if (!monitor) throw new Error("Keine Verbindung zu Hyperion");
  const reply = await monitor.call({ command: "grabbertest", reset });
  if (!reply.success) {
    throw new Error(/unknown|not found|schema/i.test(reply.error ?? "") ? "Diese Hyperion-Version kann den Grabber nicht messen (Fork-Befehl „grabbertest“ fehlt)" : `Hyperion: ${reply.error ?? "Messung fehlgeschlagen"}`);
  }
  return reply.info;
}

function readGlobalSetting(type) {
  const db = new DatabaseSync(HYPERION_DB, HYPERION_DB_READ);
  try {
    const row = db.prepare("SELECT config FROM settings WHERE type = ? AND hyperion_inst IS NULL").get(type);
    return row ? JSON.parse(row.config) : null;
  } finally {
    db.close();
  }
}

async function writeGlobalSetting(type, next) {
  const api = await openHyperion();
  try {
    await loginHyperion(api);
    const reply = await api.call({ command: "config", subcommand: "setconfig", config: { global: { settings: { [type]: next } } } });
    if (!reply.success) {
      const details = Array.isArray(reply.errorData) ? reply.errorData.map((e) => e.description ?? e).join("; ") : "";
      throw new Error(`Hyperion: ${reply.error ?? "Speichern fehlgeschlagen"}${details ? ` (${details})` : ""}`);
    }
  } finally {
    api.close();
  }
}

// the grabber settings at test time; the WebUI flags the result when they change later
function grabberSnapshot() {
  const v = readGlobalSetting("grabberV4L2") ?? {};
  const out = { name: String(v.available_devices ?? "").split(":")[0].trim() || null };
  for (const k of [...Report.GRABBER_KEYS, "standard"]) if (k in v) out[k] = v[k];
  return out;
}

function stepLabel(step) {
  const t = Report.TEXT.de;
  if (step.group === "custom") return step.name.toUpperCase();
  if (step.group === "mix") return t[step.name] ?? step.name;
  if (step.group === "black") return t.black;
  const level = Math.max(...step.sent);
  return `${t[step.group] ?? step.group} ${level}`;
}

// --- grabber color correction: calibrations per grabber model (global setting grabberTest.grabbers,
// see grabbertest-report.js). Hyperion corrects the frames of the connected grabber with the active
// slot of that grabber. Every few seconds the server asks Hyperion which grabber delivers frames
// (fork command "grabbertest" with peek) and broadcasts the state for the switches, the memory
// slots and the bell; the WebUI can change the setting too, so it is read again each time.
let grabberDevice = null; // name of the grabber that delivers frames, kept while none arrive
let peekSupported = null; // false: this Hyperion knows no per-grabber calibrations yet
let grabberCorrection = { available: false, enable: false, basedOn: null, device: null, slot: -1, name: "", stamp: "", notifications: [] };

async function peekGrabber() {
  if (!monitor) return;
  try {
    const reply = await monitor.call({ command: "grabbertest", peek: true });
    peekSupported = !!reply.success;
    if (reply.success && reply.info?.device) grabberDevice = reply.info.device;
  } catch {}
}

// The grabber chosen in Hyperion (WebUI "Gerät gefunden", global setting grabberV4L2): Hyperion only
// opens a device with exactly this name and corrects its frames by it, so the memory slots belong to
// it; without one, the grabber that delivers frames
function selectedGrabber() {
  try {
    const v = readGlobalSetting("grabberV4L2") ?? {};
    const name = String(v.available_devices ?? "");
    if (v.enable && name && !["NONE", "SELECT", "none"].includes(name)) return name;
  } catch {}
  return grabberDevice;
}

function readGrabberCorrection() {
  try {
    const gt = readGlobalSetting("grabberTest") ?? {};
    const device = selectedGrabber();
    const c = Report.currentCorrection(gt, device);
    const g = Report.grabberEntry(gt, device);
    const basic = gt.basic?.steps?.length ? gt.basic : null;
    const canFit = !!(basic && Report.sameGrabber(Report.testDevice(basic), device) && !Report.fitCorrection(basic).error);
    const available = !!(c.matrix || g?.slots?.some(Boolean) || canFit);
    // changes whenever the slots or the last test change, so the page reloads them
    const stamp = createHash("sha1").update(JSON.stringify(Report.migrated(gt).grabbers ?? {}) + "|" + (basic?.date ?? "")).digest("hex").slice(0, 12);
    const notifications = Report.notifications(gt, device).map(({ id, kind, device: d, name }) => ({ id, kind, device: d, name }));
    return { available, enable: c.enable === true, basedOn: c.basedOn ?? null, device, deviceName: device ? Report.displayName(device) : null, filled: (g?.slots ?? []).filter(Boolean).length, slot: c.slot ?? -1, name: c.name ?? "", perGrabber: peekSupported === true, stamp, notifications };
  } catch {
    return grabberCorrection;
  }
}

// Settings from before the calibrations per grabber hold one correction for every grabber; they
// are converted once this Hyperion knows the new form (it answers "peek")
async function migrateGrabberCalibrations() {
  // the device is needed: Hyperion looks the calibration up by the grabber's full name
  const device = selectedGrabber();
  if (peekSupported !== true || !device) return;
  const gt = readGlobalSetting("grabberTest");
  if (!gt || gt.grabbers || !gt.correction) return;
  await exclusive(async () => {
    const current = readGlobalSetting("grabberTest");
    if (!current || current.grabbers || !current.correction) return;
    await writeGlobalSetting("grabberTest", Report.migrated(current, device));
    console.log("grabberTest: correction converted to the calibrations per grabber");
  });
}

async function refreshGrabberCorrection() {
  await peekGrabber();
  try { await migrateGrabberCalibrations(); } catch (err) { console.warn("grabberTest migration:", err.message); }
  const next = readGrabberCorrection();
  if (JSON.stringify(next) === JSON.stringify(grabberCorrection)) return;
  grabberCorrection = next;
  broadcast();
}
grabberCorrection = readGrabberCorrection();
setInterval(refreshGrabberCorrection, 4000);

// --- watched states for the bell and the bar: TV page, Hyperion, grabber frames, "No Signal" ---
let tvReported = null;
let tvTimer = null;
function checkTv() {
  clearTimeout(tvTimer);
  const now = hasTv();
  if (tvReported === null) { tvReported = now; return; } // the first state is no change
  if (now === tvReported) return;
  const apply = () => {
    if (hasTv() === tvReported) return;
    tvReported = hasTv();
    addNotice(tvReported ? "tvConnected" : "tvLost", tvReported ? "info" : "critical");
  };
  if (now) apply(); else tvTimer = setTimeout(apply, 5000); // a reloading TV page is no loss
}

const HEALTH_POLL_MS = 4000;
const HYPERION_DOWN_AFTER_MS = 10_000; // a restart of Hyperion takes a few seconds and is no failure
const STUCK_AGE_MS = 5000;
let hyperionDownSince = 0;
let hyperionDownReported = false;
let stuckPolls = 0;
let healthKnown = false;
let wasCalibrating = false;
let lastDevice = null; // grabber that delivered frames at the last poll

// a grabber change: a known one runs with the slots it had last, a new one has no calibration, so
// its "No Signal" detection and color correction stay off until it is calibrated
async function announceGrabber(info) {
  await refreshGrabberCorrection().catch(() => {});
  const name = Report.displayName(info.device);
  const missing = [];
  if (info.calibrated !== true) missing.push("ns");
  if (!grabberCorrection.available || grabberCorrection.slot < 0) missing.push("color");
  if (missing.length) addNotice("grabberNew", "critical", { name, missing }, missing[0] === "ns" ? "card-ns" : "card-gx");
  else addNotice("grabberKnown", "info", { name, nsSlot: info.slotName || "", colorSlot: grabberCorrection.name || "" }, "card-ns");
}

// "Reset grabber (USB) + restart": whether Hyperion can do it here (sysinfo usbReset of the fork: Linux,
// grabber on USB, the right to do it) for the power menu, and the result of the last reset for the bell.
// Asked after every new connection to Hyperion (the reset runs in the restarted process) and every 30 s.
let usbReset = null;
let usbResetPolls = 0;
async function refreshUsbReset() {
  let info;
  try { info = (await monitor.call({ command: "sysinfo" })).info?.usbReset ?? null; } catch { return; }
  const last = info?.last;
  // the result of a reset this server has not reported yet; a server started long after it stays quiet
  if (last?.at && last.at !== usbReset?.last?.at && Date.now() - last.at < 5 * 60_000 && !notices.some((n) => n.params?.at === last.at)) {
    addNotice(last.ok ? "usbResetDone" : "usbResetFailed", last.ok ? "info" : "critical", { at: last.at, whyKey: last.whyKey || "", error: last.error || "", device: info.device || "" }, "card-ns");
  }
  if (JSON.stringify(info) !== JSON.stringify(usbReset)) { usbReset = info; broadcast(); }
}

async function pollHealth() {
  const next = { ...health };
  let info = null;
  if (monitor) {
    hyperionDownSince = 0;
    if (usbResetPolls++ % 8 === 0) await refreshUsbReset();
    try { info = (await monitor.call({ command: "grabbertest", nosignal: "status" })).info ?? null; } catch {}
  } else if (!hyperionDownSince) {
    hyperionDownSince = Date.now();
  }
  const down = !monitor && hyperionDownSince > 0 && Date.now() - hyperionDownSince >= HYPERION_DOWN_AFTER_MS;
  if (down && !hyperionDownReported) { hyperionDownReported = true; addNotice("hyperionDown", "critical", {}, "card-ts"); }
  if (!down && monitor && hyperionDownReported) { hyperionDownReported = false; addNotice("hyperionUp", "info", {}, "card-ts"); }
  next.hyperionUp = !down;
  if (info) {
    const stuck = !!grabberDevice && !info.calibrating && (info.ageMs < 0 || info.ageMs > STUCK_AGE_MS);
    stuckPolls = stuck ? stuckPolls + 1 : 0;
    const nowStuck = stuckPolls >= 2;
    const nowNoSignal = info.noSignal === true && !nowStuck;
    if (info.device && info.device !== lastDevice) {
      const first = lastDevice === null;
      lastDevice = info.device;
      if (!first) await announceGrabber(info);
    }
    if (healthKnown) {
      if (nowStuck !== next.grabberStuck) addNotice(nowStuck ? "grabberStuck" : "grabberOk", nowStuck ? "critical" : "info", {}, "card-ns");
      if (nowNoSignal !== next.noSignal) addNotice(nowNoSignal ? "noSignal" : "signalBack", nowNoSignal ? "critical" : "info", {}, "card-ns");
      if (wasCalibrating && !info.calibrating) addNotice("nsCalibDone", "info", {}, "card-ns");
    }
    wasCalibrating = info.calibrating === true;
    next.grabberStuck = nowStuck;
    next.noGrabber = !info.device;
    next.noSignal = nowNoSignal;
    next.nsCalibrating = info.calibrating === true;
    healthKnown = true;
  }
  if (JSON.stringify(next) !== JSON.stringify(health)) { health = next; broadcast(); }
}
setInterval(() => pollHealth().catch(() => {}), HEALTH_POLL_MS);

// --- "No Signal" still image detection (card of the same name, nosignal-ui.js like the WebUI) ---
// The setting grabberTest.noSignal for the page, without the calibration data of the slots
function noSignalConfig() {
  const ns = readGlobalSetting("grabberTest")?.noSignal ?? {};
  const grabbers = Object.fromEntries(Object.entries(ns.grabbers ?? {}).map(([device, g]) => [device, {
    active: g?.active ?? -1,
    slots: (g?.slots ?? []).map((s) => (s ? { name: s.name ?? "", savedAt: s.savedAt ?? null, featureCells: s.featureCells ?? null, unstableCells: s.unstableCells ?? null, settings: s.settings ?? null } : null)),
  }]));
  return { noSignal: { ...ns, grabbers } };
}

// only the detection's own parameters of the fork command "grabbertest" pass
async function noSignalCommand(params) {
  const cmd = { command: "grabbertest", nosignal: String(params?.nosignal ?? "") };
  if (!["status", "calibrate", "calibration"].includes(cmd.nosignal)) throw new Error("Unbekannter Befehl");
  if (params.image === true) cmd.image = true;
  if (Number.isInteger(params.duration)) cmd.duration = Math.min(10000, Math.max(1000, params.duration));
  const reply = await hyperionCommand(cmd);
  return { info: reply.info ?? {}, config: cmd.nosignal === "status" ? noSignalConfig() : undefined };
}

// op of NoSignalUI.applyOp for the grabber that delivers frames now
async function noSignalOp(op, args) {
  const status = await hyperionCommand({ command: "grabbertest", nosignal: "status" });
  await exclusive(async () => {
    const current = readGlobalSetting("grabberTest") ?? {};
    await writeGlobalSetting("grabberTest", NoSignal.applyOp(current, status.info?.device || null, op, args ?? {}, "de"));
  });
  return { config: noSignalConfig() };
}

// Changes the calibrations of the connected grabber (ops of GrabberTestReport.applyOp)
async function changeGrabberCalibration(op, args) {
  if (peekSupported !== true) throw new Error("Diese Hyperion-Version kennt noch keine Kalibrierungen je Grabber. Bitte die Hyperion-Version des Forks aktualisieren.");
  await exclusive(async () => {
    const current = readGlobalSetting("grabberTest") ?? { basic: {}, custom: {} };
    const next = Report.applyOp(current, selectedGrabber(), op, args ?? {}, "de");
    await writeGlobalSetting("grabberTest", { ...next, basic: next.basic ?? {}, custom: next.custom ?? {} });
  });
  await refreshGrabberCorrection();
}

// --- choosing the grabber like the WebUI (Aufnahme Hardware → USB-Aufnahme → Gerät gefunden) ---

// the video grabbers Hyperion finds (fork JSON API "inputsource discover")
async function discoverGrabbers() {
  if (!monitor) throw new Error("Keine Verbindung zu Hyperion");
  const reply = await monitor.call({ command: "inputsource", subcommand: "discover", sourceType: "video" }, 10_000);
  if (!reply.success) throw new Error(`Hyperion: ${reply.error ?? "Grabbersuche fehlgeschlagen"}`);
  return reply.info?.video_sources ?? [];
}

async function grabberList() {
  const v = readGlobalSetting("grabberV4L2") ?? {};
  const sources = await discoverGrabbers();
  const devices = sources.map((d) => ({ name: d.device_name, path: d.device, label: Report.displayName(d.device_name) }));
  const selected = String(v.available_devices ?? "");
  if (selected && !["NONE", "SELECT", "none"].includes(selected) && !devices.some((d) => d.name === selected)) {
    devices.push({ name: selected, path: v.device ?? null, label: Report.displayName(selected), missing: true });
  }
  return { enable: v.enable === true, selected, devices };
}

// Settings for another grabber, chosen like the WebUI does: the configured values where the new
// device supports them, otherwise its first input and format, the largest resolution and the
// highest frame rate; picture controls from its defaults
function grabberSettingsFor(current, source) {
  const next = { ...current, available_devices: source.device_name, device: source.device };
  const inputs = source.video_inputs ?? [];
  const input = inputs.find((i) => i.inputIdx === current.input) ?? inputs[0];
  if (input) {
    next.input = input.inputIdx;
    next.device_inputs = String(input.inputIdx);
    const formats = input.formats ?? [];
    const format = formats.find((f) => String(f.format ?? "").toUpperCase() === String(current.encoding ?? "").toUpperCase()) ?? formats[0];
    if (format?.format) {
      next.encoding = String(format.format).toUpperCase();
      const res = format.resolutions ?? [];
      const keep = res.find((r) => r.width === current.width && r.height === current.height);
      const pick = keep ?? [...res].sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (pick) {
        next.width = pick.width;
        next.height = pick.height;
        next.resolutions = String(res.indexOf(pick));
        const rates = (pick.fps ?? []).map(Number).filter(Number.isFinite);
        if (rates.length) {
          next.fps = rates.includes(current.fps) ? current.fps : Math.max(...rates);
          next.framerates = String(next.fps);
        }
      }
    }
    if (Array.isArray(input.standards) && input.standards.length) next.standard = input.standards.includes(current.standard) ? current.standard : input.standards[0];
  }
  const defaults = source.default?.properties ?? {};
  for (const [prop, key] of [["brightness", "hardware_brightness"], ["contrast", "hardware_contrast"], ["saturation", "hardware_saturation"], ["hue", "hardware_hue"]]) {
    next[key] = Number.isFinite(defaults[prop]) ? defaults[prop] : 0;
  }
  return next;
}

async function selectGrabber(name) {
  const sources = await discoverGrabbers();
  const source = sources.find((d) => d.device_name === name);
  if (!source) throw new Error("Dieser Grabber ist nicht angeschlossen");
  await exclusive(async () => {
    const current = readGlobalSetting("grabberV4L2") ?? {};
    if (current.available_devices === name && current.enable) return;
    makeBackup();
    await writeGlobalSetting("grabberV4L2", { ...grabberSettingsFor(current, source), enable: true });
  });
  await refreshGrabberCorrection();
}

function setRun(patch) {
  const wasRunning = grabberRun.running;
  grabberRun = { ...grabberRun, ...patch };
  if (wasRunning && !grabberRun.running) {
    if (grabberRun.error) addNotice("gtError", "critical", { error: grabberRun.error }, "card-gx");
    else if (grabberRun.aborted) addNotice("gtAborted", "critical", {}, "card-gx");
    else addNotice("gtDone", "info", { kind: grabberRun.kind }, "card-gx");
  }
  broadcast();
}

async function waitStable(shownAt) {
  await sleep(GT_MIN_WAIT_MS);
  let prev = null;
  let stable = 0;
  for (;;) {
    const s = await probeGrabber(false);
    if (s.ageMs < 0 || s.ageMs > GT_MAX_AGE_MS) throw new Error("Der Grabber liefert keine Bilder mehr");
    const m = s.last.mean;
    if (prev) stable = Math.max(...m.map((v, i) => Math.abs(v - prev[i]))) < GT_STABLE_DELTA ? stable + 1 : 0;
    prev = m;
    if (stable >= GT_STABLE_POLLS) return true;
    if (Date.now() - shownAt > GT_MAX_SETTLE_MS) return false;
    await sleep(GT_POLL_MS);
  }
}

async function runGrabberTest(kind) {
  const steps = kind === "basic"
    ? Report.basicSteps()
    : state.grabberColors.map((c) => ({ group: "custom", name: c, sent: hexRgb(c) }));
  const results = [];
  let frame = null;
  let device = null;
  try {
    for (let i = 0; i < steps.length; i++) {
      if (grabberAbort) break;
      if (![...clients.values()].includes("tv")) throw new Error("Die TV-Seite wurde geschlossen, der Test ist abgebrochen");
      const step = steps[i];
      setRun({ index: i, color: toHex(step.sent), label: stepLabel(step) });
      const settled = await waitStable(Date.now());
      if (grabberAbort) break;
      await probeGrabber(true);
      await sleep(GT_MEASURE_MS);
      const s = await probeGrabber(false);
      if (!s.avg?.n) throw new Error("Der Grabber liefert keine Bilder mehr");
      frame = { width: s.width, height: s.height };
      if (s.device) device = s.device;
      // got is always the uncorrected frame, corr the same frames after the grabber color correction (if on)
      results.push({ ...step, got: s.avg.mean, ...(s.avg.corrected ? { corr: s.avg.corrected } : {}), noise: s.avg.noise, spread: s.avg.spread, n: s.avg.n, ...(settled ? {} : { unstable: true }) });
    }
    if (grabberAbort) {
      setRun({ running: false, color: null, aborted: true, finishedAt: Date.now() });
      return;
    }
    // basic and own colors are kept apart, a new test replaces only its own part; the color
    // correction (switched in the WebUI) stays as it is, the result notes whether it was on
    await exclusive(async () => {
      const current = readGlobalSetting("grabberTest") ?? { basic: {}, custom: {} };
      const grabber = grabberSnapshot();
      if (device) grabber.name = device;
      const used = Report.currentCorrection(current, grabber.name);
      const correction = used.enable ? { correction: used } : {};
      const result = { version: 1, date: new Date().toISOString(), grabber, frame, ...correction, steps: results };
      await writeGlobalSetting("grabberTest", { ...current, basic: current.basic ?? {}, custom: current.custom ?? {}, [kind]: result });
    });
    setRun({ running: false, color: null, finishedAt: Date.now() });
  } catch (err) {
    setRun({ running: false, color: null, error: err.message, finishedAt: Date.now() });
  }
}

async function startGrabberTest(kind) {
  if (grabberRun.running) throw new Error("Die Kalibrierung der Grabber-Farberkennung läuft schon");
  if (kind !== "basic" && kind !== "custom") throw new Error("Unbekannter Test");
  if (kind === "custom" && !state.grabberColors.length) throw new Error("Zuerst eigene Farben anlegen");
  if (![...clients.values()].includes("tv")) throw new Error("Die TV-Seite ist nicht geöffnet. Öffne sie zuerst auf dem Gerät, das dem TV das Bild liefert.");
  if (!readToken()) throw new Error("Nicht mit Hyperion verbunden. Zuerst unter „Backup“ mit Hyperion verbinden.");
  await probeGrabber(true);
  await sleep(400);
  const first = await probeGrabber(false);
  if (first.ageMs < 0 || first.ageMs > GT_MAX_AGE_MS) throw new Error("Der Grabber liefert keine Bilder. Ist die USB-Aufnahme in Hyperion eingeschaltet?");
  const total = kind === "basic" ? Report.basicSteps().length : state.grabberColors.length;
  grabberAbort = false;
  setRun({ running: true, kind, index: 0, total, color: null, label: null, error: null, aborted: false, startedAt: Date.now() });
  runGrabberTest(kind);
}

// --- guided gray curve calibration (card "Graukurve kalibrieren", math in graycal.js) ---
// The TV shows one gray full screen per level. The server sets that gray so that Hyperion measures
// the level after the grabber color correction (what the LEDs are computed from), whatever the
// grabber lifts or lowers. The page answers per level: neutral, or too much / too little of a tint;
// every answer changes the gray curve point of the level at once (a point is added if the level has
// none). After all levels a control round goes through them again. All writes of one run are one
// undo step of the gray curve; "Original" writes the points from before the run.
require("./public/graycurve-graph.js");
require("./public/graycal.js");
const GrayCal = globalThis.GrayCal;
const CurveMath = globalThis.GrayCurveGraph.math;
const GC_MAX_TRIES = 6;     // TV grays tried to hit a level
const GC_MAX_POINTS = 12;   // like the WebUI and the graph

const GC_IDLE = { active: false, phase: "idle", round: "measure", levels: [], index: 0, color: null, measure: null, showing: "after", done: false, error: null, aborted: false, restored: false, startPoints: null, afterPoints: null, results: {}, colorIndex: 0, runId: "" };
let gcGuide = { ...GC_IDLE };
// counts the color writes the server makes on its own, so the pages read the settings again
let colorStamp = 0;
const colorChanged = () => { colorStamp++; broadcast(); };
let gcJob = 0;              // a newer job (level change, stop) ends a running measurement
const gcMemo = {};          // per level: { scale, last } of applyAnswer
const gcTv = {};            // per level: the TV gray that hit it last in this run

function gcSet(patch, silent = false) {
  const was = gcGuide;
  gcGuide = { ...gcGuide, ...patch };
  if (was.active && !gcGuide.active && !gcGuide.done && !silent) {
    if (gcGuide.error) addNotice("gcgError", "critical", { error: gcGuide.error }, "card-gcg");
    else addNotice("gcgAborted", "critical", {}, "card-gcg");
  }
  if (!was.done && gcGuide.done) addNotice("gcgDone", "info", {}, "card-gcg");
  broadcast();
}

const gcEntry = (color) => color?.channelAdjustment?.[gcGuide.colorIndex] ?? null;

// LED output of a gray at the level (0..255 scale per channel, 16-bit counts)
function gcPrediction(level) {
  const color = readInstanceSetting("color");
  const entry = gcEntry(color);
  let black = null;
  try { black = readInstanceSetting("device").blackThreshold ?? null; } catch {}
  const model = CurveMath.makeModel(entry, black);
  const gains = model.curveEnabled ? CurveMath.gainsAt(entry.grayCurve.points ?? [], level) : [1, 1, 1];
  const { led } = CurveMath.grayOutput(model, level * 2.55, gains);
  const counts = led.map((v) => Math.round(v * 257));
  return { counts, on: counts.some((v) => v > 0), coarse: counts.some((v) => v > 0) && Math.min(...counts) < GrayCal.COARSE_COUNTS };
}

// one measurement of the frame mean after the grabber color correction (raw if it is off)
async function gcMeasureOnce(tv, job) {
  gcSet({ color: toHex([tv, tv, tv]) });
  const settled = await waitStable(Date.now());
  if (job !== gcJob) return null;
  await probeGrabber(true);
  await sleep(GT_MEASURE_MS);
  const s = await probeGrabber(false);
  if (!s.avg?.n) throw new Error("Der Grabber liefert keine Bilder mehr");
  const rgb = (s.avg.corrected ?? s.avg.mean).map(Number);
  return { tv, rgb, level: Math.max(...rgb) * 100 / 255, corrected: !!s.avg.corrected, settled };
}

// finds the TV gray that Hyperion measures as `target` percent and measures it
async function gcMeasureLevel(target, job) {
  const tried = new Map();
  let tv = gcTv[target] ?? Math.min(255, Math.max(1, Math.round(target * 2.55)));
  let best = null;
  for (let i = 0; i < GC_MAX_TRIES && !tried.has(tv); i++) {
    if (![...clients.values()].includes("tv")) throw new Error("Die TV-Seite wurde geschlossen");
    const m = await gcMeasureOnce(tv, job);
    if (!m) return null;
    tried.set(tv, m);
    if (!best || Math.abs(m.level - target) < Math.abs(best.level - target)) best = m;
    // close enough: within half a TV step
    if (Math.abs(m.level - target) * 2.55 < 0.5) break;
    const top = Math.max(...m.rgb);
    // the grabber may scale, lift or cut the gray: correct in proportion, or one step up from black
    let next = top > 0.5 ? Math.round(tv * (target * 2.55) / top) : tv + Math.max(1, Math.round(tv / 2));
    next = Math.min(255, Math.max(1, next));
    if (next === tv) next = Math.min(255, Math.max(1, tv + Math.sign(target - m.level)));
    tv = next;
  }
  gcTv[target] = best.tv;
  const shown = toHex([best.tv, best.tv, best.tv]);
  if (gcGuide.color !== shown) gcSet({ color: shown });
  return best;
}

async function gcMeasureCurrent() {
  const job = ++gcJob;
  const target = gcGuide.levels[gcGuide.index];
  gcSet({ phase: "measure", measure: null, error: null });
  try {
    const m = await gcMeasureLevel(target, job);
    if (!m || job !== gcJob) return;
    const color = readInstanceSetting("color");
    const entry = gcEntry(color);
    const limit = Number(entry?.grayCurve?.saturationLimit ?? 0.15);
    const pred = gcPrediction(m.level);
    gcSet({
      phase: "answer",
      measure: {
        level: target, tv: m.tv, rgb: m.rgb.map((v) => Math.round(v * 100) / 100), got: Math.round(m.level * 100) / 100,
        corrected: m.corrected, unstable: !m.settled,
        // the TV gray never reaches the level: the grabber cuts it to black or the step is too coarse
        missed: Math.abs(m.level - target) > Math.max(0.6, target * 0.25),
        weight: Math.round(GrayCal.curveWeight(m.rgb, limit) * 100) / 100,
        ledOn: pred.on, coarse: pred.coarse, counts: pred.counts,
        gains: GrayCal.gainsAt(entry?.grayCurve?.points ?? [], target).map((v) => Math.round(v * 100) / 100),
      },
    });
  } catch (err) {
    if (job === gcJob) gcSet({ phase: "error", error: err.message });
  }
}

// writes points of the run (one undo step per run); no history for the before/after toggle
async function gcWritePoints(points, history = true) {
  const written = history
    ? await saveColor({ index: gcGuide.colorIndex, field: "grayCurve.points", value: points, step: gcGuide.runId })
    : await exclusive(async () => {
      const current = readInstanceSetting("color");
      const next = structuredClone(current);
      next.channelAdjustment[gcGuide.colorIndex].grayCurve.points = points;
      return writeInstanceSetting("color", next);
    });
  colorChanged();
  return written;
}

function gcGo(index) {
  gcSet({ index, measure: null });
  gcMeasureCurrent();
}

// the next level, or the control round, or the end
function gcNext() {
  if (gcGuide.index + 1 < gcGuide.levels.length) return gcGo(gcGuide.index + 1);
  if (gcGuide.round === "measure") {
    gcSet({ round: "control" });
    return gcGo(0);
  }
  gcFinish();
}

function gcFinish() {
  ++gcJob;
  gcSet({ active: false, done: true, phase: "done", color: null, measure: null });
  scheduleGuard();
  updateGrace();
}

async function gcStart({ levels, enableCurve, colorIndex }) {
  if (gcGuide.active) throw new Error("Die Graukurven-Kalibrierung läuft schon");
  if (grabberRun.running) throw new Error("Zuerst die Grabber-Kalibrierung abwarten");
  if (!hasTv()) throw new Error("Die TV-Seite ist nicht geöffnet. Öffne sie zuerst auf dem Gerät, das dem TV das Bild liefert.");
  if (!readToken()) throw new Error("Nicht mit Hyperion verbunden. Zuerst unter „Backup“ mit Hyperion verbinden.");
  const index = Number.isInteger(colorIndex) ? colorIndex : 0;
  const color = readInstanceSetting("color");
  const curve = color.channelAdjustment?.[index]?.grayCurve;
  if (!curve) throw new Error("Diese Hyperion-Version hat keine Graukurve");
  const list = [...new Set((Array.isArray(levels) ? levels : []).map((v) => num(v, 1, 100, NaN)).filter(Number.isFinite))].sort((a, b) => b - a);
  if (!list.length) throw new Error("Mindestens eine Stufe wählen");
  const missing = list.filter((l) => !curve.points?.some((p) => p.level === l)).length;
  if ((curve.points?.length ?? 0) + missing > GC_MAX_POINTS) throw new Error(`Die Graukurve hat höchstens ${GC_MAX_POINTS} Punkte. Weniger neue Stufen wählen.`);
  await probeGrabber(true);
  await sleep(400);
  const first = await probeGrabber(false);
  if (first.ageMs < 0 || first.ageMs > GT_MAX_AGE_MS) throw new Error("Der Grabber liefert keine Bilder. Ist die USB-Aufnahme in Hyperion eingeschaltet?");
  if (curve.enabled !== true) {
    if (enableCurve !== true) throw new Error("Die Graukurve ist ausgeschaltet");
    await saveColor({ index, field: "grayCurve.enabled", value: true });
    colorChanged();
  }
  for (const k of Object.keys(gcMemo)) delete gcMemo[k];
  for (const k of Object.keys(gcTv)) delete gcTv[k];
  // a test pattern would cover the gray: the calibration takes the TV alone
  const off = (t) => ({ ...state[t], active: false });
  state = sanitize({ ...state, grayTest: off("grayTest"), depthTest: off("depthTest"), fracTest: off("fracTest"), posTest: off("posTest"), posGuide: { ...DEFAULT_STATE.posGuide }, colorActive: false });
  saveState();
  delete paused.gcGuide;
  gcSet({ ...GC_IDLE, active: true, levels: list, colorIndex: index, runId: "gcg-" + Date.now().toString(36), startPoints: structuredClone(curve.points ?? []), phase: "measure" });
  // the test guard first, so a still image or black border detection never touches the gray
  await exclusive(syncGuard).catch(() => {});
  updateGrace();
  gcGo(0);
}

async function gcAnswer({ tint, dir, strength }) {
  if (!gcGuide.active || gcGuide.phase !== "answer" || gcGuide.showing !== "after") throw new Error("Gerade ist keine Antwort möglich");
  const level = gcGuide.levels[gcGuide.index];
  const entry = gcEntry(readInstanceSetting("color"));
  const points = entry?.grayCurve?.points ?? [];
  const before = GrayCal.gainsAt(points, level);
  const memo = (gcMemo[level] ??= { scale: 1, last: null });
  const gains = GrayCal.applyAnswer(before, String(tint), dir === "less" ? "less" : "more", Number(strength), memo);
  const next = GrayCal.withPoint(points, level, gains);
  if (next.length > GC_MAX_POINTS) throw new Error(`Die Graukurve hat höchstens ${GC_MAX_POINTS} Punkte`);
  await gcWritePoints(next);
  const r = gcGuide.results[level] ?? { before: GrayCal.gainsAt(gcGuide.startPoints ?? [], level).map((v) => Math.round(v * 100) / 100), answers: 0 };
  gcSet({
    results: { ...gcGuide.results, [level]: { ...r, after: gains, answers: r.answers + 1 } },
    measure: { ...gcGuide.measure, gains, ...((p) => ({ ledOn: p.on, coarse: p.coarse, counts: p.counts }))(gcPrediction(gcGuide.measure?.got ?? level)) },
  });
}

// before/after: the curve from before the run or the current one, written without history
async function gcCompare(show) {
  if (!gcGuide.active || gcGuide.phase !== "answer") throw new Error("Gerade ist kein Vergleich möglich");
  const want = show === "before" ? "before" : "after";
  if (want === gcGuide.showing) return;
  if (want === "before") {
    const now = gcEntry(readInstanceSetting("color"))?.grayCurve?.points ?? [];
    gcGuide.afterPoints = structuredClone(now);
    await gcWritePoints(structuredClone(gcGuide.startPoints ?? []), false);
  } else {
    await gcWritePoints(structuredClone(gcGuide.afterPoints ?? gcGuide.startPoints ?? []), false);
  }
  gcSet({ showing: want });
}

async function gcRestoreAfter() {
  if (gcGuide.showing === "before") {
    await gcWritePoints(structuredClone(gcGuide.afterPoints ?? gcGuide.startPoints ?? []), false);
    gcGuide.showing = "after";
  }
}

// silent: the caller tells about it itself (a pause after a connection loss)
async function gcStop(silent = false) {
  if (!gcGuide.active) return;
  ++gcJob;
  await gcRestoreAfter().catch(() => {});
  gcSet({ active: false, aborted: true, phase: "idle", color: null, measure: null }, silent);
  scheduleGuard();
  updateGrace();
}

async function gcAction(body) {
  const { action } = body ?? {};
  if (action === "start") return gcStart(body);
  if (action === "stop") return gcStop();
  if (action === "close") { if (gcGuide.active) throw new Error("Die Kalibrierung läuft noch"); return gcSet({ ...GC_IDLE }); }
  if (action === "original") {
    if (gcGuide.active || !gcGuide.startPoints) throw new Error("Nichts zum Wiederherstellen");
    await saveColor({ index: gcGuide.colorIndex, field: "grayCurve.points", value: structuredClone(gcGuide.startPoints) });
    colorChanged();
    return gcSet({ restored: true });
  }
  if (!gcGuide.active) throw new Error("Die Graukurven-Kalibrierung läuft nicht");
  if (action === "answer") return gcAnswer(body);
  if (action === "compare") return gcCompare(body.show);
  if (action === "remeasure") { await gcRestoreAfter(); return gcGo(gcGuide.index); }
  if (action === "neutral" || action === "skip") {
    await gcRestoreAfter();
    const level = gcGuide.levels[gcGuide.index];
    const r = gcGuide.results[level] ?? { before: GrayCal.gainsAt(gcGuide.startPoints ?? [], level).map((v) => Math.round(v * 100) / 100), answers: 0 };
    gcSet({ results: { ...gcGuide.results, [level]: { ...r, [gcGuide.round === "control" ? "control" : "verdict"]: action } }, showing: "after" });
    return gcNext();
  }
  if (action === "back") {
    await gcRestoreAfter();
    if (gcGuide.index > 0) return gcGo(gcGuide.index - 1);
    if (gcGuide.round === "control") { gcSet({ round: "measure" }); return gcGo(gcGuide.levels.length - 1); }
    return gcGo(0);
  }
  if (action === "finish") { await gcRestoreAfter(); return gcFinish(); }
  throw new Error("Unbekannte Aktion");
}

// --- gray curve memory slot per grabber: the slot in use is remembered for the grabber Hyperion
// uses; when Hyperion switches to a known grabber, its slot is loaded. A new grabber keeps the
// curve as it is (and so gets the slot in use). Kept in state.grayCurveByGrabber (device -> slot id
// or "default"). Checked with the other grabber states every few seconds.
const sortedCurve = (s) => (s ? { saturationLimit: s.saturationLimit, points: [...(s.points ?? [])].sort((a, b) => a.level - b.level) } : null);
const sameCurve = (a, b) => !!a && !!b && JSON.stringify(sortedCurve(grayCurveSettings(a))) === JSON.stringify(sortedCurve(grayCurveSettings(b)));

async function curveSlots() {
  const list = (state.testPresets?.grayCurve ?? []).map((p) => ({ id: p.id, name: p.name, settings: p.settings }));
  try {
    const d = (await readHyperionDefaults()).color;
    if (d && "grayCurve.points" in d) list.unshift({ id: "default", name: "Standard", settings: { saturationLimit: d["grayCurve.saturationLimit"], points: d["grayCurve.points"] } });
  } catch {}
  return list;
}

async function syncCurveSlot() {
  if (gcGuide.active) return;
  const device = selectedGrabber();
  if (!device || !readToken()) return;
  const curve = readInstanceSetting("color")?.channelAdjustment?.[0]?.grayCurve;
  if (!curve) return;
  const slots = await curveSlots();
  const last = state.curveGrabber;
  if (device !== last) {
    state = sanitize({ ...state, curveGrabber: device });
    saveState();
  }
  if (last && device !== last) {
    const want = slots.find((s) => s.id === state.grayCurveByGrabber?.[device]);
    if (want && !sameCurve(curve, want.settings)) {
      await saveColor({ index: 0, batch: [{ field: "grayCurve.saturationLimit", value: want.settings.saturationLimit }, { field: "grayCurve.points", value: want.settings.points }] });
      colorChanged();
      addNotice("gcSlotLoaded", "info", { name: Report.displayName(device), slot: want.name }, "card-gcc");
      return;
    }
    // a grabber without a slot of its own keeps the curve of the one before
    if (!want) addNotice("gcNewGrabber", "info", { name: Report.displayName(device), slot: slots.find((s) => sameCurve(curve, s.settings))?.name ?? "" }, "card-color");
  }
  const match = slots.find((s) => sameCurve(curve, s.settings));
  if (match && state.grayCurveByGrabber?.[device] !== match.id) {
    state = sanitize({ ...state, grayCurveByGrabber: { ...state.grayCurveByGrabber, [device]: match.id } });
    saveState();
    broadcast();
  }
}
setInterval(() => syncCurveSlot().catch((err) => console.warn("gray curve slot per grabber:", err.message)), 4000);

// --- Hyperion settings for black-border and gray-still-image detection (instance 0) ---

const BB_MODES = ["default", "classic", "osd", "letterbox"];

function readInstanceSetting(type, instance = 0) {
  const db = new DatabaseSync(HYPERION_DB, HYPERION_DB_READ);
  try {
    const row = db.prepare("SELECT config FROM settings WHERE type = ? AND hyperion_inst = ?").get(type, instance);
    if (!row) throw new Error(`Einstellung ${type} nicht gefunden`);
    return JSON.parse(row.config);
  } finally {
    db.close();
  }
}

// Applies a partial change with the value ranges of schema-blackborderdetector.json
function mergeBlackborder(current, patch) {
  const next = structuredClone(current);
  if ("enable" in patch) next.enable = patch.enable === true;
  if ("mode" in patch) {
    if (!BB_MODES.includes(patch.mode)) throw new Error("Unbekannter Modus");
    next.mode = patch.mode;
  }
  if ("threshold" in patch) next.threshold = num(patch.threshold, 0, 100, next.threshold);
  // frame counters: the schema has no upper limit, the cap only guards against typos
  if ("unknownFrameCnt" in patch) next.unknownFrameCnt = num(patch.unknownFrameCnt, 0, 100000, next.unknownFrameCnt);
  if ("borderFrameCnt" in patch) next.borderFrameCnt = num(patch.borderFrameCnt, 0, 100000, next.borderFrameCnt);
  if ("maxInconsistentCnt" in patch) next.maxInconsistentCnt = num(patch.maxInconsistentCnt, 0, 100000, next.maxInconsistentCnt);
  if ("blurRemoveCnt" in patch) next.blurRemoveCnt = num(patch.blurRemoveCnt, 0, 100, next.blurRemoveCnt);
  const gp = patch.grayStillImageDetector;
  if (gp) {
    const g = { ...(next.grayStillImageDetector ?? {}) };
    if ("enabled" in gp) g.enabled = gp.enabled === true;
    if ("stillTimeSeconds" in gp) g.stillTimeSeconds = num(gp.stillTimeSeconds, 1, 60, g.stillTimeSeconds ?? 5);
    if ("brightnessDropThreshold" in gp) g.brightnessDropThreshold = num(gp.brightnessDropThreshold, 0, 255, g.brightnessDropThreshold ?? 40);
    if ("dropWindowSeconds" in gp) g.dropWindowSeconds = num(gp.dropWindowSeconds, 0.2, 5, g.dropWindowSeconds ?? 1, 0.1);
    if ("changeThreshold" in gp) g.changeThreshold = num(gp.changeThreshold, 0, 64, g.changeThreshold ?? 6);
    // fork: depth of the evaluated edge frame in percent, 0 = the LED areas
    if ("edgeWidthPercent" in gp) g.edgeWidthPercent = num(gp.edgeWidthPercent, 0, 20, g.edgeWidthPercent ?? 0);
    if ("mode" in gp) {
      if (!["freeze", "off"].includes(gp.mode)) throw new Error("Unbekannte Reaktion");
      g.mode = gp.mode;
    }
    next.grayStillImageDetector = g;
  }
  return next;
}

// Every change to Hyperion reads a whole settings block, changes one value and writes the block
// back. Two saves running at the same time would both start from the old block and the later one
// would undo the earlier one, so they run one after the other.
let hyperionQueue = Promise.resolve();
function exclusive(task) {
  const run = hyperionQueue.then(task, task);
  hyperionQueue = run.catch(() => {});
  return run;
}

// one authorized JSON-API command (system commands, the RGB wizard's color)
const RGB_WIZARD_PRIORITY = 1;
let rgbWizard = false; // the RGB byte order wizard shows its colors on the LEDs
function setRgbWizard(on) {
  if (rgbWizard === on) return;
  rgbWizard = on;
  broadcast();
}
async function hyperionCommand(cmd) {
  const api = await openHyperion();
  try {
    await loginHyperion(api);
    const reply = await api.call(cmd);
    if (!reply.success) throw new Error(`Hyperion: ${reply.error ?? "Befehl fehlgeschlagen"}`);
    return reply;
  } finally {
    api.close();
  }
}

// Writes one whole settings block of instance 0 and returns what Hyperion stored
// The black threshold of the LED device: only its own fields are changed in the freshly read device setting
async function saveBlackThreshold(patch) {
  return exclusive(async () => {
    const device = readInstanceSetting("device");
    const current = device.blackThreshold ?? { enabled: true, threshold: 0.5 };
    const next = {
      enabled: patch?.enabled === undefined ? current.enabled !== false : patch.enabled === true,
      threshold: patch?.threshold === undefined ? num(current.threshold, 0, 10, 0.5, 0.05) : num(patch.threshold, 0, 10, 0.5, 0.05),
    };
    if (next.enabled === (current.enabled !== false) && next.threshold === current.threshold) return current;
    return (await writeInstanceSetting("device", { ...device, blackThreshold: next })).blackThreshold;
  });
}

async function writeInstanceSetting(type, next) {
  const api = await openHyperion();
  try {
    await loginHyperion(api);
    const reply = await api.call({ command: "config", subcommand: "setconfig", config: { instances: [{ id: 0, settings: { [type]: next } }] } });
    if (!reply.success) {
      const details = Array.isArray(reply.errorData) ? reply.errorData.map((e) => e.description ?? e).join("; ") : "";
      throw new Error(`Hyperion: ${reply.error ?? "Speichern fehlgeschlagen"}${details ? ` (${details})` : ""}`);
    }
  } finally {
    api.close();
  }
  return readInstanceSetting(type);
}

function saveBlackborder(patch) {
  return exclusive(() => writeInstanceSetting("blackborderdetector", mergeBlackborder(readInstanceSetting("blackborderdetector"), patch)));
}

// Fields the page may change, with the ranges of schema-color.json (fork extensions included).
// Paths: plain = channelAdjustment entry, "grayCurve.point.*" = one point of the gray curve (patch.stop is its index), "grayCurve.points" = all points
// at once (the graph: one drag or a new/removed point is one save)
const COLOR_FIELDS = {
  white: ["rgb"], red: ["rgb"], green: ["rgb"], blue: ["rgb"], cyan: ["rgb"], magenta: ["rgb"], yellow: ["rgb"],
  brightness: ["num", 0, 100, 1],
  saturationGain: ["num", 0, 10, 0.1],
  backlightThreshold: ["num", 0, 100, 1],
  backlightColored: ["bool"],
  gammaRed: ["num", 0.1, 100, 0.05],
  gammaGreen: ["num", 0.1, 100, 0.05],
  gammaBlue: ["num", 0.1, 100, 0.05],
  temperature: ["num", 1000, 40000, 100],
  "grayCurve.enabled": ["bool"],
  "grayCurve.saturationLimit": ["num", 0.01, 1, 0.01],
  "grayCurve.point.level": ["num", 0, 100, 1],
  "grayCurve.point.gainRed": ["num", 0, 2, 0.01],
  "grayCurve.point.gainGreen": ["num", 0, 2, 0.01],
  "grayCurve.point.gainBlue": ["num", 0, 2, 0.01],
  "grayCurve.points": ["points"],
  // fork: LED means with fractions for the 16-bit output (top level of the color settings)
  fractionalMean: ["bool"],
  // fork: capture depth of the LED areas in percent, 0 = the layout
  "ledAreaDepth.topBottom": ["num", 0, 50, 0.5],
  "ledAreaDepth.leftRight": ["num", 0, 50, 0.5],
};

// patch = { index, field, value, stop? }: one field per save, so a half-typed value never reaches Hyperion
function mergeColor(current, patch) {
  const next = structuredClone(current);
  const spec = COLOR_FIELDS[patch.field];
  if (!spec) throw new Error("Unbekanntes Farbfeld");
  const entry = next.channelAdjustment?.[Number(patch.index ?? 0)];
  if (!entry) throw new Error("Farbeintrag nicht gefunden");
  const { field, value } = patch;
  let target = entry;
  let key = field;
  if (field === "fractionalMean") {
    if (!("fractionalMean" in next)) throw new Error("Der Mittelwert mit Nachkommastellen braucht die neue Hyperion-Version");
    target = next;
  } else if (field.startsWith("ledAreaDepth.")) {
    if (!next.ledAreaDepth) throw new Error("Die Erfassungstiefe braucht die neue Hyperion-Version");
    target = next.ledAreaDepth;
    key = field.split(".")[1];
  } else if (field.startsWith("grayCurve.point.")) {
    const point = entry.grayCurve?.points?.[Number(patch.stop)];
    if (!point) throw new Error("Punkt nicht gefunden");
    target = point;
    key = field.split(".")[2];
  } else if (field.startsWith("grayCurve.")) {
    target = entry.grayCurve;
    key = field.split(".")[1];
  }
  if (!target) throw new Error("Einstellung fehlt in Hyperion");

  const [kind, min, max, step] = spec;
  if (kind === "rgb") {
    const rgb = Array.isArray(value) ? value.map(Number) : [];
    if (rgb.length !== 3 || rgb.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) throw new Error("RGB braucht drei Werte von 0 bis 255");
    target[key] = rgb;
  } else if (kind === "bool") {
    target[key] = value === true;
  } else if (kind === "points") {
    // 1-12 points like in the graph, two points never share a brightness (Hyperion sorts them)
    if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error("Die Graukurve braucht 1 bis 12 Punkte");
    const points = value.map((p) => ({
      level: num(p?.level, 0, 100, NaN, 1),
      gainRed: num(p?.gainRed, 0, 2, NaN, 0.01),
      gainGreen: num(p?.gainGreen, 0, 2, NaN, 0.01),
      gainBlue: num(p?.gainBlue, 0, 2, NaN, 0.01),
    }));
    if (points.some((p) => Object.values(p).some((v) => !Number.isFinite(v)))) throw new Error("Ungültiger Graukurven-Punkt");
    if (new Set(points.map((p) => p.level)).size !== points.length) throw new Error("Zwei Punkte mit derselben Helligkeit");
    target[key] = points;
  } else {
    target[key] = num(value, min, max, target[key], step);
  }
  return next;
}

// patch.batch = several fields in one write (reset of a group to the standard values)
// patch.step = id of a graph drag: all live saves of one drag are one undo step of the gray curve
function saveColor(patch) {
  return exclusive(async () => {
    const current = readInstanceSetting("color");
    const next = Array.isArray(patch.batch)
      ? patch.batch.reduce((cfg, f) => mergeColor(cfg, { ...f, index: patch.index }), current)
      : mergeColor(current, patch);
    const index = Number(patch.index ?? 0);
    const before = curvePointsOf(current, index);
    const written = await writeInstanceSetting("color", next);
    recordCurveStep(index, before, curvePointsOf(written, index), patch.step);
    return written;
  });
}

// Undo/redo of the gray curve points, per color entry: every write from this page that changes the
// points keeps the points before it. In its own file, so it survives a restart and every device
// undoes the same steps (a point moved by accident on the phone can be undone at the PC).
const CURVE_HISTORY_FILE = path.join(DATA_DIR, "graycurve-history.json");
const CURVE_HISTORY_MAX = 50;
let curveHistory = loadCurveHistory();

function loadCurveHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(CURVE_HISTORY_FILE, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function saveCurveHistory() {
  const tmp = CURVE_HISTORY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(curveHistory));
  fs.renameSync(tmp, CURVE_HISTORY_FILE);
}

const curvePointsOf = (color, index) => structuredClone(color?.channelAdjustment?.[index]?.grayCurve?.points ?? null);
const curveHistoryOf = (index) => (curveHistory[index] ??= { undo: [], redo: [], step: null });
const curveHistoryInfo = (index) => ({ undo: curveHistory[index]?.undo.length ?? 0, redo: curveHistory[index]?.redo.length ?? 0 });

function recordCurveStep(index, before, after, step) {
  if (!before || JSON.stringify(before) === JSON.stringify(after)) return;
  const h = curveHistoryOf(index);
  const id = step ? String(step) : null;
  // the following saves of the same drag only move the points further, the step keeps its start
  if (!id || id !== h.step) {
    h.undo.push(before);
    if (h.undo.length > CURVE_HISTORY_MAX) h.undo.shift();
  }
  h.step = id;
  h.redo = [];
  saveCurveHistory();
}

// dir "undo" or "redo": writes the points of that step, the current points go onto the other stack
function curveHistoryMove(index, dir) {
  return exclusive(async () => {
    const h = curveHistoryOf(index);
    const [from, to] = dir === "undo" ? [h.undo, h.redo] : [h.redo, h.undo];
    if (!from.length) throw new Error(dir === "undo" ? "Nichts zum Zurücknehmen" : "Nichts zum Wiederherstellen");
    const current = readInstanceSetting("color");
    const entry = current.channelAdjustment?.[index];
    if (!entry?.grayCurve) throw new Error("Graukurve fehlt in Hyperion");
    const now = curvePointsOf(current, index);
    const next = structuredClone(current);
    next.channelAdjustment[index].grayCurve.points = structuredClone(from.at(-1));
    const written = await writeInstanceSetting("color", next);
    from.pop();
    if (now) to.push(now);
    h.step = null;
    saveCurveHistory();
    return { color: written, history: curveHistoryInfo(index) };
  });
}

// Standard values from Hyperion's own schema ("config getschema"), for the placeholders of empty
// fields and the reset buttons: per page field name, like COLOR_FIELDS and the black border fields
let hyperionDefaults = null;
async function readHyperionDefaults() {
  if (hyperionDefaults) return hyperionDefaults;
  const reply = await hyperionCommand({ command: "config", subcommand: "getschema" });
  const props = reply.info?.properties ?? {};
  const c = props.color?.properties ?? {};
  const entry = c.channelAdjustment?.items?.properties ?? {};
  const sub = (o, k) => o?.properties?.[k];
  const color = {};
  for (const field of Object.keys(COLOR_FIELDS)) {
    const [head, mid, last] = field.split(".");
    let node;
    if (field === "fractionalMean") node = c.fractionalMean;
    else if (head === "ledAreaDepth") node = sub(c[head], mid);
    else if (mid === "point") node = sub(sub(entry.grayCurve, "points")?.items, last);
    else if (head === "grayCurve") node = sub(entry[head], mid);
    else node = entry[field];
    if (node && "default" in node) color[field] = node.default;
  }
  const bbProps = props.blackborderdetector?.properties ?? {};
  const blackborder = {};
  for (const [k, v] of Object.entries(bbProps)) {
    if ("default" in v) blackborder[k] = v.default;
    for (const [k2, v2] of Object.entries(v.properties ?? {})) if ("default" in v2) blackborder[`${k}.${k2}`] = v2.default;
  }
  hyperionDefaults = { color, blackborder };
  return hyperionDefaults;
}

// Builds the same structure as Hyperion's own export ("config getconfig") from a DB backup
// --- Status of the test server, Hyperion and the tests (card "Testserver") ---
const SERVER_STARTED = Date.now();
async function testServerStatus() {
  const roles = [...clients.values()];
  const safe = (f) => { try { return f(); } catch { return null; } };
  const bb = safe(() => readInstanceSetting("blackborderdetector"));
  const color = safe(() => readInstanceSetting("color"));
  const smoothing = safe(() => readInstanceSetting("smoothing"));
  const grabberTestSetting = safe(() => readGlobalSetting("grabberTest"));
  const entry = color?.channelAdjustment?.[0];
  const guarded = new Set(Object.keys(loadGuard().entries).map((k) => k.replace(/\d+$/, "").replace(/^depth(topBottom|leftRight)$/, "depth")));
  const depth = color?.ledAreaDepth;
  const feature = (key, label, on, detail) => ({ key, label, on, detail: detail ?? null, guarded: guarded.has(key) });
  return {
    server: { startedAt: SERVER_STARTED, port: PORT },
    hyperion: await hyperionStatus(),
    clients: { tv: roles.filter((r) => r === "tv").length, phone: roles.filter((r) => r === "phone").length },
    monitor: { connected: !!monitor, debugOk: !!lastDebug?.ok, debugAt: lastDebug?.at ?? null, preview: !!monitor?.imageStreaming },
    features: bb && color ? [
      feature("blackborder", "Schwarzbalken-Erkennung", bb.enable === true),
      feature("grayStill", "Graues-Standbild-Erkennung", bb.grayStillImageDetector?.enabled === true),
      feature("backlight", "Hintergrundbeleuchtung", (color.channelAdjustment ?? []).some((a) => Number(a.backlightThreshold) > 0), entry ? String(entry.backlightThreshold) : null),
      feature("signal", "No-Signal-Erkennung des Grabbers", grabberTestSetting?.noSignal?.enable === true),
      feature("depth", "Erfassungstiefe", !!depth && (Number(depth.topBottom) > 0 || Number(depth.leftRight) > 0), depth ? `${depth.topBottom} % / ${depth.leftRight} %` : null),
      feature("smoothing", "Glättung", smoothing?.enable === true, smoothing ? `${smoothing.time_ms} ms` : null),
      feature("correction", "Grabber-Farbkorrektur", grabberCorrection.enable),
      feature("fractional", "LED-Mittelwert mit Nachkommastellen", color.fractionalMean === true),
      feature("grayCurve", "Graukurve", entry?.grayCurve?.enabled === true),
      feature("layoutFix", "LED-Layout-Korrektur", layoutFixInfo.corrected),
    ] : [],
    guard: { enabled: state.testGuard, ...guardInfo },
  };
}

// --- Test guard ---
// While a test runs, Hyperion features that would falsify it are switched off for the time of the
// test and restored afterwards: the gray still detection would dim or freeze the LEDs on a still test
// picture, the black border detection takes dark test pictures or the frame of the position test for
// bars, a backlight lights LEDs that should stay dark, a deep capture depth lets the position marker
// reach neighbouring LEDs and the grabber's signal detection takes a dark test picture for "no
// signal". A feature a running test
// is about stays as it is (black bars test: black border detection, gray still test: gray still
// detection, depth test: capture depth). testguard.json keeps the original values, so a restart
// of this server still restores them; a value changed by hand during the test is left as it is.
const GUARD_FILE = path.join(DATA_DIR, "testguard.json");
const GUARD_DEPTH = { topBottom: 3, leftRight: 2 };
let guardInfo = { applied: [] };

// what the tests on the TV now ask for: { key: { type, path, value, label } }
function guardWanted(entries = {}) {
  if (!state.testGuard) return {};
  const tests = [];
  const shownColor = state.colorActive !== false;
  const pattern = ["grayTest", "depthTest", "fracTest", "posTest"].some((t) => state[t]?.active) || state.posGuide?.active;
  if (state.grayTest?.active) tests.push("gray");
  if (state.depthTest?.active) tests.push("depth");
  if (state.fracTest?.active) tests.push("frac");
  if (state.posTest?.active || state.posGuide?.active) tests.push("pos");
  if (Object.values(state.bars ?? {}).some((v) => v > 0)) tests.push("bars");
  if (shownColor && !pattern) tests.push("color");
  // the gray of the gray curve calibration is a full screen test color
  if (gcGuide.active && !tests.includes("color")) tests.push("color");
  if (!tests.length) return {};
  const off = new Set();
  for (const t of tests) for (const f of state.guardRules?.[t] ?? DEFAULT_GUARD_RULES[t]) off.add(f);
  // what a running test is about stays as it is
  for (const t of tests) for (const f of GUARD_FIXED[t] ?? []) off.delete(f);

  const want = {};
  let color = null;
  try { color = readInstanceSetting("color"); } catch {}
  if (off.has("blackborder")) want.blackborder = { type: "blackborderdetector", path: ["enable"], value: false, label: "Schwarzbalken-Erkennung" };
  if (off.has("grayStill")) want.grayStill = { type: "blackborderdetector", path: ["grayStillImageDetector", "enabled"], value: false, label: "Graues-Standbild-Erkennung" };
  // a test picture must never count as "no signal" and switch the LEDs off
  if (off.has("signal")) want.signal = { type: "grabberTest", global: true, path: ["noSignal", "enable"], value: false, label: "No-Signal-Erkennung des Grabbers" };
  if (off.has("backlight")) (color?.channelAdjustment ?? []).forEach((_, i) => {
    want["backlight" + i] = { type: "color", path: ["channelAdjustment", i, "backlightThreshold"], value: 0, label: "Hintergrundbeleuchtung" };
  });
  if (off.has("depth") && color?.ledAreaDepth) for (const k of ["topBottom", "leftRight"]) {
    // judged by the value before the test (the setting may already be the guard's own)
    const key = "depth" + k;
    const v = Number(entries[key] ? entries[key].original : color.ledAreaDepth[k]) || 0;
    // 0 = the layout's depth, deeper than the standard of the test
    if (v === 0 || v > GUARD_DEPTH[k]) want[key] = { type: "color", path: ["ledAreaDepth", k], value: GUARD_DEPTH[k], label: `Erfassungstiefe (${GUARD_DEPTH.topBottom} % / ${GUARD_DEPTH.leftRight} %)` };
  }
  return want;
}

const getPath = (obj, p) => p.reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj, p, v) {
  const parent = getPath(obj, p.slice(0, -1));
  if (parent && typeof parent === "object") parent[p[p.length - 1]] = v;
}
function loadGuard() {
  try { return JSON.parse(fs.readFileSync(GUARD_FILE, "utf8")); } catch { return { entries: {} }; }
}
function saveGuard(g) {
  if (!Object.keys(g.entries).length) { fs.rmSync(GUARD_FILE, { force: true }); return; }
  const tmp = GUARD_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(g));
  fs.renameSync(tmp, GUARD_FILE);
}

// Brings Hyperion in line with guardWanted(): restores what is no longer needed, switches off what
// is new; one write per settings block. Without a Hyperion login nothing can be written.
async function syncGuard() {
  const g = loadGuard();
  const want = guardWanted(g.entries);
  const configs = {};
  const globals = new Set();
  const read = (type, global) => {
    if (global) globals.add(type);
    return (configs[type] ??= global ? readGlobalSetting(type) : readInstanceSetting(type));
  };
  const changed = new Set();
  for (const [key, e] of Object.entries(g.entries)) {
    if (want[key] && JSON.stringify(want[key].path) === JSON.stringify(e.path)) continue;
    const cfg = read(e.type, e.global);
    // only if it still has our value; a value changed by hand during the test stays
    if (JSON.stringify(getPath(cfg, e.path)) === JSON.stringify(e.value)) { setPath(cfg, e.path, e.original); changed.add(e.type); }
    delete g.entries[key];
  }
  for (const [key, w] of Object.entries(want)) {
    if (g.entries[key]) continue;
    const cfg = read(w.type, w.global);
    const current = getPath(cfg, w.path);
    if (current === undefined || JSON.stringify(current) === JSON.stringify(w.value)) continue;
    g.entries[key] = { ...w, original: current };
    setPath(cfg, w.path, w.value);
    changed.add(w.type);
  }
  if (changed.size) {
    if (!readToken()) throw new Error("Nicht mit Hyperion verbunden");
    for (const type of changed) {
      if (globals.has(type)) await writeGlobalSetting(type, configs[type]);
      else await writeInstanceSetting(type, configs[type]);
    }
  }
  saveGuard(g);
  guardInfo = { applied: [...new Set(Object.values(g.entries).map((e) => e.label))] };
  if (changed.size) broadcast();
}

let guardTimer = null;
function scheduleGuard() {
  clearTimeout(guardTimer);
  guardTimer = setTimeout(() => {
    exclusive(syncGuard).catch((err) => {
      guardInfo = { ...guardInfo, error: err.message };
      broadcast();
    });
  }, 400);
}

// --- connection loss ---
// When the last control page is gone while something is shown on the TV, the TV warns with a
// countdown. If no page comes back in time, the tests are paused: the TV shows nothing, the settings
// the tests switched off in Hyperion are restored, the guided calibration is dropped. The test
// server itself keeps running, so a page can always connect again (the QR code on the TV).
// The basic grabber test is no reason: it runs on the server while the phone is off.
const GRACE_MS = Number(process.env.GRACE_MS) || 30000;
let graceUntil = 0;
let graceTimer = null;
let paused = {}; // test -> true: paused by a connection loss, the control page marks its card

function shownTests() {
  const keys = [];
  for (const k of ["grayTest", "depthTest", "fracTest", "posTest"]) if (state[k]?.active) keys.push(k);
  if (state.posGuide?.active) keys.push("posGuide");
  if (gcGuide.active) keys.push("gcGuide");
  if (state.colorActive !== false) keys.push("color");
  if (Object.values(state.bars ?? {}).some((v) => v > 0)) keys.push("bars");
  return keys;
}
const overlaysOnTv = () => ["bbTv", "gsTv", "dpTv"].some((k) => state.overlays?.[k]);

function updateGrace() {
  clearTimeout(graceTimer);
  graceTimer = null;
  const shown = shownTests().length > 0 || overlaysOnTv();
  if (phoneCount() > 0 || !shown) {
    if (graceUntil) { graceUntil = 0; broadcast(); }
    return;
  }
  if (grabberRun.running) {
    if (graceUntil) { graceUntil = 0; broadcast(); }
    graceTimer = setTimeout(updateGrace, 5000);
    return;
  }
  if (!graceUntil) { graceUntil = Date.now() + GRACE_MS; broadcast(); }
  graceTimer = setTimeout(pauseTests, Math.max(0, graceUntil - Date.now()) + 50);
}

function pauseTests() {
  graceTimer = null;
  if (phoneCount() > 0 || grabberRun.running) return updateGrace();
  const keys = shownTests();
  graceUntil = 0;
  paused = Object.fromEntries(keys.map((k) => [k, true]));
  const off = (t) => ({ ...state[t], active: false });
  state = sanitize({
    ...state,
    grayTest: off("grayTest"), depthTest: off("depthTest"), fracTest: off("fracTest"), posTest: off("posTest"),
    posGuide: { active: false, round: "measure", points: [], step: 0, answers: {}, done: false, cursor: 0 },
    colorActive: false,
    bars: { top: 0, bottom: 0, left: 0, right: 0 },
    overlays: { ...state.overlays, bbTv: false, gsTv: false, dpTv: false },
  });
  saveState();
  gcStop(true).catch(() => {});
  console.log(`No control page for ${GRACE_MS / 1000} s: paused ${keys.join(", ") || "overlays"}`);
  addNotice("paused", "critical", { tests: keys }, keys.length ? "" : "card-ts");
  // a color of the RGB wizard stays on the LEDs without the page that alternates it
  hyperionCommand({ command: "clear", priority: RGB_WIZARD_PRIORITY }).catch(() => {});
  rgbWizard = false;
  broadcast();
  scheduleGuard();
}

// --- LED layout correction (guided position test) ---
// layoutfix.json keeps the layout as it was before the first correction (base), the offsets now
// applied to it, the ones before (one step back) and the layout written, to notice changes made
// elsewhere (WebUI): if Hyperion's layout is neither the written nor the base one, it becomes the
// new base.
const LAYOUT_FIX_FILE = path.join(DATA_DIR, "layoutfix.json");
let layoutFixInfo = { corrected: false, hasPrevious: false, savedAt: 0, stamp: 0 };

function loadLayoutFix() {
  try { return JSON.parse(fs.readFileSync(LAYOUT_FIX_FILE, "utf8")); } catch { return null; }
}
function saveLayoutFix(fix) {
  const tmp = LAYOUT_FIX_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(fix));
  fs.renameSync(tmp, LAYOUT_FIX_FILE);
}
// the stored correction only counts while Hyperion still has the layout written with it
function currentLayoutFix() {
  const live = readInstanceSetting("leds");
  let fix = loadLayoutFix();
  if (fix && !sameLayout(live, fix.applied) && !sameLayout(live, fix.base)) fix = null;
  if (fix && sameLayout(live, fix.base)) fix = { ...fix, offsets: null, applied: fix.base };
  return { live, fix };
}
function refreshLayoutFixInfo() {
  try {
    const { fix } = currentLayoutFix();
    layoutFixInfo = { corrected: !!fix?.offsets, hasPrevious: !!(fix?.offsets && fix.previous), savedAt: fix?.savedAt ?? 0, stamp: layoutFixInfo.stamp };
  } catch {
    layoutFixInfo = { ...layoutFixInfo, corrected: false, hasPrevious: false };
  }
}

async function writeLayout(fix, offsets) {
  const runs = layoutRuns(fix.base);
  const next = offsets ? correctedLeds(fix.base, runs, offsets) : fix.base;
  makeBackup();
  const written = await writeInstanceSetting("leds", next);
  saveLayoutFix({ ...fix, offsets, applied: written, savedAt: Date.now() });
  layoutFixInfo = { corrected: !!offsets, hasPrevious: !!(offsets && fix.previous), savedAt: Date.now(), stamp: Date.now() };
  broadcast();
  return layoutFixInfo;
}

// apply: answers measured on Hyperion's layout as it is now; on a corrected layout they add up
function layoutFixAction(action, answers) {
  return exclusive(async () => {
    const { live, fix: current } = currentLayoutFix();
    const fix = current ?? { base: live, offsets: null, previous: null };
    if (action === "apply") {
      if (!answers || typeof answers !== "object") throw new Error("Keine Antworten");
      const runs = layoutRuns(fix.base);
      if (live.length !== fix.base.length) throw new Error("Die LED-Anzahl hat sich geändert");
      const clean = Object.fromEntries(Object.entries(answers).map(([i, v]) => [i, v === null ? null : num(v, -MAX_ANSWER, MAX_ANSWER, 0)]));
      const residual = offsetsFromAnswers(live.length, runs, clean);
      const offsets = fix.offsets ? composeOffsets(fix.offsets, residual, runs) : residual;
      return writeLayout({ ...fix, previous: fix.offsets ?? null }, offsets);
    }
    if (action === "undo") return writeLayout({ ...fix, previous: null }, fix.previous ?? null);
    if (action === "restore") return writeLayout({ ...fix, previous: null }, null);
    throw new Error("Unbekannte Aktion");
  });
}

function configFromBackup(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const parse = (row) => JSON.parse(row.config);
    const globalSettings = {};
    for (const row of db.prepare("SELECT type, config FROM settings WHERE hyperion_inst IS NULL").all()) {
      globalSettings[row.type] = parse(row);
    }
    const instances = db
      .prepare("SELECT instance, friendly_name, enabled FROM instances ORDER BY instance")
      .all()
      .map((inst) => {
        const settings = {};
        for (const row of db.prepare("SELECT type, config FROM settings WHERE hyperion_inst = ?").all(inst.instance)) {
          settings[row.type] = parse(row);
        }
        return { id: inst.instance, name: inst.friendly_name, enabled: inst.enabled === 1, settings };
      });
    if (!Object.keys(globalSettings).length || !instances.length) throw new Error("Backup enthält keine vollständige Konfiguration");
    const uuid = db.prepare("SELECT uuid FROM meta").get()?.uuid;
    return {
      global: { ...(uuid ? { uuid } : {}), settings: globalSettings },
      instanceIds: instances.map((i) => i.id),
      instances,
    };
  } finally {
    db.close();
  }
}

async function restoreBackup(name) {
  const file = path.join(BACKUP_DIR, path.basename(name));
  if (!name || !fs.existsSync(file)) throw new Error("Backup nicht gefunden");
  const config = configFromBackup(file);

  const api = await openHyperion();
  try {
    await loginHyperion(api);
    // keep the current state, so a restore can always be undone
    const safety = makeBackup();
    const reply = await api.call({ command: "config", subcommand: "restoreconfig", config }, 30_000);
    if (!reply.success) {
      const details = Array.isArray(reply.errorData) ? reply.errorData.map((e) => e.description ?? e).join("; ") : "";
      throw new Error(`Hyperion: ${reply.error ?? "Wiederherstellen fehlgeschlagen"}${details ? ` (${details})` : ""}`);
    }
    return { restored: path.basename(name), safety };
  } finally {
    api.close();
  }
}

// --- Login with the Hyperion password ---
// Like the Hyperion WebUI: as long as Hyperion has its default password the page is open; with a password
// of its own every device logs in once with it (Hyperion checks it, nothing is stored here) and stays
// logged in (session cookie). The TV page only shows what it is told and stays open, with the few
// read-only things it needs. The WebUI sends its own Hyperion login (X-Hyperion-Token) instead.
const SESSION_FILE = path.join(DATA_DIR, "sessions.json");
const SESSION_COOKIE = "tvtest-session";
const SESSION_MAX_AGE_S = 365 * 24 * 3600;
const AUTH_OPEN_PATHS = new Set(["/tv", "/login", "/api/login", "/api/qr.svg", "/api/hyperion/leds", "/api/hyperion/color", "/api/media/caps", "/api/media/tvstatus"]);
const AUTH_OPEN_PREFIXES = ["/static/", "/media/file/", "/media/src/", "/media/thumb/"];
const hashSession = (token) => createHash("sha256").update(token).digest("hex");
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")) ?? {}; } catch {}
function saveSessions() {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 1), { mode: 0o600 }); } catch (e) { console.error("sessions:", e.message); }
}
const sessionOf = (req) => /(?:^|;\s*)tvtest-session=([\w-]{20,80})/.exec(req.headers.cookie ?? "")?.[1] ?? null;

// whether Hyperion has a password of its own; asked at most every 30 s, the last answer counts while
// Hyperion is not reachable (and before the first answer: locked, to be safe)
async function refreshAuthRequired() {
  if (Date.now() - authCheckedAt < 30_000) return authRequired;
  authCheckedAt = Date.now();
  let api;
  try {
    api = await openHyperion();
    const reply = await api.call({ command: "authorize", subcommand: "newPasswordRequired" });
    if (reply.success) {
      const required = !reply.info?.newPasswordRequired;
      if (required !== authRequired) { authRequired = required; broadcast(); }
    }
  } catch {} finally { api?.close(); }
  return authRequired;
}

// one Hyperion login (password or token) on a connection of its own
async function hyperionAccepts(login) {
  let api;
  try {
    api = await openHyperion();
    return !!(await api.call({ command: "authorize", subcommand: "login", ...login })).success;
  } catch { return false; } finally { api?.close(); }
}
// tokens of the WebUI that Hyperion accepted, for 5 min
const webuiTokens = new Map();
async function webuiTokenValid(token) {
  if (!token || token.length > 200) return false;
  const until = webuiTokens.get(token);
  if (until && until > Date.now()) return true;
  if (!(await hyperionAccepts({ token }))) { webuiTokens.delete(token); return false; }
  webuiTokens.set(token, Date.now() + 5 * 60_000);
  return true;
}

function authOpen(req, url) {
  const p = url.pathname;
  if (AUTH_OPEN_PATHS.has(p) || AUTH_OPEN_PREFIXES.some((x) => p.startsWith(x))) return req.method === "GET" || p.startsWith("/api/media/") || p === "/api/login";
  return req.method === "GET" && p === "/api/events" && url.searchParams.get("role") !== "phone";
}
async function authorized(req, url) {
  if (authOpen(req, url) || !(await refreshAuthRequired())) return true;
  const session = sessionOf(req);
  if (session && sessions[hashSession(session)]) return true;
  return webuiTokenValid(String(req.headers["x-hyperion-token"] ?? ""));
}

let loginFailures = [];
async function handleLogin(req, res) {
  const { password } = await readBody(req);
  // a few tries per minute, then a pause (Hyperion itself does not slow down guessing)
  loginFailures = loginFailures.filter((t) => Date.now() - t < 60_000);
  if (loginFailures.length >= 10) return sendJson(res, 429, { error: "Zu viele Versuche, bitte eine Minute warten." });
  if (typeof password !== "string" || !password || password.length > 200 || !(await hyperionAccepts({ password }))) {
    loginFailures.push(Date.now());
    await new Promise((r) => setTimeout(r, 1000));
    return sendJson(res, 403, { error: "Falsches Passwort" });
  }
  const token = randomBytes(32).toString("base64url");
  sessions[hashSession(token)] = { created: new Date().toISOString(), ua: String(req.headers["user-agent"] ?? "").slice(0, 120) };
  saveSessions();
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_MAX_AGE_S}; Path=/; SameSite=Lax; HttpOnly`);
  return sendJson(res, 200, { ok: true });
}
function handleLogout(req, res) {
  const session = sessionOf(req);
  if (session && sessions[hashSession(session)]) { delete sessions[hashSession(session)]; saveSessions(); }
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly`);
  return sendJson(res, 200, { ok: true });
}

// The Hyperion WebUI (same host, other port) shows the notices and the page commands of the power menu.
// Only a page of the same host may do that; POST needs the header X-Tvtest, which a browser only sends
// after the preflight below, so a page from elsewhere cannot trigger the commands.
function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  try {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (new URL(origin).hostname !== host) return null;
  } catch { return null; }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Tvtest, X-Hyperion-Token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
function needTvtestHeader(req) {
  if (req.headers["x-tvtest"] !== "1") throw new Error("Header X-Tvtest fehlt");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const cors = corsHeaders(req);
  if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.writeHead(cors ? 204 : 403);
    return res.end();
  }

  try {
    if (!(await authorized(req, url))) {
      if (req.method === "GET" && (p === "/" || p.startsWith("/backups/"))) { res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }); return res.end(); }
      return sendJson(res, 401, { error: "Anmeldung nötig", login: true });
    }
    if (req.method === "GET" && p === "/login") return serveStatic(res, "login.html");
    if (req.method === "POST" && p === "/api/login") return handleLogin(req, res);
    if (req.method === "POST" && p === "/api/logout") return handleLogout(req, res);
    if (req.method === "GET" && p === "/") return servePage(req, res, "phone.html");
    if (req.method === "GET" && p === "/tv") return servePage(req, res, "tv.html");
    if (await media.handle(req, res, p, sendJson, readBody)) return;
    if (await sources.handle(req, res, p, sendJson, readBody)) return;
    // the TV page tells what its browser can play and how the shown media is doing
    if (req.method === "POST" && p === "/api/media/caps") {
      needTvtestHeader(req);
      const body = await readBody(req, 5000);
      tvCaps = { ...body, at: Date.now() };
      broadcast();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/media/tvstatus") {
      needTvtestHeader(req);
      const body = await readBody(req, 5000);
      const changed = JSON.stringify({ ...tvMedia, at: 0 }) !== JSON.stringify({ ...body, at: 0 });
      // the TV cannot show it: tell the bell once per item and error
      if (body.error && (body.error !== tvMedia?.error || body.id !== tvMedia?.id)) {
        const it = mediaItemOf(String(body.id ?? ""));
        addNotice("mediaError", "critical", { name: it?.name ?? "", error: String(body.error).slice(0, 200) }, "card-media");
      }
      tvMedia = { ...body, at: Date.now() };
      if (changed) broadcast();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/prefs") {
      needTvtestHeader(req);
      changePrefs(req, (await readBody(req, 50_000)).changes);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && p.startsWith("/static/")) return serveStatic(res, p.slice("/static/".length));

    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, publicState());
    if (req.method === "GET" && p === "/api/presets") return sendJson(res, 200, PRESETS);
    // what the bell of the Hyperion WebUI shows
    if (req.method === "GET" && p === "/api/notices") {
      const lang = url.searchParams.get("lang") === "en" ? "en" : "de";
      const list = notices.map((n) => ({ id: n.id, ts: n.ts, level: n.level, kind: n.kind, ...NoticeText.info(n, lang) }));
      return sendJson(res, 200, { notices: list, health, tvConnected: hasTv(), running: runningCards(), device: hostDevice });
    }
    if (req.method === "POST" && p === "/api/notices") {
      needTvtestHeader(req);
      const { op } = await readBody(req);
      if (op !== "clear") throw new Error("Unbekannter Befehl");
      notices = [];
      try { fs.writeFileSync(NOTICES_FILE, "[]"); } catch {}
      broadcast();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      clients.set(res, url.searchParams.get("role") === "phone" ? "phone" : "tv");
      checkTv();
      updateGrace();
      broadcast(); // also tells the TV that a phone joined
      if (lastDebug) res.write(`event: debug\ndata: ${JSON.stringify(lastDebug)}\n\n`);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
        checkTv();
        updateGrace();
        broadcast();
      });
      return;
    }

    // Grabber preview: a separate event stream, so only phones that show the preview get the frames
    if (req.method === "GET" && p === "/api/preview") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": preview\n\n");
      previewClients.add(res);
      syncImageStream();
      if (latestFrame) res.write(`data: ${latestFrame}\n\n`);
      req.on("close", () => {
        previewClients.delete(res);
        syncImageStream();
      });
      return;
    }

    if (req.method === "GET" && p === "/api/hyperion/blackborder") return sendJson(res, 200, readInstanceSetting("blackborderdetector"));
    if (req.method === "POST" && p === "/api/hyperion/blackborder") {
      const patch = await readBody(req);
      return sendJson(res, 200, await saveBlackborder(patch));
    }

    if (req.method === "GET" && p === "/api/testserver/status") return sendJson(res, 200, await testServerStatus());
    if (req.method === "GET" && p === "/api/hyperion/defaults") return sendJson(res, 200, await readHyperionDefaults());
    // standard settings of the test patterns (the "Standard" button of each test card)
    if (req.method === "GET" && p === "/api/testdefaults") return sendJson(res, 200, DEFAULT_STATE);
    if (req.method === "GET" && p === "/api/hyperion/color") return sendJson(res, 200, readInstanceSetting("color"));

    // Hyperion system commands like the power menu of the WebUI
    // test page and device commands of the power menu: reload the TV page, restart this server (systemd
    // starts it again after a failure exit), restart or shut down the computer
    if (req.method === "POST" && p === "/api/testpage/system") {
      needTvtestHeader(req);
      // rebootPi / poweroffPi: the names older WebUI versions of the fork send
      const body = await readBody(req);
      const action = { rebootPi: "reboot", poweroffPi: "poweroff" }[body.action] ?? body.action;
      if (!["reloadTv", "restartServer", "reboot", "poweroff"].includes(action)) return sendJson(res, 400, { error: "Unbekannter Befehl" });
      if (action === "reboot" || action === "poweroff") {
        if (!hostDevice.power) return sendJson(res, 400, { error: hostDevice.why });
        console.log(`Device ${action} requested from the control page`);
        // systemctl returns once the job is queued, so the answer still gets out
        const result = await runQuiet(...powerCommand(action));
        if (!result.ok) return sendJson(res, 500, { error: `Fehlgeschlagen: ${result.out}` });
        broadcastSystem(action);
        return sendJson(res, 200, { ok: true });
      }
      sendJson(res, 200, { ok: true });
      if (action === "reloadTv") {
        for (const [client, role] of clients) if (role === "tv") client.write("event: reload\ndata: {}\n\n");
      } else {
        console.log("Restart requested from the control page");
        broadcastSystem("server");
        setTimeout(() => process.exit(1), 300);
      }
      return;
    }

    if (req.method === "POST" && p === "/api/testpage/port") {
      needTvtestHeader(req);
      const { port } = await readBody(req);
      return sendJson(res, 200, await changePort(port));
    }

    if (req.method === "POST" && p === "/api/hyperion/system") {
      let { subcommand } = await readBody(req);
      // the former "USB reset + restart" of older pages is the reconnect now
      if (subcommand === "usbResetRestart") subcommand = "grabberUsbReconnect";
      if (!["suspend", "resume", "restart", "grabberUsbReconnect"].includes(subcommand)) return sendJson(res, 400, { error: "Unbekannter Befehl" });
      const usb = subcommand === "grabberUsbReconnect";
      // Hyperion refuses it too, but in English; asked fresh, the grabber may have changed since
      if (usb && monitor) await refreshUsbReset();
      if (usb && usbReset?.possible === false) return sendJson(res, 400, { error: NoticeText.usbWhy(usbReset.whyKey, usbReset.why, "de"), whyKey: usbReset.whyKey, why: usbReset.why });
      // the announcement goes first: Hyperion may close the connection before it answers
      if (subcommand === "restart") broadcastSystem("hyperion");
      await hyperionCommand({ command: "system", subcommand });
      // Hyperion keeps running while it reconnects the grabber (a second or a few): its result goes to the bell
      if (usb) for (const ms of [1500, 4000, 8000]) setTimeout(() => { if (monitor) refreshUsbReset().catch(() => {}); }, ms);
      return sendJson(res, 200, { ok: true });
    }

    // RGB byte order wizard like the WebUI's: Hyperion shows red or green on the LEDs (priority 1),
    // the answers give the new color order of the LED device
    if (req.method === "GET" && p === "/api/hyperion/device") {
      const device = readInstanceSetting("device");
      return sendJson(res, 200, { type: device.type ?? null, colorOrder: device.colorOrder ?? "rgb" });
    }
    // sent by the page when it is left during the wizard (sendBeacon, no body)
    if (req.method === "POST" && p === "/api/hyperion/rgbwizard-clear") {
      setRgbWizard(false);
      await hyperionCommand({ command: "clear", priority: RGB_WIZARD_PRIORITY }).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/hyperion/rgbwizard") {
      const { action, color, colorOrder } = await readBody(req);
      if (action === "color") {
        if (!Array.isArray(color) || color.length !== 3 || !color.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return sendJson(res, 400, { error: "Ungültige Farbe" });
        await hyperionCommand({ command: "color", color, priority: RGB_WIZARD_PRIORITY, origin: "TV-Testseite" });
        setRgbWizard(true);
        return sendJson(res, 200, { ok: true });
      }
      if (action === "clear") {
        setRgbWizard(false);
        await hyperionCommand({ command: "clear", priority: RGB_WIZARD_PRIORITY });
        return sendJson(res, 200, { ok: true });
      }
      if (action === "save") {
        if (typeof colorOrder !== "string" || !/^[rgb]{3}$/.test(colorOrder) || new Set(colorOrder).size !== 3) return sendJson(res, 400, { error: "Ungültige Reihenfolge" });
        const device = await exclusive(() => writeInstanceSetting("device", { ...readInstanceSetting("device"), colorOrder }));
        return sendJson(res, 200, { colorOrder: device.colorOrder });
      }
      return sendJson(res, 400, { error: "Unbekannte Aktion" });
    }
    // LED sampling areas [hmin, hmax, vmin, vmax]: the gray still detector only sees these parts of the picture
    if (req.method === "GET" && p === "/api/layoutfix") { refreshLayoutFixInfo(); return sendJson(res, 200, layoutFixInfo); }
    if (req.method === "POST" && p === "/api/layoutfix") {
      const { action, answers } = await readBody(req);
      return sendJson(res, 200, await layoutFixAction(action, answers));
    }
    if (req.method === "GET" && p === "/api/hyperion/leds") return sendJson(res, 200, readInstanceSetting("leds").map((l) => [l.hmin, l.hmax, l.vmin, l.vmax]));
    // black threshold of the LED device (fork extension), drawn in the gray curve graph
    if (req.method === "GET" && p === "/api/hyperion/blackthreshold") return sendJson(res, 200, readInstanceSetting("device").blackThreshold ?? null);
    if (req.method === "POST" && p === "/api/hyperion/blackthreshold") return sendJson(res, 200, await saveBlackThreshold(await readBody(req)));
    if (req.method === "POST" && p === "/api/hyperion/color") {
      const patch = await readBody(req);
      return sendJson(res, 200, await saveColor(patch));
    }
    if (req.method === "POST" && p === "/api/nosignal/command") return sendJson(res, 200, await noSignalCommand(await readBody(req)));
    if (req.method === "POST" && p === "/api/nosignal/op") {
      // a calibration (grid of the no-signal picture) is about 13 kB
      const { op, args } = await readBody(req, 100_000);
      return sendJson(res, 200, await noSignalOp(op, args));
    }
    if (req.method === "POST" && p === "/api/graycal") {
      await gcAction(await readBody(req));
      return sendJson(res, 200, { gcGuide });
    }
    if (req.method === "GET" && p === "/api/hyperion/graycurve/history") {
      return sendJson(res, 200, curveHistoryInfo(Number(url.searchParams.get("index") ?? 0)));
    }
    if (req.method === "POST" && p === "/api/hyperion/graycurve/history") {
      const { index, dir } = await readBody(req);
      if (dir !== "undo" && dir !== "redo") throw new Error("Unbekannte Richtung");
      return sendJson(res, 200, await curveHistoryMove(Number(index ?? 0), dir));
    }

    // QR code with the phone URL, built from the address the TV used to reach the Pi
    if (req.method === "GET" && p === "/api/qr.svg") {
      const host = /^[\w.:\[\]-]+$/.test(req.headers.host ?? "") ? req.headers.host : `localhost:${PORT}`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
      return res.end(qrSvg(`http://${host}/`));
    }

    if (req.method === "POST" && p === "/api/state") {
      const patch = await readBody(req);
      // another test or a test color takes the TV: the gray curve calibration ends
      if (gcGuide.active && (typeof patch.color === "string" || ["grayTest", "depthTest", "fracTest", "posTest", "posGuide"].some((t) => patch[t]?.active === true))) await gcStop();
      const bars = { ...state.bars, ...(patch.bars ?? {}) };
      // Relative steps are applied here, not on the client, so concurrent key presses cannot overwrite each other
      if (patch.adjust) {
        const { edges, delta } = patch.adjust;
        if (!Array.isArray(edges) || !Number.isFinite(Number(delta))) throw new Error("invalid adjust");
        for (const edge of edges) if (edge in bars) bars[edge] = bars[edge] + Number(delta);
      }
      // Custom colors are changed with add/remove operations, so two devices never overwrite each other's list
      let customColors = state.customColors;
      if (typeof patch.addCustom === "string" && HEX_COLOR.test(patch.addCustom)) {
        const c = patch.addCustom.toLowerCase();
        customColors = [...customColors.filter((x) => x !== c), c];
        if (customColors.length > MAX_CUSTOM_COLORS) throw new Error(`Maximal ${MAX_CUSTOM_COLORS} eigene Farben`);
      }
      if (typeof patch.removeCustom === "string") {
        customColors = customColors.filter((x) => x !== patch.removeCustom.toLowerCase());
      }
      // Preset edits: an override equal to the standard color is dropped again
      let presetColors = { ...state.presetColors };
      if (patch.setPreset && PRESET_IDS.includes(patch.setPreset.id) && HEX_COLOR.test(patch.setPreset.color ?? "")) {
        const { id, color } = patch.setPreset;
        const standard = PRESETS.find((p) => p.id === id).color;
        if (color.toLowerCase() === standard) delete presetColors[id];
        else presetColors[id] = color.toLowerCase();
      }
      if (typeof patch.resetPreset === "string") delete presetColors[patch.resetPreset];
      // a custom color is replaced in place, so its place in the list stays the same
      if (patch.replaceCustom && HEX_COLOR.test(patch.replaceCustom.to ?? "")) {
        const from = String(patch.replaceCustom.from ?? "").toLowerCase();
        const to = patch.replaceCustom.to.toLowerCase();
        customColors = customColors.includes(from)
          ? [...new Set(customColors.map((c) => (c === from ? to : c)))]
          : customColors;
      }
      // own colors of the grabber test, with the same add/remove/replace operations
      let grabberColors = state.grabberColors;
      if (typeof patch.addGrabberColor === "string" && HEX_COLOR.test(patch.addGrabberColor)) {
        const c = patch.addGrabberColor.toLowerCase();
        grabberColors = [...grabberColors.filter((x) => x !== c), c];
        if (grabberColors.length > MAX_CUSTOM_COLORS) throw new Error(`Maximal ${MAX_CUSTOM_COLORS} eigene Farben`);
      }
      if (typeof patch.removeGrabberColor === "string") {
        grabberColors = grabberColors.filter((x) => x !== patch.removeGrabberColor.toLowerCase());
      }
      if (patch.replaceGrabberColor && HEX_COLOR.test(patch.replaceGrabberColor.to ?? "")) {
        const from = String(patch.replaceGrabberColor.from ?? "").toLowerCase();
        const to = patch.replaceGrabberColor.to.toLowerCase();
        grabberColors = grabberColors.includes(from) ? [...new Set(grabberColors.map((c) => (c === from ? to : c)))] : grabberColors;
      }
      let grayTest = { ...state.grayTest, ...(patch.grayTest ?? {}) };
      // any change of the gray test (or an explicit restart) starts its timeline again
      if (patch.grayTest || patch.grayRestart) grayTest.startedAt = Date.now();
      const depthTest = { ...state.depthTest, ...(patch.depthTest ?? {}) };
      if (patch.depthTest || patch.depthRestart) depthTest.startedAt = Date.now();
      const fracTest = { ...state.fracTest, ...(patch.fracTest ?? {}) };
      if (patch.fracTest || patch.fracRestart) fracTest.startedAt = Date.now();
      const posTest = { ...state.posTest, ...(patch.posTest ?? {}) };
      // the guided test is sent as a whole (step and answers belong together)
      const posGuide = patch.posGuide ? { ...state.posGuide, ...patch.posGuide } : state.posGuide;
      // the running light starts again from its LED on every change
      if (patch.posTest || patch.posRestart) posTest.startedAt = Date.now();
      // the media on the TV: a new item, a new position or play/pause start its timeline again
      let mediaState = patch.media ? { ...state.media, ...patch.media } : state.media;
      if (patch.media && ["id", "position", "playing"].some((k) => k in patch.media)) mediaState.startedAt = Date.now();
      if (patch.media && "id" in patch.media && patch.media.id !== state.media.id) tvMedia = null;
      if (patch.media && "id" in patch.media && !String(patch.media.id).startsWith("src:")) mediaState.src = null;
      // only one test pattern at a time: starting one ends the others, a new test color ends all;
      // a picture or video of the media library counts as one too
      const tests = { grayTest, depthTest, fracTest, posTest };
      for (const [name, test] of Object.entries(tests)) {
        const started = Object.keys(tests).some((other) => other !== name && patch[other]?.active === true) || patch.media?.active === true;
        if (started || typeof patch.color === "string") test.active = false;
      }
      if (typeof patch.color === "string" || Object.keys(tests).some((t) => patch[t]?.active === true) || patch.posGuide?.active === true) mediaState = { ...mediaState, active: false };
      const overlays = { ...state.overlays, ...(patch.overlays ?? {}) };
      const colorActive = typeof patch.colorActive === "boolean" ? patch.colorActive : state.colorActive;
      const color = typeof patch.color === "string" && HEX_COLOR.test(patch.color) ? patch.color : state.color;
      const lang = patch.lang === "en" || patch.lang === "de" ? patch.lang : state.lang;
      const testPresets = patch.presetOp ? applyPresetOp(patch.presetOp, state.testPresets) : state.testPresets;
      const testGuard = typeof patch.testGuard === "boolean" ? patch.testGuard : state.testGuard;
      const guardRules = patch.guardRulesReset ? DEFAULT_GUARD_RULES : patch.guardRules ? { ...state.guardRules, ...patch.guardRules } : state.guardRules;
      const guideBefore = state.posGuide;
      state = sanitize({ color, colorActive, bars, customColors, grabberColors, presetColors, grayTest, depthTest, fracTest, posTest, posGuide, overlays, lang, testPresets, testGuard, guardRules, grayCurveByGrabber: state.grayCurveByGrabber, curveGrabber: state.curveGrabber, media: mediaState, lastPort: state.lastPort, ffmpegHint: state.ffmpegHint });
      if (patch.media?.active === true) ffmpegHint(mediaItemOf(state.media.id), "play");
      saveState();
      if (state.posGuide?.done && !guideBefore?.done) addNotice("guideDone", "info", {}, "card-lg");
      else if (guideBefore?.active && !guideBefore.done && !state.posGuide?.active) addNotice("guideAborted", "critical", {}, "card-lg");
      // a test that is touched again is no longer "paused"
      for (const key of ["grayTest", "depthTest", "fracTest", "posTest", "posGuide", "bars"]) if (patch[key]) delete paused[key];
      if (typeof patch.color === "string" || typeof patch.colorActive === "boolean") delete paused.color;
      if (patch.posTest) delete paused.posGuide;
      updateGrace();
      broadcast();
      scheduleGuard();
      return sendJson(res, 200, publicState());
    }

    // grabber test: the stored results (Hyperion's global setting), start and stop
    if (req.method === "GET" && p === "/api/grabbertest") {
      return sendJson(res, 200, { ...(readGlobalSetting("grabberTest") ?? {}), current: readGlobalSetting("grabberV4L2"), device: selectedGrabber() });
    }
    if (req.method === "GET" && p === "/api/grabbers") return sendJson(res, 200, await grabberList());
    if (req.method === "POST" && p === "/api/grabbers") {
      const { name } = await readBody(req);
      await selectGrabber(String(name ?? ""));
      return sendJson(res, 200, { ...(await grabberList()), grabberCorrection });
    }
    if (req.method === "POST" && p === "/api/grabbertest") {
      const { action, kind, enable, op, args } = await readBody(req);
      if (action === "correction") {
        await changeGrabberCalibration("enable", { on: enable === true });
        return sendJson(res, 200, { grabberCorrection });
      }
      if (action === "slot") {
        await changeGrabberCalibration(op, args);
        return sendJson(res, 200, { grabberCorrection });
      }
      if (action === "stop") {
        grabberAbort = true;
        return sendJson(res, 200, grabberRun);
      }
      await startGrabberTest(kind);
      return sendJson(res, 200, grabberRun);
    }

    if (req.method === "POST" && p === "/api/backup") {
      const name = makeBackup();
      return sendJson(res, 200, { name, backups: listBackups() });
    }

    if (req.method === "GET" && p === "/api/backups") return sendJson(res, 200, listBackups());

    if (req.method === "GET" && p === "/api/hyperion/status") return sendJson(res, 200, await hyperionStatus());

    if (req.method === "POST" && p === "/api/hyperion/connect") {
      if (tokenRequest.status !== "pending") requestToken();
      return sendJson(res, 202, tokenRequest);
    }

    if (req.method === "POST" && p === "/api/restore") {
      const { name } = await readBody(req);
      const result = await exclusive(() => restoreBackup(String(name ?? "")));
      return sendJson(res, 200, { ...result, backups: listBackups() });
    }

    if (req.method === "GET" && p.startsWith("/backups/")) {
      const name = path.basename(p.slice("/backups/".length));
      const full = path.join(BACKUP_DIR, name);
      if (!fs.existsSync(full)) return sendJson(res, 404, { error: "not found" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${name}"`,
      });
      return fs.createReadStream(full).pipe(res);
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

refreshLayoutFixInfo();
updateGrace();
// restore what a test switched off before a restart, or switch off again for a test still running
scheduleGuard();

// a configured port that is taken would leave the page unreachable: then it runs on the standard port
function listen(port) {
  server.once("error", (err) => {
    if (err.code !== "EADDRINUSE" || port === DEFAULT_PORT) throw err;
    console.warn(`Port ${port} is taken, using ${DEFAULT_PORT}`);
    PORT = DEFAULT_PORT;
    addNotice("portTaken", "critical", { port }, "card-ts");
    listen(DEFAULT_PORT);
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`tvtest listening on :${port}`);
    // a new port: what still points to the old one has to be changed by hand (test copies do not count)
    if (process.env.TVTEST_PORT || state.lastPort === port) return;
    if (state.lastPort) addNotice("portChanged", "critical", { from: state.lastPort, to: port }, "card-ts");
    state = sanitize({ ...state, lastPort: port });
    saveState();
  });
}
listen(PORT);

// a port changed in the WebUI: tell the pages where to go, then restart (systemd starts it again)
function moveTo(port) {
  console.log(`Port changed to ${port}, restarting`);
  const payload = `event: move\ndata: ${JSON.stringify({ port })}\n\n`;
  for (const res of clients.keys()) res.write(payload);
  setTimeout(() => process.exit(1), 500);
}
let moving = false;
setInterval(() => {
  if (moving || process.env.TVTEST_PORT) return;
  const next = configuredPort();
  if (next !== CONFIGURED_PORT) { moving = true; moveTo(next); }
}, 4000);

// is a port free on this computer (another program, or one of Hyperion's own)
function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
  });
}

async function changePort(input) {
  if (process.env.TVTEST_PORT) throw new Error("Der Port ist hier fest über TVTEST_PORT eingestellt");
  const port = validPort(input);
  if (!port) throw new Error("Der Port muss eine ganze Zahl von 1024 bis 65535 sein");
  if (port === PORT) return { port };
  const hyperionPorts = [readGlobalSetting("webConfig")?.port, readGlobalSetting("webConfig")?.sslPort, readGlobalSetting("jsonServer")?.port,
    readGlobalSetting("flatbufServer")?.port, readGlobalSetting("protoServer")?.port].map(Number);
  if (hyperionPorts.includes(port)) throw new Error(`Port ${port} benutzt Hyperion selbst`);
  if (!(await portFree(port))) throw new Error(`Port ${port} ist schon belegt`);
  const web = readGlobalSetting("webConfig") ?? {};
  try {
    await exclusive(() => writeGlobalSetting("webConfig", { ...web, testPagePort: port }));
  } catch (err) {
    throw new Error(/additional|schema|testPagePort/i.test(err.message) ? "Diese Hyperion-Version kennt den Port der Testseite noch nicht. Bitte die Hyperion-Version des Forks aktualisieren." : err.message);
  }
  moving = true;
  setTimeout(() => moveTo(port), 300);
  return { port };
}
