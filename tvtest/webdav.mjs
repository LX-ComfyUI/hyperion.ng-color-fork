// WebDAV (Nextcloud, many NAS and routers): PROPFIND with Depth 1 lists a folder, GET with a Range
// plays a file. User and password go with every request (Basic), so they are kept on the server like
// the keys of the other sources.
import path from "node:path";
import { Xml } from "./dlna.mjs";

const TIMEOUT = 8000;
const BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/></d:prop></d:propfind>';

export const auth = (s) => (s.user || s.password ? { Authorization: "Basic " + Buffer.from(`${s.user ?? ""}:${s.password ?? ""}`).toString("base64") } : {});
const folderUrl = (s) => s.url.replace(/\/*$/, "/");

// a relative key ("Urlaub/2024/a.mp4") to the address on the server; no way out of the base folder
export function urlOf(s, key, dir = false) {
  const parts = String(key ?? "").split("/").filter(Boolean);
  if (parts.some((p) => p === ".." || p === ".")) throw new Error("not found");
  return folderUrl(s) + parts.map(encodeURIComponent).join("/") + (dir && parts.length ? "/" : "");
}

// the entries of a folder: { key, name, dir, size, type, date }
export async function list(s, key) {
  const url = urlOf(s, key, true);
  let r;
  try {
    r = await fetch(url, { method: "PROPFIND", body: BODY, headers: { ...auth(s), Depth: "1", "Content-Type": 'application/xml; charset="utf-8"' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new Error(`WebDAV nicht erreichbar (${e.cause?.code ?? e.name})`);
  }
  if (r.status === 401) throw new Error("WebDAV: Benutzer oder Passwort falsch");
  if (r.status === 404) throw new Error("Diesen Ordner gibt es auf dem WebDAV-Server nicht");
  if (r.status === 405 || r.status === 501) throw new Error("Unter dieser Adresse ist kein WebDAV-Ordner");
  if (!r.ok) throw new Error(`Antwort ${r.status} von WebDAV`);
  const xml = await r.text();
  const self = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
  const base = decodeURIComponent(new URL(folderUrl(s)).pathname).replace(/\/+$/, "");
  const out = [];
  for (const resp of Xml.tags(xml, "response")) {
    const href = Xml.text(resp.body, "href");
    if (!href) continue;
    let p;
    try { p = decodeURIComponent(new URL(href, url).pathname).replace(/\/+$/, ""); } catch { continue; }
    if (p === self || !p.startsWith(base + "/")) continue;
    // only what answered 200 (some servers list properties they lack with 404)
    const ok = Xml.tags(resp.body, "propstat").find((ps) => /\s200\s/.test(Xml.text(ps.body, "status") ?? " 200 ")) ?? { body: resp.body };
    const name = path.posix.basename(p);
    if (!name || name.startsWith(".")) continue;
    out.push({
      key: p.slice(base.length + 1), name, dir: /<(?:[\w.-]+:)?collection\b/i.test(ok.body),
      size: Number(Xml.text(ok.body, "getcontentlength")) || undefined, type: Xml.text(ok.body, "getcontenttype") ?? "",
      date: Date.parse(Xml.text(ok.body, "getlastmodified") ?? "") || undefined,
    });
  }
  return out;
}
