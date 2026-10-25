// Test pictures and videos of the test page: own uploads (pictures, videos) and links to YouTube, Vimeo
// and Dailymotion. Files live in <data>/media (named by id, never by the user's file name), the list in
// <data>/media.json. ffprobe is optional: with it a video's codec, HDR and length are known, without it
// only the file type. Thumbnails come from the browser that uploads (no ffmpeg needed), for links from
// the platform (oEmbed).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

const MAX_UPLOAD = 4 * 1024 ** 3;   // one file
const KEEP_FREE = 1024 ** 3;        // an upload never fills the disk
const MAX_THUMB = 600_000;
const MAX_ITEMS = 500;
const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/bmp": ".bmp" };
const VIDEO_EXT = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-matroska": ".mkv", "video/ogg": ".ogv", "video/x-m4v": ".m4v" };
const EXT_MIME = Object.fromEntries([...Object.entries(IMAGE_EXT), ...Object.entries(VIDEO_EXT)].map(([m, e]) => [e, m]));
// browsers send these for files they do not know well; the extension decides then
const BY_EXT = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".ogv": "video/ogg" };

// YouTube, Vimeo, Dailymotion: provider and id from the usual link forms
export function parseLink(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
  const id = (re, s) => (re.test(s) ? s : null);
  if (host === "youtu.be") return ytOf(u.pathname.slice(1));
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.searchParams.get("v")) return ytOf(u.searchParams.get("v"));
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]+)/);
    return m ? ytOf(m[1]) : null;
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const m = u.pathname.match(/(?:^|\/)(\d{5,12})(?:\/([\da-f]{6,20}))?/);
    return m ? { provider: "vimeo", ref: m[1], hash: m[2] ?? u.searchParams.get("h") ?? "" } : null;
  }
  if (host === "dailymotion.com" || host === "dai.ly") {
    const m = host === "dai.ly" ? [null, u.pathname.slice(1)] : u.pathname.match(/\/(?:embed\/)?video\/([a-zA-Z0-9]+)/);
    const ref = m && id(/^[a-zA-Z0-9]{5,12}$/, m[1]);
    return ref ? { provider: "dailymotion", ref } : null;
  }
  return null;
  function ytOf(v) {
    const ref = id(/^[\w-]{11}$/, String(v ?? "").slice(0, 11));
    if (!ref) return null;
    const t = Number(String(u.searchParams.get("t") ?? u.searchParams.get("start") ?? "").replace(/s$/, ""));
    return { provider: "youtube", ref, start: Number.isFinite(t) && t > 0 ? t : 0 };
  }
}

const OEMBED = {
  youtube: (it) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + it.ref)}`,
  vimeo: (it) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent("https://vimeo.com/" + it.ref + (it.hash ? "/" + it.hash : ""))}`,
  dailymotion: (it) => `https://www.dailymotion.com/services/oembed?format=json&url=${encodeURIComponent("https://www.dailymotion.com/video/" + it.ref)}`,
};
const PROVIDER_NAME = { youtube: "YouTube", vimeo: "Vimeo", dailymotion: "Dailymotion" };

