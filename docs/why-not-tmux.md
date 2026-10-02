# Why not just use tmux?

Claudemesh ships its own localhost daemon and a `node-pty` supervisor so that one Claude Code
session can wake another by typing into its terminal. tmux already does both of those things
natively. This note records what tmux would replace, what it would not, and why we kept the
current design anyway.

## What tmux gives for free

| Claudemesh piece                                                    | tmux equivalent                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| daemon registry + liveness sweep (`src/daemon/`)                    | `tmux list-panes -a -F '#{pane_id} #{pane_current_path} #{pane_current_command}'` |
| PTY supervisor + `[inbox]` injection (`src/cli/run.ts`, `node-pty`) | `tmux send-keys -t %3 'text' Enter`                                               |
| inbox queue + long-poll events                                      | not needed; delivery is immediate                                                 |
| roadmap item "inject the body, not a sentinel"                      | `tmux load-buffer - && tmux paste-buffer -p -t %3` (bracketed paste, multi-line)  |
| reading another agent's screen                                      | `tmux capture-pane -p -t %3 -S -500`                                              |

That is roughly 1100 of the 2700 lines in this repo, plus the only native dependency.

## What tmux does not give

- **Idle gating.** `send-keys` lands in whatever is focused in the pane. If claude is showing a
  permission dialog, a message followed by Enter can confirm it. The `Stop` /
  `UserPromptSubmit` hooks are the only reliable "safe to type" signal and would have to stay,
  writing an idle flag keyed by `$TMUX_PANE` (hooks inherit it from claude).
- **Structured history.** `capture-pane` returns rendered TUI text. The JSONL transcript reader
  (`src/shared/transcript.ts`) is strictly better and would stay.
- **Terminals outside tmux.** Every agent must run inside tmux. Ghostty, Terminal.app, VS Code
  terminals, etc. only participate if the user starts tmux first. iTerm2 has `tmux -CC` native
  integration; most others do not.
- **Typing collision.** The supervisor waits for 500ms of stdin silence before injecting. tmux
  cannot see the user's keystrokes, so a message could interleave with half-typed input.
- **Guards you must add yourself.** `#{pane_in_mode}` (copy mode swallows keys),
  `pane_current_command` (claude exited, pane is now a shell: your message becomes a shell command).

## Pros

- Deletes the daemon, the supervisor, and `node-pty`. No HTTP, no sockets, no native build.
- Discovery and liveness are exact (tmux knows when a pane dies).
- Multi-line body paste solved by `paste-buffer -p`.
- The message is visible in the recipient's input box, so the human sees what arrived.
- The MCP server becomes optional: `tmux send-keys` from Bash is enough.

## Cons

- Hard requirement that all sessions live in tmux. This is the real cost.
- Still needs the hooks for idle, so it is "fewer moving parts", not "zero".
- Safety guards (dialog, copy mode, dead claude) are heuristics layered on tmux, where the
  current design gets them from claude's own hook lifecycle.
- No `✉N` badge or queued-while-busy semantics without reintroducing a queue.

## Why we skipped it

Claudemesh's contract is "zero changes to how you already run `claude`". Requiring tmux
breaks that for anyone on a plain terminal, and the pieces tmux cannot replace (idle hooks,
transcript reader) are the ones that carry the correctness burden. The deleted code is mostly
plumbing, not risk.

If tmux-only becomes acceptable for your own usage, the port is small: two hooks writing
`~/.claudemesh/panes/<pane_id>.json`, and `list` / `send` as thin wrappers over the commands
above.

## Open question to verify first

Whether current Claude Code queues text typed mid-turn as the next message. If it does, idle
gating shrinks to "not in a dialog" and the hooks matter less. Test with a live session before
building on either answer.
