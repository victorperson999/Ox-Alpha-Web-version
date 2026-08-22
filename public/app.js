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
  chat: $('chat'),
  composer: $('composer'),
  input: $('input'),
  sendBtn: $('send'),
};

/* ------------------------------------------------------------ state */

const STORE_KEY = 'oxchat.chats.v1';
const NAME_KEY = 'oxchat.name';

let chats = loadJSON(STORE_KEY, {}); // id -> {id,title,conversationId,createdAt,updatedAt,messages}
let currentChatId = null;
let conversationId = null;
let busy = false;

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(chats));
  } catch { /* private mode etc. — chat still works, history just won't save */ }
}

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
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-item' + (c.id === currentChatId ? ' active' : '');
    btn.textContent = c.title;
    btn.title = c.title;
    btn.addEventListener('click', () => openChat(c.id));
    els.chatList.appendChild(btn);
  }
}

function openChat(id) {
  const c = chats[id];
  if (!c) return;
  currentChatId = id;
  conversationId = c.conversationId || null;

  els.chat.innerHTML = '';
  for (const m of c.messages) {
    addBubble(m.role === 'user' ? 'user' : 'assistant', m.text);
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

function addBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text; // textContent keeps user/model text inert
  els.chat.appendChild(el);
  scrollToEnd();
  return el;
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

async function send() {
  const text = els.input.value.trim();
  if (!text || busy) return;

  els.hero.classList.add('gone');
  addBubble('user', text);
  els.input.value = '';
  autosize();

  busy = true;
  els.sendBtn.disabled = true;
  const typing = addTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId }),
    });
    const data = await res.json();
    typing.remove();

    if (data.error) {
      addBubble('error', '⚠️ ' + data.error);
    } else {
      conversationId = data.conversationId;
      addBubble('assistant', data.reply);
      rememberTurn(text, data.reply);
    }
  } catch {
    typing.remove();
    addBubble('error', '⚠️ Could not reach the local server.');
  }

  busy = false;
  els.sendBtn.disabled = false;
  els.input.focus();
}

function rememberTurn(userText, replyText) {
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
  c.messages.push({ role: 'user', text: userText }, { role: 'assistant', text: replyText });
  c.updatedAt = Date.now();
  persist();
  els.topbarTitle.textContent = c.title;
  renderList();
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
  if (e.key === 'Escape') setMenuOpen(false);
});

els.accountMenu.addEventListener('click', (e) => {
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
    case 'clear':
      if (confirm('Delete all saved chats? This cannot be undone.')) {
        chats = {};
        currentChatId = null;
        conversationId = null;
        els.chat.innerHTML = '';
        els.hero.classList.remove('gone');
        els.topbarTitle.textContent = '';
        persist();
        renderList();
      }
      break;
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
  send();
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
els.input.focus();
