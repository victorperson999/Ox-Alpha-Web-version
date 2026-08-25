/*
 * ox-chat — pure helpers shared by the UI. No DOM, no dependencies, so the
 * test suite can exercise them directly.
 *
 * Dates are formatted by hand rather than via toLocaleString: the output then
 * doesn't shift with the machine's locale, which keeps exports stable and
 * tests deterministic.
 */
'use strict';

(function (global) {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const DAY_MS = 24 * 60 * 60 * 1000;

  const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const calendar = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]}`;

  /**
   * A short, human timestamp relative to `now`:
   *   today      -> "14:32"
   *   yesterday  -> "Yesterday 14:32"
   *   this year  -> "12 Aug 14:32"
   *   older      -> "12 Aug 2025"
   */
  function formatTime(ms, now = Date.now()) {
    if (!Number.isFinite(ms)) return '';
    const then = new Date(ms);
    if (Number.isNaN(then.getTime())) return '';
    const today = new Date(now);

    const days = Math.round((startOfDay(today) - startOfDay(then)) / DAY_MS);
    if (days === 0) return clock(then);
    if (days === 1) return `Yesterday ${clock(then)}`;
    if (then.getFullYear() === today.getFullYear()) return `${calendar(then)} ${clock(then)}`;
    return `${calendar(then)} ${then.getFullYear()}`;
  }

  /** Longer form, for the header of an exported transcript. */
  function formatDateTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${clock(d)}`;
  }

  /**
   * How well a chat matches a query. `hits` counts matching messages so the
   * sidebar can say why a chat surfaced for a word not in its title.
   */
  function matchChat(chat, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { match: true, title: false, hits: 0 };

    const title = String(chat?.title || '').toLowerCase().includes(q);
    let hits = 0;
    for (const m of chat?.messages || []) {
      if (String(m?.text || '').toLowerCase().includes(q)) hits++;
    }
    return { match: title || hits > 0, title, hits };
  }

  /** Chats matching `query`, newest first, each annotated with its match info. */
  function searchChats(chats, query) {
    return Object.values(chats || {})
      .map((chat) => ({ chat, ...matchChat(chat, query) }))
      .filter((r) => r.match)
      .sort((a, b) => (b.chat.updatedAt || 0) - (a.chat.updatedAt || 0));
  }

  /**
   * Render one chat as a Markdown transcript.
   *
   * Speaker labels are bold lines rather than headings, so that headings inside
   * a reply keep their own document structure instead of colliding with ours.
   */
  function chatToMarkdown(chat, opts = {}) {
    const userName = opts.userName || 'You';
    const assistantName = opts.assistantName || 'Assistant';
    const now = opts.now ?? Date.now();
    const messages = chat?.messages || [];

    const lines = [`# ${chat?.title || 'Untitled chat'}`, ''];

    const meta = [`${messages.length} message${messages.length === 1 ? '' : 's'}`];
    if (Number.isFinite(chat?.createdAt)) meta.push(`started ${formatDateTime(chat.createdAt)}`);
    meta.push(`exported ${formatDateTime(now)}`);
    lines.push(`> ${meta.join(' · ')}`, '');

    for (const m of messages) {
      const who = m.role === 'user' ? userName : assistantName;
      const when = Number.isFinite(m.at) ? ` · ${formatDateTime(m.at)}` : '';
      lines.push('---', '', `**${who}**${when}`, '');

      // Named, not embedded: history keeps only thumbnails, and a transcript
      // that silently dropped the attachment would misrepresent the turn.
      if (m.attachments?.length) {
        const named = m.attachments.map((a) => a.name || 'attachment').join(', ');
        lines.push(`*Attached: ${named}*`, '');
      }

      lines.push(String(m.text ?? ''), '');
    }

    return lines.join('\n').replace(/\n{3,}$/, '\n');
  }

  /** A filesystem-safe filename for an exported chat. */
  function exportFilename(chat, now = Date.now()) {
    const slug = String(chat?.title || 'chat')
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 48)
      .replace(/^-+|-+$/g, '');
    const d = new Date(now);
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    return `ox-chat-${slug || 'chat'}-${stamp}.md`;
  }

  /* ------------------------------------------------------- attachments */

  /** Human file size. Binary units, one decimal once past bytes. */
  function formatBytes(n) {
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = n / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
  }

  /**
   * Roughly what an image costs in input tokens: Anthropic's guidance is
   * width * height / 750. Approximate by design — it is shown to set
   * expectations, not to bill anyone.
   */
  function estimateImageTokens(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
    if (width <= 0 || height <= 0) return 0;
    return Math.ceil((width * height) / 750);
  }

  /**
   * Fit an image inside `maxEdge` on its longest side, preserving aspect
   * ratio. Never scales up — a small image is already as good as it gets.
   */
  function scaledDimensions(width, height, maxEdge) {
    const w = Math.max(1, Math.round(width || 0));
    const h = Math.max(1, Math.round(height || 0));
    const longest = Math.max(w, h);
    if (!Number.isFinite(maxEdge) || maxEdge <= 0 || longest <= maxEdge) {
      return { width: w, height: h, scaled: false };
    }
    const ratio = maxEdge / longest;
    return {
      width: Math.max(1, Math.round(w * ratio)),
      height: Math.max(1, Math.round(h * ratio)),
      scaled: true,
    };
  }

  global.oxFormat = {
    formatTime,
    formatDateTime,
    matchChat,
    searchChats,
    chatToMarkdown,
    exportFilename,
    formatBytes,
    estimateImageTokens,
    scaledDimensions,
  };
})(typeof window !== 'undefined' ? window : globalThis);
