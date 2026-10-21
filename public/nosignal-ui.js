// "No Signal" still image detection of the Hyperion fork (NoSignalDetector): the settings and the
// calibration of the video grabber's own no-signal picture, shared by the fork WebUI (Aufnahme
// Hardware, USB capture panel) and the TV test page, so it has no dependencies.
//
// Settings: global setting grabberTest, key noSignal (see include/utils/NoSignalDetector.h):
//   { enable, action, delay, tolerance, match, grabbers: { "<device>": { active, slots: [slot | null] } } }
//
//   NoSignalUI.applyOp(grabberTest, device, op, args, lang)   new grabberTest; ops: options, save, use, rename, clear, forget
//   NoSignalUI.render(element, { lang, getConfig, change, command, buttonClass, primaryClass, inputClass, heading })
//     getConfig()        the grabberTest setting (or just { noSignal })
//     change(op, args)   applies an op and stores it, returns a promise
//     command(params)    sends the fork command "grabbertest" with params, returns a promise of its info
//     inputClass         class of the text, number and select fields (the WebUI's form-control, for its themes)
//     heading            false leaves out the rule and the title (the test page card has its own)
(function (global) {
  "use strict";

  const SLOT_COUNT = 3;
  const CELLS = 64 * 36;
  const DEFAULTS = { enable: false, action: "release", delay: 3, tolerance: 24, match: 95 };
  const ACTIONS = ["release", "black"];
  const POLL_MS = 1000;
  const CALIBRATION_MS = 3000;

  const TEXT = {
    de: {
      title: "„No Signal“-Standbild-Erkennung",
      guideTitle: "Anleitung",
      guideIntro: "Viele Grabber zeigen ohne HDMI-Signal ein eigenes Bild, statt schwarz zu bleiben, zum Beispiel den Text „No Signal“, ein Logo, ein Blaubild oder Farbbalken. Hyperion würde dieses Bild auf die LEDs geben. Die Erkennung lernt das Bild einmal und reagiert, sobald es wieder erscheint. Verglichen wird Helligkeit und Farbe. Eine dunkle Filmszene zählt nicht, weil ihr die Merkmale des Bildes fehlen (Text, Logo, Farbflächen).",
      guideSteps: [
        "Sorge dafür, dass am Grabber kein Signal anliegt: Zuspieler ausschalten oder das HDMI-Kabel am Grabber abziehen.",
        "Warte, bis unten das No-Signal-Bild des Grabbers zu sehen ist.",
        "„Kalibrierung starten“ und bestätigen. Hyperion nimmt das Bild 3 Sekunden lang auf.",
        "Ergebnis prüfen, in einen Speicherplatz legen und die Erkennung aktivieren. Danach den Zuspieler wieder einschalten oder das Kabel einstecken.",
      ],
      guideNote: "Jeder Grabber hat eigene Speicherplätze. Wechselst du den Grabber, nutzt Hyperion automatisch dessen Kalibrierung. Änderungen in diesem Abschnitt werden sofort gespeichert.",
      liveTitle: "Aktuelles Grabber-Bild",
      liveNone: "Noch kein Bild vom Grabber.",
      grabber: "Grabber: {name}",
      noDevice: "Kein Grabber erkannt.",
      stNoFrames: "Der Grabber liefert gerade keine Bilder.",
      stUncalibrated: "Für diesen Grabber gibt es noch keine Kalibrierung.",
      stSignal: "Bild läuft. Übereinstimmung mit dem No-Signal-Bild: {match} %",
      stPending: "No-Signal-Bild erkannt ({match} %), Reaktion in {left} s …",
      stNoSignal: "Kein Signal seit {time} ({match} %). {what}",
      stCalibrating: "Kalibrierung läuft …",
      whatRelease: "Die USB-Aufnahme ist als Quelle freigegeben: LEDs aus oder „Hintergrund Effekt/Farbe“.",
      whatBlack: "Die LEDs bekommen Schwarz.",
      whatOff: "Die Erkennung ist aus, die LEDs bleiben unverändert.",
      calStart: "Kalibrierung starten",
      calConfirm: "Liegt am Grabber gerade kein Signal an? Der Zuspieler muss aus sein oder das HDMI-Kabel am Grabber abgezogen. Das Bild oben muss das No-Signal-Bild des Grabbers zeigen.",
      calYes: "Ja, kalibrieren",
      cancel: "Abbrechen",
      calRunning: "Hyperion nimmt das Bild auf …",
      calFailFrames: "Der Grabber hat zu wenige Bilder geliefert. Ist die USB-Aufnahme eingeschaltet?",
      calFail: "Kalibrierung fehlgeschlagen: {msg}",
      resTitle: "Ergebnis der Kalibrierung",
      resStats: "{frames} Bilder aufgenommen. Merkmale (Text, Logo, Farbflächen): {features} von {cells} Feldern. Unruhige Felder, die ignoriert werden: {unstable}.",
      warnNoFeatures: "Das Bild hat keine Merkmale wie Text, Logo oder Farbflächen, es ist ganz schwarz. Dann gilt auch ein schwarzes Bild als „kein Signal“, etwa eine dunkle Filmszene nach der Wartezeit. Eine längere Wartezeit hilft.",
      warnBusy: "Das Bild ist großflächig hell oder farbig, zum Beispiel ein Blaubild oder Farbbalken. Es wird an Farbe und Helligkeit erkannt. Prüfe im Vorschaubild, dass es wirklich das No-Signal-Bild ist und kein angehaltenes Video.",
      warnUnstable: "Das Bild hat sich während der Aufnahme stark verändert. Läuft vielleicht doch etwas? Bitte erneut kalibrieren.",
      resName: "Name",
      resSaveTo: "In Platz {slot} speichern",
      resDiscard: "Verwerfen",
      confirmOverwrite: "Platz {slot} überschreiben?",
      slotsTitle: "Speicherplätze für diesen Grabber",
      slot: "Platz {n}",
      slotEmpty: "leer",
      slotInfo: "gespeichert {date}, {features} Merkmal-Felder",
      inUse: "läuft",
      chosen: "aus",
      use: "Verwenden",
      clear: "Löschen",
      confirmClear: "{slot} löschen?",
      rename: "Name von {slot}",
      others: "Kalibrierungen anderer Grabber",
      forget: "Entfernen",
      confirmForget: "Alle Kalibrierungen von {name} entfernen?",
      optTitle: "Einstellungen",
      enable: "Erkennung aktiviert",
      enableHint: "Gilt für alle Grabber. Ohne Kalibrierung für den angeschlossenen Grabber ruht die Erkennung. Auch ausgeschaltet zeigt das Grabber-Bild oben, ob das No-Signal-Bild erkannt würde, so lässt sie sich gefahrlos ausprobieren.",
      action: "Reaktion bei „kein Signal“",
      actionRelease: "Quelle freigeben: LEDs aus oder „Hintergrund Effekt/Farbe“ an, falls eingeschaltet (wie die frühere Signalerkennung, empfohlen)",
      actionBlack: "LEDs schwarz: auch „Hintergrund Effekt/Farbe“ bleibt aus, die USB-Aufnahme bleibt aktive Quelle",
      delay: "Wartezeit (Sekunden)",
      delayHint: "So lange muss das No-Signal-Bild ununterbrochen zu sehen sein, bevor Hyperion reagiert. Kommt wieder ein normales Bild, ist das Signal sofort zurück.",
      tolerance: "Toleranz (0–100)",
      toleranceHint: "Wie weit ein Feld (1/64 Bildbreite × 1/36 Bildhöhe) vom kalibrierten Bild abweichen darf, je Farbkanal von 0 bis 255. Größer = unempfindlicher gegen Bildrauschen.",
      match: "Mindest-Übereinstimmung (%)",
      matchHint: "So viele Felder müssen passen, die Merkmal-Felder (Text, Logo, Farbflächen) zusätzlich für sich.",
      dateLocale: "de-DE",
      errNoDevice: "Kein Grabber erkannt. Ist die USB-Aufnahme eingeschaltet?",
      errResult: "Kein Kalibrierergebnis vorhanden.",
    },
    en: {
      title: "\"No Signal\" still image detection",
      guideTitle: "Instructions",
      guideIntro: "Many grabbers show a picture of their own while no HDMI signal arrives, instead of staying black, for example the text \"No Signal\", a logo, a blue screen or color bars. Hyperion would put that picture on the LEDs. The detection learns the picture once and reacts as soon as it appears again. Brightness and color are compared. A dark film scene does not count, because it lacks the picture's features (text, logo, colored areas).",
      guideSteps: [
        "Make sure no signal reaches the grabber: switch the source off or unplug the HDMI cable at the grabber.",
        "Wait until the grabber's no-signal picture shows below.",
        "Press \"Start calibration\" and confirm. Hyperion records the picture for 3 seconds.",
        "Check the result, put it into a slot and enable the detection. Then switch the source back on or plug the cable back in.",
      ],
      guideNote: "Every grabber has its own slots. When you change the grabber, Hyperion uses its calibration automatically. Changes in this section are saved immediately.",
      liveTitle: "Current grabber picture",
      liveNone: "No picture from the grabber yet.",
      grabber: "Grabber: {name}",
      noDevice: "No grabber found.",
      stNoFrames: "The grabber delivers no pictures right now.",
      stUncalibrated: "This grabber has no calibration yet.",
      stSignal: "Picture running. Match with the no-signal picture: {match} %",
      stPending: "No-signal picture detected ({match} %), reacting in {left} s …",
      stNoSignal: "No signal since {time} ({match} %). {what}",
      stCalibrating: "Calibration running …",
      whatRelease: "The USB capture is released as source: LEDs off or \"Background Effect/Color\".",
      whatBlack: "The LEDs get black.",
      whatOff: "The detection is off, the LEDs stay as they are.",
      calStart: "Start calibration",
      calConfirm: "Is there no signal at the grabber right now? The source must be off or the HDMI cable unplugged at the grabber. The picture above must show the grabber's no-signal picture.",
      calYes: "Yes, calibrate",
      cancel: "Cancel",
      calRunning: "Hyperion is recording the picture …",
      calFailFrames: "The grabber delivered too few pictures. Is the USB capture switched on?",
      calFail: "Calibration failed: {msg}",
      resTitle: "Calibration result",
      resStats: "{frames} pictures recorded. Features (text, logo, colored areas): {features} of {cells} cells. Restless cells that are ignored: {unstable}.",
      warnNoFeatures: "The picture has no features like text, a logo or colored areas, it is all black. Then a black picture counts as \"no signal\" as well, for example a dark film scene after the delay. A longer delay helps.",
      warnBusy: "The picture is bright or colored over large areas, for example a blue screen or color bars. It is recognized by color and brightness. Check in the preview that it really is the no-signal picture and not a paused video.",
      warnUnstable: "The picture changed a lot during the recording. Is something playing after all? Please calibrate again.",
      resName: "Name",
      resSaveTo: "Save to slot {slot}",
      resDiscard: "Discard",
      confirmOverwrite: "Overwrite slot {slot}?",
      slotsTitle: "Slots for this grabber",
      slot: "Slot {n}",
      slotEmpty: "empty",
      slotInfo: "saved {date}, {features} feature cells",
      inUse: "running",
      chosen: "off",
      use: "Use",
      clear: "Delete",
      confirmClear: "Delete {slot}?",
      rename: "Name of {slot}",
      others: "Calibrations of other grabbers",
      forget: "Remove",
      confirmForget: "Remove all calibrations of {name}?",
      optTitle: "Settings",
      enable: "Detection enabled",
      enableHint: "Applies to all grabbers. Without a calibration for the connected grabber the detection rests. Even while it is off, the grabber picture above shows whether the no-signal picture would be detected, so it can be tried out safely.",
      action: "Reaction to \"no signal\"",
      actionRelease: "Release the source: LEDs off or \"Background Effect/Color\" on, if switched on (like the former signal detection, recommended)",
      actionBlack: "LEDs black: \"Background Effect/Color\" stays off as well, the USB capture stays the active source",
      delay: "Delay (seconds)",
      delayHint: "The no-signal picture has to show this long without a break before Hyperion reacts. As soon as a normal picture comes back, the signal is back.",
      tolerance: "Tolerance (0–100)",
      toleranceHint: "How far a cell (1/64 picture width × 1/36 picture height) may differ from the calibrated picture, per color channel from 0 to 255. Larger = less sensitive to picture noise.",
      match: "Minimum match (%)",
      matchHint: "This many cells have to match, the feature cells (text, logo, colored areas) on their own as well.",
      dateLocale: "en-GB",
      errNoDevice: "No grabber found. Is the USB capture switched on?",
      errResult: "There is no calibration result.",
    },
  };

  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const clamp = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  // the kernel name of a V4L2 device is "<card>: <card>"; show the card once
  const displayName = (device) => { const m = /^(.*): \1$/.exec(device ?? ""); return m ? m[1] : (device ?? ""); };

  function options(gt) {
    const ns = (gt && gt.noSignal) || {};
    return {
      enable: ns.enable === true,
      action: ACTIONS.includes(ns.action) ? ns.action : DEFAULTS.action,
      delay: clamp(ns.delay, 0.5, 120, DEFAULTS.delay),
      tolerance: clamp(ns.tolerance, 4, 100, DEFAULTS.tolerance),
      match: clamp(ns.match, 50, 100, DEFAULTS.match),
    };
  }

  function entry(gt, device) {
    const g = (gt && gt.noSignal && gt.noSignal.grabbers && device && gt.noSignal.grabbers[device]) || null;
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => ((g && g.slots) || [])[i] || null);
    const active = g && Number.isInteger(g.active) && slots[g.active] ? g.active : -1;
    return { active, slots };
  }

  function applyOp(gt, device, op, args = {}, lang = "de", now = new Date().toISOString()) {
    const t = TEXT[lang] || TEXT.de;
    const next = JSON.parse(JSON.stringify(gt || {}));
    const ns = next.noSignal = Object.assign({}, options(next), { grabbers: (next.noSignal && next.noSignal.grabbers) || {} });
    const slotIndex = () => {
      const i = Number(args.slot);
      if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT) throw new Error("slot");
      return i;
    };
    const own = () => {
      if (!device) throw new Error(t.errNoDevice);
      const e = entry(next, device);
      ns.grabbers[device] = e;
      return e;
    };
    switch (op) {
      case "options": {
        const o = options({ noSignal: Object.assign({}, ns, args) });
        Object.assign(ns, o);
        break;
      }
      case "save": {
        const r = args.result;
        if (!r || !r.ref || !r.unstable) throw new Error(t.errResult);
        const g = own();
        const i = slotIndex();
        g.slots[i] = {
          name: String(args.name ?? "").trim().slice(0, 60), savedAt: r.savedAt || now, cols: r.cols, rows: r.rows,
          ref: r.ref, unstable: r.unstable, featureCells: r.featureCells, unstableCells: r.unstableCells,
        };
        g.active = i;
        break;
      }
      case "use": {
        const g = own();
        const i = slotIndex();
        if (g.slots[i]) g.active = i;
        break;
      }
      case "rename": {
        const g = own();
        const i = slotIndex();
        if (g.slots[i]) g.slots[i].name = String(args.name ?? "").trim().slice(0, 60);
        break;
      }
      case "clear": {
        const g = own();
        const i = slotIndex();
        g.slots[i] = null;
        if (g.active === i) g.active = g.slots.findIndex(Boolean);
        break;
      }
      case "forget":
        delete ns.grabbers[args.device];
        break;
      default:
        throw new Error("op");
    }
    return next;
  }

  let styleAdded = false;
  function addStyle() {
    if (styleAdded || typeof document === "undefined") return;
    styleAdded = true;
    const style = document.createElement("style");
    style.textContent = `
      .nsd { margin-top: 6px; }
      .nsd-rule { border: 0; border-top: 2px solid var(--nsd-line, rgba(127,127,127,.45)); margin: 18px 0 14px; }
      .nsd h4 { margin: 0 0 10px; }
      .nsd h5 { margin: 16px 0 8px; font-weight: 600; font-size: 14px; }
      .nsd-box { border: 1px solid var(--nsd-line, rgba(127,127,127,.35)); border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; }
      .nsd-guide ol { margin: 6px 0 6px; padding-left: 22px; }
      .nsd-guide li { margin: 3px 0; display: list-item; }
      .nsd-guide p { margin: 0 0 4px; }
      .nsd-muted { opacity: .75; font-size: 13px; }
      .nsd-live img { display: block; width: 100%; max-width: 480px; aspect-ratio: 16 / 9; object-fit: contain; background: #000; border-radius: 6px; }
      .nsd-live .nsd-none { display: flex; align-items: center; justify-content: center; width: 100%; max-width: 480px; aspect-ratio: 16 / 9; background: #000; color: #bbb; border-radius: 6px; font-size: 13px; }
      .nsd-status { margin: 8px 0 0; font-size: 14px; }
      .nsd-status.bad { color: #d93025; }
      .nsd-status.ok { color: #2fa36b; }
      .nsd-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 8px 0; }
      .nsd-actions button { width: auto; margin: 0; }
      .nsd-bar { height: 6px; border-radius: 3px; background: rgba(127,127,127,.25); overflow: hidden; margin: 8px 0; max-width: 480px; }
      .nsd-bar > span { display: block; height: 100%; background: #2b93ef; width: 0; transition: width .25s linear; }
      .nsd-warn { color: #d08a00; margin: 6px 0; }
      .nsd-err { color: #d93025; margin: 6px 0; }
      /* the slots look and mark the chosen one like the other slots (grabber color correction,
         gray curve): chosen = blue, badge "läuft" while the function is on, "aus" while it is off */
      .nsd-slot { border: 1px solid rgba(128,128,128,.35); border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
      .nsd-slot.on { border-color: #2b93ef; box-shadow: inset 3px 0 0 #2b93ef; }
      .nsd-slot-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
      .nsd-slot-head b { min-width: 52px; }
      .nsd-slot-head input[type=text] { flex: 1 1 160px; min-width: 0; max-width: 320px; font: inherit; padding: 4px 8px; }
      .nsd-slot .nsd-info { margin: 4px 0 0; }
      .nsd-slot-actions { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 8px 0 0; }
      .nsd-other { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 4px 0; }
      .nsd-badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #2b93ef; color: #fff; white-space: nowrap; font-weight: normal; }
      .nsd-badge.idle { background: rgba(128,128,128,.35); color: inherit; }
      .nsd-slot button, .nsd-other button { width: auto; margin: 0; }
      .nsd-opt { margin: 10px 0; }
      .nsd-opt label { display: block; font-weight: 600; margin-bottom: 4px; }
      .nsd-opt select, .nsd-opt input[type=number] { font: inherit; padding: 4px 6px; max-width: 100%; }
      .nsd-opt input[type=number] { width: 110px; }
      .nsd-switch { display: flex; gap: 8px; align-items: center; font-weight: 600; cursor: pointer; }
      .nsd-switch input { width: 18px; height: 18px; margin: 0; }
    `;
    document.head.appendChild(style);
  }

  function render(element, opts) {
    addStyle();
    const lang = opts.lang === "en" ? "en" : "de";
    const t = TEXT[lang];
    const btn = opts.buttonClass || "";
    const primary = opts.primaryClass || btn;
    const field = opts.inputClass ? ` class="${opts.inputClass}"` : "";
    const view = { status: null, calib: null, result: null, error: "", confirming: false, configKey: "", busy: false };

    element.classList.add("nsd");
    element.innerHTML = (opts.heading === false ? "" : `
      <hr class="nsd-rule">
      <h4>${esc(t.title)}</h4>`) + `
      <div class="nsd-box nsd-guide"><b>${esc(t.guideTitle)}</b>
        <p>${esc(t.guideIntro)}</p>
        <ol>${t.guideSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
        <p class="nsd-muted">${esc(t.guideNote)}</p>
      </div>
      <div class="nsd-box nsd-live"><b>${esc(t.liveTitle)}</b>
        <p class="nsd-muted" data-ns="device"></p>
        <div data-ns="picture"><div class="nsd-none">${esc(t.liveNone)}</div></div>
        <p class="nsd-status" data-ns="status"></p>
      </div>
      <div data-ns="calibration"></div>
      <div data-ns="config"></div>`;
    const $ = (k) => element.querySelector(`[data-ns="${k}"]`);
    const ask = (msg) => (typeof global.confirm === "function" ? global.confirm(msg) : true);
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString(t.dateLocale, { hour: "2-digit", minute: "2-digit" });
    const fmtDate = (iso) => { const d = new Date(iso); return isNaN(d) ? "–" : d.toLocaleString(t.dateLocale, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); };
    const pct = (v) => (v < 0 ? "–" : Number(v).toLocaleString(t.dateLocale, { maximumFractionDigits: 0 }));
    const device = () => (view.status && view.status.device) || "";

    const change = async (op, args) => {
      try {
        await opts.change(op, args);
      } catch (e) {
        view.error = e.message || String(e);
      }
      renderConfig(true);
      renderCalibration();
    };

    function renderStatus() {
      const s = view.status;
      $("device").textContent = s && s.device ? fill(t.grabber, { name: displayName(s.device) }) : t.noDevice;
      if (s && s.image) {
        let img = $("picture").querySelector("img");
        if (!img) { $("picture").innerHTML = "<img alt=\"\">"; img = $("picture").querySelector("img"); }
        img.src = s.image;
      }
      const el = $("status");
      el.className = "nsd-status";
      if (!s) { el.textContent = ""; return; }
      const o = options(opts.getConfig());
      if (s.calibrating) el.textContent = t.stCalibrating;
      else if (s.ageMs < 0 || s.ageMs > 3000) { el.textContent = t.stNoFrames; el.classList.add("bad"); }
      else if (!s.calibrated) el.textContent = t.stUncalibrated;
      else if (s.noSignal) {
        const what = !o.enable ? t.whatOff : s.action === "black" ? t.whatBlack : t.whatRelease;
        el.textContent = fill(t.stNoSignal, { time: fmtTime(s.changedMs), match: pct(s.match), what });
        el.classList.add("bad");
      } else if (s.matchSinceMs > 0) {
        const left = Math.max(0, o.delay - (s.now - s.matchSinceMs) / 1000);
        el.textContent = fill(t.stPending, { match: pct(s.match), left: left.toLocaleString(t.dateLocale, { maximumFractionDigits: 1 }) });
      } else {
        el.textContent = fill(t.stSignal, { match: pct(s.match) });
        el.classList.add("ok");
      }
    }

    function renderCalibration() {
      const box = $("calibration");
      const r = view.result;
      let html = "";
      if (view.error) html += `<p class="nsd-err">${esc(view.error)}</p>`;
      if (view.calib && view.calib.running) {
        const done = view.calib.durationMs > 0 ? 100 * (1 - view.calib.leftMs / view.calib.durationMs) : 0;
        html += `<div class="nsd-box"><p>${esc(t.calRunning)}</p><div class="nsd-bar"><span style="width:${done.toFixed(0)}%"></span></div></div>`;
      } else if (view.confirming) {
        html += `<div class="nsd-box"><p>${esc(t.calConfirm)}</p><div class="nsd-actions">`
          + `<button type="button" class="${primary}" data-ns-act="calibrate">${esc(t.calYes)}</button>`
          + `<button type="button" class="${btn}" data-ns-act="cancel">${esc(t.cancel)}</button></div></div>`;
      } else if (r) {
        const unstableShare = r.unstableCells / (r.cells || CELLS);
        const tooRestless = unstableShare > 0.5;
        html += `<div class="nsd-box"><b>${esc(t.resTitle)}</b>`
          + (r.image ? `<div class="nsd-live" style="margin-top:6px"><img alt="" src="${esc(r.image)}"></div>` : "")
          + `<p class="nsd-muted" style="margin-top:6px">${esc(fill(t.resStats, { frames: r.frames, features: r.featureCells, cells: r.cells || CELLS, unstable: r.unstableCells }))}</p>`
          + (r.featureCells === 0 ? `<p class="nsd-warn">${esc(t.warnNoFeatures)}</p>` : "")
          + (r.featureCells > 0.6 * (r.cells || CELLS) ? `<p class="nsd-muted">${esc(t.warnBusy)}</p>` : "")
          + (unstableShare > 0.3 ? `<p class="${tooRestless ? "nsd-err" : "nsd-warn"}">${esc(t.warnUnstable)}</p>` : "");
        if (!tooRestless) {
          const e = entry(opts.getConfig(), device());
          html += `<div class="nsd-opt"><label>${esc(t.resName)}</label><input type="text"${field} maxlength="60" data-ns-name value="${esc(view.resultName || "")}"></div><div class="nsd-actions">`
            + e.slots.map((s, i) => `<button type="button" class="${s ? btn : primary}" data-ns-act="save" data-slot="${i}">${esc(fill(t.resSaveTo, { slot: i + 1 }))}</button>`).join("");
        } else {
          html += `<div class="nsd-actions">`;
        }
        html += `<button type="button" class="${btn}" data-ns-act="discard">${esc(t.resDiscard)}</button></div></div>`;
      } else {
        html += `<div class="nsd-actions"><button type="button" class="${primary}" data-ns-act="start"${device() ? "" : " disabled"}>${esc(t.calStart)}</button></div>`;
      }
      box.innerHTML = html;
      box.querySelector("[data-ns-name]")?.addEventListener("input", (ev) => { view.resultName = ev.target.value; });
      box.querySelectorAll("[data-ns-act]").forEach((b) => b.addEventListener("click", () => calibrationAction(b.dataset.nsAct, Number(b.dataset.slot))));
    }

    async function calibrationAction(act, slot) {
      view.error = "";
      if (act === "start") view.confirming = true;
      else if (act === "cancel") view.confirming = false;
      else if (act === "discard") view.result = null;
      else if (act === "save") {
        const e = entry(opts.getConfig(), device());
        if (e.slots[slot] && !ask(fill(t.confirmOverwrite, { slot: slot + 1 }))) return;
        // the preview picture is only for looking at it here, the slot does not keep it
        const { image, ...result } = view.result;
        view.result = null;
        await change("save", { slot, result, name: view.resultName || "" });
        return;
      } else if (act === "calibrate") {
        view.confirming = false;
        view.result = null;
        view.resultName = "";
        try {
          view.calib = await opts.command({ nosignal: "calibrate", duration: CALIBRATION_MS });
          renderCalibration();
          while (view.calib && view.calib.running && element.isConnected) {
            await new Promise((res) => setTimeout(res, 300));
            view.calib = await opts.command({ nosignal: "calibration" });
            renderCalibration();
          }
          if (view.calib && view.calib.error) view.error = view.calib.error === "frames" ? t.calFailFrames : fill(t.calFail, { msg: view.calib.error });
          else if (view.calib && view.calib.result) view.result = view.calib.result;
        } catch (e) {
          view.error = fill(t.calFail, { msg: e.message || String(e) });
        }
        view.calib = null;
      }
      renderCalibration();
    }

    function renderConfig(force) {
      const gt = opts.getConfig() || {};
      const o = options(gt);
      const dev = device();
      const e = entry(gt, dev);
      const others = Object.keys((gt.noSignal && gt.noSignal.grabbers) || {}).filter((d) => d !== dev && entry(gt, d).slots.some(Boolean));
      const light = JSON.stringify([o, dev, e.active, e.slots.map((s) => s && [s.name, s.savedAt, s.featureCells]), others, lang]);
      const box = $("config");
      if (!force && light === view.configKey) return;
      // do not rebuild under a name being typed
      if (!force && box.contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
      view.configKey = light;

      // settings first, the slots at the end: set up, then save
      let html = `<h5>${esc(t.optTitle)}</h5><div class="nsd-box">`
        + `<label class="nsd-switch"><input type="checkbox" data-ns-opt="enable"${o.enable ? " checked" : ""}> ${esc(t.enable)}</label>`
        + `<p class="nsd-muted" style="margin:4px 0 0">${esc(t.enableHint)}</p>`
        + `<div class="nsd-opt"><label>${esc(t.action)}</label><select${field} data-ns-opt="action">`
        + [["release", t.actionRelease], ["black", t.actionBlack]].map(([v, l]) => `<option value="${v}"${o.action === v ? " selected" : ""}>${esc(l)}</option>`).join("")
        + `</select></div>`
        + `<div class="nsd-opt"><label>${esc(t.delay)}</label><input type="number"${field} min="0.5" max="120" step="0.5" value="${o.delay}" data-ns-opt="delay"><p class="nsd-muted">${esc(t.delayHint)}</p></div>`
        + `<div class="nsd-opt"><label>${esc(t.tolerance)}</label><input type="number"${field} min="4" max="100" step="1" value="${o.tolerance}" data-ns-opt="tolerance"><p class="nsd-muted">${esc(t.toleranceHint)}</p></div>`
        + `<div class="nsd-opt"><label>${esc(t.match)}</label><input type="number"${field} min="50" max="100" step="1" value="${o.match}" data-ns-opt="match"><p class="nsd-muted">${esc(t.matchHint)}</p></div>`
        + `</div>`;
      html += `<h5>${esc(t.slotsTitle)}</h5>`;
      e.slots.forEach((s, i) => {
        const label = fill(t.slot, { n: i + 1 });
        const active = e.active === i && !!s;
        html += `<div class="nsd-slot${active ? " on" : ""}"><div class="nsd-slot-head"><b>${esc(label)}</b>`;
        if (s) {
          html += `<input type="text"${field} maxlength="60" value="${esc(s.name)}" placeholder="${esc(label)}" aria-label="${esc(fill(t.rename, { slot: label }))}" data-ns-rename="${i}">`;
          if (active) html += `<span class="nsd-badge${o.enable ? "" : " idle"}">${esc(o.enable ? t.inUse : t.chosen)}</span>`;
          html += `</div><p class="nsd-info nsd-muted">${esc(fill(t.slotInfo, { date: fmtDate(s.savedAt), features: s.featureCells ?? "–" }))}</p><div class="nsd-slot-actions">`;
          if (!active) html += `<button type="button" class="${btn}" data-ns-op="use" data-slot="${i}">${esc(t.use)}</button>`;
          html += `<button type="button" class="${btn}" data-ns-op="clear" data-slot="${i}">${esc(t.clear)}</button></div>`;
        } else {
          html += `<span class="nsd-muted">${esc(t.slotEmpty)}</span></div>`;
        }
        html += `</div>`;
      });
      if (others.length) {
        html += `<p class="nsd-muted" style="margin:8px 0 0">${esc(t.others)}:</p><div class="nsd-box">`
          + others.map((d) => `<div class="nsd-other"><span>${esc(displayName(d))}</span><button type="button" class="${btn}" data-ns-forget="${esc(d)}">${esc(t.forget)}</button></div>`).join("")
          + `</div>`;
      }

      box.innerHTML = html;

      box.querySelectorAll("[data-ns-op]").forEach((b) => b.addEventListener("click", () => {
        const i = Number(b.dataset.slot);
        if (b.dataset.nsOp === "clear" && !ask(fill(t.confirmClear, { slot: fill(t.slot, { n: i + 1 }) }))) return;
        change(b.dataset.nsOp, { slot: i });
      }));
      box.querySelectorAll("[data-ns-rename]").forEach((inp) => inp.addEventListener("change", () => change("rename", { slot: Number(inp.dataset.nsRename), name: inp.value })));
      box.querySelectorAll("[data-ns-forget]").forEach((b) => b.addEventListener("click", () => {
        if (ask(fill(t.confirmForget, { name: displayName(b.dataset.nsForget) }))) change("forget", { device: b.dataset.nsForget });
      }));
      box.querySelectorAll("[data-ns-opt]").forEach((inp) => inp.addEventListener("change", () => {
        const k = inp.dataset.nsOpt;
        change("options", { [k]: k === "enable" ? inp.checked : k === "action" ? inp.value : Number(inp.value) });
      }));
    }

    // the status (with the picture) once a second while the section is on screen
    let timer = null;
    async function poll() {
      timer = null;
      if (!element.isConnected) return;
      const visible = (typeof document === "undefined" || document.visibilityState !== "hidden") && element.offsetParent !== null;
      if (visible) {
        try {
          view.status = await opts.command({ nosignal: "status", image: true });
        } catch (e) {
          view.status = null;
        }
        renderStatus();
        renderConfig(false);
        if (!view.calib && !view.confirming && !view.result) renderCalibration();
      }
      if (element.isConnected) timer = setTimeout(poll, POLL_MS);
    }

    renderConfig(true);
    renderCalibration();
    poll();
    return {
      update() { renderConfig(false); renderStatus(); },
      stop() { if (timer) clearTimeout(timer); timer = null; },
    };
  }

  const api = { applyOp, options, entry, render, displayName, TEXT, DEFAULTS, SLOT_COUNT };
  global.NoSignalUI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
