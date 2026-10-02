import { daemon } from "../shared/client.js";
import { readDaemonPid } from "../shared/daemon-spawn.js";
import { isAlive } from "../daemon/liveness.js";
import { paths } from "../shared/paths.js";
import { loadConfig, socketPath } from "../shared/config.js";
import { packageVersion } from "../shared/version.js";

export async function runStatus(): Promise<void> {
  const pid = readDaemonPid();
  const pidAlive = pid !== null && isAlive(pid);
  const cfg = loadConfig();
  let healthy = false;
  let instances = 0;
  let daemonVersion: string | null = null;
  try {
    const h = await daemon.health({ timeoutMs: 250 });
    healthy = h.ok === true;
    instances = h.instances;
    daemonVersion = h.version ?? null;
  } catch {
    // daemon down or unreachable — report it in the JSON below rather than crashing
  }
  console.log(
    JSON.stringify(
      {
        daemon_pid: pid,
        daemon_pid_alive: pidAlive,
        daemon_healthy: healthy,
        daemon_version: daemonVersion,
        cli_version: packageVersion(),
        transport: cfg.transport,
        address: cfg.transport === "unix" ? socketPath(cfg) : `${cfg.host}:${cfg.port}`,
        instances,
        root: paths.root,
      },
      null,
      2,
    ),
  );
}
