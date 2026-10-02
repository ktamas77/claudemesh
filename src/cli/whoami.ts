import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import { selfSession } from "../shared/ancestor.js";

export async function runWhoami(): Promise<void> {
  await ensureDaemonRunning();
  const rec = await selfSession();
  if (!rec) {
    console.error(
      `no Claude session found among this process's ancestors (from pid ${process.ppid}). Are you inside a Claude Code shell?`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(rec, null, 2));
}
