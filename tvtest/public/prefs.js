// Browser settings of the test page per device, the same on every port of the test server.
// localStorage belongs to one address including the port, so a new port started without the settings.
// The server names the device with a cookie (cookies belong to the host name, not to the port), keeps
// its "tvtest-*" keys and writes them into the page (window.TVTEST_PREFS) before this script runs.
// This script copies them into localStorage first (the server's copy is the newest, written from any
// port) and sends every later change of a "tvtest-*" key back. The page code keeps using localStorage.
(function () {
  "use strict";
  let ls;
  try { ls = window.localStorage; } catch { return; }
  if (!ls) return;
  const PREFIX = "tvtest-";
  const own = (k) => typeof k === "string" && k.startsWith(PREFIX);
  const setItem = Storage.prototype.setItem;
  const removeItem = Storage.prototype.removeItem;
  const server = window.TVTEST_PREFS || {};

  const pending = {};
  let timer = null;
  function flush() {
    timer = null;
    const changes = { ...pending };
    for (const k of Object.keys(pending)) delete pending[k];
    if (!Object.keys(changes).length) return;
    fetch("/api/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tvtest": "1" },
      body: JSON.stringify({ changes }),
      keepalive: true,
    }).catch(() => {});
  }
  const queue = (k, v) => {
    pending[k] = v;
    if (!timer) timer = setTimeout(flush, 400);
  };

  try {
    for (const [k, v] of Object.entries(server)) {
      if (!own(k)) continue;
      if (v === null) removeItem.call(ls, k);
      else setItem.call(ls, k, v);
    }
    // settings from before the server kept them (or from a browser that lost the cookie) go up once
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (own(k) && !(k in server)) queue(k, ls.getItem(k));
    }
  } catch {}

  Storage.prototype.setItem = function (k, v) {
    setItem.call(this, k, v);
    if (this === ls && own(k)) queue(k, String(v));
  };
  Storage.prototype.removeItem = function (k) {
    removeItem.call(this, k);
    if (this === ls && own(k)) queue(k, null);
  };
  addEventListener("pagehide", flush);
})();
