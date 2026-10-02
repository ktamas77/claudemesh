import { spawn } from "node:child_process";
import type { MessageKind } from "../shared/types.js";

/** A supervisor long-polls continuously; if none has been seen this long, the session is bare `claude`. */
export const SUPERVISED_WINDOW_MS = 60_000;

/**
 * Notify the human only when nothing else will wake the model: a task (notes are silent by
 * design) landing in an idle session that no supervisor is attached to. Mid-turn arrivals are
 * handled by the Stop hook, supervised sessions by the PTY injection.
 */
export function shouldNotify(args: {
  enabled: boolean;
  kind: MessageKind;
  idle: boolean;
  supervised: boolean;
}): boolean {
  return args.enabled && args.kind === "task" && args.idle && !args.supervised;
}

export function sendDesktopNotification(title: string, body: string): void {
  // ponytail: fire-and-forget, macOS + freedesktop only; no-op elsewhere.
  const clean = (s: string): string => s.replace(/["\\]/g, "").slice(0, 200);
  let cmd: string[] | null = null;
  if (process.platform === "darwin") {
    cmd = ["osascript", "-e", `display notification "${clean(body)}" with title "${clean(title)}"`];
  } else if (process.platform === "linux") {
    cmd = ["notify-send", clean(title), clean(body)];
  }
  if (!cmd) return;
  try {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // notification is best-effort
  }
}
