$(document).ready(() => {
  initializeApp();
});

$(window.hyperion).on("ready", function (event) {

  loadContent(undefined, true);

  // Hide capture menu entries if no grabbers are available
  if ((window.serverInfo.grabbers.screen.available.length === 0) &&
    (window.serverInfo.grabbers.video.available.length === 0) &&
    (window.serverInfo.grabbers.audio.available.length === 0)) {
    $("#MenuItemGrabber").hide();
    if ((jQuery.inArray("boblight", window.serverInfo.services) === -1)) {
      $("#MenuItemInstCapture").hide();
    }
  }

  // Hide effects config menu entry if effect engine is not available
  if (jQuery.inArray("effectengine", window.serverInfo.services) === -1) {
    $("#MenuItemEffectsConfig").hide();
  }

  $("#main-nav, #top-navbar").show();
  if (!window.defaultPasswordIsSet) {
    $("#btn_lock_ui").show();
  }
});

$(window.hyperion).on("error", function (event) {
  const error = event.reason;

  //An error "No Authorization" is handled by waitForSuccessfulAuthorization
  if (error?.message !== "No Authorization") {

    const errorDetails = [];

    if (error?.cmd) {
      errorDetails.push(`Command: "${error.cmd}"`);
    }

    errorDetails.push(error?.details || "No additional details.");

    showInfoDialog("error", "", error?.message || "Unknown error", errorDetails);
  }
});

$(window.hyperion).on("cmd-authorize-tokenRequest cmd-authorize-getPendingTokenRequests", function (event) {

  if (event.response && event.response.info !== undefined) {
    // Fork-Fix: wartende Anfragen (WebUI erst nach der Anfrage geöffnet, getPendingTokenRequests) kommen
    // als Liste. Vorher wurde die Liste selbst als Anfrage genommen: „App: undefined, Code: undefined“,
    // und „Zugriff gewähren“ schickte keine ID, die Anfrage blieb offen.
    const val = Array.isArray(event.response.info) ? event.response.info[0] : event.response.info;
    if (!val) {
      return;
    }
    if (val.comment == '') {
      $('#modal_dialog').modal('hide');
    }

    showInfoDialog("grantToken", $.i18n('conf_network_tok_grantT'), $.i18n('conf_network_tok_grantMsg') + '<br><span style="font-weight:bold">App: ' + val.comment + '</span><br><span style="font-weight:bold">Code: ' + val.id + '</span>')

    $("#tok_grant_acc").off().on('click', function () {
      addToTokenList(val);

      // forward event, in case we need to rebuild the list now
      $(window.hyperion).trigger({ type: "build-token-list" });
      requestHandleTokenRequest(val.id, true)
    });
    $("#tok_deny_acc").off().on('click', function () {
      requestHandleTokenRequest(val.id, false)
    });
  }
});

$(window.hyperion).one("cmd-authorize-getTokenList", function (event) {
  setTokenList(event.response.info);
});

$(window.hyperion).on("cmd-authorize-newPassword", async function (event) {

  if (event.response.success === true) {
    showInfoDialog("success", $.i18n('InfoDialog_changePassword_success'));
 
    try {
      // Force login with new passwort
      await waitForSuccessfulAuthorization();
      $(window.hyperion).trigger("ready");
    } catch (err) {
      console.error("Authorization failed for new password:", err);
    }
  }
});

$(window.hyperion).on("cmd-adjustment-update", function (event) {
  window.serverInfo.adjustment = event.response.data
});

$(window.hyperion).on("cmd-videomode-update", function (event) {
  window.serverInfo.videomode = event.response.data.videomode
});

$(window.hyperion).on("cmd-components-update", function (event) {
  let obj = event.response.data

  // notfication in index
  if (obj.name == "ALL") {
    if (obj.enabled)
      $("#hyperion_disabled_notify").fadeOut("fast");
    else
      $("#hyperion_disabled_notify").fadeIn("fast");
  }

  window.comps.forEach((entry, index) => {
    if (entry.name === obj.name) {
      window.comps[index] = obj;
    }
  });
  // notify the update
  $(window.hyperion).trigger("components-updated", event.response.data);
});

