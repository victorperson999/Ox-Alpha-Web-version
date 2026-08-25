/**
 * ox-chat — a minimal local web wrapper around the Claude Code CLI.
 *
 * Zero dependencies (Node built-ins only).
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js  -> custom port
 *
 * How it works: POST /api/chat spawns `claude -p` (headless mode), pipes the
 * user's message in over stdin, and streams the reply back token by token as
 * Server-Sent Events. Conversation continuity uses native CLI sessions
 * (--session-id on the first turn, --resume afterwards), so each browser tab
 * keeps its own context.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;

/* ----------------------------------------------------------------- .env */

// The backend variables the spawned CLI cares about. Listed explicitly so an
// empty value can be treated as "make sure this is unset" (see buildClaudeEnv).
const BACKEND_VARS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
];

/**
 * Minimal KEY=VALUE reader — enough for this project's config, still no
 * dependency. Handles comments, blank lines, an optional `export ` prefix,
 * and one layer of matching quotes.
 */
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {}; // no .env is a perfectly normal setup
  }

  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!key) continue;

    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);

    out[key] = value;
  }
  return out;
}

const dotEnv = loadDotEnv(path.join(__dirname, '.env'));

/**
 * Resolve one config value. The launching terminal wins over .env, so a
 * one-off `$env:ANTHROPIC_MODEL = "..."; node server.js` still overrides the
 * file for that run; .env wins over the built-in default.
 */
function conf(key, fallback, env = process.env, file = dotEnv) {
  if (env[key]) return env[key];
  if (file[key]) return file[key];
  return fallback;
}

/** Where a value came from — printed in the banner so precedence is visible. */
function sourceOf(key, env = process.env, file = dotEnv) {
  if (file[key] === '') return '.env'; // an explicit unset outranks the terminal
  if (env[key]) return 'environment';
  if (file[key] !== undefined) return '.env';
  return 'default';
}

/**
 * The environment the spawned CLI actually gets, built once at startup so the
 * banner and every turn agree on which backend is in play. This is what kills
 * the launched-from-the-wrong-terminal failure mode: config now travels with
 * the project instead of with the shell.
 */
function buildClaudeEnv(processEnv = process.env, fileEnv = dotEnv) {
  const env = { ...processEnv };

  for (const [key, value] of Object.entries(fileEnv)) {
    // A bare "KEY=" is an explicit instruction to unset, so it outranks even a
    // value inherited from the terminal — that is the entire point of writing
    // it. The CLI prefers ANTHROPIC_API_KEY over ANTHROPIC_AUTH_TOKEN when both
    // are present, so an inherited key would otherwise hijack the backend.
    if (value === '') {
      delete env[key];
      continue;
    }
    if (processEnv[key]) continue; // otherwise a real env var wins
    env[key] = value;
  }

  // Same courtesy for a variable blanked in the launching terminal.
  for (const key of BACKEND_VARS) {
    if (env[key] === '') delete env[key];
  }

  // Strip markers that tell a nested Claude Code instance it is nested.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;

  return env;
}

const CLAUDE_ENV = buildClaudeEnv();
const PORT = Number(conf('PORT', 3000));

/* ------------------------------------------------------------ claude CLI */

