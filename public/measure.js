// Picture measurement of the media library ("Bild messen"): the TV shows a picture, this page takes the
// grabber frames Hyperion streams for the preview (after the grabber color correction) and compares
// them with the picture as the TV shows it. Everything is computed here in the browser:
// - position: the frame is matched against the picture over a range of zoom and shift, so a player that
//   zooms (overscan) or shifts the picture is found, and the colors are compared at the right place
// - per LED area (Hyperion's layout with the capture depth): expected and measured mean, color distance
// - over the whole picture: brightness, black level, contrast, saturation, color cast, clipped tones
// Color distance = Euclidean distance in OKLab x 100 (about 2 = just visible side by side).
// What the LEDs then make of it (calibration, wall) is not measured: that needs a camera.

const ok = (r, g, b) => {
  const lin = (v) => { v /= 255; return v > 0.04045 ? Math.pow((v + 0.055) / 1.055, 2.4) : v / 12.92; };
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
};
const dE = (p, q) => { const a = ok(...p), b = ok(...q); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100; };
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (c) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

// a color direction in OKLab (a, b) as a word
function castName(a, b, tr) {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  const names = [[-150, "blau"], [-100, "blau-violett"], [-60, "violett"], [-20, "magenta"], [20, "rot"], [60, "orange"], [100, "gelb"], [150, "grün"], [180, "türkis"]];
  const hit = names.find(([lim]) => h <= lim) ?? [0, "blau"];
  return tr(hit[1]);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Bild nicht ladbar"));
    img.src = src;
  });
}

// the picture as the TV shows it, on a canvas of the frame's size
async function reference(item, fit, w, h, TestImages) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  if (item.kind === "builtin") {
    TestImages.draw(ctx, item.id, w, h);
    return c;
  }
  const img = await loadImage(item.url ?? "/media/file/" + item.id);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  if (fit === "fill") ctx.drawImage(img, 0, 0, w, h);
  else {
    const k = fit === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    ctx.drawImage(img, (w - iw * k) / 2, (h - ih * k) / 2, iw * k, ih * k);
  }
  return c;
}

