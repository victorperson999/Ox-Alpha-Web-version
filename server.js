/**
 * ox-chat — a minimal local web wrapper around the Claude Code CLI.
 *
 * Zero dependencies (Node built-ins only).
 *   node server.js            -> http://localhost:3000
 *   PORT=8080 node server.js  -> custom port
 *
 * How it works: POST /api/chat spawns `claude -p` (headless mode), pipes the
 * user's message in over stdin, and returns the reply as JSON. Conversation
 * continuity uses native CLI sessions (--session-id on the first turn,
 * --resume afterwards), so each browser tab keeps its own context.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

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

const CLAUDE_PATH = process.env.CLAUDE_BIN || resolveClaudePath();

// conversationId (ours, sent to the browser) -> claude session uuid.
// Persisted to sessions.json so reopened chats keep their memory across
// server restarts.
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');

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
 * Spawn `claude -p`, write `message` to stdin, resolve with the reply text.
 * opts.mode 'new'    -> pin a fresh session with --session-id
 * opts.mode 'resume' -> continue an existing session with --resume
 */
function runClaude(message, opts) {
  return new Promise((resolve, reject) => {
    if (!CLAUDE_PATH) {
      return reject(new Error('claude CLI not found on PATH'));
    }

    const args = ['-p', '--output-format', 'text'];
    if (opts.mode === 'resume') args.push('--resume', opts.sessionId);
    else args.push('--session-id', opts.sessionId);

    // Strip markers that tell a nested Claude Code instance it is nested.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_SSE_PORT;

    const child = spawn(CLAUDE_PATH, args, {
      env,
      cwd: __dirname,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude took too long to reply (>5 min)'));
    }, REQUEST_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    // Prompt goes over stdin: immune to Windows quoting/newline issues.
    child.stdin.write(message);
    child.stdin.end();
  });
}

/**
 * Handle one chat turn. Resumes the stored session when possible; if the
 * session is gone (CLI restart, expired transcript), falls back to a fresh
 * session automatically.
 */
async function handleChatTurn(conversationId, message) {
  const existing = sessions[conversationId];

  if (existing) {
    try {
      return await runClaude(message, { mode: 'resume', sessionId: existing });
    } catch (err) {
      console.error(`[ox-chat] resume failed (${conversationId}), starting fresh: ${err.message}`);
      delete sessions[conversationId];
      saveSessions();
      // fall through and start a new session below
    }
  }

  const sessionId = crypto.randomUUID();
  const reply = await runClaude(message, { mode: 'new', sessionId });
  sessions[conversationId] = sessionId;
  saveSessions();
  return reply;
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

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
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
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    return sendJson(res, 200, { ok: true, claude: CLAUDE_PATH });
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    let payload;
    try {
      payload = JSON.parse(await readBody(req));
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

    console.log(`[ox-chat] conv=${conversationId.slice(0, 8)} prompt: ${message.slice(0, 80)}${message.length > 80 ? '…' : ''}`);

    try {
      const reply = await handleChatTurn(conversationId, message);
      return sendJson(res, 200, { reply, conversationId });
    } catch (err) {
      console.error(`[ox-chat] error: ${err.message}`);
      return sendJson(res, 502, { error: `Backend error: ${err.message}` });
    }
  }

  if (req.method === 'GET') return serveStatic(req, res);

  res.writeHead(405, { Allow: 'GET, POST' }).end();
});

server.listen(PORT, HOST, () => {
  // Startup banner: the single source of truth for where messages will go.
  // The spawned claude CLI inherits these env vars from THIS terminal.
  const backend = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com (your normal Anthropic login)';
  const model = process.env.ANTHROPIC_MODEL || '(CLI default)';

  console.log(`[ox-chat] listening on http://${HOST}:${PORT}`);
  console.log(`[ox-chat] claude binary: ${CLAUDE_PATH || 'NOT FOUND — set CLAUDE_BIN'}`);
  console.log(`[ox-chat] backend: ${backend}`);
  console.log(`[ox-chat] model:   ${model}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[ox-chat] Port ${PORT} is busy. Start with another:  PORT=3001 node server.js`);
  } else {
    throw err;
  }
  process.exit(1);
});