function resolveClaudePath() {
  const probe = process.platform === 'win32'
    ? { cmd: 'where.exe', args: ['claude'] }
    : { cmd: 'which', args: ['claude'] };
  try {
    const out = execFileSync(probe.cmd, probe.args, { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

const CLAUDE_PATH = conf('CLAUDE_BIN', '') || resolveClaudePath();

// conversationId (ours, sent to the browser) -> claude session uuid.
// Persisted to sessions.json so reopened chats keep their memory across
// server restarts.
// Overridable so tests (and a second instance) get their own store.
const SESSIONS_FILE = conf('OXCHAT_SESSIONS_FILE', path.join(__dirname, 'sessions.json'));

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

const sessions = loadSessions();

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    console.error(`[ox-chat] could not save sessions: ${err.message}`);
  }
}

/**
 * Turn the CLI's stream-json output into callbacks. Kept separate from
 * process management so it can be exercised against recorded CLI output
 * without spawning anything.
 *
 * handlers.onInit(sessionId) / onDelta(text) / onStatus(toolName)
 */
function createStreamParser(handlers = {}) {
  let buffer = '';
  const state = { reply: '', result: null, sessionId: null };

  function consume(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // non-JSON noise on stdout: ignore rather than derail the turn
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id) {
        state.sessionId = ev.session_id;
        handlers.onInit?.(ev.session_id);
      }
      return;
    }

    if (ev.type === 'result') {
      state.result = ev;
      return;
    }

    if (ev.type !== 'stream_event') return;
    // Sub-agent chatter carries a parent id; only the top-level turn is the reply.
    if (ev.parent_tool_use_id) return;

    const e = ev.event;
    if (e?.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
      handlers.onStatus?.(e.content_block.name || 'tool');
      return;
    }
    // Only text_delta is the answer — thinking_delta and input_json_delta are not.
    if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      state.reply += e.delta.text;
      handlers.onDelta?.(e.delta.text);
    }
  }

  return {
    /** Feed raw stdout; complete lines are parsed, partials are buffered. */
    push(chunk) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) consume(line);
      }
    },
    state,
  };
}

/**
 * Spawn `claude -p` in streaming mode and push events at the caller as they
 * arrive. Resolves with { reply, sessionId, costUsd } once the CLI exits.
 *
 * opts.mode      'new'    -> pin a fresh session with --session-id
 *                'resume' -> continue an existing session with --resume
 * opts.sessionId the session uuid for whichever mode
 * opts.signal    AbortSignal — aborting kills the child process
 * opts.onInit    (sessionId) once the CLI confirms the session is live
 * opts.onDelta   (text) for every chunk of the reply
 * opts.onStatus  (tool) when the CLI starts a tool call, so pauses are visible
 */
function streamClaude(message, opts) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_PATH) {
      return reject(new Error('claude CLI not found on PATH'));
    }

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      // the CLI rejects stream-json under -p without this
      '--verbose',
    ];
    if (opts.mode === 'resume') args.push('--resume', opts.sessionId);
    else args.push('--session-id', opts.sessionId);
    // Overrides ANTHROPIC_MODEL for this turn only.
    if (opts.model) args.push('--model', opts.model);

    const child = spawn(CLAUDE_PATH, args, {
      env: CLAUDE_ENV, // resolved once at startup from .env + this terminal
      cwd: __dirname,
      windowsHide: true,
    });

    let stderr = '';
    let sessionId = opts.sessionId;
    let aborted = false;

    const parser = createStreamParser({
      onInit: (id) => {
        sessionId = id;
        opts.onInit?.(id);
      },
      onDelta: (t) => opts.onDelta?.(t),
      onStatus: (t) => opts.onStatus?.(t),
    });

    child.stdout.on('data', (chunk) => parser.push(String(chunk)));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude took too long to reply (>5 min)'));
    }, REQUEST_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      if (aborted) {
        const err = new Error('stopped');
        err.aborted = true;
        return reject(err);
      }
      const { reply, result } = parser.state;
      if (result?.is_error) {
        return reject(new Error(result.result || 'claude reported an error'));
      }
      // The result event carries the authoritative text; deltas are the preview.
      const finalText = String(result?.result ?? reply).trim();
      if (code === 0 && finalText) {
        return resolve({ reply: finalText, sessionId, usage: result?.usage });
      }
      reject(new Error(stderr.trim() || `claude exited with code ${code}`));
    });

    // Prompt goes over stdin: immune to Windows quoting/newline issues.
    child.stdin.write(message);
    child.stdin.end();
  });
}

/**
 * Handle one chat turn. Resumes the stored session when possible; if the
 * session is gone (CLI restart, expired transcript), falls back to a fresh
 * session automatically — but only while nothing has been streamed yet, since
 * restarting after the browser has painted text would duplicate the reply.
 */
