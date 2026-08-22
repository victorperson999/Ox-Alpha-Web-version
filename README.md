# Ox Chat

A minimal ChatGPT-style web UI for your locally installed **Claude Code CLI**.
Zero npm dependencies — Node built-ins only.

Backend-agnostic by design: it talks to whatever backend your `claude` CLI is
pointed at — your normal Anthropic login by default, or any Anthropic-compatible
endpoint (like OpenRouter's stealth **Ox Alpha**, its namesake) via environment
variables.

## Run

```powershell
cd C:\Users\Lenovo\Documents\temp\ox-chat
node server.js
```

Open **http://localhost:3000**

On startup the server prints which backend and model it inherited:

```
[ox-chat] backend: https://openrouter.ai/api
[ox-chat] model:   stealth/ox-alpha
```

Read that banner — it's the single source of truth for where your messages are
going (see [Backend selection](#backend-selection)).

## What it does

- Serves a static chat UI (`public/`) — welcome screen, message bubbles,
  auto-growing input bar, typing indicator.
- `POST /api/chat` spawns `claude -p` in headless mode and pipes your message
  to it over stdin. Auth comes from your existing Claude Code login — no API
  key stored or handled by this app.
- Each browser tab gets its own conversation: the first turn pins a CLI session
  with `--session-id`, later turns continue it with `--resume`.
- Binds to `127.0.0.1` only. Nothing leaves your machine except the model call
  itself, made by the CLI.

## Backend selection

Ox Chat never talks to a model directly — it spawns your locally installed
`claude` CLI, and the spawned process **inherits its backend from the
environment of the terminal that launched `node server.js`**.

### Default: Anthropic

No setup needed. If you're logged in to Claude Code, the app just works and
bills your normal Anthropic plan/API.

### Ox Alpha via OpenRouter (the namesake setup)

Run these in the **same terminal**, then start the server:

```powershell
$env:ANTHROPIC_BASE_URL   = "https://openrouter.ai/api"   # no /v1 — the CLI appends /v1/messages itself
$env:ANTHROPIC_AUTH_TOKEN = "sk-or-v1-your-key-here"      # your OpenRouter API key, sent as a bearer token
$env:ANTHROPIC_API_KEY    = ""                            # blank explicitly so the CLI doesn't prefer it
$env:ANTHROPIC_MODEL      = "stealth/ox-alpha"
node server.js
```

The same pattern works for any endpoint that speaks the Anthropic Messages
API — swap the base URL, token, and model slug.

> **Warning — session-scoped config.** These variables live only in the
> terminal session where you set them. Launching the server from a fresh
> terminal silently falls back to your Anthropic login. The startup banner
> tells you which backend you're actually on.

> **Privacy note on stealth models.** Cloaked models like `stealth/ox-alpha`
> are typically free or cheap because the (anonymous) lab behind them logs
> prompts for evaluation. Don't route anything sensitive or work-related
> through them.

## Config

| Env var                | Default                  | Meaning                                           |
| ---------------------- | ------------------------ | ------------------------------------------------- |
| `PORT`                 | `3000`                   | Listen port                                       |
| `CLAUDE_BIN`           | auto-detected from PATH  | Explicit path to the `claude` executable          |
| `ANTHROPIC_BASE_URL`   | (unset = Anthropic)      | Passed through to the CLI — alternate backend     |
| `ANTHROPIC_AUTH_TOKEN` | (unset)                  | Bearer token for that backend                     |
| `ANTHROPIC_API_KEY`    | (unset)                  | Blank it (`""`) when using an alternate backend   |
| `ANTHROPIC_MODEL`      | (unset = CLI default)    | Model slug the CLI should use                     |

The four `ANTHROPIC_*` variables aren't read by Ox Chat's own code — they're
inherited by the spawned CLI processes. They're documented here because they
decide which model answers you.

## Scope

Ox Chat is a **self-hosted, single-user, bring-your-own-login** tool. It binds
to localhost and rides on the Claude Code installation of whoever runs it. It
is not designed to be exposed to other users or to share one account's access —
don't do that.

## Ideas for v2

- Stream tokens live (SSE + `--output-format stream-json`)
- Render markdown in replies
- Conversation sidebar backed by `~/.claude/projects`
- Model picker (`--model`) — surface the backend/model choice in the UI
  instead of the launching terminal's environment
- Pass `ANTHROPIC_*` config explicitly into the spawn's `env` object, killing
  the launched-from-the-wrong-terminal failure mode

## Why "Ox"?

Named after [OpenRouter's stealth model Ox Alpha](https://openrouter.ai/stealth/ox-alpha),
the first backend this UI was built to chat with. Stealth aliases are
temporary by design — the model will eventually be de-cloaked and retired
under that name — but the UI works with any Claude Code-compatible backend,
so the name stays as a nod to its origin.
