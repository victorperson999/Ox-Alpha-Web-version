/*
 * createStreamParser — the stream-json → events transformation, fed the same
 * line shapes the real CLI emits. No process is spawned and no API is called.
 */
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

const { createStreamParser } = require('../server.js');

const line = (obj) => JSON.stringify(obj) + '\n';

const INIT = line({ type: 'system', subtype: 'init', session_id: 'sess-123', model: 'x' });
const delta = (text, extra = {}) =>
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ...extra,
  });
const RESULT = line({
  type: 'result', subtype: 'success', is_error: false, result: 'final text',
  session_id: 'sess-123', usage: { input_tokens: 10, output_tokens: 5 },
});

function collect() {
  const seen = { init: [], deltas: [], status: [] };
  const parser = createStreamParser({
    onInit: (id) => seen.init.push(id),
    onDelta: (t) => seen.deltas.push(t),
    onStatus: (t) => seen.status.push(t),
  });
  return { parser, seen };
}

describe('session init', () => {
  it('reports the session id the CLI actually pinned', () => {
    const { parser, seen } = collect();
    parser.push(INIT);
    assert.deepStrictEqual(seen.init, ['sess-123']);
    assert.strictEqual(parser.state.sessionId, 'sess-123');
  });

  it('ignores an init with no session id', () => {
    const { parser, seen } = collect();
    parser.push(line({ type: 'system', subtype: 'init' }));
    assert.deepStrictEqual(seen.init, []);
  });
});

describe('reply text', () => {
  let ctx;
  beforeEach(() => { ctx = collect(); });

  it('accumulates text deltas in order', () => {
    ctx.parser.push(delta('Hel'));
    ctx.parser.push(delta('lo w'));
    ctx.parser.push(delta('orld'));
    assert.strictEqual(ctx.parser.state.reply, 'Hello world');
    assert.deepStrictEqual(ctx.seen.deltas, ['Hel', 'lo w', 'orld']);
  });

  it('reassembles lines split across chunk boundaries', () => {
    const whole = delta('chunked');
    ctx.parser.push(whole.slice(0, 20));
    assert.strictEqual(ctx.parser.state.reply, '', 'must not emit a partial line');
    ctx.parser.push(whole.slice(20));
    assert.strictEqual(ctx.parser.state.reply, 'chunked');
  });

  it('handles several lines arriving in one chunk', () => {
    ctx.parser.push(delta('a') + delta('b') + delta('c'));
    assert.strictEqual(ctx.parser.state.reply, 'abc');
  });
});

describe('what must NOT reach the reply', () => {
  let ctx;
  beforeEach(() => { ctx = collect(); });

  it('excludes thinking deltas', () => {
    ctx.parser.push(line({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
    }));
    assert.strictEqual(ctx.parser.state.reply, '');
    assert.deepStrictEqual(ctx.seen.deltas, []);
  });

  it('excludes tool-input JSON deltas', () => {
    ctx.parser.push(line({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":' } },
    }));
    assert.strictEqual(ctx.parser.state.reply, '');
  });

  it('excludes sub-agent output, which carries a parent tool id', () => {
    ctx.parser.push(delta('from a subagent', { parent_tool_use_id: 'tool_abc' }));
    assert.strictEqual(ctx.parser.state.reply, '');
  });

  it('ignores unrelated event types', () => {
    ctx.parser.push(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
    ctx.parser.push(line({ type: 'system', subtype: 'status', status: 'requesting' }));
    ctx.parser.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'dup' }] } }));
    assert.strictEqual(ctx.parser.state.reply, '');
  });

  it('survives non-JSON noise on stdout', () => {
    ctx.parser.push('not json at all\n');
    ctx.parser.push('{ truncated\n');
    ctx.parser.push(delta('still fine'));
    assert.strictEqual(ctx.parser.state.reply, 'still fine');
  });
});

describe('tool activity', () => {
  it('surfaces the tool name so pauses are explainable', () => {
    const { parser, seen } = collect();
    parser.push(line({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } },
    }));
    assert.deepStrictEqual(seen.status, ['Bash']);
  });

  it('falls back to a generic label when the name is missing', () => {
    const { parser, seen } = collect();
    parser.push(line({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use' } },
    }));
    assert.deepStrictEqual(seen.status, ['tool']);
  });

  it('does not treat a text block start as a tool', () => {
    const { parser, seen } = collect();
    parser.push(line({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    }));
    assert.deepStrictEqual(seen.status, []);
  });
});

describe('result', () => {
  it('captures the authoritative final result', () => {
    const { parser } = collect();
    parser.push(INIT + delta('partial') + RESULT);
    assert.strictEqual(parser.state.result.result, 'final text');
    assert.strictEqual(parser.state.result.usage.output_tokens, 5);
    // Deltas remain available, but the result is what the caller prefers.
    assert.strictEqual(parser.state.reply, 'partial');
  });

  it('preserves an error result for the caller to reject on', () => {
    const { parser } = collect();
    parser.push(line({ type: 'result', is_error: true, result: 'Invalid bearer token' }));
    assert.strictEqual(parser.state.result.is_error, true);
    assert.strictEqual(parser.state.result.result, 'Invalid bearer token');
  });
});

describe('a full recorded turn', () => {
  it('produces the reply and session the CLI reported', () => {
    const { parser, seen } = collect();
    parser.push(
      INIT +
      line({ type: 'system', subtype: 'status', status: 'requesting' }) +
      line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }) +
      line({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } } }) +
      line({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } }) +
      delta('h') + delta('ello world') +
      line({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }) +
      line({ type: 'stream_event', event: { type: 'message_stop' } }) +
      line({ type: 'result', is_error: false, result: 'hello world', session_id: 'sess-123' })
    );

    assert.strictEqual(parser.state.reply, 'hello world');
    assert.strictEqual(parser.state.sessionId, 'sess-123');
    assert.strictEqual(parser.state.result.result, 'hello world');
    assert.deepStrictEqual(seen.deltas, ['h', 'ello world']);
  });
});
