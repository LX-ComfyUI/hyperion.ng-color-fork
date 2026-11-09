// Finding sources in the network, so nobody has to know addresses: NAS with Windows or NFS shares
// (mDNS, as Bonjour/Avahi announce them, plus Tailscale devices that answer on the SMB port), Plex
// (its own discovery "GDM") and Jellyfin/Emby (their UDP discovery on port 7359). DLNA is in dlna.mjs.
// Everything only asks and listens for a few seconds; nothing is scanned.
import dgram from "node:dgram";
import net from "node:net";
import { execFile } from "node:child_process";

// ---- mDNS: one PTR question, answers come straight back to our port (legacy unicast, RFC 6762 6.7) ----
function dnsName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (off < buf.length && guard++ < 64) {
    const len = buf[off];
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString("utf8", off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join("."), end };
}
function parseDns(buf) {
  const recs = [];
  const qd = buf.readUInt16BE(4), counts = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let off = 12;
  for (let i = 0; i < qd; i++) off = dnsName(buf, off).end + 4;
  for (let i = 0; i < counts && off < buf.length; i++) {
    const n = dnsName(buf, off);
    off = n.end;
    const type = buf.readUInt16BE(off), len = buf.readUInt16BE(off + 8);
    const data = off + 10;
    const r = { name: n.name, type };
    if (type === 12) r.ptr = dnsName(buf, data).name;
    else if (type === 33) { r.port = buf.readUInt16BE(data + 4); r.target = dnsName(buf, data + 6).name; }
    else if (type === 1) r.a = [...buf.subarray(data, data + 4)].join(".");
    recs.push(r);
    off = data + len;
  }
  return recs;
}
function mdns(services, ms) {
  return new Promise((resolve) => {
    const recs = [];
    let sock;
    try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); } catch { return resolve([]); }
    sock.on("message", (m) => { try { recs.push(...parseDns(m)); } catch {} });
    sock.on("error", () => {});
    sock.bind(0, () => {
      for (const sv of services) {
        const q = Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
          ...sv.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0, 0, 12, 0x80, 1])]);
        sock.send(q, 5353, "224.0.0.251", () => {});
      }
    });
    setTimeout(() => {
      try { sock.close(); } catch {}
      const out = [];
      for (const sv of services) {
        for (const p of recs.filter((r) => r.type === 12 && r.name.toLowerCase() === sv.toLowerCase())) {
          const srv = recs.find((r) => r.type === 33 && r.name === p.ptr);
          const a = srv && recs.find((r) => r.type === 1 && r.name === srv.target);
          out.push({ service: sv, name: p.ptr.slice(0, -(sv.length + 1)), host: srv?.target?.replace(/\.$/, ""), address: a?.a, port: srv?.port });
        }
      }
      resolve(out);
    }, ms);
  });
}

const tcpOpen = (host, port, ms = 1200) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.setTimeout(ms, () => done(false));
  s.on("connect", () => done(true));
  s.on("error", () => done(false));
});

// devices in the Tailscale network of this server (if Tailscale is installed) that offer SMB
async function tailscaleShares() {
  const json = await new Promise((r) => execFile("tailscale", ["status", "--json"], { timeout: 3000 }, (err, out) => r(err ? null : out)));
  let st;
  try { st = JSON.parse(json); } catch { return []; }
  const peers = Object.values(st?.Peer ?? {}).filter((p) => p.Online && p.TailscaleIPs?.length).slice(0, 40);
  const found = await Promise.all(peers.map(async (p) => ((await tcpOpen(p.TailscaleIPs[0], 445)) ? p : null)));
  return found.filter(Boolean).map((p) => ({ name: p.HostName, host: (p.DNSName ?? "").replace(/\.$/, "") || p.TailscaleIPs[0], address: p.TailscaleIPs[0], via: "tailscale" }));
}

// NAS and PCs with shares: { name, host, address, proto }
export async function shares() {
  const [m, ts] = await Promise.all([mdns(["_smb._tcp.local", "_nfs._tcp.local"], 2500), tailscaleShares()]);
  const out = [];
  const seen = new Set();
  for (const r of m) {
    const key = (r.address ?? r.host) + r.service;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.name, host: r.host ?? r.address, address: r.address, proto: r.service.startsWith("_nfs") ? "nfs" : "smb", via: "lan" });
  }
  for (const t of ts) if (!out.some((o) => o.address === t.address)) out.push({ ...t, proto: "smb" });
  return out;
}

// ---- Plex GDM and Jellyfin/Emby discovery: one UDP question, JSON or header lines back ----
function udpAsk(msg, port, address, ms, parse) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try { sock = dgram.createSocket({ type: "udp4", reuseAddr: true }); } catch { return resolve([]); }
    sock.on("message", (m, rinfo) => { try { const r = parse(m.toString(), rinfo); if (r) found.set(r.url, r); } catch {} });
    sock.on("error", () => {});
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      sock.send(Buffer.from(msg), port, address, () => {});
      setTimeout(() => sock.send(Buffer.from(msg), port, address, () => {}), 400);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, ms);
  });
}

export function plex(ms = 2500) {
  return udpAsk("M-SEARCH * HTTP/1.1\r\n\r\n", 32414, "239.0.0.250", ms, (t, r) => {
    if (!/^HTTP\/1\.\d 200/.test(t)) return null;
    const h = Object.fromEntries(t.split(/\r?\n/).map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1].toLowerCase(), m[2].trim()]));
    if (h["content-type"] && !/plex\/media-server/.test(h["content-type"])) return null;
    return { name: h.name || r.address, url: `http://${r.address}:${h.port || 32400}` };
  });
}

// kind "jellyfin" or "emby"
export function mediaBrowser(kind, ms = 2500) {
  return udpAsk(kind === "emby" ? "who is EmbyServer?" : "Who is JellyfinServer?", 7359, "255.255.255.255", ms, (t) => {
    const j = JSON.parse(t);
    if (!j.Address) return null;
    return { name: j.Name || j.Address, url: String(j.Address).replace(/\/+$/, "") };
  });
}
