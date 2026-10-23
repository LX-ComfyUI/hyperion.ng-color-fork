// Texts of the notices (bell) of the test server, German and English. Used by the test page, the test
// server (for the Hyperion WebUI bell) and so kept in one place: a new kind of notice needs its text here.
(function (global) {
  const TEXT = {
    de: {
      tvConnected: ["TV-Seite verbunden", "Die TV-Seite ist wieder mit der Testseite verbunden."],
      tvLost: ["TV-Seite getrennt", "Die TV-Seite ist nicht mehr verbunden. Tests und Kalibrierungen brauchen sie, bitte auf dem TV-Gerät neu öffnen."],
      gtDone: ["Grabber-Kalibrierung fertig", "Noch in einen Speicherplatz speichern, sonst wirkt die Korrektur nicht."],
      gtAborted: ["Grabber-Kalibrierung abgebrochen", "Es wurde nichts gespeichert."],
      gtError: ["Grabber-Kalibrierung fehlgeschlagen", "{error}"],
      guideDone: ["LED-Position-Kalibrierung fertig", "Die Messung ist abgeschlossen."],
      guideAborted: ["LED-Position-Kalibrierung abgebrochen", "Zum Weitermachen neu starten."],
      nsCalibDone: ["No-Signal-Kalibrierung fertig", "Das Ergebnis steht in der Karte."],
      paused: ["Tests pausiert", "{tests}Keine Testseite war mehr verbunden. Zum Weitermachen neu starten."],
      hyperionDown: ["Hyperion nicht erreichbar", "Die Testseite erreicht Hyperion nicht mehr. Läuft der Dienst noch?"],
      hyperionUp: ["Hyperion wieder erreichbar", ""],
      grabberStuck: ["Kein Grabber erkannt", "Der Grabber hängt oder wurde entfernt. USB-Anschluss und Kabel prüfen."],
      grabberOk: ["Grabber liefert wieder Bilder", ""],
      noSignal: ["Kein Signal", ""],
      signalBack: ["Signal wieder da", ""],
      grabberKnown: ["Bekannter Grabber: {name}", "Er läuft mit seinen zuletzt benutzten Einstellungen. No-Signal-Erkennung: {ns}. Farbkorrektur: {color}."],
      grabberNew: ["Neuer Grabber: {name}", "Für diesen Grabber fehlt die Kalibrierung: {what}. Das bleibt für ihn aus, bis er kalibriert ist."],
      activeSlot: "Platz aktiv", whatNs: "No-Signal-Erkennung", whatColor: "Farbkorrektur",
    },
    en: {
      tvConnected: ["TV page connected", "The TV page is connected to the test page again."],
      tvLost: ["TV page disconnected", "The TV page is no longer connected. Tests and calibrations need it, please open it again on the TV device."],
      gtDone: ["Grabber calibration finished", "Still save it in a memory slot, or the correction has no effect."],
      gtAborted: ["Grabber calibration aborted", "Nothing was saved."],
      gtError: ["Grabber calibration failed", "{error}"],
      guideDone: ["LED position calibration finished", "The measurement is complete."],
      guideAborted: ["LED position calibration aborted", "Start it again to continue."],
      nsCalibDone: ["No-signal calibration finished", "The result is in the card."],
      paused: ["Tests paused", "{tests}No control page was connected any more. Start again to continue."],
      hyperionDown: ["Hyperion not reachable", "The test page can no longer reach Hyperion. Is the service still running?"],
      hyperionUp: ["Hyperion reachable again", ""],
      grabberStuck: ["No grabber detected", "The grabber is stuck or was removed. Check the USB port and the cable."],
      grabberOk: ["Grabber delivers frames again", ""],
      noSignal: ["No signal", ""],
      signalBack: ["Signal is back", ""],
      grabberKnown: ["Known grabber: {name}", "It runs with the settings it used last. No-signal detection: {ns}. Color correction: {color}."],
      grabberNew: ["New grabber: {name}", "This grabber is not calibrated: {what}. That stays off for it until it is calibrated."],
      activeSlot: "active slot", whatNs: "No-signal detection", whatColor: "Color correction",
    },
  };
  const TEST_NAMES = {
    de: { grayTest: "Graues Standbild", bars: "Schwarze Balken", depthTest: "Erfassungstiefe", fracTest: "Nachkommastellen", posTest: "LED-Position", posGuide: "LED-Position kalibrieren", color: "Testfarben" },
    en: { grayTest: "Gray still image", bars: "Black bars", depthTest: "Capture depth", fracTest: "Fractional digits", posTest: "LED position", posGuide: "LED position calibration", color: "Test colors" },
  };
  // the card of the test page that belongs to a paused test
  const TEST_CARDS = { grayTest: "card-gs", bars: "card-bars", depthTest: "card-dt", fracTest: "card-ft", posTest: "card-lp", posGuide: "card-lg", color: "card-color" };

  const fill = (s, p) => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));

  // { title, text, target } of a notice in lang ("de" | "en"); target = id of the card to go to
  function info(n, lang) {
    const t = TEXT[lang] ?? TEXT.de;
    const names = TEST_NAMES[lang] ?? TEST_NAMES.de;
    const q = n.params ?? {};
    const pair = t[n.kind];
    if (!Array.isArray(pair)) return { title: n.kind, text: "", target: n.target || "" };
    const keys = Array.isArray(q.tests) ? q.tests : [];
    const p = {
      name: q.name ?? "", error: q.error ?? "",
      tests: keys.length ? keys.map((k) => names[k] ?? k).join(", ") + ". " : "",
      ns: q.nsSlot || t.activeSlot, color: q.colorSlot || t.activeSlot,
      what: (q.missing ?? []).map((m) => (m === "ns" ? t.whatNs : t.whatColor)).join(" + "),
    };
    return { title: fill(pair[0], p), text: fill(pair[1], p), target: n.target || TEST_CARDS[keys[0]] || "" };
  }
  global.NoticeText = { info, TEST_CARDS };
})(typeof window !== "undefined" ? window : globalThis);
