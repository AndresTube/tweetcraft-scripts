// ==UserScript==
// @name         Tweetcraft Zoom
// @namespace    tweetcraft.zoom
// @version      1.0.0
// @author       andrestube123
// @description  A simple script that allows you to zoom using C
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// planned to do changable keybind btw
(() => {
  "use strict";
  const KEY = "KeyC";
  const SENS = 0.15 * Math.PI / 180;
  let zoom = 4, zooming = false, orig = null;

  const S = () => window.__mc && window.__mc.S;
  const log = (...a) => console.log("[zoom]", ...a);

  const ok = () => !!S();

  function start() {
    const s = S();
    if (!s) return log("no __mc.S found on this page");
    if (zooming) return;
    if (!s.started || s.menu || s.chatOpen || s.closed) return log("blocked", {started: s.started, menu: !!s.menu, chat: s.chatOpen});
    zooming = true;
    orig = s.baseFov;
    s.baseFov = Math.max(5, orig / zoom);
    log("zoom ON", orig, "->", s.baseFov);
  }
  function stop() {
    if (!zooming) return;
    zooming = false;
    const s = S();
    if (s && orig != null) s.baseFov = orig;
    orig = null;
    log("zoom OFF");
  }

  addEventListener("keydown", (e) => {
    if (e.code !== KEY || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    start();
  }, true);
  addEventListener("keyup", (e) => { if (e.code === KEY) stop(); }, true);
  addEventListener("blur", stop);

  addEventListener("wheel", (e) => {
    const s = S();
    if (!zooming || !s) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    zoom = Math.min(20, Math.max(1.5, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    s.baseFov = Math.max(5, orig / zoom);
  }, { capture: true, passive: false });

  addEventListener("mousemove", (e) => {
    const s = S();
    if (!zooming || !s || s.menu || s.chatOpen || s.input !== "lock") return;
    if (document.pointerLockElement !== document.querySelector("#gl")) return;
    if (s.lockSkip > 0) return;
    const k = 1 / zoom - 1;
    s.yaw -= e.movementX * SENS * k;
    s.pitch = Math.max(-1.5707, Math.min(1.5707, s.pitch - e.movementY * SENS * k));
  });

  log("script loaded on", location.host);
})();
