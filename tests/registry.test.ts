import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLAUDEMESH_HOME = mkdtempSync(join(tmpdir(), "claudemesh-registry-"));
const { Registry } = await import("../src/daemon/registry.js");
const { paths } = await import("../src/shared/paths.js");

const base = { cwd: "/tmp/proj", transcript_path: "/tmp/t.jsonl" };

describe("Registry identity", () => {
  let reg: InstanceType<typeof Registry>;
  beforeEach(() => {
    reg = new Registry();
    for (const r of reg.list()) reg.unregister(r.claude_id);
  });

  it("fresh session gets a new id, idle, session file written", () => {
    const rec = reg.register({ ...base, session_id: "s1", claude_pid: 100 });
    expect(rec.claude_id).toHaveLength(8);
    expect(rec.idle).toBe(true);
    expect(existsSync(paths.sessionFile("s1"))).toBe(true);
  });

  it("same pid with a new session_id (/clear) keeps its claude_id — no ghost record", () => {
    // Regression: /clear fires SessionStart with a new session_id; the old record used to
    // linger forever (pid still alive) → duplicate rows + ambiguous folder addressing.
    const a = reg.register({ ...base, session_id: "s1", claude_pid: 100 });
    const b = reg.register({ ...base, session_id: "s2", claude_pid: 100 });
    expect(b.claude_id).toBe(a.claude_id);
    expect(b.session_id).toBe("s2");
    expect(reg.list()).toHaveLength(1);
    expect(reg.getBySession("s1")).toBeUndefined();
    expect(reg.getBySession("s2")?.claude_id).toBe(a.claude_id);
    expect(existsSync(paths.sessionFile("s1"))).toBe(false);
    expect(existsSync(paths.sessionFile("s2"))).toBe(true);
  });

  it("same session_id in a new process (--resume) keeps its claude_id and updates pid", () => {
    const a = reg.register({ ...base, session_id: "s1", claude_pid: 100 });
    reg.setIdle(a.claude_id, false);
    const b = reg.register({ ...base, session_id: "s1", claude_pid: 200 });
    expect(b.claude_id).toBe(a.claude_id);
    expect(reg.getByClaudePid(100)).toBeUndefined();
    expect(reg.getByClaudePid(200)?.claude_id).toBe(a.claude_id);
    expect(b.idle).toBe(true);
    expect(reg.list()).toHaveLength(1);
  });

  it("different pid and session_id is a different session", () => {
    const a = reg.register({ ...base, session_id: "s1", claude_pid: 100 });
    const b = reg.register({ ...base, session_id: "s2", claude_pid: 200 });
    expect(b.claude_id).not.toBe(a.claude_id);
    expect(reg.list()).toHaveLength(2);
  });

  it("persists and reloads", () => {
    const a = reg.register({ ...base, session_id: "s1", claude_pid: 100 });
    const reloaded = new Registry();
    expect(reloaded.get(a.claude_id)?.session_id).toBe("s1");
  });
});
