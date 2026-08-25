/*
 * public/highlight.js — tokenizing is a readability aid, so being approximate
 * on exotic syntax is acceptable. Emitting unescaped input never is, and that
 * is what most of this file checks.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

require(path.join(__dirname, '..', 'public', 'highlight.js'));
const highlight = globalThis.oxHighlight;

// Token contents are HTML-escaped by design, so both helpers decode them
// before comparison — otherwise every assertion would be written in entities.
const decode = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/** Strip the markup back out; the result must equal the original source. */
const textOf = (html) =>
  decode(html.replace(/<span class="tok tok-[a-z]+">/g, '').replace(/<\/span>/g, ''));

const spans = (html, type) =>
  [...html.matchAll(new RegExp(`<span class="tok tok-${type}">([^<]*)</span>`, 'g'))]
    .map((m) => decode(m[1]));

describe('escaping', () => {
  it('escapes HTML in every language, highlighted or not', () => {
    for (const lang of ['javascript', 'python', 'html', 'diff', 'sql', 'nonsense-lang', '']) {
      const html = highlight('<script>alert("x")</script>', lang);
      assert.ok(!html.includes('<script>'), `${lang} leaked a script tag`);
      // Markup mode splits `<script` and `>` into separate tokens, so only the
      // opening is guaranteed contiguous.
      assert.ok(html.includes('&lt;script'), `${lang} did not escape`);
    }
  });

  it('escapes HTML hidden inside strings and comments', () => {
    const js = highlight('const a = "<img onerror=alert(1)>"; // <b>note</b>', 'js');
    assert.ok(!/<img|<b>/.test(js));
    assert.ok(js.includes('&lt;img'));
  });

  it('emits only tok-* spans and nothing else', () => {
    const html = highlight(
      'def f(x):\n    return "<a href=\'javascript:1\'>" # <!-- c -->\n', 'python'
    );
    const tags = html.match(/<[^>]*>/g) || [];
    for (const tag of tags) {
      assert.match(tag, /^(<span class="tok tok-(com|str|num|kw|bul|ins|del|hdr)">|<\/span>)$/, tag);
    }
  });

  it('never carries an event handler or a stray attribute', () => {
    const html = highlight('<div onclick="alert(1)" style="x">hi</div>', 'html');
    const tags = html.match(/<[^>]*>/g) || [];
    assert.deepStrictEqual(tags.filter((t) => / on[a-z]+=/i.test(t)), []);
  });
});

describe('round-tripping', () => {
  const samples = {
    javascript: 'const x = 1; // note\nfunction f(a) { return `t${a}`; }',
    python: 'def f(x):\n    """doc"""\n    return x + 1  # done',
    shell: 'echo "hi" && ls -la | grep foo # comment',
    sql: "SELECT * FROM t WHERE a = 'b' -- note",
    json: '{"a": 1, "b": [true, null]}',
    css: '.a { color: #fff; /* c */ }',
    html: '<a href="#x" data-y=\'z\'>text</a><!-- c -->',
    diff: '@@ -1 +1 @@\n-old\n+new\n context',
    yaml: 'key: value # note\nlist:\n  - true',
    go: 'func main() { fmt.Println("hi") }',
    rust: 'fn main() { let x: i32 = 1; }',
    powershell: '$x = Get-Process -Name node  # note',
  };

  for (const [lang, src] of Object.entries(samples)) {
    it(`preserves the exact source for ${lang}`, () => {
      assert.strictEqual(textOf(highlight(src, lang)), src);
    });
  }

  it('preserves source for an unknown language too', () => {
    const src = 'whatever <weird> & "text"';
    assert.strictEqual(textOf(highlight(src, 'brainfuck')), src);
  });

  it('handles empty and nullish input', () => {
    assert.strictEqual(highlight('', 'js'), '');
    assert.strictEqual(highlight(null, 'js'), '');
    assert.strictEqual(highlight(undefined, 'js'), '');
  });
});

