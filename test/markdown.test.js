/*
 * public/markdown.js — rendering correctness, and the injection safety the
 * whole design rests on: model output becomes HTML here and nowhere else.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

require(path.join(__dirname, '..', 'public', 'markdown.js'));
const render = globalThis.renderMarkdown;

const has = (src, needle) =>
  assert.ok(render(src).includes(needle), `expected ${needle}\n  in: ${render(src)}`);
const lacks = (src, needle) =>
  assert.ok(!render(src).includes(needle), `did NOT expect ${needle}\n  in: ${render(src)}`);

describe('injection safety', () => {
  it('escapes raw HTML rather than emitting it', () => {
    lacks('<script>alert(1)</script>', '<script>');
    has('<script>alert(1)</script>', '&lt;script&gt;');
    lacks('<img src=x onerror=alert(1)>', '<img src=x');
  });

  it('refuses dangerous link protocols', () => {
    lacks('[click](javascript:alert(1))', '<a href');
    lacks('[x](data:text/html,<script>alert(1)</script>)', '<a href="data:');
    lacks('[x](vbscript:msgbox(1))', '<a href');
    lacks('[x](JaVaScRiPt:alert(1))', '<a href');
  });

  it('refuses dangerous image protocols', () => {
    lacks('![x](javascript:alert(1))', '<img');
    lacks('![x](data:image/svg+xml;base64,PHN2Zz4=)', '<img');
  });

  it('keeps HTML inside code literal', () => {
    lacks('```\n<script>alert(1)</script>\n```', '<script>');
    lacks('try `<b>bold</b>` here', '<b>bold</b>');
  });

  it('cannot be broken out of via a link label', () => {
    lacks('[a"onmouseover="alert(1)](https://x.com)', 'onmouseover="alert');
    lacks('say "hi" <a href="x">', '<a href="x">');
  });

  it('emits only allow-listed tags, with no event handlers', () => {
    const ALLOWED = new Set([
      'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'a', 'blockquote',
      'ul', 'ol', 'li', 'input', 'div', 'table', 'thead', 'tbody', 'tr', 'th',
      'td', 'img', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);

    const html = render(
      '<div onclick="x">y</div>\n\n[a](https://b.c) **c**\n\n<img src=x onerror=alert(1)>\n\n' +
      '```\n<script>alert(1)</script>\n```\n\n| <b>h</b> |\n|---|\n| <i onmouseover=1>c</i> |\n\n' +
      '![p](https://x.com/p.png)'
    );
    const tags = html.match(/<[^>]*>/g) || [];
    const nameOf = (t) => (t.match(/^<\/?([a-z0-9]+)/i) || [, ''])[1].toLowerCase();

    assert.deepStrictEqual(tags.filter((t) => !ALLOWED.has(nameOf(t))), [], 'unexpected tag');
    assert.deepStrictEqual(tags.filter((t) => / on[a-z]+\s*=/i.test(t)), [], 'event handler');
    assert.deepStrictEqual(
      tags.filter((t) => /\s(style|srcdoc|formaction)\s*=/i.test(t)), [], 'risky attribute'
    );
  });
});

describe('inline formatting', () => {
  it('renders emphasis', () => {
    has('**bold**', '<strong>bold</strong>');
    has('an *italic* word', '<em>italic</em>');
    has('***both***', '<strong><em>both</em></strong>');
    has('~~gone~~', '<del>gone</del>');
  });

  it('renders inline code', () => has('use `npm test` now', '<code>npm test</code>'));

  it('leaves snake_case identifiers alone', () =>
    lacks('call my_var_name here', '<em>'));

  it('renders safe links', () => {
    has('[site](https://example.com)', '<a href="https://example.com"');
    has('[site](https://example.com)', 'rel="noopener noreferrer"');
    has('[mail](mailto:a@b.com)', '<a href="mailto:a@b.com"');
    has('see https://example.com now', '<a href="https://example.com"');
  });
});

describe('images', () => {
  it('renders an image, not a link with a stray bang', () => {
    has('![alt text](https://x.com/a.png)', '<img src="https://x.com/a.png"');
    has('![alt text](https://x.com/a.png)', 'alt="alt text"');
    has('![a](https://x.com/a.png)', 'loading="lazy"');
    assert.ok(!/!\s*<img/.test(render('see ![logo](https://x.com/l.png) here')));
  });

  it('works inside a link', () =>
    has('[![logo](https://x.com/l.png)](https://x.com)', '<img src="https://x.com/l.png"'));
});

describe('blocks', () => {
  it('renders headings and rules', () => {
    has('### Title', '<h3>Title</h3>');
    has('---', '<hr />');
  });

  it('renders blockquotes', () => has('> quoted', '<blockquote>'));

  it('renders fenced code with its language', () => {
    has('```\nx = 1\n```', '<pre><code>x = 1</code></pre>');
    has('```python\nx = 1\n```', 'data-lang="python"');
  });

  it('still renders an unterminated fence, for mid-stream output', () =>
    has('```js\nlet a = 1', '<pre'));

  it('renders lists, nesting, and task items', () => {
    has('- one\n- two', '<ul><li>one</li><li>two</li></ul>');
    has('1. one\n2. two', '<ol>');
    has('3. three', 'start="3"');
    has('- a\n  - b', '<ul><li>a<ul><li>b</li></ul></li></ul>');
    has('- [x] done', 'checked');
    has('- [ ] todo', '<input type="checkbox" disabled />');
  });

  it('renders tables inside a scroll wrapper', () => {
    const table = '| A | B |\n|---|---|\n| 1 | 2 |';
    has(table, '<th>A</th>');
    has(table, '<td>1</td>');
    has(table, 'class="md-table"');
  });

  it('handles empty and nullish input', () => {
    assert.strictEqual(render(''), '');
    assert.strictEqual(render(null), '');
    assert.strictEqual(render(undefined), '');
  });
});

describe('a real reply from the CLI', () => {
  // Captured verbatim from a live stealth/ox-alpha turn.
  const reply = [
    '## Heading',
    '',
    'This sentence has **bold text** and some `inline code`.',
    '',
    '| Column A | Column B |',
    '| --- | --- |',
    '| Row 1 | Value |',
    '',
    '- First item',
    '- Second item',
    '',
    '```js',
    'console.log(1);',
    '```',
  ].join('\n');

  it('renders every construct it used', () => {
    has(reply, '<h2>Heading</h2>');
    has(reply, '<strong>bold text</strong>');
    has(reply, '<code>inline code</code>');
    has(reply, '<th>Column A</th>');
    has(reply, '<td>Row 1</td>');
    has(reply, '<li>First item</li>');
    has(reply, '<pre data-lang="js"><code>console.log(1);</code></pre>');
  });
});
