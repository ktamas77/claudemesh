import { describe, expect, it } from "vitest";
import { decideInject, updateDraft, STDIN_QUIET_THRESHOLD_MS } from "../src/cli/inject.js";

const quiet = { lastKeystrokeAt: 0, draftPending: false };
const now = 100_000;

describe("decideInject", () => {
  it("injects when idle, inbox non-empty, stdin quiet, no draft", () => {
    expect(decideInject({ idle: true, pending_count: 1 }, quiet, now)).toBe("inject");
  });

  it("drops when the inbox is already empty (a hook delivered it first)", () => {
    // Regression: previously typed a bare `[inbox]` into claude after Stop/UserPromptSubmit drained.
    expect(decideInject({ idle: true, pending_count: 0 }, quiet, now)).toBe("drop");
  });

  it("retries while claude is mid-turn", () => {
    expect(decideInject({ idle: false, pending_count: 1 }, quiet, now)).toBe("retry");
  });

  it("retries while the user typed inside the quiet window", () => {
    const input = { lastKeystrokeAt: now - STDIN_QUIET_THRESHOLD_MS + 1, draftPending: false };
    expect(decideInject({ idle: true, pending_count: 1 }, input, now)).toBe("retry");
  });

  it("retries while the user has a paused, half-typed draft", () => {
    // Regression: 500ms of silence used to be enough, submitting the user's partial prompt.
    const input = { lastKeystrokeAt: now - 60_000, draftPending: true };
    expect(decideInject({ idle: true, pending_count: 1 }, input, now)).toBe("retry");
  });

  it("retries when the record is unavailable", () => {
    expect(decideInject(null, quiet, now)).toBe("retry");
  });
});

describe("updateDraft", () => {
  it("printable text starts a draft", () => {
    expect(updateDraft(false, "fix the")).toBe(true);
  });
  it("Enter, ctrl-c and ctrl-u clear the draft", () => {
    expect(updateDraft(true, "\r")).toBe(false);
    expect(updateDraft(true, "\n")).toBe(false);
    expect(updateDraft(true, "\x03")).toBe(false);
    expect(updateDraft(true, "\x15")).toBe(false);
  });
  it("text followed by Enter in one chunk is not a draft (pasted line)", () => {
    expect(updateDraft(false, "hello\r")).toBe(false);
  });
  it("escape sequences (arrows, mouse) never count as typing", () => {
    expect(updateDraft(false, "\x1b[A")).toBe(false);
    expect(updateDraft(true, "\x1b[A")).toBe(true);
  });
  it("backspace alone does not start a draft", () => {
    expect(updateDraft(false, "\x7f")).toBe(false);
  });
});
