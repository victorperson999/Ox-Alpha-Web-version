/*
 * Attachment validation and the composition of the CLI's user message.
 *
 * These are the pure halves of the feature: what the server will accept, and
 * how it turns accepted attachments into content blocks. Images pass through
 * untouched as base64; text files are inlined into the prompt.
 */
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { normalizeAttachments, buildUserContent } = require('../server.js');

// Valid base64 of arbitrary length (must be a multiple of 4).
const b64 = (units) => 'AAAA'.repeat(units);
const image = (over = {}) => ({ kind: 'image', name: 'shot.png', mediaType: 'image/png', data: b64(1), ...over });
const textFile = (over = {}) => ({ kind: 'text', name: 'notes.md', text: 'hello', ...over });

describe('normalizeAttachments', () => {
  it('treats absent attachments as none', () => {
    for (const input of [undefined, null]) {
      assert.deepStrictEqual(normalizeAttachments(input), { ok: true, attachments: [] });
    }
  });

  it('accepts a well-formed image', () => {
    const out = normalizeAttachments([image()]);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.attachments[0], {
      kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'AAAA',
    });
  });

  it('accepts every image type the API supports', () => {
    for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      assert.strictEqual(normalizeAttachments([image({ mediaType })]).ok, true, mediaType);
    }
  });

  it('refuses image types the API does not support', () => {
    for (const mediaType of ['image/bmp', 'image/tiff', 'image/svg+xml', 'application/pdf', '']) {
      const out = normalizeAttachments([image({ mediaType })]);
      assert.strictEqual(out.ok, false, mediaType);
      assert.match(out.error, /unsupported image type/i);
    }
  });

  it('strips whitespace out of base64 before validating it', () => {
    const out = normalizeAttachments([image({ data: 'AA\nAA\r\n' })]);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.attachments[0].data, 'AAAA');
  });

  it('rejects data that is not really base64', () => {
    for (const data of ['not base64!', 'AAA', 'AA=A', '', '===='.slice(0, 3)]) {
      assert.strictEqual(normalizeAttachments([image({ data })]).ok, false, JSON.stringify(data));
    }
  });

  it('enforces the 5MB per-image cap on decoded size', () => {
    // 4 base64 chars carry 3 bytes, so this is a shade over 5MB decoded.
    const tooBig = b64(Math.ceil((5 * 1024 * 1024) / 3) + 16);
    const out = normalizeAttachments([image({ name: 'huge.png', data: tooBig })]);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /huge\.png/);
    assert.match(out.error, /limit is 5MB/);
  });

  it('allows an image just under the cap', () => {
    const justUnder = b64(Math.floor((4 * 1024 * 1024) / 3));
    assert.strictEqual(normalizeAttachments([image({ data: justUnder })]).ok, true);
  });

  it('accepts a text attachment and keeps its content verbatim', () => {
    const out = normalizeAttachments([textFile({ text: 'line 1\nline 2\n' })]);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.attachments[0].text, 'line 1\nline 2\n');
  });

  it('rejects a text attachment past the inline limit', () => {
    const out = normalizeAttachments([textFile({ text: 'x'.repeat(256 * 1024 + 1) })]);
    assert.strictEqual(out.ok, false);
    assert.match(out.error, /too long to inline/);
  });

  it('rejects a text attachment with no text at all', () => {
    assert.match(normalizeAttachments([textFile({ text: undefined })]).error, /no text content/);
  });

  it('caps the number of attachments', () => {
    const six = Array.from({ length: 6 }, () => textFile());
    assert.strictEqual(normalizeAttachments(six).ok, true);
    assert.match(normalizeAttachments([...six, textFile()]).error, /At most 6/);
  });

  it('rejects a non-array, and non-object entries', () => {
    assert.match(normalizeAttachments('nope').error, /must be an array/);
    assert.match(normalizeAttachments([null]).error, /must be an object/);
    assert.match(normalizeAttachments(['string']).error, /must be an object/);
  });

  it('rejects an unknown kind rather than ignoring it', () => {
    assert.match(normalizeAttachments([{ kind: 'video' }]).error, /Unknown attachment kind/);
    assert.match(normalizeAttachments([{}]).error, /Unknown attachment kind/);
  });

  it('falls back to a placeholder name and truncates a long one', () => {
    assert.strictEqual(normalizeAttachments([image({ name: '   ' })]).attachments[0].name, 'attachment');
    assert.strictEqual(normalizeAttachments([image({ name: 42 })]).attachments[0].name, 'attachment');
    assert.strictEqual(normalizeAttachments([image({ name: 'x'.repeat(500) })]).attachments[0].name.length, 200);
  });
});

