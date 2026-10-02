#!/usr/bin/env node
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "dist", "bin", "claudemesh.js");

// Self-contained: isolated state dir (inherited by the hook/statusline subprocesses below),
// daemon auto-spawned on whatever transport the config in that dir says (default: unix socket).
process.env.CLAUDEMESH_HOME ??= mkdtempSync(join(tmpdir(), "claudemesh-smoke-"));
const { ensureDaemonRunning, readDaemonPid } = await import("../dist/shared/daemon-spawn.js");
const { loadConfig, socketPath } = await import("../dist/shared/config.js");
await ensureDaemonRunning();
const cfg = loadConfig();
console.log(`daemon pid ${readDaemonPid()} via ${cfg.transport} (${process.env.CLAUDEMESH_HOME})`);

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body && Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        ...(cfg.transport === "unix"
          ? { socketPath: socketPath(cfg) }
          : { host: cfg.host, port: cfg.port }),
        path,
        method,
        headers: {
          ...(payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : {}),
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text || "null") });
          } catch {
            resolve({ status: res.statusCode, body: text });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function runBin(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      }),
    );
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function ok(label, cond) {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) process.exitCode = 1;
}

// Two live pids (identity is per claude process, so A and B need distinct ones) that the
// liveness sweep won't prune: this script and its parent shell.
const fakeClaudePid = process.pid;
const fakeClaudePidB = process.ppid;

// 1. Direct daemon API
const a = await call("POST", "/register", {
  session_id: "smoke-A",
  claude_pid: fakeClaudePid,
  cwd: "/tmp/A",
  transcript_path: "/tmp/A.jsonl",
});
ok(
  "register A returns 200 + claude_id",
  a.status === 200 && /^[a-z0-9]{8}$/.test(a.body.claude_id),
);
const b = await call("POST", "/register", {
  session_id: "smoke-B",
  claude_pid: fakeClaudePidB,
  cwd: "/tmp/B",
  transcript_path: "/tmp/B.jsonl",
});
ok("register B unique id", a.body.claude_id !== b.body.claude_id);

const list = await call("GET", "/instances");
ok("list shows ≥2 instances", list.body.length >= 2);

const send = await call("POST", `/instances/${b.body.claude_id}/messages`, {
  from: a.body.claude_id,
  body: "hi from A",
  kind: "task",
});
ok("send message returns 200", send.status === 200);

const peek = await call("GET", `/instances/${b.body.claude_id}/messages`);
ok("peek inbox returns 1", peek.body.length === 1);

const bRec = await call("GET", `/instances/${b.body.claude_id}`);
ok("pending_count synced", bRec.body.pending_count === 1);

const drain = await call("GET", `/instances/${b.body.claude_id}/messages?drain=1`);
ok("drain returns the message", drain.body[0]?.body === "hi from A");

const peek2 = await call("GET", `/instances/${b.body.claude_id}/messages`);
ok("inbox empty after drain", peek2.body.length === 0);

const lookup = await call("GET", `/by-pid/${fakeClaudePid}`);
ok("by-pid lookup works", lookup.status === 200);

const wrong = await call("POST", "/instances/zzzzzzzz/messages", {
  from: a.body.claude_id,
  body: "x",
});
ok("send to unknown id → 404", wrong.status === 404);

// 2. Statusline
const sl1 = await runBin(["statusline"], JSON.stringify({ session_id: "smoke-A" }));
ok(
  `statusline shows id+peers (got: ${sl1.stdout.trim()})`,
  sl1.stdout.includes(a.body.claude_id) && sl1.stdout.includes("peers"),
);

// Send a message back to A to verify ✉ count appears
await call("POST", `/instances/${a.body.claude_id}/messages`, {
  from: b.body.claude_id,
  body: "hello back",
  kind: "note",
});
const sl2 = await runBin(["statusline"], JSON.stringify({ session_id: "smoke-A" }));
ok(`statusline shows ✉ when inbox non-empty (got: ${sl2.stdout.trim()})`, sl2.stdout.includes("✉"));

// 3. UserPromptSubmit hook drains inbox and emits additionalContext
const ups = await runBin(["hook", "user-prompt-submit"], JSON.stringify({ session_id: "smoke-A" }));
let parsed = null;
try {
  parsed = JSON.parse(ups.stdout);
} catch {}
ok(
  "user-prompt-submit emits additionalContext containing the message",
  parsed?.hookSpecificOutput?.additionalContext?.includes("hello back") ?? false,
);

const sl3 = await runBin(["statusline"], JSON.stringify({ session_id: "smoke-A" }));
ok(`statusline drops ✉ after drain (got: ${sl3.stdout.trim()})`, !sl3.stdout.includes("✉"));

// 4. Stop hook with task message blocks; with note doesn't
await call("POST", `/instances/${a.body.claude_id}/messages`, {
  from: b.body.claude_id,
  body: "task body",
  kind: "task",
});
const stopOut = await runBin(["hook", "stop"], JSON.stringify({ session_id: "smoke-A" }));
let stopParsed = null;
try {
  stopParsed = JSON.parse(stopOut.stdout);
} catch {}
ok(
  "Stop hook blocks when task in inbox",
  stopParsed?.decision === "block" && stopParsed?.reason?.includes("task body"),
);

await call("POST", `/instances/${a.body.claude_id}/messages`, {
  from: b.body.claude_id,
  body: "just a note",
  kind: "note",
});
const stopOut2 = await runBin(["hook", "stop"], JSON.stringify({ session_id: "smoke-A" }));
ok("Stop hook does NOT block on note-only inbox", stopOut2.stdout.trim() === "");

// 5. /clear: same pid, new session_id → same claude_id, no ghost
const a2 = await call("POST", "/register", {
  session_id: "smoke-A-cleared",
  claude_pid: fakeClaudePid,
  cwd: "/tmp/A",
  transcript_path: "/tmp/A.jsonl",
});
ok("re-register same pid keeps claude_id", a2.body.claude_id === a.body.claude_id);
const list2 = await call("GET", "/instances");
ok("no ghost record after /clear", list2.body.filter((r) => r.cwd === "/tmp/A").length === 1);

// cleanup
await call("DELETE", `/instances/${a.body.claude_id}`);
await call("DELETE", `/instances/${b.body.claude_id}`);
try {
  process.kill(readDaemonPid(), "SIGTERM");
} catch {}
console.log("done");