describe('javascript', () => {
  const html = highlight('const n = 42; // hi\nlet s = "str";', 'js');

  it('marks keywords', () => assert.ok(spans(html, 'kw').includes('const')));
  it('marks numbers', () => assert.ok(spans(html, 'num').includes('42')));
  it('marks strings', () => assert.ok(spans(html, 'str').includes('"str"')));
  it('marks comments to end of line', () => assert.ok(spans(html, 'com').includes('// hi')));

  it('does not mark a keyword embedded in an identifier', () => {
    const out = highlight('const constant = 1; myconst = 2;', 'js');
    assert.deepStrictEqual(spans(out, 'kw'), ['const'], 'only the standalone keyword');
  });

  it('does not treat a number suffix of an identifier as a number', () => {
    assert.deepStrictEqual(spans(highlight('let a1 = 2;', 'js'), 'num'), ['2']);
  });

  it('handles escaped quotes inside strings', () => {
    const out = highlight('const s = "a\\"b"; const t = 1;', 'js');
    assert.ok(spans(out, 'str').includes('"a\\"b"'));
    assert.ok(spans(out, 'kw').includes('const'));
  });

  it('handles template literals spanning lines', () => {
    const out = highlight('const t = `line\nline`; const u = 1;', 'js');
    assert.ok(spans(out, 'str').some((s) => s.includes('\n')));
  });

  it('stops an unterminated string at the newline', () => {
    const out = highlight('const s = "oops\nconst after = 1;', 'js');
    assert.ok(spans(out, 'kw').includes('const'));
    assert.strictEqual(spans(out, 'kw').length, 2, 'code after the bad string still highlights');
  });

  it('leaves an unterminated block comment as a comment', () => {
    const out = highlight('/* never closed\nconst x = 1;', 'js');
    assert.strictEqual(spans(out, 'kw').length, 0);
  });
});

describe('python', () => {
  it('treats triple-quoted blocks as one string', () => {
    const out = highlight('x = """\nnot code: def f()\n"""\ndef g(): pass', 'py');
    assert.ok(spans(out, 'str').some((s) => s.includes('not code')));
    assert.ok(spans(out, 'kw').includes('def'));
    assert.strictEqual(spans(out, 'kw').filter((k) => k === 'def').length, 1);
  });

  it('marks builtins distinctly from keywords', () => {
    const out = highlight('def f(self): return None', 'py');
    assert.ok(spans(out, 'kw').includes('def'));
    assert.ok(spans(out, 'bul').includes('self'));
    assert.ok(spans(out, 'bul').includes('None'));
  });
});

describe('sql', () => {
  it('matches keywords case-insensitively', () => {
    assert.ok(spans(highlight('select * from t', 'sql'), 'kw').includes('select'));
    assert.ok(spans(highlight('SELECT * FROM t', 'sql'), 'kw').includes('SELECT'));
  });
});

describe('diff', () => {
  const html = highlight('@@ -1,2 +1,2 @@\n-removed\n+added\n unchanged', 'diff');

  it('marks additions, removals, and hunk headers', () => {
    assert.ok(spans(html, 'ins').includes('+added'));
    assert.ok(spans(html, 'del').includes('-removed'));
    assert.ok(spans(html, 'hdr').includes('@@ -1,2 +1,2 @@'));
  });

  it('leaves context lines alone', () => assert.ok(html.includes(' unchanged')));
});

describe('markup', () => {
  const html = highlight('<a href="x">t</a><!-- c -->', 'html');
  it('marks tags, attributes, values, and comments', () => {
    assert.ok(spans(html, 'kw').some((s) => s.includes('<a')));
    assert.ok(spans(html, 'bul').includes('href='));
    assert.ok(spans(html, 'str').includes('"x"'));
    assert.ok(spans(html, 'com').includes('<!-- c -->'));
  });
});

describe('aliases', () => {
  it('resolves common aliases to a real language', () => {
    for (const alias of ['js', 'ts', 'tsx', 'py', 'bash', 'sh', 'yml', 'ps1', 'rs', 'golang']) {
      const out = highlight('x', alias);
      assert.strictEqual(typeof out, 'string');
    }
    assert.ok(spans(highlight('const a = 1;', 'ts'), 'kw').includes('const'));
    assert.ok(spans(highlight('echo hi', 'bash'), 'bul').includes('echo'));
  });

  it('is case-insensitive about the language name', () => {
    assert.ok(spans(highlight('const a = 1;', 'JavaScript'), 'kw').includes('const'));
  });

  it('advertises the languages it knows', () => {
    const list = highlight.languages();
    assert.ok(list.includes('javascript') && list.includes('diff') && list.includes('markup'));
  });
});

describe('integration with markdown.js', () => {
  it('highlights inside a fenced block, still escaping HTML', () => {
    require(path.join(__dirname, '..', 'public', 'markdown.js'));
    const html = globalThis.renderMarkdown('```js\nconst x = "<b>";\n```');

    assert.match(html, /<pre data-lang="js"><code>/);
    assert.ok(html.includes('tok-kw'), 'the fence was highlighted');
    assert.ok(!html.includes('<b>'), 'HTML inside the fence stayed escaped');
    assert.ok(html.includes('&lt;b&gt;'));
  });

  it('leaves an unknown language as plain escaped code', () => {
    const html = globalThis.renderMarkdown('```nope\n<b>x</b>\n```');
    assert.ok(!html.includes('tok-'));
    assert.ok(html.includes('&lt;b&gt;'));
  });
});
