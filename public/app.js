/* ox-chat frontend — vanilla JS, no frameworks */
'use strict';

const hero = document.getElementById('hero');
const chat = document.getElementById('chat');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');

let conversationId = null;
let busy = false;

function scrollToEnd() {
  chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' });
}

function addBubble(kind, text) {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  el.textContent = text; // textContent keeps user/model text inert
  chat.appendChild(el);
  scrollToEnd();
  return el;
}

function addTyping() {
  const el = document.createElement('div');
  el.className = 'msg assistant typing';
  for (let i = 0; i < 3; i++) el.appendChild(document.createElement('span'));
  chat.appendChild(el);
  scrollToEnd();
  return el;
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 180) + 'px';
}

async function send() {
  const text = input.value.trim();
  if (!text || busy) return;

  hero.classList.add('gone'); // collapse welcome screen on first message
  addBubble('user', text);
  input.value = '';
  autosize();

  busy = true;
  sendBtn.disabled = true;
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
    }
  } catch {
    typing.remove();
    addBubble('error', '⚠️ Could not reach the local server.');
  }

  busy = false;
  sendBtn.disabled = false;
  input.focus();
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  send();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

input.addEventListener('input', autosize);
