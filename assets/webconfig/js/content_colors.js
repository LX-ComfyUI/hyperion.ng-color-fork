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
    }
  }
  else {
    $('#conf_cont').addClass('row');
    $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_color_heading_title"), 'editor_container_color', 'btn_submit_color'));
    $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_smooth_heading_title"), 'editor_container_smoothing', 'btn_submit_smoothing'));
    if (BORDERDETECT_ENABLED) {
      $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_heading_title"), 'editor_container_blackborder', 'btn_submit_blackborder'));
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
      'controlPoints': 'edt_conf_color_controlPoints_expl',
      'grayAxisTrim': 'edt_conf_color_grayAxisTrim_expl'
    };
    Object.keys(staticFields).forEach(function (key) {
      attachInfoIcon(PROFILE_BASE + key, staticFields[key]);
    });

    // grayAxisTrim ist ein festes (nicht-dynamisches) Unterobjekt
    var grayAxisFields = {
      'enabled': 'edt_conf_color_grayAxisTrim_enabled_expl',
      'saturationThreshold': 'edt_conf_color_grayAxisTrim_saturationThreshold_expl',
      'gainRed': 'edt_conf_color_grayAxisTrim_gainRed_expl',
      'gainGreen': 'edt_conf_color_grayAxisTrim_gainGreen_expl',
      'gainBlue': 'edt_conf_color_grayAxisTrim_gainBlue_expl'
    };
    Object.keys(grayAxisFields).forEach(function (key) {
      attachInfoIcon(PROFILE_BASE + 'grayAxisTrim.' + key, grayAxisFields[key]);
    });

    // controlPoints ist eine dynamische Liste (0..n Zeilen) - Felder pro
    // Zeile werden erst beim Hinzufügen einer Zeile erzeugt, daher per
    // MutationObserver auf dem Container erneut anhängen statt einmalig.
    var controlPointFields = {
      '': 'edt_conf_color_controlPoints_lumaGate_expl', // Platzhalter, wird unten nicht genutzt
      'id': 'edt_conf_color_controlPoints_id_expl',
      'enabled': 'edt_conf_color_controlPoints_enabled_expl',
      'hue': 'edt_conf_color_controlPoints_hue_expl',
      'influence': 'edt_conf_color_controlPoints_influence_expl',
      'targetHueShift': 'edt_conf_color_controlPoints_targetHueShift_expl',
      'targetSaturationGain': 'edt_conf_color_controlPoints_targetSaturationGain_expl',
      'gamma': 'edt_conf_color_controlPoints_gamma_expl',
      'brightnessGain': 'edt_conf_color_controlPoints_brightnessGain_expl',
      'lumaGate': 'edt_conf_color_controlPoints_lumaGate_expl',
      'lumaGate.enabled': 'edt_conf_color_controlPoints_lumaGate_enabled_expl',
      'lumaGate.triggerBelow': 'edt_conf_color_controlPoints_lumaGate_triggerBelow_expl',
      'lumaGate.releaseAbove': 'edt_conf_color_controlPoints_lumaGate_releaseAbove_expl',
      'lumaGate.debounceFrames': 'edt_conf_color_controlPoints_lumaGate_debounceFrames_expl',
      'lumaGate.mode': 'edt_conf_color_controlPoints_lumaGate_mode_expl',
      'lumaGate.gatedHueShift': 'edt_conf_color_controlPoints_lumaGate_gatedHueShift_expl',
      'lumaGate.minBrightness': 'edt_conf_color_controlPoints_lumaGate_minBrightness_expl'
    };
    delete controlPointFields[''];

    // Vorher/Nachher-Farbvorschau (fork extension) fuer die beiden
    // Verschiebungsfelder: targetHueShift und lumaGate.gatedHueShift sind
    // *Differenzwerte*, kein absoluter Farbton, daher kein Farb-Auswahl-Feld
    // (wie bei "hue" oben) -- stattdessen zwei kleine Kreise, die die Farbe
    // vor und nach der Verschiebung zeigen, live nachgefuehrt ueber
    // editor.watch() auf das jeweilige Verschiebungsfeld und das
    // zugehoerige "hue"-Feld derselben Zeile.
    function hueToCss(h) {
      h = ((h % 1) + 1) % 1;
      var i = Math.floor(h * 6);
      var f = h * 6 - i;
      var q = 1 - f, t = f, rgb;
      switch (i % 6) {
        case 0: rgb = [1, t, 0]; break;
        case 1: rgb = [q, 1, 0]; break;
        case 2: rgb = [0, 1, t]; break;
        case 3: rgb = [0, q, 1]; break;
        case 4: rgb = [t, 0, 1]; break;
        default: rgb = [1, 0, q]; break;
      }
      return 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
    }

    function attachHueShiftPreview(rowBase, shiftKey) {
      var hueEditor, shiftEditor;
      try {
        hueEditor = editor.getEditor(rowBase + 'hue');
        shiftEditor = editor.getEditor(rowBase + shiftKey);
      } catch (e) {
        return;
      }
      if (!hueEditor || !shiftEditor || !shiftEditor.label) return;
      var $label = $(shiftEditor.label);
      if ($label.data('forkHueShiftPreviewAdded')) return;

      var swatchCss = { display: 'inline-block', width: '14px', height: '14px', 'border-radius': '50%', 'vertical-align': 'middle', border: '1px solid #888' };
      var $before = $('<span>').css($extendCss(swatchCss, { 'margin-left': '8px' }));
      var $arrow = $('<i>').addClass('fa fa-long-arrow-right').css({ margin: '0 4px', color: '#888' });
      var $after = $('<span>').css(swatchCss);
      $label.append($before, $arrow, $after);
      $label.data('forkHueShiftPreviewAdded', true);

      function update() {
        var hueVal = hueEditor.getValue();
        var shiftVal = shiftEditor.getValue();
        if (typeof hueVal !== 'number' || typeof shiftVal !== 'number') return;
        $before.css('background-color', hueToCss(hueVal));
        $after.css('background-color', hueToCss(hueVal + shiftVal));
      }
      update();

      editor.watch(rowBase + 'hue', update);
      editor.watch(rowBase + shiftKey, update);
    }

    function $extendCss(base, extra) {
      var merged = {};
      for (var k in base) { merged[k] = base[k]; }
      for (var k2 in extra) { merged[k2] = extra[k2]; }
      return merged;
    }

    var controlPointsEditor;
    try {
      controlPointsEditor = editor.getEditor(PROFILE_BASE + 'controlPoints');
    } catch (e) {
      controlPointsEditor = null;
    }
    if (controlPointsEditor && controlPointsEditor.container) {
      var attachAllRows = function () {
        var rowCount = (controlPointsEditor.rows || []).length;
        for (var i = 0; i < rowCount; i++) {
          var rowBase = PROFILE_BASE + 'controlPoints.' + i + '.';
          Object.keys(controlPointFields).forEach(function (key) {
            attachInfoIcon(rowBase + key, controlPointFields[key]);
          });
          attachHueShiftPreview(rowBase, 'targetHueShift');
          attachHueShiftPreview(rowBase, 'lumaGate.gatedHueShift');
        }
      };
      attachAllRows();
      var controlPointsObserver = new MutationObserver(function () {
        attachAllRows();
      });
      controlPointsObserver.observe(controlPointsEditor.container, { childList: true, subtree: true });
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
      editor_blackborder.validate().length || window.readOnlyMode ? $('#btn_submit_blackborder').prop('disabled', true) : $('#btn_submit_blackborder').prop('disabled', false);
    });

    $('#btn_submit_blackborder').off().on('click', function () {
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
