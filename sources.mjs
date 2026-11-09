// More sources for the media library, added by the user: a folder on the server (a NAS share mounted
// there, read only; netshare.mjs understands network paths and helps mounting), Plex (address + token,
// or a login with a code on plex.tv/link), Jellyfin and Emby (address + API key, or user + password,
// which is used once for a key and never kept) and DLNA media servers (dlna.mjs, no login). The pages browse them
// through this server and the TV plays them through it too (/media/src/...), so tokens never leave the
// server and the TV needs no access to the NAS or the media server. Files are played as they are
// (direct play); whether the TV browser can play them is marked from the codec the server knows.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import * as Dlna from "./dlna.mjs";
import { parseInput, netLabel, resolveNet, netMountOf, probe, within, mountPlan, countDir, pickerRoots, environment } from "./netshare.mjs";

const TYPES = ["folder", "plex", "jellyfin", "emby", "dlna"];
const LABEL = { plex: "Plex", jellyfin: "Jellyfin", emby: "Emby", dlna: "DLNA" };
// Jellyfin and Emby share their API (Emby under /emby); their ids: Jellyfin GUIDs, Emby numbers
const MB = new Set(["jellyfin", "emby"]);
const MB_ID = /^[\w-]{1,64}$/;
const CLIENT = { product: "Hyperion TV-Testseite", id: "hyperion-tvtest" };
const MB_AUTH = `Client="${CLIENT.product}", Device="Testserver", DeviceId="${CLIENT.id}", Version="1.0"`;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".bmp"]);
const VIDEO_EXT = new Set([".mp4", ".m4v", ".webm", ".mov", ".mkv", ".ogv", ".avi", ".ts", ".m2ts"]);
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/x-m4v", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska", ".ogv": "video/ogg", ".avi": "video/x-msvideo", ".ts": "video/mp2t", ".m2ts": "video/mp2t" };
const MAX_ENTRIES = 2000;
const TIMEOUT = 8000;
const FS_TIMEOUT = 8000;
const mediaKind = (name) => { const e = path.extname(name).toLowerCase(); return IMAGE_EXT.has(e) ? "image" : VIDEO_EXT.has(e) ? "video" : null; };

// an error the page can act on (notMounted opens the helper for mounting the share)
const fail = (msg, extra) => Object.assign(new Error(msg), { extra });