$(window.hyperion).on("cmd-instance-update", function (event) {

  const isInstanceRunningBeforeUpdate = isCurrentInstanceRunning();

  window.serverInfo.instance = event.response.data;

  // notify the update
  $(window.hyperion).trigger("instance-updated");

  if (!isCurrentInstanceRunning()) {
    let newInstance = getFirstRunningInstance();
    if (newInstance === null) {

      const lastSelectedInstance = getStorage('lastSelectedInstance');

      if (doesInstanceExist(lastSelectedInstance)) {

        newInstance = lastSelectedInstance;
      } else {
        newInstance = getFirstConfiguredInstance();
        //Delete Storage information about the last used but now stopped instance
        removeStorage('lastSelectedInstance');
      }
    }

    if (newInstance !== null) {
      instanceSwitch(newInstance);
    } else {
      debugMessage("No instance is configured.");
      window.currentHyperionInstance = null;
      updateUiOnInstance(window.currentHyperionInstance);
    }
  } else if (!isInstanceRunningBeforeUpdate) {
    if (window.currentHyperionInstance !== null) {
      requestServerInfo(window.currentHyperionInstance);
    }
  }

  updateHyperionInstanceListing();
});

$(window.hyperion).on("cmd-instance-switchTo", function (event) {
  const newInstance = window.currentHyperionInstance;

  if (typeof newInstance === "number" && !isNaN(newInstance)) {
    getServerInformation(newInstance);
  } else {
    console.warn("Invalid instance ID during switch");
  }
});

$(window.hyperion).on("cmd-effects-update", function (event) {
  window.serverInfo.effects = event.response.data.effects
});

function waitForSuccessfulAuthorization() {
  return new Promise((resolve, reject) => {
    let loginResolved = false;

    const onLogin = (event) => {
      if (!loginResolved) {
        loginResolved = true;
        $(window.hyperion).off("cmd-authorize-login", onLogin);
        resolve(event);
      }
    };

    const onPwRequired = async (event) => {
      try {
        await handlePasswordRequirement(event);
      } catch (err) {
        reject(err);
      }
    };

    const onError = (event) => {
      const error = event.reason;
      if (error?.message === "No Authorization" && getStorage("loginToken")) {
        removeStorage("loginToken");
        requestRequiresDefaultPasswortChange(); // Retry trigger
      }
    };

    $(window.hyperion).on("cmd-authorize-login", onLogin);
    $(window.hyperion).on("cmd-authorize-newPasswordRequired", onPwRequired);
    $(window.hyperion).on("error", onError);

    // Kick off the process (non-async call)
    requestRequiresDefaultPasswortChange();
  });
}

async function initializeApp() {
  try {
    setupDarkMode();
    setMediaStreamingSupport();
    await loadEssentialContent();

    // Ensure WebSocket is initialized and open
    initWebSocket();
    await waitForEvent("open"); // Wait for the WebSocket "open" event to confirm the connection

    // Run authorization flow and wait for login success
    await waitForSuccessfulAuthorization();

    // Run following calls in parallel
    await Promise.all([
      requestTokenInfo(),
      requestGetPendingTokenRequests(),
      requestServerConfigSchema(),
      requestSysInfo()
    ]);

    //Get configuration schemas
    const schemaEvent = await waitForEvent("cmd-config-getschema");
    await handleSchema(schemaEvent);

    // Once getschema is complete, we can proceed with getServerInformation
    const instance = getStoredInstance();
    await getServerInformation(instance);

    await waitForEvent("cmd-serverinfo-getInfo");
    // cmd-serverinfo-getInfo will trigger hyperion - ready

    bindUiHandlers();
  }
  catch (err) {
    console.error("App initialization failed:", err);
    showInfoDialog("error", "UI startup failed", err.message || err);
  }
}

function setupDarkMode() {
  applyTheme(themeMode());
}

function setMediaStreamingSupport() {
  const isMediaStreamingSupported = !!(navigator.mediaDevices?.getDisplayMedia);
  setStorage('mediaStreamingSupported', isMediaStreamingSupported);
}

async function loadEssentialContent() {
  loadContentTo("#container_connection_lost", "connection_lost");
  loadContentTo("#container_forbidden", "forbidden");  
  loadContentTo("#container_restart", "restart");
}

