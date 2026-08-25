/*
 * Streaming scroll behaviour in public/app.js.
 *
 * app.js is written for a browser, so it runs here inside a vm context with a
 * DOM shim just rich enough to load it and fire scroll events. The shim models
 * scrollTop/scrollHeight arithmetic, not real layout — it proves the follow
 * logic, not the visual result.
 */
'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ---------------------------------------------------------- DOM shim --- */

const listeners = new Map();

function makeEl(id) {
  const node = {
    id,
    tagName: 'DIV',
    textContent: '',
    innerHTML: '',
    value: '',
    hidden: false,
    title: '',
    type: '',
    dataset: {},
    style: {},
    children: [],
    isConnected: true,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(type, fn) {
      if (!listeners.has(node)) listeners.set(node, {});
      const m = listeners.get(node);
      (m[type] = m[type] || []).push(fn);
    },
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { node.children.push(...kids); },
    insertAdjacentElement(_, kid) { node.children.push(kid); return kid; },
    remove() { node.isConnected = false; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollTo(opts) { node.scrollTop = opts.top; },
    focus() {},
    showModal() {},
    close() {},
  };
  return node;
}

const nodes = new Map();
const byId = (id) => {
  if (!nodes.has(id)) nodes.set(id, makeEl(id));
  return nodes.get(id);
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  crypto: { randomUUID: () => 'uuid-test' },
  fetch: async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    json: async () => ({ model: 'stealth/ox-alpha', backend: 'https://openrouter.ai/api' }),
  }),
  localStorage: {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  },
  navigator: { clipboard: { writeText: async () => {} } },
  renderMarkdown: (t) => String(t),
  alert() {}, confirm() { return true; }, prompt() { return null; },
  document: {
    getElementById: byId,
    createElement(tag) { const n = makeEl('new-' + tag); n.tagName = tag.toUpperCase(); return n; },
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!listeners.has(this)) listeners.set(this, {});
      const m = listeners.get(this);
      (m[type] = m[type] || []).push(fn);
    },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const fire = (node, type, ev = {}) => (listeners.get(node)?.[type] || []).forEach((fn) => fn(ev));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chat = byId('chat');
const jump = byId('jumpBtn');

/** Put the transcript in a known scrolled state and let app.js observe it. */
function setScroll({ height, view = 500, top }) {
  chat.scrollHeight = height;
  chat.clientHeight = view;
  chat.scrollTop = top;
  fire(chat, 'scroll');
}

const atBottom = (height, view = 500) => height - view;

before(() => {
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'),
    sandbox,
    { filename: 'app.js' }
  );
  chat.children = [makeEl('m1'), makeEl('m2')];
});

/* ------------------------------------------------------------- tests --- */

describe('app.js', () => {
  it('loads in a browser-like context without throwing', () => {
    assert.ok(sandbox.window, 'the context survived evaluation');
  });
});

describe('following a streaming reply', () => {
  it('follows while the reader is pinned to the bottom', () => {
    setScroll({ height: 2000, top: atBottom(2000) });
    assert.strictEqual(jump.hidden, true, 'no jump button while following');
  });

  it('still counts as following inside the slack window', () => {
    setScroll({ height: 2000, top: atBottom(2000) - 60 });
    assert.strictEqual(jump.hidden, true);
  });

  it('stops following once the reader scrolls beyond the slack window', () => {
    setScroll({ height: 2000, top: atBottom(2000) - 120 });
    assert.strictEqual(jump.hidden, false, 'jump button should be offered');
  });

  it('does NOT yank a scrolled-up reader down as new tokens arrive', () => {
    setScroll({ height: 2000, top: 300 });
    const parked = chat.scrollTop;

    // More tokens land, growing the transcript.
    chat.scrollHeight = 2600;
    fire(chat, 'scroll');

    assert.strictEqual(chat.scrollTop, parked, 'the reader must stay where they were');
    assert.strictEqual(jump.hidden, false);
  });

  it('resumes following when the reader returns to the bottom', () => {
    setScroll({ height: 2600, top: atBottom(2600) });
    assert.strictEqual(jump.hidden, true);
  });
});

describe('the jump-to-latest button', () => {
  it('scrolls to the newest message and hides itself immediately', async () => {
    setScroll({ height: 3000, top: 100 });
    assert.strictEqual(jump.hidden, false, 'precondition: button is showing');

    fire(jump, 'click');

    assert.strictEqual(chat.scrollTop, chat.scrollHeight, 'jumped to the end');
    assert.strictEqual(jump.hidden, true, 'hidden at once, not after the animation');
    await sleep(500); // let the smooth-scroll guard lapse
  });

  it('is never offered for an empty transcript', () => {
    chat.children = [];
    setScroll({ height: 0, top: 0 });
    assert.strictEqual(jump.hidden, true);
  });

  it('is offered again once the smooth-scroll guard has lapsed', () => {
    chat.children = [makeEl('m1')];
    setScroll({ height: 3000, top: 100 });
    assert.strictEqual(jump.hidden, false);
  });
});
