// Language of the TV test page. The page is written in German; in English this file swaps the texts
// through a dictionary (German source -> English), keyed by the normalized text:
// - elements that hold only text and inline markup (p, b, code, a, br …) as a whole, so the word
//   order can change; inline elements with an id keep their node (content and listeners stay)
// - other text nodes and the attributes title, aria-label, placeholder and alt one by one
// - everything the page adds or changes later, through a MutationObserver
// Texts built from values in code use I18N.tr("Text mit {a}", { a }) with the same dictionary.
// Patterns (PATTERNS) cover texts with values that come from elsewhere, e.g. the server's errors.
//
// The language is kept per device (localStorage "tvtest-lang"); switching reloads the page. The TV
// page follows the language last chosen on a control page (state.lang).
(function (global) {
  "use strict";

  const LANGS = ["de", "en"];
  let lang = "de";
  try {
    const saved = localStorage.getItem("tvtest-lang");
    if (LANGS.includes(saved)) lang = saved;
  } catch {}

  const EN = global.I18N_EN ?? {};
  const PATTERNS = global.I18N_EN_PATTERNS ?? [];
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  // collect mode (?i18n-collect): every German text the page shows is recorded, for building the dictionary
  const collect = /[?&]i18n-collect\b/.test(location.search);
  const seen = collect ? (global.__i18nSeen = new Set()) : null;

  function lookup(text) {
    const key = norm(text);
    if (!key) return null;
    if (seen && /[A-Za-zÄÖÜäöüß]{2}/.test(key)) seen.add(key);
    if (lang !== "en") return null;
    if (Object.prototype.hasOwnProperty.call(EN, key)) return EN[key];
    for (const [re, out] of PATTERNS) {
      const m = key.match(re);
      if (!m) continue;
      // a function gets the match and a translator for the parts (e.g. a server message after a
      // prefix); it returns null when it does not apply after all
      const res = typeof out === "function" ? out(m, (part) => lookup(part) ?? part, (part) => lookup(part)) : key.replace(re, out);
      if (res !== null) return res;
    }
    return null;
  }

  // text with placeholders {a}, used by code for texts with values
  function tr(text, params) {
    let out = text;
    if (lang === "en") {
      const hit = Object.prototype.hasOwnProperty.call(EN, text) ? EN[text] : null;
      if (hit !== null) out = hit;
    }
    if (seen) seen.add(text);
    return params ? out.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m)) : out;
  }

  const INLINE = new Set(["B", "STRONG", "I", "EM", "CODE", "A", "BR", "SPAN", "SMALL", "KBD", "SUB", "SUP"]);
  const BLOCK_CANDIDATES = "p, h1, h2, h3, h4, label, summary, li, small, div, span, b, a, th, td, option, button, legend";
  const ATTRS = ["title", "aria-label", "placeholder", "alt"];
  const done = new WeakSet(); // nodes written by the translator (their mutations are ours)

  // only text and inline markup inside (an inline element may hold just a number, like a link "10")
  function onlyInline(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 1 && (!INLINE.has(n.tagName) || !onlyInline(n))) return false;
    }
    return true;
  }

  // only text and inline markup inside, and some real text
  function isPhrasing(el) {
    return !!el.firstChild && onlyInline(el) && /[A-Za-zÄÖÜäöüß]{2}/.test(el.textContent);
  }

  function translateElement(el) {
    if (done.has(el) || !isPhrasing(el) || !el.querySelector("*")) return false;
    // collect mode: the element counts as one text, like when it is translated
    if (seen && lang !== "en") { lookup(el.innerHTML); return true; }
    const out = lookup(el.innerHTML);
    if (out === null || out === norm(el.innerHTML)) return false;
    // keep inline elements with an id: their content may be filled by the page
    const keep = new Map([...el.querySelectorAll("[id]")].map((n) => [n.id, n]));
    done.add(el);
    el.innerHTML = out;
    for (const [id, node] of keep) {
      const slot = el.querySelector(`#${CSS.escape(id)}`);
      if (slot) slot.replaceWith(node);
    }
    // our own change is reported to the observer first, then the page may change it again
    queueMicrotask(() => done.delete(el));
    return true;
  }

  function translateText(node) {
    if (done.has(node) || node.parentElement?.closest("script, style, [data-i18n-skip]")) return;
    const out = lookup(node.nodeValue);
    if (out === null || out === norm(node.nodeValue)) return;
    const lead = node.nodeValue.match(/^\s*/)[0];
    const tail = node.nodeValue.match(/\s*$/)[0];
    done.add(node);
    node.nodeValue = lead + out + tail;
    // the page may write this node again later
    queueMicrotask(() => done.delete(node));
  }

  function translateAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!v) continue;
      const out = lookup(v);
      if (out !== null && out !== norm(v)) el.setAttribute(a, out);
    }
  }

  function translateTree(root) {
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1 || root.closest?.("script, style, [data-i18n-skip]")) return;
    const skip = new Set();
    const els = [root, ...root.querySelectorAll("*")];
    for (const el of els) {
      if (el.matches("script, style, [data-i18n-skip], [data-i18n-skip] *")) continue;
      translateAttrs(el);
      if ([...skip].some((s) => s.contains(el))) continue;
      if (el.matches(BLOCK_CANDIDATES) && translateElement(el)) skip.add(el);
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest("script, style, [data-i18n-skip]") || [...skip].some((s) => s.contains(n))) continue;
      translateText(n);
    }
  }

  function start() {
    document.documentElement.lang = lang;
    if (lang !== "en" && !collect) return;
    if (document.title) { const t = lookup(document.title); if (t) document.title = t; }
    translateTree(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") { translateText(r.target); continue; }
        if (r.type === "attributes") { translateAttrs(r.target); continue; }
        // new content: first the element as a whole (text with inline markup), else piece by piece
        const t = r.target;
        if (t.nodeType === 1 && !done.has(t) && !t.closest("script, style, [data-i18n-skip]") && t.matches(BLOCK_CANDIDATES) && translateElement(t)) continue;
        for (const n of r.addedNodes) translateTree(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function setLang(next) {
    if (!LANGS.includes(next) || next === lang) return;
    try { localStorage.setItem("tvtest-lang", next); } catch {}
    location.reload();
  }

  global.I18N = {
    get lang() { return lang; },
    get locale() { return lang === "en" ? "en-US" : "de-DE"; },
    tr,
    // any text through dictionary and patterns, unchanged when unknown (e.g. labels from the server)
    t: (text) => lookup(String(text)) ?? String(text),
    setLang,
    // the TV page takes the language from the shared state instead of its own choice
    useLang(next) { if (LANGS.includes(next)) lang = next; },
    start,
  };
})(typeof window !== "undefined" ? window : globalThis);
