// ==UserScript==
// @name         Tweetcraft Chat History
// @namespace    tweetcraft.twitterentary
// @version      1.0.0
// @description  Minecraft-style chat history: press Up and Down to recall previously sent messages and commands.
// @author       Twitterentary
// @match        https://tweetcraft.jai.vin/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const MAX = 100;

  const hist = [];
  let cursor = 0;
  let draft = '';
  let tracking = false;

  const box = () => document.getElementById('chatbox');

  function chatOpen() {
    const cb = box();
    return !!cb && !cb.hidden;
  }

  function reset() {
    cursor = hist.length;
    draft = '';
    tracking = false;
  }

  function record(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return;
    if (hist.length && hist[hist.length - 1] === t) return;
    hist.push(t);
    while (hist.length > MAX) hist.shift();
    reset();
  }

  function setValue(v) {
    const cb = box();
    if (!cb) return;
    cb.value = v;
    try { cb.setSelectionRange(v.length, v.length); } catch (e) {}
  }

  function up() {
    if (!hist.length) return false;
    if (!tracking) { draft = (box() || {}).value || ''; tracking = true; cursor = hist.length; }
    if (cursor > 0) cursor--;
    setValue(hist[cursor]);
    return true;
  }

  function down() {
    if (!tracking) return false;
    if (cursor < hist.length) cursor++;
    setValue(cursor >= hist.length ? draft : hist[cursor]);
    return true;
  }

  addEventListener('focusin', e => {
    if (e.target && e.target.id === 'chatbox') reset();
  }, true);

  addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (!chatOpen()) return;

    if (e.key === 'Enter') {
      const cb = box();
      if (cb) record(cb.value);
      return;
    }

    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

    const key = e.key;
    queueMicrotask(() => {
      if (e.defaultPrevented) return;
      if (!chatOpen()) return;
      if (key === 'ArrowUp') up();
      else down();
    });
  }, true);

  window.__mcChatHistory = {
    get list() { return hist.slice(); },
    clear() { hist.length = 0; reset(); },
    record
  };
})();
