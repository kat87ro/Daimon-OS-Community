import type { IPty } from "node-pty";
import type { AgentDefinition, IsolationMode, SpawnRequest } from "@daimon-os/shared";

export interface RunnerHandle {
  kind: IsolationMode | "shell";
  containerId?: string;
  /** Human-readable command line (binary + key flags) — logged on crash for diagnostics. */
  cmd?: string;
  cleanup(): Promise<void>;
}

export interface RunnerBackend {
  spawn(
    def: AgentDefinition,
    req: SpawnRequest,
  ): Promise<{ pty: IPty; handle: RunnerHandle }>;
}
