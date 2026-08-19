import fs from "node:fs";
import os from "node:os";
import * as pty from "node-pty";
import type { SpawnRequest } from "@daimon-os/shared";
import type { RunnerHandle } from "./types";
import { agentRuntimeEnvironment } from "./environment";

/**
 * A brand-new interactive login shell, not linked to any agent. This is the
 * pane the user drives by hand: cd into a project, launch `claude` or `codex`,
 * answer their prompts — it is a full local terminal over the multiplexed pipe.
 */
export class ShellRunner {
  /** extraEnv = vault secrets the project opted into (ProcessManager passes them),
   *  so a hand-driven shell in a project can run scripts that read those tokens. */
  spawnShell(
    req: SpawnRequest,
    extraEnv: Record<string, string> = {},
  ): { pty: pty.IPty; handle: RunnerHandle } {
    const shell = process.env.SHELL || "/bin/zsh";
    const cwd = resolveCwd(req.cwd);
    const childEnv: Record<string, string | undefined> = {
      ...agentRuntimeEnvironment(),
      ...extraEnv,
      TERM: "xterm-256color",
      DAIMON_CHANNEL: req.channel,
    };
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: req.cols,
      rows: req.rows,
      cwd,
      env: childEnv as Record<string, string>,
    });
    if (req.command) {
      const command = req.command;
      setTimeout(() => {
        try {
          proc.write(`${command}\r`);
        } catch {
          // shell died before the command landed — surfaced via onExit anyway
        }
      }, 350);
    }
    return { pty: proc, handle: { kind: "shell", cleanup: async () => {} } };
  }
}

function resolveCwd(cwd?: string): string {
  if (!cwd) return os.homedir();
  if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  throw new Error(`working directory does not exist: ${cwd}`);
}
