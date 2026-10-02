# Transport: unix socket vs TCP, and the network question

The daemon speaks plain HTTP. Where it listens is configurable in `~/.claudemesh/config.json`.

## Default: unix socket

```json
{ "transport": "unix" }
```

Socket file: `~/.claudemesh/daemon.sock`, mode `0600`. This is the default on macOS and Linux.

Why it is the default:

- **Per-user isolation for free.** `127.0.0.1` is shared by every user on the machine; a socket
  file under `~` is readable only by its owner. No token needed.
- **No port collisions.** Two users, or a second tool on 7878, cannot clash.
- **No ephemeral-port exhaustion.** Every TCP request burns a client port that sits in
  `TIME_WAIT`. A tight long-poll loop once exhausted them (commit 87052d7). Unix sockets have no
  port space.

## Opt-in: TCP

```json
{ "transport": "tcp", "host": "127.0.0.1", "port": 7878 }
```

Windows defaults to this (no unix sockets). Also useful if a tool outside Node wants to talk to
the daemon with `curl`.

## Can sessions communicate over a network?

**Not yet, and the plumbing deliberately stops you from trying blindly.** The daemon refuses to
bind a non-loopback address without a `token`:

```json
{ "transport": "tcp", "host": "0.0.0.0", "port": 7878, "token": "<long random string>" }
```

With a token set, every request must carry `Authorization: Bearer <token>`; the client sends it
automatically. Clients pointed at a remote host never try to spawn or kill a daemon (see
`decideDaemonAction` in `src/shared/daemon-spawn.ts`).

That gets you an authenticated wire. Two components still assume one host, so a shared daemon
across machines would misbehave today:

| Component                      | Assumption                                      | What breaks remotely                                        | Fix needed                                                |
| ------------------------------ | ----------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| liveness sweep (`liveness.ts`) | `process.kill(pid, 0)` on the daemon's own host | remote sessions' pids are meaningless → unregistered in 10s | heartbeat from hooks/supervisor, prune on missed beats    |
| history / search / get_turn    | reads `transcript_path` from the daemon's disk  | remote transcripts are unreadable                           | sessions push transcript tails, or daemon proxies to peer |

Both are tractable. Heartbeat is the smaller change (the supervisor already long-polls; the
Stop/UserPromptSubmit hooks already PATCH the record). Transcript access across machines is a
real design choice (push vs pull, size caps, redaction on the wire) and not something to bolt on.

Until then, treat `token` as the multi-user-on-one-box option, and keep `host` on loopback.

## Switching transport

Edit `config.json`, then run any claudemesh command. The client probes the configured address,
finds nothing, sees the old daemon pid is alive, terminates it and spawns a new one on the new
transport. The same path handles upgrades: `/healthz` reports the daemon's version, and a
mismatch with the installed CLI triggers a restart.
