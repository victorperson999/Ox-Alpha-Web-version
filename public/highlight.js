/*
 * ox-chat — a small syntax highlighter. No dependencies.
 *
 * Safety model, same as markdown.js: the tokenizer works on the RAW source and
 * every token is HTML-escaped at the moment it is emitted. The only markup this
 * file can produce is `<span class="tok tok-NAME">`, where NAME comes from a
 * fixed internal set — never from the input. An unknown language falls back to
 * plain escaping, so nothing is ever emitted unescaped.
 *
 * Scope is "what shows up in a chat about code", not a compiler front end.
 * Highlighting is a readability aid; being approximate on exotic syntax is
 * fine, emitting unescaped input never is.
 */
'use strict';

(function (global) {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

  const DEFAULT_NUMBER =
    /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/;

  /* ------------------------------------------------------ language specs */

  const JS_KEYWORDS = words(`
    async await break case catch class const continue debugger default delete do
    else export extends finally for from function get if implements import in
    instanceof interface let new of return set static super switch this throw try
    typeof var void while with yield enum declare namespace type abstract
    public private protected readonly satisfies as is keyof infer
  `);
  const JS_BUILTINS = words(`
    true false null undefined NaN Infinity console window document globalThis
    Promise Array Object String Number Boolean Symbol Map Set WeakMap WeakSet
    JSON Math Date RegExp Error TypeError RangeError process require module
    exports __dirname __filename setTimeout setInterval fetch string boolean
    number any unknown never void object
  `);

  const PY_KEYWORDS = words(`
    and as assert async await break class continue def del elif else except
    finally for from global if import in is lambda nonlocal not or pass raise
    return try while with yield match case
  `);
  const PY_BUILTINS = words(`
    True False None self cls print len range list dict set tuple str int float
    bool bytes open enumerate zip map filter sum min max abs sorted reversed
    isinstance type super Exception ValueError TypeError KeyError IndexError
  `);

  const SHELL_KEYWORDS = words(`
    if then else elif fi for while until do done case esac function in select
    return break continue local export readonly declare set unset shift source
    trap exit eval exec
  `);
  const SHELL_BUILTINS = words(`
    echo cd ls cat grep sed awk find curl wget git node npm npx python pip sudo
    chmod chown mkdir rm cp mv touch printf read test true false
  `);

  const PS_KEYWORDS = words(`
    if else elseif switch foreach for while do until break continue return
    function filter param begin process end try catch finally throw class enum
    in and or not xor
  `);
  const PS_BUILTINS = words(`
    Get-Process Get-ChildItem Set-Location New-Item Remove-Item Write-Host
    Write-Output Select-Object Where-Object ForEach-Object Test-Path Start-Job
    Stop-Process Get-Content Set-Content Out-File Measure-Object Get-Command
    Get-NetTCPConnection Start-Sleep Invoke-WebRequest
  `);

  const SQL_KEYWORDS = words(`
    SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER
    DROP INDEX VIEW JOIN INNER LEFT RIGHT FULL OUTER ON GROUP BY ORDER HAVING
    LIMIT OFFSET UNION ALL DISTINCT AS AND OR NOT NULL IS IN LIKE BETWEEN EXISTS
    CASE WHEN THEN ELSE END PRIMARY KEY FOREIGN REFERENCES DEFAULT CONSTRAINT
    WITH RETURNING CASCADE
  `);

  const GO_KEYWORDS = words(`
    break case chan const continue default defer else fallthrough for func go
    goto if import interface map package range return select struct switch type var
  `);
  const RUST_KEYWORDS = words(`
    as async await break const continue crate dyn else enum extern false fn for
    if impl in let loop match mod move mut pub ref return self Self static struct
    super trait true type unsafe use where while
  `);
  const JAVA_KEYWORDS = words(`
    abstract assert boolean break byte case catch char class const continue
    default do double else enum extends final finally float for goto if
    implements import instanceof int interface long native new package private
    protected public return short static strictfp super switch synchronized this
    throw throws transient try void volatile while var record sealed
  `);
  const C_KEYWORDS = words(`
    auto break case char const continue default do double else enum extern float
    for goto if inline int long register restrict return short signed sizeof
    static struct switch typedef union unsigned void volatile while bool class
    namespace template typename public private protected virtual override new
    delete using nullptr constexpr explicit friend operator this throw try catch
  `);

  const CSS_KEYWORDS = words(`
    important media supports keyframes import charset font-face include mixin
    extend use forward if else for each while return
  `);

  const clike = (keywords, builtins) => ({
    lineComment: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    keywords,
    builtins,
  });

  const LANGS = {
    javascript: clike(JS_KEYWORDS, JS_BUILTINS),
    python: {
      lineComment: ['#'],
      quotes: ['"', "'"],
      tripleQuotes: true,
      keywords: PY_KEYWORDS,
      builtins: PY_BUILTINS,
    },
    json: {
      quotes: ['"'],
      keywords: words('true false null'),
      builtins: new Set(),
    },
    shell: {
      lineComment: ['#'],
      quotes: ['"', "'"],
      keywords: SHELL_KEYWORDS,
      builtins: SHELL_BUILTINS,
    },
    powershell: {
      lineComment: ['#'],
      blockComment: ['<#', '#>'],
      quotes: ['"', "'"],
      keywords: PS_KEYWORDS,
      builtins: PS_BUILTINS,
      identifier: /^[A-Za-z_$][\w$-]*/, // cmdlets are Verb-Noun
    },
    sql: {
      lineComment: ['--'],
      blockComment: ['/*', '*/'],
      quotes: ['"', "'"],
      keywords: SQL_KEYWORDS,
      builtins: new Set(),
      caseInsensitiveKeywords: true,
    },
    css: {
      blockComment: ['/*', '*/'],
      quotes: ['"', "'"],
      keywords: CSS_KEYWORDS,
      builtins: new Set(),
      identifier: /^[A-Za-z_@-][\w-]*/,
    },
    yaml: {
      lineComment: ['#'],
      quotes: ['"', "'"],
      keywords: words('true false null yes no on off'),
      builtins: new Set(),
    },
    ini: {
      lineComment: ['#', ';'],
      quotes: ['"', "'"],
      keywords: words('true false'),
      builtins: new Set(),
    },
    go: clike(GO_KEYWORDS, words('true false nil iota string int int64 float64 bool byte rune error make len cap append panic recover printf Println')),
    rust: clike(RUST_KEYWORDS, words('String Vec Option Some None Result Ok Err Box i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool str char println vec')),
    java: clike(JAVA_KEYWORDS, words('true false null String System out println Integer Double Boolean List Map ArrayList HashMap Object Exception')),
    c: clike(C_KEYWORDS, words('true false NULL size_t printf malloc free memcpy strlen std cout cin endl string vector')),
  };

  const ALIASES = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript', typescript: 'javascript', node: 'javascript',
    py: 'python', python3: 'python',
    jsonc: 'json', json5: 'json',
    sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell',
    ps1: 'powershell', pwsh: 'powershell', posh: 'powershell',
    scss: 'css', less: 'css', sass: 'css',
    yml: 'yaml',
    toml: 'ini', cfg: 'ini', conf: 'ini', dotenv: 'ini', env: 'ini',
    golang: 'go',
    rs: 'rust',
    'c++': 'c', cpp: 'c', cc: 'c', h: 'c', hpp: 'c', csharp: 'c', cs: 'c', java: 'java',
    postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
    html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', htm: 'markup',
    patch: 'diff',
  };

  const normalize = (lang) => {
    const key = String(lang || '').toLowerCase().trim();
    return ALIASES[key] || key;
  };

  /* ---------------------------------------------------------- tokenizer */

  function tokenize(code, spec) {
    const out = [];
    let i = 0;
    let plainFrom = 0;

    const flush = (end) => {
      if (end > plainFrom) out.push(['plain', code.slice(plainFrom, end)]);
    };
    const emit = (type, from, to) => {
      flush(from);
      out.push([type, code.slice(from, to)]);
      i = to;
      plainFrom = to;
    };

    const identifierRe = spec.identifier || /^[A-Za-z_$][\w$]*/;

    while (i < code.length) {
      const rest = code.slice(i);
      let handled = false;

      for (const marker of spec.lineComment || []) {
        if (rest.startsWith(marker)) {
          const nl = code.indexOf('\n', i);
          emit('com', i, nl === -1 ? code.length : nl);
          handled = true;
          break;
        }
      }
      if (handled) continue;

      if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
        const [open, close] = spec.blockComment;
        const at = code.indexOf(close, i + open.length);
        emit('com', i, at === -1 ? code.length : at + close.length);
        continue;
      }

      const quote = code[i];
      if ((spec.quotes || []).includes(quote)) {
        // Python-style triple quotes span lines and swallow single quotes.
        const triple = quote.repeat(3);
        if (spec.tripleQuotes && rest.startsWith(triple)) {
          const at = code.indexOf(triple, i + 3);
          emit('str', i, at === -1 ? code.length : at + 3);
          continue;
        }
        let j = i + 1;
        while (j < code.length) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === quote) { j++; break; }
          // An unterminated single-line string stops at the newline rather than
          // painting the rest of the block as a string.
          if (code[j] === '\n' && quote !== '`') break;
          j++;
        }
        emit('str', i, Math.min(j, code.length));
        continue;
      }

      const prev = i > 0 ? code[i - 1] : '';
      if (/[0-9]/.test(quote) && !/[\w$]/.test(prev)) {
        const m = rest.match(spec.number || DEFAULT_NUMBER);
        if (m) {
          emit('num', i, i + m[0].length);
          continue;
        }
      }

      const idMatch = rest.match(identifierRe);
      if (idMatch) {
        const word = idMatch[0];
        const probe = spec.caseInsensitiveKeywords ? word.toUpperCase() : word;
        const type = spec.keywords?.has(probe) ? 'kw' : spec.builtins?.has(word) ? 'bul' : null;
        if (type) emit(type, i, i + word.length);
        else i += word.length;
        continue;
      }

      i++;
    }

    flush(code.length);
    return out;
  }

  /* --------------------------------------------- markup and diff modes */

  function tokenizeMarkup(code) {
    const out = [];
    const re = /<!--[\s\S]*?-->|<\/?[A-Za-z][\w:-]*|\/?>|"[^"]*"|'[^']*'|[A-Za-z_:][\w:.-]*=/g;
    let last = 0;
    let m;

    while ((m = re.exec(code))) {
      if (m.index > last) out.push(['plain', code.slice(last, m.index)]);
      const text = m[0];
      if (text.startsWith('<!--')) out.push(['com', text]);
      else if (text.startsWith('<') || text === '>' || text === '/>') out.push(['kw', text]);
      else if (text.startsWith('"') || text.startsWith("'")) out.push(['str', text]);
      else out.push(['bul', text]);
      last = m.index + text.length;
    }
    if (last < code.length) out.push(['plain', code.slice(last)]);
    return out;
  }

  function tokenizeDiff(code) {
    return code.split(/(\n)/).map((line) => {
      if (line === '\n' || line === '') return ['plain', line];
      if (/^@@/.test(line)) return ['hdr', line];
      if (/^(\+\+\+|---|diff |index )/.test(line)) return ['com', line];
      if (line[0] === '+') return ['ins', line];
      if (line[0] === '-') return ['del', line];
      return ['plain', line];
    });
  }

  /* ------------------------------------------------------------- public */

  // The only class names this file can ever emit.
  const TOKEN_CLASSES = new Set(['com', 'str', 'num', 'kw', 'bul', 'ins', 'del', 'hdr']);

  /**
   * Highlight `code` for `lang`, returning HTML-escaped markup.
   * An unknown or missing language returns plainly escaped text.
   */
  function highlight(code, lang) {
    const source = String(code == null ? '' : code);
    const name = normalize(lang);

    let tokens;
    if (name === 'markup') tokens = tokenizeMarkup(source);
    else if (name === 'diff') tokens = tokenizeDiff(source);
    else if (LANGS[name]) tokens = tokenize(source, LANGS[name]);
    else return escapeHtml(source);

    return tokens
      .map(([type, text]) =>
        type !== 'plain' && TOKEN_CLASSES.has(type)
          ? `<span class="tok tok-${type}">${escapeHtml(text)}</span>`
          : escapeHtml(text))
      .join('');
  }

  /** Language names (and aliases) this highlighter recognises. */
  highlight.languages = () =>
    [...new Set([...Object.keys(LANGS), 'markup', 'diff', ...Object.keys(ALIASES)])].sort();

  global.oxHighlight = highlight;
})(typeof window !== 'undefined' ? window : globalThis);
