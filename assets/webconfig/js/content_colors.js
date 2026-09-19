$(document).ready(function () {
  performTranslation();

  var BORDERDETECT_ENABLED = (jQuery.inArray("borderdetection", window.serverInfo.services) !== -1);

  // update instance listing
  updateHyperionInstanceListing();

  var editor_color = null;
  var editor_smoothing = null;
  var editor_blackborder = null;

  if (window.showOptHelp) {
    //color
    $('#conf_cont').append(createRow('conf_cont_color'));
    $('#conf_cont_color').append(createOptPanel('fa-photo', $.i18n("edt_conf_color_heading_title"), 'editor_container_color', 'btn_submit_color'));
    $('#conf_cont_color').append(createHelpTable(window.schema.color.properties, $.i18n("edt_conf_color_heading_title")));

    //smoothing
    $('#conf_cont').append(createRow('conf_cont_smoothing'));
    $('#conf_cont_smoothing').append(createOptPanel('fa-photo', $.i18n("edt_conf_smooth_heading_title"), 'editor_container_smoothing', 'btn_submit_smoothing'));
    $('#conf_cont_smoothing').append(createHelpTable(window.schema.smoothing.properties, $.i18n("edt_conf_smooth_heading_title"), "smoothingHelpPanelId"));

    //blackborder
    if (BORDERDETECT_ENABLED) {
      $('#conf_cont').append(createRow('conf_cont_blackborder'));
      $('#conf_cont_blackborder').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_heading_title"), 'editor_container_blackborder', 'btn_submit_blackborder'));
      $('#conf_cont_blackborder').append(createHelpTable(window.schema.blackborderdetector.properties, $.i18n("edt_conf_bb_heading_title"), "blackborderHelpPanelId"));

      //gray still-image detection (fork extension) - own area, placed right below black border detection
      $('#conf_cont').append(createRow('conf_cont_graystill'));
      $('#conf_cont_graystill').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_grayStillImageDetector_title"), 'editor_container_graystill', 'btn_submit_graystill'));
    }
  }
  else {
    $('#conf_cont').addClass('row');
    $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_color_heading_title"), 'editor_container_color', 'btn_submit_color'));
    $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_smooth_heading_title"), 'editor_container_smoothing', 'btn_submit_smoothing'));
    if (BORDERDETECT_ENABLED) {
      $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_heading_title"), 'editor_container_blackborder', 'btn_submit_blackborder'));

      //gray still-image detection (fork extension) - own area, placed right below black border detection
      $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_grayStillImageDetector_title"), 'editor_container_graystill', 'btn_submit_graystill'));
    }
  }

  //color
  editor_color = createJsonEditor('editor_container_color', {
    color: window.schema.color
  }, true, true);

  editor_color.on('change', function () {
    editor_color.validate().length || window.readOnlyMode ? $('#btn_submit_color').prop('disabled', true) : $('#btn_submit_color').prop('disabled', false);
  });

  $('#btn_submit_color').off().on('click', function () {
    requestWriteConfig(editor_color.getValue());
  });

  // Fork-Erweiterung: kleines Info-Symbol neben jedem Feld der
  // Farbanpassungs-Seite, das per Hover den passenden "_expl"-Beschreibungs-
  // text zeigt (Funktion, Wertebereich, Schrittweite). Nutzt das native
  // HTML-title-Attribut statt Bootstraps Tooltip-Plugin, da dieses in der
  // hier eingebundenen bootstrap.min.js nicht enthalten ist.
  (function addColorFieldInfoIcons(editor) {
    function attachInfoIcon(path, explKey) {
      var fieldEditor;
      try {
        fieldEditor = editor.getEditor(path);
      } catch (e) {
        return;
      }
      if (!fieldEditor || !fieldEditor.label) return;
      var $label = $(fieldEditor.label);
      if ($label.data('forkInfoIconAdded')) return;
      var explText = $.i18n(explKey);
      if (!explText || explText === explKey) return; // keine Übersetzung vorhanden
      $label.append(
        $('<i>')
          .addClass('fa fa-info-circle')
          .attr('title', explText)
          .css({ 'margin-left': '6px', cursor: 'help', color: '#3a87ad' })
      );
      $label.data('forkInfoIconAdded', true);
    }

    var PROFILE_BASE = 'root.color.channelAdjustment.0.';

    // Bestehende + neue feste (nicht dynamische) Felder des Profils
    var staticFields = {
      'id': 'edt_conf_color_id_expl',
      'leds': 'edt_conf_color_leds_expl',
      'white': 'edt_conf_color_white_expl',
      'red': 'edt_conf_color_red_expl',
      'green': 'edt_conf_color_green_expl',
      'blue': 'edt_conf_color_blue_expl',
      'cyan': 'edt_conf_color_cyan_expl',
      'magenta': 'edt_conf_color_magenta_expl',
      'yellow': 'edt_conf_color_yellow_expl',
      'saturationGain': 'edt_conf_color_saturationGain_expl',
      'backlightThreshold': 'edt_conf_color_backlightThreshold_expl',
      'backlightColored': 'edt_conf_color_backlightColored_expl',
      'brightness': 'edt_conf_color_brightness_expl',
      'brightnessCompensation': 'edt_conf_color_brightnessComp_expl',
      'brightnessGain': 'edt_conf_color_brightnessGain_expl',
      'temperature': 'edt_conf_color_temperature_expl',
      'gammaRed': 'edt_conf_color_gammaRed_expl',
      'gammaGreen': 'edt_conf_color_gammaGreen_expl',
      'gammaBlue': 'edt_conf_color_gammaBlue_expl',
      'grayAxisTrim': 'edt_conf_color_grayAxisTrim_expl'
    };
    Object.keys(staticFields).forEach(function (key) {
      attachInfoIcon(PROFILE_BASE + key, staticFields[key]);
    });

    // grayAxisTrim.enabled ist ein festes (nicht-dynamisches) Feld
    attachInfoIcon(PROFILE_BASE + 'grayAxisTrim.enabled', 'edt_conf_color_grayAxisTrim_enabled_expl');

    // grayAxisTrim.stops ist eine dynamische Liste (Grauachsen-Stufen,
    // Fork-Erweiterung) - Felder pro Zeile werden erst beim Hinzufügen
    // einer Zeile erzeugt, daher per MutationObserver erneut anhängen
    // statt einmalig.
    var grayAxisStopFields = {
      'saturationUpTo': 'edt_conf_color_grayAxisTrim_stops_saturationUpTo_expl',
      'gainRed': 'edt_conf_color_grayAxisTrim_gainRed_expl',
      'gainGreen': 'edt_conf_color_grayAxisTrim_gainGreen_expl',
      'gainBlue': 'edt_conf_color_grayAxisTrim_gainBlue_expl'
    };
    var grayAxisStopsEditor;
    try {
      grayAxisStopsEditor = editor.getEditor(PROFILE_BASE + 'grayAxisTrim.stops');
    } catch (e) {
      grayAxisStopsEditor = null;
    }
    if (grayAxisStopsEditor && grayAxisStopsEditor.container) {
      var attachAllGrayAxisRows = function () {
        var rowCount = (grayAxisStopsEditor.rows || []).length;
        for (var i = 0; i < rowCount; i++) {
          var rowBase = PROFILE_BASE + 'grayAxisTrim.stops.' + i + '.';
          Object.keys(grayAxisStopFields).forEach(function (key) {
            attachInfoIcon(rowBase + key, grayAxisStopFields[key]);
          });
        }
      };
      attachAllGrayAxisRows();
      var grayAxisStopsObserver = new MutationObserver(function () {
        attachAllGrayAxisRows();
      });
      grayAxisStopsObserver.observe(grayAxisStopsEditor.container, { childList: true, subtree: true });

      // Fork-Erweiterung: die Stufen muessen aufsteigend nach "Saettigung
      // bis" sortiert sein. Der Server sortiert zwar defensiv vor der
      // Auswertung, aber eine unsortierte Eingabe hier waere trotzdem
      // verwirrend, weil die sichtbare Zeilenreihenfolge dann nicht der
      // tatsaechlich angewendeten Kurve entspricht -- deshalb wird die
      // Reihenfolge hier aktiv erzwungen statt nur intern stillschweigend
      // korrigiert: bei einer Unsortierung erscheint eine Warnung, die
      // betroffenen Zeilen werden rot markiert, und der Speichern-Button
      // bleibt gesperrt (siehe editor.on('change', ...) unten), bis die
      // Reihenfolge stimmt.
      var $grayAxisOrderWarning = $('<div>')
        .attr('id', 'grayAxisStopsOrderWarning')
        .css({
          display: 'none',
          color: '#a94442',
          background: '#f2dede',
          border: '1px solid #ebccd1',
          borderRadius: '4px',
          padding: '6px 10px',
          margin: '4px 0 8px'
        });
      $(grayAxisStopsEditor.container).before($grayAxisOrderWarning);

      var getGrayAxisStopField = function (rowIndex) {
        try {
          return editor.getEditor(PROFILE_BASE + 'grayAxisTrim.stops.' + rowIndex + '.saturationUpTo');
        } catch (e) {
          return null;
        }
      };

      var findGrayAxisStopsOrderViolation = function () {
        var stops;
        try {
          stops = grayAxisStopsEditor.getValue();
        } catch (e) {
          return -1;
        }
        if (!Array.isArray(stops)) return -1;
        for (var i = 1; i < stops.length; i++) {
          var prev = stops[i - 1] ? stops[i - 1].saturationUpTo : undefined;
          var cur = stops[i] ? stops[i].saturationUpTo : undefined;
          if (typeof prev === 'number' && typeof cur === 'number' && cur <= prev) {
            return i;
          }
        }
        return -1;
      };

      var updateGrayAxisStopsOrderCheck = function () {
        var rowCount = (grayAxisStopsEditor.rows || []).length;
        for (var i = 0; i < rowCount; i++) {
          var fieldEditor = getGrayAxisStopField(i);
          if (fieldEditor && fieldEditor.input) {
            $(fieldEditor.input).css('border-color', '');
          }
        }

        var violationIndex = findGrayAxisStopsOrderViolation();
        if (violationIndex < 0) {
          $grayAxisOrderWarning.hide();
          return false;
        }

        $grayAxisOrderWarning
          .text($.i18n('edt_conf_color_grayAxisTrim_stops_order_error') +
            ' (' + $.i18n('edt_conf_color_grayAxisTrim_stops_itemtitle') + ' ' + violationIndex + ' / ' + (violationIndex + 1) + ')')
          .show();

        [violationIndex - 1, violationIndex].forEach(function (i) {
          var fieldEditor = getGrayAxisStopField(i);
          if (fieldEditor && fieldEditor.input) {
            $(fieldEditor.input).css('border-color', '#a94442');
          }
        });

        return true;
      };

      updateGrayAxisStopsOrderCheck();
      editor.on('change', function () {
        if (updateGrayAxisStopsOrderCheck()) {
          $('#btn_submit_color').prop('disabled', true);
        }
      });
    }

  })(editor_color);

  //smoothing
  editor_smoothing = createJsonEditor('editor_container_smoothing', {
    smoothing: window.schema.smoothing
  }, true, true);

  editor_smoothing.on('change', function () {
    var smoothingEnable = editor_smoothing.getEditor("root.smoothing.enable").getValue();
    if (smoothingEnable) {
      showInputOptionsForKey(editor_smoothing, "smoothing", "enable", true);
      $('#smoothingHelpPanelId').show();
    } else {
      showInputOptionsForKey(editor_smoothing, "smoothing", "enable", false);
      $('#smoothingHelpPanelId').hide();
    }
    editor_smoothing.validate().length || window.readOnlyMode ? $('#btn_submit_smoothing').prop('disabled', true) : $('#btn_submit_smoothing').prop('disabled', false);
  });

  $('#btn_submit_smoothing').off().on('click', function () {
    requestWriteConfig(editor_smoothing.getValue());
  });

  //blackborder
  if (BORDERDETECT_ENABLED) {
    editor_blackborder = createJsonEditor('editor_container_blackborder', {
      blackborderdetector: window.schema.blackborderdetector
    }, true, true);

    editor_blackborder.on('change', function () {
      var blackborderEnable = editor_blackborder.getEditor("root.blackborderdetector.enable").getValue();
      if (blackborderEnable) {
        showInputOptionsForKey(editor_blackborder, "blackborderdetector", "enable", true);
        $('#blackborderHelpPanelId').show();
        $('#blackborderWikiLinkId').show();

      } else {
        showInputOptionsForKey(editor_blackborder, "blackborderdetector", "enable", false);
        $('#blackborderHelpPanelId').hide();
        $('#blackborderWikiLinkId').hide();
      }
      var blackborderInvalid = editor_blackborder.validate().length || window.readOnlyMode;
      $('#btn_submit_blackborder').prop('disabled', blackborderInvalid);
      $('#btn_submit_graystill').prop('disabled', blackborderInvalid);
    });

    $('#btn_submit_blackborder').off().on('click', function () {
      requestWriteConfig(editor_blackborder.getValue());
    });

    // Fork-Erweiterung: Info-Symbole fuer die Graues-Standbild-Erkennung,
    // gleiches Muster wie bei den Farbkalibrierungs-Feldern oben.
    (function addGrayStillInfoIcons(editor) {
      function attachInfoIcon(path, explKey) {
        var fieldEditor;
        try {
          fieldEditor = editor.getEditor(path);
        } catch (e) {
          return;
        }
        if (!fieldEditor || !fieldEditor.label) return;
        var $label = $(fieldEditor.label);
        if ($label.data('forkInfoIconAdded')) return;
        var explText = $.i18n(explKey);
        if (!explText || explText === explKey) return;
        $label.append(
          $('<i>')
            .addClass('fa fa-info-circle')
            .attr('title', explText)
            .css({ 'margin-left': '6px', cursor: 'help', color: '#3a87ad' })
        );
        $label.data('forkInfoIconAdded', true);
      }

      var BASE = 'root.blackborderdetector.grayStillImageDetector.';
      var fields = {
        'enabled': 'edt_conf_bb_grayStillImageDetector_enabled_expl',
        'stillTimeSeconds': 'edt_conf_bb_grayStillImageDetector_stillTimeSeconds_expl',
        'brightnessDropThreshold': 'edt_conf_bb_grayStillImageDetector_brightnessDropThreshold_expl',
        'dropWindowSeconds': 'edt_conf_bb_grayStillImageDetector_dropWindowSeconds_expl',
        'changeThreshold': 'edt_conf_bb_grayStillImageDetector_changeThreshold_expl',
        'mode': 'edt_conf_bb_grayStillImageDetector_mode_expl'
      };
      Object.keys(fields).forEach(function (key) {
        attachInfoIcon(BASE + key, fields[key]);
      });
    })(editor_blackborder);

    // Fork-Erweiterung: Graues-Standbild-Erkennung als eigener Bereich unterhalb
    // der Schwarze-Balken-Erkennung. Technisch bleibt es Teil desselben
    // blackborderdetector-Objekts/Editors (ein Formular, ein "Speichern" fuer
    // beide Bereiche) - so kann das separate Speichern hier nicht versehentlich
    // ungespeicherte Aenderungen im Schwarze-Balken-Bereich ueberschreiben.
    var grayStillEditor = editor_blackborder.getEditor('root.blackborderdetector.grayStillImageDetector');
    if (grayStillEditor && grayStillEditor.container) {
      if (grayStillEditor.title) {
        grayStillEditor.title.style.display = 'none';
      }
      $('#editor_container_graystill').append(grayStillEditor.container);
    }

    $('#btn_submit_graystill').off().on('click', function () {
      requestWriteConfig(editor_blackborder.getValue());
    });
  }

  //wiki links
  var wikiElement = $(buildWL("user/advanced/Advanced.html#blackbar-detection", "edt_conf_bb_mode_title", true));
  wikiElement.attr('id', 'blackborderWikiLinkId');
  $('#editor_container_blackborder').append(wikiElement);

  //create introduction
  if (window.showOptHelp) {
    createHint("intro", $.i18n('conf_colors_color_intro'), "editor_container_color");
    createHint("intro", $.i18n('conf_colors_smoothing_intro'), "editor_container_smoothing");
    if (BORDERDETECT_ENABLED) {
      createHint("intro", $.i18n('conf_colors_blackborder_intro'), "editor_container_blackborder");
    }
  }

  removeOverlay();
});
