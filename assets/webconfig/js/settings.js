var availAccess = ['default', 'advanced', 'expert'];
var storedAccess;

//Change Password
function changePassword() {
  showInfoDialog('changePassword', $.i18n('InfoDialog_changePassword_title'));

  // fill default pw if default is set
  if (window.defaultPasswordIsSet)
    $('#current-password').val('hyperion')

  $('#id_btn_ok').off().on('click', function () {
    var oldPw = $('#current-password').val();
    var newPw = $('#new-password').val();

    requestChangePassword(oldPw, newPw);
    history.pushState({}, "New password");
  });

  $('#new-password, #current-password').off().on('input', function (e) {
    ($('#current-password').val().length >= 8 && $('#new-password').val().length >= 8) && !window.readOnlyMode ? $('#id_btn_ok').prop('disabled', false) : $('#id_btn_ok').prop('disabled', true);
  });
}

$(document).ready(function () {

  if (!storageComp()) {
    showInfoDialog('warning', "Can't store settings", "Your browser doesn't support localStorage. You can't save a specific language setting (fallback to 'auto detection') and access level (fallback to 'default'). Some wizards may be hidden. You could still use the webinterface without further issues");
    $('#language-select').prop("disabled", true);
    $('#btn_setaccess').prop("disabled", true);
  }

  initLanguageSelection();

  //access
  storedAccess = getStorage("accesslevel");
  if (storedAccess == null) {
    storedAccess = "default";
    setStorage("accesslevel", storedAccess);
  }

  if (!storageComp()) {
    showInfoDialog('warning', $.i18n('InfoDialog_nostorage_title'), $.i18n('InfoDialog_nostorage_text'));
    $('#btn_setlang').prop("disabled", true);
  }

  $('#btn_setaccess').off().on('click', function () {
    var newAccess;
    showInfoDialog('select', $.i18n('InfoDialog_access_title'), $.i18n('InfoDialog_access_text'));

    for (var lcx = 0; lcx < availAccess.length; lcx++) {
      $('#id_select').append(createSelOpt(availAccess[lcx], $.i18n('general_access_' + availAccess[lcx])));
    }

    $('#id_select').val(storedAccess);

    $('#id_select').off().on('change', function () {
      newAccess = $('#id_select').val();
      if (newAccess == storedAccess)
        $('#id_btn_saveset').prop('disabled', true);
      else
        $('#id_btn_saveset').prop('disabled', false);
    });

    $('#id_btn_saveset').off().on('click', function () {
      setStorage("accesslevel", newAccess);
      reload();
    });

    $('#id_select').trigger('change');
  });

  // change pw btn
  $('#btn_changePassword').off().on('click', function () {
    changePassword();
  });

  //Suspend Hyperion
  $('#btn_systemSuspend').off().on('click', function () {
    requestSystemSuspend();
  });

  //Resume Hyperion
  $('#btn_systemResume').off().on('click', function () {
    requestSystemResume();
  });

  //Restart Hyperion
  $('#btn_systemRestart').off().on('click', function () {
    requestSystemRestart();
  });

  // The restart is fast enough under systemd (Restart=on-failure) that the
  // passive connection-lost watchdog (needs ~9-12s of failed polling) never
  // trips. React to the server's own restart acknowledgement instead.
  $(window.hyperion).on("cmd-system-restart", function () {
    setTimeout(initRestart, 100);
  });

  //Reconnect grabber (USB): recovers a stuck/hanging capture grabber, no replug and no restart needed
  // Fork: only where Hyperion can reset it (sysinfo usbReset: Linux, grabber on USB, the right to
  // do it); otherwise greyed out with the reason. sysinfo is asked again when the menu opens.
  const usbResetPossible = function () { const u = window.sysInfo && window.sysInfo.usbReset; return !u || u.possible !== false; };
  const renderUsbReset = function () {
    const u = window.sysInfo && window.sysInfo.usbReset;
    $('#btn_systemUsbResetRestart').toggleClass('disabled', !usbResetPossible());
    const why = u && u.possible === false && u.whyKey ? $.i18n('power_usbreset_why_' + u.whyKey) : '';
    $('#power_usbreset_why').text(why).toggle(!!why);
  };
  $(window.hyperion).off('cmd-sysinfo.usbreset').on('cmd-sysinfo.usbreset', function () { setTimeout(renderUsbReset, 0); });
  $('a[data-tip-key="general_tip_power"]').parent().off('show.bs.dropdown.usbreset').on('show.bs.dropdown.usbreset', function () { requestSysInfo(); });
  renderUsbReset();
  $('#btn_systemUsbResetRestart').off().on('click', function () {
    if (!usbResetPossible()) return false;
    requestGrabberUsbReconnect();
  });

  // Hyperion keeps running; the bell of the test page reports the result
  $(window.hyperion).off('cmd-system-grabberUsbReconnect').on("cmd-system-grabberUsbReconnect", function () {
    showNotification('info', $.i18n('power_usbreset_started'));
  });

  // Fork-Erweiterung: Befehle der TV-Testseite im Power-Menü (Testserver, testPageBase, siehe Glocke in
  // content_index.js); die Einträge erscheinen nur, wenn er erreichbar ist
  const tvCommand = function (action, question) {
    if (question && !window.confirm($.i18n(question))) return;
    fetch(testPageBase() + '/api/testpage/system', {
      method: 'POST',
      headers: testPageHeaders({ 'Content-Type': 'application/json', 'X-Tvtest': '1' }),
      body: JSON.stringify({ action: action })
    }).then(function (res) {
      if (res.ok) return;
      return res.json().catch(function () { return {}; }).then(function (out) {
        showNotification('danger', $.i18n('power_tp_failed', out.error || res.status));
      });
    }, function () {
      showNotification('danger', $.i18n('power_tp_unreachable'));
    });
  };
  // Hyperion-Gerät: Name des Rechners und ob er von hier neu starten/herunterfahren kann (sonst Grund);
  // kommt mit den Meldungen der Testseite (content_index.js, globalThis.forkHostDevice)
  const powerAllowed = function () { return !!(globalThis.forkHostDevice && globalThis.forkHostDevice.power); };
  globalThis.forkPowerDevice = function () {
    const d = globalThis.forkHostDevice;
    $('#power_device_name').text(d && d.name ? '(' + d.name + ')' : '');
    $('#btn_deviceReboot, #btn_devicePoweroff').toggleClass('disabled', !powerAllowed());
    const why = d && !d.power && d.whyKey ? $.i18n('power_device_why_' + d.whyKey) : '';
    $('#power_device_why').text(why).toggle(!!why && $('#btn_deviceReboot').is(':visible'));
  };
  $('#btn_tpReloadTv').off().on('click', function () { tvCommand('reloadTv'); });
  $('#btn_tpRestartServer').off().on('click', function () { tvCommand('restartServer', 'power_tp_restartServer_ask'); });
  $('#btn_deviceReboot').off().on('click', function () { if (!powerAllowed()) return false; tvCommand('reboot', 'power_device_reboot_ask'); });
  $('#btn_devicePoweroff').off().on('click', function () { if (!powerAllowed()) return false; tvCommand('poweroff', 'power_device_poweroff_ask'); });
  globalThis.forkPowerDevice();

  //Lock Ui
  $('#btn_lock_ui').off().on('click', function () {
    removeStorage('loginToken');
    location.replace('/');
  });

  //hide menu elements
  if (storedAccess != 'expert')
    $('#load_webconfig').toggle(false);

});

