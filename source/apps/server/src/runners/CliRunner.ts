import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pty from "node-pty";
import type { AgentDefinition, ProviderConfig, SpawnRequest } from "@daimon-os/shared";
import { sanitizeSlug, type ConfigStore } from "../config/ConfigStore";
import {
  createTrustedMcpRuntime,
  removeTrustedMcpConfig,
  type TrustedMcpSpawnRequest,
} from "../config/trustedMcpConfig";
import {
  managedPathExists,
  removeManagedPath,
  writeManagedFileAtomic,
} from "../security/runtimeFiles";
import { agentRuntimeEnvironment } from "./environment";
import type { RunnerBackend, RunnerHandle } from "./types";

/** default binary per kind when the provider doesn't override cliCommand */
export const KIND_CMD: Partial<Record<ProviderConfig["kind"], string>> = {
  claude: "claude",
  gemini: "gemini",
  codex: "codex",
  // Ollama/LM Studio are inference engines, not coding-agent CLIs. Codex's
  // supported OSS adapters provide the tool-capable agent loop for both.
  ollama: "codex",
  lmstudio: "codex",
};
const LAUNCH_CLI_KINDS = new Set<ProviderConfig["kind"]>([
  "claude", "gemini", "codex", "ollama", "lmstudio",
]);
const LOCAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/;

export function providerRuntimeAdapterKind(
  kind: ProviderConfig["kind"],
): "claude" | "codex" | "gemini" | undefined {
  if (kind === "ollama" || kind === "lmstudio") return "codex";
  if (kind === "claude" || kind === "codex" || kind === "gemini") return kind;
  return undefined;
}

export interface TrustedMcpCapability {
  readonly supported: boolean;
  readonly reason?: string;
}

/**
 * Lead support is a security capability, not a synonym for "we can launch the
 * binary". A supported adapter must be able to select one private, app-owned
 * MCP config without loading repository MCP definitions or putting the scoped
 * bearer on the process command line.
 */
export function trustedMcpCapability(kind: ProviderConfig["kind"]): TrustedMcpCapability {
  switch (kind) {
    case "claude":
      return { supported: true };
    case "codex":
      return { supported: true };
    case "gemini":
      return { supported: true };
    case "ollama":
    case "lmstudio":
      return { supported: true };
    default:
      return {
        supported: false,
        reason: `provider kind "${kind}" has no trusted Daimon MCP adapter`,
      };
  }
}

/**
 * The real Phase-2 runtime: an agent is a conformance-tested CLI running in a
 * PTY — Claude Code, Codex, Gemini, or Codex OSS backed by Ollama/LM Studio. Daimon
 * injects the agent's identity (role + system prompt + skill index) the way
 * each CLI supports, and mounts attached skills into the project's
 * .claude/skills so the CLI discovers them natively.
 */
export class CliRunner implements RunnerBackend {
  constructor(
    private readonly store: ConfigStore,
    private readonly trustedMcpRoot: string,
  ) {}

