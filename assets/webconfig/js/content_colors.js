$(document).ready(function () {
  performTranslation();

  var BORDERDETECT_ENABLED = (jQuery.inArray("borderdetection", window.serverInfo.services) !== -1);

  // update instance listing
  updateHyperionInstanceListing();

  var editor_color = null;
  var editor_smoothing = null;
  var editor_blackborder = null;

  // Fork-Erweiterung: die Erfassungstiefe der LED-Bereiche (color.ledAreaDepth) wird auf der Seite
  // LED-Hardware eingestellt; hier fehlt sie im Formular, beim Speichern bleibt der Wert aus Hyperion
  var colorSchema = $.extend(true, {}, window.schema.color);
  delete colorSchema.properties.ledAreaDepth;
  var colorValue = function () {
    var value = editor_color.getValue();
    var depth = window.serverConfig.color && window.serverConfig.color.ledAreaDepth;
    if (depth && value.color) value.color.ledAreaDepth = depth;
    return value;
  };

  // Fork-Erweiterung: die Graukurve steht in einem eigenen Bereich unter der
  // Farbkalibrierung (Teil desselben Formulars wie bei der Graues-Standbild-Erkennung, jeder Bereich
  // speichert das ganze Formular). Nur im Experten-Modus, wie die Einstellungen selbst.
  var profileProps = colorSchema.properties.channelAdjustment.items.properties;
  var GRAY_SECTIONS = [
    { key: 'grayCurve', container: 'editor_container_graycurve', button: 'btn_submit_graycurve', icon: 'fa-line-chart' }
  ].filter(function (sec) {
    var prop = profileProps[sec.key];
    return prop && (prop.access !== 'expert' || storedAccess === 'expert');
  });

  if (window.showOptHelp) {
    //color
    $('#conf_cont').append(createRow('conf_cont_color'));
    $('#conf_cont_color').append(createOptPanel('fa-photo', $.i18n("edt_conf_color_heading_title"), 'editor_container_color', 'btn_submit_color'));
    $('#conf_cont_color').append(createHelpTable(colorSchema.properties, $.i18n("edt_conf_color_heading_title")));

    GRAY_SECTIONS.forEach(function (sec) {
      var title = $.i18n(profileProps[sec.key].title);
      $('#conf_cont').append(createRow('conf_cont_' + sec.key));
      $('#conf_cont_' + sec.key).append(createOptPanel(sec.icon, title, sec.container, sec.button));
      $('#conf_cont_' + sec.key).append(createHelpTable(profileProps[sec.key].properties, title));
    });

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
    GRAY_SECTIONS.forEach(function (sec) {
      $('#conf_cont').append(createOptPanel(sec.icon, $.i18n(profileProps[sec.key].title), sec.container, sec.button));
    });
    $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_smooth_heading_title"), 'editor_container_smoothing', 'btn_submit_smoothing'));
    if (BORDERDETECT_ENABLED) {
      $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_heading_title"), 'editor_container_blackborder', 'btn_submit_blackborder'));

      //gray still-image detection (fork extension) - own area, placed right below black border detection
      $('#conf_cont').append(createOptPanel('fa-photo', $.i18n("edt_conf_bb_grayStillImageDetector_title"), 'editor_container_graystill', 'btn_submit_graystill'));
    }
  }

  //color
  editor_color = createJsonEditor('editor_container_color', {
    color: colorSchema
  }, true, true);

  var colorButtons = ['#btn_submit_color'].concat(GRAY_SECTIONS.map(function (sec) { return '#' + sec.button; }));
  editor_color.on('change', function () {
    $(colorButtons.join(',')).prop('disabled', !!(editor_color.validate().length || window.readOnlyMode));
    relocateGraySections();
  });

  $(colorButtons.join(',')).off().on('click', function () {
    requestWriteConfig(colorValue());
  });

  // Fork-Erweiterung: die Teile jedes Farbprofils in ihre Bereiche umhängen. Beim Hinzufügen oder
  // Entfernen eines Profils baut der Editor die Zeilen neu auf, daher bei jeder Änderung prüfen.
  function relocateGraySections() {
    var adjustments = editor_color.getEditor('root.color.channelAdjustment');
    var count = adjustments && adjustments.rows ? adjustments.rows.length : 0;
    GRAY_SECTIONS.forEach(function (sec) {
      var target = document.getElementById(sec.container);
      if (!target) return;
      for (var i = 0; i < count; i++) {
        var part = editor_color.getEditor('root.color.channelAdjustment.' + i + '.' + sec.key);
        if (!part || !part.container) continue;
        var holderId = sec.container + '_profile_' + i;
        var holder = document.getElementById(holderId);
        if (!holder) {
          holder = document.createElement('div');
          holder.id = holderId;
          holder.className = 'fork-profile-part';
          holder.innerHTML = '<h5 class="fork-profile-name"></h5>';
          target.appendChild(holder);
        }
        var profile = editor_color.getEditor('root.color.channelAdjustment.' + i + '.id');
        var name = holder.querySelector('.fork-profile-name');
        name.textContent = $.i18n('edt_conf_color_profile_label', profile ? profile.getValue() : String(i + 1));
        name.style.display = count > 1 ? '' : 'none';
        if (part.title) part.title.style.display = 'none';
        if (part.container.parentNode !== holder) holder.appendChild(part.container);
      }
      // Bereiche entfernter Profile
      $(target).children('.fork-profile-part').each(function () {
        var index = Number(this.id.split('_profile_')[1]);
        if (index >= count) $(this).remove();
      });
    });
  }
  relocateGraySections();

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
      infoIcons.add(fieldEditor.label, explText); // Fork: gemeinsames (i)-Symbol mit Blase (ui_utils.js)
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
      'grayCurve': 'edt_conf_color_grayCurve_expl'
    };
    Object.keys(staticFields).forEach(function (key) {
      attachInfoIcon(PROFILE_BASE + key, staticFields[key]);
    });

    // Graukurve (Fork-Erweiterung): feste Felder plus dynamische Punkte-Liste; die
    // Felder einer Zeile entstehen erst beim Hinzufügen, daher per MutationObserver
    // erneut anhängen. Die Reihenfolge der Punkte ist egal, der Server sortiert sie
    // nach Helligkeit.
    attachInfoIcon(PROFILE_BASE + 'grayCurve.enabled', 'edt_conf_color_grayCurve_enabled_expl');
    attachInfoIcon(PROFILE_BASE + 'grayCurve.saturationLimit', 'edt_conf_color_grayCurve_saturationLimit_expl');
    attachInfoIcon(PROFILE_BASE + 'grayCurve.points', 'edt_conf_color_grayCurve_points_expl');
    var grayCurvePointFields = {
      'level': 'edt_conf_color_grayCurve_level_expl',
      'gainRed': 'edt_conf_color_grayCurve_gainRed_expl',
      'gainGreen': 'edt_conf_color_grayCurve_gainGreen_expl',
      'gainBlue': 'edt_conf_color_grayCurve_gainBlue_expl'
    };
    var grayCurvePointsEditor;
    try {
      grayCurvePointsEditor = editor.getEditor(PROFILE_BASE + 'grayCurve.points');
    } catch (e) {
      grayCurvePointsEditor = null;
    }
    if (grayCurvePointsEditor && grayCurvePointsEditor.container) {
      var attachAllGrayCurveRows = function () {
        var rowCount = (grayCurvePointsEditor.rows || []).length;
        for (var i = 0; i < rowCount; i++) {
          var rowBase = PROFILE_BASE + 'grayCurve.points.' + i + '.';
          Object.keys(grayCurvePointFields).forEach(function (key) {
            attachInfoIcon(rowBase + key, grayCurvePointFields[key]);
          });
        }
      };
      attachAllGrayCurveRows();
      new MutationObserver(function () {
        attachAllGrayCurveRows();
      }).observe(grayCurvePointsEditor.container, { childList: true, subtree: true });
    }

    // LED-Mittelwert mit Nachkommastellen (Fork-Erweiterung), Ebene "color"
    attachInfoIcon('root.color.fractionalMean', 'edt_conf_color_fractionalMean_expl');

  })(editor_color);

  // Fork-Erweiterung: Graph der Graukurve über der Punkte-Liste jedes
  // Farbprofils (js/graycurve-graph.js). Oben steht, was die LEDs bei jedem
  // Grau des Bildes bekommen, unten die Faktoren; Ziehen, Hinzufügen und
  // Löschen schreiben die Punkte in den Editor, wirksam nach "Speichern".
  // Nur im Experten-Modus, wie die Graukurve selbst.
  (function addGrayCurveGraphs(editor) {
    if (typeof GrayCurveGraph === 'undefined') return;
    var text = {};
    ['all', 'red', 'green', 'blue', 'log', 'linear', 'input', 'output', 'factor', 'point', 'remove', 'off', 'hint', 'blackThreshold', 'withoutCurve'].forEach(function (key) {
      var i18nKey = 'edt_conf_color_grayCurve_graph_' + key;
      var value = $.i18n(i18nKey);
      if (value && value !== i18nKey) text[key] = value;
    });
    var adjustments = editor.getEditor('root.color.channelAdjustment');
    var count = adjustments && adjustments.rows ? adjustments.rows.length : 0;
    for (var i = 0; i < count; i++) {
      (function (base) {
        var entryEditor = editor.getEditor(base);
        var pointsEditor = editor.getEditor(base + '.grayCurve.points');
        if (!entryEditor || !pointsEditor || !pointsEditor.container) return;
        var holder = $('<div>').css({ margin: '6px 0 14px' })[0];
        $(pointsEditor.container).before(holder);
        var graph = GrayCurveGraph.create(holder, {
          text: text,
          onChange: function (points, final) {
            // das Array neu setzen baut die Zeilen neu auf, daher erst beim Loslassen
            if (final) pointsEditor.setValue(points);
          }
        });
        var refresh = function () {
          var device = window.serverConfig && window.serverConfig.device;
          graph.update({
            entry: entryEditor.getValue(),
            blackThreshold: device ? device.blackThreshold : null,
            writable: !window.readOnlyMode
          });
        };
        editor.on('change', refresh);
        refresh();

        // Die Punkte lassen sich auch im Graphen bearbeiten, daher ist ihre Liste einklappbar
        // (Klick auf die Überschrift, Zustand für alle Profile gespeichert, Standard: zu)
        var title = pointsEditor.title;
        var panel = pointsEditor.panel;
        if (title && panel) {
          var storedOpen = function () {
            try { return localStorage.getItem('grayCurvePointsOpen') === '1'; } catch (e) { return false; }
          };
          var count = $('<span class="gc-points-count">')[0];
          var chevron = $('<i class="fa fa-chevron-down gc-points-chevron" aria-hidden="true"></i>')[0];
          title.classList.add('gc-points-title');
          title.insertBefore(chevron, title.firstChild);
          $(title).children('span').first().after(count);
          var show = function (open) {
            panel.style.display = open ? '' : 'none';
            title.classList.toggle('gc-points-folded', !open);
            title.setAttribute('aria-expanded', String(open));
          };
          var updateCount = function () {
            var value = pointsEditor.getValue();
            count.textContent = Array.isArray(value) ? ' (' + value.length + ')' : '';
          };
          title.setAttribute('role', 'button');
          title.tabIndex = 0;
          var toggle = function (ev) {
            if (ev.target.closest('.info-icon, button')) return;
            var open = title.classList.contains('gc-points-folded');
            try { localStorage.setItem('grayCurvePointsOpen', open ? '1' : '0'); } catch (e) { }
            $('.gc-points-title').each(function () { $(this).trigger('gcPointsShow', [open]); });
          };
          $(title).on('gcPointsShow', function (ev, open) { show(open); });
          title.addEventListener('click', toggle);
          title.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); }
          });
          editor.on('change', updateCount);
          updateCount();
          show(storedOpen());
        }
      })('root.color.channelAdjustment.' + i);
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
        infoIcons.add(fieldEditor.label, explText); // Fork: gemeinsames (i)-Symbol mit Blase (ui_utils.js)
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
    // TV test page (tvtest service on the same host, see testPageBase): /tv on the TV, / is the phone/PC control page
    var testPageLink = function (path) {
      return '<a href="' + testPageBase() + path + '" target="_blank" rel="noopener">' + testPageBase() + path + '</a>';
    };
    createHint("intro", $.i18n('conf_colors_color_intro') + '<br><br>' + $.i18n('conf_colors_color_testpage', testPageLink("/tv"), testPageLink("/")), "editor_container_color");
    createHint("intro", $.i18n('conf_colors_smoothing_intro'), "editor_container_smoothing");
    if (BORDERDETECT_ENABLED) {
      createHint("intro", $.i18n('conf_colors_blackborder_intro'), "editor_container_blackborder");
    }
  }

  removeOverlay();
});
