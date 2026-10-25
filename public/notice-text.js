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
      gcgDone: ["Graukurven-Kalibrierung fertig", "Die neue Kurve wirkt schon. Als Speicherplatz sichern, damit sie bleibt, wenn ein anderer Platz geladen wird."],
      gcgAborted: ["Graukurven-Kalibrierung abgebrochen", "Die Änderungen bis dahin bleiben, „Zurück“ bei der Graukurve nimmt sie zurück."],
      gcgError: ["Graukurven-Kalibrierung fehlgeschlagen", "{error}"],
      mediaError: ["TV kann „{name}“ nicht zeigen", "{error}"],
      ffmpegMissing: ["ffmpeg fehlt auf dem Server", "Videos lassen sich trotzdem hochladen und abspielen. Ohne ffmpeg erkennt die Testseite aber Codec, 10 Bit, HDR und Länge nicht und kann nicht vorher sagen, ob der TV-Browser ein Video kann. Vorschaubilder gibt es nur, wenn der Browser beim Hochladen das Video lesen kann. Nachinstallieren auf dem Server, z. B. mit: sudo apt install ffmpeg"],
      portChanged: ["Testseite jetzt auf Port {to}", "Bisher Port {from}. Bitte prüfen und anpassen: Lesezeichen oder Startseite auf dem TV-Gerät (neu: Adresse des Servers mit :{to}/tv), Lesezeichen und Verknüpfungen auf Handy, Tablet und PC (:{to}), Portfreigaben im Router, Firewall-Regeln und Einträge in einem Reverse-Proxy, die noch auf {from} zeigen. Von selbst ziehen mit: offene Testseiten, der QR-Code auf dem TV, die Links im Hyperion-WebUI und die Einstellungen dieser Seite."],
      portTaken: ["Port {port} belegt", "Die Testseite läuft deshalb auf dem Standard-Port 8093. Einen freien Port in der Karte Testserver einstellen."],
      gcSlotLoaded: ["Graukurve für {name}", "Speicherplatz „{slot}“ geladen, den dieser Grabber zuletzt benutzt hat."],
      gcNewGrabber: ["Graukurve bei neuem Grabber: {name}", "Es läuft weiter die Graukurve des bisherigen Grabbers{slotText}. Prüfe die Grautöne mit den Testfarben. Eine neue Kalibrierung der Graukurve ist kein Muss."],
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
      gcgDone: ["Gray curve calibration finished", "The new curve is already in use. Save it in a memory slot so it stays when another slot is loaded."],
      gcgAborted: ["Gray curve calibration aborted", "The changes made so far stay, \u201cBack\u201d at the gray curve undoes them."],
      gcgError: ["Gray curve calibration failed", "{error}"],
      mediaError: ["TV cannot show \u201c{name}\u201d", "{error}"],
      ffmpegMissing: ["ffmpeg is missing on the server", "Videos can still be uploaded and played. Without ffmpeg the test page cannot tell codec, 10 bit, HDR and length, nor say beforehand whether the TV browser can play a video. Thumbnails only exist when the browser can read the video while uploading. Install it on the server, e.g. with: sudo apt install ffmpeg"],
      portChanged: ["Test page now on port {to}", "Port {from} before. Please check and change: the bookmark or start page on the TV device (new: the server's address with :{to}/tv), bookmarks and shortcuts on phone, tablet and PC (:{to}), port forwardings in the router, firewall rules and reverse proxy entries that still point to {from}. These follow by themselves: open test pages, the QR code on the TV, the links in the Hyperion WebUI and the settings of this page."],
      portTaken: ["Port {port} taken", "So the test page runs on the standard port 8093. Set a free port in the card Test server."],
      gcSlotLoaded: ["Gray curve for {name}", "Loaded memory slot \u201c{slot}\u201d, the one this grabber used last."],
      gcNewGrabber: ["Gray curve with a new grabber: {name}", "The gray curve of the previous grabber keeps running{slotText}. Check the gray tones with the test colors. A new calibration of the gray curve is not a must."],
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
    de: { grayTest: "Graues Standbild", bars: "Schwarze Balken", depthTest: "Erfassungstiefe", fracTest: "Nachkommastellen", posTest: "LED-Position", posGuide: "LED-Position kalibrieren", gcGuide: "Graukurve kalibrieren", color: "Testfarben" },
    en: { grayTest: "Gray still image", bars: "Black bars", depthTest: "Capture depth", fracTest: "Fractional digits", posTest: "LED position", posGuide: "LED position calibration", gcGuide: "Gray curve calibration", color: "Test colors" },
  };
  // the card of the test page that belongs to a paused test
  const TEST_CARDS = { grayTest: "card-gs", bars: "card-bars", depthTest: "card-dt", fracTest: "card-ft", posTest: "card-lp", posGuide: "card-lg", gcGuide: "card-gcg", color: "card-color" };

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
      name: q.name ?? "", error: q.error ?? "", slot: q.slot ?? "", port: q.port ?? "", from: q.from ?? "", to: q.to ?? "",
      slotText: q.slot ? (lang === "en" ? ` (memory slot \u201c${q.slot}\u201d)` : ` (Speicherplatz „${q.slot}“)`) : "",
      tests: keys.length ? keys.map((k) => names[k] ?? k).join(", ") + ". " : "",
      ns: q.nsSlot || t.activeSlot, color: q.colorSlot || t.activeSlot,
      what: (q.missing ?? []).map((m) => (m === "ns" ? t.whatNs : t.whatColor)).join(" + "),
    };
    return { title: fill(pair[0], p), text: fill(pair[1], p), target: n.target || TEST_CARDS[keys[0]] || "" };
  }
  global.NoticeText = { info, TEST_CARDS };
})(typeof window !== "undefined" ? window : globalThis);
