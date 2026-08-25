/*
 * The HTTP contract: routing, validation, static serving, and the endpoints
 * the UI depends on.
 *
 * Nothing here reaches the model. Every /api/chat case below is rejected
 * before the CLI would be spawned, so the suite is free, fast, and offline.
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Point the session store at a throwaway file BEFORE the server module loads,
// so the suite can never touch a real sessions.json.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxchat-http-'));
const sessionsFile = path.join(dir, 'sessions.json');
fs.writeFileSync(sessionsFile, JSON.stringify({ 'seeded-conversation': 'uuid-1' }, null, 2));
process.env.OXCHAT_SESSIONS_FILE = sessionsFile;

const { server } = require('../server.js');

let origin;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Raw request, so the path is sent exactly as written (fetch would normalise it). */
function raw(method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path: rawPath },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const postJson = (body, headers = {}) =>
  fetch(`${origin}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });

describe('GET /api/health', () => {
  it('reports readiness and the resolved CLI path', async () => {
    const res = await fetch(`${origin}/api/health`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.ok('claude' in json);
  });
});

describe('GET /api/config', () => {
  it('exposes the backend and model the UI should display', async () => {
    const res = await fetch(`${origin}/api/config`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.deepStrictEqual(Object.keys(json).sort(), ['backend', 'model']);
    assert.ok(typeof json.backend === 'string' && json.backend.length > 0);
  });

  it('never leaks the credential', async () => {
    const body = await (await fetch(`${origin}/api/config`)).text();
    assert.ok(!/sk-[a-z]/i.test(body), 'a token must not appear in the config payload');
    assert.ok(!/TOKEN|API_KEY/i.test(body));
  });
});

describe('static files', () => {
  it('serves the app shell at the root', async () => {
    const res = await fetch(`${origin}/`);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<title>ox-chat<\/title>/);
  });

  it('serves assets with their correct content types', async () => {
    for (const [file, type] of [['/app.js', /javascript/], ['/style.css', /text\/css/], ['/markdown.js', /javascript/]]) {
      const res = await fetch(origin + file);
      assert.strictEqual(res.status, 200, `${file} should exist`);
      assert.match(res.headers.get('content-type'), type);
    }
  });

  it('never serves a stale asset during development', async () => {
    const res = await fetch(`${origin}/app.js`);
    assert.match(res.headers.get('cache-control'), /no-store/);
  });

  it('404s an unknown path', async () => {
    assert.strictEqual((await fetch(`${origin}/does-not-exist.js`)).status, 404);
  });

  it('refuses to escape the public directory', async () => {
    // Percent-encoded so the traversal survives to the server untouched.
    for (const p of ['/%2e%2e/server.js', '/%2e%2e%2f%2e%2e%2f.env', '/..%2fserver.js']) {
      const res = await raw('GET', p);
      assert.ok([403, 404].includes(res.status), `${p} returned ${res.status}`);
      assert.ok(!res.body.includes('createStreamParser'), `${p} leaked server source`);
      assert.ok(!/sk-or-/.test(res.body), `${p} leaked .env contents`);
    }
  });
});

describe('POST /api/chat validation', () => {
  it('rejects a malformed JSON body', async () => {
    const res = await postJson('{oops');
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /Invalid JSON/);
  });

  it('requires a non-empty message', async () => {
    for (const body of ['{}', '{"message":""}', '{"message":"   "}', '{"message":123}']) {
      const res = await postJson(body);
      assert.strictEqual(res.status, 400, `body ${body}`);
      assert.match((await res.json()).error, /required/);
    }
  });

  it('rejects an oversized body with 413, not a confusing parse error', async () => {
    const res = await postJson(JSON.stringify({ message: 'x'.repeat(1024 * 1024 + 512) }));
    assert.strictEqual(res.status, 413);
    assert.match((await res.json()).error, /too large/i);
  });

  it('answers validation failures as JSON, not as a stream', async () => {
    // The client checks this to decide how to read the response.
    const res = await postJson('{}');
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

describe('DELETE /api/chat/:id', () => {
  it('reports when there was nothing to forget', async () => {
    const res = await fetch(`${origin}/api/chat/never-existed`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { deleted: false });
  });

  it('forgets a session and persists that to disk', async () => {
    const res = await fetch(`${origin}/api/chat/seeded-conversation`, { method: 'DELETE' });
    assert.deepStrictEqual(await res.json(), { deleted: true });

    const onDisk = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    assert.ok(!('seeded-conversation' in onDisk), 'the session must be gone from the file');
  });

  it('handles an id with url-escaped characters', async () => {
    const res = await fetch(`${origin}/api/chat/${encodeURIComponent('a/b c')}`, { method: 'DELETE' });
    assert.strictEqual(res.status, 200);
  });
});

describe('method handling', () => {
  it('rejects an unsupported method and advertises what is allowed', async () => {
    const res = await raw('PUT', '/api/chat');
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.allow, 'GET, POST, DELETE');
  });
});