  async spawn(
    def: AgentDefinition,
    req: SpawnRequest,
  ): Promise<{ pty: pty.IPty; handle: RunnerHandle }> {
    const provider = this.store.getProvider(
      req.overrides?.providerId ?? def.providerId,
    );
    if (!provider) throw new Error(`agent "${def.name}" has no provider configured`);
    if (provider.mode !== "cli") {
      throw new Error(
        `provider "${provider.name}" is api-mode — switch it to cli mode or set the agent runtime to mock`,
      );
    }
    if (!LAUNCH_CLI_KINDS.has(provider.kind)) {
      throw new Error(
        `provider kind "${provider.kind}" is not supported by the launch CLI adapter contract`,
      );
    }
    const configuredCommand = provider.cliCommand || KIND_CMD[provider.kind];
    if (!configuredCommand) {
      throw new Error(`provider kind "${provider.kind}" needs an explicit CLI command`);
    }
    const command = resolveProviderExecutable(provider.kind, configuredCommand);

    const cwd = resolveCwd(req.cwd);
    const permissionMode = def.permissionMode ?? "supervised";
    if (permissionMode !== "supervised") {
      throw new Error(
        "host CLI agents support only explicit foreground supervised mode; use Docker isolation for sandboxed or unattended work",
      );
    }
    // NOTE: auto-acceptance of Claude's startup dialogs is intentionally DISABLED
    // (per operator preference) — the trust / "Bypass Permissions?" / "New MCP
    // server?" prompts now appear in the agent's live terminal pane for the user
    // to accept manually. Daimon never writes trust decisions into the provider's
    // global configuration on the user's behalf.
    // The CLAUDE.md persona stays suppressed via CLAUDE_CODE_DISABLE_CLAUDE_MDS
    // (below): accepting the "allow external CLAUDE.md imports?" prompt would load
    // ~/.claude/SOUL.md and re-introduce the enterprise-persona goal-bug.
    const model = req.overrides?.model ?? def.model ?? provider.defaultModel;
    if (
      (provider.kind === "ollama" || provider.kind === "lmstudio") &&
      (!model || !LOCAL_MODEL_ID.test(model) || model.toLowerCase().endsWith(":cloud"))
    ) {
      throw new Error("local providers require a valid on-device model id; cloud aliases are blocked");
    }
    const trustedMcpServers = (req as TrustedMcpSpawnRequest).trustedMcpServers ?? [];
    if (trustedMcpServers.length > 0) {
      const capability = trustedMcpCapability(provider.kind);
      if (!capability.supported) throw new Error(capability.reason);
    }
    const mounted = this.mountSkills(def, cwd);
    const system = buildSystemContext(def, this.skillNames(def));
    // This file is app-owned and contains ONLY definitions selected in Daimon.
    // Never pass a repository-authored mixed config through Claude's trusted flag.
    let mcpRuntime: ReturnType<typeof createTrustedMcpRuntime>;
    try {
      const runtimeAdapterKind = providerRuntimeAdapterKind(provider.kind);
      if (!runtimeAdapterKind) throw new Error(`provider kind "${provider.kind}" has no runtime adapter`);
      mcpRuntime = createTrustedMcpRuntime(
        this.trustedMcpRoot,
        req.channel,
        trustedMcpServers,
        runtimeAdapterKind,
        {
          cwd,
          // A local-model run needs no OpenAI login. Do not link auth.json into
          // its private CODEX_HOME even when the operator also uses paid Codex.
          linkProviderCredentials: provider.kind !== "ollama" && provider.kind !== "lmstudio",
        },
      );
    } catch (error) {
      for (const relative of mounted) removeManagedPath(cwd, relative);
      throw error;
    }
    const argv = buildProviderArgv(provider.kind, {
      model,
      system,
      taskPrompt: req.taskPrompt,
      mcpConfig: mcpRuntime?.configPath,
      trustedMcpServerNames: mcpRuntime?.serverNames,
      oneShot: req.oneShot,
      sessionId: req.channel, // claude --session-id → transcript named by our channel
      permissionMode,
    });
    const stdinPrompt = req.oneShot && req.taskPrompt
      ? provider.kind === "claude"
        ? req.taskPrompt
        : combine(system, req.taskPrompt)
      : undefined;

    const childEnv: Record<string, string | undefined> = {
      ...agentRuntimeEnvironment(),
      ...(provider.kind === "claude" ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } : {}),
      ...(provider.kind === "ollama" || provider.kind === "lmstudio"
        ? { OTEL_SDK_DISABLED: "true" }
        : {}),
      ...this.store.secretsForAgent(req.projectId, def),
      ...def.env,
      ...mcpRuntime?.env,
      TERM: "xterm-256color",
      DAIMON_CHANNEL: req.channel,
      DAIMON_AGENT_NAME: def.name,
      DAIMON_AGENT_ROLE: def.description ?? "",
    };
    let proc: pty.IPty;
    try {
      proc = pty.spawn(command, argv, {
        name: "xterm-256color",
        cols: req.cols,
        rows: req.rows,
        cwd,
        env: {
          ...childEnv,
        // Stop the spawned claude from loading ANY CLAUDE.md (user ~/.claude/CLAUDE.md
        // → @SOUL.md persona, or a project CLAUDE.md). The persona was overriding the
        // project goal (Lead emitted generic "enterprise architect" tasks); agents get
        // their identity via --append-system-prompt and the task as the positional
        // prompt, so they need no CLAUDE.md. This also suppresses the "allow external
        // CLAUDE.md imports?" dialog. Set right after process.env so it wins; secret/
        // def.env/override spreads below can still override.
        // vault secrets this project opted into, decrypted at spawn time and
        // injected as env vars. MCP stdio servers the CLI launches inherit this
        // env, so an Instagram/Facebook token reaches the automation WITHOUT ever
        // being written to a config file on disk. Placed before def.env/overrides
        // so an agent's explicit env can still override a secret if it must.
        } as Record<string, string>,
      });
      if (stdinPrompt) {
        // One-shot instructions can carry run-scoped capabilities. Keep them
        // out of the process command line, which is visible to other same-user
        // processes, and close stdin after a single bounded write.
        proc.write(`${stdinPrompt}\n\x04`);
      }
    } catch (error) {
      removeTrustedMcpConfig(this.trustedMcpRoot, req.channel);
      for (const relative of mounted) removeManagedPath(cwd, relative);
      throw error;
    }