async function handlePasswordRequirement(event) {
  const token = getStorage("loginToken");

  if (event.response.info.newPasswordRequired) {
    window.defaultPasswordIsSet = true;

    if (token) {
      requestTokenAuthorization(token);
    } else {
      requestAuthorization('hyperion');
    }

    const loginEvent = await waitForEvent("cmd-authorize-login");
    handleLogin(loginEvent, token !== null);
  } else {
    $("#main-nav, #top-navbar").hide();

    if (token) {
      requestTokenAuthorization(token);

      const loginEvent = await waitForEvent("cmd-authorize-login");
      handleLogin(loginEvent, true);
    } else {
      loadContentTo("#page-content", "login");
    }
  }
}

function handleLogin(event, isLoggedIn = false) {
  if (isLoggedIn && window.defaultPasswordIsSet && getStorage("suppressDefaultPwWarning") !== "true") {
    const msg = `
      <div class="text-right">
        ${$.i18n('dashboard_message_do_not_show_again')}
        <input id="chk_suppressDefaultPw" type="checkbox" onChange="suppressDefaultPwWarning()">
      </div>`;

    showNotification(
      'warning',
      $.i18n('dashboard_message_default_password'),
      $.i18n('dashboard_message_default_password_t'),
      `<a style="cursor:pointer" onClick="changePassword()">
        ${$.i18n('InfoDialog_changePassword_title')}
      </a>` + msg
    );
  } else {
    $("#btn_lock_ui").hide();
  }

  if (event.response?.info?.token) {
    setStorage("loginToken", event.response.info.token);
  }
}


async function handleSchema(event) {
  window.serverSchema = event.response.info;
  window.schema = window.serverSchema.properties;
}

function getStoredInstance() {
  const stored = getStorage('lastSelectedInstance');
  return (stored !== null && !isNaN(Number(stored))) ? Number(stored) : null;
}

async function getServerInformation(instance) {

  try {
    // Step 1: Start waiting for the config-getconfig event before sending the request
    const configEventPromise = new Promise((resolve) => {
      const handler = function (event) {
        $(window.hyperion).off("cmd-config-getconfig", handler);
        resolve(event);
      };
      $(window.hyperion).on("cmd-config-getconfig", handler);
    });

    // Step 2: Send config request
    const configResponsePromise = requestServerConfig.async([], [instance], []);

    // Step 3: Wait for both response and event
    const [, configEvent] = await Promise.all([
      configResponsePromise,
      configEventPromise
    ]);

    const config = configEvent.response.info;
    let instanceId = instance;
    const { instanceIds, instances } = config;

    // Step 4: Validate instance
    if (!instanceIds.includes(instance)) {
      // Choose a fallback: enabled instance or first
      const fallback = instances.find((inst) => inst.enabled)?.id || instanceIds[0];
      if (fallback !== undefined) {
        instanceId = fallback;
        window.currentHyperionInstance = fallback;
        setStorage('lastSelectedInstance', fallback);
      } else {
        console.warn("No valid instance found");
        window.currentHyperionInstance = null;
        instanceId = [];
      }
    } else {
      window.currentHyperionInstance = instance;
    }

    // Step 5: Update server config for the (corrected) instance
    const legacyConfig = reverseTransformConfig(config, instanceId);
    window.serverConfig = legacyConfig;
    window.showOptHelp = window.serverConfig.general?.showOptHelp;
    $(window.hyperion).trigger("serverConfig_updated");

    // Step 6: Load additional info
    requestServerInfo(instanceId);

  } catch (error) {
    console.error("Error in getServerInformation:", error);
  }
}

$(window.hyperion).on("cmd-serverinfo-getInfo", function (event) {

  window.serverInfo = event.response.info;

  // comps
  window.comps = event.response.info.components

  $(window.hyperion).trigger("ready");

  window.comps.forEach(function (obj) {
    if (obj.name == "ALL") {
      if (obj.enabled)
        $("#hyperion_disabled_notify").fadeOut("fast");
      else
        $("#hyperion_disabled_notify").fadeIn("fast");
    }
  });

  // determine button visibility
  const running = window.serverInfo.instance.filter(entry => entry.running);
  if (running.length > 1) {
    $('#btn_hypinstanceswitch').toggle(true)
  } else {
    $('#btn_hypinstanceswitch').toggle(false)
  }
}); // end cmd-serverinfo

