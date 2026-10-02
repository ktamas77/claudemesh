import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

// Boots the real daemon over a unix socket with a token, drives it through the real client.
const home = mkdtempSync(join(tmpdir(), "claudemesh-daemon-"));
process.env.CLAUDEMESH_HOME = home;
writeFileSync(join(home, "config.json"), JSON.stringify({ transport: "unix", token: "t0k" }));

const { startDaemon } = await import("../src/daemon/server.js");
const { daemon, DaemonError } = await import("../src/shared/client.js");
const { paths } = await import("../src/shared/paths.js");
const { packageVersion } = await import("../src/shared/version.js");

let handle: Awaited<ReturnType<typeof startDaemon>>;

beforeAll(async () => {
  handle = await startDaemon();
});
afterAll(async () => {
  await handle.close();
});

describe("daemon over unix socket", () => {
  it("creates a 0600 socket and reports its version", async () => {
    expect(existsSync(paths.socket)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
    }
    const h = await daemon.health();
    expect(h.ok).toBe(true);
    expect(h.version).toBe(packageVersion());
  });

  it("rejects requests without the bearer token", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: paths.socket, path: "/healthz", method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(401);
  });

  it("register → send → events → drain round-trip", async () => {
    const a = await daemon.register({
      session_id: "sa",
      claude_pid: process.pid,
      cwd: "/tmp/a",
      transcript_path: "/dev/null",
    });
    const b = await daemon.register({
      session_id: "sb",
      claude_pid: process.pid + 1_000_000, // not alive; sweep runs every 10s so fine within the test
      cwd: "/tmp/b",
      transcript_path: "/dev/null",
    });
    expect(a.claude_id).not.toBe(b.claude_id);

    const waiting = daemon.events(b.claude_id, 5_000);
    await daemon.sendMessage(b.claude_id, { from: a.claude_id, body: "hello", kind: "task" });
    const ev = await waiting;
    expect(ev).toMatchObject({ type: "message", pending: 1 });

    const rec = await daemon.get(b.claude_id);
    expect(rec.pending_count).toBe(1);

    const msgs = await daemon.drainInbox(b.claude_id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ from: a.claude_id, to: b.claude_id, body: "hello" });
    expect((await daemon.get(b.claude_id)).pending_count).toBe(0);
  });

  it("re-register with the same pid keeps the id across the wire", async () => {
    const first = await daemon.register({
      session_id: "sx",
      claude_pid: 424242,
      cwd: "/tmp/x",
      transcript_path: "/dev/null",
    });
    const second = await daemon.register({
      session_id: "sy",
      claude_pid: 424242,
      cwd: "/tmp/x",
      transcript_path: "/dev/null",
    });
    expect(second.claude_id).toBe(first.claude_id);
    const all = await daemon.list();
    expect(all.filter((r) => r.cwd === "/tmp/x")).toHaveLength(1);
  });

  it("unregister removes the session's inbox file (no orphans)", async () => {
    const { existsSync } = await import("node:fs");
    const rec = await daemon.register({
      session_id: "sz",
      claude_pid: 434343,
      cwd: "/tmp/z",
      transcript_path: "/dev/null",
    });
    await daemon.sendMessage(rec.claude_id, { from: "cli", body: "left behind?", kind: "note" });
    expect(existsSync(paths.inboxFile(rec.claude_id))).toBe(true);
    await daemon.unregister(rec.claude_id);
    expect(existsSync(paths.inboxFile(rec.claude_id))).toBe(false);
  });

  it("404s on unknown ids with a DaemonError", async () => {
    await expect(daemon.get("zzzzzzzz")).rejects.toBeInstanceOf(DaemonError);
  });
});