// averages the next frames of the preview stream (data URLs) for `ms` milliseconds
function grabFrames(ms, onProgress) {
  return new Promise((resolve, reject) => {
    const es = new EventSource("/api/preview");
    let sum = null, n = 0, w = 0, h = 0, busy = false;
    const started = Date.now();
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const done = () => {
      es.close();
      clearTimeout(timer);
      if (!n) return reject(new Error("Keine Bilder vom Grabber. Läuft die USB-Aufnahme in Hyperion?"));
      const out = ctx.createImageData(w, h);
      for (let i = 0; i < sum.length; i++) out.data[i] = (i & 3) === 3 ? 255 : sum[i] / n;
      resolve({ data: out, w, h, n, sum, frames: n });
    };
    const timer = setTimeout(done, ms + 4000);
    es.onmessage = async (ev) => {
      if (busy) return;
      busy = true;
      try {
        const img = await loadImage(ev.data);
        if (!sum) {
          w = img.naturalWidth; h = img.naturalHeight;
          canvas.width = w; canvas.height = h;
          sum = new Float32Array(w * h * 4);
        }
        ctx.drawImage(img, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        for (let i = 0; i < d.length; i++) sum[i] += d[i];
        n++;
        onProgress?.(n);
      } catch {}
      busy = false;
      if (n && Date.now() - started >= ms) done();
    };
  });
}

// luminance on a small grid (for the position search)
function smallLuma(source, sw, sh) {
  const c = document.createElement("canvas");
  c.width = sw; c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, sw, sh);
  const d = ctx.getImageData(0, 0, sw, sh).data;
  const out = new Float32Array(sw * sh);
  for (let i = 0; i < out.length; i++) out[i] = luma(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return out;
}

// zoom s and shift (dx, dy in small-grid pixels) that make the picture fit the frame best (correlation)
function findPosition(ref, meas, sw, sh) {
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mm = mean(meas);
  const all = [];
  const cx = sw / 2, cy = sh / 2;
  for (let s = 0.9; s <= 1.0601; s += 0.01) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        let sxy = 0, sxx = 0, syy = 0, sx = 0, sy = 0, n = 0;
        for (let y = 2; y < sh - 2; y += 1) {
          const ry = Math.round((y - cy - dy) / s + cy);
          if (ry < 0 || ry >= sh) continue;
          for (let x = 2; x < sw - 2; x += 1) {
            const rx = Math.round((x - cx - dx) / s + cx);
            if (rx < 0 || rx >= sw) continue;
            const a = ref[ry * sw + rx], b = meas[y * sw + x] - mm;
            sxy += a * b; sxx += a * a; sx += a; sy += b; syy += b * b; n++;
          }
        }
        if (n < sw * sh * 0.6) continue;
        // Pearson correlation over the pixels both have
        const va = sxx - (sx * sx) / n, vb = syy - (sy * sy) / n;
        const score = va > 0 && vb > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(va * vb) : -1;
        all.push({ score, s, dx, dy });
      }
    }
  }
  // the best match wins; pictures like a smooth ramp look almost the same zoomed or shifted, then
  // several places are nearly as good and the position counts as uncertain. An axis without any
  // structure (vertical bars have none from top to bottom) cannot be measured and does not count.
  const top = Math.max(...all.map((c) => c.score));
  const best = all.find((c) => c.score === top);
  const near = all.filter((c) => 1 - c.score <= (1 - top) * 1.5 + 1e-5);
  const span = (k) => Math.max(...near.map((c) => c[k])) - Math.min(...near.map((c) => c[k]));
  let gx = 0, gy = 0;
  for (let y = 0; y < sh - 1; y++) for (let x = 0; x < sw - 1; x++) {
    gx += Math.abs(ref[y * sw + x + 1] - ref[y * sw + x]);
    gy += Math.abs(ref[(y + 1) * sw + x] - ref[y * sw + x]);
  }
  gx /= (sw - 1) * (sh - 1);
  gy /= (sw - 1) * (sh - 1);
  // along an axis without structure every shift fits: keep the picture where it was sent
  let pick = best;
  for (const [k, g] of [["dy", gy], ["dx", gx]]) {
    if (g > 1) continue;
    const same = near.filter((c) => c.s === pick.s && (k === "dy" ? c.dx === pick.dx : c.dy === pick.dy));
    if (same.length) pick = same.reduce((a, b) => (Math.abs(b[k]) < Math.abs(a[k]) ? b : a));
  }
  pick.uncertain = span("s") > 0.025 || (span("dx") > 2 && gx > 1) || (span("dy") > 2 && gy > 1);
  return pick;
}

