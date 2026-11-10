// Flow chart "Vom TV-Bild zu den LEDs" of the Hyperion fork: every step a grabbed picture takes until
// the LEDs light up, in the order of the code (V4L2Grabber, Hyperion::processUpdate,
// MultiColorAdjustment::applyAdjustment, LinearColorSmoothing, LED device). Shared by the TV test page
// (card above the guide) and the fork WebUI (guide, right column), so it has no dependencies and
// brings its own styles. The colors work on light and dark pages alike.
//
//   ForkFlow.render(element, { lang })    lang "de" (default) or "en"
//   ForkFlow.show("20")                   scrolls to step 20 and marks it for a moment (the guides
//                                         link their steps to the processing step they act in)
//
// Two lines run beside the steps: the precise color with fractions (16 bit) from step 11 to the LED
// device, and the gray curve, which measures at step 11 and acts at step 18.
(function (global) {
  "use strict";

  // where = [page, section] in the WebUI, null = outside Hyperion
  const OUT = { de: "außerhalb von Hyperion", en: "outside Hyperion" };
  const W = {
    grabber: { de: "Aufnahme Hardware", en: "Capturing Hardware" },
    colors: { de: "Bildverarbeitung", en: "Image Processing" },
    leds: { de: "LED-Hardware", en: "LED Output" },
    remote: { de: "Fernbedienung", en: "Remote Control" },
    gtest: { de: "Grabber-Test", en: "Grabber test" },
    nosignal: { de: "„No Signal“-Standbild", en: "\"No Signal\" still image" },
    input: { de: "Quellenauswahl", en: "Source Selection" },
    bb: { de: "Schwarze Balken Erkennung", en: "Blackbar detector" },
    layout: { de: "LED-Layout", en: "LED Layout" },
    depth: { de: "Erfassungstiefe", en: "Capture depth" },
    mapping: { de: "LED-Bereich Zuordnungstyp", en: "LED area assignment" },
    calib: { de: "Farbkalibrierung", en: "Color Calibration" },
    smooth: { de: "Glättung", en: "Smoothing" },
    ctrl: { de: "LED-Steuerung", en: "LED Controller" },
  };

  // fork: "new" = only in this fork, "ext" = in Hyperion, extended by the fork (note says how)
  const PHASES = [
    { color: "#6b7785", name: { de: "Signal", en: "Signal" }, sub: { de: "Hardware", en: "Hardware" }, steps: [
      { n: "1", t: { de: "Zuspieler / Quelle", en: "Player / source" },
        d: { de: "schickt das Bild per HDMI", en: "sends the picture over HDMI" }, out: true },
      { n: "2", t: { de: "HDMI-Splitter", en: "HDMI splitter" }, opt: true,
        d: { de: "ein Ausgang zum TV, einer zum Grabber", en: "one output to the TV, one to the grabber" }, out: true },
      { n: "3", t: { de: "Video-Grabber", en: "Video grabber" },
        d: { de: "macht aus HDMI einen Videostrom, meist YUV", en: "turns HDMI into a video stream, mostly YUV" }, out: true },
    ] },
    { color: "#2f74c0", name: { de: "Aufnahme", en: "Capture" }, sub: { de: "Grabber-Bild", en: "grabber picture" }, steps: [
      { n: "4", t: { de: "Dekodieren YUV → RGB", en: "Decode YUV → RGB" }, fork: "ext",
        d: { de: "aus dem Videostrom werden RGB-Bildpunkte", en: "the video stream becomes RGB pixels" },
        note: { de: "Fork: Farbnorm je Grabber wählbar (BT.601 oder BT.709)", en: "Fork: color standard per grabber (BT.601 or BT.709)" },
        where: [["grabber", "gtest"]] },
      { n: "5a", t: { de: "Ränder abschneiden", en: "Crop edges" },
        d: { de: "entfernt links, rechts, oben und unten Bildpunkte", en: "removes pixels at the left, right, top and bottom" },
        where: [["grabber"]] },
      { n: "5b", t: { de: "Verkleinern", en: "Size decimation" },
        d: { de: "verkleinert das Bild um einen Faktor, damit die Auswertung weniger rechnen muss", en: "shrinks the picture by a factor so the analysis has less to compute" },
        where: [["grabber"]] },
      { n: "6", t: { de: "„No Signal“-Standbild", en: "\"No Signal\" still image" }, fork: "new",
        d: { de: "erkennt das Bild, das der Grabber ohne Signal zeigt → LEDs aus oder nächste Quelle", en: "detects the picture the grabber shows without a signal → LEDs off or the next source" },
        where: [["grabber", "nosignal"]] },
      { n: "7", t: { de: "Grabber-Farbkorrektur", en: "Grabber color correction" }, fork: "new",
        d: { de: "gleicht den Farbstich des Grabbers aus, berechnet vom Grabber-Test", en: "removes the color cast of the grabber, computed by the grabber test" },
        where: [["grabber", "gtest"]] },
    ] },
    { color: "#7b5bc4", name: { de: "Quelle", en: "Source" }, sub: { de: "Eingabe", en: "input" }, steps: [
      { n: "8", t: { de: "Priorität entscheidet", en: "Priority decides" },
        d: { de: "Grabber, Effekt, feste Farbe oder ein gesendetes Bild: die höchste Priorität gewinnt", en: "grabber, effect, fixed color or a sent picture: the highest priority wins" },
        note: { de: "Effekte und feste Farben überspringen die Schritte 9 bis 12", en: "Effects and fixed colors skip steps 9 to 12" }, plain: true,
        where: [["remote", "input"]] },
    ] },
    { color: "#2e9a6a", name: { de: "Bild → LED-Farben", en: "Picture → LED colors" }, sub: { de: "je LED", en: "per LED" }, steps: [
      { n: "9", t: { de: "Schwarze Balken Erkennung", en: "Black bar detection" },
        d: { de: "erkennt Kinobalken, die LED-Bereiche rücken nach innen", en: "detects cinema bars, the LED areas move inwards" },
        where: [["colors", "bb"]] },
      { n: "10", t: { de: "LED-Bereiche", en: "LED areas" }, fork: "ext",
        d: { de: "jede LED bekommt ihren Bildausschnitt am Rand", en: "each LED gets its part of the picture at the edge" },
        note: { de: "Fork: Erfassungstiefe einstellbar, wie weit der Bereich ins Bild reicht", en: "Fork: adjustable capture depth, how far the area reaches into the picture" },
        where: [["leds", "layout"], ["colors", "depth"]] },
      { n: "11", t: { de: "Farbe je LED berechnen", en: "Compute the color per LED" }, fork: "ext",
        d: { de: "eine Farbe aus jedem Bildausschnitt, Verfahren wählbar (Mittelwert, Dominante Farbe …)", en: "one color from each part of the picture, method selectable (mean, dominant color …)" },
        note: { de: "Fork: mit Nachkommastellen, ab hier läuft die genaue Farbe für 16 Bit mit", en: "Fork: with fractions, from here the precise color for 16 bit runs alongside" },
        where: [["colors", "mapping"]] },
      { n: "12", t: { de: "Graues Standbild Erkennung", en: "Gray still image detection" }, fork: "new",
        d: { de: "pausiertes, grau abgeblendetes Video → LEDs gedimmt", en: "paused video faded to gray → LEDs dimmed" },
        where: [["colors", "bb"]] },
      { n: "13", t: { de: "Auszuschließende LEDs", en: "Blacklist LEDs" },
        d: { de: "LEDs auf der Ausschlussliste bleiben schwarz", en: "LEDs on the blacklist stay black" },
        where: [["leds", "layout"]] },
    ] },
    { color: "#d9822b", name: { de: "Farb\u00ADanpassung", en: "Color adjustment" }, sub: { de: "je LED", en: "per LED" }, steps: [
      { n: "14", t: { de: "Sättigung & Helligkeit", en: "Saturation & brightness" },
        d: { de: "Sättigungs- und Helligkeitsverstärkung, falls eingestellt", en: "saturation and brightness gain, if set" },
        where: [["colors", "calib"]] },
      { n: "15", t: { de: "Gamma", en: "Gamma" },
        d: { de: "Helligkeitsverlauf je Rot, Grün und Blau", en: "brightness curve for red, green and blue" },
        where: [["colors", "calib"]] },
      { n: "16a", t: { de: "Grundfarben", en: "Base colors" },
        d: { de: "Rot, Grün, Blau, Cyan, Magenta, Gelb, Weiß und Schwarz: jede mit eigenem Farbwert", en: "red, green, blue, cyan, magenta, yellow, white and black: each with its own color value" },
        where: [["colors", "calib"]] },
      { n: "16b", t: { de: "Helligkeit & Helligkeitsabgleich", en: "Brightness & brightness compensation" },
        d: { de: "Gesamthelligkeit; der Abgleich gleicht Grundfarben, Mischfarben und Weiß in der Helligkeit an", en: "overall brightness; the compensation evens out base colors, mixed colors and white" },
        note: { de: "16a und 16b rechnet Hyperion in einem Zug", en: "Hyperion computes 16a and 16b in one go" }, plain: true,
        where: [["colors", "calib"]] },
      { n: "17", t: { de: "Farbtemperatur", en: "Temperature" },
        d: { de: "wärmer oder kälter", en: "warmer or cooler" },
        where: [["colors", "calib"]] },
      { n: "18", t: { de: "Graukurve", en: "Gray curve" }, fork: "new",
        d: { de: "hält Grautöne in jeder Helligkeit neutral", en: "keeps grays neutral at every brightness" },
        note: { de: "misst an der Farbe aus Schritt 11 (gestrichelte Linie), wirkt erst hier", en: "measures at the color from step 11 (dashed line), acts only here" },
        where: [["colors", "calib"]] },
      { n: "19", t: { de: "Hintergrundbeleuchtung", en: "Backlight" },
        d: { de: "Mindesthelligkeit, damit dunkle Szenen nicht ganz aus sind", en: "minimum brightness, so dark scenes are not completely off" },
        where: [["colors", "calib"]] },
    ] },
    { color: "#c8463d", name: { de: "Ausgabe", en: "Output" }, sub: { de: "zu den LEDs", en: "to the LEDs" }, steps: [
      { n: "20", t: { de: "RGB-Byte-Reihenfolge", en: "RGB byte order" },
        d: { de: "RGB, GRB … so wie das LED-Gerät es erwartet", en: "RGB, GRB … the way the LED device expects it" },
        where: [["leds", "ctrl"]] },
      { n: "21", t: { de: "Glättung", en: "Smoothing" }, fork: "ext",
        d: { de: "sanfte Übergänge statt Flackern", en: "soft transitions instead of flicker" },
        note: { de: "Fork: glättet auch die genaue Farbe für 16 Bit", en: "Fork: also smooths the precise color for 16 bit" },
        where: [["colors", "smooth"]] },
      { n: "22", t: { de: "LED-Gerät", en: "LED device" }, fork: "ext",
        d: { de: "sendet die Farben an die LEDs (SPI, USB, Netzwerk …)", en: "sends the colors to the LEDs (SPI, USB, network …)" },
        note: { de: "Fork: 16 Bit je Farbe, wenn der Treiber des LED-Geräts es unterstützt", en: "Fork: 16 bit per color when the driver of the LED device supports it" },
        where: [["leds", "ctrl"]] },
      { n: "23", t: { de: "LEDs leuchten", en: "LEDs light up" },
        d: { de: "fertig, meist wenige Millisekunden nach der Aufnahme", en: "done, mostly a few milliseconds after capture" }, out: true },
    ] },
  ];

  // the two lines beside the steps: from step, to step
  const LINES = { hp: ["11", "22"], gc: ["11", "18"] };

  const TEXT = {
    de: {
      title: "Vom TV-Bild zu den LEDs",
      intro: "So verarbeitet Hyperion jedes Bild, von oben nach unten in genau dieser Reihenfolge. Das ist nicht die Reihenfolge der Anleitung: Die Anleitung ordnet, was du nacheinander einstellst, hier steht, wo es im Bild wirkt. Das Kästchen unter jedem Schritt zeigt, wo du ihn in der WebUI einstellst.",
      opt: "optional",
      fork: "nur in diesem Fork",
      ext: "in Hyperion vorhanden, vom Fork erweitert",
      hp: "16 Bit: Ab Schritt 11 rechnet der Fork jede LED-Farbe zusätzlich genau mit Nachkommastellen. Das LED-Gerät bekommt diese genaue Farbe, wenn es 16 Bit je Farbe kann.",
      gc: "Graukurve: misst an der Farbe aus Schritt 11 und wirkt in Schritt 18.",
      hpShort: "genaue Farbe für 16 Bit", gcShort: "Graukurve",
    },
    en: {
      title: "From the TV picture to the LEDs",
      intro: "This is how Hyperion processes every picture, from top to bottom in exactly this order. This is not the order of the guide: the guide orders what you set up one after the other, this shows where it acts on the picture. The box below each step shows where to set it in the WebUI.",
      opt: "optional",
      fork: "only in this fork",
      ext: "in Hyperion, extended by the fork",
      hp: "16 bit: From step 11 the fork also computes every LED color precisely with fractions. The LED device gets this precise color when it supports 16 bit per color.",
      gc: "Gray curve: measures at the color from step 11 and acts in step 18.",
      hpShort: "precise color for 16 bit", gcShort: "gray curve",
    },
  };

  const CSS = `
.ff{--ff-line:rgba(128,128,128,.38);--ff-soft:rgba(128,128,128,.10);--ff-arrow:rgba(128,128,128,.6);--ff-hp:#139a9c;--ff-gc:#d9822b;--ff-forkbg:#f5c451;--ff-forkink:#3d2b00;
 container-type:inline-size;font-size:14px;line-height:1.35}
.ff *{box-sizing:border-box}
.ff-title{font-size:17px;font-weight:700;margin:0 0 4px}
.ff-intro{opacity:.75;margin:0 0 14px}
.ff-grid{display:grid;grid-template-columns:[ph] 118px [node] minmax(0,1fr) [gc] 16px [hp] 18px [end];column-gap:10px}
.ff-ph{grid-column:ph;border-radius:8px;background:var(--c);color:#fff;padding:10px 6px;font-weight:700;font-size:13px;display:flex;flex-direction:column;justify-content:center;text-align:center;hyphens:manual}
.ff-ph small,.ff-phrow small{display:block;font-weight:400;opacity:.9;margin-top:3px;font-size:11.5px}
.ff-phrow{display:none;grid-column:node / gc;border-radius:7px;background:var(--c);color:#fff;padding:6px 10px;font-weight:700;font-size:13px;margin:2px 0 6px}
.ff-phrow small{display:inline;margin:0 0 0 8px}
.ff-node{grid-column:node;border:1px solid var(--ff-line);border-left:5px solid var(--c);border-radius:7px;padding:7px 10px 8px 8px;display:grid;grid-template-columns:30px minmax(0,1fr);column-gap:8px;align-items:start;background:var(--ff-soft)}
.ff-num{min-width:26px;height:24px;padding:0 5px;border-radius:12px;background:var(--c);color:#fff;font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.ff-t{font-weight:700;font-size:14.5px}
.ff-t .ff-opt{font-weight:400;opacity:.7}
.ff-d{opacity:.78;font-size:12.8px}
.ff-note{font-size:12px;margin-top:3px;opacity:.9}
.ff-note.fork{color:inherit;border-left:3px solid var(--ff-forkbg);padding-left:6px}
.ff-where{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.ff-tag{font-size:11.5px;border:1px solid var(--ff-line);border-radius:10px;padding:1px 8px;opacity:.85}
.ff-tag.out{border-style:dashed}
.ff-badge{font-size:10px;font-weight:700;border-radius:4px;padding:1px 5px;margin-left:6px;vertical-align:2px;white-space:nowrap;color:var(--ff-forkink);background:var(--ff-forkbg);border:1px solid var(--ff-forkbg)}
.ff-badge.ext{background:transparent;color:inherit;border-color:var(--ff-forkbg)}
.ff-node.ff-hl{animation:ff-hl 2.4s ease-out}
@keyframes ff-hl{0%,40%{box-shadow:0 0 0 3px var(--c)}100%{box-shadow:0 0 0 3px transparent}}
.ff-arrow{grid-column:node;height:14px;position:relative;margin-left:19px}
.ff-arrow::before{content:"";position:absolute;left:0;top:0;bottom:4px;border-left:2px solid var(--ff-arrow)}
.ff-arrow::after{content:"";position:absolute;left:-4px;bottom:0;border:5px solid transparent;border-top:6px solid var(--ff-arrow);border-bottom:0}
.ff-arrow.big{height:22px}
.ff-rail{position:relative;pointer-events:none}
.ff-rail::before{content:"";position:absolute;left:50%;top:0;bottom:0;margin-left:-1px}
.ff-rail.start::before{top:50%}
.ff-rail.end::before{bottom:50%}
.ff-rail.hp::before{border-left:3px solid var(--ff-hp);margin-left:-1.5px}
.ff-rail.gc::before{border-left:2px dashed var(--ff-gc)}
.ff-stub{position:absolute;top:50%;height:0;right:50%}
.ff-rail.hp .ff-stub{border-top:3px solid var(--ff-hp);margin-top:-1.5px;width:calc(50% + 36px)}
.ff-rail.gc .ff-stub{border-top:2px dashed var(--ff-gc);margin-top:-1px;width:calc(50% + 10px)}
.ff-rail.end .ff-stub::before{content:"";position:absolute;left:-1px;top:-6.5px;border:5px solid transparent;border-right:7px solid var(--ff-hp);border-left:0}
.ff-rail.gc.end .ff-stub::before{border-right-color:var(--ff-gc);top:-6px}
.ff-rail.start .ff-stub::after{content:"";position:absolute;left:-4px;top:-5px;width:7px;height:7px;border-radius:50%}
.ff-rail.hp.start .ff-stub::after{background:var(--ff-hp);top:-5px}
.ff-rail.gc.start .ff-stub::after{background:var(--ff-gc);top:-4.5px}
.ff-legend{margin-top:14px;display:grid;gap:6px;font-size:12.5px}
.ff-legend div{display:flex;gap:8px;align-items:baseline}
.ff-legend .ff-badge{margin-left:0;flex:none}
.ff-sw{flex:none;width:26px;height:0;align-self:center}
.ff-sw.hp{border-top:3px solid var(--ff-hp)}
.ff-sw.gc{border-top:2px dashed var(--ff-gc)}
@container (max-width:520px){
 .ff-grid{grid-template-columns:[ph node] minmax(0,1fr) [gc] 12px [hp] 14px [end];column-gap:6px}
 .ff-ph{display:none}
 .ff-phrow{display:block}
 .ff-node{grid-template-columns:28px minmax(0,1fr);padding-right:8px}
 .ff-rail.hp .ff-stub{width:calc(50% + 24px)}
 .ff-rail.gc .ff-stub{width:calc(50% + 6px)}
}
`;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);

  function injectStyle() {
    if (document.getElementById("ff-style")) return;
    const style = document.createElement("style");
    style.id = "ff-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function render(element, options = {}) {
    const lang = options.lang === "en" ? "en" : "de";
    const tx = TEXT[lang];
    injectStyle();

    // rows of one grid, so the two lines on the right run through all phases: per phase a header row
    // (shown on narrow screens, the phase label on the left otherwise), the steps with arrows between
    // them and a bigger arrow to the next phase
    const cells = [];
    const rowOf = {};
    let row = 1;
    PHASES.forEach((ph, p) => {
      const first = row;
      cells.push(`<div class="ff-phrow" style="grid-row:${row};--c:${ph.color}">${esc(ph.name[lang])}<small>${esc(ph.sub[lang])}</small></div>`);
      row++;
      ph.steps.forEach((s, i) => {
        if (i) cells.push(`<div class="ff-arrow" style="grid-row:${row++}"></div>`);
        rowOf[s.n] = row;
        const badge = s.fork === "new" ? `<span class="ff-badge" title="${esc(tx.fork)}">FORK</span>`
          : s.fork === "ext" ? `<span class="ff-badge ext" title="${esc(tx.ext)}">+FORK</span>` : "";
        const note = s.note ? `<div class="ff-note${s.plain ? "" : " fork"}">${s.n === "18" ? "↳ " : ""}${esc(s.note[lang])}</div>` : "";
        const where = s.out ? `<span class="ff-tag out">${esc(OUT[lang])}</span>`
          : (s.where || []).map((w) => `<span class="ff-tag">${w.map((k) => esc(W[k][lang])).join(" → ")}</span>`).join("");
        cells.push(`<div class="ff-node" id="ff-step-${esc(s.n)}" style="grid-row:${row};--c:${ph.color}"><span class="ff-num">${esc(s.n)}</span><div>`
          + `<div class="ff-t">${esc(s.t[lang])}${s.opt ? ` <span class="ff-opt">(${esc(tx.opt)})</span>` : ""}${badge}</div>`
          + `<div class="ff-d">${esc(s.d[lang])}</div>${note}<div class="ff-where">${where}</div></div></div>`);
        row++;
      });
      cells.push(`<div class="ff-ph" style="grid-row:${first} / ${row};--c:${ph.color}">${esc(ph.name[lang])}<small>${esc(ph.sub[lang])}</small></div>`);
      if (p < PHASES.length - 1) cells.push(`<div class="ff-arrow big" style="grid-row:${row++}"></div>`);
    });
    for (const [key, [from, to]] of Object.entries(LINES)) {
      const a = rowOf[from];
      const b = rowOf[to];
      const label = esc(tx[key + "Short"]);
      for (let r = a; r <= b; r++) {
        const end = r === a ? " start" : r === b ? " end" : "";
        const stub = r === a || r === b ? '<span class="ff-stub"></span>' : "";
        cells.push(`<div class="ff-rail ${key}${end}" style="grid-row:${r};grid-column:${key}" title="${label}">${stub}</div>`);
      }
    }

    element.innerHTML = `<div class="ff" lang="${lang}">`
      + (options.title === false ? "" : `<p class="ff-title">${esc(tx.title)}</p>`)
      + `<p class="ff-intro">${esc(tx.intro)}</p>`
      + `<div class="ff-grid">${cells.join("")}</div>`
      + `<div class="ff-legend">`
      + `<div><span class="ff-sw hp"></span><span>${esc(tx.hp)}</span></div>`
      + `<div><span class="ff-sw gc"></span><span>${esc(tx.gc)}</span></div>`
      + `<div><span class="ff-badge">FORK</span><span>${esc(tx.fork)}</span></div>`
      + `<div><span class="ff-badge ext">+FORK</span><span>${esc(tx.ext)}</span></div>`
      + `</div></div>`;
  }

  function show(n) {
    const node = document.getElementById("ff-step-" + n);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.remove("ff-hl");
    void node.offsetWidth; // restart the animation
    node.classList.add("ff-hl");
  }

  global.ForkFlow = { render, show, PHASES };
})(typeof window !== "undefined" ? window : globalThis);
