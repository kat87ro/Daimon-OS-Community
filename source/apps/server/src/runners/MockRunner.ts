import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import type { AgentDefinition, SpawnRequest } from "@daimon-os/shared";
import { agentRuntimeEnvironment } from "./environment";
import type { RunnerBackend, RunnerHandle } from "./types";

const AGENT_SCRIPT = fileURLToPath(new URL("./mock-agent.cjs", import.meta.url));

/**
 * Clotho-mock — spawns a sandboxed local Node script under a real PTY.
 * The script emits realistic ANSI agent-loop output plus in-band OSC 6973
 * telemetry, and echoes stdin so interactivity is testable end to end.
 */
export class MockRunner implements RunnerBackend {
  async spawn(
    def: AgentDefinition,
    req: SpawnRequest,
  ): Promise<{ pty: pty.IPty; handle: RunnerHandle }> {
    const childEnv: Record<string, string | undefined> = {
      ...agentRuntimeEnvironment(),
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      ...def.env,
      ...req.overrides?.env,
      DAIMON_AGENT_NAME: def.name,
      DAIMON_TASK: req.taskPrompt ?? "idle loop",
      DAIMON_TOOLS: def.tools.filter((t) => t.enabled).map((t) => t.name).join(","),
      DAIMON_MODEL: req.overrides?.model ?? def.model ?? "default",
    };
    const proc = pty.spawn(process.execPath, [AGENT_SCRIPT], {
      name: "xterm-256color",
      cols: req.cols,
      rows: req.rows,
      cwd: process.cwd(),
      env: childEnv as Record<string, string>,
    });
    return {
      pty: proc,
      handle: { kind: "mock", cleanup: async () => {} },
    };
  }
}