export async function measurePicture({ item, fit, areas, TestImages, tr, onProgress }) {
  onProgress?.(tr("Warte, bis das Bild beim Grabber ankommt …"));
  const frame = await grabFrames(2000, (n) => onProgress?.(tr("Lese Grabberbilder: {a}", { a: n })));
  const { w, h } = frame;
  const refCanvas = await reference(item, fit, w, h, TestImages);
  const measCanvas = document.createElement("canvas");
  measCanvas.width = w; measCanvas.height = h;
  measCanvas.getContext("2d").putImageData(frame.data, 0, 0);

  onProgress?.(tr("Suche die Bildlage …"));
  await new Promise((r) => setTimeout(r, 30));
  const sw = 160, sh = Math.max(1, Math.round((160 * h) / w));
  const pos = findPosition(smallLuma(refCanvas, sw, sh), smallLuma(measCanvas, sw, sh), sw, sh);
  // the picture placed like the frame shows it
  const aligned = document.createElement("canvas");
  aligned.width = w; aligned.height = h;
  const actx = aligned.getContext("2d", { willReadFrequently: true });
  actx.fillStyle = "#000";
  actx.fillRect(0, 0, w, h);
  const k = w / sw;
  actx.translate(w / 2 + pos.dx * k, h / 2 + pos.dy * k);
  actx.scale(pos.s, pos.s);
  actx.drawImage(refCanvas, -w / 2, -h / 2);
  const R = actx.getImageData(0, 0, w, h).data;
  const M = frame.data.data;

  // per LED area: mean of the picture and of the frame
  const leds = (areas ?? []).map(([x0, x1, y0, y1], i) => {
    const ax = Math.max(0, Math.floor(x0 * w)), bx = Math.min(w, Math.ceil(x1 * w));
    const ay = Math.max(0, Math.floor(y0 * h)), by = Math.min(h, Math.ceil(y1 * h));
    const r = [0, 0, 0], m = [0, 0, 0];
    let n = 0;
    for (let y = ay; y < by; y += 2) for (let x = ax; x < bx; x += 2) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) { r[c] += R[o + c]; m[c] += M[o + c]; }
      n++;
    }
    if (!n) return null;
    const exp = r.map((v) => v / n), got = m.map((v) => v / n);
    return { i, area: [x0, x1, y0, y1], exp, got, de: dE(exp, got) };
  }).filter(Boolean);

  // the whole picture, every 4th pixel
  let n = 0, sR = 0, sM = 0, sRR = 0, sRM = 0;
  let chromaR = 0, chromaM = 0, nChroma = 0, castA = 0, castB = 0, nGray = 0, clipHi = 0, nHi = 0, crushLo = 0, nLo = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) {
    const o = (y * w + x) * 4;
    const lr = luma(R[o], R[o + 1], R[o + 2]), lm = luma(M[o], M[o + 1], M[o + 2]);
    sR += lr; sM += lm; sRR += lr * lr; sRM += lr * lm; n++;
    const a = ok(R[o], R[o + 1], R[o + 2]), b = ok(M[o], M[o + 1], M[o + 2]);
    const cr = Math.hypot(a[1], a[2]), cm = Math.hypot(b[1], b[2]);
    if (cr > 0.05) { chromaR += cr; chromaM += cm; nChroma++; }
    if (cr < 0.02 && a[0] > 0.15) { castA += b[1] - a[1]; castB += b[2] - a[2]; nGray++; }
    if (lr > 20 && lr < 235) {
      if (Math.max(M[o], M[o + 1], M[o + 2]) >= 254 && Math.max(R[o], R[o + 1], R[o + 2]) < 245) clipHi++;
      if (Math.max(M[o], M[o + 1], M[o + 2]) <= 2) crushLo++;
      nHi++; nLo++;
    }
  }
  const gain = (sRM - (sR * sM) / n) / (sRR - (sR * sR) / n);
  const offset = (sM - gain * sR) / n;
  const stats = {
    contrast: gain,
    black: offset,
    brightness: sM / Math.max(1, sR),
    saturation: nChroma ? chromaM / chromaR : null,
    cast: nGray > 50 ? { a: castA / nGray, b: castB / nGray, de: Math.hypot(castA / nGray, castB / nGray) * 100 } : null,
    clipHi: nHi ? clipHi / nHi : 0,
    crushLo: nLo ? crushLo / nLo : 0,
  };
  const des = leds.map((l) => l.de);
  const meanDe = des.length ? des.reduce((a, b) => a + b, 0) / des.length : null;
  const sorted = [...des].sort((a, b) => a - b);
  return {
    when: Date.now(), item: { id: item.id, kind: item.kind, name: item.name }, fit, frames: frame.frames, w, h,
    position: { zoom: pos.s, dx: (pos.dx / sw) * 100, dy: (pos.dy / sh) * 100, match: pos.score, uncertain: pos.uncertain },
    leds, meanDe, p90: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : null, stats,
    images: { ref: aligned.toDataURL("image/jpeg", 0.85), meas: measCanvas.toDataURL("image/jpeg", 0.85) },
  };
}

// result as HTML; color of an LED area by its distance
const deColor = (d) => (d < 3 ? "#2fa36b" : d < 6 ? "#9bc53d" : d < 10 ? "#f0a020" : "#d93025");
export function grade(d, tr) {
  return d == null ? "" : d < 3 ? tr("sehr gut") : d < 6 ? tr("gut") : d < 10 ? tr("sichtbare Abweichung") : tr("deutliche Abweichung");
}

