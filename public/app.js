/* ox-chat frontend — vanilla JS, no frameworks */
'use strict';

const $ = (id) => document.getElementById(id);

const els = {
  sidebar: $('sidebar'),
  scrim: $('scrim'),
  burger: $('burger'),
  newChatBtn: $('newChatBtn'),
  searchInput: $('searchInput'),
  chatList: $('chatList'),
  accountBtn: $('accountBtn'),
  accountMenu: $('accountMenu'),
  accName: $('accName'),
  avatar: $('avatar'),
  hero: $('hero'),
  topbarTitle: $('topbarTitle'),
  modelSelect: $('modelSelect'),
  chat: $('chat'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('send'),
};

/* ------------------------------------------------------------ state */

const STORE_KEY = 'oxchat.chats.v1';
const NAME_KEY = 'oxchat.name';
const MODEL_KEY = 'oxchat.model';
const MODEL_LIST_KEY = 'oxchat.models';

let chats = loadJSON(STORE_KEY, {}); // id -> {id,title,conversationId,createdAt,updatedAt,messages}
let currentChatId = null;
let conversationId = null;
let busy = false;
let abort = null; // AbortController for the in-flight turn

let defaultModel = null; // whatever .env resolved to, from /api/config
let customModels = loadJSON(MODEL_LIST_KEY, []);
let chosenModel = localStorage.getItem(MODEL_KEY) || ''; // '' = use the server default

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode etc. — the app still works, it just won't remember */ }
}

const persist = () => saveJSON(STORE_KEY, chats);

/* --------------------------------------------------------- sidebar */

function renderList() {
  const q = els.searchInput.value.trim().toLowerCase();
  const items = Object.values(chats)
    .filter((c) => !q || c.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  els.chatList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = q ? 'No matching chats' : 'No chats yet';
    els.chatList.appendChild(empty);
    return;
  }

  for (const c of items) {
    // A row, not a single button: it holds its own rename/delete controls, and
    // a button cannot legally nest inside another button.
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-open';
    open.textContent = c.title;
    open.title = c.title;
    open.addEventListener('click', () => openChat(c.id));

    const actions = document.createElement('div');
    actions.className = 'chat-actions';

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'chat-act';
    rename.innerHTML = '&#9998;';
    rename.title = 'Rename';
    rename.setAttribute('aria-label', `Rename "${c.title}"`);
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      renameChat(c.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-act danger';
    del.innerHTML = '&#10005;';
    del.title = 'Delete';
    del.setAttribute('aria-label', `Delete "${c.title}"`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(c.id);
    });

    actions.append(rename, del);
    row.append(open, actions);
    els.chatList.appendChild(row);
  }
}

function renameChat(id) {
  const c = chats[id];
  if (!c) return;
  const next = prompt('Rename chat', c.title);
  if (next === null) return;
  c.title = next.trim().slice(0, 80) || c.title;
  c.updatedAt = Date.now();
  persist();
  if (id === currentChatId) els.topbarTitle.textContent = c.title;
  renderList();
}

/** Forget a conversation on the server too, so sessions.json stops growing. */
async function forgetSession(convId) {
  if (!convId) return;
  try {
    await fetch(`/api/chat/${encodeURIComponent(convId)}`, { method: 'DELETE' });
  } catch { /* the chat is gone from the UI either way */ }
}

async function deleteChat(id) {
  const c = chats[id];
  if (!c) return;
  if (!confirm(`Delete "${c.title}"? This cannot be undone.`)) return;

  const convId = c.conversationId;
  delete chats[id];
  persist();
  if (id === currentChatId) newChat();
  else renderList();
  await forgetSession(convId);
}

function openChat(id) {
  const c = chats[id];
  if (!c) return;
  currentChatId = id;
  conversationId = c.conversationId || null;

  els.chat.innerHTML = '';
  for (const m of c.messages) {
    if (m.role === 'user') {
      addBubble('user', m.text);
    } else {
      const bubble = addBubble('assistant', '');
      renderAssistant(bubble, m.text, true);
      if (m.usage) addMeta(bubble, m.usage);
    }
  }
  els.hero.classList.add('gone');
  els.topbarTitle.textContent = c.title;
  closeMobileNav();
  renderList();
  scrollToEnd();
}

function newChat() {
  currentChatId = null;
  conversationId = null;
  els.chat.innerHTML = '';
  els.hero.classList.remove('gone');
  els.topbarTitle.textContent = '';
  closeMobileNav();
  renderList();
  els.input.focus();
}

/* ------------------------------------------------------------ chat */

function scrollToEnd() {
  els.chat.scrollTo({ top: els.chat.scrollHeight, behavior: 'smooth' });
}

// While tokens stream in, smooth scrolling fights the arriving text.
function stickToEnd() {
  els.chat.scrollTop = els.chat.scrollHeight;
}

function addBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text; // textContent keeps user text inert
  els.chat.appendChild(el);
  scrollToEnd();
  return el;
}

