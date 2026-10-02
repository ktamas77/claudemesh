export const STDIN_QUIET_THRESHOLD_MS = 500;

export type InjectDecision = "inject" | "retry" | "drop";

export interface InputState {
  /** Timestamp of the last byte the user typed (0 = never). */
  lastKeystrokeAt: number;
  /** True when printable characters were typed since the last Enter / ctrl-c / ctrl-u. */
  draftPending: boolean;
}

/**
 * Decide whether the supervisor may type the wake sentinel into claude right now.
 *  - record unknown → retry (daemon hiccup)
 *  - inbox already empty → drop: a hook (Stop or UserPromptSubmit) delivered the message
 *    first; typing `[inbox]` now would give claude a bare, context-free prompt
 *  - claude mid-turn → retry
 *  - user typed within the quiet window → retry
 *  - user has a half-typed draft → retry (appending `[inbox]\r` would submit their draft)
 */
export function decideInject(
  rec: { idle: boolean; pending_count: number } | null,
  input: InputState,
  now: number,
): InjectDecision {
  if (!rec) return "retry";
  if (rec.pending_count === 0) return "drop";
  if (!rec.idle) return "retry";
  if (now - input.lastKeystrokeAt < STDIN_QUIET_THRESHOLD_MS) return "retry";
  if (input.draftPending) return "retry";
  return "inject";
}

/**
 * Fold one chunk of raw stdin into the draft flag.
 * Enter (\r or \n), ctrl-c (\x03) and ctrl-u (\x15) clear the input line in Claude Code.
 * Escape sequences (arrows, mouse, focus events) start with \x1b and never count as typing.
 * ponytail: byte heuristic, not a line editor model; Esc-clears and backspace-to-empty are
 * not tracked, so we may wait longer than needed but never submit someone's draft.
 */
export function updateDraft(prev: boolean, chunk: string): boolean {
  if (chunk.length === 0) return prev;
  if (chunk.startsWith("\x1b")) return prev;
  const CLEARS = ["\r", "\n", "\x03", "\x15"];
  if (CLEARS.some((c) => chunk.includes(c))) return false;
  for (const ch of chunk) {
    if (ch >= " " && ch !== "\x7f") return true;
  }
  return prev;
}