$(window.hyperion).on("cmd-sysinfo", function (event) {
  window.sysInfo = event.response.info;

  window.currentVersion = window.sysInfo.hyperion.version;
  window.currentChannel = window.sysInfo.hyperion.channel;
  window.readOnlyMode = window.sysInfo.hyperion.readOnlyMode;
});

$(window.hyperion).on("cmd-config-setconfig", function (event) {
  if (event.response.success === true) {
    showNotification('success', $.i18n('dashboard_alert_message_confsave_success'), $.i18n('dashboard_alert_message_confsave_success_t'))
  }
});

function bindUiHandlers() {

  // Handle language selection
  $(".bootstrap-select").on("click", function (e) {
    e.stopPropagation();
    $(this).toggleClass("open");
  });

  $('#language-select').on('changed.bs.select', function () {
    const newLang = $(this).val();
    if (newLang !== storedLang) {
      setStorage("langcode", newLang);
      location.reload();
    }
  });

  // Side menu link click activation
  $('#side-menu li a, #side-menu li ul li a').on("click", function () {
    $('#side-menu').find('.active').removeClass('active');
    $(this).addClass('active');
  });

  // Fork-Erweiterung: Darstellung wechselt reihum Auto -> Hell -> Dunkel
  $("#btn_darkmode").off().on("click", function () {
    const order = ["auto", "light", "dark"];
    applyTheme(order[(order.indexOf(themeMode()) + 1) % order.length]);
  });

  // Main navigation click handling
  document.querySelectorAll(".mnava").forEach(el => {
    el.addEventListener("click", function (e) {
      loadContent(e);
      window.scrollTo(0, 0);
    });
  });

  // Fork-Erweiterung: das Logo bleibt in der festen Kopfzeile sichtbar (früher beim Scrollen ausgeblendet)
  
}

function suppressDefaultPwWarning() {
  const checked = document.getElementById('chk_suppressDefaultPw').checked;
  setStorage("suppressDefaultPwWarning", String(checked));
}

// Menuitem toggle;
function SwitchToMenuItem(target, item) {
  document.getElementById(target).click(); // Get <a href menu item;
  let sidebar = $('#side-menu');  // Get sidebar menu;
  sidebar.find('.active').toggleClass('inactive'); // find all active classes and set inactive;
  sidebar.find('.in').removeClass("in"); // Find all collapsed menu items and close it by remove "in" class;
  $('#' + target).removeClass('inactive'); // Remove inactive state by classname;
  $('#' + target).addClass('active'); // Add active state by classname;
  let cl_object = $('#' + target).closest('ul'); // Find closest ul sidemenu header;
  cl_object.addClass('in'); // Add class "in" to expand header in sidebar menu;
  if (item) { // Jump to div "item" if available. Time limit 3 seconds
    function scrollTo(counter) {
      if (counter < 30) {
        setTimeout(function () {
          counter++;
          if ($('#' + item).length)
            $('#' + item)[0].scrollIntoView();
          else
            scrollTo(counter);
        }, 100);
      }
    }

    scrollTo(0);
  }
};

