// ==UserScript==
// @name         Tweetcraft Zoom
// @namespace    tweetcraft.zoom
// @version      1.1.0
// @author       andrestube123
// @description  Hold a key to zoom in and adjust your FOV for a closer look.
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const DEFAULTS = { key: "KeyC", level: 4, look: 1 };
  let KEY = DEFAULTS.key;
  let zoom = DEFAULTS.level;
  let look = DEFAULTS.look;
  let zooming = false, orig = null;

  const log = (...a) => console.log("[zoom]", ...a);
  const typing = t => !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  const gl = () => document.getElementById("gl");
  const screenOn = () => { const s = document.getElementById("screen"); return !!s && /(^|\s)on(\s|$)/.test(s.className || ""); };
  const canZoom = () => !screenOn() && !typing(document.activeElement) && !!gl();

  function tcGet(k, d) {
    const b = window.__tcOptions;
    if (b) return b.get("zoom." + k, d);
    try { const c = JSON.parse(localStorage.getItem("tc.options") || "{}"); return c["zoom." + k] !== undefined ? c["zoom." + k] : d; } catch (e) { return d; }
  }
  function tcSet(k, v) {
    const b = window.__tcOptions;
    if (b) { b.set("zoom." + k, v); return; }
    try { const c = JSON.parse(localStorage.getItem("tc.options") || "{}"); c["zoom." + k] = v; localStorage.setItem("tc.options", JSON.stringify(c)); } catch (e) {}
  }

  function refreshConfig() {
    KEY = tcGet("key", DEFAULTS.key) || DEFAULTS.key;
    zoom = Math.max(1.5, Math.min(20, Number(tcGet("level", DEFAULTS.level)) || DEFAULTS.level));
    look = Math.max(0.1, Math.min(3, Number(tcGet("look", DEFAULTS.look)) || DEFAULTS.look));
  }

  let fovCache = (() => { const v = Number(localStorage.getItem("mc.fov")); return v >= 30 && v <= 110 ? v : 70; })();
  const getFov = () => { const b = window.__tcOptions; return (b && b.fov && b.fov.get) ? b.fov.get() : fovCache; };

  let menusMod = null, menusPending = null;
  function domReady() { return document.readyState !== "loading" ? Promise.resolve() : new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true })); }
  function menus() {
    if (menusMod) return Promise.resolve(menusMod);
    if (!menusPending) menusPending = (async () => {
      await domReady();
      try { menusMod = await import("/js/menus.js"); } catch (e) { menusMod = null; }
      return menusMod;
    })();
    return menusPending;
  }

  let fovInput;
  async function localStealFov() {
    if (fovInput !== undefined) return fovInput;
    const M = await menus();
    if (!M) { fovInput = null; return null; }
    const glEl = gl();
    const wasLocked = !!glEl && document.pointerLockElement === glEl;
    fovInput = null;
    try {
      M.openOptions();
      const el = document.querySelector('#screen .inner input[type="range"][data-k="fov"]');
      if (el) { el.min = "5"; el.step = "any"; fovInput = el; }
      M.closeMenu();
    } catch (e) {}
    if (wasLocked && glEl && glEl.requestPointerLock) { try { glEl.requestPointerLock(); } catch (e) {} }
    return fovInput;
  }
  async function setFov(v) {
    v = Math.max(2, Math.min(110, Number(v) || 70));
    const b = window.__tcOptions;
    if (b && b.fov && b.fov.set) { await b.fov.set(v); return; }
    fovCache = v; try { localStorage.setItem("mc.fov", v); } catch (e) {}
    const inp = await localStealFov();
    if (inp) { inp.value = String(v); inp.dispatchEvent(new Event("input", { bubbles: true })); }
  }

  async function start() {
    if (zooming || !canZoom()) return;
    zooming = true;
    orig = getFov();
    await setFov(orig / zoom);
    log("zoom ON", orig, "->", orig / zoom);
  }
  function stop() {
    if (!zooming) return;
    zooming = false;
    if (orig != null) setFov(orig);
    orig = null;
    log("zoom OFF");
  }

  refreshConfig();

  addEventListener("keydown", (e) => {
    if (e.__tcCaptured || (window.__tcOptions && window.__tcOptions.capturing)) return;
    if (e.code !== KEY || e.repeat) return;
    if (typing(e.target)) return;
    start();
  }, true);
  addEventListener("keyup", (e) => {
    if (e.__tcCaptured || (window.__tcOptions && window.__tcOptions.capturing)) return;
    if (e.code === KEY) stop();
  }, true);
  addEventListener("blur", stop);

  addEventListener("wheel", (e) => {
    if (!zooming) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    zoom = Math.min(20, Math.max(1.5, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (orig != null) setFov(orig / zoom);
  }, { capture: true, passive: false });

  addEventListener("mousemove", (e) => {
    if (!zooming) return;
    if (document.pointerLockElement !== gl()) return;
    const f = look / zoom;
    if (f === 1) return;
    try {
      Object.defineProperty(e, "movementX", { value: e.movementX * f, configurable: true });
      Object.defineProperty(e, "movementY", { value: e.movementY * f, configurable: true });
    } catch (err) {}
  }, true);

  function registerWithBus() {
    const b = window.__tcOptions;
    if (!b || !b.registerKeybind) { setTimeout(registerWithBus, 200); return; }
    if (b.changed) b.changed(() => refreshConfig());
    b.registerKeybind({
      id: "zoom",
      label: "Zoom (hold)",
      defaultKey: DEFAULTS.key,
      get: () => KEY,
      set: (code) => { KEY = code; tcSet("key", code); },
      reset: () => { KEY = DEFAULTS.key; tcSet("key", DEFAULTS.key); }
    });
    if (b.register) {
      b.register({
        id: "zoom",
        title: "Zoom",
        build: (api) => [
          api.header("Zoom"),
          api.slider("Zoom level", Math.round(zoom * 100) / 100, 1.5, 20, 0.5, v => { zoom = v; tcSet("level", v); }),
          api.slider("Look sensitivity (zoomed)", Math.round(Number(tcGet("look", DEFAULTS.look)) * 100) / 100, 0.1, 3, 0.05, v => { look = v; tcSet("look", v); refreshConfig(); }),
          api.note("Zoom key: " + (api.prettyKey ? api.prettyKey(KEY) : KEY) + " — change it in the Keybinds tab. Scroll to adjust the zoom while holding it."),
          api.row(api.btn("Reset zoom key to C", () => { KEY = DEFAULTS.key; tcSet("key", DEFAULTS.key); if (api.refresh) api.refresh(); }))
        ]
      });
    }
  }
  registerWithBus();

  log("script loaded on", location.host);
})();
