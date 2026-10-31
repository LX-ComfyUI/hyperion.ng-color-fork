// More sources for the media library, added by the user: a folder on the server (a NAS share mounted
// there, read only), Plex (address + token) and Jellyfin (address + API key). The pages browse them
// through this server and the TV plays them through it too (/media/src/...), so tokens never leave the
// server and the TV needs no access to the NAS or the media server. Files are played as they are
// (direct play); whether the TV browser can play them is marked from the codec the server knows.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";

const TYPES = ["folder", "plex", "jellyfin"];
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv", ".avi", ".ts", ".m2ts"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".ogv": "video/ogg", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t" };
const MAX_ENTRIES = 2000;
const TIMEOUT = 8000;

const cleanUrl = (u) => {
  let url;
  try { url = new URL(String(u ?? "").trim()); } catch { throw new Error("Bitte eine Adresse wie http://192.168.1.10:32400 eingeben"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Die Adresse muss mit http:// oder https:// beginnen");
  return url.origin + url.pathname.replace(/\/+$/, "");
};

export function createSources({ dataDir, thumbsDir }) {
  const FILE = path.join(dataDir, "sources.json");
  let list = [];
  try { list = JSON.parse(fs.readFileSync(FILE, "utf8")).filter((s) => s && TYPES.includes(s.type)); } catch {}
  let ffmpeg = null;
  execFile("ffmpeg", ["-version"], (err) => { ffmpeg = !err && process.env.TVTEST_NO_FFMPEG !== "1"; });

  function save() {
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  }
  const find = (id) => list.find((s) => s.id === id) ?? null;
  // what the pages see: never the token
  const view = (s) => ({ id: s.id, type: s.type, name: s.name, path: s.path, url: s.url, hasToken: !!s.token, status: s.status ?? null });

  function clean(input, old) {
    const type = TYPES.includes(input?.type) ? input.type : old?.type;
    if (!type) throw new Error("Unbekannte Art der Quelle");
    const out = { type, name: String(input?.name ?? old?.name ?? "").trim().slice(0, 60) };
    if (type === "folder") {
      const p = String(input?.path ?? old?.path ?? "").trim();
      if (!path.isAbsolute(p)) throw new Error("Bitte einen vollständigen Pfad auf dem Server eingeben, z. B. /mnt/nas/videos");
      out.path = path.normalize(p);
      if (!out.name) out.name = path.basename(out.path) || out.path;
    } else {
      out.url = cleanUrl(input?.url ?? old?.url);
      const token = String(input?.token ?? "").trim();
      out.token = token || old?.token || "";
      if (!out.token) throw new Error(type === "plex" ? "Der Plex-Token fehlt" : "Der API-Schlüssel fehlt");
      if (!out.name) out.name = type === "plex" ? "Plex" : "Jellyfin";
    }
    return out;
  }

  // ---- talking to Plex and Jellyfin ----
  const headers = (s) => (s.type === "plex"
    ? { "X-Plex-Token": s.token, Accept: "application/json", "X-Plex-Client-Identifier": "hyperion-tvtest", "X-Plex-Product": "Hyperion TV-Testseite" }
    : { "X-Emby-Token": s.token, Accept: "application/json" });
  async function api(s, p) {
    let r;
    try {
      r = await fetch(s.url + p, { headers: headers(s), signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      throw new Error(`${s.type === "plex" ? "Plex" : "Jellyfin"} nicht erreichbar (${e.cause?.code ?? e.name})`);
    }
    if (r.status === 401 || r.status === 403) throw new Error(s.type === "plex" ? "Plex lehnt den Token ab" : "Jellyfin lehnt den API-Schlüssel ab");
    if (!r.ok) throw new Error(`Antwort ${r.status} von ${s.type === "plex" ? "Plex" : "Jellyfin"}`);
    return r.json();
  }

  async function test(s) {
    if (s.type === "folder") {
      const st = await fs.promises.stat(s.path).catch(() => null);
      if (!st?.isDirectory()) throw new Error("Diesen Ordner gibt es auf dem Server nicht. Ist die NAS-Freigabe eingebunden?");
      await fs.promises.access(s.path, fs.constants.R_OK).catch(() => { throw new Error("Der Testserver darf diesen Ordner nicht lesen (Rechte)"); });
      return "Ordner lesbar";
    }
    if (s.type === "plex") {
      const j = await api(s, "/library/sections");
      const n = j.MediaContainer?.Directory?.length ?? 0;
      return `Plex verbunden, ${n} ${n === 1 ? "Bibliothek" : "Bibliotheken"}`;
    }
    const info = await api(s, "/System/Info");
    const libs = await api(s, "/Library/VirtualFolders").catch(() => []);
    const n = Array.isArray(libs) ? libs.length : 0;
    return `Jellyfin ${info.Version ?? ""} verbunden, ${n} ${n === 1 ? "Bibliothek" : "Bibliotheken"}`.replace("  ", " ");
  }

  // ---- browsing: key "" = top level; entries { key, kind: folder|image|video, name, ... } ----
  async function browseFolder(s, key) {
    const root = await fs.promises.realpath(s.path);
    const dir = await fs.promises.realpath(path.join(root, key || "")).catch(() => null);
    if (!dir || (dir !== root && !dir.startsWith(root + path.sep))) throw new Error("Ordner nicht gefunden");
    const ents = (await fs.promises.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith("."));
    const out = [];
    for (const e of ents.slice(0, MAX_ENTRIES)) {
      const rel = path.relative(root, path.join(dir, e.name));
      const ext = path.extname(e.name).toLowerCase();
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = (await fs.promises.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory() ?? false;
      if (isDir) out.push({ key: rel, kind: "folder", name: e.name });
      else if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) {
        const st = await fs.promises.stat(path.join(dir, e.name)).catch(() => null);
        out.push({ key: rel, kind: IMAGE_EXT.has(ext) ? "image" : "video", name: e.name, size: st?.size, container: ext.slice(1), thumb: true });
      }
    }
    out.sort((a, b) => ((b.kind === "folder") - (a.kind === "folder")) || a.name.localeCompare(b.name, "de", { numeric: true }));
    return { entries: out, crumbs: key ? key.split(path.sep).map((n, i, all) => ({ key: all.slice(0, i + 1).join(path.sep), name: n })) : [] };
  }

  const plexKind = (m) => (["movie", "episode", "clip", "video"].includes(m.type) ? "video" : m.type === "photo" ? "image" : "folder");
  async function browsePlex(s, key) {
    if (!key) {
      const j = await api(s, "/library/sections");
      return { entries: (j.MediaContainer?.Directory ?? []).filter((d) => ["movie", "show", "photo"].includes(d.type)).map((d) => ({ key: `/library/sections/${d.key}/all`, kind: "folder", name: d.title })), crumbs: [] };
    }
    if (!/^\/library\/(sections\/\d+\/all|metadata\/\d+\/children)$/.test(key)) throw new Error("Ungültiger Plex-Eintrag");
    const j = await api(s, key);
    const entries = (j.MediaContainer?.Metadata ?? []).slice(0, MAX_ENTRIES).map((m) => {
      const kind = plexKind(m);
      const media = m.Media?.[0];
      const part = media?.Part?.[0];
      if (kind === "folder") return { key: `/library/metadata/${m.ratingKey}/children`, kind, name: m.title, thumb: m.thumb || undefined };
      if (!part?.key) return null;
      return {
        key: part.key, kind, name: m.parentTitle && m.type === "episode" ? `${m.grandparentTitle ?? ""} ${m.parentIndex != null ? "S" + m.parentIndex : ""}E${m.index ?? ""} ${m.title}`.trim() : m.title,
        size: part.size, duration: m.duration ? Math.round(m.duration / 1000) : undefined, width: media.width, height: media.height,
        codec: media.videoCodec, container: part.container ?? media.container, thumb: m.thumb || undefined,
      };
    }).filter(Boolean);
    return { entries, crumbs: [] };
  }

  const jfKind = (it) => (["Movie", "Episode", "Video", "MusicVideo", "Trailer"].includes(it.Type) ? "video" : it.Type === "Photo" ? "image" : it.IsFolder ? "folder" : null);
  async function browseJellyfin(s, key) {
    if (!key) {
      const libs = await api(s, "/Library/VirtualFolders");
      return { entries: (libs ?? []).filter((l) => ["movies", "tvshows", "homevideos", "photos", "mixed", null, undefined].includes(l.CollectionType)).map((l) => ({ key: l.ItemId, kind: "folder", name: l.Name })), crumbs: [] };
    }
    if (!/^[\da-f-]{16,40}$/i.test(key)) throw new Error("Ungültiger Jellyfin-Eintrag");
    const j = await api(s, `/Items?ParentId=${key}&SortBy=IsFolder,SortName&SortOrder=Descending,Ascending&Fields=MediaStreams,MediaSources,Path&Limit=${MAX_ENTRIES}`);
    const entries = (j.Items ?? []).map((it) => {
      const kind = jfKind(it);
      if (!kind) return null;
      const v = (it.MediaStreams ?? it.MediaSources?.[0]?.MediaStreams ?? []).find((m) => m.Type === "Video");
      return {
        key: it.Id, kind, name: it.Type === "Episode" && it.SeriesName ? `${it.SeriesName} S${it.ParentIndexNumber ?? "?"}E${it.IndexNumber ?? "?"} ${it.Name}` : it.Name,
        duration: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 1e7) : undefined, width: v?.Width, height: v?.Height,
        codec: v?.Codec, bits: v?.BitDepth, hdr: v?.VideoRange && v.VideoRange !== "SDR" ? (v.VideoRangeType ?? v.VideoRange) : undefined,
        container: it.MediaSources?.[0]?.Container ?? it.Container, size: it.MediaSources?.[0]?.Size, thumb: it.ImageTags?.Primary ? true : undefined,
      };
    }).filter(Boolean);
    return { entries, crumbs: [] };
  }

  async function browse(id, key) {
    const s = find(id);
    if (!s) throw new Error("Quelle nicht gefunden");
    try {
      const out = s.type === "folder" ? await browseFolder(s, key) : s.type === "plex" ? await browsePlex(s, key) : await browseJellyfin(s, key);
      s.status = { ok: true, at: Date.now() };
      return out;
    } catch (e) {
      s.status = { ok: false, error: e.message, at: Date.now() };
      throw e;
    }
  }

  // ---- streaming and thumbnails through this server ----
  function folderFile(s, key) {
    const root = fs.realpathSync(s.path);
    const full = fs.realpathSync(path.join(root, key));
    if (!full.startsWith(root + path.sep)) throw new Error("not found");
    return full;
  }

  function serveLocal(req, res, full) {
    const st = fs.statSync(full);
    const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] === "" ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : st.size - 1;
      if (!(start >= 0) || start >= st.size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${st.size}` }); return res.end(); }
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Accept-Ranges": "bytes" });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(full).pipe(res);
  }

  async function proxy(req, res, url, s) {
    const h = { ...headers(s) };
    delete h.Accept;
    if (req.headers.range) h.Range = req.headers.range;
    const ctrl = new AbortController();
    req.on("close", () => ctrl.abort());
    const r = await fetch(url, { headers: h, signal: ctrl.signal });
    const out = {};
    for (const k of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
      const v = r.headers.get(k);
      if (v) out[k] = v;
    }
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
  }

  function streamUrl(s, key) {
    if (s.type === "plex") {
      if (!/^\/library\/parts\/\d+\//.test(key)) throw new Error("not found");
      return s.url + key;
    }
    if (!/^[\da-f-]{16,40}$/i.test(key)) throw new Error("not found");
    return `${s.url}/Items/${key}/Download`;
  }

  async function serve(req, res, id, key) {
    const s = find(id);
    if (!s) { res.writeHead(404); return res.end(); }
    try {
      if (s.type === "folder") return serveLocal(req, res, folderFile(s, key));
      // Jellyfin: videos through the stream endpoint (static = the file as it is), pictures as download
      if (s.type === "jellyfin" && req.headers["x-kind"] !== "image") {
        const u = `${s.url}/Videos/${key}/stream?static=true`;
        if (!/^[\da-f-]{16,40}$/i.test(key)) throw new Error("not found");
        return await proxy(req, res, u, s);
      }
      return await proxy(req, res, streamUrl(s, key), s);
    } catch {
      if (!res.headersSent) { res.writeHead(404); res.end(); }
    }
  }

  // thumbnails: Plex/Jellyfin deliver their own, a folder needs ffmpeg (cached) or gets the picture itself
  async function thumb(req, res, id, key) {
    const s = find(id);
    if (!s) { res.writeHead(404); return res.end(); }
    try {
      if (s.type === "plex") {
        if (!/^\/library\/metadata\/\d+\/thumb\/\d+$/.test(key)) throw new Error("bad");
        return await proxy(req, res, `${s.url}/photo/:/transcode?width=320&height=180&minSize=1&url=${encodeURIComponent(key)}`, s);
      }
      if (s.type === "jellyfin") {
        if (!/^[\da-f-]{16,40}$/i.test(key)) throw new Error("bad");
        return await proxy(req, res, `${s.url}/Items/${key}/Images/Primary?maxWidth=320&quality=80`, s);
      }
      const full = folderFile(s, key);
      const out = path.join(thumbsDir, "src-" + createHash("sha1").update(s.id + full + fs.statSync(full).mtimeMs).digest("hex").slice(0, 20) + ".jpg");
      if (fs.existsSync(out)) { res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" }); return fs.createReadStream(out).pipe(res); }
      const isImage = IMAGE_EXT.has(path.extname(full).toLowerCase());
      if (ffmpeg !== true) {
        if (isImage) return serveLocal(req, res, full);
        res.writeHead(404); return res.end();
      }
      execFile("ffmpeg", ["-v", "error", "-y", ...(isImage ? [] : ["-ss", "2"]), "-i", full, "-frames:v", "1", "-vf", "scale=320:-2", out], { timeout: 60_000 }, (err) => {
        if (err || !fs.existsSync(out)) {
          if (isImage) return serveLocal(req, res, full);
          res.writeHead(404); return res.end();
        }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
        fs.createReadStream(out).pipe(res);
      });
    } catch {
      if (!res.headersSent) { res.writeHead(404); res.end(); }
    }
  }

  // the item the TV shows (state.media.id = "src:<source id>:<key>")
  function item(fullId, info) {
    const m = /^src:([\da-f]+):(.+)$/s.exec(fullId ?? "");
    const s = m && find(m[1]);
    if (!s) return null;
    const kind = info?.kind === "image" ? "image" : "video";
    return { id: fullId, kind, name: info?.name ?? m[2], url: `/media/src/${s.id}?key=${encodeURIComponent(m[2])}&kind=${kind}`, source: s.type };
  }

  async function handle(req, res, p, sendJson, readBody) {
    const q = new URL(req.url, "http://x").searchParams;
    if (req.method === "GET" && p === "/api/sources") { sendJson(res, 200, { sources: list.map(view) }); return true; }
    if (req.method === "GET" && p === "/api/sources/browse") {
      sendJson(res, 200, { source: view(find(q.get("id")) ?? {}), ...(await browse(q.get("id"), q.get("key") ?? "")) });
      return true;
    }
    if (req.method === "POST" && p === "/api/sources") {
      const body = await readBody(req, 20_000);
      const { op, id } = body;
      if (op === "test") {
        const s = id && !body.source ? find(id) : clean(body.source, id ? find(id) : null);
        if (!s) throw new Error("Quelle nicht gefunden");
        const msg = await test(s);
        if (id && find(id)) find(id).status = { ok: true, at: Date.now() };
        sendJson(res, 200, { ok: true, message: msg });
        return true;
      }
      if (op === "add") {
        if (list.length >= 20) throw new Error("Höchstens 20 Quellen");
        list.push({ id: randomBytes(6).toString("hex"), ...clean(body.source) });
      } else if (op === "update") {
        const at = list.findIndex((s) => s.id === id);
        if (at < 0) throw new Error("Quelle nicht gefunden");
        list[at] = { id, ...clean(body.source, list[at]) };
      } else if (op === "remove") {
        list = list.filter((s) => s.id !== id);
      } else throw new Error("Unbekannte Aktion");
      save();
      sendJson(res, 200, { sources: list.map(view) });
      return true;
    }
    if (req.method === "GET" && p.startsWith("/media/src/")) {
      if (q.get("kind") === "image") req.headers["x-kind"] = "image";
      await serve(req, res, p.slice("/media/src/".length), q.get("key") ?? "");
      return true;
    }
    if (req.method === "GET" && p === "/api/sources/thumb") { await thumb(req, res, q.get("id"), q.get("key") ?? ""); return true; }
    return false;
  }

  return { handle, item };
}
