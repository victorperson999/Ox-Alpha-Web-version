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
  starters: $('starters'),
  topbarTitle: $('topbarTitle'),
  jumpBtn: $('jumpBtn'),
  modelSelect: $('modelSelect'),
  chat: $('chat'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('send'),
};

const fmt = window.oxFormat;

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

// The raw Markdown behind each rendered reply, for "copy reply". Keyed weakly
// so removing a bubble drops its text with it.
const rawText = new WeakMap();

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
    return true;
  } catch {
    // Quota exhausted or private mode: the chat still works, history doesn't save.
    return false;
  }
}

let warnedAboutStorage = false;

function persist() {
  if (saveJSON(STORE_KEY, chats) || warnedAboutStorage) return;
  warnedAboutStorage = true;
  addBubble('error', '⚠️ Browser storage is full — this chat works, but history is no longer being saved. Export or delete some chats.');
}

const displayName = () => localStorage.getItem(NAME_KEY) || 'You';
const modelLabel = () => chosenModel || defaultModel || 'Assistant';

/* --------------------------------------------------------- sidebar */

function renderList() {
  const query = els.searchInput.value.trim();
  const results = fmt.searchChats(chats, query);

  els.chatList.innerHTML = '';

  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = query ? 'No matching chats' : 'No chats yet';
    els.chatList.appendChild(empty);
    return;
  }

  for (const { chat: c, title: titleMatched, hits } of results) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-open';
    open.title = c.title;
    open.addEventListener('click', () => openChat(c.id));

    const label = document.createElement('span');
    label.className = 'chat-title';
    label.textContent = c.title;
    open.appendChild(label);

    // Say why a chat surfaced when the query isn't in its title.
    if (query && !titleMatched && hits) {
      const badge = document.createElement('span');
      badge.className = 'chat-hits';
      badge.textContent = `${hits} match${hits === 1 ? '' : 'es'}`;
      open.appendChild(badge);
    }

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
  const lastIndex = c.messages.length - 1;

  c.messages.forEach((m, i) => {
    if (m.role === 'user') {
      const bubble = addBubble('user', m.text);
      addMeta(bubble, { role: 'user', at: m.at });
    } else {
      const bubble = addBubble('assistant', '');
      renderAssistant(bubble, m.text, true);
      addMeta(bubble, {
        role: 'assistant',
        at: m.at,
        usage: m.usage,
        actions: assistantActions(i === lastIndex),
      });
    }
  });

  els.hero.classList.add('gone');
  els.topbarTitle.textContent = c.title;
  closeMobileNav();
  renderList();

  // Opening a chat from a search result should show you where the hits are.
  const query = els.searchInput.value.trim();
  if (query) highlightMatches(els.chat, query);

  scrollToEnd(false);
}

function newChat() {
  currentChatId = null;
  conversationId = null;
  els.chat.innerHTML = '';
  els.hero.classList.remove('gone');
  els.topbarTitle.textContent = '';
  closeMobileNav();
  renderList();
  updateJumpButton();
  els.input.focus();
}

/* ---------------------------------------------------------- scroll */

// How close to the bottom still counts as "following along".
const FOLLOW_SLACK_PX = 80;

let autoFollow = true;
let programmaticScrolls = 0;

function nearBottom() {
  const el = els.chat;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
}

