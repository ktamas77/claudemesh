import type * as NodePty from "node-pty";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { daemon, DaemonError } from "../shared/client.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import { decideInject, updateDraft, type InputState } from "./inject.js";

type IPty = NodePty.IPty;

const POLL_REGISTER_INTERVAL_MS = 100;
const EVENTS_LONG_POLL_MS = 25_000;
const INJECT_RETRY_MS = 250;
const WAKE_SENTINEL = "[inbox]";

export async function runChild(args: string[]): Promise<void> {
  let ptySpawn: typeof NodePty.spawn;
  try {
    ({ spawn: ptySpawn } = await import("node-pty"));
  } catch (err) {
    console.error(
      "[claudemesh run] node-pty failed to load. The PTY supervisor needs node-pty (a native module).",
    );
    console.error(`  underlying error: ${(err as Error).message}`);
    console.error("  Try: cd $(npm root -g)/@ktamas77/claudemesh && npm rebuild node-pty");
    console.error(
      "  Meanwhile you can keep using bare `claude`; hooks + MCP + status line still work,",
    );
    console.error("  just without realtime injection of inbox messages.");
    process.exitCode = 1;
    return;
  }

  const claudeBinName = process.env.CLAUDEMESH_CLAUDE_BIN ?? "claude";
  let claudeBinAbs: string;
  try {
    claudeBinAbs = resolveBin(claudeBinName);
  } catch (err) {
    console.error(`[claudemesh run] ${(err as Error).message}`);
    console.error(
      `  Set CLAUDEMESH_CLAUDE_BIN to the absolute path of the claude binary if it's not on PATH.`,
    );
    process.exitCode = 127;
    return;
  }

  const cwd = process.cwd();
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const env: { [key: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }

  await ensureDaemonRunning().catch(() => undefined);

  let child: IPty;
  try {
    child = ptySpawn(claudeBinAbs, args, { name: "xterm-256color", cols, rows, cwd, env });
  } catch (err) {
    console.error(`[claudemesh run] failed to spawn ${claudeBinAbs}: ${(err as Error).message}`);
    console.error(
      `  Try running ${claudeBinAbs} directly to see the real error, or set CLAUDEMESH_CLAUDE_BIN to a different binary.`,
    );
    process.exitCode = 1;
    return;
  }

  const wasRaw = process.stdin.isTTY ? process.stdin.isRaw : false;
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();

  const input: InputState = { lastKeystrokeAt: 0, draftPending: false };
  const onStdin = (data: Buffer | string): void => {
    const text = typeof data === "string" ? data : data.toString("utf8");
    input.lastKeystrokeAt = Date.now();
    input.draftPending = updateDraft(input.draftPending, text);
    child.write(text);
  };
  process.stdin.on("data", onStdin);

  const onChildData = (chunk: string): void => {
    process.stdout.write(chunk);
  };
  child.onData(onChildData);

  const onResize = (): void => {
    const c = process.stdout.columns ?? 80;
    const r = process.stdout.rows ?? 24;
    try {
      child.resize(c, r);
    } catch {
      // child may have exited
    }
  };
  process.stdout.on("resize", onResize);

  const forwardSignal = (sig: NodeJS.Signals): void => {
    try {
      child.kill(sig);
    } catch {
      // child gone
    }
  };
  process.on("SIGINT", forwardSignal);
  process.on("SIGTERM", forwardSignal);

  const exitCode: Promise<number> = new Promise((resolve) => {
    child.onExit(({ exitCode: code, signal }) => {
      resolve(typeof code === "number" ? code : signal ? 128 + signal : 1);
    });
  });

  const subscriberCancel = startSubscriber(child, input);

  const code = await exitCode;
  subscriberCancel();
  process.stdin.removeListener("data", onStdin);
  process.stdout.removeListener("resize", onResize);
  process.off("SIGINT", forwardSignal);
  process.off("SIGTERM", forwardSignal);
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(wasRaw);
    } catch {
      // best effort
    }
  }
  process.stdin.pause();

  process.exitCode = code;
}

function startSubscriber(child: IPty, input: InputState): () => void {
  let cancelled = false;
  let claudeId: string | null = null;
  let pendingWake = false;

  const tryInject = (): void => {
    if (cancelled || !pendingWake) return;
    if (!claudeId) {
      setTimeout(tryInject, INJECT_RETRY_MS);
      return;
    }
    daemon
      .get(claudeId)
      .then((rec) => {
        if (cancelled || !pendingWake) return;
        switch (decideInject(rec, input, Date.now())) {
          case "retry":
            setTimeout(tryInject, INJECT_RETRY_MS);
            return;
          case "drop":
            pendingWake = false;
            return;
          case "inject":
            try {
              child.write(`${WAKE_SENTINEL}\r`);
              pendingWake = false;
            } catch {
              // child gone
            }
        }
      })
      .catch(() => setTimeout(tryInject, INJECT_RETRY_MS));
  };

  const loop = async (): Promise<void> => {
    while (!cancelled && claudeId === null) {
      try {
        const rec = await daemon.byPid(child.pid, { timeoutMs: 1000 });
        claudeId = rec.claude_id;
      } catch (err) {
        if (err instanceof DaemonError && err.status === 404) {
          await sleep(POLL_REGISTER_INTERVAL_MS);
          continue;
        }
        if (cancelled) return;
        await sleep(POLL_REGISTER_INTERVAL_MS);
      }
    }
    while (!cancelled && claudeId !== null) {
      // If we're already holding a pending wake we haven't been able to
      // deliver yet (user mid-typing, session still mid-turn), don't re-poll
      // the events endpoint — the daemon would just keep returning 200 the
      // instant the inbox is non-empty and we'd burn through ephemeral ports
      // in a tight loop, exhausting them with TIME_WAIT entries.
      if (pendingWake) {
        await sleep(INJECT_RETRY_MS);
        continue;
      }
      try {
        const ev = await daemon.events(claudeId, EVENTS_LONG_POLL_MS);
        if (cancelled) return;
        if (ev && ev.type === "message") {
          pendingWake = true;
          tryInject();
        }
      } catch {
        if (cancelled) return;
        await sleep(1000);
      }
    }
  };

  void loop();

  return () => {
    cancelled = true;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveBin(name: string): string {
  if (isAbsolute(name) || name.includes("/")) {
    if (isExecutableFile(name)) return name;
    throw new Error(`"${name}" is not an executable file`);
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(
    `could not find "${name}" on PATH (searched ${path.split(":").filter(Boolean).length} directories)`,
  );
}

function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    if (!st.isFile() && !st.isSymbolicLink()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