/**
 * Model replies are the one place we build HTML from untrusted text.
 * renderMarkdown escapes everything before emitting its own fixed tag set —
 * see public/markdown.js.
 */
function renderAssistant(el, text, withCopyButtons) {
  el.classList.add('md');
  el.innerHTML = window.renderMarkdown(text);
  if (withCopyButtons) addCopyButtons(el);
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    pre.appendChild(btn);
  }
}

function addMeta(bubble, usage) {
  if (!usage) return;
  const m = document.createElement('div');
  m.className = 'msg-meta';
  // Tokens only: the CLI's cost figure uses Anthropic pricing and is wrong
  // for any other backend.
  m.textContent = `↑ ${usage.input.toLocaleString()} in · ↓ ${usage.output.toLocaleString()} out`;
  bubble.insertAdjacentElement('afterend', m);
  return m;
}

function addTyping() {
  const el = document.createElement('div');
  el.className = 'msg assistant typing';
  for (let i = 0; i < 3; i++) el.appendChild(document.createElement('span'));
  els.chat.appendChild(el);
  scrollToEnd();
  return el;
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 180) + 'px';
}

/**
 * Parse an SSE body into {event, data} objects as frames arrive.
 * Frames are separated by a blank line; `:` lines are keep-alive comments.
 */
async function* sseFrames(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let split;
    while ((split = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, split);
      buf = buf.slice(split + 2);

      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;

      try {
        yield { event, data: JSON.parse(data.join('\n')) };
      } catch { /* malformed frame — skip it rather than kill the stream */ }
    }
  }
}

function setBusy(on) {
  busy = on;
  // The send button doubles as the stop button, so it must stay enabled.
  els.sendBtn.classList.toggle('is-stop', on);
  els.sendBtn.innerHTML = on ? '&#9632;' : '&#8593;';
  els.sendBtn.title = on ? 'Stop (Esc)' : 'Send (Enter)';
  els.sendBtn.setAttribute('aria-label', on ? 'Stop generating' : 'Send');
}

function stop() {
  abort?.abort();
}

async function send() {
  const text = els.input.value.trim();
  if (!text || busy) return;

  els.hero.classList.add('gone');
  addBubble('user', text);
  els.input.value = '';
  autosize();

  setBusy(true);
  const typing = addTyping();
  let bubble = null;
  let status = null;
  let reply = '';
  let usage = null;
  let stopped = false;
  let failed = null;

  // Re-rendering markdown on every delta would be wasteful and jittery, so
  // repaint at most once per animation frame.
  let painting = false;
  const paint = () => {
    if (painting || !bubble) return;
    painting = true;
    requestAnimationFrame(() => {
      painting = false;
      if (!bubble) return;
      renderAssistant(bubble, reply, false);
      stickToEnd();
    });
  };

  abort = new AbortController();

  const setStatus = (tool) => {
    if (!status) {
      status = document.createElement('div');
      status.className = 'tool-status';
    }
    status.textContent = `⚙ running ${tool}…`;
    els.chat.appendChild(status); // appendChild moves it back to the end
    stickToEnd();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId, model: chosenModel || undefined }),
      signal: abort.signal,
    });

    // Validation failures come back as plain JSON, not a stream.
    if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }

    for await (const { event, data } of sseFrames(res.body)) {
      if (event === 'session') {
        conversationId = data.conversationId;
      } else if (event === 'delta') {
        if (typing.isConnected) typing.remove();
        if (!bubble) {
          bubble = addBubble('assistant', '');
          bubble.classList.add('streaming');
        }
        reply += data.text;
        paint();
      } else if (event === 'status') {
        setStatus(data.tool);
      } else if (event === 'error') {
        failed = data.error;
      } else if (event === 'done') {
        // The server's final text is authoritative; deltas were the preview.
        reply = data.reply ?? reply;
        usage = data.usage || null;
        if (!bubble) bubble = addBubble('assistant', '');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') stopped = true;
    else failed = err.message || 'Could not reach the local server.';
  }

  if (typing.isConnected) typing.remove();
  status?.remove();

  if (bubble) {
    bubble.classList.remove('streaming');
    renderAssistant(bubble, reply, true); // final paint, now with copy buttons
    if (stopped) bubble.classList.add('stopped');
    if (!reply) bubble.remove();
    else if (usage) addMeta(bubble, usage);
  }

  // Keep whatever arrived: a stopped or half-failed turn is still history the
  // CLI session remembers, so the transcript must match it.
  if (reply) rememberTurn(text, reply, usage);
  if (failed) addBubble('error', '⚠️ ' + failed);

  abort = null;
  setBusy(false);
  scrollToEnd();
  els.input.focus();
}