describe('buildUserContent', () => {
  it('sends a plain message as a single text block', () => {
    const { content } = buildUserContent('hello', []);
    assert.deepStrictEqual(content, [{ type: 'text', text: 'hello' }]);
  });

  it('puts images before the text, as the API prefers', () => {
    const { content } = buildUserContent('what is this?', [
      { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'AAAA' },
    ]);
    assert.deepStrictEqual(content.map((c) => c.type), ['image', 'text']);
    assert.deepStrictEqual(content[0].source, {
      type: 'base64', media_type: 'image/png', data: 'AAAA',
    });
  });

  it('passes image bytes through untouched — the wrapper never interprets them', () => {
    const data = b64(64);
    const { content } = buildUserContent('x', [{ kind: 'image', name: 'a.png', mediaType: 'image/jpeg', data }]);
    assert.strictEqual(content[0].source.data, data);
    assert.strictEqual(content[0].source.media_type, 'image/jpeg');
  });

  it('names attached images in the text, so the model can refer to them', () => {
    const { text } = buildUserContent('compare these', [
      { kind: 'image', name: 'before.png', mediaType: 'image/png', data: 'AAAA' },
      { kind: 'image', name: 'after.png', mediaType: 'image/png', data: 'AAAA' },
    ]);
    assert.match(text, /2 images attached: before\.png, after\.png/);
  });

  it('inlines a text file as a fenced block tagged with its language', () => {
    const { content, text } = buildUserContent('review this', [
      { kind: 'text', name: 'app.js', text: 'const x = 1;' },
    ]);
    assert.strictEqual(content.length, 1, 'text files add no content blocks');
    assert.match(text, /Attached file: app\.js/);
    assert.match(text, /```js\nconst x = 1;\n```/);
  });

  it('leaves the fence language empty for an extensionless file', () => {
    const { text } = buildUserContent('x', [{ kind: 'text', name: 'Dockerfile', text: 'FROM node' }]);
    assert.match(text, /```\nFROM node\n```/);
  });

  it('lengthens the fence when the file itself contains one', () => {
    // Otherwise the file's own ``` would close our block early and the rest
    // would be read as prose rather than as file contents.
    const body = 'intro\n```js\nnested();\n```\noutro';
    const { text } = buildUserContent('look', [{ kind: 'text', name: 'readme.md', text: body }]);
    assert.match(text, /````md\n/, 'outer fence must be longer than any inner one');
    assert.ok(text.includes(body), 'the body survives verbatim');
    assert.ok(text.trimEnd().endsWith('````'), 'and is closed by the longer fence');
  });

  it('handles several text files and several images together', () => {
    const { content, text } = buildUserContent('everything', [
      { kind: 'image', name: 'a.png', mediaType: 'image/png', data: 'AAAA' },
      { kind: 'text', name: 'one.txt', text: 'first' },
      { kind: 'text', name: 'two.txt', text: 'second' },
    ]);
    assert.deepStrictEqual(content.map((c) => c.type), ['image', 'text']);
    assert.match(text, /Attached file: one\.txt/);
    assert.match(text, /Attached file: two\.txt/);
    assert.match(text, /1 image attached: a\.png/);
  });

  it('copes with an empty message, as an uncaptioned screenshot produces', () => {
    const { content, text } = buildUserContent('', [
      { kind: 'image', name: 'shot.png', mediaType: 'image/png', data: 'AAAA' },
    ]);
    assert.strictEqual(content[0].type, 'image');
    assert.match(text, /1 image attached: shot\.png/);
  });

  it('copes with nullish arguments', () => {
    assert.deepStrictEqual(buildUserContent(null).content, [{ type: 'text', text: '' }]);
    assert.deepStrictEqual(buildUserContent(undefined, []).content, [{ type: 'text', text: '' }]);
  });
});
