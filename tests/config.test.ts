import { describe, expect, it } from "vitest";
import {
  mergeConfig,
  isLoopback,
  isLocalDaemon,
  validateServeConfig,
} from "../src/shared/config.js";
import { DEFAULT_CONFIG } from "../src/shared/types.js";
import { decideDaemonAction } from "../src/shared/daemon-spawn.js";

describe("config transport", () => {
  it("defaults to unix on non-windows", () => {
    if (process.platform !== "win32") expect(DEFAULT_CONFIG.transport).toBe("unix");
  });
  it("ignores unknown transport values", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { transport: "carrier-pigeon" as never });
    expect(cfg.transport).toBe(DEFAULT_CONFIG.transport);
  });
  it("accepts tcp + custom port + token", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { transport: "tcp", port: 9999, token: "s3cret" });
    expect(cfg).toMatchObject({ transport: "tcp", port: 9999, token: "s3cret" });
  });
  it("isLoopback", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      expect(isLoopback(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.5", "::", "example.com"]) {
      expect(isLoopback(h)).toBe(false);
    }
  });
  it("refuses to serve non-loopback tcp without a token", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { transport: "tcp", host: "0.0.0.0" });
    expect(validateServeConfig(cfg)).toMatch(/token/);
    expect(validateServeConfig({ ...cfg, token: "x" })).toBeNull();
    expect(validateServeConfig(mergeConfig(DEFAULT_CONFIG, { transport: "tcp" }))).toBeNull();
    expect(validateServeConfig(DEFAULT_CONFIG)).toBeNull();
  });
  it("isLocalDaemon", () => {
    expect(isLocalDaemon(DEFAULT_CONFIG)).toBe(true);
    expect(isLocalDaemon({ ...DEFAULT_CONFIG, transport: "tcp" })).toBe(true);
    expect(isLocalDaemon({ ...DEFAULT_CONFIG, transport: "tcp", host: "10.0.0.2" })).toBe(false);
  });
});

describe("decideDaemonAction", () => {
  it("healthy + same version → ok", () => {
    expect(decideDaemonAction({ version: "1.2.3" }, true, true, "1.2.3")).toBe("ok");
  });
  it("healthy + stale version → kill-and-spawn (regression: old daemon survived npm upgrade)", () => {
    expect(decideDaemonAction({ version: "1.0.0" }, true, true, "1.2.3")).toBe("kill-and-spawn");
    expect(decideDaemonAction({}, true, true, "1.2.3")).toBe("kill-and-spawn");
  });
  it("no answer + pidfile alive → kill-and-spawn (daemon on an old transport/port)", () => {
    expect(decideDaemonAction(null, true, true, "1.2.3")).toBe("kill-and-spawn");
  });
  it("no answer + nothing alive → spawn", () => {
    expect(decideDaemonAction(null, false, true, "1.2.3")).toBe("spawn");
  });
  it("remote daemon is never spawned or killed", () => {
    expect(decideDaemonAction(null, true, false, "1.2.3")).toBe("unreachable");
    expect(decideDaemonAction({ version: "0.9.0" }, true, false, "1.2.3")).toBe("ok");
  });
});
