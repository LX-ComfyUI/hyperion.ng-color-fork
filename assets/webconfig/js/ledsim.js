// Fork-Erweiterung: Gijgo rechnet die Lage eines festen (position: fixed) Fensters über offsetParent; Firefox
// liefert dort <body> und Gijgo zieht dann bei jedem Mausschritt die Scrollhöhe ab: nach dem Scrollen sprang
// das Fenster beim Verschieben aus dem Bild. Feste Elemente stehen einfach dort, wo sie im Fenster sind.
if (typeof gj !== "undefined" && gj.core && gj.core.position) {
  var gjPosition = gj.core.position;
  gj.core.position = function (el) {
    if (el && el.nodeType === 1 && getComputedStyle(el).position === "fixed") {
      var r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
    }
    return gjPosition(el);
  };
}

$(document).ready(function () {
  var modalOpened = false;
  var ledsim_width = 540;
  var ledsim_height = 489;
  var dialog;
  var leds;
  var grabberConfig;
  var lC = false;
  var imageCanvasNodeCtx = document.getElementById("image_preview_canv").getContext("2d", { willReadFrequently: false});
  var ledsCanvasNodeCtx = document.getElementById("leds_preview_canv").getContext("2d", { willReadFrequently: false});
  var sigDetectAreaCanvasNodeCtx = document.getElementById("grab_preview_canv").getContext("2d", { willReadFrequently: false});
  var canvas_height;
  var canvas_width;
  var twoDPaths = [];
  var toggleLeds = true;
  var toggleLedsNum = false;
  var toggleSigDetectArea = false;

  var activeComponent = "";

  const image = new Image();
  image.src = "img/hyperion/logo_negativ.png";

  /// add prototype for simple canvas clear() method
  CanvasRenderingContext2D.prototype.clear = function () {
    this.clearRect(0, 0, this.canvas.width, this.canvas.height)
  };

  function create2dPaths() {
    twoDPaths = [];
    for (const element of leds) {
      var led = element;
      twoDPaths.push(build2DPath(led.hmin * canvas_width, led.vmin * canvas_height, (led.hmax - led.hmin) * canvas_width, (led.vmax - led.vmin) * canvas_height, 5));
    }
  }

  /**
   * Draws a rounded rectangle into a new Path2D object, returns the created path.
   * If you omit the last three params, it will draw a rectangle
   * outline with a 5 pixel border radius
   * @param {Number} x The top left x coordinate
   * @param {Number} y The top left y coordinate
   * @param {Number} width The width of the rectangle
   * @param {Number} height The height of the rectangle
   * @param {Number} [radius = 5] The corner radius; It can also be an object
   *                 to specify different radii for corners
   * @param {Number} [radius.tl = 0] Top left
   * @param {Number} [radius.tr = 0] Top right
   * @param {Number} [radius.br = 0] Bottom right
   * @param {Number} [radius.bl = 0] Bottom left
   * @return {Path2D} The final path
   */
  function build2DPath(x, y, width, height, radius) {
    if (typeof radius == 'number') {
      radius = { tl: radius, tr: radius, br: radius, bl: radius };
    } else {
      var defaultRadius = { tl: 0, tr: 0, br: 0, bl: 0 };
      for (var side in defaultRadius) {
        radius[side] = radius[side] || defaultRadius[side];
      }
    }

    var path = new Path2D();

    path.moveTo(x + radius.tl, y);
    path.lineTo(x + width - radius.tr, y);
    path.quadraticCurveTo(x + width, y, x + width, y + radius.tr);
    path.lineTo(x + width, y + height - radius.br);
    path.quadraticCurveTo(x + width, y + height, x + width - radius.br, y + height);
    path.lineTo(x + radius.bl, y + height);
    path.quadraticCurveTo(x, y + height, x, y + height - radius.bl);
    path.lineTo(x, y + radius.tl);
    path.quadraticCurveTo(x, y, x + radius.tl, y);

    return path;
  }

  $(window.hyperion).one("ready", function () {
    leds = window.serverConfig.leds;
    grabberConfig = window.serverConfig.grabberV4L2;

    // Fork-Erweiterung: kompakt wie die Grabber-Vorschau der TV-Testseite: startet klein unten links
    // (siehe "opened"), die Höhe folgt immer der Breite im Seitenverhältnis des Bildes (fitHeight)
    ledsim_width = 350;

    dialog = $("#ledsim_dialog").dialog({
      uiLibrary: 'bootstrap',
      resizable: true,
      modal: false,
      minWidth: 230,
      width: ledsim_width,
      minHeight: 100,
      closeOnEscape: true,
      autoOpen: false,
      title: $.i18n('main_ledsim_title'),
      resize: function (e) {
        fitHeight();
        updateLedLayout();
      },
      opened: function (e) {

        // Fork-Erweiterung: kein Titeltext, Knöpfe nur als Symbol mit Namen beim Darüberfahren, Start klein unten links
        $(this).get(0).querySelector(".modal-title").textContent = "";
        $("#ledsim_dialog [data-role=footer] .btn").each(function () {
          var label = $(this).children("span").text();
          this.dataset.tip = label;
          this.setAttribute("aria-label", label);
        });
        $("#ledsim_dialog").css({ width: ledsim_width + "px", left: "10px", right: "auto", bottom: "auto" });
        fitHeight();
        $("#ledsim_dialog").css({ top: Math.max(10, globalThis.innerHeight - $("#ledsim_dialog").outerHeight() - 10) + "px" });
        lC = false;

        if (!lC) {
          updateLedLayout();
          lC = true;
        }
        modalOpened = true;

        setClassByBool('#leds_toggle', toggleLeds, "btn-danger", "btn-success");
        if ($('#leds_toggle').hasClass('btn-success'))
          requestLedColorsStart();

        setClassByBool('#leds_toggle_live_video', window.imageStreamActive, "btn-danger", "btn-success");
        if ($('#leds_toggle_live_video').hasClass('btn-success'))
          requestLedImageStart();
      },
      closed: function (e) {
        modalOpened = false;
        lC = false;
      },
      resizeStop: function (e) {
        fitHeight();
        resizeFromTop = false;
        fitHeight(true);
        updateLedLayout();
      }
    });
    $("#ledsim_dialog").on("pointerdown mousedown touchstart", ".gj-resizable-handle", function () {
      // oberer Griff oder Fenster unten am Rand (Startlage): die Unterkante bleibt stehen, es wächst nach oben
      resizeBottom = this.parentElement.getBoundingClientRect().bottom;
      resizeFromTop = /gj-resizable-n/.test(this.className) || resizeBottom > globalThis.innerHeight - 40;
    });
    // apply new configuration
    $(window.hyperion).on("serverConfig_updated", function (event) {
      grabberConfig = window.serverConfig?.grabberV4L2 ?? {};
      leds = window.serverConfig?.leds;

      if (Array.isArray(leds) && leds.length > 0) {
        updateLedLayout();
      } else {
        console.warn("LED configuration is missing or empty. Skipping updateLedLayout.");
      }
    });
  });

  function printLedsToCanvas(colors) {

    if (grabberConfig.enable && grabberConfig.signalDetection && toggleSigDetectArea && storedAccess === 'expert') {

      sigDetectAreaCanvasNodeCtx.setLineDash([5, 5]);
      sigDetectAreaCanvasNodeCtx.stroke(build2DPath(grabberConfig.sDHOffsetMin * canvas_width,
        grabberConfig.sDVOffsetMin * canvas_height,
        (grabberConfig.sDHOffsetMax - grabberConfig.sDHOffsetMin) * canvas_width,
        (grabberConfig.sDVOffsetMax - grabberConfig.sDVOffsetMin) * canvas_height,
        5));
    }

    // toggle leds, do not print
    if (!toggleLeds)
      return;

    var useColor = false;
    var cPos = 0;
    ledsCanvasNodeCtx.clear();
    if (typeof colors != "undefined")
      useColor = true;

    // check size of ledcolors with leds length
    if (colors && colors.length / 3 < leds.length)
      return;

    for (var idx = 0; idx < leds.length; idx++) {
      var led = leds[idx];
      // can be used as fallback when Path2D is not available
      //roundRect(ledsCanvasNodeCtx, led.hmin * canvas_width, led.vmin * canvas_height, (led.hmax-led.hmin) * canvas_width, (led.vmax-led.vmin) * canvas_height, 4, true, colors[idx])
      //ledsCanvasNodeCtx.fillRect(led.hmin * canvas_width, led.vmin * canvas_height, (led.hmax-led.hmin) * canvas_width, (led.vmax-led.vmin) * canvas_height);

      ledsCanvasNodeCtx.fillStyle = (useColor) ? "rgba(" + colors[cPos] + "," + colors[cPos + 1] + "," + colors[cPos + 2] + ",1.0)" : "hsla(" + (idx * 360 / leds.length) + ",100%,50%,1.0)";
      ledsCanvasNodeCtx.fill(twoDPaths[idx]);
      ledsCanvasNodeCtx.strokeStyle = '#323232';
      ledsCanvasNodeCtx.stroke(twoDPaths[idx]);

      if (toggleLedsNum) {
        ledsCanvasNodeCtx.fillStyle = "white";
        ledsCanvasNodeCtx.textAlign = "center";
        ledsCanvasNodeCtx.fillText(((led.name) ? led.name : idx), (led.hmin * canvas_width) + (((led.hmax - led.hmin) * canvas_width) / 2), (led.vmin * canvas_height) + (((led.vmax - led.vmin) * canvas_height) / 2));
      }

      // increment colorsPosition
      cPos += 3;
    }
  }

  // Fork-Erweiterung: Höhe des Fensters aus der Breite: Bild im Seitenverhältnis des Grabber-Bildes
  // (16:9 bis das erste Bild da ist), darüber die schmale Kopfzeile, darunter die Knöpfe. Breiter als
  // das Browserfenster geht es nicht.
  var imageAspect = 9 / 16;
  var glowCanvas = document.createElement("canvas");
  var glowAt = 0;
  var resizeFromTop = false;
  var resizeBottom = 0;
  function fitHeight(keepInWindow) {
    var dlg = $("#ledsim_dialog");
    var maxWidth = globalThis.innerWidth - 20;
    if (dlg.outerWidth() > maxWidth) dlg.css("width", maxWidth + "px");
    var body = dlg.children("[data-role=body]");
    var width = body.width();
    var height = Math.round(width * imageAspect);
    var chrome = dlg.children("[data-role=header]").outerHeight() + dlg.children("[data-role=footer]").outerHeight() + dlg.outerHeight() - dlg.innerHeight();
    // höher als das Browserfenster geht es auch nicht: dann wird die Breite passend kleiner
    var maxHeight = globalThis.innerHeight - 20 - chrome;
    if (height > maxHeight) {
      var sides = dlg.outerWidth() - width;
      height = Math.max(50, maxHeight);
      width = Math.round(height / imageAspect);
      dlg.css("width", (width + sides) + "px");
    }
    body.css("height", height + "px");
    var total = chrome + height;
    dlg.css("height", total + "px");
    // beim Ziehen an einem oberen Griff bleibt die Unterkante stehen; sonst die Oberkante. Nur beim
    // Öffnen und bei neuem Seitenverhältnis wird das Fenster ins Bild geschoben (beim Ziehen würde das
    // Verschieben die Rechnung von Gijgo aufschaukeln)
    if (resizeFromTop && resizeBottom) dlg.css("top", Math.max(0, resizeBottom - total) + "px");
    if (keepInWindow) {
      var top = dlg[0].getBoundingClientRect().top;
      dlg.css("top", Math.max(0, Math.min(top, globalThis.innerHeight - total - 10)) + "px");
    }
  }

  function updateLedLayout() {
    if (grabberConfig.enable && grabberConfig.signalDetection && storedAccess === 'expert') {
      $("#sigDetectArea_toggle").show();
    } else {
      $("#sigDetectArea_toggle").hide();
    }

    //calculate body size
    // Fork-Erweiterung: das Bild füllt den Inhaltsbereich, dessen Höhe fitHeight() setzt
    canvas_width = Math.round($('#ledsim_dialog > [data-role=body]').width());
    canvas_height = Math.round(canvas_width * imageAspect);

    $("[id$=_preview_canv]").prop({ "width": canvas_width, "height": canvas_height });
    $('#leds_canvas').css("--width-var", canvas_width + "px");
    $('#leds_canvas').css("--height-var", canvas_height + "px");

    create2dPaths();
    printLedsToCanvas();
    $('#leds_canvas').css("--background-var", "none");
    resetImage();
  }

  // ------------------------------------------------------------------
  $('#leds_toggle_num').off().on("click", function () {
    toggleLedsNum = !toggleLedsNum
    toggleClass('#leds_toggle_num', "btn-danger", "btn-success");
  });
  // ------------------------------------------------------------------

  $('#leds_toggle').off().on("click", function () {
    toggleLeds = !toggleLeds

    if (window.ledStreamActive) {
      requestLedColorsStop();
      ledsCanvasNodeCtx.clear();
      $('#leds_canvas').css("--background-var", "none");
    } else {
      requestLedColorsStart();
    }
    toggleClass('#leds_toggle', "btn-success", "btn-danger");

    if (toggleLeds) {
      $("#leds_toggle_num").show();
    } else {
      $("#leds_toggle_num").hide();
    }
  });

  // ------------------------------------------------------------------
  $('#leds_toggle_live_video').off().on("click", function () {
    setClassByBool('#leds_toggle_live_video', window.imageStreamActive, "btn-success", "btn-danger");
    if (window.imageStreamActive) {
      $('#leds_prev_toggle_live_video').trigger('click');
      requestLedImageStop();
      resetImage();
    }
    else {
      requestLedImageStart();
    }
  });

  $('#sigDetectArea_toggle').off().on("click", function () {
    toggleSigDetectArea = !toggleSigDetectArea
    sigDetectAreaCanvasNodeCtx.clear();
    toggleClass('#sigDetectArea_toggle', "btn-success", "btn-danger");
  });

  // ------------------------------------------------------------------
  $(window.hyperion).on("cmd-ledcolors-ledstream-update", function (event) {
    if (!modalOpened) {
      requestLedColorsStop();
      $('#leds_canvas').css("--background-var", "none");
    }
    else {
      printLedsToCanvas(event.response.data.leds)
      // Fork-Erweiterung: der unscharfe Schein hinter dem Bild kam aus einem PNG der ganzen LED-Leinwand bei
      // jedem LED-Bild (bis 100/s); bei großem Fenster legte das den Browser lahm. Jetzt aus einer kleinen
      // Kopie und höchstens 10-mal pro Sekunde, wegen der Unschärfe sieht er gleich aus.
      var now = Date.now();
      if (now - glowAt >= 100) {
        glowAt = now;
        var src = $('#leds_preview_canv')[0];
        if (src.width > 0 && src.height > 0) {
          glowCanvas.width = 160;
          glowCanvas.height = Math.max(1, Math.round(160 * src.height / src.width));
          glowCanvas.getContext("2d").drawImage(src, 0, 0, glowCanvas.width, glowCanvas.height);
          $('#leds_canvas').css("--background-var", "url(" + glowCanvas.toDataURL("image/png") + ") no-repeat top left");
          // Safari workaround (redraw canvas)
          $('#leds_canvas').parent().hide().show(0);
        }
      }
    }
  });

  // ------------------------------------------------------------------
  $(window.hyperion).on("cmd-ledcolors-imagestream-update", function (event) {
    setClassByBool('#leds_toggle_live_video', window.imageStreamActive, "btn-danger", "btn-success");
    if (!modalOpened) {
      if (!$('#leds_prev_toggle_live_video').hasClass("btn-success")) {
        requestLedImageStop();
      }
    }
    else {
      var imageData = (event.response.data.image);

      var image = new Image();
      image.onload = function () {
        // Fork-Erweiterung: Seitenverhältnis vom Grabber-Bild übernehmen (z. B. 4:3-Quelle)
        var aspect = image.height / image.width;
        if (image.width > 0 && Math.abs(aspect - imageAspect) > 0.005) {
          imageAspect = aspect;
          resizeFromTop = false;
          fitHeight(true);
          updateLedLayout();
        }
        imageCanvasNodeCtx.drawImage(image, 0, 0, canvas_width, canvas_height);
      };
      image.src = imageData;
    }
  });

  $("#btn_open_ledsim").off().on("click", function (event) {
    dialog.open();
  });

  // ------------------------------------------------------------------
  $(window.hyperion).on("cmd-settings-update", function (event) {

    var obj = event.response.data
    if (obj.leds || obj.grabberV4L2) {
      Object.getOwnPropertyNames(obj).forEach(function (val, idx, array) {
        window.serverInfo[val] = obj[val];
      });
      leds = window.serverConfig.leds;
      grabberConfig = window.serverConfig.grabberV4L2;
      updateLedLayout();
    }
  });

  $(window.hyperion).on("cmd-priorities-update", function (event) {
    var prios = event.response.data.priorities;
    if (prios.length > 0) {
      //Clear image when new input
      if (prios[0].componentId !== activeComponent) {
        resetImage();
        activeComponent = prios[0].componentId;
      }
      else if (!prios[0].active) {
        resetImage();
      }
    }
    else {
      resetImage();
    }

  });

  $(window.hyperion).on("cmd-instance-switchTo", function (event) {
    if (modalOpened) {
      if (!isCurrentInstanceRunning()) {
        dialog.close();
        return;
      }

      const titleText = $.i18n('main_ledsim_title') + " - " + getCurrentInstanceName();
      // Update the title inside the Gijgo modal dialog
      $("#ledsim_dialog").find(".modal-title").text(titleText);
    }
  });

  function resetImage() {
    if (typeof imageCanvasNodeCtx !== "undefined") {

      imageCanvasNodeCtx.fillStyle = "#1c1c1c"; //90% gray
      imageCanvasNodeCtx.fillRect(0, 0, canvas_width, canvas_height);
      var destImageWidth = image.width;
      var destImageHeight = image.height;
      if (destImageWidth + 40 >= canvas_width) {
        destImageWidth = image.width * (canvas_width - 40) / image.width;
        destImageHeight = image.height * (canvas_width - 40) / image.width;
      }
      imageCanvasNodeCtx.drawImage(image, 0, 0, image.width - 31, image.height, canvas_width / 2 - destImageWidth / 2, canvas_height / 2 - destImageHeight / 2, destImageWidth, destImageHeight);
    }
  }
});