export function resultHtml(r, tr, esc) {
  const f = (v, d = 1) => Number(v).toLocaleString(globalThis.I18N?.locale ?? "de-DE", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (v) => f(v * 100, 0) + " %";
  const rows = [];
  const p = r.position;
  const shifted = Math.abs(p.dx) >= 0.6 || Math.abs(p.dy) >= 0.6;
  const zoomed = Math.abs(p.zoom - 1) >= 0.01;
  rows.push([tr("Bildlage"), p.uncertain ? tr("bei diesem Bild nicht sicher bestimmbar (dafür Farbtafel oder Ränder nehmen)") : !shifted && !zoomed ? tr("stimmt") : [
    zoomed ? tr("{a} % {b}", { a: f(Math.abs(p.zoom - 1) * 100, 0), b: p.zoom > 1 ? tr("vergrößert (Overscan, Ränder fehlen)") : tr("verkleinert (schwarzer Rand)") }) : "",
    shifted ? tr("verschoben um {a} % waagerecht, {b} % senkrecht", { a: f(p.dx), b: f(p.dy) }) : "",
  ].filter(Boolean).join(", ")]);
  if (p.match < 0.6) rows.push([tr("Hinweis"), tr("Bild und Grabberbild passen schlecht zusammen. Zeigt der TV wirklich dieses Bild?")]);
  const s = r.stats;
  rows.push([tr("Helligkeit"), pct(s.brightness)]);
  rows.push([tr("Kontrast"), pct(s.contrast)]);
  rows.push([tr("Schwarzwert"), Math.abs(s.black) < 2 ? tr("stimmt") : tr("{a} {b}", { a: f(Math.abs(s.black)), b: s.black > 0 ? tr("Stufen angehoben") : tr("Stufen abgesenkt") })]);
  if (s.saturation != null) rows.push([tr("Sättigung"), pct(s.saturation)]);
  if (s.cast) rows.push([tr("Farbstich bei Grau"), s.cast.de < 1 ? tr("keiner")
    : s.cast.de < 2 ? tr("kaum sichtbar, leicht {a} ({b})", { a: castName(s.cast.a, s.cast.b, tr), b: f(s.cast.de) })
    : tr("{a} ({b})", { a: castName(s.cast.a, s.cast.b, tr), b: f(s.cast.de) })]);
  if (s.clipHi > 0.01) rows.push([tr("Helle Töne abgeschnitten"), pct(s.clipHi)]);
  if (s.crushLo > 0.01) rows.push([tr("Dunkle Töne verschluckt"), pct(s.crushLo)]);
  const worst = [...r.leds].sort((a, b) => b.de - a.de).slice(0, 8);
  return `<div class="mm-summary"><b>${tr("LED-Flächen: mittlere Abweichung {a}", { a: r.meanDe == null ? "–" : f(r.meanDe) })}</b> · ${esc(grade(r.meanDe, tr))}` +
    `<small>${tr("{a} LED-Flächen, 90 % liegen unter {b} · gemittelt über {c} Grabberbilder", { a: r.leds.length, b: r.p90 == null ? "–" : f(r.p90), c: r.frames })}</small></div>` +
    `<div class="mm-pics"><figure><img src="${r.images.ref}" alt=""><figcaption>${tr("Bild, wie der TV es zeigt")}</figcaption></figure>` +
    `<figure class="mm-meas"><img src="${r.images.meas}" alt=""><svg viewBox="0 0 1 1" preserveAspectRatio="none">${r.leds.map((l) => `<rect x="${l.area[0]}" y="${l.area[2]}" width="${l.area[1] - l.area[0]}" height="${l.area[3] - l.area[2]}" fill="${deColor(l.de)}" fill-opacity=".55"/>`).join("")}</svg><figcaption>${tr("Beim Grabber, LED-Flächen nach Abweichung gefärbt")}</figcaption></figure></div>` +
    `<div class="mm-legend"><span style="background:#2fa36b"></span>${tr("unter 3")}<span style="background:#9bc53d"></span>3–6<span style="background:#f0a020"></span>6–10<span style="background:#d93025"></span>${tr("über 10")}</div>` +
    `<table class="mm-table"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>` +
    (worst.length ? `<h4 class="hy-h"><span>${tr("Größte Abweichungen")}</span></h4><table class="mm-table mm-worst"><thead><tr><th>LED</th><th>${tr("soll")}</th><th>${tr("ist")}</th><th>${tr("Abweichung")}</th></tr></thead><tbody>` +
      worst.map((l) => `<tr><td>${l.i}</td><td><span class="mm-sw" style="background:${hex(l.exp)}"></span>${l.exp.map((v) => Math.round(v)).join(", ")}</td><td><span class="mm-sw" style="background:${hex(l.got)}"></span>${l.got.map((v) => Math.round(v)).join(", ")}</td><td>${f(l.de)}</td></tr>`).join("") + "</tbody></table>" : "");
}
