# claudemesh

**Let your local [Claude Code](https://claude.com/claude-code) sessions find and talk to each other — in realtime, with zero compromises to the Claude Code CLI you already use.**

Run `claude` in three folders. Today they don't know the others exist. Install claudemesh and they do: each session gets a stable ID, can list its peers, send them tasks that wake them up the instant they arrive, and read each other's conversation history — all over a tiny localhost daemon. No cloud, no network exposure, no auth, no behavior changes inside `claude` itself. Stop using it any time and the original `claude` binary is exactly as it was.

```bash
claudemesh          # launch claude inside the realtime supervisor
claudemesh -c       # claude -c (continue most recent session)
claudemesh --resume # any other claude flag works the same
```

Anything that isn't a recognized subcommand (`list`, `send`, `install`, …) is forwarded straight to the wrapped `claude` binary, so `claudemesh` is a drop-in alternative entrypoint to `claude` — no alias, no shadow, no plugin install inside Claude. You get every feature of Claude Code (sessions, hooks, plugins, MCP, sub-agents, slash commands, IDE integration) plus the inter-instance side channel.

> Status: v0.2 — realtime PTY supervisor + folder-name addressing + idle tracking.

## Why

You probably run `claude` in several folders at once. They have no idea about each other. Claudemesh gives every session a stable identity and a realtime side channel:

- **Find peers**: list which other Claudes are running on this machine, where, and for how long.
- **Hand off work**: `claudemesh send api-service "rerun the migration check"` — the recipient wakes up and acts on it within a second if it was launched via `claudemesh`, or on its next user prompt otherwise.
- **Inspect**: peek at another instance's history (recent turns, search, fetch a specific turn) when you need cross-session context.
- **Notice**: the receiver's status line ticks up (`✉2`) when messages are waiting.

Everything is purely additive. Hooks and MCP are installed at the user level (`~/.claude/`), so existing project-level Claude Code config is untouched. Removing claudemesh is one command (`claudemesh uninstall`) and leaves no trace inside `claude` itself.

## How it works

There are two layers, and you can use either independently:

```
   ┌─────────────── one machine ───────────────┐
   │                                            │
   │  ┌── claudemesh (PTY supervisor) ────────┐   │  ← Layer 2: realtime injection
   │  │   ↑↓ proxy user terminal ↔ claude  │   │      (when launched via `claudemesh`)
   │  │   subscribes to daemon /events      │   │
   │  │   writes "[inbox]\n" to PTY master  │   │
   │  └─┬─────────────────────────────────┬─┘   │
   │    │ (PTY pair)                      │     │
   │  ┌─▼──────────────── claude ──────────▼─┐  │  ← Layer 1: hooks + MCP
   │  │   SessionStart/End hooks             │  │      (works with bare `claude` too)
   │  │   UserPromptSubmit hook (drains inbox)│ │
   │  │   Stop hook (blocks on tasks)        │  │
   │  │   MCP server: claudemesh               │  │
   │  └──────────────────────────────────────┘  │
   │                                            │
   │              ┌─────────────────────────┐   │
   │              │  claudemesh daemon        │   │
   │              │  HTTP @ ~/.claudemesh/  │   │
   │              │    daemon.sock (or TCP) │   │
   │              │  • registry + idle flag │   │
   │              │  • inboxes              │   │
   │              │  • events long-poll     │   │
   │              │  • liveness sweep       │   │
   │              └─────────────────────────┘   │
   └────────────────────────────────────────────┘
```

The daemon listens on a `0600` unix socket in `~/.claudemesh/` by default (TCP on loopback is opt-in, see [Configuration](#configuration)). State persists to `~/.claudemesh/`.

### Realtime via the supervisor

`claudemesh` spawns `claude` inside a PTY (via `node-pty`) and proxies your terminal byte-for-byte to/from it — so it looks and feels exactly like running `claude` directly. Any flag you pass to `claudemesh` (e.g. `claudemesh -c`, `claudemesh --resume <id>`) is forwarded to claude. In parallel the supervisor long-polls the daemon for new inbox messages addressed to this session. When one arrives:

1. Wait for the daemon's `idle` flag on this session to be `true` (the `Stop` hook sets it when claude finishes a turn; the `UserPromptSubmit` hook clears it).
2. Wait for ≥500ms of stdin silence (so we don't corrupt typing).
3. Write `[inbox]\n` to the PTY master.

That sentinel is read by claude as if you typed it. `UserPromptSubmit` fires, the hook drains the inbox, and the messages arrive as additional context attached to that turn — with explicit instructions to _act_ on `kind="task"` bodies, not just acknowledge them. End-to-end latency from `send` to claude starting work is sub-second on a healthy machine.

### Without the supervisor (bare `claude`)

If you keep running `claude` directly, the inbox + hooks still do most of the work:

- Messages still queue in the inbox.
- Status line still shows `✉N`.
- The `Stop` hook still blocks on pending tasks if it happens to fire while messages are queued.
- `UserPromptSubmit` still drains messages into the next turn.

What you lose is the **wake-up for fully-idle claude**: messages that arrive after `Stop` has already fired sit in the inbox until you submit any prompt. With the supervisor, that gap goes away.

### Status line

```
[abc12345 · 3 peers · ✉2]
```

- `abc12345` — this session's ID.
- `3 peers` — count of _other_ live Claudes (drops out at zero).
- `✉2` — unread inbox messages (drops out at zero).

## Install

> Requires Node ≥ 20. The supervisor needs `node-pty` (native, prebuilt for darwin/linux/win).

```bash
npm i -g @ktamas77/claudemesh
claudemesh install
```

`claudemesh install` patches two files (each backed up first):

- `~/.claude/settings.json` — adds the four hooks and the status-line script.
- `~/.claude.json` — adds the `claudemesh` MCP server under `mcpServers`.

After this, just use `claudemesh` everywhere you'd type `claude`:

```bash
claudemesh              # interactive session in the supervisor
claudemesh -c           # resume the most recent session
claudemesh --resume xyz # resume a specific session id
```

The original `claude` binary is untouched — both work side by side. Use `claudemesh` when you want realtime inbox delivery; use `claude` when you don't (you still get the inbox + ✉ status line, just no auto-wake).

If you'd rather invoke the supervisor under a shorter name, drop a tiny script anywhere on your PATH:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/clc <<'EOF'
#!/bin/sh
exec claudemesh "$@"
EOF
chmod +x ~/.local/bin/clc
```

Now `clc -c` is `claudemesh -c` is `claude -c`-with-supervisor.

```bash
claudemesh uninstall   # reverses the install
```

If `node-pty` fails to install (older toolchain), bare `claudemesh` errors out with a fix-it message but the subcommands (`claudemesh list`, `claudemesh send`, etc.) still work.

### Adding the badge to an existing status line

If you already have a custom `statusLine` script in `~/.claude/settings.json`, `claudemesh install` detects it and **leaves it alone** rather than clobbering your customizations. To add the `[abc12345 · 3 peers · ✉2]` badge yourself, capture stdin once and pipe it to `claudemesh statusline`:

```bash
#!/bin/bash
input=$(cat)

# ... your existing parts ...
out="$host | $model | $ctx | $folder"

# Claudemesh badge (only renders if claudemesh is installed and a session is registered)
if command -v claudemesh >/dev/null 2>&1; then
  badge=$(printf '%s' "$input" | claudemesh statusline 2>/dev/null)
  [ -n "$badge" ] && out="$out | $badge"
fi

printf '%s\n' "$out"
```

`claudemesh statusline` reads the same JSON Claude Code already pipes to your script (it needs `session_id`), prints `[id · peers · ✉N]`, and exits silently with no output if the daemon is down or the session isn't registered yet.

## CLI

```
claudemesh [claude args...]              launch claude inside the realtime supervisor
                                       (e.g. `claudemesh -c`, `claudemesh --resume <id>`)
claudemesh list                          show all live Claude sessions
claudemesh whoami                        this shell's parent claude (best-effort by ppid)
claudemesh send <target> <message>       send a task message; target = id or folder name
claudemesh history <target> [-n N]       tail another session's transcript
claudemesh search <target> <query>       search another session's transcript
claudemesh status                        daemon health + instance count
claudemesh install / uninstall           patch / unpatch ~/.claude config
claudemesh help                          show subcommand help
claudemesh run [claude args...]          explicit form of the default supervisor launch
claudemesh daemon / mcp / hook / statusline   internal (used by Claude Code)
```

Anything that's not a recognized subcommand from this list is treated as args for the supervisor and forwarded to claude — that's how `claudemesh -c` and friends work.

`CLAUDEMESH_CLAUDE_BIN` overrides which binary the supervisor launches (default: `claude` on PATH). Useful if you have multiple Claude Code builds installed.

### Addressing sessions: id or folder name

Anywhere a target is expected — CLI commands and MCP tools alike — you can pass either the 8-char `claude_id` or the **basename of that session's working directory**. The resolver:

1. Tries an exact `claude_id` match against the live registry.
2. Falls back to a case-insensitive match on `basename(cwd)`.

```bash
# These two are equivalent when one live session is running in /Users/me/dev/api-service
claudemesh send 7k3p9q2x "rerun the migration check"
claudemesh send api-service "rerun the migration check"
```

If the folder name matches more than one live session (e.g. `~/orgA/api` and `~/orgB/api` both running), the resolver errors out with both `claude_id`s and full paths so you can disambiguate by id. If nothing matches, it prints all live sessions.

## MCP tools

The `claudemesh` MCP server exposes the following inside every `claude` session. Wherever a tool takes a target session, you can pass either an 8-char `claude_id` or a folder basename (see [Addressing sessions](#addressing-sessions-id-or-folder-name)).

| Tool                                       | Purpose                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whoami`                                   | Your own `claude_id`, cwd, started_at.                                                                                                            |
| `list_instances`                           | All live sessions: id, cwd, last_active, pending count, idle.                                                                                     |
| `send_message(to, body, kind?)`            | Send to another session. `kind: "task"` (default) wakes the recipient via the supervisor / Stop hook; `kind: "note"` is silent until next prompt. |
| `read_inbox(drain?)`                       | Pull pending messages for the current session (defaults to draining).                                                                             |
| `read_history(id, last_n_turns?, redact?)` | Recent turns from another session, redacted by default; pass `redact: false` for raw.                                                             |
| `search_history(id, query, options?)`      | Substring/regex search over another session's transcript with surrounding context.                                                                |
| `get_turn(id, turn_index)`                 | Pinpoint full-content fetch of one turn after `read_history` / `search_history` flagged it.                                                       |

## Message delivery

Two kinds:

- **task** (default) — receiver acts on the body as if you typed it. Three delivery paths, in priority order:
  1. **Supervisor injection (realtime)** — if the receiver was launched via `claudemesh`, the supervisor writes `[inbox]\n` into the PTY the moment the message arrives and the receiver is idle + not actively typing. Sub-second wake-up.
  2. **Stop hook (between turns)** — if the receiver is _just finishing_ a turn when the message lands, the `Stop` hook blocks the stop and feeds the message in as the continuation directive.
  3. **UserPromptSubmit (next prompt)** — if neither of the above caught it (bare `claude`, fully idle), the message sits in the inbox until the user submits any prompt to that receiver, at which point it's appended as additional context for that turn.
- **note** — surfaces only via path #3 (next prompt). Doesn't block stops, doesn't wake the model.

Inbox is at-least-once and drained on read.

### Idle tracking

The daemon stores an `idle: boolean` per session, kept in sync by the hooks:

- `SessionStart` (or first register) → `idle: false`
- `UserPromptSubmit` (user just submitted) → `idle: false`
- `Stop`, when allowing the stop (no inbox tasks pending) → `idle: true`

The supervisor reads this flag before injecting, ensuring it never types into a session that's mid-turn.

## Configuration

`~/.claudemesh/config.json` (all keys optional):

```json
{
  "transport": "unix",
  "socket_path": "~/.claudemesh/daemon.sock",
  "host": "127.0.0.1",
  "port": 7878,
  "token": null,
  "redact": { "enabled": true, "line_byte_cap": 4096 },
  "statusline": { "show_peers": true, "show_inbox": true }
}
```

- `transport`: `"unix"` (default on macOS/Linux) or `"tcp"` (default on Windows). Switching restarts the daemon on the next command.
- `token`: shared secret sent as a bearer header. Required when `host` is not loopback. Cross-machine use is not supported yet; [docs/transport.md](./docs/transport.md) explains what is missing.
- `CLAUDEMESH_HOME` env var relocates the whole state directory (used by the tests).

## Privacy & security

- Daemon listens on a per-user `0600` unix socket by default, so other users on the same machine cannot reach it. TCP is opt-in; binding a non-loopback address is refused unless a shared `token` is configured. See [docs/transport.md](./docs/transport.md).
- `claude_id` is stable per claude _process_: `/clear` (new session_id, same pid) keeps the id, so peers' addresses and pending inbox messages survive it.
- The daemon reports its version on `/healthz`; a CLI/daemon version mismatch after an upgrade restarts the daemon automatically.
- `read_history` redacts large tool results / file contents above a per-line byte cap by default. Pass `redact: false` (or use `get_turn`) for raw.
- Hooks fail open: any daemon error is logged and the hook exits 0. Claude Code keeps working with no claudemesh integration if the daemon is down.
- The supervisor never writes to the PTY unless (a) the idle flag is set, (b) the inbox is still non-empty (a hook may have delivered the message first), (c) ≥500ms of stdin silence, and (d) no half-typed draft is pending (printable keys since the last Enter / ctrl-c / ctrl-u). Escape sequences such as arrow keys never count as a draft.

## Development

```bash
git clone git@github.com:ktamas77/claudemesh.git
cd claudemesh
npm install
npm run build       # tsc → dist/ (also chmod +x the bin)
npm run dev         # tsc --watch
npm run lint        # eslint
npm run format      # prettier --write
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit + a real daemon over a unix socket in a temp dir)
node scripts/smoke.mjs   # end-to-end through dist/: daemon spawn, hooks, statusline, /clear
```

Pre-commit (husky) runs `typecheck → test → lint-staged`. A broken type or failing test blocks the commit.

### Layout

```
src/
├── bin/claudemesh.ts          # entrypoint, dispatches all subcommands
├── cli/
│   ├── run.ts               # PTY supervisor (default `claudemesh` entrypoint)
│   ├── inject.ts            # pure "may we type into claude now?" decision (tested)
│   ├── send.ts, history.ts, search.ts, list.ts, whoami.ts, status.ts
│   ├── install.ts, statusline.ts
│   └── ...
├── daemon/
│   ├── server.ts            # HTTP routes incl. /events long-poll, PATCH idle; unix socket or TCP
│   ├── registry.ts          # id ↔ session ↔ pid ↔ cwd, idle flag
│   ├── inbox.ts             # per-recipient jsonl
│   ├── waiters.ts           # pub-sub for the events long-poll
│   └── liveness.ts          # prune dead PIDs
├── mcp/server.ts            # stdio MCP server
├── hooks/                   # session-start, session-end, user-prompt-submit, stop
└── shared/                  # paths, ids, http client, transcript reader, resolver
```

## Roadmap

- [x] Architecture & repo scaffold (TS + ESLint + Prettier + Husky)
- [x] Phase 1 — daemon + register/list + status line
- [x] Phase 2 — MCP tools (`whoami`, `list_instances`, `send_message`, `read_inbox`)
- [x] Phase 3 — task-mode wake-up, `read_history` / `search_history` / `get_turn`
- [x] Phase 4 — liveness sweep + lazy daemon autostart
- [x] Phase 5 — folder-name addressing, sharper imperative inbox prompts
- [x] Phase 6 — `claudemesh` PTY supervisor for realtime injection (with subcommand passthrough)
- [x] Unix-socket transport by default, TCP opt-in, bearer token for non-loopback, daemon version check on upgrade
- [x] Process-stable `claude_id` across `/clear`; supervisor skips injection when a hook already delivered, and never submits a half-typed draft
- [ ] Real-world soak across many concurrent supervisor sessions
- [ ] Network mode: heartbeat-based liveness + remote transcript access (see docs/transport.md)
- [ ] Reply chains: auto-set `from` when a recipient calls `send_message` after waking
- [ ] Optional desktop notification fallback for un-supervised idle sessions
- [ ] Inject the message body itself instead of an `[inbox]` sentinel (bracketed paste for multi-line; prepend `from <id> · ` for attribution; preserve existing path as fallback when paste mode unavailable)

### Why not tmux?

tmux's `send-keys` / `list-panes` could replace the daemon and the PTY supervisor outright. We considered it and kept the current design because it would require every session to run inside tmux, and the parts tmux cannot replace (idle hooks, transcript reader) are the ones that matter for safety. Full pro/con in [docs/why-not-tmux.md](./docs/why-not-tmux.md).

## License

[MIT](./LICENSE) © Tamas Kalman