// Fork-Erweiterung: Glocke mit Meldungen. Zwei Quellen:
// 1. Ein Grabber liefert Bilder, für den es noch keinen Eintrag mit Farbkalibrierungen gibt (globale
//    Einstellung grabberTest.grabbers, siehe js/grabbertest-report.js). Welcher Grabber gerade Bilder
//    liefert, fragt der Fork-Befehl "grabbertest" mit "peek" ab, ohne eine Messung zu starten.
//    "Gesehen" legt den Eintrag ohne Kalibrierung an.
// 2. Die Meldungen des Testservers der TV-Testseite (Statuswechsel, Tests und Kalibrierungen fertig,
//    pausiert oder abgebrochen, Grabber, No Signal). Der Testserver läuft auf demselben Rechner (Port
//    webConfig.testPagePort, siehe testPageBase); ohne ihn bleibt die Glocke bei Quelle 1. Dieselben Meldungen zeigt die TV-Testseite.
// Die Auswahl rechts neben dem Titel (alle / nur kritische / stumm) gilt je Browser.
(function () {
  const POLL_MS = 15000;
  const TV_POLL_MS = 5000;
  const MODES = ['all', 'critical', 'off'];
  const MODE_ICONS = { all: 'fa-bell', critical: 'fa-exclamation-triangle', off: 'fa-bell-slash' };
  let device = null;
  let started = false;
  let tvNotes = [];
  let tvUp = false;
  let toasted = null; // höchste Nummer, die schon angekündigt (oder übersprungen) wurde

  const lang = () => (storedLang === 'de' ? 'de' : 'en');
  const esc = (s) => $('<div>').text(s).html();
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, String(value)); } catch (e) { /* ohne Speicher gilt der Standard */ } },
  };
  let mode = store.get('hy-notes-mode', 'all');
  if (!MODES.includes(mode)) mode = 'all';
  let seen = Number(store.get('hy-notes-seen', '-1'));

  // Adresse des Testservers; über https (Mixed Content) ist er nicht erreichbar
  const tvBase = () => (location.protocol === 'http:' ? testPageBase() : null);
  const shown = (n) => mode === 'all' || (mode === 'critical' && n.level === 'critical');
  const lastId = () => (tvNotes.length ? tvNotes[tvNotes.length - 1].id : 0);

  function timeText(ts) {
    const d = new Date(ts);
    const locale = lang() === 'de' ? 'de-DE' : 'en-GB';
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString(locale)
      : d.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  function render() {
    if (typeof GrabberTestReport === 'undefined') return;
    const grabberTest = (globalThis.serverConfig && globalThis.serverConfig.grabberTest) || {};
    const notes = mode === 'off' ? [] : GrabberTestReport.notifications(grabberTest, device, lang());
    const t = GrabberTestReport.make(lang()).t;
    const count = document.getElementById('nt_count');
    const menu = document.getElementById('nt_menu');
    if (!count || !menu) return;
    const fresh = notes.length + tvNotes.filter((n) => n.id > seen && shown(n)).length;
    count.textContent = String(fresh);
    count.style.display = fresh ? '' : 'none';
    const key = JSON.stringify([notes, tvNotes, mode, seen, tvUp]) + lang();
    if (menu.dataset.key === key) return;
    menu.dataset.key = key;
    const list = menu.querySelector('.nt-list');
    const scrollTop = list ? list.scrollTop : 0;
    const modeButtons = MODES.map((m) => '<button type="button" class="btn btn-default btn-xs' + (m === mode ? ' active' : '')
      + '" data-nt-mode="' + m + '" title="' + esc($.i18n('nt_mode_' + m)) + '"><i class="fa ' + MODE_ICONS[m] + '"></i></button>').join('');
    let html = '<li class="nt-head"><span>' + esc(t.ntTitle) + '</span><span class="nt-modes">' + modeButtons + '</span></li><li class="nt-listrow"><ul class="nt-list">';
    for (const n of notes) {
      html += '<li class="nt-item"><b>' + esc(n.title) + '</b><p>' + esc(n.text) + '</p><div class="nt-actions">'
        + '<a class="btn btn-default btn-sm" href="#conf_grabber" data-nt-goto>' + esc($.i18n('edt_conf_grabbertest_heading_title')) + '</a>'
        + '<button type="button" class="btn btn-primary btn-sm" data-nt-seen>' + esc(t.ntSeen) + '</button></div></li>';
    }
    const base = tvBase();
    for (const n of tvNotes.slice().reverse()) {
      html += '<li class="nt-item' + (n.level === 'critical' ? ' nt-crit' : '') + (n.id > seen ? ' nt-fresh' : '') + '"'
        + (n.target && base ? ' data-nt-open="' + esc(base + '/phone#' + n.target) + '"' : '') + '>'
        + '<time>' + esc(timeText(n.ts)) + '</time><b>' + esc(n.title) + '</b>' + (n.text ? '<p>' + esc(n.text) + '</p>' : '') + '</li>';
    }
    if (!notes.length && !tvNotes.length) {
      html += '<li class="nt-none">' + esc(t.ntNone) + '</li>';
    }
    html += '</ul></li>';
    if (tvNotes.length) {
      html += '<li class="nt-foot"><button type="button" class="btn btn-default btn-sm" data-nt-clear>' + esc($.i18n('nt_clear')) + '</button></li>';
    }
    menu.innerHTML = html;
    const newList = menu.querySelector('.nt-list');
    if (newList) newList.scrollTop = scrollTop;
    $(menu).find('[data-nt-seen]').on('click', function () {
      const current = globalThis.serverConfig.grabberTest || {};
      requestWriteConfig({ grabberTest: GrabberTestReport.applyOp(current, device, 'acknowledge', {}, lang()) });
      render();
    });
    // der Link lädt die Seite wie ein Eintrag im Seitenmenü (nativer Klick, den hört loadContent)
    $(menu).find('[data-nt-goto]').on('click', function (ev) {
      ev.preventDefault();
      const item = document.getElementById('MenuItemGrabber');
      if (item) item.click();
    });
    $(menu).find('[data-nt-mode]').on('click', function () {
      mode = this.getAttribute('data-nt-mode');
      store.set('hy-notes-mode', mode);
      render();
    });
    // ein Eintrag öffnet die zugehörige Karte der TV-Testseite
    $(menu).find('[data-nt-open]').on('click', function () {
      window.open(this.getAttribute('data-nt-open'), 'hyperion-tvtest');
    });
    $(menu).find('[data-nt-clear]').on('click', async function () {
      try {
        await fetch(base + '/api/notices', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tvtest': '1' }, body: JSON.stringify({ op: 'clear' }) });
        fetchTv();
      } catch (e) { /* Testserver nicht erreichbar */ }
    });
  }

  // Bedienelemente im Menü schließen es nicht; Öffnen zählt alles als gesehen
  $(document).on('click', '#nt_menu', function (ev) { ev.stopPropagation(); });
  $(document).on('shown.bs.dropdown', '#btn_notifications', function () {
    seen = lastId();
    store.set('hy-notes-seen', seen);
    render();
  });

  // Meldung unten rechts, wenn eine neue ankommt und die Auswahl es zulässt
  function announce() {
    if (toasted === null) { toasted = lastId(); return; }
    if (lastId() < toasted) toasted = lastId(); // Liste wurde geleert
    for (const n of tvNotes) {
      if (n.id <= toasted) continue;
      toasted = n.id;
      if (shown(n) && n.kind !== 'noSignal' && n.kind !== 'signalBack') {
        showNotification(n.level === 'critical' ? 'danger' : 'info', n.text, n.title);
      }
    }
  }

  async function fetchTv() {
    const base = tvBase();
    if (!base) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 3000);
    try {
      const res = await fetch(base + '/api/notices?lang=' + lang(), { cache: 'no-store', signal: abort.signal });
      if (!res.ok) throw new Error('status ' + res.status);
      const data = await res.json();
      tvNotes = data.notices || [];
      tvUp = true;
      if (seen < 0) { seen = lastId(); store.set('hy-notes-seen', seen); } // erster Besuch: ohne alte Meldungen
      announce();
    } catch (e) {
      tvUp = false;
    } finally {
      clearTimeout(timer);
    }
    $('.tp-only').toggle(tvUp);
    $('#btn_open_testpage > a').attr('href', base + '/phone');
    render();
  }

  async function poll() {
    try {
      const reply = await sendAsyncToHyperion('grabbertest', '', { peek: true });
      if (reply && reply.success && reply.info && reply.info.device) device = reply.info.device;
    } catch (e) {
      // ohne Verbindung bleibt der letzte Stand
    }
    render();
  }

  $(globalThis.hyperion).on('ready', function () {
    if (started) return;
    started = true;
    poll();
    setInterval(poll, POLL_MS);
    fetchTv();
    setInterval(fetchTv, TV_POLL_MS);
  });
  // Änderungen der Einstellung (Testseite, Grabber-Seite, Gesehen) wirken sofort
  $(globalThis.hyperion).on('cmd-settings-update', function (event) {
    const data = event.response && event.response.data;
    if (data && data.grabberTest && globalThis.serverConfig) {
      globalThis.serverConfig.grabberTest = data.grabberTest;
      render();
    }
  });
})();
