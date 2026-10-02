import { request as httpRequest, Agent as HttpAgent } from "node:http";
import { loadConfig, socketPath } from "./config.js";
import type { DaemonConfig, InstanceRecord, InboxMessage, MessageKind } from "./types.js";

const keepAliveAgent = new HttpAgent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 8,
  maxFreeSockets: 4,
});

class DaemonError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DaemonError";
  }
}

interface ClientOptions {
  retry?: boolean;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_MS = 5000;

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: ClientOptions = {},
): Promise<T> {
  const cfg = loadConfig();
  const start = Date.now();
  const retry = opts.retry ?? false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let attempt = 0;
  let lastError: unknown;

  while (true) {
    try {
      return await rawCall<T>(cfg, method, path, body, timeoutMs);
    } catch (err) {
      lastError = err;
      const elapsed = Date.now() - start;
      if (!retry || elapsed > DEFAULT_RETRY_MAX_MS) break;
      attempt++;
      await sleep(Math.min(DEFAULT_RETRY_DELAY_MS * attempt, 500));
    }
  }
  throw lastError;
}

function rawCall<T>(
  cfg: DaemonConfig,
  method: string,
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = httpRequest(
      {
        ...(cfg.transport === "unix"
          ? { socketPath: socketPath(cfg) }
          : { host: cfg.host, port: cfg.port }),
        path,
        method,
        agent: keepAliveAgent,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(payload.length) } : {}),
          ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            if (text.length === 0) {
              resolve(undefined as T);
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (e) {
              reject(new DaemonError(`invalid JSON response: ${(e as Error).message}`, status));
            }
            return;
          }
          let code: string | undefined;
          try {
            const parsed = JSON.parse(text) as { error?: string; code?: string };
            code = parsed.code;
            reject(new DaemonError(parsed.error ?? `HTTP ${status}`, status, code));
          } catch {
            reject(new DaemonError(`HTTP ${status}: ${text}`, status));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new DaemonError("daemon request timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RegisterPayload {
  session_id: string;
  claude_pid: number;
  cwd: string;
  transcript_path: string;
}

export const daemon = {
  health(opts?: ClientOptions): Promise<{ ok: true; instances: number; version?: string }> {
    return call("GET", "/healthz", undefined, opts);
  },
  register(payload: RegisterPayload, opts?: ClientOptions): Promise<{ claude_id: string }> {
    return call("POST", "/register", payload, opts);
  },
  unregister(claudeId: string): Promise<void> {
    return call("DELETE", `/instances/${claudeId}`);
  },
  list(opts?: ClientOptions): Promise<InstanceRecord[]> {
    return call("GET", "/instances", undefined, opts);
  },
  get(claudeId: string, opts?: ClientOptions): Promise<InstanceRecord> {
    return call("GET", `/instances/${claudeId}`, undefined, opts);
  },
  byPid(pid: number, opts?: ClientOptions): Promise<InstanceRecord> {
    return call("GET", `/by-pid/${pid}`, undefined, opts);
  },
  sendMessage(
    to: string,
    body: { from: string; body: string; kind?: MessageKind },
  ): Promise<{ id: string }> {
    return call("POST", `/instances/${to}/messages`, body);
  },
  drainInbox(claudeId: string): Promise<InboxMessage[]> {
    return call("GET", `/instances/${claudeId}/messages?drain=1`);
  },
  peekInbox(claudeId: string): Promise<InboxMessage[]> {
    return call("GET", `/instances/${claudeId}/messages`);
  },
  history(
    claudeId: string,
    params: { last_n_turns?: number; redact?: boolean },
  ): Promise<{ turns: unknown[] }> {
    const q = new URLSearchParams();
    if (params.last_n_turns !== undefined) q.set("last_n_turns", String(params.last_n_turns));
    if (params.redact !== undefined) q.set("redact", String(params.redact));
    return call("GET", `/instances/${claudeId}/history?${q.toString()}`);
  },
  search(
    claudeId: string,
    query: string,
    params: { context?: number } = {},
  ): Promise<{ matches: unknown[] }> {
    const q = new URLSearchParams({ q: query });
    if (params.context !== undefined) q.set("context", String(params.context));
    return call("GET", `/instances/${claudeId}/search?${q.toString()}`);
  },
  getTurn(claudeId: string, index: number): Promise<{ turn: unknown }> {
    return call("GET", `/instances/${claudeId}/turn/${index}`);
  },
  setIdle(claudeId: string, idle: boolean): Promise<unknown> {
    return call("PATCH", `/instances/${claudeId}`, { idle });
  },
  events(
    claudeId: string,
    timeoutMs: number,
  ): Promise<{ type: "message"; pending: number } | null> {
    return call("GET", `/instances/${claudeId}/events?timeout=${timeoutMs}`, undefined, {
      timeoutMs: timeoutMs + 5_000,
    }) as Promise<{ type: "message"; pending: number } | null>;
  },
};

export { DaemonError };
