export interface InstanceRecord {
  claude_id: string;
  session_id: string;
  claude_pid: number;
  cwd: string;
  transcript_path: string;
  started_at: string;
  last_active: string;
  pending_count: number;
  idle: boolean;
}

export type MessageKind = "task" | "note";

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  kind: MessageKind;
  body: string;
  ts: string;
}

export type Transport = "unix" | "tcp";

export interface DaemonConfig {
  /** "unix" (default on macOS/Linux): per-user socket file. "tcp": host:port (default on Windows). */
  transport: Transport;
  /** Socket file path for transport "unix". Defaults to ~/.claudemesh/daemon.sock. */
  socket_path?: string;
  /** TCP bind/connect address. Non-loopback hosts require `token`. */
  host: string;
  port: number;
  /** Shared secret sent as `Authorization: Bearer <token>`. Required for non-loopback TCP. */
  token?: string;
  /**
   * How the supervisor wakes an idle claude:
   *  "body"     (default) paste the message text itself via bracketed paste, attributed to the sender
   *  "sentinel" type `[inbox]`; the UserPromptSubmit hook then attaches the messages as context
   */
  inject_mode: "body" | "sentinel";
  /** Desktop notification when a task lands in an idle session with no supervisor attached. */
  notify: boolean;
  redact: {
    enabled: boolean;
    line_byte_cap: number;
  };
  statusline: {
    show_peers: boolean;
    show_inbox: boolean;
  };
}

export const DEFAULT_CONFIG: DaemonConfig = {
  transport: process.platform === "win32" ? "tcp" : "unix",
  port: 7878,
  host: "127.0.0.1",
  inject_mode: "body",
  notify: true,
  redact: {
    enabled: true,
    line_byte_cap: 4096,
  },
  statusline: {
    show_peers: true,
    show_inbox: true,
  },
};