export function createMedia({ dataDir, onChange, onUpload }) {
  const DIR = path.join(dataDir, "media");
  const THUMBS = path.join(DIR, "thumbs");
  const LIST = path.join(dataDir, "media.json");
  fs.mkdirSync(THUMBS, { recursive: true });
  let items = [];
  try { items = JSON.parse(fs.readFileSync(LIST, "utf8")).filter((i) => i && typeof i.id === "string"); } catch {}
  // a download cut off by a restart is gone
  for (const it of items.filter((i) => i.downloading)) { fs.rm(path.join(DIR, it.file + ".part"), { force: true }, () => {}); }
  items = items.filter((i) => !i.downloading);
  // every link pasted, newest first: { url, at, result: "embed" | "download" | "error", name, error }
  const HISTORY = path.join(dataDir, "link-history.json");
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, "utf8")).filter((h) => h && typeof h.url === "string"); } catch {}
  function remember(entry) {
    history = [{ ...entry, at: Date.now() }, ...history.filter((h) => h.url !== entry.url)].slice(0, 50);
    fs.writeFileSync(HISTORY, JSON.stringify(history));
  }
  let ffprobe = null;
  let ffmpeg = null;
  // TVTEST_NO_FFMPEG=1 behaves as if ffmpeg were missing (to test the hints)
  const noTools = process.env.TVTEST_NO_FFMPEG === "1";
  execFile("ffprobe", ["-version"], (err) => { ffprobe = !err && !noTools; });
  execFile("ffmpeg", ["-version"], (err) => { ffmpeg = !err && !noTools; });

  function save() {
    const tmp = LIST + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(items, null, 1));
    fs.renameSync(tmp, LIST);
    onChange?.();
  }
  const newId = () => randomBytes(8).toString("hex");
  const find = (id) => items.find((i) => i.id === id) ?? null;
  const fileOf = (it) => (it?.file ? path.join(DIR, it.file) : null);

  function disk() {
    try {
      const s = fs.statfsSync(DIR);
      return { free: s.bavail * s.bsize, total: s.blocks * s.bsize, used: items.reduce((n, i) => n + (i.size ?? 0), 0) };
    } catch {
      return null;
    }
  }

  function info() {
    return { items, history, disk: disk(), ffprobe: ffprobe === true, ffmpeg: ffmpeg === true, maxUpload: MAX_UPLOAD, keepFree: KEEP_FREE };
  }

  // codec, HDR and length of a video (or size of a picture), if ffprobe is there
  function probe(it) {
    if (ffprobe !== true || !it.file) return;
    execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", fileOf(it)], { timeout: 30_000, maxBuffer: 4_000_000 }, (err, out) => {
      if (err) return;
      let j;
      try { j = JSON.parse(out); } catch { return; }
      const v = (j.streams ?? []).find((s) => s.codec_type === "video");
      const a = (j.streams ?? []).find((s) => s.codec_type === "audio");
      const cur = find(it.id);
      if (!cur) return;
      if (v && cur.kind === "image") {
        cur.width = v.width ?? cur.width;
        cur.height = v.height ?? cur.height;
      } else if (v) {
        cur.codec = v.codec_name ?? null;
        cur.profile = v.profile ?? null;
        cur.width = v.width ?? cur.width;
        cur.height = v.height ?? cur.height;
        cur.bits = /10|12/.test(v.pix_fmt ?? "") ? (/12/.test(v.pix_fmt) ? 12 : 10) : 8;
        cur.hdr = v.color_transfer === "smpte2084" ? "HDR10" : v.color_transfer === "arib-std-b67" ? "HLG" : null;
        const [n, d] = String(v.avg_frame_rate ?? "0/1").split("/").map(Number);
        if (n && d) cur.fps = Math.round((n / d) * 100) / 100;
      }
      cur.audio = a?.codec_name ?? null;
      const dur = Number(j.format?.duration);
      if (cur.kind === "video" && Number.isFinite(dur)) cur.duration = Math.round(dur * 10) / 10;
      save();
      // a browser that cannot decode the file (e.g. HEVC on a PC) sent no thumbnail: ffmpeg makes one
      setTimeout(() => thumbByFfmpeg(cur.id), 15_000);
    });
  }

  function thumbByFfmpeg(id) {
    const it = find(id);
    if (ffmpeg !== true || !it?.file || it.thumb) return;
    const seek = it.kind === "video" && it.duration > 2 ? ["-ss", "1"] : [];
    const out = path.join(THUMBS, id + ".jpg");
    execFile("ffmpeg", ["-v", "error", "-y", ...seek, "-i", fileOf(it), "-frames:v", "1", "-vf", "scale=320:-2", out], { timeout: 60_000 }, (err) => {
      const cur = find(id);
      if (err || !cur || cur.thumb || !fs.existsSync(out)) return;
      cur.thumb = Date.now();
      save();
    });
  }

  function upload(req, res, sendJson) {
    const name = decodeURIComponent(String(req.headers["x-name"] ?? "")).trim().slice(0, 120) || "Datei";
    const ext = path.extname(name).toLowerCase();
    let mime = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_EXT[mime] && !VIDEO_EXT[mime]) mime = BY_EXT[ext] ?? mime;
    const kind = IMAGE_EXT[mime] ? "image" : VIDEO_EXT[mime] ? "video" : null;
    if (!kind) { req.resume(); return sendJson(res, 400, { error: "Nur Bilder (JPG, PNG, WebP, GIF, AVIF, BMP) und Videos (MP4, WebM, MOV, MKV, OGV) gehen" }); }
    const size = Number(req.headers["content-length"]);
    if (!Number.isFinite(size) || size <= 0) { req.resume(); return sendJson(res, 411, { error: "Dateigröße fehlt" }); }
    if (size > MAX_UPLOAD) { req.resume(); return sendJson(res, 413, { error: "Die Datei ist größer als 4 GB" }); }
    const d = disk();
    if (d && size + KEEP_FREE > d.free) { req.resume(); return sendJson(res, 507, { error: "Nicht genug freier Speicher auf dem Server" }); }
    if (items.length >= MAX_ITEMS) { req.resume(); return sendJson(res, 400, { error: `Höchstens ${MAX_ITEMS} Einträge` }); }
    const id = newId();
    const file = id + (IMAGE_EXT[mime] ?? VIDEO_EXT[mime]);
    const tmp = path.join(DIR, file + ".part");
    const out = fs.createWriteStream(tmp);
    let got = 0;
    let failed = false;
    const fail = (code, msg) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      if (!res.headersSent) sendJson(res, code, { error: msg });
    };
    req.on("data", (c) => { got += c.length; if (got > size) fail(400, "Mehr Daten als angekündigt"); });
    req.on("aborted", () => fail(400, "Hochladen abgebrochen"));
    out.on("error", (e) => fail(500, e.message));
    req.pipe(out);
    out.on("finish", () => {
      if (failed) return;
      if (got !== size) return fail(400, "Hochladen unvollständig");
      fs.renameSync(tmp, path.join(DIR, file));
      const base = path.basename(name, path.extname(name)) || name;
      const it = { id, kind, name: base, file, mime, size, createdAt: Date.now() };
      items.push(it);
      save();
      probe(it);
      onUpload?.(it);
      sendJson(res, 200, { item: it, ...info() });
    });
  }

  function putThumb(req, res, sendJson, id) {
    const it = find(id);
    if (!it) { req.resume(); return sendJson(res, 404, { error: "Eintrag nicht gefunden" }); }
    const chunks = [];
    let n = 0;
    req.on("data", (c) => { n += c.length; if (n <= MAX_THUMB) chunks.push(c); });
    req.on("end", () => {
      if (n > MAX_THUMB) return sendJson(res, 413, { error: "Vorschaubild zu groß" });
      fs.writeFileSync(path.join(THUMBS, id + ".jpg"), Buffer.concat(chunks));
      const q = new URL(req.url, "http://x").searchParams;
      it.thumb = Date.now();
      // what the browser read from the file (without ffprobe the only source)
      for (const k of ["width", "height"]) if (!it[k] && Number(q.get(k)) > 0) it[k] = Number(q.get(k));
      if (it.kind === "video" && !it.duration && Number(q.get("duration")) > 0) it.duration = Math.round(Number(q.get("duration")) * 10) / 10;
      save();
      sendJson(res, 200, { ok: true });
    });
  }

  // a pasted link: YouTube/Vimeo/Dailymotion are embedded, anything else is downloaded if it is a
  // picture or video file; every link goes into the history
  async function addAnyLink(url) {
    try {
      if (parseLink(url)) {
        const it = await addLink(url);
        remember({ url, result: "embed", name: it.name });
        return it;
      }
      const it = await download(url);
      remember({ url, result: "download", name: it.name });
      return it;
    } catch (e) {
      remember({ url, result: "error", error: e.message });
      throw e;
    }
  }

  // downloads a picture or video into the library; the item shows the progress while it runs
  async function download(input) {
    let url;
    try { url = new URL(String(input).trim()); } catch { throw new Error("Das ist kein gültiger Link"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("Nur Links mit http:// oder https:// gehen");
    if (items.length >= MAX_ITEMS) throw new Error(`Höchstens ${MAX_ITEMS} Einträge`);
    const ctrl = new AbortController();
    const headTimer = setTimeout(() => ctrl.abort(), 15_000);
    let r;
    try {
      r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (Hyperion TV-Testseite)" } });
    } catch (e) {
      throw new Error(`Link nicht erreichbar (${e.cause?.code ?? e.name})`);
    } finally {
      clearTimeout(headTimer);
    }
    if (!r.ok) throw new Error(`Der Server des Links antwortet mit ${r.status}`);
    const ext0 = path.extname(new URL(r.url).pathname).toLowerCase();
    let mime = String(r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_EXT[mime] && !VIDEO_EXT[mime]) mime = BY_EXT[ext0] ?? mime;
    const kind = IMAGE_EXT[mime] ? "image" : VIDEO_EXT[mime] ? "video" : null;
    if (!kind) {
      r.body?.cancel().catch(() => {});
      throw new Error(mime === "text/html" ? "Der Link führt zu einer Webseite, nicht direkt zu einer Bild- oder Videodatei" : "Der Link führt zu keiner Bild- oder Videodatei");
    }
    const size = Number(r.headers.get("content-length")) || 0;
    if (size > MAX_UPLOAD) { r.body?.cancel().catch(() => {}); throw new Error("Die Datei ist größer als 4 GB"); }
    const d = disk();
    if (d && size + KEEP_FREE > d.free) { r.body?.cancel().catch(() => {}); throw new Error("Nicht genug freier Speicher auf dem Server"); }
    const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(r.headers.get("content-disposition") ?? "");
    const fname = decodeURIComponent(cd?.[1] ?? path.basename(new URL(r.url).pathname) ?? "") || "Download";
    const id = newId();
    const file = id + (IMAGE_EXT[mime] ?? VIDEO_EXT[mime]);
    const it = { id, kind, name: path.basename(fname, path.extname(fname)).slice(0, 120) || "Download", file, mime, size: size || undefined, createdAt: Date.now(), source: r.url.slice(0, 500), downloading: true, loaded: 0 };
    items.push(it);
    save();
    // the rest runs on; the list shows the progress
    (async () => {
      const tmp = path.join(DIR, file + ".part");
      const out = fs.createWriteStream(tmp);
      let got = 0, last = 0;
      try {
        for await (const chunk of r.body) {
          if (!items.includes(it)) throw new Error("Download abgebrochen");
          got += chunk.length;
          if (got > MAX_UPLOAD) throw new Error("Die Datei ist größer als 4 GB");
          if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
          if (Date.now() - last > 1000) { last = Date.now(); it.loaded = got; onChange?.(); }
        }
        await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
        fs.renameSync(tmp, path.join(DIR, file));
        delete it.downloading;
        delete it.loaded;
        it.size = got;
        if (kind === "image") it.thumb = Date.now(); // the picture itself serves as its thumbnail
        save();
        probe(it);
        if (kind === "video") onUpload?.(it);
      } catch (e) {
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        items = items.filter((i) => i.id !== id);
        remember({ url: String(input).trim(), result: "error", error: e.message });
        save();
      }
    })();
    return it;
  }

  async function addLink(url) {
    const p = parseLink(url);
    if (!p) throw new Error("Unbekannter Link. Es gehen Links zu YouTube, Vimeo und Dailymotion.");
    if (items.length >= MAX_ITEMS) throw new Error(`Höchstens ${MAX_ITEMS} Einträge`);
    const dup = items.find((i) => i.kind === "link" && i.provider === p.provider && i.ref === p.ref);
    if (dup) return dup;
    const it = { id: newId(), kind: "link", provider: p.provider, ref: p.ref, hash: p.hash || undefined, start: p.start || undefined, url: String(url).trim().slice(0, 500), name: `${PROVIDER_NAME[p.provider]} ${p.ref}`, createdAt: Date.now() };
    // title and picture from the platform; without internet the link still works on the TV later
    try {
      const r = await fetch(OEMBED[p.provider](it), { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const o = await r.json();
        if (o.title) it.name = String(o.title).slice(0, 120);
        if (o.duration) it.duration = Number(o.duration) || undefined;
        if (o.thumbnail_url) {
          const t = await fetch(o.thumbnail_url, { signal: AbortSignal.timeout(6000) });
          if (t.ok) {
            const buf = Buffer.from(await t.arrayBuffer());
            if (buf.length <= MAX_THUMB * 3) { fs.writeFileSync(path.join(THUMBS, it.id + ".jpg"), buf); it.thumb = Date.now(); }
          }
        }
      } else if (r.status === 401 || r.status === 403) {
        it.embedBlocked = true; // the owner does not allow embedding
      } else if (r.status === 404) {
        throw Object.assign(new Error("Dieses Video gibt es nicht (mehr) oder es ist privat"), { user: true });
      }
    } catch (err) {
      if (err.user) throw err;
    }
    items.push(it);
    save();
    return it;
  }

  function remove(id) {
    const at = items.findIndex((i) => i.id === id);
    if (at < 0) throw new Error("Eintrag nicht gefunden");
    const [it] = items.splice(at, 1);
    if (it.file) fs.rm(fileOf(it), { force: true }, () => {});
    fs.rm(path.join(THUMBS, it.id + ".jpg"), { force: true }, () => {});
    save();
  }

  function rename(id, name) {
    const it = find(id);
    if (!it) throw new Error("Eintrag nicht gefunden");
    const n = String(name ?? "").trim().slice(0, 120);
    if (!n) throw new Error("Bitte einen Namen eingeben");
    it.name = n;
    save();
  }

  // a file with Range support, so videos can be wound on the TV
  function serveFile(req, res, it) {
    const full = fileOf(it);
    let st;
    try { st = fs.statSync(full); } catch { res.writeHead(404); return res.end(); }
    const type = it.mime ?? EXT_MIME[path.extname(full)] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      let start = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : st.size - 1;
      if (!(start >= 0) || start >= st.size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes", "Cache-Control": "no-cache" });
    fs.createReadStream(full).pipe(res);
  }

  // routes: returns true when it answered
  async function handle(req, res, p, sendJson, readBody) {
    if (req.method === "GET" && p === "/api/media") { sendJson(res, 200, info()); return true; }
    if (req.method === "POST" && p === "/api/media/upload") { upload(req, res, sendJson); return true; }
    if (req.method === "POST" && p === "/api/media/thumb") { putThumb(req, res, sendJson, new URL(req.url, "http://x").searchParams.get("id")); return true; }
    if (req.method === "POST" && p === "/api/media") {
      const { op, id, name, url } = await readBody(req);
      if (op === "rename") rename(id, name);
      else if (op === "delete") remove(id);
      else if (op === "link") { const item = await addAnyLink(url); sendJson(res, 200, { item, ...info() }); return true; }
      else if (op === "forget") { history = history.filter((h) => h.url !== url); fs.writeFileSync(HISTORY, JSON.stringify(history)); }
      else if (op === "forgetAll") { history = []; fs.writeFileSync(HISTORY, "[]"); }
      else throw new Error("Unbekannte Aktion");
      sendJson(res, 200, info());
      return true;
    }
    if (req.method === "GET" && p.startsWith("/media/file/")) {
      const it = find(p.slice("/media/file/".length));
      if (!it?.file) { sendJson(res, 404, { error: "not found" }); return true; }
      serveFile(req, res, it);
      return true;
    }
    if (req.method === "GET" && p.startsWith("/media/thumb/")) {
      const id = p.slice("/media/thumb/".length);
      const full = path.join(THUMBS, id.replace(/[^\da-f]/g, "") + ".jpg");
      if (!fs.existsSync(full)) {
        // a downloaded picture without a thumbnail of its own
        const it = find(id);
        if (it?.kind === "image" && !it.downloading) { serveFile(req, res, it); return true; }
        sendJson(res, 404, { error: "not found" });
        return true;
      }
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
      fs.createReadStream(full).pipe(res);
      return true;
    }
    return false;
  }

  return { handle, info, find };
}
