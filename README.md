# ox-chat

A minimal ChatGPT-style web wrapper around your locally installed Claude Code CLI.
Zero npm dependencies — Node built-ins only.

## Run

```powershell
cd C:\Users\Lenovo\Documents\temp\ox-chat
node server.js
```

Open **http://localhost:3000**

## What it does

- Serves a static chat UI (`public/`) — welcome screen, message bubbles,
  auto-growing input bar, typing indicator.
- `POST /api/chat` spawns `claude -p` in headless mode and pipes your message
  to it over stdin. Auth comes from your existing Claude Code login — no API key.
- Each browser tab gets its own conversation: the first turn pins a CLI session
  with `--session-id`, later turns continue it with `--resume`.
- Binds to `127.0.0.1` only. Nothing leaves your machine except the model call itself.

## Config

| Env var      | Default            | Meaning                          |
| ------------ | ------------------ | -------------------------------- |
| `PORT`       | `3000`             | Listen port                      |
| `CLAUDE_BIN` | auto-detected PATH | Explicit path to the claude exe  |

## Ideas for v2

- Stream tokens live (SSE + `--output-format stream-json`)
- Render markdown in replies
- Conversation sidebar backed by `~/.claude/projects`
- Model picker (`--model`)
