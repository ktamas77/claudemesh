import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { paths, ensureDirs } from "./paths.js";
import { daemon, DaemonError } from "./client.js";
import { loadConfig, isLocalDaemon } from "./config.js";
import { packageVersion } from "./version.js";
import { isAlive } from "../daemon/liveness.js";

const SPAWN_TIMEOUT_MS = 5000;
const SPAWN_POLL_MS = 50;

export type DaemonAction = "ok" | "spawn" | "kill-and-spawn" | "unreachable";

/**
 * Pure decision: given the health probe result (null = no answer), whether the pidfile's
 * process is alive, and whether the daemon is local, what should ensureDaemonRunning do?
 *  - healthy + same version → ok
 *  - healthy + other version → kill-and-spawn (stale daemon left over from an upgrade)
 *  - no answer, local, pidfile alive → kill-and-spawn (old daemon on a different transport/port)
 *  - no answer, local → spawn
 *  - no answer, remote → unreachable (never spawn or kill anything for a remote daemon)
 */
export function decideDaemonAction(
  health: { version?: string } | null,
  pidAlive: boolean,
  local: boolean,
  ourVersion: string,
): DaemonAction {
  if (health) {
    return (health.version ?? "") === ourVersion || !local ? "ok" : "kill-and-spawn";
  }
  if (!local) return "unreachable";
  return pidAlive ? "kill-and-spawn" : "spawn";
}

export async function ensureDaemonRunning(): Promise<void> {
  const cfg = loadConfig();
  const health = await probe();
  const pid = readDaemonPid();
  const action = decideDaemonAction(
    health,
    pid !== null && isAlive(pid),
    isLocalDaemon(cfg),
    packageVersion(),
  );
  switch (action) {
    case "ok":
      return;
    case "unreachable":
      throw new DaemonError(`remote daemon at ${cfg.host}:${cfg.port} is not responding`);
    case "kill-and-spawn":
      if (pid !== null) await killDaemon(pid);
      break;
    case "spawn":
      break;
  }
  spawnDaemon();
  await waitForDaemon();
}

async function probe(): Promise<{ version?: string } | null> {
  try {
    return await daemon.health({ timeoutMs: 250 });
  } catch {
    return null;
  }
}

async function killDaemon(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && isAlive(pid)) await sleep(SPAWN_POLL_MS);
  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

function spawnDaemon(): void {
  ensureDirs();
  const claudemeshBin = locateBin();
  const out = openSync(paths.daemonLog, "a");
  const err = openSync(paths.daemonLog, "a");
  const child = spawn(process.execPath, [claudemeshBin, "daemon"], {
    detached: true,
    stdio: ["ignore", out, err],
    env: process.env,
  });
  closeSync(out);
  closeSync(err);
  if (child.pid !== undefined) {
    writeFileSync(paths.daemonPid, String(child.pid));
  }
  child.unref();
}

async function waitForDaemon(): Promise<void> {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await sleep(SPAWN_POLL_MS);
  }
  throw new DaemonError("daemon failed to come up within timeout");
}

function locateBin(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "bin", "claudemesh.js");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readDaemonPid(): number | null {
  if (!existsSync(paths.daemonPid)) return null;
  const text = readFileSync(paths.daemonPid, "utf8").trim();
  const pid = Number(text);
  return Number.isFinite(pid) ? pid : null;
}