function rememberTurn(userText, replyText, usage) {
  if (!currentChatId) {
    currentChatId = crypto.randomUUID();
    chats[currentChatId] = {
      id: currentChatId,
      title: userText.slice(0, 60) + (userText.length > 60 ? '…' : ''),
      conversationId: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
  }
  const c = chats[currentChatId];
  c.conversationId = conversationId;
  c.messages.push(
    { role: 'user', text: userText },
    { role: 'assistant', text: replyText, usage: usage || undefined }
  );
  c.updatedAt = Date.now();
  persist();
  els.topbarTitle.textContent = c.title;
  renderList();
}

/* ------------------------------------------------------ copy buttons */

els.chat.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const code = btn.closest('pre')?.querySelector('code');
  if (!code) return;

  const done = (label) => {
    btn.textContent = label;
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  };
  try {
    await navigator.clipboard.writeText(code.textContent);
    done('Copied');
  } catch {
    done('Failed');
  }
});

/* ------------------------------------------------------ model picker */

function renderModelOptions() {
  const sel = els.modelSelect;
  sel.innerHTML = '';

  const def = document.createElement('option');
  def.value = '';
  def.textContent = defaultModel ? `Default (${defaultModel})` : 'Default (from .env)';
  sel.appendChild(def);

  for (const m of customModels) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  }

  const add = document.createElement('option');
  add.value = '__add__';
  add.textContent = 'Add model…';
  sel.appendChild(add);

  // A model removed from the list falls back to the default.
  sel.value = customModels.includes(chosenModel) ? chosenModel : '';
  if (sel.value === '' && chosenModel) {
    chosenModel = '';
    localStorage.removeItem(MODEL_KEY);
  }
}

els.modelSelect.addEventListener('change', () => {
  const value = els.modelSelect.value;

  if (value === '__add__') {
    const slug = (prompt('Model slug to add (e.g. stealth/ox-alpha)') || '').trim();
    // Same charset the server accepts, so the UI can't offer a slug it rejects.
    if (slug && /^[\w./:-]{1,64}$/.test(slug)) {
      if (!customModels.includes(slug)) {
        customModels.push(slug);
        saveJSON(MODEL_LIST_KEY, customModels);
      }
      chosenModel = slug;
      localStorage.setItem(MODEL_KEY, slug);
    } else if (slug) {
      alert('That does not look like a model slug. Letters, digits, . _ - / : only.');
    }
    renderModelOptions();
    return;
  }

  chosenModel = value;
  if (value) localStorage.setItem(MODEL_KEY, value);
  else localStorage.removeItem(MODEL_KEY);
});

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    defaultModel = cfg.model || null;
  } catch { /* the picker still works, it just won't name the default */ }
  renderModelOptions();
}

/* ---------------------------------------------------- account menu */

function setMenuOpen(open) {
  els.accountMenu.hidden = !open;
  els.accountBtn.setAttribute('aria-expanded', String(open));
}

els.accountBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setMenuOpen(els.accountMenu.hidden);
});

document.addEventListener('click', (e) => {
  if (!els.accountMenu.hidden && !e.target.closest('.menu-wrap')) setMenuOpen(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  setMenuOpen(false);
  if (busy) stop();
});

els.accountMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  setMenuOpen(false);

  switch (btn.dataset.action) {
    case 'settings':
      openSettings();
      break;
    case 'profile':
      applyName();
      $('profileDlg').showModal();
      break;
    case 'help':
      $('helpDlg').showModal();
      break;
    case 'clear': {
      if (!confirm('Delete all saved chats? This cannot be undone.')) break;
      const ids = Object.values(chats).map((c) => c.conversationId).filter(Boolean);
      chats = {};
      persist();
      newChat();
      // Drop the server-side sessions too, or sessions.json keeps them forever.
      await Promise.all(ids.map(forgetSession));
      break;
    }
  }
});

/* -------------------------------------------------- settings/name */

function applyName() {
  const name = localStorage.getItem(NAME_KEY) || 'You';
  els.accName.textContent = name;
  els.avatar.textContent = (name.trim()[0] || 'Y').toUpperCase();
  $('profName').textContent = name;
  $('nameInput').value = name === 'You' ? '' : name;
}

function openSettings() {
  applyName();
  $('settingsDlg').showModal();
}

$('saveNameBtn').addEventListener('click', () => {
  const name = ($('nameInput').value.trim() || 'You').slice(0, 32);
  localStorage.setItem(NAME_KEY, name);
  applyName();
  $('settingsDlg').close();
});

for (const btn of document.querySelectorAll('[data-close]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close());
}

/* --------------------------------------------------- mobile drawer */

function closeMobileNav() {
  els.sidebar.classList.remove('open');
  els.scrim.hidden = true;
}

els.burger.addEventListener('click', () => {
  els.sidebar.classList.add('open');
  els.scrim.hidden = false;
});

els.scrim.addEventListener('click', closeMobileNav);

/* ------------------------------------------------------------ init */

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  // Enter never reaches here (the textarea handles it), so a submit while
  // busy is always a deliberate click on the stop button.
  if (busy) stop();
  else send();
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

els.input.addEventListener('input', autosize);
els.searchInput.addEventListener('input', renderList);
els.newChatBtn.addEventListener('click', newChat);

applyName();
renderList();
loadConfig();
els.input.focus();
