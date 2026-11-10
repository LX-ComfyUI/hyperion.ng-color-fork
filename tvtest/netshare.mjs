// Network shares for the folder source: understands what people paste (\\NAS\share\folder, smb://,
// nfs://, a path in quotes), finds the share among the ones the server has mounted or lists in
// /etc/fstab, writes the commands to mount one (the test server never gets admin rights for that) and
// checks paths on network mounts in a child process with a time limit: a share whose NAS is off can
// block every file access for minutes, and in this process that would stall the whole server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dns from "node:dns";
import { execFile, spawn } from "node:child_process";

const NET_FS = new Set(["cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs", "sshfs", "davfs", "fuse.davfs2", "fuse.rclone", "afpfs", "webdav"]);
const MOUNTS_FILE = process.env.TVTEST_MOUNTS ?? "/proc/mounts";
const FSTAB_FILE = process.env.TVTEST_FSTAB ?? "/etc/fstab";
const PROBE_MS = 4000;

const unesc = (s) => s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)));
const fstabEsc = (s) => s.replace(/[\\ \t]/g, (c) => "\\" + c.charCodeAt(0).toString(8).padStart(3, "0"));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const segs = (s) => s.split(/[\\/]+/).filter(Boolean);
const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "nas";

// ---- what was typed ----
// { kind: "local", path } | { kind: "net", proto: "smb", host, share, sub[], user } | { kind: "net", proto: "nfs", host, rpath }
// | { kind: "drive" } (C:\… on a Windows PC) | { kind: "bad" }
export function parseInput(raw) {
  let s = String(raw ?? "").trim().replace(/^(["'])(.*)\1$/s, "$2").trim();
  if (!s) return { kind: "bad" };
  // on a Windows server a UNC path or a drive is just a path
  if (process.platform === "win32") return path.win32.isAbsolute(s) ? { kind: "local", path: s } : { kind: "bad" };
  if (/^[a-z]:[\\/]/i.test(s)) return { kind: "drive" };
  const url = /^(smb|cifs|nfs|file):\/\//i.exec(s);
  if (url) {
    let u;
    try { u = new URL(s.replace(/\\/g, "/")); } catch { return { kind: "bad" }; }
    const proto = u.protocol.slice(0, -1).toLowerCase();
    const parts = u.pathname.split("/").filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
    if (proto === "file") {
      if (!u.hostname || u.hostname === "localhost") return { kind: "local", path: "/" + parts.join("/") };
      if (!parts.length) return { kind: "bad" };
      return { kind: "net", proto: "smb", host: u.hostname, share: parts[0], sub: parts.slice(1), user: "" };
    }
    if (!u.hostname) return { kind: "bad" };
    if (proto === "nfs") return { kind: "net", proto: "nfs", host: u.hostname, rpath: "/" + parts.join("/") };
    if (!parts.length) return { kind: "net", proto: "smb", host: u.hostname, share: "", sub: [], user: decodeURIComponent(u.username || "") };
    return { kind: "net", proto: "smb", host: u.hostname, share: parts[0], sub: parts.slice(1), user: decodeURIComponent(u.username || "") };
  }
  // \\host\share\… or //host/share/…
  if (/^(\\\\|\/\/)[^\\/]/.test(s)) {
    const p = segs(s);
    return { kind: "net", proto: "smb", host: p[0], share: p[1] ?? "", sub: p.slice(2), user: "" };
  }
  // host:/export/path (how NFS is written)
  const nfs = /^([\w.-]+):(\/.*)$/.exec(s);
  if (nfs) return { kind: "net", proto: "nfs", host: nfs[1], rpath: path.posix.normalize(nfs[2]) };
  if (path.isAbsolute(s)) return { kind: "local", path: path.normalize(s) };
  return { kind: "bad" };
}

export function netLabel(n) {
  if (n.proto === "nfs") return `${n.host}:${n.rpath}`;
  return "\\\\" + [n.host, n.share, ...n.sub].filter(Boolean).join("\\");
}

// ---- mounted shares and the ones /etc/fstab knows (an automount there mounts on first access) ----
let mountCache = { at: 0, list: [] };
function readMountTable(file) {
  try { return fs.readFileSync(file, "utf8").split("\n"); } catch { return []; }
}
function parseSource(type, src) {
  if (/^(cifs|smb3|smbfs)$/.test(type)) {
    const p = segs(src);
    return p.length >= 2 ? { proto: "smb", host: p[0], share: p[1], prefix: p.slice(2) } : null;
  }
  if (/^nfs4?$/.test(type)) {
    const m = /^\[?([^\]]+?)\]?:(\/.*)?$/.exec(src);
    return m ? { proto: "nfs", host: m[1], export: path.posix.normalize(m[2] ?? "/") } : null;
  }
  return null;
}
async function darwinMounts() {
  // "//user@host/share on /Volumes/share (smbfs, nodev, …)"
  const out = await new Promise((r) => execFile("mount", { timeout: 3000 }, (err, so) => r(err ? "" : so)));
  return out.split("\n").map((l) => /^(\S+) on (.+) \((\w+)/.exec(l)).filter(Boolean)
    .map((m) => ({ source: m[1], target: m[2], type: m[3] === "smbfs" ? "cifs" : m[3] === "nfs" ? "nfs" : m[3], mounted: true }));
}
export async function netMounts() {
  if (Date.now() - mountCache.at < 5000) return mountCache.list;
  const list = [];
  const seen = new Set();
  const add = (m) => {
    if (!NET_FS.has(m.type) || seen.has(m.target)) return;
    seen.add(m.target);
    list.push({ ...m, net: parseSource(m.type, m.source) });
  };
  if (process.platform === "darwin") for (const m of await darwinMounts()) add(m);
  else {
    const mounted = readMountTable(MOUNTS_FILE).map((l) => l.split(/\s+/)).filter((f) => f.length >= 3).map((f) => ({ source: unesc(f[0]), target: unesc(f[1]), type: f[2], opts: f[3] ?? "" }));
    const autofs = new Set(mounted.filter((m) => m.type === "autofs").map((m) => m.target));
    for (const m of mounted) add({ source: m.source, target: m.target, type: m.type, mounted: true });
    for (const l of readMountTable(FSTAB_FILE)) {
      const f = l.trim().split(/\s+/);
      if (f.length < 3 || f[0].startsWith("#")) continue;
      const m = { source: unesc(f[0]), target: unesc(f[1]), type: f[2], opts: f[3] ?? "" };
      add({ source: m.source, target: m.target, type: m.type, mounted: false, fstab: true, automount: /x-systemd\.automount/.test(m.opts) && autofs.has(m.target) });
    }
  }
  mountCache = { at: Date.now(), list };
  return list;
}

// is this path on a network mount (then file access goes through probe() first)
export async function netMountOf(p) {
  const list = await netMounts();
  let best = null;
  for (const m of list) if ((p === m.target || p.startsWith(m.target.replace(/\/$/, "") + "/")) && (!best || m.target.length > best.target.length)) best = m;
  return best;
}

// ---- the same host under other names: NAS-AO-Asus, nas-ao-asus.local, its address, its Tailscale name ----
const hostCache = new Map();
async function hostKeys(h) {
  const lower = h.toLowerCase().replace(/\.$/, "");
  const hit = hostCache.get(lower);
  if (hit && Date.now() - hit.at < 60_000) return hit.keys;
  const keys = new Set([lower]);
  if (!/^[\d.]+$|:/.test(lower)) keys.add(lower.split(".")[0]);
  const ips = await Promise.race([dns.promises.lookup(lower, { all: true }).catch(() => []), new Promise((r) => setTimeout(() => r([]), 2000))]);
  for (const a of ips) keys.add(a.address);
  hostCache.set(lower, { at: Date.now(), keys });
  return keys;
}
async function sameHost(a, b) {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const [ka, kb] = await Promise.all([hostKeys(a), hostKeys(b)]);
  for (const k of ka) if (kb.has(k)) return true;
  return false;
}

// the local folder of a network path, or null when the server has not mounted that share
export async function resolveNet(n) {
  const eq = (x, y) => x.toLowerCase() === y.toLowerCase();
  for (const m of await netMounts()) {
    if (!m.net || m.net.proto !== n.proto) continue;
    if (n.proto === "smb") {
      if (!eq(m.net.share, n.share) || m.net.prefix.length > n.sub.length || !m.net.prefix.every((p, i) => eq(p, n.sub[i]))) continue;
      if (!(await sameHost(m.net.host, n.host))) continue;
      return { local: path.join(m.target, ...n.sub.slice(m.net.prefix.length)), mount: m };
    }
    const ex = m.net.export.replace(/\/$/, "");
    if (n.rpath !== ex && !n.rpath.startsWith(ex + "/")) continue;
    if (!(await sameHost(m.net.host, n.host))) continue;
    return { local: path.join(m.target, n.rpath.slice(ex.length)), mount: m };
  }
  return null;
}

// ---- checking a folder without risking this process: a child with a time limit ----
// { ok } | { ok: false, why: "timeout" | "missing" | "denied" | "notdir" }
const probeCache = new Map();
export function probe(dir, { fresh = false } = {}) {
  const hit = probeCache.get(dir);
  if (!fresh && hit && (!hit.r || Date.now() - hit.at < (hit.r.ok ? 15_000 : 5000))) return hit.p;
  const p = new Promise((resolve) => {
    if (process.platform === "win32") {
      // no sh there; a stat with a time limit is the best we can do
      const t = setTimeout(() => resolve({ ok: false, why: "timeout" }), PROBE_MS);
      fs.promises.stat(dir).then((st) => resolve(st.isDirectory() ? { ok: true } : { ok: false, why: "notdir" }), (e) => resolve({ ok: false, why: e.code === "EACCES" ? "denied" : "missing" })).finally(() => clearTimeout(t));
      return;
    }
    execFile("sh", ["-c", 'test -e "$1" || exit 2; test -d "$1" || exit 4; test -r "$1" -a -x "$1" || exit 3; ls -f "$1" >/dev/null 2>&1 || exit 3', "sh", dir], { timeout: PROBE_MS, killSignal: "SIGKILL" }, (err) => {
      if (!err) return resolve({ ok: true });
      if (err.killed || err.signal) return resolve({ ok: false, why: "timeout" });
      resolve({ ok: false, why: err.code === 2 ? "missing" : err.code === 4 ? "notdir" : "denied" });
    });
  });
  const entry = { at: Date.now(), p, r: null };
  probeCache.set(dir, entry);
  p.then((r) => { entry.r = r; entry.at = Date.now(); });
  return p;
}

// any promise with a time limit (for file access after a good probe, so a share that goes away in
// between cannot leave a request hanging)
export function within(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}

// ---- the commands to mount a share, shown on the page to copy (run once by someone with admin rights) ----
const which = (cmds) => cmds.find((c) => ["/usr/bin/", "/bin/", "/usr/sbin/", "/sbin/"].some((d) => fs.existsSync(d + c)));
function installCmd(proto) {
  const pkg = {
    apt: proto === "smb" ? "cifs-utils" : "nfs-common", dnf: proto === "smb" ? "cifs-utils" : "nfs-utils",
    pacman: proto === "smb" ? "cifs-utils" : "nfs-utils", zypper: proto === "smb" ? "cifs-utils" : "nfs-client", apk: proto === "smb" ? "cifs-utils" : "nfs-utils",
  };
  const pm = which(["apt-get", "dnf", "pacman", "zypper", "apk"]);
  return pm === "apt-get" ? `sudo apt install ${pkg.apt}` : pm === "dnf" ? `sudo dnf install ${pkg.dnf}` : pm === "pacman" ? `sudo pacman -S ${pkg.pacman}`
    : pm === "zypper" ? `sudo zypper install ${pkg.zypper}` : pm === "apk" ? `sudo apk add ${pkg.apk}` : `sudo apt install ${pkg.apt}`;
}

export function environment() {
  return {
    platform: process.platform,
    docker: fs.existsSync("/.dockerenv") || /docker|containerd|kubepods/.test(readMountTable("/proc/1/cgroup").join("\n")),
    systemd: fs.existsSync("/run/systemd/system"),
    smbTool: !!which(["mount.cifs"]),
    nfsTool: !!which(["mount.nfs"]),
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    user: os.userInfo().username,
  };
}

// input { proto, host, share (or export for NFS), sub, user, guest, target, lang }
export async function mountPlan(input) {
  const env = environment();
  const de = input.lang !== "en";
  const proto = input.proto === "nfs" ? "nfs" : "smb";
  const host = String(input.host ?? "").trim().replace(/^\\\\|^\/\//, "").replace(/[\\/].*$/, "");
  if (!/^[\w.:\[\]-]+$/.test(host)) throw new Error("Bitte die Adresse des NAS eingeben, z. B. 192.168.1.20 oder NAS-Name");
  const share = proto === "nfs" ? "/" + segs(String(input.share ?? "")).join("/") : segs(String(input.share ?? ""))[0] ?? "";
  if (!share || share === "/") throw new Error(proto === "nfs" ? "Bitte den Export eingeben, z. B. /volume1/video" : "Bitte den Namen der Freigabe eingeben");
  const sub = segs(String(input.sub ?? ""));
  const hostName = /^[\d.]+$|:/.test(host) ? "nas" : slug(host.split(".")[0]);
  let target = String(input.target ?? "").trim() || `/mnt/${hostName}-${slug(proto === "nfs" ? segs(share).at(-1) : share)}`;
  if (!path.isAbsolute(target) || /[\n'"]/.test(target)) throw new Error("Der Ordner zum Einbinden muss ein vollständiger Pfad sein, z. B. /mnt/nas");
  target = path.normalize(target).replace(/\/$/, "");
  const mounts = await netMounts();
  const taken = mounts.find((m) => m.target === target);
  const net = proto === "nfs" ? { proto, host, rpath: share } : { proto, host, share, sub: [], user: "" };
  const already = await resolveNet(net);
  const name = path.basename(target);
  const cred = `/etc/tvtest-shares/${name}.cred`;
  const guest = proto === "smb" && !!input.guest;
  const user = String(input.user ?? "").trim();
  const steps = [];
  const warnings = [];
  if (env.platform !== "linux") {
    return { env, steps: [], target, local: null, warnings: [env.platform === "darwin"
      ? "Auf einem Mac: im Finder „Gehe zu“ → „Mit Server verbinden“ und smb://NAS/Freigabe eingeben. Danach liegt die Freigabe unter /Volumes/<Freigabe>, diesen Ordner hier eintragen."
      : "Auf diesem Betriebssystem bitte die Freigabe selbst einbinden und den Ordner hier eintragen."] };
  }
  if (already) warnings.push("Diese Freigabe ist auf dem Server schon eingebunden: {a}");
  else if (taken) warnings.push("Unter {b} ist schon etwas anderes eingebunden oder eingetragen. Bitte einen anderen Ordner zum Einbinden wählen.");
  if (env.docker) warnings.push("Die Testseite läuft in einem Container. Die Befehle auf dem Rechner ausführen, auf dem der Container läuft, und den Ordner danach in den Container durchreichen (zum Beispiel -v {b}:{b}:ro).");
  if (proto === "smb" ? !env.smbTool : !env.nfsTool) steps.push({ title: proto === "smb" ? "Werkzeug für Windows-Freigaben installieren" : "Werkzeug für NFS installieren", cmd: installCmd(proto) });
  if (proto === "smb" && !guest) {
    const ask = user ? `u=${shq(user)}` : `read -rp ${shq(de ? "Benutzer am NAS: " : "User on the NAS: ")} u`;
    steps.push({
      title: "Zugangsdaten sicher ablegen (fragt das Passwort ab, es landet nicht im Befehlsverlauf und nur Administratoren können die Datei lesen)",
      cmd: `sudo install -d -m 700 /etc/tvtest-shares\n${ask}; read -rsp ${shq(de ? "Passwort: " : "Password: ")} p; echo\nprintf 'username=%s\\npassword=%s\\n' "$u" "$p" | sudo sh -c ${shq(`umask 077; cat > ${cred}`)}; unset p`,
    });
  }
  const own = env.uid != null ? `,uid=${env.uid},gid=${env.gid}` : "";
  const auto = env.systemd ? ",x-systemd.automount,x-systemd.mount-timeout=20,x-systemd.idle-timeout=30min" : "";
  const line = proto === "smb"
    ? `${fstabEsc(`//${host}/${share}`)} ${fstabEsc(target)} cifs ro,${guest ? "guest" : `credentials=${fstabEsc(cred)}`}${own},iocharset=utf8,file_mode=0444,dir_mode=0555,nofail,_netdev${auto} 0 0`
    : `${fstabEsc(`${host}:${share}`)} ${fstabEsc(target)} nfs ro,soft,timeo=50,retrans=2,nofail,_netdev${auto} 0 0`;
  steps.push({ title: "Ordner zum Einbinden anlegen", cmd: `sudo mkdir -p ${shq(target)}` });
  steps.push({
    title: "In /etc/fstab eintragen (mit Sicherung vorher): nur lesend, verbindet erst beim ersten Zugriff, der Server startet auch, wenn das NAS aus ist",
    cmd: `sudo cp /etc/fstab /etc/fstab.bak-tvtest\necho ${shq(line)} | sudo tee -a /etc/fstab`,
  });
  steps.push({
    title: "Einbinden und kurz prüfen (zeigt den Inhalt der Freigabe)",
    cmd: env.systemd ? `sudo systemctl daemon-reload\nsudo systemctl start "$(systemd-escape -p --suffix=automount ${shq(target)})"\nls ${shq(target)}` : `sudo mount ${shq(target)}\nls ${shq(target)}`,
  });
  return { env, steps, line, target, local: path.join(target, ...sub), already: already ? already.mount.target : null, taken: !!taken && !already, warnings, guest, proto, cred: proto === "smb" && !guest ? cred : null, host, share };
}

// first level below the folder, for the test and the folder picker: how many pictures, videos, folders
export async function countDir(dir, isMedia) {
  const ents = await within(fs.promises.readdir(dir, { withFileTypes: true }), 8000, "timeout");
  let images = 0, videos = 0, folders = 0;
  for (const e of ents) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) folders++;
    else { const k = isMedia(e.name); if (k === "image") images++; else if (k === "video") videos++; }
  }
  return { images, videos, folders };
}

// where the folder picker starts: shares, /mnt, /media, the home folder
export async function pickerRoots() {
  const out = [];
  const seen = new Set();
  const add = (p, kind, label) => { if (!seen.has(p)) { seen.add(p); out.push({ path: p, kind, label }); } };
  for (const m of await netMounts()) add(m.target, "net", m.net ? (m.net.proto === "nfs" ? `${m.net.host}:${m.net.export}` : netLabel({ ...m.net, sub: m.net.prefix })) : m.source);
  for (const base of ["/mnt", "/media", `/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, "/Volumes"]) {
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".") && !(base === "/media" && e.name === os.userInfo().username)) add(path.join(base, e.name), "local", "");
  }
  add(os.homedir(), "home", "");
  return out;
}

// ---- running the planned steps itself (opt-in, Linux only) ----
// Only the steps mountPlan writes, built here from checked parts: every command is a fixed argument list
// (nothing typed is ever put into a shell line), the passwords travel through stdin and are never logged
// or stored. sudo is asked for them in the one place they are needed.
const scrub = (t, secrets) => secrets.filter(Boolean).reduce((x, p) => x.split(p).join("***"), String(t)).slice(-1500);
function run(argv, { stdin = "", timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    if (process.env.TVTEST_MOUNT_DRYRUN === "1") return resolve({ ok: true, out: "(Probelauf) " + argv.join(" ") });
    const c = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C.UTF-8" } });
    let out = "";
    const t = setTimeout(() => { out += "\n(Zeitlimit)"; c.kill("SIGKILL"); }, timeout);
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { out += d; });
    c.on("error", (e) => { clearTimeout(t); resolve({ ok: false, out: e.message }); });
    c.on("close", (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.trim() }); });
    c.stdin.on("error", () => {});
    c.stdin.end(stdin);
  });
}
export async function sudoFree() {
  if (process.env.TVTEST_MOUNT_DRYRUN === "1") return process.env.TVTEST_MOUNT_SUDO === "pw" ? false : true;
  return (await run(["sudo", "-n", "true"], { timeout: 5000 })).ok;
}
// input = the same as mountPlan; secrets = { sudo, nas }; returns { ok, log: [{ title, ok, out }], local }
export async function mountRun(input, secrets = {}) {
  const plan = await mountPlan(input);
  const log = [];
  const fail = (title, out) => { log.push({ title, ok: false, out: scrub(out, [secrets.sudo, secrets.nas]) }); return { ok: false, log, target: plan.target, local: plan.local }; };
  if (plan.env.platform !== "linux") throw new Error("Das Einbinden aus der Seite gibt es nur auf Linux");
  if (plan.env.docker) throw new Error("Die Testseite läuft in einem Container und kann dort nichts einbinden");
  if (plan.already) return { ok: true, log: [{ title: "Schon eingebunden", ok: true, out: plan.already }], target: plan.already, local: plan.local };
  if (plan.taken) throw new Error("Unter diesem Ordner ist schon etwas anderes eingebunden oder eingetragen. Bitte einen anderen Ordner zum Einbinden wählen.");
  const free = await sudoFree();
  if (!free && !secrets.sudo) throw new Error("Bitte das Administratorpasswort des Servers eingeben");
  if (/[\r\n]/.test(String(secrets.sudo ?? "")) || /[\r\n]/.test(String(secrets.nas ?? "")) || /[\r\n]/.test(String(input.user ?? ""))) throw new Error("Zeilenumbrüche sind in Benutzer und Passwort nicht erlaubt");
  const pw = free ? "" : secrets.sudo + "\n";
  const sudo = (argv, stdin = "", timeout) => run(["sudo", "-S", "-p", "", ...argv], { stdin: pw + stdin, timeout });
  const step = async (title, r) => { log.push({ title, ok: r.ok, out: scrub(r.out, [secrets.sudo, secrets.nas]) }); return r.ok; };

  if (!free) {
    // wrong password: stop here, with a clear message instead of a failing later step
    const t = await sudo(["-v"], "", 15000);
    if (!t.ok) return fail("Administratorpasswort prüfen", /incorrect|Sorry|Falsches|falsch/i.test(t.out) ? "Das Administratorpasswort stimmt nicht." : t.out);
  }
  if ((input.proto === "nfs" ? !plan.env.nfsTool : !plan.env.smbTool)) {
    if (!which(["apt-get"])) return fail("Werkzeug installieren", "Bitte das Werkzeug für Netzwerkfreigaben selbst installieren (siehe Schritt 1 in der Liste).");
    if (!(await step("Werkzeug für Netzwerkfreigaben installieren", await sudo(["apt-get", "install", "-y", plan.proto === "smb" ? "cifs-utils" : "nfs-common"], "", 240000)))) return { ok: false, log, target: plan.target, local: plan.local };
  }
  if (plan.cred) {
    const user = String(input.user ?? "").trim();
    if (!user || !secrets.nas) return fail("Zugangsdaten ablegen", "Bitte Benutzer und Passwort am NAS eingeben (oder „Ohne Anmeldung“ wählen).");
    const r = await sudo(["sh", "-c", 'install -d -m 700 /etc/tvtest-shares && umask 077 && cat > "$1"', "sh", plan.cred], `username=${user}\npassword=${secrets.nas}\n`);
    if (!(await step("Zugangsdaten sicher ablegen", r))) return { ok: false, log, target: plan.target, local: plan.local };
  }
  if (!(await step("Ordner zum Einbinden anlegen", await sudo(["mkdir", "-p", plan.target])))) return { ok: false, log, target: plan.target, local: plan.local };
  let tab = "";
  try { tab = fs.readFileSync(FSTAB_FILE, "utf8"); } catch {}
  const have = tab.split("\n").some((l) => l.trim().split(/\s+/)[1] === plan.line.split(" ")[1]);
  if (have) log.push({ title: "In /etc/fstab eintragen", ok: true, out: "Der Eintrag steht schon in /etc/fstab." });
  else {
    if (!(await step("Sicherung der /etc/fstab", await sudo(["cp", "/etc/fstab", "/etc/fstab.bak-tvtest"])))) return { ok: false, log, target: plan.target, local: plan.local };
    const r = await sudo(["sh", "-c", 'cat >> /etc/fstab'], (tab && !tab.endsWith("\n") ? "\n" : "") + plan.line + "\n");
    if (!(await step("In /etc/fstab eintragen (nur lesend)", r))) return { ok: false, log, target: plan.target, local: plan.local };
  }
  if (plan.env.systemd) {
    if (!(await step("systemd neu einlesen", await sudo(["systemctl", "daemon-reload"])))) return { ok: false, log, target: plan.target, local: plan.local };
    const unit = await run(["systemd-escape", "-p", "--suffix=automount", plan.target]);
    if (!unit.ok) return fail("Einbinden", unit.out);
    if (!(await step("Einbinden starten", await sudo(["systemctl", "start", unit.out])))) return { ok: false, log, target: plan.target, local: plan.local };
  } else if (!(await step("Einbinden", await sudo(["mount", plan.target])))) return { ok: false, log, target: plan.target, local: plan.local };
  const ls = await run(["ls", plan.target], { timeout: 25000 });
  log.push({ title: "Inhalt der Freigabe", ok: ls.ok, out: scrub(ls.out || (ls.ok ? "(leer)" : ""), [secrets.sudo, secrets.nas]) });
  return { ok: ls.ok, log, target: plan.target, local: plan.local };
}
