import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import * as pty from "node-pty";
import type { AgentDefinition, SpawnRequest } from "@daimon-os/shared";
import type { ConfigStore } from "../config/ConfigStore";
import { dockerClientEnvironment } from "./environment";
import type { RunnerBackend, RunnerHandle } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Docker isolation: the agent loop runs inside a container, attached to a
 * PTY via `docker run -i`. Cleanup force-removes the container so a closed
 * pane can never leak a runtime.
 */
export class DockerRunner implements RunnerBackend {
  constructor(private readonly store: ConfigStore) {}

  async spawn(
    def: AgentDefinition,
    req: SpawnRequest,
  ): Promise<{ pty: pty.IPty; handle: RunnerHandle }> {
    if (!def.dockerImage) {
      throw new Error(`agent "${def.name}" has docker isolation but no dockerImage`);
    }
    const containerName = `daimon-${req.channel.slice(0, 8)}`;
    const containerEnv: Record<string, string | undefined> = {
      ...this.store.secretsForAgent(req.projectId, def),
      ...def.env,
      DAIMON_AGENT_NAME: def.name,
      DAIMON_TASK: req.taskPrompt ?? "",
    };
    delete containerEnv.DAIMON_AUTH_TOKEN;
    delete containerEnv.DAIMON_RENDERER_TOKEN;
    const definedContainerEnv = Object.fromEntries(
      Object.entries(containerEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    // `-e KEY` copies from the Docker client's environment without putting raw
    // values in process-list/diagnostic argv.
    const envArgs = Object.keys(definedContainerEnv).flatMap((key) => ["-e", key]);
    // The Docker client never inherits unrelated gateway/CI/cloud credentials.
    const dockerHostEnv = { ...dockerClientEnvironment(), ...definedContainerEnv };
    const workspace = req.cwd ? fs.realpathSync.native(req.cwd) : undefined;
    const workspaceArgs = workspace
      ? ["--mount", `type=bind,src=${workspace},dst=/workspace`, "--workdir", "/workspace"]
      : [];
    const userArgs = typeof process.getuid === "function" && typeof process.getgid === "function"
      ? ["--user", `${process.getuid()}:${process.getgid()}`]
      : [];

    const proc = pty.spawn(
      "docker",
      [
        "run", "--rm", "-i", "--name", containerName,
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--pids-limit", "256",
        "--memory", "2g",
        "--cpus", "2",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        ...userArgs,
        ...workspaceArgs,
        ...envArgs,
        def.dockerImage,
      ],
      {
        name: "xterm-256color",
        cols: req.cols,
        rows: req.rows,
        cwd: process.cwd(),
        env: dockerHostEnv as Record<string, string>,
      },
    );
    return {
      pty: proc,
      handle: {
        kind: "docker",
        containerId: containerName,
        cleanup: async () => {
          try {
            await execFileAsync("docker", ["rm", "-f", containerName]);
          } catch {
            // already gone — --rm usually beats us to it
          }
        },
      },
    };
  }
}
