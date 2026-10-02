import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { paths, ensureDirs } from "./paths.js";
import { DEFAULT_CONFIG, type DaemonConfig } from "./types.js";

export function loadConfig(): DaemonConfig {
  if (!existsSync(paths.config)) {
    return DEFAULT_CONFIG;
  }
  try {
    const raw = readFileSync(paths.config, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
    return mergeConfig(DEFAULT_CONFIG, parsed);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeDefaultConfigIfMissing(): void {
  ensureDirs();
  if (existsSync(paths.config)) return;
  writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
}

export function mergeConfig(base: DaemonConfig, overlay: Partial<DaemonConfig>): DaemonConfig {
  const out: DaemonConfig = {
    transport:
      overlay.transport === "tcp" || overlay.transport === "unix"
        ? overlay.transport
        : base.transport,
    port: overlay.port ?? base.port,
    host: overlay.host ?? base.host,
    inject_mode: overlay.inject_mode === "sentinel" ? "sentinel" : base.inject_mode,
    notify: typeof overlay.notify === "boolean" ? overlay.notify : base.notify,
    redact: { ...base.redact, ...(overlay.redact ?? {}) },
    statusline: { ...base.statusline, ...(overlay.statusline ?? {}) },
  };
  if (overlay.socket_path) out.socket_path = overlay.socket_path;
  if (overlay.token) out.token = overlay.token;
  return out;
}

export function socketPath(cfg: DaemonConfig): string {
  return cfg.socket_path ?? paths.socket;
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/** True when the daemon this config points at lives on this machine (so we may spawn/kill it). */
export function isLocalDaemon(cfg: DaemonConfig): boolean {
  return cfg.transport === "unix" || isLoopback(cfg.host);
}

/** Returns an error message if the config is unsafe to serve, else null. */
export function validateServeConfig(cfg: DaemonConfig): string | null {
  if (cfg.transport === "tcp" && !isLoopback(cfg.host) && !cfg.token) {
    return `refusing to bind tcp ${cfg.host}:${cfg.port} without a "token" in config.json — anyone on the network could inject prompts and read transcripts`;
  }
  return null;
}
