// TV page: shows the picture or video of the media library (state.media + state.mediaItem) full screen
// and plays it as the control page says. Own files play in a <video>, built-in test pictures are drawn
// by testimages.js, YouTube and Vimeo through their player APIs, Dailymotion as a plain embed (start
// and stop only). The page reports what its browser can play (once) and how the video is doing (every
// 2 s while it plays): position, length, errors such as "embedding not allowed".
(function (global) {
  "use strict";

  const host = document.createElement("div");
  host.id = "media";
  host.hidden = true;
  document.getElementById("screen").after(host);
  const style = document.createElement("style");
  style.textContent = `
    #media { position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: #000; }
    #media > img, #media > video, #media > canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    #media > .player, #media > iframe, #media .player iframe { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }`;
  document.head.appendChild(style);

  const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "X-Tvtest": "1" }, body: JSON.stringify(body) }).catch(() => {});

  // what this browser can play; codec strings for the common profiles (1080p)
  function reportCaps() {
    const v = document.createElement("video");
    const can = (t) => v.canPlayType(t) || "";
    const caps = {
      h264: can('video/mp4; codecs="avc1.640028"'),
      hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"'),
      hevc10: can('video/mp4; codecs="hvc1.2.4.L120.90"'),
      vp9: can('video/webm; codecs="vp9"'),
      vp8: can('video/webm; codecs="vp8"'),
      av1: can('video/mp4; codecs="av01.0.08M.08"'),
      mov: can("video/quicktime"),
      mkv: can("video/x-matroska"),
      ogv: can('video/ogg; codecs="theora"'),
      aac: can('audio/mp4; codecs="mp4a.40.2"'),
      opus: can('audio/webm; codecs="opus"'),
    };
    post("/api/media/caps", { caps, ua: navigator.userAgent.slice(0, 200), screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio } });
  }
  reportCaps();

  let shown = null;     // { key, kind, el, api }
  let applied = "";
  let statusTimer = null;
  let lastStatus = "";
  let clock = () => Date.now();

  function report(extra) {
    const s = { id: shown?.id ?? "", ...extra };
    const key = JSON.stringify(s);
    if (key === lastStatus) return;
    lastStatus = key;
    post("/api/media/tvstatus", s);
  }

  function teardown() {
    clearInterval(statusTimer);
    statusTimer = null;
    try { shown?.api?.destroy?.(); } catch {}
    if (shown?.el?.tagName === "VIDEO") { shown.el.pause(); shown.el.removeAttribute("src"); shown.el.load(); }
    host.replaceChildren();
    shown = null;
    applied = "";
  }

  // where the video should be now (seconds)
  function expected(m, duration) {
    let t = m.position + (m.playing ? Math.max(0, clock() - m.startedAt) / 1000 : 0);
    if (m.loop && duration > 0) t %= duration;
    else if (duration > 0) t = Math.min(t, duration);
    return t;
  }

  function loadScript(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Player-Skript nicht ladbar (kein Internet?)"));
      document.head.appendChild(s);
    });
  }

  function youtubeApi() {
    if (global.YT?.Player) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const before = global.onYouTubeIframeAPIReady;
      global.onYouTubeIframeAPIReady = () => { before?.(); resolve(); };
      loadScript("https://www.youtube.com/iframe_api", () => false).catch(reject);
    });
  }

  function build(item, m) {
    teardown();
    shown = { id: item.id, key: item.id + "|" + item.kind, kind: item.kind };
    const fit = (el) => { el.style.objectFit = m.fit === "fill" ? "fill" : m.fit; };
    if (item.kind === "builtin") {
      const c = document.createElement("canvas");
      c.width = Math.round(innerWidth * devicePixelRatio);
      c.height = Math.round(innerHeight * devicePixelRatio);
      global.TestImages.draw(c.getContext("2d"), item.id, c.width, c.height);
      host.appendChild(c);
      shown.el = c;
      report({ ok: true, width: c.width, height: c.height });
      return;
    }
    if (item.kind === "image") {
      const img = new Image();
      img.onload = () => report({ ok: true, width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => report({ error: "Der TV-Browser kann dieses Bild nicht anzeigen" });
      img.src = item.url ?? "/media/file/" + item.id;
      fit(img);
      host.appendChild(img);
      shown.el = img;
      return;
    }
    if (item.kind === "video") {
      const v = document.createElement("video");
      v.playsInline = true;
      v.preload = "auto";
      v.src = item.url ?? "/media/file/" + item.id;
      fit(v);
      v.onerror = () => report({ error: "Der TV-Browser kann dieses Video nicht abspielen (Format oder Codec)" });
      v.onloadedmetadata = () => apply(currentMedia ?? m, true);
      host.appendChild(v);
      shown.el = v;
      shown.api = {
        time: () => v.currentTime, duration: () => v.duration,
        play: () => v.play(), pause: () => v.pause(), seek: (t) => { v.currentTime = t; },
        mute: (on) => { v.muted = on; }, loop: (on) => { v.loop = on; },
      };
      statusTimer = setInterval(() => report({ ok: !v.error, position: Math.round(v.currentTime), duration: Math.round(v.duration || 0), paused: v.paused, muted: v.muted, blocked: shown?.blocked ?? false }), 2000);
      return;
    }
    if (item.kind === "link") buildLink(item, m);
  }

  function buildLink(item, m) {
    const div = document.createElement("div");
    div.className = "player";
    const inner = document.createElement("div");
    div.appendChild(inner);
    host.appendChild(div);
    shown.el = div;
    const id = item.id;
    const fail = (msg) => { if (shown?.id === id) report({ error: msg }); };
    const startAt = Math.floor(expected(m, item.duration || 0));
    if (item.provider === "youtube") {
      youtubeApi().then(() => {
        if (shown?.id !== id) return;
        const p = new global.YT.Player(inner, {
          videoId: item.ref,
          playerVars: { autoplay: m.playing ? 1 : 0, mute: m.muted ? 1 : 0, controls: 0, rel: 0, playsinline: 1, disablekb: 1, iv_load_policy: 3, start: startAt, loop: m.loop ? 1 : 0, playlist: m.loop ? item.ref : undefined },
          events: {
            onReady: () => { if (shown?.id === id) apply(currentMedia, true); },
            // 101/150: the owner does not allow embedding, 100: removed or private, 2: bad id, 5: HTML5 player error
            onError: (e) => fail(e.data === 101 || e.data === 150 ? "Einbetten nicht erlaubt (vom Kanal gesperrt)" : e.data === 100 ? "Video nicht gefunden oder privat" : "YouTube-Fehler " + e.data),
          },
        });
        shown.api = {
          time: () => p.getCurrentTime?.() ?? 0, duration: () => p.getDuration?.() ?? 0,
          play: () => p.playVideo?.(), pause: () => p.pauseVideo?.(), seek: (t) => p.seekTo?.(t, true),
          mute: (on) => (on ? p.mute?.() : p.unMute?.()), loop: () => {}, destroy: () => p.destroy?.(),
          paused: () => p.getPlayerState?.() !== 1,
        };
        statusTimer = setInterval(() => report({ ok: true, position: Math.round(shown?.api?.time() ?? 0), duration: Math.round(shown?.api?.duration() ?? 0), paused: shown?.api?.paused(), muted: p.isMuted?.() ?? m.muted }), 2000);
      }).catch((e) => fail(e.message));
      return;
    }
    if (item.provider === "vimeo") {
      loadScript("https://player.vimeo.com/api/player.js", () => !!global.Vimeo?.Player).then(() => {
        if (shown?.id !== id) return;
        const opts = { id: Number(item.ref), autoplay: m.playing, muted: m.muted, loop: m.loop, controls: false, dnt: true, width: innerWidth, height: innerHeight };
        if (item.hash) opts.h = item.hash;
        const p = new global.Vimeo.Player(inner, opts);
        let t = 0, d = 0, paused = !m.playing, muted = m.muted;
        p.on("timeupdate", (e) => { t = e.seconds; d = e.duration; });
        p.on("play", () => { paused = false; });
        p.on("pause", () => { paused = true; });
        p.on("error", (e) => fail(/privacy|embed/i.test(e?.name + e?.message) ? "Einbetten nicht erlaubt (Datenschutz-Einstellung des Videos)" : "Vimeo-Fehler: " + (e?.message ?? e?.name)));
        p.ready().then(() => { if (shown?.id === id) apply(currentMedia, true); }).catch((e) => fail("Vimeo: " + (e?.message ?? "nicht ladbar")));
        shown.api = {
          time: () => t, duration: () => d,
          play: () => p.play().catch((e) => { if (e?.name === "NotAllowedError") { shown.blocked = true; p.setMuted(true).then(() => p.play()).catch(() => {}); } }),
          pause: () => p.pause().catch(() => {}), seek: (s) => p.setCurrentTime(s).catch(() => {}),
          mute: (on) => { muted = on; p.setMuted(on).catch(() => {}); }, loop: (on) => p.setLoop(on).catch(() => {}),
          destroy: () => p.destroy().catch(() => {}),
        };
        statusTimer = setInterval(() => report({ ok: true, position: Math.round(t), duration: Math.round(d), paused, muted, blocked: shown?.blocked ?? false }), 2000);
      }).catch((e) => fail(e.message));
      return;
    }
    if (item.provider === "dailymotion") {
      // the plain embed: no control while it runs; pause/seek start it again from that point
      const f = document.createElement("iframe");
      f.allow = "autoplay; fullscreen";
      f.src = `https://www.dailymotion.com/embed/video/${encodeURIComponent(item.ref)}?autoplay=${m.playing ? 1 : 0}&mute=${m.muted ? 1 : 0}&controls=0&queue-enable=false&ui-start-screen-info=0&sharing-enable=false&start=${startAt}`;
      div.replaceChildren(f);
      shown.api = { simple: true };
      report({ ok: true, simple: true });
    }
  }

  let currentMedia = null;
  // brings the player in line with the state: play/pause, position, sound, loop, fit
  function apply(m, force = false) {
    if (!shown) return;
    const api = shown.api;
    const key = JSON.stringify([m.playing, m.position, m.startedAt, m.muted, m.loop, m.fit]);
    if (!force && key === applied) return;
    applied = key;
    if (shown.el && (shown.el.tagName === "IMG" || shown.el.tagName === "VIDEO")) shown.el.style.objectFit = m.fit === "fill" ? "fill" : m.fit;
    if (!api) return;
    if (api.simple) return;
    api.loop?.(m.loop);
    api.mute?.(m.muted);
    const d = Number(api.duration?.()) || 0;
    const want = expected(m, d);
    if (Math.abs((api.time?.() ?? 0) - want) > 1.2) api.seek?.(want);
    if (m.playing) {
      const r = api.play?.();
      // with sound, browsers only start a video after a tap on this device: play it muted then
      if (r?.catch) r.catch((e) => {
        if (e?.name !== "NotAllowedError" || !shown?.el?.tagName) return;
        shown.blocked = true;
        shown.el.muted = true;
        shown.el.play().catch(() => {});
      });
    } else api.pause?.();
  }

  // called by the TV page with every state; clockFn gives the Pi's time
  function render(state, clockFn) {
    if (clockFn) clock = clockFn;
    const m = state.media;
    const item = state.mediaItem;
    const on = !!(m?.active && item);
    host.hidden = !on;
    if (!on) { if (shown) { teardown(); report({}); } currentMedia = null; return; }
    currentMedia = m;
    const key = item.id + "|" + item.kind;
    // Dailymotion knows no control: a change of play/pause/position builds it again
    const dmKey = item.provider === "dailymotion" ? JSON.stringify([m.playing, m.position, m.startedAt, m.muted]) : "";
    if (!shown || shown.key !== key || (dmKey && shown.dmKey !== dmKey)) {
      build(item, m);
      if (shown) shown.dmKey = dmKey;
    }
    apply(m);
  }

  global.TvMedia = { render, active: () => !host.hidden };
})(window);