/** Jump to the newest message and resume following the stream. */
function scrollToEnd(smooth = true) {
  autoFollow = true;
  programmaticScrolls++;
  els.chat.scrollTo({ top: els.chat.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  updateJumpButton(); // hide it now, rather than letting it linger the whole animation
  // Smooth scrolling emits its own scroll events on the way down; ignore
  // them, or the midpoint of our own animation reads as "user scrolled up".
  setTimeout(() => {
    programmaticScrolls = Math.max(0, programmaticScrolls - 1);
    updateJumpButton();
  }, 400);
}

/**
 * Follow arriving tokens — but only while the reader is already at the
 * bottom. Yanking them back down every frame while they have scrolled up to
 * re-read something is worse than simply not following.
 */
function followStream() {
  if (autoFollow) els.chat.scrollTop = els.chat.scrollHeight;
}

function updateJumpButton() {
  els.jumpBtn.hidden = autoFollow || !els.chat.children.length;
}

els.chat.addEventListener('scroll', () => {
  if (programmaticScrolls > 0) return;
  autoFollow = nearBottom();
  updateJumpButton();
});

els.jumpBtn.addEventListener('click', () => {
  scrollToEnd();
  els.input.focus();
});

/* ------------------------------------------------------------ chat */

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
  rawText.set(el, text);
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

const assistantActions = (isLast) => [
  { act: 'copy-reply', label: 'Copy', title: 'Copy this reply as Markdown' },
  ...(isLast
    ? [{
        act: 'ask-again',
        label: 'Ask again',
        // Honest label: the CLI session is append-only, so this adds a new turn
        // rather than replacing the previous answer.
        title: 'Send the same question again as a new turn (it does not replace this answer)',
      }]
    : []),
];

/** The row under a message: timestamp, token counts, and its actions. */
function addMeta(bubble, { role, at, usage, actions = [] }) {
  const bits = [];
  const when = fmt.formatTime(at);
  if (when) bits.push(when);
  if (usage) {
    // Tokens only: the CLI's cost figure uses Anthropic pricing and is wrong
    // for any other backend.
    bits.push(`↑ ${usage.input.toLocaleString()} · ↓ ${usage.output.toLocaleString()}`);
  }
  if (!bits.length && !actions.length) return null;

  const row = document.createElement('div');
  row.className = `msg-meta ${role}`;

  if (bits.length) {
    const text = document.createElement('span');
    text.className = 'meta-text';
    text.textContent = bits.join('  ·  ');
    row.appendChild(text);
  }

  for (const a of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'meta-act';
    btn.dataset.act = a.act;
    btn.textContent = a.label;
    btn.title = a.title || a.label;
    row.appendChild(btn);
  }

  bubble.insertAdjacentElement('afterend', row);
  return row;
}

function addTyping() {
  const el = document.createElement('div');
  el.className = 'msg assistant typing';
  for (let i = 0; i < 3; i++) el.appendChild(document.createElement('span'));
  els.chat.appendChild(el);
  scrollToEnd();
  return el;
}

/** Wrap query matches in <mark>, walking text nodes so markup stays intact. */
function highlightMatches(root, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return 0;

  const LIMIT = 300; // a pathological query shouldn't lock the page up
  let count = 0;

  const visit = (node) => {
    if (count >= LIMIT) return;
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) {
        const text = child.nodeValue;
        const lower = text.toLowerCase();
        if (!lower.includes(needle)) continue;

        const frag = document.createDocumentFragment();
        let from = 0;
        for (;;) {
          const at = lower.indexOf(needle, from);
          if (at === -1 || count >= LIMIT) break;
          if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
          const mark = document.createElement('mark');
          mark.textContent = text.slice(at, at + needle.length);
          frag.appendChild(mark);
          from = at + needle.length;
          count++;
        }
        if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
        child.replaceWith(frag);
      } else if (child.nodeType === 1 && child.tagName !== 'MARK' && child.tagName !== 'BUTTON') {
        visit(child);
      }
    }
  };

  visit(root);
  return count;
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

/**
 * Run one turn.
 *   text      what to send; defaults to whatever is in the composer
 *   echoUser  false when the user's bubble is already on screen (a retry)
 */
async function send(text = els.input.value.trim(), { echoUser = true } = {}) {
  if (!text || busy) return;

  els.hero.classList.add('gone');
  const sentAt = Date.now();
  if (echoUser) {
    const userBubble = addBubble('user', text);
    addMeta(userBubble, { role: 'user', at: sentAt });
    els.input.value = '';
    autosize();
  }

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
      followStream();
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
    followStream();
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
  }

  // Keep whatever arrived: a stopped or half-failed turn is still history the
  // CLI session remembers, so the transcript must match it.
  if (reply) {
    const at = Date.now();
    rememberTurn(text, reply, usage, sentAt, at);
    addMeta(bubble, { role: 'assistant', at, usage, actions: assistantActions(true) });
  }
  if (failed) addFailure(failed, text);

  abort = null;
  setBusy(false);
  scrollToEnd();
  els.input.focus();
}

