/*
 * public/format.js — timestamps, search matching, and Markdown export.
 * All pure, so all directly testable.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

require(path.join(__dirname, '..', 'public', 'format.js'));
const { formatTime, formatDateTime, matchChat, searchChats, chatToMarkdown, exportFilename } =
  globalThis.oxFormat;

// A fixed reference point keeps these assertions stable forever.
const NOW = new Date(2026, 7, 25, 14, 30).getTime(); // 25 Aug 2026, 14:30
const at = (...args) => new Date(...args).getTime();

describe('formatTime', () => {
  it('shows just the clock for today', () => {
    assert.strictEqual(formatTime(at(2026, 7, 25, 9, 5), NOW), '09:05');
    assert.strictEqual(formatTime(at(2026, 7, 25, 23, 59), NOW), '23:59');
  });

  it('labels yesterday', () => {
    assert.strictEqual(formatTime(at(2026, 7, 24, 18, 0), NOW), 'Yesterday 18:00');
  });

  it('adds the date within the same year', () => {
    assert.strictEqual(formatTime(at(2026, 7, 12, 14, 3), NOW), '12 Aug 14:03');
    assert.strictEqual(formatTime(at(2026, 0, 1, 0, 0), NOW), '1 Jan 00:00');
  });

  it('drops the clock for older years', () => {
    assert.strictEqual(formatTime(at(2025, 7, 12, 14, 3), NOW), '12 Aug 2025');
  });

  it('measures calendar days, not 24-hour spans', () => {
    // 23:30 yesterday is 15 hours before "now", but it is still yesterday.
    assert.strictEqual(formatTime(at(2026, 7, 24, 23, 30), NOW), 'Yesterday 23:30');
    // 00:10 today is 14 hours before "now", and is still today.
    assert.strictEqual(formatTime(at(2026, 7, 25, 0, 10), NOW), '00:10');
  });

  it('returns an empty string for junk rather than "Invalid Date"', () => {
    for (const bad of [undefined, null, NaN, 'nonsense', {}]) {
      assert.strictEqual(formatTime(bad, NOW), '');
    }
  });
});

describe('formatDateTime', () => {
  it('renders an unambiguous, locale-independent stamp', () => {
    assert.strictEqual(formatDateTime(at(2026, 7, 25, 14, 30)), '25 Aug 2026, 14:30');
  });

  it('is empty for junk', () => assert.strictEqual(formatDateTime(undefined), ''));
});

describe('matchChat', () => {
  const chat = {
    title: 'Deploying the server',
    messages: [
      { role: 'user', text: 'how do I restart nginx?' },
      { role: 'assistant', text: 'Run systemctl restart nginx.' },
      { role: 'user', text: 'thanks' },
    ],
  };

  it('matches everything for an empty query', () => {
    assert.deepStrictEqual(matchChat(chat, ''), { match: true, title: false, hits: 0 });
    assert.deepStrictEqual(matchChat(chat, '   '), { match: true, title: false, hits: 0 });
  });

  it('matches on the title', () => {
    const r = matchChat(chat, 'deploy');
    assert.strictEqual(r.match, true);
    assert.strictEqual(r.title, true);
  });

  it('matches on message content the title never mentions', () => {
    const r = matchChat(chat, 'nginx');
    assert.strictEqual(r.match, true);
    assert.strictEqual(r.title, false);
    assert.strictEqual(r.hits, 2, 'counts every matching message');
  });

  it('is case-insensitive', () => {
    assert.strictEqual(matchChat(chat, 'NGINX').hits, 2);
    assert.strictEqual(matchChat(chat, 'DePlOy').title, true);
  });

  it('reports no match when nothing contains the query', () => {
    assert.strictEqual(matchChat(chat, 'kubernetes').match, false);
  });

  it('survives malformed chats', () => {
    assert.strictEqual(matchChat({}, 'x').match, false);
    assert.strictEqual(matchChat(null, 'x').match, false);
    assert.strictEqual(matchChat({ messages: [null, {}] }, 'x').match, false);
  });
});

describe('searchChats', () => {
  const chats = {
    a: { id: 'a', title: 'Alpha', updatedAt: 100, messages: [{ text: 'about nginx' }] },
    b: { id: 'b', title: 'Beta nginx', updatedAt: 300, messages: [] },
    c: { id: 'c', title: 'Gamma', updatedAt: 200, messages: [{ text: 'unrelated' }] },
  };

  it('returns matches newest first', () => {
    assert.deepStrictEqual(searchChats(chats, 'nginx').map((r) => r.chat.id), ['b', 'a']);
  });

  it('returns everything, still newest first, for an empty query', () => {
    assert.deepStrictEqual(searchChats(chats, '').map((r) => r.chat.id), ['b', 'c', 'a']);
  });

  it('annotates why each chat matched', () => {
    const [beta, alpha] = searchChats(chats, 'nginx');
    assert.strictEqual(beta.title, true);
    assert.strictEqual(alpha.title, false);
    assert.strictEqual(alpha.hits, 1);
  });

  it('handles an empty store', () => {
    assert.deepStrictEqual(searchChats({}, 'x'), []);
    assert.deepStrictEqual(searchChats(null, 'x'), []);
  });
});

describe('chatToMarkdown', () => {
  const chat = {
    title: 'Restarting nginx',
    createdAt: at(2026, 7, 25, 14, 0),
    messages: [
      { role: 'user', text: 'how do I restart nginx?', at: at(2026, 7, 25, 14, 0) },
      { role: 'assistant', text: 'Run:\n\n```bash\nsystemctl restart nginx\n```', at: at(2026, 7, 25, 14, 1) },
    ],
  };

  const md = chatToMarkdown(chat, { now: NOW });

  it('leads with the chat title', () => assert.ok(md.startsWith('# Restarting nginx')));

  it('records counts and dates in the header', () => {
    assert.match(md, /> 2 messages · started 25 Aug 2026, 14:00 · exported 25 Aug 2026, 14:30/);
  });

  it('labels each speaker with a timestamp', () => {
    assert.ok(md.includes('**You** · 25 Aug 2026, 14:00'));
    assert.ok(md.includes('**Assistant** · 25 Aug 2026, 14:01'));
  });

  it('reproduces message bodies verbatim, fenced code included', () => {
    assert.ok(md.includes('how do I restart nginx?'));
    assert.ok(md.includes('```bash\nsystemctl restart nginx\n```'));
  });

  it('uses bold labels, not headings, so reply headings keep their meaning', () => {
    const withHeading = chatToMarkdown(
      { title: 't', messages: [{ role: 'assistant', text: '## A real heading' }] },
      { now: NOW }
    );
    assert.ok(withHeading.includes('## A real heading'));
    // The only '#' heading we introduce is the document title.
    assert.strictEqual(withHeading.split('\n').filter((l) => l === '# t').length, 1);
  });

  it('honours a custom display name', () => {
    const out = chatToMarkdown(chat, { now: NOW, userName: 'Victor', assistantName: 'Ox Alpha' });
    assert.ok(out.includes('**Victor**'));
    assert.ok(out.includes('**Ox Alpha**'));
  });

  it('omits the timestamp for messages saved before they were recorded', () => {
    const out = chatToMarkdown({ title: 't', messages: [{ role: 'user', text: 'old' }] }, { now: NOW });
    assert.ok(out.includes('**You**\n'), 'no trailing separator when there is no time');
  });

  it('handles an empty chat without crashing', () => {
    const out = chatToMarkdown({ title: 'Empty', messages: [] }, { now: NOW });
    assert.ok(out.includes('# Empty'));
    assert.ok(out.includes('0 messages'));
  });

  it('handles a missing chat object', () => {
    assert.ok(chatToMarkdown(null, { now: NOW }).includes('# Untitled chat'));
  });
});

describe('exportFilename', () => {
  it('slugifies the title and stamps the date', () => {
    assert.strictEqual(
      exportFilename({ title: 'Restarting nginx!' }, NOW),
      'ox-chat-restarting-nginx-20260825.md'
    );
  });

  it('strips characters a filesystem would object to', () => {
    const name = exportFilename({ title: 'a/b\\c:d*e?f"g<h>i|j' }, NOW);
    assert.ok(!/[\\/:*?"<>|]/.test(name), name);
  });

  it('truncates a very long title', () => {
    const name = exportFilename({ title: 'x'.repeat(300) }, NOW);
    assert.ok(name.length < 80, name.length);
  });

  it('falls back when the title has nothing usable', () => {
    assert.strictEqual(exportFilename({ title: '???' }, NOW), 'ox-chat-chat-20260825.md');
    assert.strictEqual(exportFilename({}, NOW), 'ox-chat-chat-20260825.md');
  });
});
