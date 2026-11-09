// DLNA/UPnP media servers (many NAS, routers, Windows media sharing): found in the network with SSDP,
// browsed through their ContentDirectory service (SOAP over HTTP), files fetched over plain HTTP. No
// login; the test server only reads. The XML is small and simple, so a few tolerant regular
// expressions read it (any namespace prefix, entities, CDATA).
import dgram from "node:dgram";

const TIMEOUT = 8000;
const PAGE = 500;

const xmlUnesc = (s) => String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-f]+);/gi, (m, e) => (e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" ? '"' : e === "apos" ? "'" : e === "amp" ? "&"
    : String.fromCodePoint(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
// elements by local name, whatever namespace prefix the server uses
const tags = (xml, name) => [...String(xml ?? "").matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>)`, "gi"))]
  .map((m) => ({ attrs: m[1], body: m[2] ?? "" }));
const text = (xml, name) => { const t = tags(xml, name)[0]; return t ? xmlUnesc(t.body).trim() : null; };
const attr = (attrs, name) => { const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs ?? ""); return m ? xmlUnesc(m[1]) : null; };

async function fetchText(url, init = {}) {
  let r;
  try {
    r = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeout ?? TIMEOUT) });
  } catch (e) {
    throw new Error(`Medienserver nicht erreichbar (${e.cause?.code ?? e.name})`);
  }
  if (!r.ok) throw new Error(`Antwort ${r.status} vom Medienserver`);
  return r.text();
}

// ---- finding servers: M-SEARCH to the SSDP group, answers carry the address of the description ----
export function discover(ms = 3000) {
  return new Promise((resolve) => {
    const found = new Set();
    let sock;
    try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); } catch { return resolve([]); }
    sock.on("message", (m) => {
      const loc = /^location:\s*(\S+)/im.exec(m.toString())?.[1];
      if (loc && /^https?:\/\//i.test(loc)) found.add(loc);
    });
    sock.on("error", () => {});
    sock.bind(0, () => {
      const msg = Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n');
      // twice: UDP gets lost now and then
      sock.send(msg, 1900, "239.255.255.250", () => {});
      setTimeout(() => sock.send(msg, 1900, "239.255.255.250", () => {}), 400);
    });
    setTimeout(async () => {
      try { sock.close(); } catch {}
      const out = await Promise.all([...found].map((u) => describe(u, true).then((d) => ({ url: u, name: d.name, model: d.model }), () => null)));
      resolve(out.filter(Boolean));
    }, ms);
  });
}

// ---- the description: name and where the ContentDirectory answers ----
const descCache = new Map();
export async function describe(location, fresh = false) {
  const hit = descCache.get(location);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.d;
  const xml = await fetchText(location, { timeout: 4000 });
  const service = tags(xml, "service").find((s) => /ContentDirectory/i.test(text(s.body, "serviceType") ?? ""));
  if (!service) throw new Error("Das Gerät ist kein Medienserver (kein ContentDirectory)");
  const base = text(xml, "URLBase") || location;
  const d = {
    name: text(xml, "friendlyName") || new URL(location).host,
    model: [text(xml, "manufacturer"), text(xml, "modelName")].filter(Boolean).join(" "),
    control: new URL(text(service.body, "controlURL"), base).href,
    serviceType: text(service.body, "serviceType"),
  };
  descCache.set(location, { at: Date.now(), d });
  return d;
}

async function soapBrowse(location, objectId, flag, start, count) {
  const d = await describe(location);
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>`
    + `<u:Browse xmlns:u="${xmlEsc(d.serviceType)}"><ObjectID>${xmlEsc(objectId)}</ObjectID><BrowseFlag>${flag}</BrowseFlag><Filter>*</Filter>`
    + `<StartingIndex>${start}</StartingIndex><RequestedCount>${count}</RequestedCount><SortCriteria></SortCriteria></u:Browse></s:Body></s:Envelope>`;
  const xml = await fetchText(d.control, { method: "POST", body, headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${d.serviceType}#Browse"` } });
  return { didl: text(xml, "Result") ?? "", returned: Number(text(xml, "NumberReturned") ?? 0), total: Number(text(xml, "TotalMatches") ?? 0) };
}

// "1:02:03.500" → seconds
const seconds = (d) => { const m = /^(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(d ?? ""); return m ? Math.round(+m[1] * 3600 + +m[2] * 60 + +m[3]) : undefined; };

// one DIDL-Lite item → entry; res = the file (the first resource of the right kind is the original)
function readItem(it) {
  const cls = text(it.body, "class") ?? "";
  const kind = /\.videoItem/i.test(cls) ? "video" : /\.imageItem/i.test(cls) ? "image" : null;
  if (!kind) return null;
  const res = tags(it.body, "res").map((r) => ({ url: xmlUnesc(r.body).trim(), info: attr(r.attrs, "protocolInfo") ?? "", size: Number(attr(r.attrs, "size")) || undefined, duration: seconds(attr(r.attrs, "duration")), resolution: attr(r.attrs, "resolution") }))
    .filter((r) => /^https?:\/\//i.test(r.url));
  const mine = res.filter((r) => r.info.split(":")[2]?.startsWith(kind + "/"));
  const main = mine[0] ?? res[0];
  if (!main) return null;
  // a small picture for the list: album art, else the smallest picture resource (servers often add a
  // thumbnail to videos too), else the picture itself
  const art = text(it.body, "albumArtURI");
  const small = res.filter((r) => r !== main && r.info.split(":")[2]?.startsWith("image/")).sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))[0];
  const [w, h] = (main.resolution ?? "").split("x").map(Number);
  const mime = main.info.split(":")[2] ?? "";
  // the DLNA profile names the codec (AVC_MP4_…, HEVC_…)
  const pn = /DLNA\.ORG_PN=([\w-]+)/.exec(main.info)?.[1] ?? "";
  const codec = /^AVC/i.test(pn) ? "h264" : /^HEVC/i.test(pn) ? "hevc" : /^VP9/i.test(pn) ? "vp9" : /^AV1/i.test(pn) ? "av1" : /^MPEG/i.test(pn) ? "mpeg2video" : undefined;
  return {
    key: attr(it.attrs, "id"), kind, name: text(it.body, "title") ?? "", size: main.size, duration: main.duration, width: w || undefined, height: h || undefined,
    container: mime.split("/")[1]?.replace(/^x-/, "").replace("matroska", "mkv").replace("quicktime", "mov"), url: main.url, codec,
    date: Date.parse(text(it.body, "date") ?? "") || undefined,
    art: /^https?:\/\//i.test(art ?? "") ? art : small ? small.url : kind === "image" ? main.url : null,
  };
}

// a folder of the server ("0" = top), as entries { key, kind, name, … } plus the file addresses
export async function browse(location, objectId = "0", max = 2000) {
  const out = [];
  let truncated = false;
  for (let start = 0; start < max;) {
    const r = await soapBrowse(location, objectId, "BrowseDirectChildren", start, Math.min(PAGE, max - start));
    for (const c of tags(r.didl, "container")) out.push({ key: attr(c.attrs, "id"), kind: "folder", name: text(c.body, "title") ?? "" });
    for (const it of tags(r.didl, "item")) { const e = readItem(it); if (e) out.push(e); }
    start += r.returned;
    if (!r.returned || start >= r.total) break;
    if (start >= max) truncated = true;
  }
  return { entries: out.filter((e) => e.key), truncated };
}

// one item again (after a restart of the test server the addresses are no longer known)
export async function item(location, objectId) {
  const r = await soapBrowse(location, objectId, "BrowseMetadata", 0, 1);
  const it = tags(r.didl, "item")[0];
  return it ? readItem(it) : null;
}