/** An error bubble that can retry the exact message that failed. */
function addFailure(message, attemptedText) {
  const bubble = addBubble('error', '⚠️ ' + message);
  const row = document.createElement('div');
  row.className = 'msg-meta error';

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'meta-act';
  retry.textContent = 'Retry';
  retry.title = 'Send that message again';
  retry.addEventListener('click', () => {
    bubble.remove();
    row.remove();
    // The user's bubble is already on screen from the failed attempt.
    send(attemptedText, { echoUser: false });
  });

  row.appendChild(retry);
  bubble.insertAdjacentElement('afterend', row);
  scrollToEnd();
}

function rememberTurn(userText, replyText, usage, sentAt, repliedAt) {
  if (!currentChatId) {
    currentChatId = crypto.randomUUID();
    chats[currentChatId] = {
      id: currentChatId,
      title: userText.slice(0, 60) + (userText.length > 60 ? '…' : ''),
      conversationId: null,
      createdAt: sentAt,
      updatedAt: repliedAt,
      messages: [],
    };
  }
  const c = chats[currentChatId];
  c.conversationId = conversationId;
  c.messages.push(
    { role: 'user', text: userText, at: sentAt },
    { role: 'assistant', text: replyText, usage: usage || undefined, at: repliedAt }
  );
  c.updatedAt = repliedAt;
  persist();
  els.topbarTitle.textContent = c.title;
  renderList();
}

/* ------------------------------------------------- message actions */

els.chat.addEventListener('click', async (e) => {
  const flash = (btn, label, revert = 'Copy') => {
    btn.textContent = label;
    setTimeout(() => { btn.textContent = revert; }, 1200);
  };

  const codeBtn = e.target.closest('.copy-btn');
  if (codeBtn) {
    const code = codeBtn.closest('pre')?.querySelector('code');
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.textContent);
      flash(codeBtn, 'Copied');
    } catch {
      flash(codeBtn, 'Failed');
    }
    return;
  }

  const action = e.target.closest('.meta-act');
  if (!action) return;

  const bubble = action.closest('.msg-meta')?.previousElementSibling;

  if (action.dataset.act === 'copy-reply') {
    const text = (bubble && rawText.get(bubble)) || bubble?.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      flash(action, 'Copied');
    } catch {
      flash(action, 'Failed');
    }
    return;
  }

  if (action.dataset.act === 'ask-again') {
    const messages = chats[currentChatId]?.messages || [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) send(lastUser.text);
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

/* ------------------------------------------------------------ export */

function exportCurrentChat() {
  const chat = chats[currentChatId];
  if (!chat) {
    alert('Open a chat first — there is nothing to export yet.');
    return;
  }

  const markdown = fmt.chatToMarkdown(chat, {
    userName: displayName(),
    assistantName: modelLabel(),
  });

  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fmt.exportFilename(chat);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    case 'export':
      exportCurrentChat();
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
  const name = displayName();
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

/* ------------------------------------------------ keyboard shortcuts */

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Escape') {
    setMenuOpen(false);
    if (busy) stop();
    return;
  }

  // Ctrl/Cmd+K — jump to search.
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.searchInput.focus();
    els.searchInput.select?.();
    return;
  }

  // Alt+N — new chat. Alt rather than Ctrl, which the browser claims.
  if (e.altKey && !mod && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
    return;
  }

  // Ctrl/Cmd+/ — shortcut reference.
  if (mod && e.key === '/') {
    e.preventDefault();
    $('helpDlg').showModal();
  }
});

/* ---------------------------------------------------- prompt starters */

els.starters?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-prompt]');
  if (!btn) return;
  els.input.value = btn.dataset.prompt;
  autosize();
  els.input.focus();
});

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
