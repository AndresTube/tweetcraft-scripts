// ==UserScript==
// @name         Tweetcraft WorldEdit
// @namespace    tweetcraft.twitterentary
// @version      1.0.0
// @author       andrestube123
// @description  WorldEdit-style building tools for creative worlds: selection, set, replace, copy, paste, rotate, and undo.
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__tcWE) return;

  const CFG = { rate: 20, maxVolume: 500000, axe: 259, reach: 96, history: 15 };
  window.__tcWE = { CFG };

  const DEFAULT_HOTBAR = [2, 3, 1, 4, 5, 6, 10, 11, 7];
  const DENY = new Set([12, 179, 186, 187, 207]);
  for (const [a, b] of [[95, 109], [150, 164], [166, 170], [189, 199], [208, 209]]) for (let i = a; i <= b; i++) DENY.add(i);
  for (const i of [166, 167, 168, 191, 192, 193, 194, 195, 196, 197, 198]) DENY.delete(i);

  const W = { x: null, mem: null, names: [], nb: 0, rayArgs: null };
  const net = { ws: null, send: () => {}, synced: false, sv: false, owner: false, op: false, lock: 0, slot: 0, hotbar: null };
  const sel = { p1: null, p2: null };
  const undoStack = [];
  const redoStack = [];
  let clip = null;
  let clip0 = null;
  let clipFace = 0;
  let job = null;

  const $ = id => document.getElementById(id);

  function cstr(p) {
    const b = new Uint8Array(W.mem.buffer);
    let q = p;
    while (b[q]) q++;
    return new TextDecoder().decode(b.subarray(p, q));
  }

  function variantNames(names, text) {
    for (const line of String(text || '').split('\n')) {
      const t = line.indexOf('\t');
      if (t > 0) names[+line.slice(0, t)] = line.slice(t + 1);
    }
    return names;
  }
  function bindEngine(ex) {
    W.x = ex;
    W.mem = ex.memory;
    W.nb = ex.nblocks();
    W.names = variantNames(cstr(ex.block_names()).split('\n'), ex.variant_names ? cstr(ex.variant_names()) : '');
    console.log('[Twitterentary WorldEdit] engine attached (' + W.nb + ' blocks)');
    say('WorldEdit ready. Type //help', '#55ff55');
  }

  const nativeInstantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (...args) {
    const res = await nativeInstantiate.apply(this, args);
    const inst = res && res.instance ? res.instance : res;
    const ex = inst && inst.exports;
    if (!ex || !ex.set_block || !ex.state_ptr || !ex.raycast || !ex.block_names) return res;
    const wrapped = {};
    for (const k of Object.keys(ex)) wrapped[k] = ex[k];
    wrapped.raycast = (...a) => {
      W.rayArgs = a.slice(0, 7);
      return ex.raycast(...a);
    };
    try { bindEngine(ex); } catch (e) { console.warn('[Twitterentary WorldEdit] bind failed', e); }
    const patched = { exports: wrapped };
    return res.instance ? { module: res.module, instance: patched } : patched;
  };

  const NativeWS = window.WebSocket;
  window.WebSocket = new Proxy(NativeWS, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      if (/\/ws\/[a-z0-9]{16}(\?|$)/.test(String(args[0] || ''))) attach(ws);
      return ws;
    }
  });

  function applySlot(st) {
    if (!st) return;
    if (Number.isInteger(st.slot) && st.slot >= 0 && st.slot <= 8) net.slot = st.slot;
    if (Array.isArray(st.hotbar) && st.hotbar.length === 9) net.hotbar = st.hotbar.slice();
  }

  function onMessage(m) {
    switch (m.t) {
      case 'welcome':
        net.sv = !!m.sv;
        net.owner = !!m.owner;
        net.op = !!m.op;
        net.lock = (m.room && m.room.lock) || 0;
        net.synced = false;
        applySlot(m.st);
        break;
      case 'synced': net.synced = true; break;
      case 'room': net.lock = (m.room && m.room.lock) || 0; break;
      case 'you': net.owner = !!m.owner; net.op = !!m.op; break;
      case 'place': applySlot(m.st); break;
      case 'sys':
        if (m.m) {
          window.__tcWE.lastSys = m.m;
          if (job && /out of date/i.test(m.m)) job.abort = true;
        }
        break;
      case 'placeack':
      case 'digack':
        if (W.x && Number.isInteger(m.x) && Number.isInteger(m.y) && Number.isInteger(m.z) &&
            Number.isInteger(m.b) && m.b >= 0 && m.b <= 255) {
          try { W.x.set_block(m.x, m.y, m.z, m.b); } catch {}
        }
        break;
    }
  }

  function attach(ws) {
    net.ws = ws;
    net.synced = false;
    const rawSend = ws.send.bind(ws);
    net.send = d => { if (ws.readyState === 1) rawSend(d); };
    ws.send = function (d) {
      if (typeof d === 'string' && d.charCodeAt(0) === 123) {
        try {
          const m = JSON.parse(d);
          if (m.t === 'inv') applySlot(m);
        } catch {}
      }
      captureAction(d);
      return rawSend(d);
    };
    ws.addEventListener('message', e => {
      if (typeof e.data !== 'string' || e.data.charCodeAt(0) !== 123) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      onMessage(m);
    });
    ws.addEventListener('close', () => { if (net.ws === ws) net.synced = false; });
  }

  function toast(text, ms = 1800) {
    try {
      const n = document.getElementById('note');
      if (!n) return;
      n.textContent = text;
      n.classList.add('show');
      clearTimeout(toast.t);
      toast.t = setTimeout(() => n.classList.remove('show'), ms);
    } catch (e) {}
  }

  function say(text) {
    const ws = net.ws;
    if (ws && ws.readyState === 1) {
      try {
        ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'sys', m: '[WE] ' + text }) }));
        return;
      } catch (e) {}
    }
    toast('[WE] ' + text);
  }

  const locked = () => document.pointerLockElement === $('gl');
  const chatOpen = () => { const c = $('chatbox'); return !!c && !c.hidden; };
  const active = () => locked() && !chatOpen();

  const gameState = () => (window.__mc && window.__mc.S) || null;

  function hotbar() {
    const S = gameState();
    if (S && Array.isArray(S.hotbar) && S.hotbar.length === 9) return S.hotbar.slice();
    try {
      const h = JSON.parse(localStorage.getItem('mc.hotbar'));
      if (Array.isArray(h) && h.length === 9) return h;
    } catch (e) {}
    if (Array.isArray(net.hotbar) && net.hotbar.length === 9) return net.hotbar.slice();
    return DEFAULT_HOTBAR.slice();
  }
  function slotId() {
    const S = gameState();
    if (S && Number.isInteger(S.slot) && S.slot >= 0 && S.slot <= 8) return S.slot;
    return net.slot;
  }
  const held = () => hotbar()[slotId()] || 0;

  function captureAction(d) {
    if (job) return;
    if (typeof d !== 'string' || d.charCodeAt(0) !== 123) return;
    if (!wandHeld()) return;
    let m;
    try { m = JSON.parse(d); } catch (e) { return; }
    if (m.t === 'dig' && m.s === 0 && Number.isInteger(m.x)) setPos('p1', [m.x, m.y, m.z]);
    else if (m.t === 'place' && Number.isInteger(m.x)) setPos('p2', [m.x, m.y, m.z]);
  }

  addEventListener('keydown', e => {
    if (e.repeat || !/^Digit[1-9]$/.test(e.code) || !active()) return;
    net.slot = Number(e.code[5]) - 1;
  }, true);

  let wheelAcc = 0;
  addEventListener('wheel', e => {
    if (e.target !== $('gl') || !active()) return;
    wheelAcc += e.deltaMode ? e.deltaY * 50 : e.deltaY;
    if (Math.abs(wheelAcc) >= 50) {
      net.slot = (net.slot + (wheelAcc > 0 ? 1 : -1) + 9) % 9;
      wheelAcc = 0;
    }
  }, { capture: true, passive: true });

  addEventListener('keydown', e => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || !active()) return;
    if (e.code === 'Comma') { e.preventDefault(); setPos('p1', aimedOrFeet()); }
    else if (e.code === 'Period') { e.preventDefault(); setPos('p2', aimedOrFeet()); }
    else if (e.code === 'Minus') { e.preventDefault(); sel.p1 = sel.p2 = null; say('Selection cleared.', '#aaaaaa'); }
  }, true);

  function stState() { return new Float64Array(W.mem.buffer, W.x.state_ptr(), 12); }
  function feet() {
    const st = stState();
    return [Math.floor(st[0]), Math.floor(st[1] + 1e-3), Math.floor(st[2])];
  }
  const fullAt = (x, y, z) => (W.x.get_full ? W.x.get_full(x, y, z) : W.x.get_block(x, y, z));
  const worldW = () => W.x.world_w();
  const worldH = () => W.x.world_h();
  const inWorld = (x, y, z) => x >= 0 && z >= 0 && x < worldW() && z < worldW() && y >= 1 && y < worldH();

  const S_LOW = 211, S_PER = 11, S_END = 211 + 11 * 4;
  const hiByte = id => (id >= 4096 ? (id >> 8) : 0);
  const loByte = id => (id & 255);
  const withHi = (lo, hi) => (hi ? (lo | (hi << 8)) : lo);
  const isStairSlab = id => loByte(id) >= S_LOW && loByte(id) < S_END;
  const stairSlot = id => ((loByte(id) - S_LOW) % S_PER + S_PER) % S_PER;
  const isStair = id => isStairSlab(id) && stairSlot(id) < 8;
  const isSlab = id => isStairSlab(id) && stairSlot(id) >= 8 && stairSlot(id) < 10;
  const isDoubleSlab = id => isStairSlab(id) && stairSlot(id) === 10;
  const YAW_FOR_LOOK = [0, Math.PI, Math.PI / 2, -Math.PI / 2];
  const ROT_FACING = [3, 2, 0, 1];

  function pasteable(id) {
    if (id === 0) return true;
    if (!Number.isInteger(id) || id < 0 || id > 32767 || (id & 255) === 255) return false;
    const lo = loByte(id);
    if (id < 4096) return lo < W.nb && !!W.names[id] && !DENY.has(id);
    if (W.names[id]) return true;
    const hi = id >> 8;
    if ((hi === 32 || hi === 33) && [6, 16, 72, 166].includes(lo)) return true;
    if (hi >= 16 && hi <= 18 && ((lo >= 211 && lo <= 221) || (lo >= 119 && lo <= 127))) return true;
    return false;
  }

  function desiredFaces(to) {
    if (isStair(to)) return stairSlot(to) >= 4 ? [0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 0];
    if (isStairSlab(to)) return stairSlot(to) === 9 ? [0, 1, 2, 3, 4, 5] : [1, 2, 3, 4, 5, 0];
    const hi = hiByte(to);
    if (hi === 32) return [4, 5, 1, 2, 3, 0];
    if (hi === 33) return [2, 3, 1, 4, 5, 0];
    return null;
  }

  const FLUID_ITEM = { 9: 307, 68: 308 };
  const FLUID_BLOCK = { 307: 9, 308: 68 };

  function placeSpec(to) {
    if (FLUID_ITEM[to]) return { held: FLUID_ITEM[to], yaw: 0 };
    if (isStair(to)) {
      const slot = stairSlot(to);
      return { held: withHi(loByte(to) - slot, hiByte(to)), yaw: YAW_FOR_LOOK[slot % 4] };
    }
    if (isStairSlab(to)) {
      const slot = stairSlot(to);
      return { held: withHi(loByte(to) - slot + 8, hiByte(to)), yaw: 0 };
    }
    const hi = hiByte(to);
    if (hi === 32 || hi === 33) return { held: loByte(to), yaw: 0 };
    return { held: to, yaw: 0 };
  }

  function rotBlock(id, quarter) {
    if (!id || !quarter) return id;
    quarter = ((quarter % 4) + 4) % 4;
    if (isStair(id)) {
      const slot = stairSlot(id), facing = slot % 4, top = slot >= 4 ? 4 : 0;
      let nf = facing;
      for (let k = 0; k < quarter; k++) nf = ROT_FACING[nf];
      return withHi(loByte(id) - facing + nf, hiByte(id));
    }
    if (quarter % 2 === 1) {
      const hi = hiByte(id);
      if (hi === 32) return withHi(loByte(id), 33);
      if (hi === 33) return withHi(loByte(id), 32);
    }
    return id;
  }
  function rotClip(src, quarter) {
    quarter = ((quarter % 4) + 4) % 4;
    const out = new Int32Array(src.length);
    for (let i = 0; i < src.length; i += 4) {
      let x = src[i], z = src[i + 2];
      for (let k = 0; k < quarter; k++) { const nx = -z, nz = x; x = nx; z = nz; }
      out[i] = x; out[i + 1] = src[i + 1]; out[i + 2] = z; out[i + 3] = quarter ? rotBlock(src[i + 3], quarter) : src[i + 3];
    }
    return out;
  }

  const netOp = { seq: 0, held: -1, realBar: null, realSlot: 0 };
  const FACE_N = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
  const SUPPORT_ORDER = [1, 4, 5, 2, 3, 0];

  function sendPos(x, y, z, flags = 2, yaw = 0) {
    const buf = new ArrayBuffer(18);
    const dv = new DataView(buf);
    dv.setUint8(0, 1);
    dv.setFloat32(1, x, true);
    dv.setFloat32(5, y, true);
    dv.setFloat32(9, z, true);
    dv.setInt16(13, Math.max(-32768, Math.min(32767, Math.round(yaw * 1e4))), true);
    dv.setInt16(15, 0, true);
    dv.setUint8(17, flags);
    net.send(buf);
  }
  function sendRealPos() {
    if (!W.x) return;
    const st = stState();
    sendPos(st[0], st[1], st[2], 0);
  }
  function setHeldBlock(id) {
    if (netOp.held === id) return;
    if (netOp.held === -1) {
      netOp.realBar = hotbar();
      netOp.realSlot = slotId();
    }
    netOp.held = id;
    const hb = netOp.realBar.slice();
    hb[0] = id;
    net.send(JSON.stringify({ t: 'inv', hotbar: hb, slot: 0 }));
  }
  function restoreHeld() {
    if (netOp.held === -1) return;
    netOp.held = -1;
    const hb = netOp.realBar;
    if (!hb) return;
    netOp.realBar = null;
    try { net.send(JSON.stringify({ t: 'inv', hotbar: hb, slot: netOp.realSlot })); } catch (e) {}
  }

  function findSupport(x, y, z, faces) {
    const order = faces && faces.length ? faces : SUPPORT_ORDER;
    for (const f of order) {
      const n = FACE_N[f];
      const tx = x - n[0], ty = y - n[1], tz = z - n[2];
      if (!inWorld(tx, ty, tz)) continue;
      const b = fullAt(tx, ty, tz);
      if (b > 0) return { tx, ty, tz, f };
    }
    return null;
  }

  function opDig(x, y, z) {
    netOp.seq++;
    sendPos(x + 0.5, Math.min(worldH() - 1, y + 3), z + 0.5);
    net.send(JSON.stringify({ t: 'dig', s: 0, x, y, z, f: 1, i: netOp.seq }));
  }
  function opPlace(x, y, z, id, sup) {
    netOp.seq++;
    const spec = placeSpec(id);
    setHeldBlock(spec.held);
    sendPos(sup.tx + 0.5, Math.min(worldH() - 1, sup.ty + 3), sup.tz + 0.5, 2, spec.yaw);
    net.send(JSON.stringify({ t: 'place', x: sup.tx, y: sup.ty, z: sup.tz, f: sup.f, i: netOp.seq, p: [x, y, z] }));
  }

  function netSet(x, y, z, old, to, sup) {
    if (old !== 0) opDig(x, y, z);
    if (to !== 0 && sup) opPlace(x, y, z, to, sup);
  }

  function verified() {
    try { const t = JSON.parse(localStorage.getItem('mc.tok')); return !!(t && t.handle); } catch { return false; }
  }
  function canBuild() {
    if (net.lock === 2) return net.owner || net.op;
    if (net.lock === 1) return net.owner || net.op || verified();
    return true;
  }
  function gate() {
    if (!W.x) { say('Engine not attached. Reload the page.', '#ff5555'); return false; }
    if (!net.ws || net.ws.readyState !== 1 || !net.synced) { say('Not connected yet.', '#ff5555'); return false; }
    if (!canBuild()) { say('You cannot build in this world.', '#ff5555'); return false; }
    if (job) { say('Busy: ' + job.label + ' (//cancel to stop)', '#ffaa00'); return false; }
    return true;
  }

  function validBlock(id) {
    return Number.isInteger(id) && id >= 0 && id < 255 && id < W.nb && !!W.names[id] && !DENY.has(id);
  }
  function parseBlock(s) {
    s = String(s || '').trim().toLowerCase().replace(/_+/g, ' ');
    if (!s) return -1;
    const alias = /^(.*\S)\s+(source|flowing|flow|level)$/.exec(s);
    if (alias) {
      const base = parseBlock(alias[1]);
      if (base >= 0) return base;
    }
    if (/^\d+$/.test(s)) return validBlock(+s) ? +s : -1;
    const starts = [];
    const incl = [];
    for (let i = 0; i < Math.min(W.nb, 255); i++) {
      const n = W.names[i];
      if (!n || n.includes('(') || !validBlock(i)) continue;
      const l = n.toLowerCase();
      if (l === s) return i;
      if (l.startsWith(s)) starts.push(i); else if (l.includes(s)) incl.push(i);
    }
    const pool = starts.length ? starts : incl;
    return pool.length === 1 ? pool[0] : pool.length > 1 ? -2 : -1;
  }
  const WATER_FAMILY = new Set([9, 96, 97, 98, 99, 100, 101, 102, 103]);
  const LAVA_FAMILY = new Set([68, 104, 105, 106, 107]);
  const fluidSourceOf = f => (WATER_FAMILY.has(f) ? 9 : LAVA_FAMILY.has(f) ? 68 : 0);
  function sameFrom(f, from) {
    const src = fluidSourceOf(from);
    if (src) return fluidSourceOf(f) === src;
    return f === from;
  }
  function fromMatcher(str) {
    const ms = [];
    for (const part of String(str).split(',')) {
      const raw = part.trim().toLowerCase().replace(/_+/g, ' ');
      if (!raw) continue;
      const id = parseBlock(raw);
      if (id === -2) { say('"' + part.trim() + '" is ambiguous.', '#ff5555'); return null; }
      if (id < 0) { say('Unknown or disallowed block: ' + part.trim(), '#ff5555'); return null; }
      const mode = /\bsource$/.test(raw) ? 'source' : /\b(flowing|flow)$/.test(raw) ? 'flowing' : 'family';
      ms.push({ id, mode });
    }
    if (!ms.length) { say('No match block given.', '#ff5555'); return null; }
    return f => {
      for (const m of ms) {
        const src = fluidSourceOf(m.id);
        if (src && m.mode === 'source') { if (f === m.id) return true; continue; }
        if (src && m.mode === 'flowing') { if (fluidSourceOf(f) === src && f !== m.id) return true; continue; }
        if (sameFrom(f, m.id)) return true;
      }
      return false;
    };
  }

  function parsePattern(str) {
    const entries = [];
    for (const raw of String(str).split(',')) {
      const t = raw.trim();
      if (!t) continue;
      let name = t, weight = 1, m;
      if ((m = /^(.+?)\s*\*\s*(\d+(?:\.\d+)?)$/.exec(t))) { name = m[1].trim(); weight = parseFloat(m[2]); }
      else if ((m = /^(\d+(?:\.\d+)?)\s*%\s*(.+)$/.exec(t))) { weight = parseFloat(m[1]); name = m[2].trim(); }
      const id = parseBlock(name);
      if (id < 0) return { error: id, name };
      if (!(weight > 0) || !Number.isFinite(weight)) weight = 1;
      entries.push([id, weight]);
    }
    return { entries };
  }
  function makePicker(pat) {
    const e = pat.entries;
    if (e.length === 1) { const only = e[0][0]; return () => only; }
    let total = 0;
    const cum = new Float64Array(e.length);
    for (let i = 0; i < e.length; i++) { total += e[i][1]; cum[i] = total; }
    return () => {
      const r = Math.random() * total;
      for (let i = 0; i < cum.length; i++) if (r < cum[i]) return e[i][0];
      return e[e.length - 1][0];
    };
  }
  function fillArg(str) {
    if (str === undefined) {
      const h = held();
      const id = FLUID_BLOCK[h] || h;
      if (!id || !validBlock(id)) { say('Hold a block or type its name (//set stone).', '#ff5555'); return null; }
      return { pick: () => id, label: W.names[id] };
    }
    if (/[,*%]/.test(str)) {
      const pat = parsePattern(str);
      if (pat.error === -2) { say('"' + pat.name + '" is ambiguous.', '#ff5555'); return null; }
      if (pat.error) { say('Unknown or disallowed block: ' + pat.name, '#ff5555'); return null; }
      if (!pat.entries.length) { say('Empty pattern.', '#ff5555'); return null; }
      return { pick: makePicker(pat), label: str.trim() };
    }
    const id = parseBlock(str);
    if (id === -2) { say('"' + str + '" is ambiguous.', '#ff5555'); return null; }
    if (id < 0) { say('Unknown or disallowed block: ' + str, '#ff5555'); return null; }
    return { pick: () => id, label: W.names[id] };
  }

  function bounds() {
    if (!sel.p1 || !sel.p2) return null;
    const a = sel.p1;
    const b = sel.p2;
    const lo = [0, 1, 2].map(i => Math.min(a[i], b[i]));
    const hi = [0, 1, 2].map(i => Math.max(a[i], b[i]));
    return { lo, hi, n: (hi[0] - lo[0] + 1) * (hi[1] - lo[1] + 1) * (hi[2] - lo[2] + 1) };
  }
  function setPos(which, p) {
    sel[which] = p;
    const b = bounds();
    say('Pos' + (which === 'p1' ? 1 : 2) + ': ' + p.join(', ') + (b ? ' (' + b.n + ' blocks)' : ''), '#55ffff');
  }
  function needSel() {
    const b = bounds();
    if (!b) { say('Select two positions first ( , and . keys, or //pos1 //pos2).', '#ff5555'); return null; }
    if (b.n > CFG.maxVolume) { say('Selection too large (' + b.n + '). Limit ' + CFG.maxVolume + '.', '#ff5555'); return null; }
    return b;
  }
  function scan(b, fn) {
    const out = [];
    const Wd = worldW();
    const H = worldH();
    for (let x = Math.max(0, b.lo[0]); x <= Math.min(Wd - 1, b.hi[0]); x++)
      for (let y = Math.max(1, b.lo[1]); y <= Math.min(H - 1, b.hi[1]); y++)
        for (let z = Math.max(0, b.lo[2]); z <= Math.min(Wd - 1, b.hi[2]); z++) {
          const to = fn(x, y, z);
          if (to >= 0) out.push(x, y, z, to);
        }
    return Int32Array.from(out);
  }

  function aim() {
    const a = W.rayArgs;
    if (!a || !W.x) return null;
    const ray = new Int32Array(W.mem.buffer, W.x.ray_ptr(), 8);
    const keep = Int32Array.from(ray);
    const hit = W.x.raycast(a[0], a[1], a[2], a[3], a[4], a[5], CFG.reach) === 1;
    const r = hit ? [ray[1], ray[2], ray[3]] : null;
    ray.set(keep);
    return r;
  }

  function wandHeld() {
    if (held() === CFG.axe) return true;
    const n = W.names && W.names[held()];
    return !!n && /axe/i.test(n);
  }

  function targetBlock() {
    const S = gameState();
    if (S && S.sel && Number.isInteger(S.sel.x)) return [S.sel.x, S.sel.y, S.sel.z];
    return aim();
  }

  function aimedOrFeet() {
    const t = targetBlock();
    return t || feet();
  }
  function parseNum(tok, base) {
    if (tok === undefined) return null;
    if (tok[0] === '~') {
      const o = tok.length > 1 ? parseInt(tok.slice(1), 10) : 0;
      return Number.isFinite(o) ? base + o : null;
    }
    const v = parseInt(tok, 10);
    return Number.isFinite(v) ? v : null;
  }
  function parseCoords(a, base) {
    if (a.length < 3) return null;
    const x = parseNum(a[0], base[0]);
    const y = parseNum(a[1], base[1]);
    const z = parseNum(a[2], base[2]);
    if (x === null || y === null || z === null) return null;
    return [x, y, z];
  }
  function wrapSel(lo, hi) {
    const w = worldW(), h = worldH();
    sel.p1 = [Math.max(0, Math.min(w - 1, lo[0])), Math.max(1, Math.min(h - 1, lo[1])), Math.max(0, Math.min(w - 1, lo[2]))];
    sel.p2 = [Math.max(0, Math.min(w - 1, hi[0])), Math.max(1, Math.min(h - 1, hi[1])), Math.max(0, Math.min(w - 1, hi[2]))];
    const b = bounds();
    say('Selection: ' + sel.p1.join(', ') + ' .. ' + sel.p2.join(', ') + (b ? ' (' + b.n + ' blocks)' : ''), '#55ffff');
  }

  let lastPick = 0;
  function tryPick(e) {
    if (!wandHeld() || (e.button !== 0 && e.button !== 2)) return;
    const gl = $('gl');
    if (document.pointerLockElement !== gl && e.target !== gl) return;
    const p = targetBlock();
    if (!p) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const now = performance.now();
    if (now - lastPick < 50) return;
    lastPick = now;
    setPos(e.button === 2 ? 'p2' : 'p1', p);
  }
  addEventListener('pointerdown', tryPick, true);
  addEventListener('mousedown', tryPick, true);

  addEventListener('contextmenu', e => {
    if (!wandHeld()) return;
    const gl = $('gl');
    if (document.pointerLockElement !== gl && e.target !== gl) return;
    const p = targetBlock();
    if (!p) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const now = performance.now();
    if (now - lastPick < 50) return;
    lastPick = now;
    setPos('p2', p);
  }, true);

  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const cellKey = (x, y, z) => ((x * 2048) + z) * 256 + y;

  function planOps(list) {
    const n = list.length / 4;
    const index = new Map();
    const overlay = new Map();
    const ops = [];
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const x = list[o], y = list[o + 1], z = list[o + 2], to = list[o + 3];
      if (to === 0) { overlay.set(cellKey(x, y, z), 0); ops.push(x, y, z, 0, 0); }
      else index.set(cellKey(x, y, z), o);
    }
    if (!index.size) return Int32Array.from(ops);

    const solid = (x, y, z) => {
      const k = cellKey(x, y, z);
      const ov = overlay.get(k);
      if (ov !== undefined) return ov > 0;
      if (index.has(k)) return false;
      if (!inWorld(x, y, z)) return false;
      const b = fullAt(x, y, z);
      return b > 0;
    };
    const supported = (x, y, z) => {
      for (const d of N6) if (solid(x + d[0], y + d[1], z + d[2])) return true;
      return false;
    };

    let scafId = 1;
    if (!validBlock(scafId)) { scafId = 0; for (let i = 1; i < W.nb; i++) if (validBlock(i)) { scafId = i; break; } }
    const pillar = [];

    const queue = [];
    for (const [k, o] of index) if (supported(list[o], list[o + 1], list[o + 2])) queue.push(k);

    let guard = index.size * 4 + 32;
    while (index.size && guard-- > 0) {
      if (queue.length) {
        const k = queue.pop();
        const o = index.get(k);
        if (o === undefined) continue;
        index.delete(k);
        const x = list[o], y = list[o + 1], z = list[o + 2], to = list[o + 3];
        overlay.set(k, to);
        ops.push(x, y, z, to, 0);
        for (const d of N6) {
          const nx = x + d[0], ny = y + d[1], nz = z + d[2];
          const nk = cellKey(nx, ny, nz);
          if (index.has(nk) && supported(nx, ny, nz)) queue.push(nk);
        }
      } else {
        let bestK = -1, bestY = 1e9, bestX = 1e9;
        for (const [k, o] of index) {
          const y = list[o + 1], x = list[o];
          if (y < bestY || (y === bestY && x < bestX)) { bestY = y; bestX = x; bestK = k; }
        }
        if (bestK < 0) break;
        const o = index.get(bestK);
        const x = list[o], y = list[o + 1], z = list[o + 2];
        let sy = -1;
        for (let yy = y - 1; yy >= 1; yy--) if (solid(x, yy, z)) { sy = yy; break; }
        if (sy < 0) { index.delete(bestK); continue; }
        for (let yy = sy + 1; yy < y; yy++) {
          overlay.set(cellKey(x, yy, z), scafId);
          ops.push(x, yy, z, scafId, 1);
          pillar.push(x, yy, z);
        }
        queue.push(bestK);
      }
    }
    for (let s = pillar.length - 3; s >= 0; s -= 3) ops.push(pillar[s], pillar[s + 1], pillar[s + 2], 0, 1);
    return Int32Array.from(ops);
  }

  function startJob(label, list, mode) {
    if (!list.length) { say(label + ': nothing to change.', '#ffaa00'); return; }
    const planned = planOps(list);
    if (!planned.length) { say(label + ': nothing to change.', '#ffaa00'); return; }
    job = { label, list: planned, i: 0, n: planned.length / 5, log: [], skipped: 0, failed: 0, nosup: 0, abort: false, mode, t0: performance.now(), lastToast: 0 };
    say(label + ': ' + job.n + ' blocks queued...', '#aaaaaa');
    toast(label + '…');
  }

  function finish() {
    const j = job;
    job = null;
    sendRealPos();
    restoreHeld();
    const changed = j.log.length / 5;
    if (changed) {
      const rec = { label: j.label, log: j.log };
      if (j.mode === 'undo') redoStack.push(rec);
      else {
        undoStack.push(rec);
        if (j.mode === 'new') redoStack.length = 0;
        if (undoStack.length > CFG.history) undoStack.shift();
      }
    }
    let msg = j.label + ': ' + changed + ' changed in ' + ((performance.now() - j.t0) / 1000).toFixed(1) + 's';
    if (j.skipped) msg += ', ' + j.skipped + ' skipped';
    if (j.nosup) msg += ', ' + j.nosup + ' with no support';
    if (j.failed) msg += ', ' + j.failed + ' failed';
    say(msg, (j.failed || j.nosup || j.abort) ? '#ffaa00' : '#55ff55');
    toast(j.label + ': ' + changed + ' blocks', 2600);
    if (j.abort && window.__tcWE.lastSys) say('Server: ' + window.__tcWE.lastSys, '#ff5555');
  }

  setInterval(() => {
    if (!job) return;
    if (!W.x || !net.ws || net.ws.readyState !== 1) return;
    job.acc = (job.acc || 0) + Math.max(1, Math.min(20000, CFG.rate)) / 20;
    let per = Math.floor(job.acc);
    job.acc -= per;
    const L = job.list;
    let n = 0;
    while (n < per && job.i < job.n) {
      const o = job.i++ * 5;
      const x = L[o], y = L[o + 1], z = L[o + 2], to = L[o + 3], scaf = L[o + 4];
      if (!pasteable(to) && to !== 0) { job.skipped++; continue; }
      if (!inWorld(x, y, z)) { job.skipped++; continue; }
      const old = fullAt(x, y, z);
      if (old === to) continue;
      const sup = to !== 0 ? findSupport(x, y, z, desiredFaces(to)) : null;
      if (to !== 0 && !sup) { job.nosup++; continue; }
      if (W.x.set_block(x, y, z, to) === -1) { job.failed++; continue; }
      netSet(x, y, z, old, to, sup);
      if (!scaf) job.log.push(x, y, z, old, to);
      n++;
    }
    const now = performance.now();
    if (now - job.lastToast > 250) {
      job.lastToast = now;
      toast(job.label + ' ' + Math.floor(job.i / job.n * 100) + '%');
    }
    if (job.i >= job.n || job.abort) finish();
  }, 50);

  function reverseList(log) {
    const out = new Int32Array(log.length / 5 * 4);
    let k = 0;
    for (let o = log.length - 5; o >= 0; o -= 5) {
      out[k++] = log[o]; out[k++] = log[o + 1]; out[k++] = log[o + 2]; out[k++] = log[o + 3];
    }
    return out;
  }

  const HELP = [
    'SELECT (any of these):',
    '  , = pos1, . = pos2 at the block you look at (or the one you stand on), - = clear',
    '  Wooden Axe: left click = pos1, right click = pos2',
    '  //pos1 //pos2 = at your feet   //hpos1 //hpos2 = at the aimed block',
    '  //pos1 x y z  or  //pos1 ~1 ~ ~-3  (relative to feet)',
    '  //box <r> = r-block cube around you   //expand <n> [up|down|north|south|east|west]',
    'EDIT:',
    '//set [block]   (no argument uses the held block)',
    '//replace [from] <to>   (no "from" = everything but air; from may be a list)',
    '  random mix: //set granite,bricks   //set granite*3,bricks   //set 70%granite,30%bricks',
    '  (commas = equal chance; *N or N% sets a weight. Also works for //replace <to> and //walls)',
    '  water & lava work: //set water  //replace water air  //replace stone lava',
    '  fluids are placed with a bucket; "//replace water" clears the whole pool,',
    '  "water_source" only the source block, "water_flowing" only the flowing part',
    '//walls [block]  //cut  //copy  //paste [-a]',
    '//facing north|south|east|west  //rotate <deg>  (turn the copied build)',
    '//undo //redo //cancel //speed <blocks/s> //desel //size',
    'Use underscores for spaces: oak_planks',
    'Speed is blocks/s (default 20). Edits use the server place/dig protocol.'
  ];

  function command(text) {
    const parts = text.slice(2).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const a = parts;
    if (!cmd) return;
    switch (cmd) {
      case 'help':
      case '?':
        HELP.forEach(l => say(l, '#aaaaaa'));
        break;
      case 'wand':
        say('Hold the Wooden Axe (E > Tools & Combat). Or select without it: press , for pos1 and . for pos2, or use //pos1 //pos2 / //hpos1 //hpos2.', '#aaaaaa');
        break;
      case 'pos1':
      case 'p1': {
        const c = parseCoords(a, feet());
        setPos('p1', c || feet());
        break;
      }
      case 'pos2':
      case 'p2': {
        const c = parseCoords(a, feet());
        setPos('p2', c || feet());
        break;
      }
      case 'hpos1': {
        const t = targetBlock();
        if (!t) { say('Look at a block first.', '#ff5555'); break; }
        setPos('p1', t);
        break;
      }
      case 'hpos2': {
        const t = targetBlock();
        if (!t) { say('Look at a block first.', '#ff5555'); break; }
        setPos('p2', t);
        break;
      }
      case 'box':
      case 'cube': {
        const r = Math.max(0, parseInt(a[0], 10) || 0);
        const f = feet();
        wrapSel([f[0] - r, f[1] - r, f[2] - r], [f[0] + r, f[1] + r, f[2] + r]);
        break;
      }
      case 'expand': {
        const b = bounds();
        if (!b) { say('Select a region first.', '#ff5555'); break; }
        const n = parseInt(a[0], 10);
        if (!Number.isFinite(n)) { say('Usage: //expand <amount> [up|down|north|south|east|west] (negative shrinks)', '#ff5555'); break; }
        const d = (a[1] || 'all').toLowerCase();
        let lo = b.lo.slice(), hi = b.hi.slice();
        if (d === 'all') { lo = [lo[0] - n, lo[1] - n, lo[2] - n]; hi = [hi[0] + n, hi[1] + n, hi[2] + n]; }
        else if (d === 'up') hi[1] += n; else if (d === 'down') lo[1] -= n;
        else if (d === 'east') hi[0] += n; else if (d === 'west') lo[0] -= n;
        else if (d === 'south') hi[2] += n; else if (d === 'north') lo[2] -= n;
        else { say('Unknown direction: ' + d, '#ff5555'); break; }
        wrapSel(lo, hi);
        break;
      }
      case 'desel':
      case 'sel':
        sel.p1 = sel.p2 = null;
        say('Selection cleared.', '#aaaaaa');
        break;
      case 'size': {
        const b = bounds();
        if (!b) { say('No selection.', '#ff5555'); break; }
        say((b.hi[0] - b.lo[0] + 1) + ' x ' + (b.hi[1] - b.lo[1] + 1) + ' x ' + (b.hi[2] - b.lo[2] + 1) + ' = ' + b.n + ' blocks', '#55ffff');
        break;
      }
      case 'speed': {
        const n = parseInt(a[0], 10);
        if (!n) { say('Current speed: ' + CFG.rate + ' blocks/s', '#aaaaaa'); break; }
        CFG.rate = Math.max(1, Math.min(20000, n));
        say('Speed: ' + CFG.rate + ' blocks/s');
        if (CFG.rate > 20) {
          say('Heads up: above 20 blocks/s the server may drop some edits, so a few blocks might not be placed. Lower //speed if you need every block.', '#ffaa00');
        }
        break;
      }
      case 'cancel':
        if (!job) { say('Nothing running.', '#aaaaaa'); break; }
        job.i = job.n;
        finish();
        break;
      case 'set': {
        if (!gate()) break;
        const b = needSel();
        if (!b) break;
        const fill = fillArg(a[0]);
        if (!fill) break;
        startJob('set ' + fill.label, scan(b, () => fill.pick()), 'new');
        break;
      }
      case 'walls': {
        if (!gate()) break;
        const b = needSel();
        if (!b) break;
        const fill = fillArg(a[0]);
        if (!fill) break;
        const [x0, y0, z0] = b.lo;
        const [x1, y1, z1] = b.hi;
        startJob('walls ' + fill.label, scan(b, (x, y, z) => (x === x0 || x === x1 || z === z0 || z === z1 ? fill.pick() : -1)), 'new');
        break;
      }
      case 'replace':
      case 'rep': {
        if (!gate()) break;
        const b = needSel();
        if (!b) break;
        if (!a.length) { say('Usage: //replace [from] <to>', '#ff5555'); break; }
        let from = null;
        if (a.length > 1) {
          from = fromMatcher(a[0]);
          if (!from) break;
        }
        const to = fillArg(a[a.length - 1]);
        if (!to) break;
        startJob('replace -> ' + to.label, scan(b, (x, y, z) => {
          const f = fullAt(x, y, z);
          if (!from) return f !== 0 ? to.pick() : -1;
          return from(f) ? to.pick() : -1;
        }), 'new');
        break;
      }
      case 'copy':
      case 'cut': {
        if (!W.x) break;
        const b = needSel();
        if (!b) break;
        const f = feet();
        const blocks = [];
        for (let x = b.lo[0]; x <= b.hi[0]; x++)
          for (let y = Math.max(1, b.lo[1]); y <= b.hi[1]; y++)
            for (let z = b.lo[2]; z <= b.hi[2]; z++)
              if (inWorld(x, y, z)) blocks.push(x - f[0], y - f[1], z - f[2], fullAt(x, y, z));
        clip = Int32Array.from(blocks);
        clip0 = clip;
        clipFace = 0;
        say('Copied ' + clip.length / 4 + ' blocks (relative to your feet).');
        if (cmd === 'cut') {
          if (!gate()) break;
          startJob('cut', scan(b, () => 0), 'new');
        }
        break;
      }
      case 'paste': {
        if (!clip) { say('Nothing copied (//copy first).', '#ff5555'); break; }
        if (!gate()) break;
        const f = feet();
        const skipAir = a.includes('-a');
        const out = [];
        for (let i = 0; i < clip.length; i += 4) {
          const x = f[0] + clip[i], y = f[1] + clip[i + 1], z = f[2] + clip[i + 2], id = clip[i + 3];
          if (!inWorld(x, y, z) || (skipAir && id === 0)) continue;
          out.push(x, y, z, id);
        }
        startJob('paste', Int32Array.from(out), 'new');
        break;
      }
      case 'facing':
      case 'face': {
        if (!clip0) { say('Nothing copied (//copy first).', '#ff5555'); break; }
        if (!a.length) { say('Clipboard faces ' + ['north', 'east', 'south', 'west'][clipFace] + '. Usage: //facing north|south|east|west', '#aaaaaa'); break; }
        const dirs = { north: 0, n: 0, east: 1, e: 1, south: 2, s: 2, west: 3, w: 3 };
        const q = dirs[a[0].toLowerCase()];
        if (q === undefined) { say('Direction must be north, south, east or west.', '#ff5555'); break; }
        clipFace = q;
        clip = q ? rotClip(clip0, q) : clip0;
        say('Clipboard rotated to face ' + a[0].toLowerCase() + '. Paste to apply.', '#55ffff');
        break;
      }
      case 'rotate': {
        if (!clip0) { say('Nothing copied (//copy first).', '#ff5555'); break; }
        const deg = parseInt(a[0], 10);
        if (!Number.isFinite(deg)) { say('Usage: //rotate <degrees> (e.g. 90, 180, 270)', '#ff5555'); break; }
        const q = (((Math.round(deg / 90) % 4) + 4) % 4);
        clipFace = (clipFace + q) % 4;
        clip = q ? rotClip(clip, q) : clip;
        say('Clipboard rotated ' + (q * 90) + '°.', '#55ffff');
        break;
      }
      case 'undo': {
        if (!gate()) break;
        const h = undoStack.pop();
        if (!h) { say('Nothing to undo.', '#ffaa00'); break; }
        startJob('undo ' + h.label, reverseList(h.log), 'undo');
        break;
      }
      case 'redo': {
        if (!gate()) break;
        const h = redoStack.pop();
        if (!h) { say('Nothing to redo.', '#ffaa00'); break; }
        startJob('redo ' + h.label, reverseList(h.log), 'redo');
        break;
      }
      default:
        say('Unknown command: //' + cmd + '. Try //help', '#ff5555');
    }
  }

  addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing || !chatOpen()) return;
    const cb = $('chatbox');
    const t = ((cb && cb.value) || '').trim();
    if (!t.startsWith('//')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    setTimeout(() => { command(t); closeChat(); }, 0);
  }, true);

  function closeChat() {
    const S = window.__mc && window.__mc.S;
    const cb = $('chatbox');
    try {
      if (S) S.chatOpen = false;
      if (cb) { cb.hidden = true; cb.blur(); cb.value = ''; }
      const gl = $('gl');
      if (gl && document.pointerLockElement !== gl && gl.requestPointerLock) gl.requestPointerLock();
    } catch (e) {}
  }

})();
