import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { renderForPaste, wrapPaste } from "../src/cli/inject.js";
import { shouldNotify } from "../src/daemon/notify.js";
import { Waiters } from "../src/daemon/waiters.js";
import { findRegisteredAncestor } from "../src/shared/ancestor.js";
import type { InboxMessage, InstanceRecord } from "../src/shared/types.js";

const msg = (over: Partial<InboxMessage>): InboxMessage => ({
  id: "m1",
  from: "aaaaaaaa",
  to: "bbbbbbbb",
  kind: "task",
  body: "rerun the migration check",
  ts: "2026-10-02T00:00:00Z",
  ...over,
});

describe("renderForPaste", () => {
  it("attributes the sender and keeps the body verbatim (multi-line included)", () => {
    const out = renderForPaste([msg({ body: "line 1\nline 2" })], (id) =>
      id === "aaaaaaaa" ? "api-service" : undefined,
    );
    expect(out).toBe(
      '[claudemesh message from aaaaaaaa (api-service) — reply with send_message to "aaaaaaaa"]\nline 1\nline 2',
    );
  });
  it("falls back to the bare id when the sender is unknown (e.g. cli)", () => {
    expect(renderForPaste([msg({ from: "cli" })])).toMatch(/^\[claudemesh message from cli — /);
  });
  it("joins several messages with a blank line and labels notes", () => {
    const out = renderForPaste([msg({}), msg({ id: "m2", kind: "note", body: "fyi" })]);
    expect(out.split("\n\n")).toHaveLength(2);
    expect(out).toContain("[claudemesh note from");
  });
  it("wrapPaste uses bracketed-paste markers", () => {
    expect(wrapPaste("x\ny")).toBe("\x1b[200~x\ny\x1b[201~");
  });
});

describe("shouldNotify", () => {
  const base = { enabled: true, kind: "task" as const, idle: true, supervised: false };
  it("fires only for a task into an idle, unsupervised session", () => {
    expect(shouldNotify(base)).toBe(true);
  });
  it("stays quiet for notes, busy sessions, supervised sessions, or when disabled", () => {
    expect(shouldNotify({ ...base, kind: "note" })).toBe(false);
    expect(shouldNotify({ ...base, idle: false })).toBe(false);
    expect(shouldNotify({ ...base, supervised: true })).toBe(false);
    expect(shouldNotify({ ...base, enabled: false })).toBe(false);
  });
});

describe("Waiters.recentlySeen", () => {
  it("remembers that a supervisor attached, within the window", () => {
    const w = new Waiters();
    const res = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      setHeader() {},
      end() {},
    });
    expect(w.recentlySeen("abc", 60_000)).toBe(false);
    w.add("abc", res as never, 30_000);
    expect(w.recentlySeen("abc", 60_000)).toBe(true);
    expect(w.recentlySeen("abc", 60_000, Date.now() + 61_000)).toBe(false);
    w.closeAll();
  });
});

describe("findRegisteredAncestor", () => {
  const rec = (pid: number): InstanceRecord => ({
    claude_id: `id${pid}`,
    session_id: "s",
    claude_pid: pid,
    cwd: "/x",
    transcript_path: "/t",
    started_at: "",
    last_active: "",
    pending_count: 0,
    idle: true,
  });
  // tree: 500 (claudemesh) → 400 (zsh -c) → 300 (claude) → 200 (terminal) → 1
  const parents: Record<number, number | null> = { 500: 400, 400: 300, 300: 200, 200: 1, 1: null };
  const parentOf = (p: number): number | null => parents[p] ?? null;

  it("finds claude two levels up through the Bash tool's shell", () => {
    expect(findRegisteredAncestor(400, [rec(300), rec(999)], parentOf)?.claude_id).toBe("id300");
  });
  it("returns undefined when no ancestor is registered", () => {
    expect(findRegisteredAncestor(400, [rec(999)], parentOf)).toBeUndefined();
  });
  it("matches the direct parent first", () => {
    expect(findRegisteredAncestor(400, [rec(400), rec(300)], parentOf)?.claude_id).toBe("id400");
  });
});