async function handleChatTurn(conversationId, message, hooks) {
  // Persist on init rather than on success: a turn the user stops still has a
  // session worth resuming.
  const remember = (sessionId) => {
    if (sessions[conversationId] !== sessionId) {
      sessions[conversationId] = sessionId;
      saveSessions();
    }
    hooks.onInit?.(sessionId);
  };

  const existing = sessions[conversationId];

  if (existing) {
    try {
      return await streamClaude(message, {
        ...hooks, onInit: remember, mode: 'resume', sessionId: existing,
      });
    } catch (err) {
      if (err.aborted || hooks.streamed()) throw err;
      console.error(`[ox-chat] resume failed (${conversationId}), starting fresh: ${err.message}`);
      delete sessions[conversationId];
      saveSessions();
      // fall through and start a new session below
    }
  }

  const sessionId = crypto.randomUUID();
  return streamClaude(message, { ...hooks, onInit: remember, mode: 'new', sessionId });
}

/**
 * Run one turn at a time per conversation. Two tabs (or an impatient
 * double-send) pointed at the same session would otherwise have two
 * `claude --resume` processes writing the same transcript.
 */
const turnQueues = new Map();

function serialize(key, task) {
  const prev = turnQueues.get(key) || Promise.resolve();
  const run = prev.then(task, task); // run whether or not the previous turn failed
  const tail = run.catch(() => {});
  turnQueues.set(key, tail);
  tail.then(() => {
    if (turnQueues.get(key) === tail) turnQueues.delete(key);
  });
  return run;
}

/**
 * Provider-reported token counts. Deliberately no cost figure: the CLI
 * computes one with Anthropic's price list, which is wrong for any other
 * backend, and a confidently wrong number is worse than none.
 */
function tokenSummary(usage) {
  if (!usage) return null;
  const input =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  return { input, output: usage.output_tokens || 0 };
}

