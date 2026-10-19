// Hyperion TV test page: small LAN server on the Pi, no dependencies.
// Serves the TV page (any TV browser, laptop or tablet) and the control page, keeps the
// shared state, syncs both via Server-Sent Events and writes DB backups.
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";

import { layoutRuns, offsetsFromAnswers, composeOffsets, correctedLeds, sameLayout, MAX_ANSWER } from "./public/layoutfix.js";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-generator");

const PORT = Number(process.env.TVTEST_PORT ?? 8093);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
// TVTEST_DATA_DIR lets a test copy keep its own state and backups
const DATA_DIR = process.env.TVTEST_DATA_DIR ?? HERE;
const STATE_FILE = path.join(DATA_DIR, "state.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
// overridable so a test copy can run against a mock Hyperion and a copy of the database
const HYPERION_DB = process.env.TVTEST_HYPERION_DB ?? "/home/alexo/.hyperion/db/hyperion.db";
const MAX_BAR = 50; // percent of screen per edge
const TOKEN_FILE = path.join(DATA_DIR, "hyperion-token");
const HYPERION_HOST = "127.0.0.1";
const HYPERION_JSON_PORT = Number(process.env.TVTEST_HYPERION_PORT ?? 19444);
const TOKEN_REQUEST_TIMEOUT_MS = 180_000; // Hyperion drops unanswered token requests after 180 s

const MAX_CUSTOM_COLORS = 24;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

// Test guard rules: which Hyperion features each kind of test switches off while it runs. Features a
// test is about stay on and cannot be chosen (black bars: black border detection, gray still image:
// gray still detection, capture depth: capture depth).
const GUARD_FEATURES = ["grayStill", "blackborder", "backlight", "stray", "signal", "edgeBoost", "depth"];
const GUARD_TESTS = ["color", "bars", "gray", "depth", "frac", "pos"];
const GUARD_FIXED = { bars: ["blackborder"], gray: ["grayStill"], depth: ["depth"] };
const DEFAULT_GUARD_RULES = {
  color: ["grayStill", "blackborder", "backlight", "stray", "signal"],
  bars: ["grayStill", "backlight"],
  gray: ["backlight", "signal"],
  depth: ["grayStill", "blackborder", "backlight", "signal", "edgeBoost"],
  frac: ["grayStill", "blackborder", "backlight", "stray", "signal"],
  pos: ["grayStill", "blackborder", "backlight", "depth", "signal"],
};

const DEFAULT_STATE = {
  color: "#000000",
  // false = the TV shows black instead of `color` (the on/off button per test color)
  colorActive: true,
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

// Tests whose settings can be saved as presets; the settings are the test's state without the run state
const PRESET_TESTS = ["bars", "grayTest", "depthTest", "fracTest", "posTest"];
const MAX_TEST_PRESETS = 50;
function presetSettings(test, settings) {
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
    if (list.length >= MAX_TEST_PRESETS) throw new Error(`Maximal ${MAX_TEST_PRESETS} Vorlagen je Test`);
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, fav: false, settings: op.settings ?? {}, savedAt: Date.now() });
  } else {
    if (at < 0) throw new Error("Vorlage nicht gefunden");
    if (op.op === "delete") list.splice(at, 1);
    else if (op.op === "fav") list[at] = { ...list[at], fav: !list[at].fav };
    else if (op.op === "rename") { if (!name) throw new Error("Bitte einen Namen eingeben"); list[at] = { ...list[at], name }; }
    else if (op.op === "update") list[at] = { ...list[at], settings: op.settings ?? {}, savedAt: Date.now() };
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
      .slice(0, MAX_TEST_PRESETS)
      .map((p) => ({ id: p.id.slice(0, 40), name: p.name.trim().slice(0, 60) || "?", fav: p.fav === true, settings: presetSettings(test, p.settings), savedAt: num(p.savedAt, 0, Number.MAX_SAFE_INTEGER, 0) }));
    if (clean.length) out.testPresets[test] = clean;
  }
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

// Every event carries the full state plus how many phones are connected (the TV hides its QR code then)
function broadcast() {
  // serverNow lets the TV time the gray test against the Pi's clock, not its own
  const payload = `data: ${JSON.stringify({ ...state, grabberRun, grabberCorrection, layoutFix: layoutFixInfo, guard: guardInfo, phones: phoneCount(), serverNow: Date.now() })}\n\n`;
  for (const res of clients.keys()) res.write(payload);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 10_000) reject(new Error("body too large"));
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

function makeBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `hyperion-${stamp}.db`;
  const target = path.join(BACKUP_DIR, name);
  const db = new DatabaseSync(HYPERION_DB, { readOnly: true });
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
  sock.on("connect", () => { monitor = m; syncImageStream(); });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (monitor === m) monitor = null;
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
const Report = globalThis.GrabberTestReport;

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
  const db = new DatabaseSync(HYPERION_DB, { readOnly: true });
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

