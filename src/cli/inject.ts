import type { InboxMessage } from "../shared/types.js";

export const STDIN_QUIET_THRESHOLD_MS = 500;
export const WAKE_SENTINEL = "[inbox]";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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

/**
 * The text the supervisor pastes into claude in "body" mode. The message *is* the prompt, so
 * no directive framing is needed; one attribution line per message tells the model who to
 * `send_message` back to. Multi-line bodies are safe: the whole thing goes in one bracketed paste.
 */
export function renderForPaste(
  messages: InboxMessage[],
  nameOf: (claudeId: string) => string | undefined = () => undefined,
): string {
  return messages
    .map((m) => {
      const from = sanitize(m.from);
      const name = nameOf(m.from);
      const who = name ? `${from} (${sanitize(name)})` : from;
      const tag = m.kind === "note" ? "note" : "message";
      return `[claudemesh ${tag} from ${who} — reply with send_message to "${from}"]\n${sanitize(m.body)}`;
    })
    .join("\n\n");
}

/**
 * Everything pasted into claude is typed into a terminal, so a peer (or a model-authored body)
 * must not be able to smuggle an in-band paste terminator or escape sequences that the TUI
 * would act on as keystrokes. Keep newlines and tabs; drop every other control byte, ESC first.
 */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Wrap text so the terminal app receives it as a single paste (claude enables mode 2004). */
export function wrapPaste(text: string): string {
  // Belt and braces: no code path may emit the terminator inside the paste.
  return `${PASTE_START}${text.replaceAll(PASTE_END, "")}${PASTE_END}`;
}
