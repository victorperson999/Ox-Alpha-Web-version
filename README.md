# Ox Chat

A minimal ChatGPT-style web UI for your locally installed **Claude Code CLI**.
Zero npm dependencies — Node built-ins only.

Backend-agnostic by design: it talks to whatever backend your `claude` CLI is
pointed at — your normal Anthropic login by default, or any Anthropic-compatible
endpoint (like OpenRouter's stealth **Ox Alpha**, its namesake) via environment
variables.

## Run

```powershell
cd path\to\ox-chat   # wherever you cloned this repo
npm start             # or: node server.js
```

There is nothing to install — `package.json` has no dependencies, only
scripts. Use `npm run dev` to restart automatically on file changes.

Open **http://localhost:3000**

To point it at a non-default backend, copy `.env.example` to `.env` and edit
it — no environment juggling required:

```powershell
copy .env.example .env
node server.js
```

On startup the server prints its resolved config, tagging each value with
where it came from:

```
[ox-chat] config:  .env (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL)
[ox-chat] backend: https://openrouter.ai/api [.env]
[ox-chat] model:   stealth/ox-alpha [.env]
[ox-chat] auth:    ANTHROPIC_AUTH_TOKEN set [.env]
```

Read that banner — it's the single source of truth for where your messages are
going (see [Backend selection](#backend-selection)).

## What it does

- Serves a static chat UI (`public/`) — welcome screen, message bubbles,
  auto-growing input bar, typing indicator.
- `POST /api/chat` spawns `claude -p` in headless mode, pipes your message to
  it over stdin, and streams the reply back token by token over Server-Sent
  Events. Auth comes from your existing Claude Code login — no API key stored
  or handled by this app.
- The send button becomes a **stop** button while a reply is streaming (or
  press <kbd>Esc</kbd>). Stopping kills the CLI child process; the partial
  reply is kept, and the conversation stays resumable.
- Turns are serialized per conversation, so two tabs on the same chat can't
  run two `claude --resume` processes over one transcript.
- Replies render as Markdown — headings, lists, tables, images, blockquotes,
  and fenced code with syntax highlighting, a language tag, and a copy button.
- Hover a sidebar chat to rename or delete it; deleting also drops the
  session server-side, so `sessions.json` stops growing forever.
- A model dropdown overrides `.env` per message via `--model`.
- Each message carries a timestamp; each reply its input/output token counts.
- Search reaches into message text, not just chat titles, and highlights the
  matches when you open a chat.
- A failed turn offers **Retry**; the newest reply offers **Copy** and
  **Ask again**.
- **Export chat** writes the open conversation out as a Markdown transcript.
- The empty screen offers a few prompt starters.
- Each browser tab gets its own conversation: the first turn pins a CLI session
  with `--session-id`, later turns continue it with `--resume`.
- Binds to `127.0.0.1` only. Nothing leaves your machine except the model call
  itself, made by the CLI.

## Backend selection

Ox Chat never talks to a model directly — it spawns your locally installed
`claude` CLI and hands it an explicitly built environment, assembled at
startup from `.env` plus the launching terminal.

Precedence, highest first:

1. A bare `KEY=` in `.env` — an explicit "make sure this is unset"
2. A variable set in the terminal that launched the server
3. A value in `.env`
4. The built-in default

So `.env` is the durable project config, and a terminal variable is a
one-off override for a single run.

### Default: Anthropic

No setup needed. If you're logged in to Claude Code, the app just works and
bills your normal Anthropic plan/API.

### Ox Alpha via OpenRouter (the namesake setup)

Put this in `.env` and just run `node server.js`:

```ini
ANTHROPIC_BASE_URL=https://openrouter.ai/api      # no /v1 — the CLI appends /v1/messages itself
ANTHROPIC_AUTH_TOKEN=sk-or-v1-your-key-here       # your OpenRouter key, sent as a bearer token
ANTHROPIC_MODEL=stealth/ox-alpha
ANTHROPIC_API_KEY=                                # bare = unset; the CLI would otherwise prefer it
```

The same pattern works for any endpoint that speaks the Anthropic Messages
API — swap the base URL, token, and model slug.

> **All four lines matter.** A token without `ANTHROPIC_BASE_URL` gets sent
> to Anthropic and fails; an `ANTHROPIC_API_KEY` that's set (even inherited
> from your shell) outranks `ANTHROPIC_AUTH_TOKEN` and silently hijacks the
> backend. The server warns about both cases at startup.

> **Privacy note on stealth models.** Cloaked models like `stealth/ox-alpha`
> are typically free or cheap because the (anonymous) lab behind them logs
> prompts for evaluation. Don't route anything sensitive or work-related
> through them.

## Streaming API

`POST /api/chat` takes `{ message, conversationId }` and responds with
`text/event-stream`. Validation failures come back as plain JSON instead
(`400`/`413`), so check the content type before parsing frames.

| Event     | Payload                                     | Meaning                                |
| --------- | ------------------------------------------- | -------------------------------------- |
| `session` | `{ conversationId }`                        | Session is live — sent before any text |
| `delta`   | `{ text }`                                  | A chunk of the reply                   |
| `status`  | `{ tool }`                                  | The CLI started a tool call            |
| `done`    | `{ reply, conversationId, usage }`          | Final authoritative text + tokens      |
| `error`   | `{ error }`                                 | The turn failed                        |

The optional `model` field on the request maps to `--model` for that turn
only, overriding `ANTHROPIC_MODEL`. Slugs are charset-limited server-side.

`usage` is `{ input, output }` token counts as reported by the provider.
There is deliberately **no cost figure**: the CLI computes one against
Anthropic's price list, which is wrong for any other backend, and a
confidently wrong number is worse than none.

Two more endpoints:

| Endpoint                     | Purpose                                          |
| ---------------------------- | ------------------------------------------------ |
| `GET /api/config`            | Resolved backend + model, so the UI can show them |
| `DELETE /api/chat/{id}`      | Forget one conversation server-side               |

Aborting the request (the Stop button does exactly this) closes the socket,
which kills the spawned CLI process.

## Config

| Env var                | Default                  | Meaning                                           |
| ---------------------- | ------------------------ | ------------------------------------------------- |
| `PORT`                 | `3000`                   | Listen port                                       |
| `CLAUDE_BIN`           | auto-detected from PATH  | Explicit path to the `claude` executable          |
| `ANTHROPIC_BASE_URL`   | (unset = Anthropic)      | Passed through to the CLI — alternate backend     |
| `ANTHROPIC_AUTH_TOKEN` | (unset)                  | Bearer token for that backend                     |
| `ANTHROPIC_API_KEY`    | (unset)                  | Blank it (`""`) when using an alternate backend   |
| `ANTHROPIC_MODEL`      | (unset = CLI default)    | Model slug the CLI should use                     |
| `OXCHAT_SESSIONS_FILE` | `./sessions.json`        | Where session ids are stored (tests override it)  |

## Shortcuts

| Key                | Does                          |
| ------------------ | ----------------------------- |
| `Enter`            | Send                          |
| `Shift`+`Enter`    | Newline                       |
| `Esc`              | Stop a streaming reply        |
| `Ctrl`/`Cmd`+`K`   | Jump to search                |
| `Alt`+`N`          | New chat                      |
| `Ctrl`/`Cmd`+`/`   | Shortcut reference            |

Every value above can live in `.env` or in the environment. The four
`ANTHROPIC_*` ones aren't used by Ox Chat itself — they're passed through to
the spawned CLI, and they decide which model answers you.

## Tests

```powershell
npm test
```

Node's built-in runner, still zero dependencies. Nothing in the suite
reaches the model or the network, so it is free, offline, and fast: every
`/api/chat` case is one the server rejects *before* it would spawn the CLI,
and the streaming parser is fed recorded CLI output rather than a live
process.

| File                      | Covers                                            |
| ------------------------- | ------------------------------------------------- |
| `markdown.test.js`        | Rendering, and the injection safety it rests on    |
| `highlight.test.js`       | Tokenizing, and that it never emits raw input      |
| `stream-parser.test.js`   | `stream-json` → events, incl. what must not leak   |
| `format.test.js`          | Timestamps, search matching, Markdown export       |
| `config.test.js`          | `.env` parsing and precedence, token counts        |
| `http.test.js`            | Routing, validation, static serving, traversal     |
| `ui.test.js`              | Scroll-follow, shortcuts, starters, under a shim   |

`ui.test.js` runs the real `public/*.js` inside a `vm` context with a minimal
DOM shim. That models `scrollTop`/`scrollHeight` arithmetic, not layout — it
proves the logic, not the visual result.

Two files carry the load-bearing safety properties, and both are worth
reading before changing them: `markdown.js` and `highlight.js` are the only
places model output becomes HTML. Each escapes every character before
emitting markup, and each can only produce tags and class names written
literally in its own source — never anything derived from the input.

## Scope

Ox Chat is a **self-hosted, single-user, bring-your-own-login** tool. It binds
to localhost and rides on the Claude Code installation of whoever runs it. It
is not designed to be exposed to other users or to share one account's access —
don't do that.

## Ideas for v3

- Conversation history backed by `~/.claude/projects` instead of
  `localStorage`, which a browser cache clear currently wipes
- A per-chat working directory, so a conversation can operate on another
  project instead of always running inside the ox-chat folder
- Collapsible tool cards showing what `Bash`/`Read`/`Edit` actually ran,
  and rendered diffs for file edits
- A collapsible panel for thinking blocks (currently filtered out)
- Attachments — the CLI accepts images

## Why "Ox"?

Named after [OpenRouter's stealth model Ox Alpha](https://openrouter.ai/stealth/ox-alpha),
the first backend this UI was built to chat with. Stealth aliases are
temporary by design — the model will eventually be de-cloaked and retired
under that name — but the UI works with any Claude Code-compatible backend,
so the name stays as a nod to its origin.
