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
  // own colors of the grabber test, measured one after the other
  grabberColors: [],
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
  const payload = `data: ${JSON.stringify({ ...state, grabberRun, grabberCorrection, phones: phoneCount(), serverNow: Date.now() })}\n\n`;
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
      if (enable && !validMatrix(current.correction?.matrix)) throw new Error("Noch keine Korrektur berechnet. Zuerst einen Grundtest machen und die Korrektur im Grabber-Test einschalten.");
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
  if (grabberRun.running) throw new Error("Der Grabber-Test läuft schon");
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

function saveColor(patch) {
  return exclusive(() => writeInstanceSetting("color", mergeColor(readInstanceSetting("color"), patch)));
}

// Builds the same structure as Hyperion's own export ("config getconfig") from a DB backup
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

    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, { ...state, grabberRun, grabberCorrection });
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
      state = sanitize({ color, colorActive, bars, customColors, grabberColors, presetColors, grayTest, depthTest, fracTest, posTest, overlays, lang });
      saveState();
      broadcast();
      return sendJson(res, 200, { ...state, grabberRun, grabberCorrection });
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`tvtest listening on :${PORT}`);
});