const cleanUrl = (u, whole = false) => {
  let url;
  try { url = new URL(String(u ?? "").trim()); } catch { throw new Error("Bitte eine Adresse wie http://192.168.1.10:32400 eingeben"); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Die Adresse muss mit http:// oder https:// beginnen");
  return whole ? url.href : url.origin + url.pathname.replace(/\/+$/, "");
};

export function createSources({ dataDir, thumbsDir, notify = () => {} }) {
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
  const view = (s) => ({ id: s.id, type: s.type, name: s.name, path: s.path, remote: s.remote, url: s.url, hasToken: !!s.token, user: s.user, status: s.status ?? null });

  // a typed folder: a path on the server, or a network path (\\NAS\share\…) that is looked up among the
  // shares the server has mounted
  async function folderPath(raw) {
    const p = parseInput(raw);
    if (p.kind === "local") return { path: p.path };
    if (p.kind === "drive") throw new Error("Das ist ein Laufwerk auf einem Windows-PC. Die Testseite läuft auf dem Server und sieht es nicht. Gib den Ordner am PC im Netzwerk frei und trag den Netzwerkpfad ein (\\\\PC\\Freigabe\\Ordner).");
    if (p.kind !== "net") throw new Error("Bitte einen Ordner auf dem Server (z. B. /mnt/nas/videos) oder einen Netzwerkpfad (z. B. \\\\NAS\\Freigabe\\Ordner) eingeben");
    if (p.proto === "smb" && !p.share) throw fail("Im Netzwerkpfad fehlt der Name der Freigabe (\\\\NAS\\Freigabe\\Ordner)", { notMounted: p });
    const r = await resolveNet(p);
    if (!r) throw fail("Das ist ein Netzwerkpfad. Diese Freigabe ist auf dem Server noch nicht eingebunden.", { notMounted: p });
    return { path: r.local, remote: netLabel(p), mount: r.mount.target };
  }

  async function clean(input, old) {
    const type = TYPES.includes(input?.type) ? input.type : old?.type;
    if (!type) throw new Error("Unbekannte Art der Quelle");
    const out = { type, name: String(input?.name ?? old?.name ?? "").trim().slice(0, 60) };
    if (type === "folder") {
      const raw = String(input?.path ?? "").trim() || old?.remote || old?.path || "";
      const f = await folderPath(raw);
      out.path = f.path;
      if (f.remote) out.remote = f.remote;
      if (!out.name) out.name = path.basename(out.path) || out.path;
    } else if (type === "dlna") {
      out.url = cleanUrl(input?.url ?? old?.url, true);
      const d = await Dlna.describe(out.url, true).catch((e) => { throw e.message.startsWith("Antwort 404") ? new Error("Unter dieser Adresse liegt keine Gerätebeschreibung. Am einfachsten „Im Netz suchen“ benutzen.") : e; });
      if (!out.name) out.name = d.name;
    } else if (type === "plex" && input?.plexLink) {
      // signed in with a code: the server's own token from the sign-in, the page never sees it
      const link = plexLinks.get(String(input.plexLink.pin));
      const server = link?.servers?.[Number(input.plexLink.server)];
      if (!server) throw new Error("Die Plex-Anmeldung ist abgelaufen, bitte noch einmal anmelden");
      out.url = server.url;
      out.token = server.token;
      if (!out.name) out.name = server.name || "Plex";
    } else {
      out.url = cleanUrl(input?.url ?? old?.url);
      const token = String(input?.token ?? "").trim();
      const user = String(input?.user ?? "").trim();
      const password = String(input?.password ?? "");
      if (MB.has(type) && user && password) {
        // user + password once for a key of this server; the password is not kept
        Object.assign(out, await mbLogin({ type, url: out.url }, user, password));
      } else {
        out.token = token || old?.token || "";
        if (old?.userId && !token) { out.userId = old.userId; out.user = old.user; }
      }
      if (!out.token) throw new Error(type === "plex" ? "Der Plex-Token fehlt" : "Der API-Schlüssel fehlt (oder Benutzer und Passwort eingeben)");
      if (!out.name) out.name = LABEL[type];
    }
    return out;
  }

  // ---- talking to Plex, Jellyfin and Emby ----
  const headers = (s) => (s.type === "plex"
    ? { "X-Plex-Token": s.token, Accept: "application/json", "X-Plex-Client-Identifier": CLIENT.id, "X-Plex-Product": CLIENT.product }
    : MB.has(s.type) ? { "X-Emby-Token": s.token, Accept: "application/json" } : {});
  const base = (s) => s.url + (s.type === "emby" ? "/emby" : "");
  async function api(s, p, init = {}) {
    let r;
    try {
      r = await fetch(base(s) + p, { ...init, headers: { ...headers(s), ...init.headers }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      throw new Error(`${LABEL[s.type]} nicht erreichbar (${e.cause?.code ?? e.name})`);
    }
    if (r.status === 401 || r.status === 403) throw new Error(s.type === "plex" ? "Plex lehnt den Token ab" : init.login ? `${LABEL[s.type]}: Benutzer oder Passwort falsch` : `${LABEL[s.type]} lehnt den API-Schlüssel ab`);
    if (!r.ok) throw new Error(`Antwort ${r.status} von ${LABEL[s.type]}`);
    return r.json();
  }

  // Jellyfin/Emby: a login gives a key bound to that user (seeing only what the user may see)
  async function mbLogin(s, user, password) {
    const j = await api({ ...s, token: "" }, "/Users/AuthenticateByName", {
      method: "POST", login: true, body: JSON.stringify({ Username: user, Pw: password }),
      headers: { "Content-Type": "application/json", Authorization: `MediaBrowser ${MB_AUTH}`, "X-Emby-Authorization": `Emby ${MB_AUTH}` },
    });
    if (!j.AccessToken) throw new Error(`${LABEL[s.type]}: Benutzer oder Passwort falsch`);
    return { token: j.AccessToken, userId: j.User?.Id, user: j.User?.Name ?? user };
  }

  // ---- Plex sign-in with a code: plex.tv/link, then the servers of that account ----
  const plexLinks = new Map(); // pin id -> { at, code, token, servers }
  const plexTv = async (p, init = {}) => {
    let r;
    try {
      r = await fetch("https://plex.tv" + p, { ...init, headers: { Accept: "application/json", "X-Plex-Product": CLIENT.product, "X-Plex-Client-Identifier": CLIENT.id, ...init.headers }, signal: AbortSignal.timeout(TIMEOUT) });
    } catch (e) {
      throw new Error(`plex.tv nicht erreichbar (${e.cause?.code ?? e.name}). Der Server braucht für die Anmeldung Internet.`);
    }
    if (!r.ok) throw new Error(`Antwort ${r.status} von plex.tv`);
    return r.json();
  };
  async function plexPinStart() {
    for (const [k, v] of plexLinks) if (Date.now() - v.at > 30 * 60_000) plexLinks.delete(k);
    const j = await plexTv("/api/v2/pins", { method: "POST" });
    plexLinks.set(String(j.id), { at: Date.now(), code: j.code });
    return { pin: String(j.id), code: j.code };
  }
  // the servers of the account, each with an address that answers from here (local first)
  async function plexPinCheck(pin) {
    const link = plexLinks.get(String(pin));
    if (!link) throw new Error("Die Plex-Anmeldung ist abgelaufen, bitte noch einmal anmelden");
    if (link.servers) return { done: true, servers: link.servers.map(({ name, url, owned }) => ({ name, url, owned })) };
    const j = await plexTv(`/api/v2/pins/${encodeURIComponent(pin)}`);
    if (!j.authToken) return { done: false };
    link.token = j.authToken;
    const res = await plexTv("/api/v2/resources?includeHttps=1", { headers: { "X-Plex-Token": j.authToken } });
    const servers = [];
    for (const d of (Array.isArray(res) ? res : []).filter((x) => String(x.provides ?? "").includes("server"))) {
      const conns = (d.connections ?? []).filter((c) => !c.relay).sort((a, b) => (b.local - a.local));
      const tries = conns.flatMap((c) => [c.local && c.address && c.port ? `http://${c.address}:${c.port}` : null, c.uri]).filter(Boolean);
      let url = null;
      for (const u of [...new Set(tries)]) {
        const ok = await fetch(u + "/identity", { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
        if (ok) { url = u.replace(/\/+$/, ""); break; }
      }
      if (url) servers.push({ name: d.name, url, token: d.accessToken || j.authToken, owned: !!d.owned });
    }
    link.servers = servers;
    if (!servers.length) throw new Error("Angemeldet, aber kein Plex-Server dieses Kontos ist von hier aus erreichbar");
    return { done: true, servers: servers.map(({ name, url, owned }) => ({ name, url, owned })) };
  }

  // a folder may sit on a network share: checked in a child process first (see netshare.mjs), with a
  // message that says what is wrong
  async function ready(dir, fresh = false) {
    const r = await probe(dir, { fresh });
    if (r.ok) return;
    const m = await netMountOf(dir);
    if (r.why === "timeout") throw new Error("Die Netzwerkfreigabe antwortet nicht. Ist das NAS eingeschaltet und im Netz erreichbar?");
    if (r.why === "notdir") throw new Error("Das ist eine Datei, kein Ordner");
    if (m && dir !== m.target) {
      const root = await probe(m.target, { fresh });
      if (root.why === "timeout") throw new Error("Die Netzwerkfreigabe antwortet nicht. Ist das NAS eingeschaltet und im Netz erreichbar?");
      if (!root.ok && root.why !== "denied") throw new Error("Die Netzwerkfreigabe lässt sich nicht verbinden (NAS aus, Zugangsdaten falsch oder Freigabe umbenannt)");
    } else if (m && r.why === "missing") throw new Error("Die Netzwerkfreigabe lässt sich nicht verbinden (NAS aus, Zugangsdaten falsch oder Freigabe umbenannt)");
    if (r.why === "denied") throw new Error("Der Testserver darf diesen Ordner nicht lesen (Rechte). Bei einer Netzwerkfreigabe: beim Einbinden uid und gid des Testservers angeben.");
    throw new Error(m ? "Die Freigabe ist erreichbar, aber diesen Unterordner gibt es dort nicht" : "Diesen Ordner gibt es auf dem Server nicht");
  }

  async function test(s) {
    if (s.type === "folder") {
      await ready(s.path, true);
      const n = await countDir(s.path, mediaKind).catch(() => { throw new Error("Die Netzwerkfreigabe antwortet nicht. Ist das NAS eingeschaltet und im Netz erreichbar?"); });
      if (!n.images && !n.videos) return n.folders ? `Ordner lesbar: keine Bilder oder Videos direkt darin, ${n.folders} Unterordner` : "Ordner lesbar, aber leer";
      return `Ordner lesbar: ${n.videos} ${n.videos === 1 ? "Video" : "Videos"}, ${n.images} ${n.images === 1 ? "Bild" : "Bilder"}, ${n.folders} Unterordner`;
    }
    if (s.type === "plex") {
      const j = await api(s, "/library/sections");
      const n = j.MediaContainer?.Directory?.length ?? 0;
      return `Plex verbunden, ${n} ${n === 1 ? "Bibliothek" : "Bibliotheken"}`;
    }
    if (s.type === "dlna") {
      const d = await Dlna.describe(s.url, true);
      const top = (await Dlna.browse(s.url, "0", 200)).entries;
      return `${d.name} verbunden, ${top.length} ${top.length === 1 ? "Eintrag" : "Einträge"} oben`;
    }
    const info = await api(s, "/System/Info");
    const n = (await mbLibraries(s).catch(() => [])).length;
    return `${LABEL[s.type]} ${info.Version ?? ""} verbunden, ${n} ${n === 1 ? "Bibliothek" : "Bibliotheken"}`.replace("  ", " ");
  }

  // ---- browsing: key "" = top level; entries { key, kind: folder|image|video, name, ... } ----
  async function browseFolder(s, key) {
    await ready(s.path);
    const slow = "Die Netzwerkfreigabe antwortet nicht. Ist das NAS eingeschaltet und im Netz erreichbar?";
    const root = await within(fs.promises.realpath(s.path), FS_TIMEOUT, slow);
    const dir = await within(fs.promises.realpath(path.join(root, key || "")), FS_TIMEOUT, slow).catch(() => null);
    if (!dir || (dir !== root && !dir.startsWith(root + path.sep))) throw new Error("Ordner nicht gefunden");
    const ents = (await within(fs.promises.readdir(dir, { withFileTypes: true }), FS_TIMEOUT, slow)).filter((e) => !e.name.startsWith("."));
    const out = [];
    await within(Promise.all(ents.slice(0, MAX_ENTRIES).map(async (e) => {
      const rel = path.relative(root, path.join(dir, e.name));
      const ext = path.extname(e.name).toLowerCase();
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) isDir = (await fs.promises.stat(path.join(dir, e.name)).catch(() => null))?.isDirectory() ?? false;
      if (isDir) out.push({ key: rel, kind: "folder", name: e.name });
      else if (IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext)) {
        const st = await fs.promises.stat(path.join(dir, e.name)).catch(() => null);
        out.push({ key: rel, kind: IMAGE_EXT.has(ext) ? "image" : "video", name: e.name, size: st?.size, date: st ? Math.round(st.mtimeMs) : undefined, container: ext.slice(1), thumb: true });
      }
    })), 2 * FS_TIMEOUT, slow);
    out.sort((a, b) => ((b.kind === "folder") - (a.kind === "folder")) || a.name.localeCompare(b.name, "de", { numeric: true }));
    return { entries: out, truncated: ents.length > MAX_ENTRIES, crumbs: key ? key.split(path.sep).map((n, i, all) => ({ key: all.slice(0, i + 1).join(path.sep), name: n })) : [] };
  }

  const plexKind = (m) => (["movie", "episode", "clip", "video"].includes(m.type) ? "video" : m.type === "photo" ? "image" : "folder");
  async function browsePlex(s, key) {
    if (!key) {
      const j = await api(s, "/library/sections");
      return { entries: (j.MediaContainer?.Directory ?? []).filter((d) => ["movie", "show", "photo"].includes(d.type)).map((d) => ({ key: `/library/sections/${d.key}/all`, kind: "folder", name: d.title })), crumbs: [] };
    }
    if (!/^\/library\/(sections\/\d+\/all|metadata\/\d+\/children)$/.test(key)) throw new Error("Ungültiger Plex-Eintrag");
    const j = await api(s, key);
    const all = j.MediaContainer?.Metadata ?? [];
    const entries = all.slice(0, MAX_ENTRIES).map((m) => {
      const kind = plexKind(m);
      const media = m.Media?.[0];
      const part = media?.Part?.[0];
      if (kind === "folder") return { key: `/library/metadata/${m.ratingKey}/children`, kind, name: m.title, thumb: m.thumb || undefined };
      if (!part?.key) return null;
      return {
        key: part.key, kind, name: m.parentTitle && m.type === "episode" ? `${m.grandparentTitle ?? ""} ${m.parentIndex != null ? "S" + m.parentIndex : ""}E${m.index ?? ""} ${m.title}`.trim() : m.title,
        size: part.size, duration: m.duration ? Math.round(m.duration / 1000) : undefined, width: media.width, height: media.height,
        codec: media.videoCodec, container: part.container ?? media.container, thumb: m.thumb || undefined, date: m.addedAt ? m.addedAt * 1000 : undefined,
      };
    }).filter(Boolean);
    return { entries, truncated: all.length > MAX_ENTRIES, crumbs: [] };
  }

  const jfKind = (it) => (["Movie", "Episode", "Video", "MusicVideo", "Trailer"].includes(it.Type) ? "video" : it.Type === "Photo" ? "image" : it.IsFolder ? "folder" : null);
  // the libraries: with an API key (admin) all of them, with a user login the user's own views
  async function mbLibraries(s) {
    const VIDEO_LIBS = ["movies", "tvshows", "homevideos", "photos", "mixed", "musicvideos", null, undefined];
    if (s.userId) {
      const j = await api(s, `/Users/${s.userId}/Views`);
      return (j.Items ?? []).filter((l) => VIDEO_LIBS.includes(l.CollectionType)).map((l) => ({ key: l.Id, kind: "folder", name: l.Name }));
    }
    const libs = await api(s, "/Library/VirtualFolders");
    return (Array.isArray(libs) ? libs : []).filter((l) => VIDEO_LIBS.includes(l.CollectionType)).map((l) => ({ key: l.ItemId ?? l.Id, kind: "folder", name: l.Name }));
  }
  async function browseJellyfin(s, key) {
    if (!key) return { entries: await mbLibraries(s), crumbs: [] };
    if (!MB_ID.test(key)) throw new Error(`Ungültiger ${LABEL[s.type]}-Eintrag`);
    const j = await api(s, `${s.userId ? `/Users/${s.userId}` : ""}/Items?ParentId=${key}&SortBy=IsFolder,SortName&SortOrder=Descending,Ascending&Fields=MediaStreams,MediaSources,Path,DateCreated&Limit=${MAX_ENTRIES}`);
    const entries = (j.Items ?? []).map((it) => {
      const kind = jfKind(it);
      if (!kind) return null;
      const v = (it.MediaStreams ?? it.MediaSources?.[0]?.MediaStreams ?? []).find((m) => m.Type === "Video");
      return {
        key: it.Id, kind, name: it.Type === "Episode" && it.SeriesName ? `${it.SeriesName} S${it.ParentIndexNumber ?? "?"}E${it.IndexNumber ?? "?"} ${it.Name}` : it.Name,
        duration: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 1e7) : undefined, width: v?.Width, height: v?.Height,
        codec: v?.Codec, bits: v?.BitDepth, hdr: v?.VideoRange && v.VideoRange !== "SDR" ? (v.VideoRangeType ?? v.VideoRange) : undefined,
        container: it.MediaSources?.[0]?.Container ?? it.Container, size: it.MediaSources?.[0]?.Size, thumb: it.ImageTags?.Primary ? true : undefined,
        date: Date.parse(it.DateCreated ?? "") || undefined,
      };
    }).filter(Boolean);
    return { entries, truncated: (j.TotalRecordCount ?? 0) > entries.length, crumbs: [] };
  }

  // reachable or not, with a notice in the bell when a source goes away and when it is back
  function setStatus(s, ok, error) {
    s.status = ok ? { ok: true, at: Date.now() } : { ok: false, error, at: Date.now() };
    if (!ok && !s.offlineNoticed) { s.offlineNoticed = true; notify("sourceOffline", "critical", { name: s.name, error }); }
    if (ok && s.offlineNoticed) { s.offlineNoticed = false; notify("sourceOnline", "info", { name: s.name }); }
  }

  async function browse(id, key) {
    const s = find(id);
    if (!s) throw new Error("Quelle nicht gefunden");
    try {
      const out = s.type === "folder" ? await browseFolder(s, key) : s.type === "plex" ? await browsePlex(s, key) : s.type === "dlna" ? await browseDlna(s, key) : await browseJellyfin(s, key);
      setStatus(s, true);
      return out;
    } catch (e) {
      // a wrong key is no sign of a source that went away
      if (!/^(Ordner nicht gefunden|Ungültiger (Plex|Jellyfin|Emby|DLNA)-Eintrag)$/.test(e.message)) setStatus(s, false, e.message);
      throw e;
    }
  }

  // DLNA: the file addresses come with the listing and are kept for playing (dlnaItems)
  const dlnaItems = new Map(); // source id + object id -> { url, art }
  async function browseDlna(s, key) {
    const { entries, truncated } = await Dlna.browse(s.url, key || "0", MAX_ENTRIES);
    for (const e of entries) if (e.kind !== "folder") dlnaItems.set(s.id + "\n" + e.key, { url: e.url, art: e.art });
    if (dlnaItems.size > 20_000) dlnaItems.clear();
    return { entries: entries.map(({ url, art, ...e }) => ({ ...e, thumb: art ? true : undefined })), truncated, crumbs: [] };
  }
  async function dlnaItem(s, key) {
    const hit = dlnaItems.get(s.id + "\n" + key);
    if (hit) return hit;
    const it = await Dlna.item(s.url, key);
    if (!it) throw new Error("not found");
    dlnaItems.set(s.id + "\n" + key, { url: it.url, art: it.art });
    return it;
  }

  // all sources at once, when the page opens the list (no checks in the background: they would keep
  // the disks of a NAS from going to sleep)
  async function checkAll() {
    await Promise.all(list.map(async (s) => {
      try {
        if (s.type === "folder") await ready(s.path);
        else if (s.type === "dlna") await Dlna.describe(s.url, true);
        else await api(s, s.type === "plex" ? "/identity" : "/System/Info");
        setStatus(s, true);
      } catch (e) { setStatus(s, false, e.message); }
    }));
  }

  // ---- streaming and thumbnails through this server ----
  async function folderFile(s, key) {
    await ready(s.path);
    const root = await within(fs.promises.realpath(s.path), FS_TIMEOUT, "timeout");
    const full = await within(fs.promises.realpath(path.join(root, key)), FS_TIMEOUT, "timeout");
    if (!full.startsWith(root + path.sep)) throw new Error("not found");
    return full;
  }

  async function serveLocal(req, res, full) {
    const st = await within(fs.promises.stat(full), FS_TIMEOUT, "timeout");
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
    if (!MB_ID.test(key)) throw new Error("not found");
    return `${base(s)}/Items/${key}/Download`;
  }

  async function serve(req, res, id, key) {
    const s = find(id);
    if (!s) { res.writeHead(404); return res.end(); }
    try {
      if (s.type === "folder") return await serveLocal(req, res, await folderFile(s, key));
      if (s.type === "dlna") return await proxy(req, res, (await dlnaItem(s, key)).url, s);
      // Jellyfin/Emby: videos through the stream endpoint (static = the file as it is), pictures as download
      if (MB.has(s.type) && req.headers["x-kind"] !== "image") {
        if (!MB_ID.test(key)) throw new Error("not found");
        return await proxy(req, res, `${base(s)}/Videos/${key}/stream?static=true`, s);
      }
      return await proxy(req, res, streamUrl(s, key), s);
    } catch (e) {
      if (e.message !== "not found") setStatus(s, false, e.message === "timeout" ? "Die Netzwerkfreigabe antwortet nicht. Ist das NAS eingeschaltet und im Netz erreichbar?" : e.message);
      if (!res.headersSent) { res.writeHead(404); res.end(); }
    }
  }

  // at most two ffmpeg/ffprobe at a time: for a folder on a NAS each one reads over the network
  let ffRunning = 0;
  const ffQueue = [];
  function ffRun(tool, args, timeout, done) {
    if (ffRunning >= 2) return ffQueue.push(() => ffRun(tool, args, timeout, done));
    ffRunning++;
    execFile(tool, args, { timeout, maxBuffer: 4_000_000 }, (err, out) => {
      ffRunning--;
      ffQueue.shift()?.();
      done(err, out);
    });
  }
  const ffmpegThumb = (args, done) => ffRun("ffmpeg", args, 60_000, done);

  // thumbnails: Plex/Jellyfin/Emby/DLNA deliver their own, a folder needs ffmpeg (cached) or gets the picture itself
  async function thumb(req, res, id, key) {
    const s = find(id);
    if (!s) { res.writeHead(404); return res.end(); }
    try {
      if (s.type === "plex") {
        if (!/^\/library\/metadata\/\d+\/thumb\/\d+$/.test(key)) throw new Error("bad");
        return await proxy(req, res, `${s.url}/photo/:/transcode?width=320&height=180&minSize=1&url=${encodeURIComponent(key)}`, s);
      }
      if (MB.has(s.type)) {
        if (!MB_ID.test(key)) throw new Error("bad");
        return await proxy(req, res, `${base(s)}/Items/${key}/Images/Primary?maxWidth=320&quality=80`, s);
      }
      if (s.type === "dlna") {
        const it = await dlnaItem(s, key);
        if (!it.art) throw new Error("bad");
        return await proxy(req, res, it.art, s);
      }
      const full = await folderFile(s, key);
      const st = await within(fs.promises.stat(full), FS_TIMEOUT, "timeout");
      const out = path.join(thumbsDir, "src-" + createHash("sha1").update(s.id + full + st.mtimeMs).digest("hex").slice(0, 20) + ".jpg");
      if (fs.existsSync(out)) { res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" }); return fs.createReadStream(out).pipe(res); }
      const isImage = IMAGE_EXT.has(path.extname(full).toLowerCase());
      if (ffmpeg !== true) {
        if (isImage) return await serveLocal(req, res, full);
        res.writeHead(404); return res.end();
      }
      ffmpegThumb(["-v", "error", "-y", ...(isImage ? [] : ["-ss", "2"]), "-i", full, "-frames:v", "1", "-vf", "scale=320:-2", out], (err) => {
        if (err || !fs.existsSync(out)) {
          if (isImage) return serveLocal(req, res, full).catch(() => { if (!res.headersSent) { res.writeHead(404); res.end(); } });
          res.writeHead(404); return res.end();
        }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" });
        fs.createReadStream(out).pipe(res);
      });
    } catch {
      if (!res.headersSent) { res.writeHead(404); res.end(); }
    }
  }

  // codec, 10 bit, HDR and length of a video in a folder (the list shows whether the TV can play it);
  // ffprobe reads only the start of the file, results are kept for the session
  const probes = new Map(); // path + mtime -> info
  let ffprobe = null;
  execFile("ffprobe", ["-version"], (err) => { ffprobe = !err && process.env.TVTEST_NO_FFMPEG !== "1"; });
  async function probeVideo(id, key) {
    const s = find(id);
    if (!s || s.type !== "folder" || ffprobe !== true) return null;
    const full = await folderFile(s, key);
    const st = await within(fs.promises.stat(full), FS_TIMEOUT, "timeout");
    const ck = full + "\n" + st.mtimeMs;
    if (probes.has(ck)) return probes.get(ck);
    const info = await new Promise((resolve) => ffRun("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", full], 20_000, (err, out) => resolve(err ? null : readProbe(out))));
    if (probes.size > 5000) probes.clear();
    probes.set(ck, info);
    return info;
  }
  function readProbe(out) {
    let j;
    try { j = JSON.parse(out); } catch { return null; }
    const v = (j.streams ?? []).find((x) => x.codec_type === "video");
    if (!v) return null;
    const dur = Number(j.format?.duration);
    return {
      codec: v.codec_name ?? null, width: v.width, height: v.height, bits: /12/.test(v.pix_fmt ?? "") ? 12 : /10/.test(v.pix_fmt ?? "") ? 10 : 8,
      hdr: v.color_transfer === "smpte2084" ? "HDR10" : v.color_transfer === "arib-std-b67" ? "HLG" : undefined,
      duration: Number.isFinite(dur) ? Math.round(dur) : undefined, bitrate: Number(j.format?.bit_rate) || undefined,
    };
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
    if (req.method === "GET" && p === "/api/sources") {
      if (q.get("check") === "1") await checkAll();
      sendJson(res, 200, { sources: list.map(view) });
      return true;
    }
    // the folder picker: start points, or the folders inside one folder (names only, never files)
    if (req.method === "GET" && p === "/api/sources/dirs") {
      const dir = q.get("path");
      if (!dir) { sendJson(res, 200, { roots: await pickerRoots() }); return true; }
      if (!path.isAbsolute(dir)) throw new Error("Ungültiger Ordner");
      const at = path.normalize(dir);
      await ready(at, true);
      const slow = "Die Netzwerkfreigabe antwortet nicht. Ist das NAS eingeschaltet und im Netz erreichbar?";
      const ents = await within(fs.promises.readdir(at, { withFileTypes: true }), FS_TIMEOUT, slow);
      const dirs = [];
      let images = 0, videos = 0;
      for (const e of ents) {
        if (e.name.startsWith(".")) continue;
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) isDir = (await within(fs.promises.stat(path.join(at, e.name)), 3000, "").catch(() => null))?.isDirectory() ?? false;
        if (isDir) dirs.push(e.name);
        else { const k = mediaKind(e.name); if (k === "image") images++; else if (k === "video") videos++; }
      }
      dirs.sort((a, b) => a.localeCompare(b, "de", { numeric: true }));
      const m = await netMountOf(at);
      sendJson(res, 200, { path: at, parent: at === path.parse(at).root ? null : path.dirname(at), dirs: dirs.slice(0, 500), more: Math.max(0, dirs.length - 500), images, videos, net: !!m });
      return true;
    }
    if (req.method === "GET" && p === "/api/sources/browse") {
      sendJson(res, 200, { source: view(find(q.get("id")) ?? {}), ...(await browse(q.get("id"), q.get("key") ?? "")) });
      return true;
    }
    if (req.method === "POST" && p === "/api/sources") {
      const body = await readBody(req, 20_000);
      const { op, id } = body;
      try {
        return await post(res, sendJson, op, id, body);
      } catch (e) {
        if (!e.extra) throw e;
        sendJson(res, 400, { error: e.message, ...e.extra });
        return true;
      }
    }
    if (req.method === "GET" && p.startsWith("/media/src/")) {
      if (q.get("kind") === "image") req.headers["x-kind"] = "image";
      await serve(req, res, p.slice("/media/src/".length), q.get("key") ?? "");
      return true;
    }
    if (req.method === "GET" && p === "/api/sources/thumb") { await thumb(req, res, q.get("id"), q.get("key") ?? ""); return true; }
    if (req.method === "GET" && p === "/api/sources/probe") {
      sendJson(res, 200, { info: await probeVideo(q.get("id"), q.get("key") ?? "").catch(() => null) });
      return true;
    }
    return false;
  }

  async function post(res, sendJson, op, id, body) {
    if (op === "test") {
      const s = id && !body.source ? find(id) : await clean(body.source, id ? find(id) : null);
      if (!s) throw new Error("Quelle nicht gefunden");
      const msg = await test(s);
      if (id && find(id)) setStatus(find(id), true);
      // a network path that was found: the page shows where it is mounted
      sendJson(res, 200, { ok: true, message: msg, path: s.path, remote: s.remote });
      return true;
    }
    // the commands for mounting a share (see netshare.mjs); the server runs none of them
    if (op === "mountPlan") { sendJson(res, 200, await mountPlan(body.plan ?? {})); return true; }
    if (op === "env") { sendJson(res, 200, environment()); return true; }
    if (op === "discover") { sendJson(res, 200, { servers: await Dlna.discover() }); return true; }
    if (op === "plexPin") { sendJson(res, 200, await plexPinStart()); return true; }
    if (op === "plexPinCheck") { sendJson(res, 200, await plexPinCheck(body.pin)); return true; }
    if (op === "add") {
      if (list.length >= 20) throw new Error("Höchstens 20 Quellen");
      list.push({ id: randomBytes(6).toString("hex"), ...(await clean(body.source)) });
    } else if (op === "update") {
      const at = list.findIndex((s) => s.id === id);
      if (at < 0) throw new Error("Quelle nicht gefunden");
      list[at] = { id, ...(await clean(body.source, list[at])) };
    } else if (op === "remove") {
      list = list.filter((s) => s.id !== id);
    } else throw new Error("Unbekannte Aktion");
    save();
    sendJson(res, 200, { sources: list.map(view) });
    return true;
  }

  return { handle, item };
}
