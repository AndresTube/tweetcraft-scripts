// ==UserScript==
// @name         Tweetcraft Minecraftizer
// @namespace    https://tweetcraft.jai.vin
// @version      1.0.0
// @description  Replaces TweetCraft textures with vanilla Minecraft textures for blocks, items, and the environment.
// @author       you
// @match        https://tweetcraft.jai.vin/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  if (!W.HTMLImageElement || !W.HTMLImageElement.prototype) return;

  const CFG = {
    version: '1.21.4',
    repo: 'PrismarineJS/minecraft-assets',
    branch: 'master',
    cdn: 'jsDelivr',
    base: null,
    concurrency: 16,
    timeoutMs: 15000,
    cache: true,
    categories: {
      block: true,
      environment: true,
      entity: true,
      item: true,
      itemAtlas: true,
      misc: true,
      gui: false,
      font: false,
    },
  };

  const BLOCK_ALIAS = {
    end_portal_frame_side_full: 'end_portal_frame_side',
    end_portal_frame_top_eye: 'end_portal_frame_eye',
    lantern_hanging: 'lantern',
    lantern_top: 'lantern',
  };

  const BLOCK_SKIP = new Set(['fire_0', 'fire_1', 'nether_portal', 'end_portal']);

  const MOON = ['full_moon', 'waning_gibbous', 'third_quarter', 'waning_crescent',
    'new_moon', 'waxing_crescent', 'first_quarter', 'waxing_gibbous'];

  function cdnURL(rel) {
    if (CFG.base) return CFG.base.replace(/\/$/, '') + '/' + rel;
    const root = CFG.cdn === 'rawGitHub'
      ? 'https://raw.githubusercontent.com/' + CFG.repo + '/' + CFG.branch
      : 'https://cdn.jsdelivr.net/gh/' + CFG.repo + '@' + CFG.branch;
    return root + '/data/' + CFG.version + '/' + rel;
  }

  let active = 0;
  const waiting = [];
  function slot() {
    return new Promise(resolve => {
      const start = () => { active++; resolve(() => { active--; pump(); }); };
      if (active < CFG.concurrency) start(); else waiting.push(start);
    });
  }
  function pump() { while (active < CFG.concurrency && waiting.length) waiting.shift()(); }

  async function fetchBlobURL(url) {
    const release = await slot();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CFG.timeoutMs);
    try {
      const r = await fetch(url, { mode: 'cors', credentials: 'omit', signal: ctrl.signal });
      if (!r.ok) { failed++; return null; }
      const b = await r.blob();
      if (!b || !b.size) { failed++; return null; }
      replaced++;
      return URL.createObjectURL(b);
    } catch (e) {
      failed++;
      return null;
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  const texCache = new Map();
  function loadCandidates(key, urls) {
    if (texCache.has(key)) return texCache.get(key);
    const p = (async () => {
      for (const u of urls) {
        const b = await fetchBlobURL(u);
        if (b) return b;
      }
      return null;
    })();
    if (CFG.cache) texCache.set(key, p);
    return p;
  }

  function loadImageEl(url) {
    return new Promise((resolve, reject) => {
      const img = new W.Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed: ' + url));
      img.src = url;
    });
  }

  let atlasP = null;
  function getItemAtlas() {
    if (atlasP) return atlasP;
    atlasP = (async () => {
      try {
        const [rects, blob] = await Promise.all([
          fetch('/assets/atlas/items.json').then(r => (r.ok ? r.json() : null)).catch(() => null),
          fetch('/assets/atlas/items.webp').then(r => (r.ok ? r.blob() : null)).catch(() => null),
        ]);
        if (!rects || !blob) return null;
        const bmp = await W.createImageBitmap(blob);
        const canvas = W.document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const g = canvas.getContext('2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(bmp, 0, 0);
        await Promise.all(Object.keys(rects).map(async key => {
          const url = await loadCandidates('i:' + key, [
            cdnURL('items/' + key + '.png'),
            cdnURL('blocks/' + key + '.png'),
            cdnURL('items/' + key + '_00.png'),
          ]);
          if (!url) return;
          try {
            const img = await loadImageEl(url);
            const [x, y, w, h] = rects[key];
            g.clearRect(x, y, w, h);
            g.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, x, y, w, h);
          } catch (e) {}
        }));
        return await new Promise(res => canvas.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/png'));
      } catch (e) {
        return null;
      }
    })();
    return atlasP;
  }

  let moonP = null;
  function getMoon(name) {
    const idx = MOON.indexOf(name);
    if (idx < 0) return Promise.resolve(null);
    if (!moonP) {
      moonP = (async () => {
        const url = await fetchBlobURL(cdnURL('environment/moon_phases.png'));
        if (!url) return null;
        const img = await loadImageEl(url);
        const cell = 16;
        const cols = Math.max(1, Math.floor(img.naturalWidth / cell));
        const out = [];
        for (let k = 0; k < 8; k++) {
          const c = W.document.createElement('canvas');
          c.width = c.height = cell;
          const g = c.getContext('2d');
          g.imageSmoothingEnabled = false;
          g.drawImage(img, (k % cols) * cell, Math.floor(k / cols) * cell, cell, cell, 0, 0, cell, cell);
          out.push(await new Promise(res => c.toBlob(b => res(b ? URL.createObjectURL(b) : null), 'image/png')));
        }
        return out;
      })();
    }
    return moonP.then(list => (list ? list[idx] : null));
  }

  function dedupe(list) { return list.filter((v, i) => v && list.indexOf(v) === i); }

  function mapGameAsset(v) {
    const at = v.indexOf('/assets/');
    if (at < 0) return null;
    let rest = v.slice(at + 8);
    const stop = rest.search(/[?#]/);
    if (stop >= 0) rest = rest.slice(0, stop);
    const seg = rest.split('/');
    const cat = seg[0];
    const file = seg[seg.length - 1];

    if (cat === 'atlas' && file === 'items.webp') {
      return CFG.categories.itemAtlas ? { kind: 'atlas' } : null;
    }

    if (cat === 'block') {
      if (!CFG.categories.block) return null;
      const name = file.replace(/\.png$/i, '');
      if (BLOCK_SKIP.has(name)) return null;
      const mc = BLOCK_ALIAS[name] || name;
      return { kind: 'tex', key: 'b:' + mc, cands: [cdnURL('blocks/' + mc + '.png')] };
    }

    if (cat === 'env') {
      if (seg[1] === 'moon') {
        return CFG.categories.environment ? { kind: 'moon', name: file.replace(/\.png$/i, '') } : null;
      }
      if (!CFG.categories.environment) return null;
      if (!['clouds.png', 'sun.png', 'rain.png', 'snow.png', 'end_sky.png'].includes(file)) return null;
      return { kind: 'tex', key: 'e:' + file, cands: [cdnURL('environment/' + file)] };
    }

    if (cat === 'entity') {
      if (!CFG.categories.entity) return null;
      if (file === 'steve.png') {
        return { kind: 'tex', key: 'steve', cands: [cdnURL('entity/player/wide/steve.png')] };
      }
      return null;
    }

    if (cat === 'item') {
      if (!CFG.categories.item) return null;
      const name = file.replace(/\.png$/i, '');
      return { kind: 'tex', key: 'i:' + name, cands: dedupe([cdnURL('items/' + name + '.png'), cdnURL('blocks/' + name + '.png')]) };
    }

    if (cat === 'misc') {
      if (!CFG.categories.misc) return null;
      const name = file.replace(/\.png$/i, '');
      return { kind: 'tex', key: 'm:' + name, cands: [cdnURL('misc/' + name + '.png')] };
    }

    if (cat === 'gui' || cat === 'font') {
      const name = file.replace(/\.png$/i, '');
      if (name === 'ascii') {
        if (!CFG.categories.font) return null;
        return { kind: 'tex', key: 'ascii', cands: [cdnURL('font/ascii.png')] };
      }
      if (!CFG.categories.gui) return null;
      const sub = seg.slice(1, -1).join('/');
      const cands = [];
      if (sub === 'inv') cands.push(cdnURL('gui/sprites/container/' + file));
      cands.push(cdnURL('gui/' + (sub ? sub + '/' : '') + file));
      if (sub) cands.push(cdnURL('gui/' + file));
      cands.push(cdnURL('gui/sprites/hud/' + file));
      cands.push(cdnURL('gui/sprites/widget/' + file));
      cands.push(cdnURL('gui/sprites/container/' + file));
      return { kind: 'tex', key: 'g:' + rest, cands: dedupe(cands) };
    }

    return null;
  }

  function resolveAsset(m) {
    if (m.kind === 'atlas') return getItemAtlas();
    if (m.kind === 'moon') return getMoon(m.name);
    return loadCandidates(m.key, m.cands);
  }

  const Native = Object.getOwnPropertyDescriptor(W.HTMLImageElement.prototype, 'src');
  if (!Native || !Native.set || !Native.get) return;

  let replaced = 0;
  let failed = 0;
  let swapped = 0;
  const origOf = new WeakMap();
  const blobOrig = new Map();

  Object.defineProperty(W.HTMLImageElement.prototype, 'src', {
    configurable: true,
    enumerable: Native.enumerable,
    get() {
      const cur = Native.get.call(this);
      if (cur && blobOrig.has(cur)) return blobOrig.get(cur);
      if (!cur) return origOf.get(this) || cur;
      return cur;
    },
    set(value) {
      if (typeof value !== 'string' || value.startsWith('data:') || value.startsWith('blob:')) {
        Native.set.call(this, value);
        return;
      }
      const mapping = mapGameAsset(value);
      if (!mapping) {
        Native.set.call(this, value);
        return;
      }
      origOf.set(this, value);
      resolveAsset(mapping).then(blobURL => {
        if (!blobURL) { Native.set.call(this, value); return; }
        blobOrig.set(blobURL, value);
        swapped++;
        Native.set.call(this, blobURL);
      }).catch(() => { Native.set.call(this, value); });
    },
  });

  W.__mcTextures = {
    config: CFG,
    stats() { return { requested: replaced + failed, replaced, failed, swapped }; },
    clearCache() { texCache.clear(); atlasP = null; moonP = null; },
    baseURL: cdnURL,
  };

  console.info('%c[TweetCraft Minecraftizer]%c active — Minecraft ' + CFG.version +
    ' textures via ' + CFG.cdn, 'color:#3fa34d;font-weight:bold', 'color:inherit');
})();
