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

const qrcode = createRequire(import.meta.url)("qrcode-generator");

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
  // where the debug views are drawn: on the TV picture (captured by the grabber!) or on the phone preview
  overlays: { bbTv: false, bbPreview: true, gsTv: false, gsPreview: true },
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
  const o = { ...DEFAULT_STATE.overlays, ...(input.overlays ?? {}) };
  out.overlays = Object.fromEntries(Object.keys(DEFAULT_STATE.overlays).map((k) => [k, o[k] === true]));
  if (input.presetColors && typeof input.presetColors === "object") {
    out.presetColors = Object.fromEntries(
      Object.entries(input.presetColors)
        .filter(([id, c]) => PRESET_IDS.includes(id) && typeof c === "string" && HEX_COLOR.test(c))
        .map(([id, c]) => [id, c.toLowerCase()]),
    );
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
  const payload = `data: ${JSON.stringify({ ...state, phones: phoneCount(), serverNow: Date.now() })}\n\n`;
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
const PREVIEW_INTERVAL_MS = 125; // about 8 frames per second to the phones
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
// Paths: plain = channelAdjustment entry, "edgeTransitionBoost.*" = top level, "grayAxisTrim.stop.*" = one stop (patch.stop)
const COLOR_FIELDS = {
  white: ["rgb"], red: ["rgb"], green: ["rgb"], blue: ["rgb"], cyan: ["rgb"], magenta: ["rgb"], yellow: ["rgb"],
  brightness: ["num", 0, 100, 1],
  saturationGain: ["num", 0, 10, 0.1],
  backlightThreshold: ["num", 0, 100, 1],
  backlightColored: ["bool"],
  gammaRed: ["num", 0.1, 100, 0.1],
  gammaGreen: ["num", 0.1, 100, 0.1],
  gammaBlue: ["num", 0.1, 100, 0.1],
  temperature: ["num", 1000, 40000, 100],
  "grayAxisTrim.enabled": ["bool"],
  "grayAxisTrim.stop.saturationUpTo": ["num", 0, 1, 0.01],
  "grayAxisTrim.stop.gainRed": ["num", 0, 4, 0.05],
  "grayAxisTrim.stop.gainGreen": ["num", 0, 4, 0.05],
  "grayAxisTrim.stop.gainBlue": ["num", 0, 4, 0.05],
  "edgeTransitionBoost.enabled": ["bool"],
  "edgeTransitionBoost.ledWidth": ["num", 1, 3, 1],
  "edgeTransitionBoost.edgeSensitivity": ["num", 5, 255, 1],
  "edgeTransitionBoost.boostStrength": ["num", 0, 2, 0.05],
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
  if (field.startsWith("edgeTransitionBoost.")) {
    target = next.edgeTransitionBoost;
    key = field.split(".")[1];
  } else if (field.startsWith("grayAxisTrim.stop.")) {
    const stop = entry.grayAxisTrim?.stops?.[Number(patch.stop)];
    if (!stop) throw new Error("Stufe nicht gefunden");
    target = stop;
    key = field.split(".")[2];
  } else if (field === "grayAxisTrim.enabled") {
    target = entry.grayAxisTrim;
    key = "enabled";
  }
  if (!target) throw new Error("Einstellung fehlt in Hyperion");

  const [kind, min, max, step] = spec;
  if (kind === "rgb") {
    const rgb = Array.isArray(value) ? value.map(Number) : [];
    if (rgb.length !== 3 || rgb.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) throw new Error("RGB braucht drei Werte von 0 bis 255");
    target[key] = rgb;
  } else if (kind === "bool") {
    target[key] = value === true;
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

    if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, state);
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
    // LED sampling areas [hmin, hmax, vmin, vmax]: the gray still detector only sees these parts of the picture
    if (req.method === "GET" && p === "/api/hyperion/leds") return sendJson(res, 200, readInstanceSetting("leds").map((l) => [l.hmin, l.hmax, l.vmin, l.vmax]));
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
      let grayTest = { ...state.grayTest, ...(patch.grayTest ?? {}) };
      // any change of the gray test (or an explicit restart) starts its timeline again
      if (patch.grayTest || patch.grayRestart) grayTest.startedAt = Date.now();
      const overlays = { ...state.overlays, ...(patch.overlays ?? {}) };
      const colorActive = typeof patch.colorActive === "boolean" ? patch.colorActive : state.colorActive;
      const color = typeof patch.color === "string" && HEX_COLOR.test(patch.color) ? patch.color : state.color;
      state = sanitize({ color, colorActive, bars, customColors, presetColors, grayTest, overlays });
      saveState();
      broadcast();
      return sendJson(res, 200, state);
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