    // Compact command string for crash diagnostics — omit the long --append-system-prompt
    // and task-prompt values since they're already stored in the agent definition.
    const diagArgv = argv.filter((a, i) => {
      if (a === system) return false; // system prompt value (after --append-system-prompt)
      if (req.taskPrompt && a === req.taskPrompt) return false; // positional task prompt
      return true;
    });
    const cmd = `${command} ${diagArgv.join(" ")}`.trim();

    return {
      pty: proc,
      handle: {
        kind: "cli",
        cmd,
        cleanup: async () => {
          // remove only the skill copies WE created — never user files
          for (const relative of mounted) removeManagedPath(cwd, relative);
          removeTrustedMcpConfig(this.trustedMcpRoot, req.channel);
        },
      },
    };
  }

  /** copy attached skills into <cwd>/.claude/skills/<slug>; skip existing */
  private mountSkills(def: AgentDefinition, cwd: string): string[] {
    const created: string[] = [];
    for (const skillId of def.skillIds ?? []) {
      const skill = this.store.getSkill(skillId);
      if (!skill?.content) continue;
      const relative = `.claude/skills/${sanitizeSlug(skill.slug)}`;
      if (managedPathExists(cwd, relative)) continue; // project already has it — leave it
      writeManagedFileAtomic(cwd, `${relative}/SKILL.md`, skill.content);
      created.push(relative);
    }
    return created;
  }

  private skillNames(def: AgentDefinition): string[] {
    return (def.skillIds ?? [])
      .map((id) => this.store.getSkill(id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
      .map((s) => `${s.name}${s.description ? ` — ${s.description}` : ""}`);
  }
}

function buildSystemContext(def: AgentDefinition, skillNames: string[]): string {
  const parts = [
    `You are ${def.name}${def.description ? `, ${def.description}` : ""}.`,
    def.systemPrompt,
  ];
  if (skillNames.length > 0) {
    parts.push(`Skills available in .claude/skills: ${skillNames.join("; ")}.`);
  }
  const selectedTools = def.tools.filter((tool) => tool.enabled).map((tool) => tool.name);
  if (selectedTools.length > 0) {
    parts.push(
      `Daimon capability profile: ${selectedTools.join(", ")}. Prefer these capabilities when available. ` +
      "This profile never overrides provider approval prompts, sandbox rules, or MCP attachment policy.",
    );
  }
  return parts.filter(Boolean).join("\n\n");
}

export function buildProviderArgv(
  kind: ProviderConfig["kind"],
  opts: {
    model?: string;
    system: string;
    taskPrompt?: string;
    mcpConfig?: string;
    trustedMcpServerNames?: readonly string[];
    oneShot?: boolean;
    sessionId?: string;
    permissionMode: NonNullable<AgentDefinition["permissionMode"]>;
  },
): string[] {
  const {
    model, system, taskPrompt, mcpConfig, trustedMcpServerNames,
    oneShot, sessionId, permissionMode,
  } = opts;
  if (permissionMode !== "supervised") {
    throw new Error(
      "host CLI agents support only explicit foreground supervised mode; use Docker isolation for sandboxed or unattended work",
    );
  }
  switch (kind) {
    case "claude":
      // claude supports a real system-prompt flag; task rides as the
      // positional initial prompt.
      // oneShot (-p/--print): a worker runs the task headless and EXITS, so the
      //   scheduler sees completion and unblocks dependents. The Lead omits this
      //   (interactive) because it must keep polling + delegating.
      // --strict-mcp-config prevents discovery/merge of repository/user MCP
      // definitions. --setting-sources user excludes project/local settings and
      // their hooks while retaining the operator's subscription authentication.
      return [
        ...(oneShot ? ["--print", "--output-format", "text"] : []),
        ...(model ? ["--model", model] : []),
        // pin the session id to our channel so the JSONL transcript is named by it
        // (deterministic match for the CostTracker) — must be a valid UUID, which
        // our channel always is
        ...(sessionId ? ["--session-id", sessionId] : []),
        ...(mcpConfig
          ? ["--setting-sources", "user", "--strict-mcp-config", "--mcp-config", mcpConfig]
          : []),
        "--append-system-prompt",
        system,
        ...(taskPrompt && !oneShot ? [taskPrompt] : []),
      ];
    case "codex":
      // `codex exec` is the non-interactive one-shot mode; bare `codex` is the TUI
      return [
        ...(oneShot ? ["exec"] : []),
        ...(mcpConfig ? ["--strict-config"] : []),
        ...(model ? ["-m", model] : []),
        ...(combine(system, taskPrompt) ? [oneShot ? "-" : combine(system, taskPrompt)] : []),
      ];
    case "ollama":
    case "lmstudio":
      // Codex owns the coding-agent loop; the selected loopback engine owns
      // inference. `--oss` guarantees this run does not use the operator's
      // OpenAI subscription, while the private CODEX_HOME prevents repo/user
      // MCP configuration and credentials from leaking into the local run.
      return [
        ...(oneShot ? ["exec"] : []),
        ...(mcpConfig ? ["--strict-config"] : []),
        "--oss",
        "--local-provider",
        kind === "ollama" ? "ollama" : "lmstudio",
        // Local inference must not quietly activate remote plugin catalogs,
        // hosted app tools, external browser services, or remote compaction.
        "--disable", "plugins",
        "--disable", "remote_plugin",
        "--disable", "apps",
        "--disable", "browser_use_external",
        "--disable", "remote_compaction_v2",
        ...(model ? ["-m", model] : []),
        ...(combine(system, taskPrompt) ? [oneShot ? "-" : combine(system, taskPrompt)] : []),
      ];
    case "gemini":
      // -p runs a single prompt non-interactively and exits; -i stays interactive
      return [
        ...(model ? ["-m", model] : []),
        ...(sessionId ? ["--session-id", sessionId] : []),
        ...(trustedMcpServerNames?.length
          ? ["--allowed-mcp-server-names", trustedMcpServerNames.join(",")]
          : []),
        ...(combine(system, taskPrompt)
          ? [oneShot ? "-p" : "-i", oneShot ? "" : combine(system, taskPrompt)]
          : []),
      ];
    default:
      return taskPrompt ? [taskPrompt] : [];
  }
}

/** Resolve only the conformance-tested executable name through trusted process
 * PATH entries, then launch its canonical absolute path. Relative/empty PATH
 * components and lookalike command names are rejected. */
export function resolveProviderExecutable(
  kind: ProviderConfig["kind"],
  configured?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const expected = KIND_CMD[kind];
  if (!expected) throw new Error(`provider kind "${kind}" has no supported CLI executable`);
  const requested = configured?.trim() || expected;
  if (path.isAbsolute(requested)) {
    const canonical = canonicalExecutable(requested);
    const approved = findApprovedOnPath(expected, environment);
    if (approved && canonical === approved) return canonical;
    throw new Error(`provider executable is not the canonical '${expected}' resolved from trusted PATH`);
  }
  if (requested !== expected || requested.includes(path.sep)) {
    throw new Error(`provider executable must be the approved '${expected}' command`);
  }
  const approved = findApprovedOnPath(expected, environment);
  if (approved) return approved;
  throw new Error(`approved provider executable '${expected}' was not found on an absolute PATH entry`);
}

function findApprovedOnPath(expected: string, environment: NodeJS.ProcessEnv): string | undefined {
  for (const entry of (environment.PATH ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    try {
      return canonicalExecutable(path.join(entry, expected));
    } catch {
      // Continue to the next trusted absolute PATH entry.
    }
  }
  return undefined;
}

function canonicalExecutable(candidate: string): string {
  const canonical = fs.realpathSync.native(candidate);
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error("provider executable is not a regular file");
  fs.accessSync(canonical, fs.constants.X_OK);
  return canonical;
}

function combine(system: string, taskPrompt?: string): string {
  if (!taskPrompt) return "";
  return `${system}\n\nTask: ${taskPrompt}`;
}

function resolveCwd(cwd?: string): string {
  if (!cwd) return os.homedir();
  if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
  throw new Error(`working directory does not exist: ${cwd}`);
}
