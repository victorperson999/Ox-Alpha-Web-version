/*
 * .env parsing and precedence — the rules that decide which backend actually
 * answers you, plus the token summary shown under each reply.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadDotEnv, buildClaudeEnv, conf, sourceOf, tokenSummary } = require('../server.js');

let dir;
const fixture = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxchat-cfg-')); });
after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('loadDotEnv', () => {
  it('parses assignments, quotes, comments, and export prefixes', () => {
    const file = fixture('.env.basic', [
      '# a comment',
      '',
      'PLAIN=value',
      'DOUBLE="quoted value"',
      "SINGLE='quoted value'",
      'export EXPORTED=yes',
      '  SPACED  =  trimmed  ',
      'EMPTY=',
      'NOT_AN_ASSIGNMENT',
      '# EQUALS=in-a-comment',
    ].join('\n'));

    assert.deepStrictEqual(loadDotEnv(file), {
      PLAIN: 'value',
      DOUBLE: 'quoted value',
      SINGLE: 'quoted value',
      EXPORTED: 'yes',
      SPACED: 'trimmed',
      EMPTY: '',
    });
  });

  it('keeps characters that appear in real values', () => {
    const file = fixture('.env.values', [
      'ANTHROPIC_BASE_URL=https://openrouter.ai/api',
      'TOKEN=sk-or-v1-abc_DEF-123',
      'WITH_EQUALS=a=b=c',
    ].join('\n'));

    const out = loadDotEnv(file);
    assert.strictEqual(out.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.strictEqual(out.TOKEN, 'sk-or-v1-abc_DEF-123');
    assert.strictEqual(out.WITH_EQUALS, 'a=b=c', 'only the first = separates');
  });

  it('treats a missing file as no configuration, not an error', () => {
    assert.deepStrictEqual(loadDotEnv(path.join(dir, 'nope.env')), {});
  });

  it('tolerates CRLF line endings', () => {
    const file = fixture('.env.crlf', 'A=1\r\nB=2\r\n');
    assert.deepStrictEqual(loadDotEnv(file), { A: '1', B: '2' });
  });
});

describe('precedence', () => {
  const fileEnv = {
    PORT: '3111',
    ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
    ANTHROPIC_MODEL: 'stealth/ox-alpha',
  };

  it('prefers .env over the built-in default', () => {
    assert.strictEqual(conf('PORT', 3000, {}, fileEnv), '3111');
    assert.strictEqual(sourceOf('PORT', {}, fileEnv), '.env');
  });

  it('prefers a terminal variable over .env, for one-off overrides', () => {
    const env = { ANTHROPIC_MODEL: 'from-terminal' };
    assert.strictEqual(conf('ANTHROPIC_MODEL', null, env, fileEnv), 'from-terminal');
    assert.strictEqual(sourceOf('ANTHROPIC_MODEL', env, fileEnv), 'environment');
  });

  it('falls back to the default when neither is set', () => {
    assert.strictEqual(conf('NOTHING', 'fallback', {}, fileEnv), 'fallback');
    assert.strictEqual(sourceOf('NOTHING', {}, fileEnv), 'default');
  });
});

describe('buildClaudeEnv', () => {
  it('fills in values the terminal is missing', () => {
    const env = buildClaudeEnv({}, { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api' });
    assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  });

  it('lets a terminal variable win', () => {
    const env = buildClaudeEnv(
      { ANTHROPIC_MODEL: 'from-terminal' },
      { ANTHROPIC_MODEL: 'from-file' }
    );
    assert.strictEqual(env.ANTHROPIC_MODEL, 'from-terminal');
  });

  // The rule the README's four-line setup depends on: the CLI prefers
  // ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN, so an inherited key would
  // silently hijack an alternate backend unless a bare KEY= can unset it.
  it('treats a bare KEY= as an explicit unset that outranks the terminal', () => {
    const env = buildClaudeEnv(
      { ANTHROPIC_API_KEY: 'inherited-from-shell' },
      { ANTHROPIC_API_KEY: '' }
    );
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'the inherited key must be removed');
  });

  it('also drops a backend variable blanked in the terminal itself', () => {
    const env = buildClaudeEnv({ ANTHROPIC_API_KEY: '' }, {});
    assert.ok(!('ANTHROPIC_API_KEY' in env));
  });

  it('strips the markers that tell the CLI it is nested', () => {
    const env = buildClaudeEnv(
      { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_SSE_PORT: '1234' },
      {}
    );
    assert.ok(!('CLAUDECODE' in env));
    assert.ok(!('CLAUDE_CODE_ENTRYPOINT' in env));
    assert.ok(!('CLAUDE_CODE_SSE_PORT' in env));
  });

  it('passes unrelated variables through untouched', () => {
    const env = buildClaudeEnv({ PATH: '/usr/bin', HOME: '/home/me' }, {});
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.HOME, '/home/me');
  });
});

describe('tokenSummary', () => {
  it('folds cache reads and writes into the input count', () => {
    assert.deepStrictEqual(
      tokenSummary({
        input_tokens: 2,
        cache_read_input_tokens: 24446,
        cache_creation_input_tokens: 3457,
        output_tokens: 5,
      }),
      { input: 27905, output: 5 }
    );
  });

  it('copes with a sparse usage object', () => {
    assert.deepStrictEqual(tokenSummary({ output_tokens: 7 }), { input: 0, output: 7 });
    assert.deepStrictEqual(tokenSummary({}), { input: 0, output: 0 });
  });

  it('returns null when the CLI reported no usage', () => {
    assert.strictEqual(tokenSummary(null), null);
    assert.strictEqual(tokenSummary(undefined), null);
  });

  it('reports no cost figure, because the CLI prices with Anthropic rates', () => {
    const out = tokenSummary({ input_tokens: 1, output_tokens: 1 });
    assert.deepStrictEqual(Object.keys(out).sort(), ['input', 'output']);
  });
});
