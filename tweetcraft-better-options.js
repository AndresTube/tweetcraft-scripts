// ==UserScript==
// @name         Tweetcraft Better Options
// @namespace    tweetcraft.twitterentary
// @version      1.0.0
// @description  Adds a custom options menu for graphics, interface, keybinds, shaders, and zoom settings.
// @author       Twitterentary
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TAG = '[BetterOptions]';
  const MENU_NAME = 'tcoptions';
  const STORE_KEY = 'tc.options';
  const RDS = [4, 6, 8, 10, 12];

  const DEFAULTS = {
    'ui.scale': 1,
    'hud.on': true,
    'input.sens': 1,
    'keys.map': {},
    'keys.mute': []
  };

  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { cfg = {}; }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {} };
  const clone = v => (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v;

  const sections = [];
  const keybinds = [];
  const subs = [];

  const bus = {
    version: '2.2.0',
    get config() { return cfg; },
    get: (k, d) => (cfg[k] !== undefined ? cfg[k] : (DEFAULTS[k] !== undefined ? clone(DEFAULTS[k]) : d)),
    set(k, v) { cfg[k] = v; save(); emit(k, v); },
    register(sec) { if (sec && sec.id && !sections.some(s => s.id === sec.id)) { sections.push(sec); emit('__sections'); } },
    registerKeybind(kb) { if (kb && kb.id && !keybinds.some(k => k.id === kb.id)) { keybinds.push(kb); emit('__keybinds'); } },
    changed(cb) { subs.push(cb); },
    open: () => openMenu(),
    toast,
    fov: null,
    capturing: false,
    ui: null
  };
  function emit(k, v) { for (const f of subs) { try { f(k, v); } catch (e) {} } }
  window.__tcOptions = bus;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  const isTyping = t => !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  const $ = sel => document.querySelector(sel);

  function toast(text) {
    const n = document.getElementById('note');
    if (n) {
      try {
        n.textContent = text;
        n.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => n.classList.remove('show'), 2000);
        return;
      } catch (e) {}
    }
    console.log(TAG, text);
  }

  let _menus = null, _menusPending = null, _menusOverride = false;
  function domReady() {
    if (document.readyState !== 'loading') return Promise.resolve();
    return new Promise(res => document.addEventListener('DOMContentLoaded', res, { once: true }));
  }
  function menus() {
    if (_menus) return Promise.resolve(_menus);
    if (_menusPending) return _menusPending;
    _menusPending = (async () => {
      await domReady();
      try { const m = await import('/js/menus.js'); if (!_menusOverride) _menus = m; }
      catch (e) { console.warn(TAG, 'menus import failed', e); if (!_menusOverride) _menus = null; }
      return _menus;
    })();
    return _menusPending;
  }
  menus();
  bus._injectMenus = (m) => { _menusOverride = true; _menus = m; _menusPending = Promise.resolve(m); };

  const ourMenuOpen = () => !!$('#screen .inner .tc-marker');

  let fovCache = (() => { const v = Number(store.get('mc.fov')); return v >= 30 && v <= 110 ? v : 70; })();
  const getFov = () => fovCache;
  let fovInput;
  async function stealFovInput() {
    if (fovInput !== undefined) return fovInput;
    const M = await menus();
    if (!M) { fovInput = null; return null; }
    const wasOurs = ourMenuOpen();
    const gl = document.getElementById('gl');
    const wasLocked = !!gl && document.pointerLockElement === gl;
    fovInput = null;
    try {
      M.openOptions();
      const el = $('#screen .inner input[type="range"][data-k="fov"]');
      if (el) { el.min = '5'; el.step = 'any'; fovInput = el; }
    } catch (e) { console.warn(TAG, e); }
    try { if (wasOurs) M.showScreen(MENU_NAME, buildScreen, 'dim'); else M.closeMenu(); } catch (e) {}
    if (wasLocked && gl && gl.requestPointerLock) { try { gl.requestPointerLock(); } catch (e) {} }
    return fovInput;
  }
  async function setFov(v) {
    v = Math.max(2, Math.min(110, Number(v) || 70));
    fovCache = v; store.set('mc.fov', v);
    const inp = await stealFovInput();
    if (inp) { inp.value = String(v); inp.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  bus.fov = { get: getFov, set: setFov };

  const currentRd = () => { const v = Number(store.get('mc.rd')); return RDS.includes(v) ? v : 8; };
  async function setRenderDistance(target) {
    if (!RDS.includes(target)) target = RDS[0];
    const M = await menus();
    if (!M) { toast('Options unavailable'); return; }
    const wasOurs = ourMenuOpen();
    try {
      M.openPause();
      let guard = 0;
      while (guard++ < 12) {
        const b = $('#screen .inner button[aria-label^="Distance:"]');
        if (!b) break;
        const cur = Number((b.getAttribute('aria-label').match(/\d+/) || [])[0]);
        if (cur === target) break;
        b.click();
      }
    } catch (e) { console.warn(TAG, e); }
    store.set('mc.rd', target);
    try { if (wasOurs) M.showScreen(MENU_NAME, buildScreen, 'dim'); else M.closeMenu(); } catch (e) {}
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) { toast("Fullscreen isn't allowed here"); }
    refresh();
  }
  async function toggleHud() {
    const M = await menus();
    if (!M) return;
    const wasOurs = ourMenuOpen();
    bus.set('hud.on', !bus.get('hud.on', true));
    try {
      M.closeMenu();
      const down = new KeyboardEvent('keydown', { code: 'F1', key: 'F1', bubbles: true });
      down.__tc = true;
      window.dispatchEvent(down);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'F1', key: 'F1', bubbles: true }));
    } catch (e) { console.warn(TAG, e); }
    try { if (wasOurs) M.showScreen(MENU_NAME, buildScreen, 'dim'); } catch (e) {}
  }

  let uiTimer = 0;
  const isTouch = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  function uiMult() { return Math.max(0.5, Math.min(3, Number(bus.get('ui.scale', 1)) || 1)); }
  function uiBase() {
    const full = window.devicePixelRatio || 1;
    const t = isTouch();
    const raw = Math.max(t ? 2 : 1, Math.min(3, Math.min(innerWidth / 280, innerHeight / 190)));
    const u = Math.max(1, Math.round(raw * full)) / full;
    const d = Math.max(1, Math.round(u * full) - 1) / full;
    const hpx = Math.max(t ? 2 : 1, Math.round((t ? 1.75 : 1.25) * full));
    return { u, d, hp: hpx / full };
  }
  function applyUiScale() {
    const m = uiMult(), b = uiBase(), root = document.documentElement.style;
    root.setProperty('--u', (b.u * m) + 'px');
    root.setProperty('--d', (b.d * m) + 'px');
    root.setProperty('--tc-s', String(m));
    const scr = document.getElementById('screen');
    if (scr) rescaleLabels(scr);
  }
  function reassertUiScale() {
    const m = uiMult();
    if (m === 1) return;
    const b = uiBase(), root = document.documentElement.style;
    const near = (cur, want) => Math.abs(parseFloat(cur) - want) < 0.02;
    if (!near(root.getPropertyValue('--u'), b.u * m)) root.setProperty('--u', (b.u * m) + 'px');
    if (!near(root.getPropertyValue('--d'), b.d * m)) root.setProperty('--d', (b.d * m) + 'px');
    if (root.getPropertyValue('--tc-s') !== String(m)) root.setProperty('--tc-s', String(m));
  }

  let hudPatched = false, _uiOverride = null, capturedFont = null;
  function noteFont(f) { if (f && typeof f.draw === 'function' && typeof f.width === 'function') capturedFont = f; }
  const hudScale = (gs, m) => (typeof gs !== 'number' || m === 1) ? gs : Math.max(1, Math.round(gs * m));
  async function patchHudScale() {
    if (hudPatched) return;
    try {
      const ui = _uiOverride || await import('/js/ui.js');
      const P = ui && ui.Hud && ui.Hud.prototype;
      if (!P) return;
      if (P.draw && !P.draw.__tcScaled) {
        const orig = P.draw;
        const fn = function (o) {
          noteFont(this && this.font);
          const m = uiMult();
          if (m !== 1 && o && typeof o.gs === 'number') o = Object.assign({}, o, { gs: hudScale(o.gs, m) });
          return orig.call(this, o);
        };
        fn.__tcScaled = true; P.draw = fn;
      }
      const wrapScale = (name, argIndex) => {
        const orig = P[name]; if (!orig || orig.__tcScaled) return;
        const fn = function (...args) { const m = uiMult(); if (m !== 1 && typeof args[argIndex] === 'number') args[argIndex] = hudScale(args[argIndex], m); return orig.apply(this, args); };
        fn.__tcScaled = true; P[name] = fn;
      };
      wrapScale('suggestions', 0); wrapScale('tab', 1); wrapScale('hint', 1);
      hudPatched = true;
    } catch (e) {}
  }

  let survPatched = false, _survOverride = null;
  async function patchSurvivalScale() {
    if (survPatched) return;
    try {
      const mod = _survOverride || await import('/js/survival/client.js');
      const P = mod && mod.SurvivalClient && mod.SurvivalClient.prototype;
      if (!P || !P.drawHud) return;
      if (!P.drawHud.__tcScaled) {
        const orig = P.drawHud;
        const fn = function (hud, font, gs) {
          noteFont(font || (hud && hud.font));
          return orig.call(this, hud, font, hudScale(gs, uiMult()));
        };
        fn.__tcScaled = true; P.drawHud = fn;
      }
      survPatched = true;
    } catch (e) {}
  }

  function redrawButtonLabels(btn) {
    if (!capturedFont || !btn || btn.tagName !== 'BUTTON') return;
    if (btn.classList.contains('hb')) return;
    const text = btn.getAttribute('aria-label') || '';
    if (!text) return;
    const m = uiMult();
    for (const c of Array.from(btn.children)) {
      if (!c || c.tagName !== 'CANVAS') continue;
      const fw = capturedFont.width(text);
      if (c.__tcPx == null) {
        const px0 = c.width / Math.max(1, fw + 1);
        if (Math.abs(c.height - 9 * px0) > 1 || Math.abs(c.width - (fw + 1) * px0) > Math.max(1, px0)) continue;
        c.__tcPx = px0;
      }
      const px = Math.max(1, c.__tcPx * m);
      const color = c.classList.contains('hi') ? '#ffffa0' : (btn.disabled ? '#a0a0a0' : '#ffffff');
      const W = Math.max(1, Math.round((fw + 1) * px));
      const H = Math.max(1, Math.round(9 * px));
      if (c.width !== W) c.width = W;
      if (c.height !== H) c.height = H;
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, W, H);
      capturedFont.draw(ctx, text, 0, 0, px, color, true);
      const dpr = window.devicePixelRatio || 1;
      c.style.width = (W / dpr) + 'px';
      c.style.height = (H / dpr) + 'px';
    }
  }
  function rescaleLabels(root) {
    if (!capturedFont || !root || root.nodeType !== 1) return;
    if (root.matches && root.matches('button.mcb')) redrawButtonLabels(root);
    if (root.querySelectorAll) for (const b of root.querySelectorAll('button.mcb')) redrawButtonLabels(b);
  }
  let labelObserver = null;
  function startLabelObserver() {
    if (labelObserver || !window.MutationObserver) return;
    const screen = document.getElementById('screen');
    if (!screen) return;
    labelObserver = new MutationObserver(muts => {
      for (const mu of muts) for (const n of mu.addedNodes) {
        if (!n || n.nodeType !== 1) continue;
        if (n.tagName === 'CANVAS' && n.parentElement) redrawButtonLabels(n.parentElement);
        else rescaleLabels(n);
      }
    });
    labelObserver.observe(screen, { childList: true, subtree: true });
  }

  bus._injectUi = (ui) => { _uiOverride = ui; hudPatched = false; };
  bus._patchHud = () => patchHudScale();
  bus._patchSurvival = () => patchSurvivalScale();
  bus._injectSurvival = (mod) => { _survOverride = mod; survPatched = false; };
  bus._rescaleLabels = (root) => rescaleLabels(root);

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) for (const k in props) {
      const v = props[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) e.append(kid);
    return e;
  }
  const T = s => document.createTextNode(String(s));
  const row = (...kids) => h('div', { class: 'row' }, ...kids);
  const note = text => h('p', { class: 'desc' }, T(text));
  const header = text => h('div', { class: 'tc-title' }, T(text));

  function btn(label, onclick, opts) {
    const b = h('button', { class: 'mcb' + (opts && opts.cls ? ' ' + opts.cls : ''), type: 'button', 'aria-label': label, text: label });
    b.addEventListener('click', e => { e.preventDefault(); try { onclick && onclick(e); } catch (err) { console.error(TAG, err); } });
    b.__setLabel = t => { b.textContent = t; b.setAttribute('aria-label', t); };
    return b;
  }
  function toggle(label, value, onchange) {
    const b = btn(label + ': ' + (value ? 'ON' : 'OFF'), () => { value = !value; b.__setLabel(label + ': ' + (value ? 'ON' : 'OFF')); onchange(value); }, { cls: 'tc-tg' });
    return b;
  }
  function slider(label, value, min, max, step, oninput, onchange) {
    const cap = h('div', { class: 'tc-cap', text: label + ': ' + value });
    const inp = h('input', { class: 'tc-range', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    inp.addEventListener('input', () => { const v = Number(inp.value); cap.textContent = label + ': ' + v; if (oninput) oninput(v); });
    if (onchange) inp.addEventListener('change', () => onchange(Number(inp.value)));
    return h('div', { class: 'tc-row' }, cap, inp);
  }
  function item(label, control) {
    return h('div', { class: 'tc-item' }, h('div', { class: 'tc-cap', text: label }), control);
  }

  let cssDone = false;
  function ensureCSS() {
    if (cssDone) return; cssDone = true;
    const st = document.createElement('style');
    st.textContent = `
      /* the pixel font, everywhere. form controls do not inherit it by default */
      #screen .inner, #screen .inner button, #screen .inner input, #screen .inner select, #screen .inner textarea {
        font-family: "Tweetcraft", ui-monospace, monospace;
      }
      #screen .inner .tc-title { font: calc(9 * var(--u)) "Tweetcraft", ui-monospace, monospace; margin: 0 0 calc(2 * var(--u)); text-shadow: calc(1 * var(--u)) calc(1 * var(--u)) 0 #282828; }
      #screen .inner .tc-cap { font: calc(8 * var(--u)) "Tweetcraft", ui-monospace, monospace; }
      #screen .inner .mcb { font: calc(8 * var(--u)) "Tweetcraft", ui-monospace, monospace; }
      /* the game's canvas button labels are redrawn crisply by JS (see
         redrawButtonLabels); only the crosshair bitmap needs a plain scale. */
      #cross { transform: translate(-50%, -50%) scale(var(--tc-s, 1)); }
      #screen .inner .tc-tabs { display: flex; gap: calc(2 * var(--u)); flex-wrap: wrap; justify-content: center; max-width: 94vw; }
      #screen .inner .tc-tabs .mcb { width: auto; padding: 0 calc(4 * var(--u)); height: calc(18 * var(--u)); }
      #screen .inner .mcb.on { border-image-source: url(/assets/gui/button_highlighted.png); }
      #screen .inner .tc-item { display: flex; gap: calc(3 * var(--u)); align-items: center; justify-content: space-between; width: min(94vw, calc(230 * var(--u))); }
      #screen .inner .tc-item > .mcb { width: calc(66 * var(--u)); }
      #screen .inner .tc-row { display: flex; gap: calc(3 * var(--u)); align-items: center; justify-content: center; width: min(94vw, calc(230 * var(--u))); }
      #screen .inner .tc-row .tc-cap { min-width: calc(78 * var(--u)); }
      #screen .inner .tc-range { width: 100%; height: calc(12 * var(--u)); margin: 0; padding: 0; border: var(--u) solid #000; background: #252525; cursor: pointer; touch-action: none; }
      #screen .inner .tc-list { display: flex; flex-direction: column; gap: calc(2 * var(--u)); max-height: calc(150 * var(--u)); overflow-y: auto; width: min(94vw, calc(230 * var(--u))); }
      #screen .inner .tc-sep { height: calc(3 * var(--u)); }
      /* these now live in our menu, so drop them from the game's pause screen */
      #screen .inner button[aria-label^="Distance:"] { display: none !important; }
      #screen .inner button[aria-label="Fullscreen"],
      #screen .inner button[aria-label="Exit Fullscreen"] { display: none !important; }
    `;
    (document.head || document.documentElement).append(st);
  }

  function fovRow() {
    return slider('Field of View', Math.round(getFov()), 30, 110, 1, v => { setFov(v); });
  }
  function rdRow() {
    const cur = currentRd();
    return slider('Render distance', cur, RDS[0], RDS[RDS.length - 1], 2, null, v => { setRenderDistance(v).then(refresh); });
  }
  function fullscreenRow() {
    const on = !!document.fullscreenElement;
    return item('Fullscreen', btn(on ? 'Exit' : 'Enter', toggleFullscreen));
  }
  function scaleRow() {
    const cur = Number(bus.get('ui.scale', 1));
    return slider('Interface & HUD size', cur, 0.75, 2, 0.05, v => { bus.set('ui.scale', v); applyUiScale(); });
  }
  function hudRow() {
    return item('HUD', toggle('HUD', !!bus.get('hud.on', true), toggleHud));
  }

  const KEYNAMES = { Space: ' ', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Slash: '/', Quote: "'", Comma: ',', Period: '.', Minus: '-', Equal: '=', Backquote: '`', Semicolon: ';', Backslash: '\\', BracketLeft: '[', BracketRight: ']' };
  const keyName = code => KEYNAMES[code] || (code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code);
  let capturing = null;
  function setCapturing(entry) { capturing = entry; bus.capturing = !!entry; }

  function screenIsOn() { const s = document.getElementById('screen'); return !!s && /(^|\s)on(\s|$)/.test(s.className || ''); }
  function invClosed() { const el = document.getElementById('inv'); return !el || el.classList.contains('off'); }
  function remapActive() { return !screenIsOn() && invClosed() && !isTyping(document.activeElement); }
  function modKeySet() {
    const set = new Set();
    for (const kb of keybinds) { try { const k = kb.get && kb.get(); if (k) set.add(k); } catch (e) {} }
    return set;
  }
  function onKeyCapture(e) {
    try { onKeyCaptureImpl(e); } catch (err) {}
  }
  function onKeyCaptureImpl(e) {
    if (e.__tc) return;
    if (capturing && !ourMenuOpen()) setCapturing(null);

    if (capturing && (e.type === 'keydown')) {
      e.preventDefault(); e.stopImmediatePropagation();
      e.__tcCaptured = true;
      const entry = capturing.entry;
      if (e.code === 'Escape') { setCapturing(null); refresh(); return; }
      if (entry && entry.def && modKeySet().has(e.code)) { setCapturing(null); refresh(); toast('That key is used by a mod'); return; }
      setCapturing(null); bindEntry(entry, e.code); refresh();
      return;
    }

    if (!remapActive()) return;
    if (modKeySet().has(e.code)) return;
    const map = bus.get('keys.map', {}) || {};
    const to = map[e.code];
    if (to) {
      e.preventDefault(); e.stopImmediatePropagation();
      const ev = new KeyboardEvent(e.type, {
        code: to, key: keyName(to), bubbles: true, cancelable: true, repeat: e.repeat,
        ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
      });
      ev.__tc = true;
      window.dispatchEvent(ev);
      return;
    }
    const mute = bus.get('keys.mute', []) || [];
    if (mute.includes(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }
  addEventListener('keydown', onKeyCapture, true);
  addEventListener('keyup', onKeyCapture, true);

  function currentKeyFor(def) {
    const map = bus.get('keys.map', {}) || {};
    for (const src in map) if (map[src] === def) return src;
    const mute = bus.get('keys.mute', []) || [];
    return mute.includes(def) ? null : def;
  }
  function bindEntry(entry, newKey) {
    if (entry && (entry.get || entry.set)) { entry.set(newKey); return; }
    const def = entry.def;
    const map = bus.get('keys.map', {}) || {};
    const mute = (bus.get('keys.mute', []) || []).slice();
    for (const src in map) if (map[src] === def) delete map[src];
    const mi = mute.indexOf(def);
    if (newKey === def) { if (mi >= 0) mute.splice(mi, 1); }
    else { map[newKey] = def; if (mi < 0) mute.push(def); }
    bus.set('keys.map', map);
    bus.set('keys.mute', mute);
  }

  const GAME_ACTIONS = [
    ['Forward', 'KeyW'], ['Back', 'KeyS'], ['Left', 'KeyA'], ['Right', 'KeyD'],
    ['Jump', 'Space'], ['Sneak', 'ShiftLeft'], ['Sprint (Mac)', 'ControlLeft'],
    ['Drop item', 'KeyQ'], ['Inventory', 'KeyE'], ['Chat', 'KeyT'], ['View', 'F5'],
    ['Debug (F3)', 'F3'], ['HUD (F1)', 'F1']
  ];
  function keybindEntries() {
    const list = GAME_ACTIONS.map(([label, def]) => ({ id: 'g:' + def, label, def }));
    for (const kb of keybinds) list.push({ id: 'm:' + kb.id, label: kb.label, get: kb.get, set: kb.set });
    return list;
  }
  function entryKey(entry) { return entry.get ? entry.get() : currentKeyFor(entry.def); }

  function keybindsSection() {
    const out = [header('Keybinds'), note('Click a key to change it, then press the new key. Escape cancels. Game keys are remapped; mod keys are handled by their script.')];
    out.push(slider('Mouse sensitivity', Number(bus.get('input.sens', 1)), 0.25, 3, 0.05, v => bus.set('input.sens', v)));
    out.push(h('div', { class: 'tc-sep' }));
    const list = h('div', { class: 'tc-list' });
    for (const entry of keybindEntries()) {
      const isCap = capturing && capturing.entry && capturing.entry.id === entry.id;
      const cur = entryKey(entry);
      const kb = btn(isCap ? '(press key…)' : (cur ? prettyKey(cur) : '(none)'), () => { setCapturing({ entry }); refresh(); });
      list.append(item(entry.label, kb));
    }
    out.push(list);
    out.push(h('div', { class: 'tc-sep' }));
    out.push(row(btn('Reset all keybinds', () => {
      bus.set('keys.map', {}); bus.set('keys.mute', []);
      for (const kb of keybinds) if (kb.reset) kb.reset();
      refresh();
    })));
    return out;
  }
  function prettyKey(code) {
    if (!code) return '(none)';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    return code;
  }

  function shadersSection() {
    const TE = window.Twitterentary;
    if (!TE || !TE.cfg) return [header('Shaders'), note('Twitterentary Shaders is not loaded on this page.')];
    const cfgRef = TE.cfg;
    const schema = TE.schema || defaultShaderSchema(cfgRef);
    const out = [header('Shaders'), note('Lighting and colour apply instantly. Settings marked (reload) need a page refresh.')];
    let anyReload = false;
    for (const f of schema) {
      const label = f.label + (f.reload ? ' (reload)' : '');
      if (f.type === 'bool') {
        out.push(item(label, toggle(label, !!cfgRef[f.key], v => { setShader(TE, f.key, v); if (f.reload) toast('Saved — reload to apply'); })));
      } else if (f.type === 'num') {
        const cur = Number(cfgRef[f.key]);
        out.push(slider(label, Number.isFinite(cur) ? cur : f.min, f.min, f.max, f.step, v => { setShader(TE, f.key, v); }));
      }
      if (f.reload) anyReload = true;
    }
    if (anyReload) {
      out.push(h('div', { class: 'tc-sep' }));
      out.push(row(btn('Reload page now', () => location.reload())));
    }
    return out;
  }
  function setShader(TE, key, value) {
    const c = TE.cfg; c[key] = value;
    try { localStorage.setItem('tc.shader.' + key, String(value)); } catch (e) {}
    if (TE.apply) { try { TE.apply(); } catch (e) {} }
  }
  function defaultShaderSchema(c) {
    const b = (key, label) => ({ key, label, type: 'bool' });
    const n = (key, label, min, max, step) => ({ key, label, type: 'num', min, max, step });
    return [
      b('enabled', 'Shaders on'), b('shadows', 'Sun shadows'), b('waving', 'Waving leaves & plants'),
      b('waterEffects', 'Water effects'), b('skyEffects', 'Sky'), b('cloudEffects', 'Clouds'),
      n('sunStrength', 'Sun light', 0, 2, 0.05), n('ambientStrength', 'Ambient light', 0, 2, 0.05),
      n('blockLight', 'Block light', 0, 2, 0.05), n('aoPower', 'Contact shadows (AO)', 0.5, 3, 0.1),
      n('exposure', 'Exposure', 0.4, 2, 0.05), n('saturation', 'Saturation', 0, 2, 0.02), n('contrast', 'Contrast', 0.5, 1.8, 0.02),
      n('waveStrength', 'Wave strength', 0, 2, 0.05)
    ];
  }

  let curTab = 'graphics';
  function tabsList() {
    const t = [{ id: 'graphics', title: 'Graphics' }];
    if (window.Twitterentary && window.Twitterentary.cfg) t.push({ id: 'shaders', title: 'Shaders' });
    for (const s of sections) t.push({ id: 'reg:' + s.id, title: s.title || s.id });
    t.push({ id: 'keybinds', title: 'Keybinds' });
    t.push({ id: 'about', title: 'About' });
    return t;
  }
  function buildScreen() {
    ensureCSS();
    const tabs = h('div', { class: 'tc-tabs' });
    for (const t of tabsList()) {
      const b = btn(t.title, () => { curTab = t.id; refresh(); });
      if (curTab === t.id) b.classList.add('on');
      tabs.append(b);
    }
    const body = [];
    body.push(h('span', { class: 'tc-marker', style: 'display:none' }));
    body.push(header('More Options'), tabs, h('div', { class: 'tc-sep' }));

    if (curTab === 'graphics') {
      body.push(fovRow(), rdRow(), fullscreenRow(), scaleRow(), hudRow());
    } else if (curTab === 'shaders') {
      body.push(...shadersSection());
    } else if (curTab === 'keybinds') {
      body.push(...keybindsSection());
    } else if (curTab === 'about') {
      body.push(note('TweetCraft Better Options v' + bus.version + '. Settings are saved automatically.'));
      body.push(note('Opened from the pause menu\'s "Options…" button. Press Escape to go back.'));
    } else if (curTab.startsWith('reg:')) {
      const sec = sections.find(x => x.id === curTab.slice(4));
      if (sec) { try { body.push(...sec.build(api())); } catch (e) { body.push(note('Section error: ' + e.message)); } }
    }
    body.push(h('div', { class: 'tc-sep' }));
    body.push(row(btn('Done', closeMenu)));
    return body;
  }
  function api() {
    return { bus, h, T, row, note, header, btn, toggle, slider, item, refresh, toast, prettyKey, currentKeyFor, fov: bus.fov };
  }
  bus.ui = { h, T, row, note, header, btn, toggle, slider, item, refresh, toast, prettyKey };
  bus.build = buildScreen;
  bus.close = closeMenu;

  async function openMenu() {
    if (ourMenuOpen()) { refresh(); return; }
    const M = await menus();
    if (!M) { toast('Options unavailable'); return; }
    M.showScreen(MENU_NAME, buildScreen, 'dim');
    stealFovInput();
  }
  function closeMenu() {
    if (capturing) setCapturing(null);
    const doBack = M => { if (M) { try { M.back(); } catch (e) {} } };
    if (_menus) doBack(_menus);
    else menus().then(doBack);
  }
  function refresh() {
    if (_menus && ourMenuOpen()) { try { _menus.refresh(); } catch (e) {} }
  }

  function onDocClick(e) {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const b = t.closest('button[aria-label="Options…"], button[aria-label="Options..."]');
    if (!b) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openMenu();
  }
  addEventListener('click', onDocClick, true);

  function sensMult() { return Math.max(0.1, Math.min(5, Number(bus.get('input.sens', 1)) || 1)); }
  addEventListener('mousemove', (e) => {
    const m = sensMult();
    if (m === 1) return;
    const gl = document.getElementById('gl');
    if (!gl || document.pointerLockElement !== gl) return;
    try {
      Object.defineProperty(e, 'movementX', { value: e.movementX * m, configurable: true });
      Object.defineProperty(e, 'movementY', { value: e.movementY * m, configurable: true });
    } catch (err) {}
  }, true);

  applyUiScale();
  ensureCSS();
  let patchTries = 0;
  const tryPatch = () => Promise.all([patchHudScale(), patchSurvivalScale()]).then(() => {
    if ((!hudPatched || !survPatched) && ++patchTries < 10) setTimeout(tryPatch, 300);
  });
  domReady().then(() => { ensureCSS(); tryPatch(); startLabelObserver(); });
  addEventListener('resize', () => { applyUiScale(); setTimeout(applyUiScale, 0); });
  uiTimer = setInterval(reassertUiScale, 250);
  addEventListener('fullscreenchange', () => refresh());

  console.info(TAG, 'loaded. Open it from the pause menu\'s "Options…" button.');
})();