// --- grabber color correction (global setting grabberTest.correction, computed by the report) ---
// state for the switches on the control page; the WebUI can change it too, so it is read again
// every few seconds and broadcast when it changed
let grabberCorrection = { available: false, enable: false, basedOn: null };

function readGrabberCorrection() {
  try {
    const c = readGlobalSetting("grabberTest")?.correction ?? {};
    const available = Array.isArray(c.matrix) && c.matrix.length === 9;
    return { available, enable: available && c.enable === true, basedOn: c.basedOn ?? null };
  } catch {
    return grabberCorrection;
  }
}

function refreshGrabberCorrection() {
  const next = readGrabberCorrection();
  if (JSON.stringify(next) === JSON.stringify(grabberCorrection)) return;
  grabberCorrection = next;
  broadcast();
}
grabberCorrection = readGrabberCorrection();
setInterval(refreshGrabberCorrection, 4000);

// same limits as Hyperion (GrabberColorCorrection::configure): 9 numbers, row absolute sum <= 2
function validMatrix(m) {
  if (!Array.isArray(m) || m.length !== 9 || !m.every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  for (let r = 0; r < 3; r++) if (Math.abs(m[3 * r]) + Math.abs(m[3 * r + 1]) + Math.abs(m[3 * r + 2]) > 2) return false;
  return true;
}

// enable: true/false switches the stored matrix; a full correction object (from the report) replaces it
async function setGrabberCorrection({ enable, correction }) {
  await exclusive(async () => {
    const current = readGlobalSetting("grabberTest") ?? { basic: {}, custom: {} };
    let next;
    if (correction && typeof correction === "object") {
      if (correction.enable && !validMatrix(correction.matrix)) throw new Error("Ungültige Korrekturmatrix");
      next = { ...correction, enable: correction.enable === true };
    } else {
      if (enable && !validMatrix(current.correction?.matrix)) throw new Error("Noch keine Korrektur berechnet. Zuerst einen Grundtest machen und die Korrektur unter Grabber-Farberkennung kalibrieren einschalten.");
      next = { ...(current.correction ?? {}), enable: enable === true };
    }
    await writeGlobalSetting("grabberTest", { ...current, basic: current.basic ?? {}, custom: current.custom ?? {}, correction: next });
  });
  refreshGrabberCorrection();
}

function setRun(patch) {
  grabberRun = { ...grabberRun, ...patch };
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
      const correction = current.correction?.enable ? { correction: current.correction } : {};
      const result = { version: 1, date: new Date().toISOString(), grabber: grabberSnapshot(), frame, ...correction, steps: results };
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

// --- Hyperion settings for black-border and gray-still-image detection (instance 0) ---

const BB_MODES = ["default", "classic", "osd", "letterbox"];

function readInstanceSetting(type, instance = 0) {
  const db = new DatabaseSync(HYPERION_DB, { readOnly: true });
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
// Paths: plain = channelAdjustment entry, "edgeTransitionBoost.*" = top level, "grayAxisTrim.stop.*" = one stop (patch.stop),
// "grayCurve.point.*" = one point of the gray curve (patch.stop is its index), "grayCurve.points" = all points
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
  "grayAxisTrim.enabled": ["bool"],
  "grayAxisTrim.stop.saturationUpTo": ["num", 0, 1, 0.01],
  "grayAxisTrim.stop.gainRed": ["num", 0, 4, 0.05],
  "grayAxisTrim.stop.gainGreen": ["num", 0, 4, 0.05],
  "grayAxisTrim.stop.gainBlue": ["num", 0, 4, 0.05],
  "grayCurve.enabled": ["bool"],
  "grayCurve.saturationLimit": ["num", 0.01, 1, 0.01],
  "grayCurve.point.level": ["num", 0, 100, 1],
  "grayCurve.point.gainRed": ["num", 0, 2, 0.01],
  "grayCurve.point.gainGreen": ["num", 0, 2, 0.01],
  "grayCurve.point.gainBlue": ["num", 0, 2, 0.01],
  "grayCurve.points": ["points"],
  "grayAxisTrim.stops": ["stops"],
  "edgeTransitionBoost.enabled": ["bool"],
  "edgeTransitionBoost.ledWidth": ["num", 1, 3, 1],
  "edgeTransitionBoost.edgeSensitivity": ["num", 5, 255, 1],
  "edgeTransitionBoost.boostStrength": ["num", 0, 2, 0.05],
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
  } else if (field.startsWith("edgeTransitionBoost.")) {
    target = next.edgeTransitionBoost;
    key = field.split(".")[1];
  } else if (field.startsWith("ledAreaDepth.")) {
    if (!next.ledAreaDepth) throw new Error("Die Erfassungstiefe braucht die neue Hyperion-Version");
    target = next.ledAreaDepth;
    key = field.split(".")[1];
  } else if (field.startsWith("grayAxisTrim.stop.")) {
    const stop = entry.grayAxisTrim?.stops?.[Number(patch.stop)];
    if (!stop) throw new Error("Stufe nicht gefunden");
    target = stop;
    key = field.split(".")[2];
  } else if (field === "grayAxisTrim.stops") {
    target = entry.grayAxisTrim;
    key = "stops";
  } else if (field === "grayAxisTrim.enabled") {
    target = entry.grayAxisTrim;
    key = "enabled";
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
  } else if (kind === "stops") {
    // reset of the gray axis correction: the stops as a whole
    if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new Error("Die Grauachsen-Korrektur braucht 1 bis 12 Stufen");
    const stops = value.map((p) => ({
      saturationUpTo: num(p?.saturationUpTo, 0, 1, NaN, 0.01),
      gainRed: num(p?.gainRed, 0, 4, NaN, 0.05),
      gainGreen: num(p?.gainGreen, 0, 4, NaN, 0.05),
      gainBlue: num(p?.gainBlue, 0, 4, NaN, 0.05),
    }));
    if (stops.some((p) => Object.values(p).some((v) => !Number.isFinite(v)))) throw new Error("Ungültige Stufe");
    target[key] = stops;
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
function saveColor(patch) {
  return exclusive(() => {
    const current = readInstanceSetting("color");
    const next = Array.isArray(patch.batch)
      ? patch.batch.reduce((cfg, f) => mergeColor(cfg, { ...f, index: patch.index }), current)
      : mergeColor(current, patch);
    return writeInstanceSetting("color", next);
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
    else if (head === "edgeTransitionBoost" || head === "ledAreaDepth") node = sub(c[head], mid);
    else if (field === "grayAxisTrim.stops") node = sub(entry.grayAxisTrim, "stops");
    else if (mid === "stop") node = sub(sub(entry.grayAxisTrim, "stops")?.items, last);
    else if (mid === "point") node = sub(sub(entry.grayCurve, "points")?.items, last);
    else if (head === "grayAxisTrim" || head === "grayCurve") node = sub(entry[head], mid);
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
  const device = safe(() => readInstanceSetting("device"));
  const smoothing = safe(() => readInstanceSetting("smoothing"));
  const v4l = safe(() => readGlobalSetting("grabberV4L2"));
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
      feature("stray", "Störlicht-Filter", device?.strayLedSuppressor?.enabled === true),
      feature("signal", "Signalerkennung des Grabbers", v4l?.signalDetection === true),
      feature("edgeBoost", "Kantenverstärkung", color.edgeTransitionBoost?.enabled === true),
      feature("depth", "Erfassungstiefe", !!depth && (Number(depth.topBottom) > 0 || Number(depth.leftRight) > 0), depth ? `${depth.topBottom} % / ${depth.leftRight} %` : null),
      feature("smoothing", "Glättung", smoothing?.enable === true, smoothing ? `${smoothing.time_ms} ms` : null),
      feature("correction", "Grabber-Farbkorrektur", grabberCorrection.enable),
      feature("fractional", "LED-Mittelwert mit Nachkommastellen", color.fractionalMean === true),
      feature("grayAxis", "Grauachsen-Korrektur", entry?.grayAxisTrim?.enabled === true),
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
// bars, a backlight lights LEDs that should stay dark, the stray LED filter darkens dim red LEDs,
// a deep capture depth lets the position marker reach neighbouring LEDs, the grabber's signal
// detection takes a dark test picture for "no signal" and the edge boost changes the depth frame. A feature a running test
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
  const shownColor = state.colorActive !== false && (state.color ?? "#000000").toLowerCase() !== "#000000";
  const pattern = ["grayTest", "depthTest", "fracTest", "posTest"].some((t) => state[t]?.active) || state.posGuide?.active;
  if (state.grayTest?.active) tests.push("gray");
  if (state.depthTest?.active) tests.push("depth");
  if (state.fracTest?.active) tests.push("frac");
  if (state.posTest?.active || state.posGuide?.active) tests.push("pos");
  if (Object.values(state.bars ?? {}).some((v) => v > 0)) tests.push("bars");
  if (shownColor && !pattern) tests.push("color");
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
  // a black or dark test picture would count as "no signal" and switch the LEDs off
  if (off.has("signal")) want.signal = { type: "grabberV4L2", global: true, path: ["signalDetection"], value: false, label: "Signalerkennung des Grabbers" };
  if (off.has("edgeBoost")) want.edgeBoost = { type: "color", path: ["edgeTransitionBoost", "enabled"], value: false, label: "Kantenverstärkung" };
  if (off.has("stray")) want.stray = { type: "device", path: ["strayLedSuppressor", "enabled"], value: false, label: "Störlicht-Filter" };
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  try {
    if (req.method === "GET" && (p === "/" || p === "/phone")) return serveStatic(res, "phone.html");
    if (req.method === "GET" && p === "/tv") return serveStatic(res, "tv.html");
    if (req.method === "GET" && p.startsWith("/static/")) return serveStatic(res, p.slice("/static/".length));

    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, { ...state, grabberRun, grabberCorrection, layoutFix: layoutFixInfo, guard: guardInfo });
    if (req.method === "GET" && p === "/api/presets") return sendJson(res, 200, PRESETS);

    if (req.method === "GET" && p === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      clients.set(res, url.searchParams.get("role") === "phone" ? "phone" : "tv");
      broadcast(); // also tells the TV that a phone joined
      if (lastDebug) res.write(`event: debug\ndata: ${JSON.stringify(lastDebug)}\n\n`);
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        clients.delete(res);
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
    if (req.method === "POST" && p === "/api/hyperion/system") {
      const { subcommand } = await readBody(req);
      if (!["suspend", "resume", "restart", "usbResetRestart"].includes(subcommand)) return sendJson(res, 400, { error: "Unbekannter Befehl" });
      await hyperionCommand({ command: "system", subcommand });
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
      await hyperionCommand({ command: "clear", priority: RGB_WIZARD_PRIORITY }).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/hyperion/rgbwizard") {
      const { action, color, colorOrder } = await readBody(req);
      if (action === "color") {
        if (!Array.isArray(color) || color.length !== 3 || !color.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return sendJson(res, 400, { error: "Ungültige Farbe" });
        await hyperionCommand({ command: "color", color, priority: RGB_WIZARD_PRIORITY, origin: "TV-Testseite" });
        return sendJson(res, 200, { ok: true });
      }
      if (action === "clear") {
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
    if (req.method === "POST" && p === "/api/hyperion/color") {
      const patch = await readBody(req);
      return sendJson(res, 200, await saveColor(patch));
    }

    // QR code with the phone URL, built from the address the TV used to reach the Pi
    if (req.method === "GET" && p === "/api/qr.svg") {
      const host = /^[\w.:\[\]-]+$/.test(req.headers.host ?? "") ? req.headers.host : `localhost:${PORT}`;
      res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" });
      return res.end(qrSvg(`http://${host}/`));
    }

    if (req.method === "POST" && p === "/api/state") {
      const patch = await readBody(req);
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
      // only one test pattern at a time: starting one ends the others, a new test color ends all
      const tests = { grayTest, depthTest, fracTest, posTest };
      for (const [name, test] of Object.entries(tests)) {
        const started = Object.keys(tests).some((other) => other !== name && patch[other]?.active === true);
        if (started || typeof patch.color === "string") test.active = false;
      }
      const overlays = { ...state.overlays, ...(patch.overlays ?? {}) };
      const colorActive = typeof patch.colorActive === "boolean" ? patch.colorActive : state.colorActive;
      const color = typeof patch.color === "string" && HEX_COLOR.test(patch.color) ? patch.color : state.color;
      const lang = patch.lang === "en" || patch.lang === "de" ? patch.lang : state.lang;
      const testPresets = patch.presetOp ? applyPresetOp(patch.presetOp, state.testPresets) : state.testPresets;
      const testGuard = typeof patch.testGuard === "boolean" ? patch.testGuard : state.testGuard;
      const guardRules = patch.guardRulesReset ? DEFAULT_GUARD_RULES : patch.guardRules ? { ...state.guardRules, ...patch.guardRules } : state.guardRules;
      state = sanitize({ color, colorActive, bars, customColors, grabberColors, presetColors, grayTest, depthTest, fracTest, posTest, posGuide, overlays, lang, testPresets, testGuard, guardRules });
      saveState();
      broadcast();
      scheduleGuard();
      return sendJson(res, 200, { ...state, grabberRun, grabberCorrection, layoutFix: layoutFixInfo, guard: guardInfo });
    }

    // grabber test: the stored results (Hyperion's global setting), start and stop
    if (req.method === "GET" && p === "/api/grabbertest") {
      return sendJson(res, 200, { ...(readGlobalSetting("grabberTest") ?? {}), current: readGlobalSetting("grabberV4L2") });
    }
    if (req.method === "POST" && p === "/api/grabbertest") {
      const { action, kind, enable, correction } = await readBody(req);
      if (action === "correction") {
        await setGrabberCorrection({ enable, correction });
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
// restore what a test switched off before a restart, or switch off again for a test still running
scheduleGuard();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`tvtest listening on :${PORT}`);
});
