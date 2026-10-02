import { execFileSync } from "node:child_process";
import { daemon } from "./client.js";
import type { InstanceRecord } from "./types.js";

const MAX_DEPTH = 8;

/** Parent pid via `ps`; null at the root or on failure. */
export function parentPid(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const n = Number(out.trim());
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/** Pure: walk up from `startPid` and return the first registered record, if any. */
export function findRegisteredAncestor(
  startPid: number,
  records: InstanceRecord[],
  parentOf: (pid: number) => number | null = parentPid,
): InstanceRecord | undefined {
  const byPid = new Map(records.map((r) => [r.claude_pid, r] as const));
  let pid: number | null = startPid;
  for (let depth = 0; depth < MAX_DEPTH && pid !== null; depth++) {
    const hit = byPid.get(pid);
    if (hit) return hit;
    pid = parentOf(pid);
  }
  return undefined;
}

/**
 * The claude session this process runs under, if any. Walks the process tree because a CLI
 * invoked from claude's Bash tool sits under a shell (`zsh -c …`) whose parent is claude.
 */
export async function selfSession(): Promise<InstanceRecord | undefined> {
  const records = await daemon.list();
  return findRegisteredAncestor(process.ppid, records);
}
