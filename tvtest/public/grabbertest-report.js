// Report of the grabber test of the Hyperion fork: how the video grabber sees known test colors.
//
// The TV test page shows each color full screen on the device that feeds the TV, Hyperion measures
// the decoded grabber frames (VideoProbe, before any calibration) and the test page stores the
// result in the global setting "grabberTest". This file holds the test steps, the evaluation and
// the rendering, shared by the TV test page and the fork WebUI (Aufnahme Hardware), so it has no
// dependencies.
//
//   GrabberTestReport.basicSteps()                       the steps of the basic test, in order
//   GrabberTestReport.analyze(result)                    numbers and findings of a basic test
//   GrabberTestReport.render(element, { basic, custom, current, lang })
//
// result = { date, grabber: { name, device, width, height, fps, encoding, ... }, frame: { width, height },
//            steps: [{ group, name?, sent: [r, g, b], got: [r, g, b], noise: [..], spread: [..], n }] }
(function (global) {
  "use strict";

  const GRAYS = [2, 4, 8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 160, 192, 224, 235, 245, 255];
  const PRIMARY_LEVELS = [4, 8, 16, 32, 50, 128, 192, 224, 240, 255];
  const SECONDARY_LEVELS = [16, 50, 128, 192, 224, 240, 255];
  const LADDERS = [
    ["red", [1, 0, 0], PRIMARY_LEVELS],
    ["green", [0, 1, 0], PRIMARY_LEVELS],
    ["blue", [0, 0, 1], PRIMARY_LEVELS],
    ["cyan", [0, 1, 1], SECONDARY_LEVELS],
    ["magenta", [1, 0, 1], SECONDARY_LEVELS],
    ["yellow", [1, 1, 0], SECONDARY_LEVELS],
  ];
  const MIXES = [
    ["orange", [255, 128, 0]],
    ["skin", [225, 170, 140]],
  ];
  const CHANNEL_COLORS = ["#e5484d", "#2fa36b", "#3b82f6"];
  // colors of the before/after table of the correction
  const COMPARE = [
    ["red", [255, 0, 0]], ["green", [0, 255, 0]], ["green", [0, 128, 0]], ["blue", [0, 0, 255]],
    ["cyan", [0, 255, 255]], ["magenta", [255, 0, 255]], ["yellow", [255, 255, 0]],
    ["mix", [255, 128, 0]], ["mix", [225, 170, 140]], ["gray", [128, 128, 128]],
  ];

  // grabber settings that change what the grabber delivers; a result taken with other values is outdated
  const GRABBER_KEYS = ["device", "input", "width", "height", "fps", "encoding", "hardware_brightness", "hardware_contrast", "hardware_saturation", "hardware_hue"];

  const TEXT = {
    de: {
      title: "Grabber-Test",
      none: "Noch kein Grabber-Test gespeichert.",
      measured: "Gemessen am {date}",
      frame: "Bild {w}×{h}",
      stale: "Seit diesem Test wurden Grabber-Einstellungen geändert ({keys}). Wiederhole den Test, damit die Werte wieder stimmen.",
      gray: "Grau",
      red: "Rot", green: "Grün", blue: "Blau", cyan: "Cyan", magenta: "Magenta", yellow: "Gelb",
      orange: "Orange", skin: "Hautton", black: "Schwarz", custom: "Eigene Farbe",
      grayChart: "Graustufen",
      grayChartHint: "Waagerecht die gesendete Stufe, senkrecht was der Grabber liefert. Die gepunktete Linie ist ideal. Beide Achsen sind gestaucht, damit die dunklen Stufen lesbar bleiben.",
      ladders: "Farbleitern",
      laddersHint: "Jede Farbe in mehreren Helligkeiten. Durchgezogen der Kanal der Farbe, gestrichelt die Kanäle, die dunkel bleiben sollten.",
      colLadder: "Farbe", colVisible: "erkennbar ab", colPure: "Farbton stimmt ab", colStrength: "Stärke bei 128", colPurity: "Fremdanteil bei 255",
      never: "nie",
      allValues: "Alle Messwerte",
      colColor: "Farbe", colSent: "gesendet", colGot: "Grabber", colDiff: "Abweichung", colNoise: "Rauschen",
      customTitle: "Eigene Farben",
      customMeasured: "Gemessen am {date}",
      f_blackGood: "Schwarz kommt als {v} an. Ideal ist 0, das passt.",
      f_blackLift: "Schwarz ist angehoben: Es kommt als {v} statt 0 an. Dunkle Szenen wirken an den LEDs dadurch heller und flauer.",
      f_blackHigh: "Schwarz ist deutlich angehoben: Es kommt als {v} statt 0 an. Prüfe den HDMI-Farbbereich des Zuspielgeräts und die Hardware-Helligkeit des Grabbers.",
      f_limited: "Schwarz kommt als etwa {b} und Weiß als etwa {w} an. Das Zuspielgerät sendet sehr wahrscheinlich Limited Range (16–235), und der Grabber rechnet es nicht auf 0–255 um. Stelle am Zuspielgerät Full Range (0–255) ein.",
      f_whiteGood: "Weiß kommt als {v} an. Das passt.",
      f_whiteLow: "Weiß erreicht nur {v} statt 255. Helle Farben kommen etwas dunkler an.",
      f_darkGood: "Auch die dunkelsten Graustufen sind unterscheidbar.",
      f_darkSmall: "Grau 2 lässt sich nicht von Schwarz unterscheiden. Das ist normal, ab Grau 4 ist alles unterscheidbar.",
      f_darkLost: "Dunkle Stufen gehen verloren: Grau 0 bis {v} kommt gleich an.",
      f_darkClipped: "Grau 0 bis {v} kommt gleich an, Schwarz wird abgeschnitten. Wahrscheinlich passen die Farbbereiche nicht zusammen: Das Zuspielgerät sendet Full Range, der Grabber erwartet Limited Range (oder umgekehrt).",
      f_lightLost: "Helle Stufen gehen verloren: Grau {v} bis 255 kommt gleich an.",
      f_tintGood: "Grau bleibt neutral (höchstens {v} Stufen Unterschied zwischen den Kanälen).",
      f_tintWarn: "Grau bekommt einen leichten Farbstich: bei Grau {s} bis zu {v} Stufen, {c} ist am stärksten.",
      f_tintBad: "Grau hat einen deutlichen Farbstich: bei Grau {s} bis zu {v} Stufen, {c} ist am stärksten.",
      f_noiseGood: "Rauschen: ±{v} Stufen. Das Bild ist ruhig.",
      f_noiseWarn: "Rauschen: ±{v} Stufen. Etwas unruhig, die LEDs mitteln das aber weg.",
      f_noiseBad: "Rauschen: ±{v} Stufen. Das Bild ist sehr unruhig.",
      f_drift: "Schwarz hat sich während des Tests um {v} Stufen verändert. Der Grabber war noch nicht stabil, wiederhole den Test.",
      f_darkInvisible: "Sehr dunkle Farben gehen verloren: {list}.",
      f_darkHue: "Dunkle Farben verlieren ihren Farbton: {list}.",
      f_darkHueGood: "Auch dunkle Farben behalten ihren Farbton.",
      f_crosstalk: "Farben sind nicht rein: {list}. Das deutet auf eine abweichende Farbmatrix (BT.601/BT.709) oder eine Farbsättigungs-Einstellung hin.",
      f_strengthGood: "Alle Farben kommen ungefähr gleich stark an wie Grau (Abweichung höchstens {v} %).",
      f_strength: "Farben kommen unterschiedlich stark an: {list} (bei Stufe 128, Grau 128 = 100 %).{effect}",
      strengthWeak: " Zu schwache Farben leuchten an den LEDs schwächer, als sie im Bild sind.",
      strengthStrong: " Zu starke Farben leuchten an den LEDs kräftiger, als sie im Bild sind.",
      f_strengthClip: "Verstärkte Farben erreichen den Höchstwert schon vor 255: {list}. Hellere Töne dieser Farben lassen sich nicht mehr unterscheiden.",
      f_matrix: "Fremdanteile und ungleiche Stärke zusammen sind das typische Bild einer abweichenden Farbmatrix: Der Grabber (oder ein Gerät davor, etwa ein HDMI-Splitter) rechnet die Farben mit einer anderen Norm um, als das Zuspielgerät sendet. Der Fernseher ist daran nicht beteiligt, weil der Grabber das Signal vor ihm abgreift. Graustufen sind davon nicht betroffen.",
      f_unstable: "{n} Schritte wurden nicht ganz ruhig gemessen. Wiederhole den Test, wenn Werte seltsam aussehen.",
      pureFromItem: "{c} erst ab {v}",
      visibleFromItem: "{c} erst ab {v} erkennbar",
      neverItem: "{c} gar nicht",
      crosstalkItem: "{c} {v} %",
      strengthItem: "{c} {v} %",
      clipItem: "{c} bei etwa {v}",
      corrTitle: "Grabber-Farbkorrektur",
      corrOn: "Die Grabber-Farbkorrektur ist eingeschaltet (berechnet aus dem Grundtest vom {date}).",
      corrOff: "Die Grabber-Farbkorrektur ist ausgeschaltet.",
      corrRaw: "Gemessen wird immer das unkorrigierte Grabber-Bild. Die Befunde oben beschreiben also den Grabber selbst, auch wenn die Korrektur eingeschaltet ist.",
      corrMeasured: "Mit der Korrektur gemessen: Abweichung im Mittel {mean}, höchstens {max} Stufen (ohne Korrektur {bmean} / {bmax}).",
      corrFitGood: "Die Farben weichen kaum ab (im Mittel {mean}, höchstens {max} Stufen). Eine Korrektur ist nicht nötig.",
      corrFit: "Eine aus diesem Grundtest berechnete Korrektur senkt die Abweichung von im Mittel {bmean} / höchstens {bmax} auf {mean} / {max} Stufen.",
      corrFitNone: "Aus diesem Grundtest lässt sich keine Korrektur berechnen ({why}).",
      corrWhyData: "zu wenige brauchbare Messwerte",
      corrWhyRange: "die nötige Korrektur wäre zu stark",
      corrStale: "Dieser Grundtest ist neuer als die eingeschaltete Korrektur. Mit ihr bliebe hier eine Abweichung von im Mittel {mean}, höchstens {max} Stufen.",
      corrStaleBad: "Die eingeschaltete Korrektur passt nicht mehr zu diesem Grundtest. Berechne sie neu.",
      corrLost: "Nicht korrigierbar, weil der Grabber diese Werte schon abschneidet: {list}. Sie werden so gut wie möglich angenähert.",
      corrHow: "Die Korrektur ist eine 3×3-Farbmatrix, die Hyperion direkt auf das Grabber-Bild anwendet, vor allen anderen Einstellungen. Grau bleibt dabei unverändert, Gamma, Weißpunkt und Graukurve bleiben also gültig. Prüfe nach dem Einschalten aber die Farbkalibrierung (Rot, Grün, Blau, Cyan, Magenta, Gelb).",
      corrWhere: "Ein- und ausschalten und zwischen den Speicherplätzen wechseln kannst du oben bei den Kalibrierungen dieses Grabbers (im Hyperion-WebUI im Expertenmodus).",
      corrMatrix: "Matrix aus dem Grundtest vom {date}",
      corrSwitch: "Grabber-Farbkorrektur aktiv",
      slTitle: "Kalibrierungen dieses Grabbers",
      slSelect: "Grabber",
      slSelectHint: "Der Grabber, den Hyperion verwendet (wie im WebUI unter Aufnahme Hardware → USB-Aufnahme → Gerät gefunden). Ein anderer stellt Hyperion um.",
      slMissing: "{name} (nicht angeschlossen)",
      slConfirmSwitch: "Hyperion auf den Grabber {name} umstellen? Die Aufnahme startet dabei neu, die LEDs sind kurz aus.",
      slGrabber: "Grabber: {name}",
      slNoDevice: "Kein Grabber erkannt. Sobald der Grabber Bilder liefert, erscheint hier sein Name.",
      slIntro: "Jedes Grabber-Modell hat drei Speicherplätze. Verwendet wird der aktive Platz des Grabbers, der gerade angeschlossen ist. Nach einem Grabberwechsel gilt automatisch dessen Kalibrierung, für einen Grabber ohne Kalibrierung bleibt die Korrektur aus.",
      slSlot: "Platz {n}",
      slEmpty: "leer",
      slActive: "aus",
      slInUse: "läuft",
      slNamePh: "Name, z. B. mit Splitter",
      slInfo: "Grundtest vom {date} · Abweichung {before} → {after} Stufen im Mittel",
      slUse: "Verwenden",
      slSave: "Letzten Grundtest hier speichern",
      slOverwrite: "Mit letztem Grundtest überschreiben",
      slClear: "Löschen",
      slConfirmOverwrite: "{slot} mit dem Grundtest vom {date} überschreiben?",
      slConfirmClear: "{slot} löschen?",
      slSaveHint: "Speichern legt die aus dem letzten Grundtest ({date}) berechnete Korrektur im Platz ab und verwendet sie.",
      slOtherTest: "Der letzte Grundtest stammt vom Grabber {name}. Mach zuerst einen Grundtest mit diesem Grabber, um hier zu speichern.",
      slNoTest: "Noch kein Grundtest. Nach dem ersten Grundtest kannst du ihn hier speichern.",
      slOthers: "Andere Grabber ({n})",
      slOtherLine: "{used} von 3 Plätzen belegt · {state}",
      slOtherOn: "Korrektur an: {slot}",
      slOtherOff: "Korrektur aus",
      slForget: "Entfernen",
      slConfirmForget: "Alle Kalibrierungen von {name} entfernen?",
      errNoDevice: "Kein Grabber erkannt",
      errNoTest: "Noch kein Grundtest gespeichert",
      errOtherTest: "Der letzte Grundtest stammt von einem anderen Grabber",
      errFit: "Aus dem letzten Grundtest lässt sich keine Korrektur berechnen",
      errNoSlot: "Dieser Speicherplatz ist leer",
      ntTitle: "Benachrichtigungen",
      ntNone: "Keine neuen Meldungen.",
      ntNewGrabber: "Neuer Grabber erkannt: {name}",
      ntNewGrabberText: "Für diesen Grabber ist noch keine Farbkalibrierung gespeichert, die Grabber-Farbkorrektur bleibt für ihn deshalb aus. Kalibrieren kannst du ihn auf der TV-Testseite in der Karte „Grabber-Farberkennung“.",
      ntSeen: "Gesehen",
      vgTitle: "Messungen vergleichen",
      vgIntro: "Vergleicht zwei gespeicherte Grundtests im Detail, vom selben oder von verschiedenen Grabbern: Kennzahlen, jeden Messschritt und die Korrekturmatrix.",
      vgNeedTwo: "Zum Vergleichen sind mindestens zwei gespeicherte Messungen nötig. Messungen entstehen mit dem Grundtest und liegen in den Speicherplätzen.",
      vgA: "Messung A", vgB: "Messung B", vgGrabber: "Grabber", vgPick: "Messung",
      vgLast: "Letzter Grundtest · {date}", vgSlot: "Platz {n}{name} · {date}", vgNoMeasure: "ohne gespeicherte Messung",
      vgGo: "Vergleichen", vgSame: "Beide Seiten sind dieselbe Messung, es gibt nichts zu vergleichen.",
      vgSummary: "{k} von {n} Messschritten weichen um mehr als {x} Stufen voneinander ab, am meisten {name} ({v} Stufen).",
      vgSummaryNone: "Alle {n} Messschritte liegen höchstens {x} Stufen auseinander.",
      vgMetrics: "Kennzahlen", vgMetric: "Kennzahl", vgDelta: "Unterschied (B − A)",
      mBlack: "Schwarzwert", mWhite: "Weißwert", mGain: "Spreizung Weiß − Schwarz", mDarkLost: "Dunkle Stufen wie Schwarz bis", mLightLost: "Helle Stufen wie Weiß ab",
      mTint: "Farbstich der Grautöne", mNoise: "Rauschen bei 128", mDrift: "Schwarz-Drift",
      vgSteps: "Alle Messschritte im Vergleich ({n}, {k} mit Abweichung)", vgOnlyOne: "nur in einer Messung",
      vgChart: "Graustufen im Vergleich", vgChartHint: "Die Graustufen beider Messungen wie im Ergebnis: Rot, Grün und Blau über dem gesendeten Wert.",
      vgFindings: "Befund",
      vgCustom: "Eigene Farben im Vergleich", vgCustomNone: "In keiner der beiden Messungen sind eigene Farben gespeichert. Sie werden mit dem Platz gespeichert, wenn sie vor dem Speichern gemessen wurden (ältere Plätze haben keine).", vgCustomOne: "Nur eine der beiden Messungen hat eigene Farben gespeichert, ein Vergleich ist nicht möglich.",
      vgChannels: "Je Kanal übereinander: Messung A blau durchgezogen, Messung B orange gestrichelt.",
      vgLadders: "Farbleitern im Vergleich", vgLaddersHint: "Je Farbe Messung A, Messung B und beide übereinander (A blau durchgezogen, B orange gestrichelt, nur die Hauptkanäle der Farbe).", vgOver: "übereinander",
      vgMatrix: "Korrekturmatrix", vgNoMatrix: "keine Korrektur berechenbar", vgMatrixDelta: "Größter Unterschied der Matrixwerte: {v}.",
      cmpTitle: "Ohne und mit Korrektur",
      cmpMeasured: "Ausgewählte Testfarben, mit Korrektur über Hyperion gemessen.",
      cmpCalc: "Ausgewählte Testfarben, mit Korrektur berechnet. Ein Grundtest bei eingeschalteter Korrektur misst die Werte.",
      colWithout: "ohne Korrektur",
      colWith: "mit Korrektur",
      corrEnable: "Korrektur aus diesem Grundtest einschalten",
      corrRecompute: "Korrektur aus diesem Grundtest neu berechnen",
      corrDisable: "Korrektur ausschalten",
      colCorr: "mit Korrektur",
      keys: { device: "Gerät", input: "Eingang", width: "Breite", height: "Höhe", fps: "Bildrate", encoding: "Format", hardware_brightness: "Helligkeit", hardware_contrast: "Kontrast", hardware_saturation: "Sättigung", hardware_hue: "Farbton" },
    },
    en: {
      title: "Grabber test",
      none: "No grabber test stored yet.",
      measured: "Measured on {date}",
      frame: "Frame {w}×{h}",
      stale: "Grabber settings changed since this test ({keys}). Repeat the test to get valid values again.",
      gray: "Gray",
      red: "Red", green: "Green", blue: "Blue", cyan: "Cyan", magenta: "Magenta", yellow: "Yellow",
      orange: "Orange", skin: "Skin tone", black: "Black", custom: "Own color",
      grayChart: "Gray levels",
      grayChartHint: "Horizontal the level sent, vertical what the grabber delivers. The dotted line is ideal. Both axes are compressed so the dark levels stay readable.",
      ladders: "Color ladders",
      laddersHint: "Each color at several brightness levels. Solid: the color's channel, dashed: the channels that should stay dark.",
      colLadder: "Color", colVisible: "visible from", colPure: "hue correct from", colStrength: "strength at 128", colPurity: "foreign share at 255",
      never: "never",
      allValues: "All measured values",
      colColor: "Color", colSent: "sent", colGot: "grabber", colDiff: "deviation", colNoise: "noise",
      customTitle: "Own colors",
      customMeasured: "Measured on {date}",
      f_blackGood: "Black arrives as {v}. Ideal is 0, that's fine.",
      f_blackLift: "Black is lifted: it arrives as {v} instead of 0. Dark scenes look brighter and flatter on the LEDs.",
      f_blackHigh: "Black is lifted a lot: it arrives as {v} instead of 0. Check the HDMI color range of the source device and the hardware brightness of the grabber.",
      f_limited: "Black arrives as about {b} and white as about {w}. The source device most likely sends limited range (16–235) and the grabber does not expand it to 0–255. Set the source device to full range (0–255).",
      f_whiteGood: "White arrives as {v}. That's fine.",
      f_whiteLow: "White only reaches {v} instead of 255. Bright colors arrive a bit darker.",
      f_darkGood: "Even the darkest gray levels can be told apart.",
      f_darkSmall: "Gray 2 cannot be told apart from black. That's normal, from gray 4 on every level is distinct.",
      f_darkLost: "Dark levels get lost: gray 0 to {v} arrive the same.",
      f_darkClipped: "Gray 0 to {v} arrive the same, black is clipped. The color ranges probably don't match: the source sends full range and the grabber expects limited range (or the other way round).",
      f_lightLost: "Bright levels get lost: gray {v} to 255 arrive the same.",
      f_tintGood: "Gray stays neutral (at most {v} levels between the channels).",
      f_tintWarn: "Gray gets a slight tint: up to {v} levels at gray {s}, {c} is strongest.",
      f_tintBad: "Gray has a clear tint: up to {v} levels at gray {s}, {c} is strongest.",
      f_noiseGood: "Noise: ±{v} levels. The picture is calm.",
      f_noiseWarn: "Noise: ±{v} levels. A bit restless, the LEDs average it out though.",
      f_noiseBad: "Noise: ±{v} levels. The picture is very restless.",
      f_drift: "Black changed by {v} levels during the test. The grabber was not stable yet, repeat the test.",
      f_darkInvisible: "Very dark colors get lost: {list}.",
      f_darkHue: "Dark colors lose their hue: {list}.",
      f_darkHueGood: "Dark colors keep their hue too.",
      f_crosstalk: "Colors are not pure: {list}. This points to a different color matrix (BT.601/BT.709) or a saturation setting.",
      f_strengthGood: "All colors arrive about as strong as gray (at most {v} % off).",
      f_strength: "Colors arrive with different strength: {list} (at level 128, gray 128 = 100 %).{effect}",
      strengthWeak: " Colors that arrive too weak light up weaker on the LEDs than they are in the picture.",
      strengthStrong: " Colors that arrive too strong light up stronger on the LEDs than they are in the picture.",
      f_strengthClip: "Boosted colors reach the maximum before 255: {list}. Brighter shades of these colors can no longer be told apart.",
      f_matrix: "Foreign shares and uneven strength together are the typical sign of a different color matrix: the grabber (or a device in front of it, such as an HDMI splitter) converts the colors with a different standard than the source device sends. The TV is not involved, the grabber taps the signal before it. Gray levels are not affected.",
      f_unstable: "{n} steps were not measured quite steadily. Repeat the test if values look odd.",
      pureFromItem: "{c} only from {v}",
      visibleFromItem: "{c} only visible from {v}",
      neverItem: "{c} not at all",
      crosstalkItem: "{c} {v} %",
      strengthItem: "{c} {v} %",
      clipItem: "{c} at about {v}",
      corrTitle: "Grabber color correction",
      corrOn: "The grabber color correction is on (computed from the basic test of {date}).",
      corrOff: "The grabber color correction is off.",
      corrRaw: "The test always measures the uncorrected grabber picture. The findings above describe the grabber itself, even while the correction is on.",
      corrMeasured: "Measured with the correction: deviation {mean} on average, at most {max} levels (without correction {bmean} / {bmax}).",
      corrFitGood: "The colors barely deviate ({mean} on average, at most {max} levels). No correction needed.",
      corrFit: "A correction computed from this basic test lowers the deviation from {bmean} on average / at most {bmax} to {mean} / {max} levels.",
      corrFitNone: "No correction can be computed from this basic test ({why}).",
      corrWhyData: "too few usable values",
      corrWhyRange: "the correction needed would be too strong",
      corrStale: "This basic test is newer than the active correction. With it, a deviation of {mean} on average, at most {max} levels would remain here.",
      corrStaleBad: "The active correction no longer fits this basic test. Compute it again.",
      corrLost: "Cannot be corrected because the grabber already clips these values: {list}. They are approximated as well as possible.",
      corrHow: "The correction is a 3×3 color matrix that Hyperion applies directly to the grabber picture, before all other settings. Gray stays unchanged, so gamma, white point and gray curve stay valid. After switching it on, check the color calibration though (red, green, blue, cyan, magenta, yellow).",
      corrWhere: "You switch the correction on and off and change between the memory slots above at the calibrations of this grabber (in the Hyperion WebUI in expert mode).",
      corrMatrix: "Matrix from the basic test of {date}",
      corrSwitch: "Grabber color correction active",
      slTitle: "Calibrations of this grabber",
      slSelect: "Grabber",
      slSelectHint: "The grabber Hyperion uses (like in the WebUI under Capturing Hardware → USB Capture → Device discovered). Choosing another one switches Hyperion over.",
      slMissing: "{name} (not connected)",
      slConfirmSwitch: "Switch Hyperion to the grabber {name}? Capturing restarts, the LEDs are off for a moment.",
      slGrabber: "Grabber: {name}",
      slNoDevice: "No grabber detected. As soon as the grabber delivers frames, its name appears here.",
      slIntro: "Every grabber model has three memory slots. The active slot of the grabber connected right now is used. After a grabber change its own calibration applies automatically, for a grabber without calibration the correction stays off.",
      slSlot: "Slot {n}",
      slEmpty: "empty",
      slActive: "off",
      slInUse: "running",
      slNamePh: "Name, e.g. with splitter",
      slInfo: "Basic test of {date} · deviation {before} → {after} levels on average",
      slUse: "Use",
      slSave: "Save last basic test here",
      slOverwrite: "Overwrite with last basic test",
      slClear: "Delete",
      slConfirmOverwrite: "Overwrite {slot} with the basic test of {date}?",
      slConfirmClear: "Delete {slot}?",
      slSaveHint: "Saving stores the correction computed from the last basic test ({date}) in the slot and uses it.",
      slOtherTest: "The last basic test comes from the grabber {name}. Run a basic test with this grabber first to save here.",
      slNoTest: "No basic test yet. After the first basic test you can save it here.",
      slOthers: "Other grabbers ({n})",
      slOtherLine: "{used} of 3 slots used · {state}",
      slOtherOn: "correction on: {slot}",
      slOtherOff: "correction off",
      slForget: "Remove",
      slConfirmForget: "Remove all calibrations of {name}?",
      errNoDevice: "No grabber detected",
      errNoTest: "No basic test saved yet",
      errOtherTest: "The last basic test comes from another grabber",
      errFit: "No correction can be computed from the last basic test",
      errNoSlot: "This memory slot is empty",
      ntTitle: "Notifications",
      ntNone: "No new messages.",
      ntNewGrabber: "New grabber detected: {name}",
      ntNewGrabberText: "No color calibration is saved for this grabber yet, so the grabber color correction stays off for it. You can calibrate it on the TV test page in the card “Grabber color detection”.",
      ntSeen: "Got it",
      vgTitle: "Compare measurements",
      vgIntro: "Compares two saved basic tests in detail, from the same or from different grabbers: key figures, every measuring step and the correction matrix.",
      vgNeedTwo: "At least two saved measurements are needed to compare. Measurements come from the basic test and are kept in the memory slots.",
      vgA: "Measurement A", vgB: "Measurement B", vgGrabber: "Grabber", vgPick: "Measurement",
      vgLast: "Last basic test · {date}", vgSlot: "Slot {n}{name} · {date}", vgNoMeasure: "no saved measurement",
      vgGo: "Compare", vgSame: "Both sides are the same measurement, there is nothing to compare.",
      vgSummary: "{k} of {n} measuring steps differ by more than {x} levels, most at {name} ({v} levels).",
      vgSummaryNone: "All {n} measuring steps are at most {x} levels apart.",
      vgMetrics: "Key figures", vgMetric: "Figure", vgDelta: "Difference (B − A)",
      mBlack: "Black level", mWhite: "White level", mGain: "Span white − black", mDarkLost: "Dark levels like black up to", mLightLost: "Light levels like white from",
      mTint: "Tint of the grays", mNoise: "Noise at 128", mDrift: "Black drift",
      vgSteps: "All measuring steps compared ({n}, {k} deviating)", vgOnlyOne: "in one measurement only",
      vgChart: "Gray levels compared", vgChartHint: "The gray levels of both measurements as in the result: red, green and blue over the sent value.",
      vgFindings: "Findings",
      vgCustom: "Own colors compared", vgCustomNone: "Neither measurement has own colors saved. They are saved with the slot when they were measured before saving (older slots have none).", vgCustomOne: "Only one of the two measurements has own colors saved, so they cannot be compared.",
      vgChannels: "Each channel over each other: measurement A blue solid, measurement B orange dashed.",
      vgLadders: "Color ladders compared", vgLaddersHint: "For each color measurement A, measurement B and both over each other (A blue solid, B orange dashed, the main channels of the color only).", vgOver: "over each other",
      vgMatrix: "Correction matrix", vgNoMatrix: "no correction can be computed", vgMatrixDelta: "Largest difference of the matrix values: {v}.",
      cmpTitle: "Without and with correction",
      cmpMeasured: "Selected test colors, measured with the correction through Hyperion.",
      cmpCalc: "Selected test colors, computed with the correction. A basic test with the correction switched on measures the values.",
      colWithout: "without correction",
      colWith: "with correction",
      corrEnable: "Switch on correction from this basic test",
      corrRecompute: "Recompute correction from this basic test",
      corrDisable: "Switch off correction",
      colCorr: "with correction",
      keys: { device: "device", input: "input", width: "width", height: "height", fps: "frame rate", encoding: "format", hardware_brightness: "brightness", hardware_contrast: "contrast", hardware_saturation: "saturation", hardware_hue: "hue" },
    },
  };

  function basicSteps() {
    const steps = [{ group: "black", sent: [0, 0, 0] }];
    for (const v of GRAYS) steps.push({ group: "gray", sent: [v, v, v] });
    for (const [name, mask, levels] of LADDERS) {
      for (const v of levels) steps.push({ group: name, sent: mask.map((m) => m * v) });
    }
    for (const [name, rgb] of MIXES) steps.push({ group: "mix", name, sent: rgb.slice() });
    steps.push({ group: "black", sent: [0, 0, 0] });
    return steps;
  }

  const avg = (v) => (v[0] + v[1] + v[2]) / 3;
  const isRgb = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
  const validSteps = (result) => (result && Array.isArray(result.steps) ? result.steps.filter((s) => isRgb(s.sent) && isRgb(s.got)) : []);

  function analyze(result) {
    const steps = validSteps(result);
    const blacks = steps.filter((s) => s.group === "black");
    const grays = steps.filter((s) => s.group === "gray").sort((a, b) => a.sent[0] - b.sent[0]);
    if (!blacks.length || !grays.length) return null;

    const black = [0, 1, 2].map((i) => blacks.reduce((sum, s) => sum + s.got[i], 0) / blacks.length);
    const drift = blacks.length > 1 ? Math.max(...[0, 1, 2].map((i) => Math.abs(blacks[blacks.length - 1].got[i] - blacks[0].got[i]))) : 0;
    const whiteStep = grays.find((s) => s.sent[0] === 255) ?? grays[grays.length - 1];
    const white = whiteStep.got;
    const blackLuma = avg(black);
    const whiteLuma = avg(white);
    const gain = (whiteLuma - blackLuma) / 255;

    // the darkest levels that arrive like black, counted from 0 up to the first distinct one
    let darkLostTo = 0;
    for (const s of grays) {
      if (avg(s.got) - blackLuma < 0.5) darkLostTo = s.sent[0];
      else break;
    }
    // the brightest levels below 255 that arrive like white
    let lightLostFrom = null;
    for (const s of grays.slice().reverse()) {
      if (s.sent[0] === 255) continue;
      if (whiteLuma - avg(s.got) < 0.5) lightLostFrom = s.sent[0];
      else break;
    }

    // tint of grays: spread between the channels, measured from 16 up (below that it is noise)
    let tint = { value: 0, sent: null, channel: null };
    for (const s of grays) {
      if (s.sent[0] < 16) continue;
      const spread = Math.max(...s.got) - Math.min(...s.got);
      if (spread > tint.value) {
        const mean = avg(s.got);
        const devs = s.got.map((v) => Math.abs(v - mean));
        tint = { value: spread, sent: s.sent[0], channel: devs.indexOf(Math.max(...devs)) };
      }
    }

    const mid = grays.find((s) => s.sent[0] === 128);
    const noise = mid && isRgb(mid.noise) ? avg(mid.noise) : null;

    const ladders = LADDERS.map(([name, mask]) => {
      const rows = steps.filter((s) => s.group === name).sort((a, b) => Math.max(...a.sent) - Math.max(...b.sent));
      const main = [0, 1, 2].filter((i) => mask[i]);
      const foreign = [0, 1, 2].filter((i) => !mask[i]);
      const graded = rows.map((s) => {
        const rise = s.got.map((v, i) => v - black[i]);
        const mainRise = Math.min(...main.map((i) => rise[i]));
        const foreignRise = Math.max(0, ...foreign.map((i) => rise[i]));
        const visible = mainRise >= 1;
        const pure = visible && foreignRise <= Math.max(1, 0.25 * mainRise);
        return { level: Math.max(...s.sent), got: s.got, mainRise, foreignRise, visible, pure };
      });
      const visibleFrom = graded.find((g) => g.visible)?.level ?? null;
      // lowest level from which on every brighter level keeps its hue
      let pureFrom = null;
      for (const g of graded.slice().reverse()) {
        if (g.pure) pureFrom = g.level;
        else break;
      }
      const top = graded.find((g) => g.level === 255);
      const crosstalk = top && top.mainRise > 0 ? (100 * top.foreignRise) / top.mainRise : null;
      // strength: the color's channels against the same gray level, at 128 where nothing clips yet
      const ref = rows.find((s) => Math.max(...s.sent) === 128);
      const refGray = grays.find((s) => s.sent[0] === 128);
      let strength = null;
      let parts = null;
      if (ref && refGray) {
        parts = main.map((i) => (refGray.got[i] - black[i] > 8 ? (ref.got[i] - black[i]) / (refGray.got[i] - black[i]) : null));
        if (parts.every((v) => v !== null)) strength = (100 * parts.reduce((a, b) => a + b, 0)) / parts.length;
        else parts = null;
      }
      // a boosted channel that is stuck at the top at 255 clips from about 255 / gain on; the measured
      // levels between 128 and 255 (if the test had them) narrow the estimate down
      let clipFrom = null;
      if (parts && top) {
        for (const [k, i] of main.entries()) {
          if (parts[k] <= 1.05 || top.got[i] < 254) continue;
          let from = 255 / parts[k];
          const below = graded.filter((g) => g.level < 255 && g.got[i] < 254).map((g) => g.level);
          const above = graded.filter((g) => g.got[i] >= 254).map((g) => g.level);
          if (below.length) from = Math.max(from, Math.max(...below));
          if (above.length) from = Math.min(from, Math.min(...above));
          clipFrom = Math.round(clipFrom === null ? from : Math.min(clipFrom, from));
        }
      }
      return { name, mask, rows: graded, visibleFrom, pureFrom, crosstalk, strength, clipFrom };
    });

    const unstable = steps.filter((s) => s.unstable).length;

    const findings = [];
    const add = (level, key, params) => findings.push({ level, key, params: params ?? {} });
    const limited = blackLuma >= 10 && whiteLuma <= 242;
    if (limited) add("bad", "f_limited", { b: Math.round(blackLuma), w: Math.round(whiteLuma) });
    else if (blackLuma <= 1.5) add("ok", "f_blackGood", { v: black });
    else if (blackLuma <= 8) add("warn", "f_blackLift", { v: black });
    else add("bad", "f_blackHigh", { v: black });
    if (!limited) add(whiteLuma >= 250 ? "ok" : "warn", whiteLuma >= 250 ? "f_whiteGood" : "f_whiteLow", { v: white });
    if (darkLostTo === 0) add("ok", "f_darkGood");
    else if (darkLostTo <= 2) add("ok", "f_darkSmall");
    else if (darkLostTo < 12) add("warn", "f_darkLost", { v: darkLostTo });
    else add("bad", "f_darkClipped", { v: darkLostTo });
    if (lightLostFrom !== null && lightLostFrom <= 245) add(lightLostFrom <= 235 ? "bad" : "warn", "f_lightLost", { v: lightLostFrom });
    if (tint.value < 2) add("ok", "f_tintGood", { v: tint.value });
    else add(tint.value < 5 ? "warn" : "bad", tint.value < 5 ? "f_tintWarn" : "f_tintBad", { v: tint.value, s: tint.sent, c: tint.channel });
    if (noise !== null) add(noise < 1.5 ? "ok" : noise < 3 ? "warn" : "bad", noise < 1.5 ? "f_noiseGood" : noise < 3 ? "f_noiseWarn" : "f_noiseBad", { v: noise });
    if (drift > 1) add("warn", "f_drift", { v: drift });
    // dark colors: lost completely (not visible at their lower levels) or visible with a wrong hue
    const lost = ladders.filter((l) => l.rows.length && (l.visibleFrom === null || l.visibleFrom > l.rows[0].level * 2));
    if (lost.length) add("warn", "f_darkInvisible", { ladders: lost });
    const lateHue = ladders.filter((l) => l.rows.length && !lost.includes(l) && (l.pureFrom === null || l.pureFrom > Math.max(l.rows[0].level * 2, l.visibleFrom)));
    if (lateHue.length) add("warn", "f_darkHue", { ladders: lateHue });
    if (!lost.length && !lateHue.length && ladders.some((l) => l.rows.length)) add("ok", "f_darkHueGood");
    const impure = ladders.filter((l) => l.crosstalk !== null && l.crosstalk > 10);
    if (impure.length) add("warn", "f_crosstalk", { ladders: impure });
    const measured = ladders.filter((l) => l.strength !== null);
    const uneven = measured.filter((l) => Math.abs(l.strength - 100) > 5).sort((p, q) => Math.abs(q.strength - 100) - Math.abs(p.strength - 100));
    if (uneven.length) add("warn", "f_strength", { ladders: uneven });
    else if (measured.length) add("ok", "f_strengthGood", { v: Math.max(...measured.map((l) => Math.abs(l.strength - 100))) });
    const clipped = ladders.filter((l) => l.clipFrom !== null);
    if (clipped.length) add("warn", "f_strengthClip", { ladders: clipped });
    if (impure.length && uneven.length) add("warn", "f_matrix");
    if (unstable) add("warn", "f_unstable", { n: unstable });

    return { black, white, gain, drift, darkLostTo, lightLostFrom, tint, noise, ladders, findings, limited };
  }

  // --- grabber color correction ---

  // what Hyperion does with a pixel: matrix, rounded and clamped to 0..255
  const applyMatrix = (m, v) => [0, 1, 2].map((o) => Math.min(255, Math.max(0, Math.round(m[3 * o] * v[0] + m[3 * o + 1] * v[1] + m[3 * o + 2] * v[2]))));
  // largest absolute row sum Hyperion accepts (keeps its fast integer path exact)
  const MAX_ROW_ABS_SUM = 2;

  // deviation of the steps from what was sent: mean over all channels and the largest one
  function deviation(steps, pick) {
    let sum = 0;
    let n = 0;
    let max = 0;
    for (const s of steps) {
      const v = pick(s);
      if (!v) continue;
      for (let i = 0; i < 3; i++) {
        const d = Math.abs(v[i] - s.sent[i]);
        sum += d;
        n++;
        max = Math.max(max, d);
      }
    }
    return n ? { mean: sum / n, max } : null;
  }

  // The correction is fitted directly: for each output channel the least squares solution of
  // matrix * got = sent over all test colors from level 16 up, with the row summing up to 1 so
  // grays stay as they are. Fitting the inverse of a grabber model instead would be exact for
  // unclipped colors only: a grabber that clips negative values to 0 (e.g. green in pure red)
  // loses them, and the exact inverse then mixes that channel into saturated colors.
  function fitCorrection(result) {
    const steps = validSteps(result).filter((s) => s.group !== "custom" && Math.max(...s.sent) >= 16);
    if (steps.length < 12) return { error: "data" };
    const matrix = [];
    for (let o = 0; o < 3; o++) {
      let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
      for (const s of steps) {
        // with c2 = 1 - c0 - c1: sent - got_b = c0 (got_r - got_b) + c1 (got_g - got_b)
        const x1 = s.got[0] - s.got[2];
        const x2 = s.got[1] - s.got[2];
        const y = s.sent[o] - s.got[2];
        a11 += x1 * x1; a12 += x1 * x2; a22 += x2 * x2; b1 += x1 * y; b2 += x2 * y;
      }
      const d = a11 * a22 - a12 * a12;
      if (Math.abs(d) < 1e-6) return { error: "data" };
      const c0 = (b1 * a22 - b2 * a12) / d;
      const c1 = (a11 * b2 - a12 * b1) / d;
      matrix.push(c0, c1, 1 - c0 - c1);
    }
    const rounded = matrix.map((v) => Math.round(v * 10000) / 10000);
    for (let o = 0; o < 3; o++) {
      if (Math.abs(rounded[3 * o]) + Math.abs(rounded[3 * o + 1]) + Math.abs(rounded[3 * o + 2]) > MAX_ROW_ABS_SUM) return { error: "range" };
    }
    return { matrix: rounded, ...evaluateCorrection(result, rounded) };
  }

  // how a correction matrix would do on the raw values of a test; lost = steps it cannot fix
  // because the grabber clipped them already
  function evaluateCorrection(result, matrix) {
    const steps = validSteps(result).filter((s) => s.group !== "custom");
    const before = deviation(steps, (s) => s.got);
    const after = deviation(steps, (s) => applyMatrix(matrix, s.got));
    const lost = steps.filter((s) => s.got.some((v) => v >= 254) && applyMatrix(matrix, s.got).some((v, i) => Math.abs(v - s.sent[i]) > 3));
    return { before, after, lost };
  }

  // grabber settings that differ between the test and now
  function changedKeys(result, current) {
    if (!result?.grabber || !current) return [];
    return GRABBER_KEYS.filter((k) => k in result.grabber && k in current && String(result.grabber[k]) !== String(current[k]));
  }

  // --- rendering ---

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const hex = (rgb) => "#" + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");

  const CSS = `
    .gtr { font-size: 14px; line-height: 1.45; }
    .gtr-meta { opacity: .75; font-size: 13px; margin: 0 0 8px; }
    .gtr-stale { border-left: 4px solid #e0a000; background: rgba(224, 160, 0, .12); padding: 8px 10px; border-radius: 4px; margin: 0 0 10px; }
    .gtr-findings { list-style: none; padding: 0; margin: 0 0 12px; }
    .gtr-findings li { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; border: none; font-size: 14px; justify-content: flex-start; flex-wrap: nowrap; }
    .gtr-findings .ico { flex: none; width: 20px; height: 20px; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
    .gtr-findings .gtr-ok .ico { background: #2fa36b; }
    .gtr-findings .gtr-warn .ico { background: #d08a00; }
    .gtr-findings .gtr-bad .ico { background: #d93025; }
    .gtr-findings .gtr-info .ico { background: #6b7280; }
    .gtr-table.gtr-matrix { width: auto; }
    .gtr-table.gtr-matrix td { text-align: right; padding-left: 14px; }
    .gtr-actions { margin: 8px 0 0; display: flex; gap: 10px 16px; flex-wrap: wrap; align-items: center; }
    .gtr-matrix-row { display: flex; gap: 8px 28px; flex-wrap: wrap; align-items: flex-end; margin: 6px 0; }
    .gtr-switch { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; margin: 0; }
    .gtr-switch input { width: 18px; height: 18px; margin: 0; }
    .gtr h4 { font-size: 14px; font-weight: 600; margin: 16px 0 4px; text-transform: none; letter-spacing: 0; opacity: 1; color: inherit; }
    .gtr-hint { font-size: 12px; opacity: .7; margin: 0 0 6px; }
    .gtr svg { display: block; width: 100%; height: auto; overflow: visible; }
    .gtr svg text { font: 10px system-ui, sans-serif; fill: currentColor; opacity: .7; }
    .gtr-chart { max-width: 520px; }
    .gtr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 14px; }
    .gtr-grid .cap { font-size: 12px; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
    .gtr-sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(128, 128, 128, .5); vertical-align: -2px; flex: none; }
    .gtr-table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; margin: 6px 0; }
    .gtr-table th, .gtr-table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid rgba(128, 128, 128, .25); white-space: nowrap; }
    .gtr-table th { font-weight: 600; opacity: .8; }
    .gtr-scroll { overflow-x: auto; }
    .gtr details summary { cursor: pointer; margin: 14px 0 4px; font-weight: 600; }
    .gtr-cmp-sel { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px 16px; margin: 8px 0; }
    .gtr-cmp-sel > div { border: 1px solid rgba(128, 128, 128, .35); border-radius: 8px; padding: 8px 10px; }
    .gtr-cmp-sel label { display: block; font-size: 12px; opacity: .75; margin: 6px 0 2px; }
    .gtr-cmp-sel select { width: 100%; font: inherit; font-size: 14px; padding: 5px 8px; border-radius: 4px; border: 1px solid rgba(128, 128, 128, .5); background: transparent; color: inherit; }
    .gtr-cmp-sel option { color: #222; background: #fff; }
    .gtr-cmp-tag { display: inline-block; min-width: 20px; padding: 0 6px; border-radius: 10px; color: #fff; font-size: 12px; font-weight: 700; text-align: center; }
    .gtr-cmp-tag.a { background: #2b93ef; }
    .gtr-cmp-tag.b { background: #d08a00; }
    .gtr-cmp-head { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 16px; margin: 12px 0 4px; }
    .gtr-cmp-summary { margin: 6px 0; font-weight: 600; }
    .gtr-cmp-table td:nth-child(n+2), .gtr-cmp-table th:nth-child(n+2) { text-align: right; }
    .gtr-cwarn { color: #d08a00; font-weight: 600; }
    .gtr-cbad { color: #d93025; font-weight: 600; }
    .gtr-muted { opacity: .6; }
    .gtr-cmp-go { margin: 8px 0; }
    .gtr-cmp-charts { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
    .gtr-cmp-pair { grid-template-columns: repeat(auto-fill, minmax(240px, 320px)); }
    .gtr-cmp-ladders { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px 18px; }
    .gtr-cmp-ladder > .cap { font-size: 13px; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
    .gtr-cmp-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
    .gtr-cmp-three .cap { font-size: 12px; margin-bottom: 2px; display: flex; align-items: center; gap: 6px; }
  `;

  function ensureStyle(doc) {
    if (doc.getElementById("gtr-style")) return;
    const style = doc.createElement("style");
    style.id = "gtr-style";
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  // square root scale: the dark levels get room, like the eye sees them
  const sq = (v) => Math.sqrt(Math.max(0, Math.min(255, v)) / 255);

  // rows: [{ level, got }], channels: indices drawn solid, dashed: indices drawn dashed
  function chartSvg(rows, solid, dashed, { width = 320, height = 200, small = false, color = null, overlayColor = null, overlayChannels = [0, 1, 2] } = {}, overlay = null) {
    const pad = small ? { l: 22, r: 6, t: 6, b: 16 } : { l: 30, r: 8, t: 8, b: 22 };
    const w = width - pad.l - pad.r;
    const h = height - pad.t - pad.b;
    const x = (v) => pad.l + sq(v) * w;
    const y = (v) => pad.t + (1 - sq(v)) * h;
    const ticks = small ? [0, 16, 64, 255] : [0, 4, 16, 32, 64, 128, 255];
    let out = `<svg viewBox="0 0 ${width} ${height}" role="img">`;
    for (const t of ticks) {
      out += `<line x1="${x(t)}" y1="${pad.t}" x2="${x(t)}" y2="${pad.t + h}" stroke="currentColor" stroke-opacity=".12"/>`;
      out += `<line x1="${pad.l}" y1="${y(t)}" x2="${pad.l + w}" y2="${y(t)}" stroke="currentColor" stroke-opacity=".12"/>`;
      out += `<text x="${x(t)}" y="${height - 4}" text-anchor="middle">${t}</text>`;
      out += `<text x="${pad.l - 4}" y="${y(t) + 3}" text-anchor="end">${t}</text>`;
    }
    out += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(255)}" y2="${y(255)}" stroke="currentColor" stroke-opacity=".45" stroke-dasharray="1 3"/>`;
    const line = (i, dash) => {
      const pts = rows.map((r) => `${x(r.level).toFixed(1)},${y(r.got[i]).toFixed(1)}`).join(" ");
      const col = color ?? CHANNEL_COLORS[i];
      const dots = rows.map((r) => `<circle cx="${x(r.level).toFixed(1)}" cy="${y(r.got[i]).toFixed(1)}" r="${small ? 1.6 : 2.2}" fill="${col}"/>`).join("");
      return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${small ? 1.4 : 1.8}"${dash ? ' stroke-dasharray="4 3"' : ""}/>${dots}`;
    };
    for (const i of dashed) out += line(i, true);
    for (const i of solid) out += line(i, false);
    // a second measurement drawn dashed over the first (comparison)
    if (overlay) {
      for (const i of overlayChannels) {
        const col = overlayColor ?? CHANNEL_COLORS[i];
        const pts = overlay.map((r) => `${x(r.level).toFixed(1)},${y(r.got[i]).toFixed(1)}`).join(" ");
        out += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="${small ? 1.4 : 1.8}" stroke-dasharray="4 3"/>`
          + overlay.map((r) => `<circle cx="${x(r.level).toFixed(1)}" cy="${y(r.got[i]).toFixed(1)}" r="${small ? 1.6 : 2.2}" fill="${col}"/>`).join("");
      }
    }
    return out + "</svg>";
  }

  function make(lang) {
    const t = TEXT[lang] ?? TEXT.de;
    const locale = lang === "de" ? "de-DE" : "en-US";
    const num = (v, d = 1) => Number(v).toLocaleString(locale, { minimumFractionDigits: d, maximumFractionDigits: d });
    const rgbText = (v, d = 1) => v.map((c) => num(c, d)).join(" / ");
    const fill = (s, params) => s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? params[k] : `{${k}}`));
    const channelName = (i) => [t.red, t.green, t.blue][i];
    const dateText = (iso) => {
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? "–" : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
    };
    const stepName = (s) => (s.group === "mix" || s.group === "custom" ? t[s.name] ?? s.name ?? t.custom : t[s.group] ?? s.group);

    function findingText(f) {
      const p = f.params;
      switch (f.key) {
        case "f_blackGood": case "f_blackLift": case "f_blackHigh": case "f_whiteGood": case "f_whiteLow":
          return fill(t[f.key], { v: rgbText(p.v) });
        case "f_tintGood":
          return fill(t[f.key], { v: num(p.v) });
        case "f_tintWarn": case "f_tintBad":
          return fill(t[f.key], { v: num(p.v), s: p.s, c: channelName(p.c) });
        case "f_noiseGood": case "f_noiseWarn": case "f_noiseBad": case "f_drift":
          return fill(t[f.key], { v: num(p.v) });
        case "f_darkHue":
          return fill(t[f.key], { list: p.ladders.map((l) => (l.pureFrom === null ? fill(t.neverItem, { c: t[l.name] }) : fill(t.pureFromItem, { c: t[l.name], v: l.pureFrom }))).join(", ") });
        case "f_darkInvisible":
          return fill(t[f.key], { list: p.ladders.map((l) => (l.visibleFrom === null ? fill(t.neverItem, { c: t[l.name] }) : fill(t.visibleFromItem, { c: t[l.name], v: l.visibleFrom }))).join(", ") });
        case "f_crosstalk":
          return fill(t[f.key], { list: p.ladders.map((l) => fill(t.crosstalkItem, { c: t[l.name], v: num(l.crosstalk, 0) })).join(", ") });
        case "f_strengthGood":
          return fill(t[f.key], { v: num(p.v, 0) });
        case "f_strength":
          return fill(t[f.key], {
            list: p.ladders.map((l) => fill(t.strengthItem, { c: t[l.name], v: num(l.strength, 0) })).join(", "),
            effect: (p.ladders.some((l) => l.strength < 100) ? t.strengthWeak : "") + (p.ladders.some((l) => l.strength > 100) ? t.strengthStrong : ""),
          });
        case "f_strengthClip":
          return fill(t[f.key], { list: p.ladders.map((l) => fill(t.clipItem, { c: t[l.name], v: l.clipFrom })).join(", ") });
        default:
          return fill(t[f.key], p);
      }
    }

    function metaLine(result) {
      const g = result.grabber ?? {};
      const parts = [fill(t.measured, { date: dateText(result.date) })];
      if (g.name) parts.push(esc(g.name));
      const frame = result.frame ?? g;
      if (frame.width && frame.height) parts.push(fill(t.frame, { w: frame.width, h: frame.height }));
      if (g.encoding) parts.push(esc(g.encoding) + (g.fps ? ` ${g.fps} fps` : ""));
      return parts.join(" · ");
    }

    function valuesTable(steps) {
      const withCorr = steps.some((s) => isRgb(s.corr));
      let out = `<div class="gtr-scroll"><table class="gtr-table"><thead><tr><th>${t.colColor}</th><th>${t.colSent}</th><th>${t.colGot}</th><th>${t.colDiff}</th>${withCorr ? `<th>${t.colCorr}</th>` : ""}<th>${t.colNoise}</th></tr></thead><tbody>`;
      for (const s of steps) {
        const diff = s.got.map((v, i) => v - s.sent[i]);
        const diffText = diff.map((d) => (d > 0 ? "+" : "") + num(d)).join(" / ");
        out += `<tr><td><span class="gtr-sw" style="background:${hex(s.sent)}"></span> <span class="gtr-sw" style="background:${hex(s.got)}"></span> ${esc(stepName(s))}</td>`
          + `<td>${s.sent.join(" / ")}</td><td>${rgbText(s.got)}</td><td>${diffText}</td>${withCorr ? `<td>${isRgb(s.corr) ? rgbText(s.corr) : "–"}</td>` : ""}<td>${isRgb(s.noise) ? "±" + num(avg(s.noise)) : "–"}</td></tr>`;
      }
      return out + "</tbody></table></div>";
    }

    const stepLevelName = (s) => (s.group === "mix" || s.group === "custom" ? stepName(s) : `${stepName(s)} ${Math.max(...s.sent)}`);
    const matrixOn = (c) => !!(c && c.enable && Array.isArray(c.matrix) && c.matrix.length === 9 && c.matrix.every((v) => Number.isFinite(v)));

    function matrixTable(m) {
      const fmt = (v) => (v >= 0 ? "\u2007" : "") + num(v, 3);
      let out = `<table class="gtr-table gtr-matrix"><tbody>`;
      for (let o = 0; o < 3; o++) {
        out += `<tr><th>${[t.red, t.green, t.blue][o]}</th>${[0, 1, 2].map((i) => `<td>${fmt(m[3 * o + i])}</td>`).join("")}</tr>`;
      }
      return out + "</tbody></table>";
    }

    // the correction block; controls = switch and buttons (WebUI), toggle = false leaves the switch
    // out (the page shows its own)
    function correctionHtml(basic, correction, controls, toggle = true) {
      const steps = validSteps(basic).filter((s) => s.group !== "custom");
      const on = matrixOn(correction);
      const fit = fitCorrection(basic);
      const useful = !fit.error && fit.before && fit.before.max > 4;
      // the correction is up to date when it comes from this test or the test was measured with it
      const measuredWith = on && basic.correction?.basedOn === correction.basedOn;
      const sameTest = on && (correction.basedOn === basic.date || measuredWith);
      const items = [];
      const line = (level, text) => items.push(`<li class="gtr-${level}"><span class="ico">${level === "ok" ? "✓" : level === "warn" ? "!" : "i"}</span><span>${text}</span></li>`);
      const dev = (d) => ({ mean: num(d.mean), max: num(d.max, 0) });

      line(on ? "ok" : "info", on ? fill(t.corrOn, { date: dateText(correction.basedOn) }) : t.corrOff);
      const measured = deviation(steps, (s) => (isRgb(s.corr) ? s.corr : null));
      if (measured) {
        const raw = deviation(steps, (s) => (isRgb(s.corr) ? s.got : null));
        line(measured.max <= 4 ? "ok" : "info", fill(t.corrMeasured, { ...dev(measured), bmean: num(raw.mean), bmax: num(raw.max, 0) }));
      }
      if (on && !sameTest) {
        const e = evaluateCorrection(basic, correction.matrix);
        line("info", fill(t.corrStale, dev(e.after)));
        if (useful && e.after.mean > fit.after.mean + 1) line("warn", t.corrStaleBad);
      }
      if (fit.error) line("warn", fill(t.corrFitNone, { why: fit.error === "range" ? t.corrWhyRange : t.corrWhyData }));
      else if (!useful) line("ok", fill(t.corrFitGood, dev(fit.before)));
      else if (!measuredWith) line("info", fill(t.corrFit, { ...dev(fit.after), bmean: num(fit.before.mean), bmax: num(fit.before.max, 0) }));
      if (useful && fit.lost.length) line("warn", fill(t.corrLost, { list: fit.lost.map(stepLevelName).join(", ") }));

      let out = `<h4>${t.corrTitle}</h4><ul class="gtr-findings">${items.join("")}</ul>`;

      // the matrix the switch uses: the stored one, otherwise the one from this test
      const stored = matrixOn({ ...correction, enable: true }) ? correction : null;
      const shownMatrix = stored ? stored.matrix : useful ? fit.matrix : null;
      const shownDate = stored ? stored.basedOn : basic.date;

      // selected colors without and with the correction: measured through Hyperion when the test
      // ran with the correction on, otherwise computed with the matrix above
      const pick = COMPARE.map(([group, sent]) => steps.find((s) => s.group === group && s.sent.every((v, i) => v === sent[i]))).filter(Boolean);
      const measuredAll = pick.length && pick.every((s) => isRgb(s.corr));
      if (pick.length && (measuredAll || shownMatrix)) {
        const withValue = (s) => (measuredAll ? s.corr : applyMatrix(shownMatrix, s.got));
        const cell = (v) => `<span class="gtr-sw" style="background:${hex(v)}"></span> ${v.map((x) => Math.round(x)).join(" / ")}`;
        out += `<p class="gtr-hint" style="margin-top:10px"><b>${t.cmpTitle}</b> · ${measuredAll ? t.cmpMeasured : t.cmpCalc}</p>`
          + `<div class="gtr-scroll"><table class="gtr-table"><thead><tr><th>${t.colSent}</th><th>${t.colWithout}</th><th>${t.colWith}</th></tr></thead><tbody>`
          + pick.map((s) => `<tr><td>${cell(s.sent)} · ${esc(stepLevelName(s))}</td><td>${cell(s.got)}</td><td>${cell(withValue(s))}</td></tr>`).join("")
          + "</tbody></table></div>";
      }

      if (shownMatrix) {
        out += `<div class="gtr-matrix-row"><div><p class="gtr-hint">${fill(t.corrMatrix, { date: dateText(shownDate) })}</p>${matrixTable(shownMatrix)}</div>`;
        const recompute = useful && stored && !sameTest;
        if (controls && (toggle || recompute)) {
          out += `<div class="gtr-actions">${toggle ? `<label class="gtr-switch"><input type="checkbox" data-gtr-toggle${on ? " checked" : ""}> ${t.corrSwitch}</label>` : ""}`;
          if (recompute) out += `<button type="button" class="btn btn-primary btn-sm" data-gtr-action="recompute">${t.corrRecompute}</button>`;
          out += "</div>";
        }
        out += "</div>";
      }
      out += `<p class="gtr-hint">${t.corrHow}${on ? " " + t.corrRaw : ""}${controls ? "" : " " + t.corrWhere}</p>`;
      return out;
    }

    function basicHtml(basic, current, correction, controls, toggle = true) {
      const a = analyze(basic);
      if (!a) return `<p>${t.none}</p>`;
      let out = `<p class="gtr-meta">${metaLine(basic)}</p>`;
      const changed = changedKeys(basic, current);
      if (changed.length) out += `<p class="gtr-stale">${fill(t.stale, { keys: changed.map((k) => t.keys[k] ?? k).join(", ") })}</p>`;
      out += `<ul class="gtr-findings">${a.findings.map((f) => `<li class="gtr-${f.level}"><span class="ico">${f.level === "ok" ? "✓" : f.level === "warn" ? "!" : "✕"}</span><span>${findingText(f)}</span></li>`).join("")}</ul>`;
      out += correctionHtml(basic, correction, controls, toggle);

      const steps = validSteps(basic);
      const grays = [{ level: 0, got: a.black }, ...steps.filter((s) => s.group === "gray").map((s) => ({ level: s.sent[0], got: s.got }))].sort((p, q) => p.level - q.level);
      out += `<h4>${t.grayChart}</h4><p class="gtr-hint">${t.grayChartHint}</p><div class="gtr-chart">${chartSvg(grays, [0, 1, 2], [])}</div>`;

      const ladders = a.ladders.filter((l) => l.rows.length);
      if (ladders.length) {
        out += `<h4>${t.ladders}</h4><p class="gtr-hint">${t.laddersHint}</p><div class="gtr-grid">`;
        for (const l of ladders) {
          const rows = [{ level: 0, got: a.black }, ...l.rows];
          const solid = [0, 1, 2].filter((i) => l.mask[i]);
          const dashed = [0, 1, 2].filter((i) => !l.mask[i]);
          out += `<div><div class="cap"><span class="gtr-sw" style="background:${hex(l.mask.map((m) => m * 255))}"></span>${t[l.name]}</div>${chartSvg(rows, solid, dashed, { width: 170, height: 120, small: true })}</div>`;
        }
        out += `</div><div class="gtr-scroll"><table class="gtr-table"><thead><tr><th>${t.colLadder}</th><th>${t.colVisible}</th><th>${t.colPure}</th><th>${t.colStrength}</th><th>${t.colPurity}</th></tr></thead><tbody>`;
        for (const l of ladders) {
          out += `<tr><td><span class="gtr-sw" style="background:${hex(l.mask.map((m) => m * 255))}"></span> ${t[l.name]}</td><td>${l.visibleFrom ?? t.never}</td><td>${l.pureFrom ?? t.never}</td><td>${l.strength === null ? "–" : num(l.strength, 0) + " %"}</td><td>${l.crosstalk === null ? "–" : num(l.crosstalk, 0) + " %"}</td></tr>`;
        }
        out += "</tbody></table></div>";
      }
      out += `<details><summary>${t.allValues}</summary>${valuesTable(steps)}</details>`;
      return out;
    }

    function customHtml(custom) {
      const steps = validSteps(custom);
      if (!steps.length) return "";
      return `<h4>${t.customTitle}</h4><p class="gtr-meta">${fill(t.customMeasured, { date: dateText(custom.date) })}</p>${valuesTable(steps)}`;
    }

    // --- comparison of two saved measurements: A and B = { label, result, matrix? } ---
    const sign = (d, digits = 1) => (d > 0 ? "+" : d < 0 ? "−" : "") + num(Math.abs(d), digits);
    const levelClass = (m, warn, bad) => (m >= bad ? "gtr-cbad" : m >= warn ? "gtr-cwarn" : "");

    function compareHtml(A, B) {
      const a = analyze(A.result);
      const b = analyze(B.result);
      if (!a || !b) return `<p>${t.none}</p>`;
      const head = [["A", A, t.vgA], ["B", B, t.vgB]].map(([tag, side, name]) =>
        `<div class="gtr-cmp-side"><span class="gtr-cmp-tag ${tag.toLowerCase()}">${tag}</span> <b>${esc(side.label)}</b><p class="gtr-meta">${metaLine(side.result)}</p></div>`).join("");
      let out = `<div class="gtr-cmp-head">${head}</div>`;

      // steps matched by color and level
      const key = (s) => `${s.group}|${s.name ?? ""}|${s.sent.join(",")}`;
      const stepsA = validSteps(A.result);
      const stepsB = validSteps(B.result);
      const byB = new Map(stepsB.map((s) => [key(s), s]));
      const seenKeys = new Set();
      const pairs = [];
      for (const s of stepsA) { seenKeys.add(key(s)); pairs.push({ a: s, b: byB.get(key(s)) ?? null }); }
      for (const s of stepsB) if (!seenKeys.has(key(s))) pairs.push({ a: null, b: s });
      const both = pairs.filter((p) => p.a && p.b);
      for (const p of both) { p.delta = p.b.got.map((v, i) => v - p.a.got[i]); p.max = Math.max(...p.delta.map(Math.abs)); }
      const THRESHOLD = 3;
      const off = both.filter((p) => p.max > THRESHOLD);
      if (both.length) {
        const top = both.reduce((m, p) => (p.max > m.max ? p : m), both[0]);
        out += `<p class="gtr-cmp-summary">${off.length ? fill(t.vgSummary, { k: off.length, n: both.length, x: THRESHOLD, name: esc(stepLevelName(top.a)), v: num(top.max, 0) }) : fill(t.vgSummaryNone, { n: both.length, x: THRESHOLD })}</p>`;
      }

      // the findings of both measurements side by side, as in the single result
      const findingList = (an) => `<ul class="gtr-findings">${an.findings.map((f) => `<li class="gtr-${f.level}"><span class="ico">${f.level === "ok" ? "✓" : f.level === "warn" ? "!" : "✕"}</span><span>${findingText(f)}</span></li>`).join("")}</ul>`;
      out += `<h4>${t.vgFindings}</h4><div class="gtr-cmp-head">`
        + [["A", a], ["B", b]].map(([k, an]) => `<div class="gtr-cmp-side"><span class="gtr-cmp-tag ${k.toLowerCase()}">${k}</span>${findingList(an)}</div>`).join("") + `</div>`;

      // key figures
      const rgbRow = (label, va, vb, warn, bad) => {
        const d = va.map((v, i) => vb[i] - v);
        return `<tr><td>${label}</td><td>${rgbText(va)}</td><td>${rgbText(vb)}</td><td class="${levelClass(Math.max(...d.map(Math.abs)), warn, bad)}">${d.map((x) => sign(x)).join(" / ")}</td></tr>`;
      };
      const numRow = (label, va, vb, { d = 1, unit = "", warn = Infinity, bad = Infinity, nullText = "–" } = {}) => {
        const f = (v) => (v === null || v === undefined ? nullText : num(v, d) + unit);
        const diff = va === null || va === undefined || vb === null || vb === undefined ? null : vb - va;
        return `<tr><td>${label}</td><td>${f(va)}</td><td>${f(vb)}</td><td class="${diff === null ? "" : levelClass(Math.abs(diff), warn, bad)}">${diff === null ? "–" : sign(diff, d) + unit}</td></tr>`;
      };
      let rows = rgbRow(t.mBlack, a.black, b.black, 2, 6) + rgbRow(t.mWhite, a.white, b.white, 3, 8)
        + numRow(t.mGain, 100 * a.gain, 100 * b.gain, { unit: " %", warn: 2, bad: 6 })
        + numRow(t.mDarkLost, a.darkLostTo, b.darkLostTo, { d: 0, warn: 2, bad: 8 })
        + numRow(t.mLightLost, a.lightLostFrom, b.lightLostFrom, { d: 0, warn: 5, bad: 15 })
        + numRow(t.mTint, a.tint.value, b.tint.value, { warn: 1.5, bad: 4 })
        + numRow(t.mNoise, a.noise, b.noise, { warn: 1, bad: 3 })
        + numRow(t.mDrift, a.drift, b.drift, { warn: 1, bad: 3 });
      const ladderByName = (an) => Object.fromEntries(an.ladders.filter((l) => l.rows.length).map((l) => [l.name, l]));
      const la = ladderByName(a);
      const lb = ladderByName(b);
      for (const name of [...new Set([...Object.keys(la), ...Object.keys(lb)])]) {
        const x = la[name];
        const y = lb[name];
        const lvl = (v) => (v === undefined ? undefined : v === null ? null : v);
        const label = (what) => `<span class="gtr-sw" style="background:${hex((x ?? y).mask.map((m) => m * 255))}"></span> ${t[name]} · ${what}`;
        rows += numRow(label(t.colVisible), lvl(x?.visibleFrom), lvl(y?.visibleFrom), { d: 0, warn: 4, bad: 12, nullText: t.never });
        rows += numRow(label(t.colPure), lvl(x?.pureFrom), lvl(y?.pureFrom), { d: 0, warn: 6, bad: 20, nullText: t.never });
        rows += numRow(label(t.colStrength), x?.strength, y?.strength, { d: 0, unit: " %", warn: 5, bad: 15 });
        rows += numRow(label(t.colPurity), x?.crosstalk, y?.crosstalk, { d: 0, unit: " %", warn: 5, bad: 15 });
      }
      out += `<h4>${t.vgMetrics}</h4><div class="gtr-scroll"><table class="gtr-table gtr-cmp-table"><thead><tr><th>${t.vgMetric}</th><th>A</th><th>B</th><th>${t.vgDelta}</th></tr></thead><tbody>${rows}</tbody></table></div>`;

      // gray levels of both over each other
      const grayRows = (an, result) => [{ level: 0, got: an.black }, ...validSteps(result).filter((s) => s.group === "gray").map((s) => ({ level: s.sent[0], got: s.got }))].sort((p, q) => p.level - q.level);
      // gray levels: both measurements as in the single result, then each channel over each other;
      // A is the blue and B the orange of the selection above
      const rowsA = grayRows(a, A.result);
      const rowsB = grayRows(b, B.result);
      const tag = (k) => `<span class="gtr-cmp-tag ${k.toLowerCase()}">${k}</span>`;
      const OVER = { color: "#2b93ef", overlayColor: "#d08a00" };
      out += `<h4>${t.vgChart}</h4><p class="gtr-hint">${t.vgChartHint}</p>`
        + `<div class="gtr-grid gtr-cmp-pair"><div><div class="cap">${tag("A")}</div>${chartSvg(rowsA, [0, 1, 2], [], { width: 260, height: 180 })}</div>`
        + `<div><div class="cap">${tag("B")}</div>${chartSvg(rowsB, [0, 1, 2], [], { width: 260, height: 180 })}</div></div>`
        + `<p class="gtr-hint">${t.vgChannels}</p><div class="gtr-grid gtr-cmp-charts">`
        + [0, 1, 2].map((i) => `<div><div class="cap"><span class="gtr-sw" style="background:${CHANNEL_COLORS[i]}"></span>${channelName(i)}</div>${chartSvg(rowsA, [i], [], { width: 220, height: 150, small: true, ...OVER, overlayChannels: [i] }, rowsB)}</div>`).join("")
        + `</div>`;

      // color ladders: per color A, B and both over each other (the main channels of the color)
      const ladderPairs = Object.keys(la).filter((n) => lb[n]);
      if (ladderPairs.length) {
        out += `<h4>${t.vgLadders}</h4><p class="gtr-hint">${t.vgLaddersHint}</p><div class="gtr-cmp-ladders">`;
        for (const name of ladderPairs) {
          const x = la[name];
          const y = lb[name];
          const rA = [{ level: 0, got: a.black }, ...x.rows];
          const rB = [{ level: 0, got: b.black }, ...y.rows];
          const solid = [0, 1, 2].filter((i) => x.mask[i]);
          const dashed = [0, 1, 2].filter((i) => !x.mask[i]);
          const small = { width: 170, height: 120, small: true };
          out += `<div class="gtr-cmp-ladder"><div class="cap"><span class="gtr-sw" style="background:${hex(x.mask.map((m) => m * 255))}"></span>${t[name]}</div><div class="gtr-cmp-three">`
            + `<div><div class="cap">${tag("A")}</div>${chartSvg(rA, solid, dashed, small)}</div>`
            + `<div><div class="cap">${tag("B")}</div>${chartSvg(rB, solid, dashed, small)}</div>`
            + `<div><div class="cap">${t.vgOver}</div>${chartSvg(rA, solid, [], { ...small, ...OVER, overlayChannels: solid }, rB)}</div>`
            + `</div></div>`;
        }
        out += `</div>`;
      }

      // every step
      let body = "";
      for (const p of pairs) {
        const s = p.a ?? p.b;
        const cell = (st) => (st ? rgbText(st.got) : `<span class="gtr-muted">${t.vgOnlyOne}</span>`);
        body += `<tr><td><span class="gtr-sw" style="background:${hex(s.sent)}"></span> ${esc(stepLevelName(s))}</td><td>${s.sent.join(" / ")}</td><td>${cell(p.a)}</td><td>${cell(p.b)}</td>`
          + `<td class="${p.delta ? levelClass(p.max, THRESHOLD, 8) : ""}">${p.delta ? p.delta.map((x) => sign(x)).join(" / ") : "–"}</td></tr>`;
      }
      out += `<details class="gtr-cmp-steps"><summary>${fill(t.vgSteps, { n: pairs.length, k: off.length })}</summary><div class="gtr-scroll"><table class="gtr-table gtr-cmp-table"><thead><tr><th>${t.colColor}</th><th>${t.colSent}</th><th>A</th><th>B</th><th>${t.vgDelta}</th></tr></thead><tbody>${body}</tbody></table></div></details>`;

      // own colors: only where both measurements have them (they are saved with a memory slot)
      const cA = A.custom ? validSteps(A.custom) : [];
      const cB = B.custom ? validSteps(B.custom) : [];
      out += `<h4>${t.vgCustom}</h4>`;
      if (cA.length && cB.length) {
        const byColor = new Map(cB.map((s) => [String(s.name ?? s.sent.join(",")).toLowerCase(), s]));
        const used = new Set();
        let body2 = "";
        for (const sa of cA) {
          const k = String(sa.name ?? sa.sent.join(",")).toLowerCase();
          const sb = byColor.get(k);
          used.add(k);
          const d = sb ? sb.got.map((v, i) => v - sa.got[i]) : null;
          body2 += `<tr><td><span class="gtr-sw" style="background:${hex(sa.sent)}"></span> ${esc(stepName(sa))}</td><td>${sa.sent.join(" / ")}</td><td>${rgbText(sa.got)}</td><td>${sb ? rgbText(sb.got) : `<span class="gtr-muted">${t.vgOnlyOne}</span>`}</td><td class="${d ? levelClass(Math.max(...d.map(Math.abs)), THRESHOLD, 8) : ""}">${d ? d.map((x) => sign(x)).join(" / ") : "–"}</td></tr>`;
        }
        for (const sb of cB) {
          const k = String(sb.name ?? sb.sent.join(",")).toLowerCase();
          if (!used.has(k)) body2 += `<tr><td><span class="gtr-sw" style="background:${hex(sb.sent)}"></span> ${esc(stepName(sb))}</td><td>${sb.sent.join(" / ")}</td><td><span class="gtr-muted">${t.vgOnlyOne}</span></td><td>${rgbText(sb.got)}</td><td>–</td></tr>`;
        }
        out += `<div class="gtr-scroll"><table class="gtr-table gtr-cmp-table"><thead><tr><th>${t.colColor}</th><th>${t.colSent}</th><th>A</th><th>B</th><th>${t.vgDelta}</th></tr></thead><tbody>${body2}</tbody></table></div>`;
      } else {
        out += `<p class="gtr-hint">${cA.length || cB.length ? t.vgCustomOne : t.vgCustomNone}</p>`;
      }

      // correction matrices
      const matrixOf = (side) => {
        if (validMatrix(side.matrix)) return side.matrix;
        const fit = fitCorrection(side.result);
        return fit.error ? null : fit.matrix;
      };
      const ma = matrixOf(A);
      const mb = matrixOf(B);
      out += `<h4>${t.vgMatrix}</h4><div class="gtr-matrix-row"><div><b>A</b>${ma ? matrixTable(ma) : `<p class="gtr-hint">${t.vgNoMatrix}</p>`}</div><div><b>B</b>${mb ? matrixTable(mb) : `<p class="gtr-hint">${t.vgNoMatrix}</p>`}</div></div>`;
      if (ma && mb) out += `<p class="gtr-hint">${fill(t.vgMatrixDelta, { v: num(Math.max(...ma.map((v, i) => Math.abs(mb[i] - v))), 3) })}</p>`;
      return out;
    }

    return { t, num, fill, dateText, basicHtml, customHtml, valuesTable, findingText, correctionHtml, compareHtml };
  }

  // onAction(action, correction) makes the correction switchable (WebUI): "enable" passes the
  // correction computed from the basic test, "disable" the current one switched off; toggle: false
  // leaves the on/off switch out when the page has its own
  function render(element, { basic, custom, current, correction, lang = "de", onAction = null, toggle = true } = {}) {
    if (!element) return;
    ensureStyle(element.ownerDocument);
    const r = make(lang);
    element.innerHTML = `<div class="gtr">${basic && validSteps(basic).length ? r.basicHtml(basic, current, correction, !!onAction, toggle) : `<p>${r.t.none}</p>`}${custom ? r.customHtml(custom) : ""}</div>`;
    if (!onAction) return;
    const fresh = () => {
      const fit = fitCorrection(basic);
      return fit.error ? null : { enable: true, matrix: fit.matrix, basedOn: basic.date, before: fit.before, after: fit.after };
    };
    // the switch keeps the stored matrix, so on and off compare the same correction
    element.querySelector("[data-gtr-toggle]")?.addEventListener("change", (ev) => {
      if (!ev.target.checked) {
        onAction("disable", { ...(correction ?? {}), enable: false });
        return;
      }
      const stored = Array.isArray(correction?.matrix) && correction.matrix.length === 9 ? { ...correction, enable: true } : fresh();
      if (stored) onAction("enable", stored);
    });
    element.querySelector("[data-gtr-action=recompute]")?.addEventListener("click", () => {
      const next = fresh();
      if (next) onAction("enable", next);
    });
  }

  // --- calibrations per grabber model ---
  // grabberTest.grabbers = { "<device name>": { enable, active: slot or -1, seen, slots: [slot | null, x3] } }
  // slot = { name, matrix, basedOn, before, after, savedAt, basic }
  // Hyperion corrects the frames of a device with the active slot of that device (VideoProbe.cpp).
  // Older settings have one "correction" for every device; they read as the grabber of the basic
  // test with that correction in slot 1.

  const SLOT_COUNT = 3;
  const NAME_MAX = 40;
  const validMatrix = (m) => Array.isArray(m) && m.length === 9 && m.every((v) => Number.isFinite(v));
  // name of the grabber a test result was measured with
  const testDevice = (result) => (result && result.grabber && result.grabber.name) || null;
  // Hyperion names a grabber like the kernel ("UGREEN-25854: UGREEN-25854"); older tests kept only
  // the part before the colon
  const shortName = (name) => String(name ?? "").split(": ")[0].trim();
  const sameGrabber = (a, b) => !!a && !!b && (a === b || shortName(a) === shortName(b));
  function displayName(name) {
    const parts = String(name ?? "").split(": ");
    return parts.length === 2 && parts[0].trim() === parts[1].trim() ? parts[0].trim() : String(name ?? "");
  }

  // device: the grabber delivering frames now; an older correction is filed under its full name
  function migrated(gt, device = null) {
    const g = gt ?? {};
    if (g.grabbers && typeof g.grabbers === "object") return g;
    const out = { ...g, grabbers: {} };
    delete out.correction;
    const c = g.correction;
    const tested = testDevice(g.basic);
    const name = tested && sameGrabber(tested, device) ? device : tested;
    if (name && c && validMatrix(c.matrix)) {
      const slot = { name: "", matrix: c.matrix, basedOn: c.basedOn ?? null, before: c.before ?? null, after: c.after ?? null, savedAt: c.basedOn ?? null };
      if (g.basic && g.basic.date === c.basedOn) slot.basic = g.basic;
      out.grabbers[name] = { enable: c.enable === true, active: 0, seen: c.basedOn ?? null, slots: [slot, null, null] };
    }
    return out;
  }

  function grabberEntry(gt, device) {
    return (device && migrated(gt, device).grabbers[device]) || null;
  }

  // the correction Hyperion uses for this device, shaped like the older single correction
  function currentCorrection(gt, device) {
    const g = grabberEntry(gt, device);
    const slot = g && g.active >= 0 ? (g.slots ?? [])[g.active] : null;
    if (!slot || !validMatrix(slot.matrix)) return { enable: false };
    return { enable: g.enable === true, matrix: slot.matrix, basedOn: slot.basedOn, before: slot.before, after: slot.after, slot: g.active, name: slot.name ?? "" };
  }

  // Applies a change and returns the new setting (always in the per-grabber form); throws with a
  // text in lang when the change is not possible. ops: enable {on}, use {slot}, save {slot},
  // rename {slot, name}, clear {slot}, forget {device}, acknowledge
  function applyOp(gt, device, op, args = {}, lang = "de", now = new Date().toISOString()) {
    const t = TEXT[lang] ?? TEXT.de;
    const next = structuredClone(migrated(gt, device));
    const fail = (key) => { throw new Error(t[key]); };
    const entry = () => {
      if (!device) fail("errNoDevice");
      const g = next.grabbers[device] ?? (next.grabbers[device] = { enable: false, active: -1, seen: now, slots: [] });
      g.slots = Array.from({ length: SLOT_COUNT }, (_, i) => (g.slots ?? [])[i] ?? null);
      return g;
    };
    const slotIndex = () => {
      const i = Number(args.slot);
      if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT) throw new Error("slot");
      return i;
    };
    const firstFilled = (g) => g.slots.findIndex((x) => x && validMatrix(x.matrix));
    const fromBasic = (g, i) => {
      const basic = next.basic;
      if (!basic || !Array.isArray(basic.steps) || !basic.steps.length) fail("errNoTest");
      if (!sameGrabber(testDevice(basic), device)) fail("errOtherTest");
      const fit = fitCorrection(basic);
      if (fit.error) fail("errFit");
      const old = g.slots[i];
      g.slots[i] = { name: old?.name ?? "", matrix: fit.matrix, basedOn: basic.date, before: fit.before, after: fit.after, savedAt: now, basic };
      // the own colors measured with this grabber belong to the slot, so measurements can be compared later
      const custom = next.custom;
      if (custom && Array.isArray(custom.steps) && custom.steps.length && sameGrabber(testDevice(custom), device)) g.slots[i].custom = custom;
      g.active = i;
      g.enable = true;
    };

    switch (op) {
      case "acknowledge":
        entry();
        break;
      case "enable": {
        const g = entry();
        if (args.on) {
          if (!(g.active >= 0 && g.slots[g.active])) {
            const i = firstFilled(g);
            if (i >= 0) g.active = i;
            else fromBasic(g, 0);
          }
          g.enable = true;
        } else {
          g.enable = false;
        }
        break;
      }
      case "use": {
        const g = entry();
        const i = slotIndex();
        if (!g.slots[i]) fail("errNoSlot");
        g.active = i;
        g.enable = true;
        break;
      }
      case "save": {
        const g = entry();
        fromBasic(g, slotIndex());
        break;
      }
      case "rename": {
        const g = entry();
        const i = slotIndex();
        if (!g.slots[i]) fail("errNoSlot");
        g.slots[i].name = String(args.name ?? "").trim().slice(0, NAME_MAX);
        break;
      }
      case "clear": {
        const g = entry();
        const i = slotIndex();
        g.slots[i] = null;
        if (g.active === i) {
          g.active = firstFilled(g);
          if (g.active < 0) g.enable = false;
        }
        break;
      }
      case "forget":
        delete next.grabbers[String(args.device ?? "")];
        break;
      default:
        throw new Error("op");
    }
    return next;
  }

  // messages for the bell: a grabber delivers frames that has no entry yet
  function notifications(gt, device, lang = "de") {
    const t = TEXT[lang] ?? TEXT.de;
    if (!device || grabberEntry(gt, device)) return [];
    return [{ id: "newGrabber:" + device, kind: "newGrabber", device, name: displayName(device), title: t.ntNewGrabber.replace("{name}", displayName(device)), text: t.ntNewGrabberText }];
  }

  const SLOT_CSS = `
    .gtr-slots { margin: 0 0 6px; }
    .gtr-slot { border: 1px solid rgba(128, 128, 128, .35); border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
    .gtr-slot.on { border-color: #2b93ef; box-shadow: inset 3px 0 0 #2b93ef; }
    .gtr-slot-head { display: flex; align-items: center; gap: 8px 10px; flex-wrap: wrap; }
    .gtr-slot-head b { min-width: 52px; }
    .gtr-slot-head input { flex: 1 1 160px; min-width: 0; max-width: 320px; font: inherit; font-size: 14px; padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(128, 128, 128, .45); background: transparent; color: inherit; }
    .gtr-badge { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #2b93ef; color: #fff; white-space: nowrap; }
    .gtr-badge.idle { background: rgba(128, 128, 128, .35); color: inherit; }
    .gtr-slot-info { font-size: 13px; opacity: .75; margin: 4px 0 0; }
    .gtr-slot-actions { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 8px 0 0; }
    .gtr-slot-actions button { width: auto; margin: 0; }
    .gtr-others { margin: 10px 0 0; }
    .gtr-select { margin: 2px 0 4px; }
    .gtr-select select { font: inherit; font-size: 15px; padding: 6px 10px; width: auto; min-width: min(320px, 100%); max-width: 100%; border-radius: 6px; border: 1px solid rgba(128, 128, 128, .5); background: transparent; color: inherit; }
    .gtr-select option { color: #222; background: #fff; }
    .gtr-other { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 6px 0; border-bottom: 1px solid rgba(128, 128, 128, .25); }
  `;

  // --- comparison of saved measurements ---

  // every measurement that can be compared: the memory slots of all grabbers (their saved basic test)
  // and the last basic test; [{ device, key: "last" | slot number, slot, name, date, result | null }]
  function compareSources(gt) {
    const g = migrated(gt, null);
    const out = [];
    for (const [device, entry] of Object.entries(g.grabbers ?? {})) {
      (entry.slots ?? []).forEach((slot, i) => {
        if (!slot) return;
        const result = slot.basic && validSteps(slot.basic).length ? slot.basic : null;
        out.push({ device, key: String(i), slot: i, name: slot.name ?? "", date: (result && result.date) || slot.basedOn || slot.savedAt || null, result, matrix: validMatrix(slot.matrix) ? slot.matrix : null, custom: slot.custom && validSteps(slot.custom).length ? slot.custom : null });
      });
    }
    if (g.basic && validSteps(g.basic).length) {
      const device = testDevice(g.basic) || "?";
      const custom = g.custom && validSteps(g.custom).length && sameGrabber(testDevice(g.custom), device) ? g.custom : null;
      out.push({ device, key: "last", slot: -1, name: "", date: g.basic.date, result: g.basic, matrix: null, custom });
    }
    return out;
  }

  // The section "compare measurements": pick grabber and measurement for A and B, then "Compare".
  // The selection stays in the element when the page redraws.
  function renderCompare(element, { grabberTest, device = null, lang = "de", heading = true, buttonClass = "" } = {}) {
    if (!element) return;
    ensureStyle(element.ownerDocument);
    const r = make(lang);
    const t = r.t;
    const sources = compareSources(grabberTest);
    const usable = sources.filter((x) => x.result);
    const st = element.__gtrCmp ?? (element.__gtrCmp = { a: null, b: null, shown: false });
    const idOf = (x) => `${x.device}\u0001${x.key}`;
    const find = (id) => sources.find((x) => idOf(x) === id) ?? null;
    const slotLabel = (x) => (x.key === "last"
      ? r.fill(t.vgLast, { date: x.date ? r.dateText(x.date) : "–" })
      : r.fill(t.vgSlot, { n: x.slot + 1, name: x.name ? ` (${x.name})` : "", date: x.date ? r.dateText(x.date) : "–" }) + (x.result ? "" : ` · ${t.vgNoMeasure}`));
    let html = (heading ? `<h4>${esc(t.vgTitle)}</h4>` : "") + `<p class="gtr-hint">${esc(t.vgIntro)}</p>`;
    if (usable.length < 2) {
      element.innerHTML = `<div class="gtr">${html}<p>${esc(t.vgNeedTwo)}</p></div>`;
      return;
    }
    // defaults: A = measurement of the grabber in use (active slot first), B = the next other one
    if (!find(st.a)) {
      const mine = usable.filter((x) => sameGrabber(x.device, device));
      const entry = grabberEntry(grabberTest, device);
      st.a = idOf(mine.find((x) => entry && x.slot === entry.active) ?? mine[0] ?? usable[0]);
      st.shown = false;
    }
    if (!find(st.b) || st.b === st.a) {
      const other = usable.find((x) => idOf(x) !== st.a);
      st.b = idOf(other);
      st.shown = false;
    }
    const devices = [...new Set(sources.map((x) => x.device))];
    const side = (tag, name, id) => {
      const cur = find(id);
      const inDevice = sources.filter((x) => x.device === cur.device);
      return `<div><span class="gtr-cmp-tag ${tag.toLowerCase()}">${tag}</span> <b>${esc(name)}</b>`
        + `<label>${esc(t.vgGrabber)}</label><select data-cmp-device="${tag}">${devices.map((d) => `<option value="${esc(d)}"${d === cur.device ? " selected" : ""}>${esc(displayName(d))}</option>`).join("")}</select>`
        + `<label>${esc(t.vgPick)}</label><select data-cmp-pick="${tag}">${inDevice.map((x) => `<option value="${esc(idOf(x))}"${idOf(x) === id ? " selected" : ""}${x.result ? "" : " disabled"}>${esc(slotLabel(x))}</option>`).join("")}</select></div>`;
    };
    html += `<div class="gtr-cmp-sel">${side("A", t.vgA, st.a)}${side("B", t.vgB, st.b)}</div>`
      + `<div class="gtr-cmp-go"><button type="button"${buttonClass ? ` class="${buttonClass}"` : ""} data-cmp-go>${esc(t.vgGo)}</button></div><div data-cmp-result></div>`;
    element.innerHTML = `<div class="gtr">${html}</div>`;
    const show = () => {
      const box = element.querySelector("[data-cmp-result]");
      const A = find(st.a);
      const B = find(st.b);
      if (!st.shown || !A || !B) { box.innerHTML = ""; return; }
      if (idOf(A) === idOf(B)) { box.innerHTML = `<p>${esc(t.vgSame)}</p>`; return; }
      const label = (x) => `${displayName(x.device)} · ${slotLabel(x).split(" · ")[0]}`;
      box.innerHTML = r.compareHtml({ label: label(A), result: A.result, matrix: A.matrix, custom: A.custom }, { label: label(B), result: B.result, matrix: B.matrix, custom: B.custom });
    };
    // a grabber change selects its first usable measurement; any change clears the result
    for (const tag of ["A", "B"]) {
      const key = tag === "A" ? "a" : "b";
      element.querySelector(`[data-cmp-device="${tag}"]`).addEventListener("change", (ev) => {
        const first = sources.find((x) => x.device === ev.target.value && x.result);
        if (first) st[key] = idOf(first);
        st.shown = false;
        renderCompare(element, { grabberTest, device, lang, heading, buttonClass });
      });
      element.querySelector(`[data-cmp-pick="${tag}"]`).addEventListener("change", (ev) => {
        st[key] = ev.target.value;
        st.shown = false;
        element.querySelector("[data-cmp-result]").innerHTML = "";
      });
    }
    element.querySelector("[data-cmp-go]").addEventListener("click", () => { st.shown = true; show(); });
    show();
  }

  // Memory slots of the connected grabber and the other known grabbers. onAction(op, args) makes
  // them editable (null: read only); toggle adds the on/off switch for the correction. devices
  // ([{ name, label, missing }]) with onSelectDevice(name) shows the grabber as a dropdown.
  function renderSlots(element, { grabberTest, device, lang = "de", onAction = null, toggle = false, buttonClass = "", devices = null, onSelectDevice = null } = {}) {
    if (!element) return;
    ensureStyle(element.ownerDocument);
    const doc = element.ownerDocument;
    if (!doc.getElementById("gtr-slot-style")) {
      const style = doc.createElement("style");
      style.id = "gtr-slot-style";
      style.textContent = SLOT_CSS;
      doc.head.appendChild(style);
    }
    const r = make(lang);
    const t = r.t;
    const gt = migrated(grabberTest, device);
    const g = device ? gt.grabbers[device] : null;
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => (g?.slots ?? [])[i] ?? null);
    const basic = gt.basic && Array.isArray(gt.basic.steps) && gt.basic.steps.length ? gt.basic : null;
    const basicHere = !!(basic && sameGrabber(testDevice(basic), device));
    const canSave = !!(onAction && basicHere && !fitCorrection(basic).error);
    const slotName = (i) => t.slSlot.replace("{n}", i + 1);
    const ask = (text) => (typeof global.confirm === "function" ? global.confirm(text) : true);
    const btn = (action, i, label) => `<button type="button" class="${buttonClass}" data-sl="${action}" data-slot="${i}">${esc(label)}</button>`;

    let out = `<div class="gtr gtr-slots"><h4 style="margin-top:0">${esc(t.slTitle)}</h4>`;
    if (Array.isArray(devices) && onSelectDevice) {
      const opts = devices.map((d) => `<option value="${esc(d.name)}"${d.name === device ? " selected" : ""}>${esc(d.missing ? t.slMissing.replace("{name}", d.label ?? displayName(d.name)) : d.label ?? displayName(d.name))}</option>`);
      if (!devices.some((d) => d.name === device)) opts.unshift(`<option value="" selected>${esc(device ? displayName(device) : "–")}</option>`);
      out += `<div class="gtr-select"><select data-sl-device aria-label="${esc(t.slSelect)}">${opts.join("")}</select></div>`
        + `<p class="gtr-hint">${esc(t.slSelectHint)}</p>`;
    } else {
      out += `<p class="gtr-meta">${device ? r.fill(esc(t.slGrabber), { name: `<b>${esc(displayName(device))}</b>` }) : esc(t.slNoDevice)}</p>`;
    }
    if (device) {
      out += `<p class="gtr-hint">${esc(t.slIntro)}</p>`;
      if (toggle && onAction) {
        const on = !!(g && g.enable && g.active >= 0 && slots[g.active]);
        out += `<label class="gtr-switch" style="margin:4px 0 6px"><input type="checkbox" data-sl="enable"${on ? " checked" : ""}${!on && !slots.some(Boolean) && !canSave ? " disabled" : ""}> ${esc(t.corrSwitch)}</label>`;
      }
      slots.forEach((s, i) => {
        const active = !!(g && g.active === i && s);
        const used = active && g.enable;
        // like all slots: the chosen one is blue, its badge says whether the function runs
        out += `<div class="gtr-slot${active ? " on" : ""}"><div class="gtr-slot-head"><b>${esc(slotName(i))}</b>`;
        if (s) {
          out += onAction ? `<input type="text" maxlength="${NAME_MAX}" data-sl="rename" data-slot="${i}" value="${esc(s.name ?? "")}" placeholder="${esc(t.slNamePh)}">` : s.name ? `<span>${esc(s.name)}</span>` : "";
          if (active) out += `<span class="gtr-badge${used ? "" : " idle"}">${esc(used ? t.slInUse : t.slActive)}</span>`;
        } else {
          out += `<span class="gtr-slot-info" style="margin:0">${esc(t.slEmpty)}</span>`;
        }
        out += `</div>`;
        if (s) {
          out += `<p class="gtr-slot-info">${esc(r.fill(t.slInfo, { date: r.dateText(s.basedOn), before: s.before ? r.num(s.before.mean) : "–", after: s.after ? r.num(s.after.mean) : "–" }))}</p>`;
        }
        if (onAction) {
          const acts = [];
          if (s && !used) acts.push(btn("use", i, t.slUse));
          if (canSave) acts.push(btn("save", i, s ? t.slOverwrite : t.slSave));
          if (s) acts.push(btn("clear", i, t.slClear));
          if (acts.length) out += `<div class="gtr-slot-actions">${acts.join("")}</div>`;
        }
        out += `</div>`;
      });
      if (onAction) {
        out += `<p class="gtr-hint">${esc(canSave ? r.fill(t.slSaveHint, { date: r.dateText(basic.date) }) : basic && !basicHere ? r.fill(t.slOtherTest, { name: displayName(testDevice(basic) ?? "?") }) : basic ? r.fill(t.corrFitNone, { why: t.corrWhyData }) : t.slNoTest)}</p>`;
      }
    }
    const others = Object.keys(gt.grabbers).filter((n) => n !== device).sort();
    if (others.length) {
      out += `<details class="gtr-others"><summary>${esc(t.slOthers.replace("{n}", others.length))}</summary>`;
      for (const n of others) {
        const o = gt.grabbers[n];
        const filled = (o.slots ?? []).filter(Boolean).length;
        const on = o.enable && o.active >= 0 && (o.slots ?? [])[o.active];
        const state = on ? t.slOtherOn.replace("{slot}", slotName(o.active) + (o.slots[o.active].name ? ` (${o.slots[o.active].name})` : "")) : t.slOtherOff;
        out += `<div class="gtr-other"><span><b>${esc(displayName(n))}</b><br><span class="gtr-slot-info">${esc(r.fill(t.slOtherLine, { used: filled, state }))}</span></span>`
          + (onAction ? `<button type="button" class="${buttonClass}" data-sl="forget" data-device="${esc(n)}">${esc(t.slForget)}</button>` : "") + `</div>`;
      }
      out += `</details>`;
    }
    out += `</div>`;
    element.innerHTML = out;
    const select = element.querySelector("select[data-sl-device]");
    if (select) {
      select.addEventListener("change", () => {
        const name = select.value;
        if (!name || name === device) return;
        const label = select.options[select.selectedIndex].textContent;
        if (!ask(r.fill(t.slConfirmSwitch, { name: label }))) {
          select.value = devices.some((d) => d.name === device) ? device : "";
          return;
        }
        onSelectDevice(name);
      });
    }
    if (!onAction) return;

    element.querySelectorAll("button[data-sl]").forEach((b) => b.addEventListener("click", () => {
      const op = b.dataset.sl;
      const i = Number(b.dataset.slot);
      if (op === "save" && slots[i] && !ask(r.fill(t.slConfirmOverwrite, { slot: slotName(i), date: r.dateText(basic.date) }))) return;
      if (op === "clear" && !ask(r.fill(t.slConfirmClear, { slot: slotName(i) }))) return;
      if (op === "forget" && !ask(r.fill(t.slConfirmForget, { name: displayName(b.dataset.device) }))) return;
      onAction(op, op === "forget" ? { device: b.dataset.device } : { slot: i });
    }));
    element.querySelectorAll('input[data-sl="rename"]').forEach((inp) => inp.addEventListener("change", () => onAction("rename", { slot: Number(inp.dataset.slot), name: inp.value })));
    element.querySelector('input[data-sl="enable"]')?.addEventListener("change", (ev) => onAction("enable", { on: ev.target.checked }));
  }

  global.GrabberTestReport = { basicSteps, analyze, changedKeys, fitCorrection, evaluateCorrection, render, make, GRABBER_KEYS, TEXT,
    migrated, grabberEntry, currentCorrection, applyOp, notifications, renderSlots, renderCompare, compareSources, testDevice, sameGrabber, displayName, SLOT_COUNT };
})(typeof window !== "undefined" ? window : globalThis);
