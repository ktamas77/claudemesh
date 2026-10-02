import { readHookInput, logHookError } from "./util.js";
import { ensureDaemonRunning } from "../shared/daemon-spawn.js";
import { daemon } from "../shared/client.js";

export async function runSessionStartHook(): Promise<void> {
  try {
    const input = await readHookInput();
    if (!input.session_id || !input.transcript_path) return;
    await ensureDaemonRunning();
    await daemon.register(
      {
        session_id: input.session_id,
        // process.ppid is claude's pid only because the hook command is a single simple
        // command, which bash -c execs in place without forking. Adding an env prefix,
        // `&&`, or a pipe to the hook command in install.ts would make ppid the shell's pid
        // and the liveness sweep would unregister us within 10s. Keep the command simple.
        claude_pid: process.ppid,
        cwd: input.cwd ?? process.cwd(),
        transcript_path: input.transcript_path,
      },
      { retry: true },
    );
  } catch (err) {
    logHookError("SessionStart", err);
  }
}