/* ------------------------------------------------------------- HTTP glue */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('Message is too large.');
        err.tooLarge = true;
        // Drain rather than destroy: tearing the socket down here would race
        // the 413 and the client would see a connection reset instead.
        req.removeAllListeners('data');
        req.resume();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  // Trailing separator matters: without it a sibling `public-evil/` would pass.
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      // dev server: always serve fresh assets, never a stale cached copy
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/** Stream one chat turn to the browser as Server-Sent Events. */
async function handleChatRequest(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    return sendJson(res, err.tooLarge ? 413 : 400, { error: err.message });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!message) {
    return sendJson(res, 400, { error: 'Field "message" is required.' });
  }

  const conversationId =
    typeof payload.conversationId === 'string' && payload.conversationId.length <= 64
      ? payload.conversationId
      : crypto.randomUUID();

  // Charset-limited so a stray slug cannot turn into extra CLI arguments.
  const model =
    typeof payload.model === 'string' && /^[\w./:-]{1,64}$/.test(payload.model)
      ? payload.model
      : null;

  console.log(`[ox-chat] conv=${conversationId.slice(0, 8)} prompt: ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.socket?.setNoDelay(true);

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Comment frames keep the socket warm through a long tool call.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  // The Stop button aborts the fetch, which closes this socket: kill the CLI.
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  let streamed = false;

  try {
    const out = await serialize(conversationId, () =>
      handleChatTurn(conversationId, message, {
        model,
        signal: ac.signal,
        onInit: () => send('session', { conversationId }),
        onDelta: (text) => {
          streamed = true;
          send('delta', { text });
        },
        onStatus: (tool) => send('status', { tool }),
        streamed: () => streamed,
      }));
    send('done', { reply: out.reply, conversationId, usage: tokenSummary(out.usage) });
  } catch (err) {
    if (!ac.signal.aborted) {
      console.error(`[ox-chat] error: ${err.message}`);
      send('error', { error: `Backend error: ${err.message}` });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, { ok: true, claude: CLAUDE_PATH });
  }

  // Lets the UI show which backend and model it is actually talking to,
  // instead of the browser having to guess from nothing.
  if (req.method === 'GET' && req.url === '/api/config') {
    return sendJson(res, 200, {
      model: CLAUDE_ENV.ANTHROPIC_MODEL || null,
      backend: CLAUDE_ENV.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    });
  }

  // Drop a conversation server-side so deleted chats stop accumulating in
  // sessions.json forever.
  if (req.method === 'DELETE' && req.url.startsWith('/api/chat/')) {
    let id;
    try {
      id = decodeURIComponent(req.url.slice('/api/chat/'.length));
    } catch {
      return sendJson(res, 400, { error: 'Bad conversation id.' });
    }
    const existed = Object.prototype.hasOwnProperty.call(sessions, id);
    if (existed) {
      delete sessions[id];
      saveSessions();
    }
    return sendJson(res, 200, { deleted: existed });
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    return handleChatRequest(req, res);
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { Allow: 'GET, POST, DELETE' }).end();
});

/** Which variable carries the credential — never the credential itself. */
function authLabel() {
  if (CLAUDE_ENV.ANTHROPIC_API_KEY) return `ANTHROPIC_API_KEY set [${sourceOf('ANTHROPIC_API_KEY')}]`;
  if (CLAUDE_ENV.ANTHROPIC_AUTH_TOKEN) return `ANTHROPIC_AUTH_TOKEN set [${sourceOf('ANTHROPIC_AUTH_TOKEN')}]`;
  return 'your Claude Code login';
}

// Required as a module (by the tests) this file only exports; it starts
// listening solely when run directly.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
  // Startup banner: the single source of truth for where messages will go.
  // Each line tags its source, so a stale terminal variable quietly winning
  // over .env is visible rather than mysterious.
  const keys = Object.keys(dotEnv);
  const backend = CLAUDE_ENV.ANTHROPIC_BASE_URL;
  const model = CLAUDE_ENV.ANTHROPIC_MODEL;

  console.log(`[ox-chat] listening on http://${HOST}:${PORT}`);
  console.log(`[ox-chat] config:  ${keys.length ? `.env (${keys.join(', ')})` : 'no .env — this terminal only'}`);
  console.log(`[ox-chat] claude binary: ${CLAUDE_PATH || 'NOT FOUND — set CLAUDE_BIN'}`);
  console.log(`[ox-chat] backend: ${backend ? `${backend} [${sourceOf('ANTHROPIC_BASE_URL')}]` : 'https://api.anthropic.com (your normal Anthropic login)'}`);
  console.log(`[ox-chat] model:   ${model ? `${model} [${sourceOf('ANTHROPIC_MODEL')}]` : '(CLI default)'}`);
  console.log(`[ox-chat] auth:    ${authLabel()}`);

  // A token with no base URL is almost always a half-finished setup: another
  // provider's key aimed at Anthropic, which fails in a confusing way.
  if (!backend && CLAUDE_ENV.ANTHROPIC_AUTH_TOKEN) {
    console.warn('[ox-chat] WARNING: ANTHROPIC_AUTH_TOKEN is set but ANTHROPIC_BASE_URL is not, so that token goes to api.anthropic.com. If it belongs to another provider, set ANTHROPIC_BASE_URL too.');
  }

  if (backend && CLAUDE_ENV.ANTHROPIC_API_KEY) {
    console.warn('[ox-chat] WARNING: ANTHROPIC_API_KEY is set alongside a custom base URL. The CLI prefers it over ANTHROPIC_AUTH_TOKEN, so your requests may not go where you think. Blank it with a bare "ANTHROPIC_API_KEY=" line in .env.');
  }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[ox-chat] Port ${PORT} is busy. Start with another:  PORT=3001 node server.js`);
    } else {
      throw err;
    }
    process.exit(1);
  });
}

module.exports = {
  server,
  createStreamParser,
  loadDotEnv,
  buildClaudeEnv,
  tokenSummary,
  conf,
  sourceOf,
};


