import type { IPty } from "node-pty";
import type { WebSocket } from "ws";
import {
  MAX_RETAINED_PROCS,
  PROTOCOL_VERSION,
  RING_RETENTION_MS,
  TERMINAL_STATUSES,
  WS_HIGH_WATER_BYTES,
  WS_LOW_WATER_BYTES,
  emptyMetrics,
  makeFrame,
  newSessionId,
} from "@daimon-os/shared";
import type {
  AgentDefinition,
  ChannelSnapshot,
  ExitReason,
  RunMetrics,
  ServerFrame,
  SpawnRequest,
  TelemetryEvent,
  TerminalSession,
} from "@daimon-os/shared";
import os from "node:os";
import fs from "node:fs";
import { basename, join } from "node:path";
import type { ConfigStore } from "../config/ConfigStore";
import type { TrustedMcpSpawnRequest } from "../config/trustedMcpConfig";
import { OscTelemetryParser } from "../gateway/oscTelemetry";
import { ShellRunner } from "../runners/ShellRunner";
import { resolveProjectCwd } from "../security/projectPaths";
import type { RunnerBackend, RunnerHandle } from "../runners/types";
import { trustedMcpCapability } from "../runners/CliRunner";
import { OutputBatcher } from "./OutputBatcher";
import { ReplayRingBuffer } from "./ReplayRingBuffer";
import { claudeTranscriptPath } from "./transcript";

interface ManagedProcess {
  session: TerminalSession;
  pty: IPty;
  handle: RunnerHandle;
  ring: ReplayRingBuffer;
  seq: number;
  subscribers: Set<WebSocket>;
  batcher: OutputBatcher;
  telemetry: OscTelemetryParser;
  paused: boolean;
  exited: boolean;
  killReason?: ExitReason;
  timeoutHandle?: NodeJS.Timeout;
  retentionHandle?: NodeJS.Timeout;
  lastMetricsSentAt: number;
  /** epoch ms of the most recent PTY output — drives the idle watchdog */
  lastOutputAt: number;
  /** Throttles durable liveness observations independently from terminal frame
   *  batching. Output itself remains in the replay buffer. */
  lastLifecycleOutputAt: number;
  /** Claude transcript path for cost tracking (set only for claude agents) */
  transcriptPath?: string;
  /** suspended (SIGSTOP) because it hit a budget cap — resumable */
  budgetPaused?: boolean;
  /** rolling tail of the agent's (ANSI-stripped) output — its deliverable, kept
   *  so we can log "what it sent" when the pane auto-closes on completion */
  outputTail: string;
  /** compact command line from the runner (binary + key flags, no long prompt values) */
  cmd?: string;
  /** One shared teardown promise prevents close() and PTY onExit from cleaning
   *  or notifying scheduler hooks twice. */
  terminalization?: Promise<void>;
  /** Authority that created the channel. Renderer clients may never enumerate
   *  or operate admin-owned channels. */
  authority: ChannelAuthority;
}

export type ChannelAuthority = "admin" | "renderer" | "system";
export type ChannelOperation = "read" | "control";
export interface ProcessLifecycleEvent {
  kind: "spawn" | "output" | "status" | "heartbeat" | "exit";
  channel: string;
  session: TerminalSession;
  confidence: "reported" | "observed";
  outputObserved?: boolean;
}

const OUTPUT_TAIL_MAX = 16_000;
export const DEFAULT_MAX_RESIDENT_PROCESSES = 64;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]/g;

export class SpawnError extends Error {
  constructor(
    readonly code: "SPAWN_FAILED" | "LIMIT_EXCEEDED" | "UNKNOWN_CHANNEL",
    message: string,
  ) {
    super(message);
  }
}

/**
 * The central registry: one ManagedProcess per agent run, keyed by channel id.
 * Owns the full lifecycle — spawn (Clotho), stream, kill (Atropos), cleanup —
 * and guarantees a closed pane never leaks a PTY, container, or timer.
 */
export class ProcessManager {
  private readonly procs = new Map<string, ManagedProcess>();
  private readonly resumeTicker: NodeJS.Timeout;
  private readonly heartbeatTicker: NodeJS.Timeout;
  /** Synchronous reservations cover the await between runner admission and
   *  process registration. JavaScript's run-to-completion semantics make this
   *  an atomic counter for concurrent spawn()/runHeadless() calls. */
  private admissionReservations = 0;
  private readonly reservedChannels = new Set<string>();
  private appLog?: {
    emit(
      level: "info" | "warn" | "error",
      source: string,
      message: string,
      channel?: string,
      detail?: string,
    ): void;
  };
  /** notified when a process exits — the task scheduler hooks here (2v2-B) */
  private readonly exitHooks = new Set<(channel: string, reason: string) => void>();
  private readonly lifecycleHooks = new Set<(event: ProcessLifecycleEvent) => void>();
  private managedCwdAuthorizer?: (projectRoot: string, requestedCwd: string) => boolean;
  /**
   * A native/admin-confirmed project start grants the resident Lead and its
   * selected team permission to use host CLI providers for this process
   * lifetime. The grant is deliberately narrower than a global "automation
   * enabled" switch: it is bound to one project and the exact current roster,
   * and is revoked when the Lead exits or the team changes.
   */
  private readonly hostAutomationGrants = new Map<string, ReadonlySet<string>>();

  /** Claude config dir the spawned CLI writes transcripts under — they live at
   *  <claudeConfigBase>/projects/..., so the cost tracker must read the same dir
   *  or every worker shows $0. Defaults to ~/.claude (where claude writes them);
   *  overridable for tests / a future relocation. */
  private readonly claudeConfigBase: string;

  constructor(
    private readonly store: ConfigStore,
    private readonly runners: Record<string, RunnerBackend>,
    private readonly shellRunner: ShellRunner = new ShellRunner(),
    claudeConfigDir?: string,
    private readonly maxResidentProcesses = DEFAULT_MAX_RESIDENT_PROCESSES,
  ) {
    if (!Number.isInteger(maxResidentProcesses) || maxResidentProcesses < 1) {
      throw new Error("resident process cap must be a positive integer");
    }
    this.claudeConfigBase = claudeConfigDir ?? join(os.homedir(), ".claude");
    this.resumeTicker = setInterval(() => this.resumeDrainedChannels(), 200);
    this.resumeTicker.unref();
    this.heartbeatTicker = setInterval(() => {
      for (const proc of this.procs.values()) {
        if (!proc.exited) this.emitLifecycle(proc, "heartbeat", "observed");
      }
    }, 10_000);
    this.heartbeatTicker.unref();
  }

  setAppLog(appLog: ProcessManager["appLog"]): void {
    this.appLog = appLog;
  }
  onExitHook(fn: (channel: string, reason: string) => void): void {
    this.exitHooks.add(fn);
  }
  onLifecycleHook(fn: (event: ProcessLifecycleEvent) => void): void {
    this.lifecycleHooks.add(fn);
  }

  /** Internal-only authorization for scheduler/Lead worktrees outside the canonical project root. */
  setManagedCwdAuthorizer(fn: (projectRoot: string, requestedCwd: string) => boolean): void {
    this.managedCwdAuthorizer = fn;
  }

  get size(): number {
    return this.procs.size;
  }

  rendererMaySpawn(req: SpawnRequest): boolean {
    void req;
    // All process creation, including Docker/mock agents, crosses Electron
    // main's exact one-time native confirmation. A container can still receive
    // project files and scoped secrets, so isolation is not launch authority.
    return false;
  }

  grantHostAutomation(projectId: string, agentIds: readonly string[]): void {
    if (!projectId || agentIds.length === 0) throw new Error("host automation grant requires a project roster");
    this.hostAutomationGrants.set(projectId, new Set(agentIds));
  }

  revokeHostAutomation(projectId: string): void {
    this.hostAutomationGrants.delete(projectId);
  }

  hasHostAutomationGrant(projectId: string | undefined, agentId: string | undefined): boolean {
    return Boolean(projectId && agentId && this.hostAutomationGrants.get(projectId)?.has(agentId));
  }

  /** live agent sessions (Lead + workers) — the scheduler's concurrency gauge.
   *  Budget-paused workers are EXCLUDED: a SIGSTOP'd run is making no progress, so
   *  it must not hold a slot and block unrelated, in-budget projects from
   *  dispatching. This is only the scheduler's effective-work gauge: the
   *  resident-process safety cap still counts paused processes, while the
   *  configured concurrency cap tracks only processes doing active work.
   *  NOTE: this counts only kind==="agent" —
   *  manually-spawned shells are intentionally NOT counted here (they legitimately
   *  hold a real slot the scheduler doesn't manage); the spawn() hard guard counts
   *  all live procs, so a shell at cap can surface a benign dispatch-time requeue. */
  liveAgentCount(): number {
    return [...this.procs.values()].filter(
      (p) => !p.exited && !p.budgetPaused && p.session.kind === "agent",
    ).length;
  }

  /** true if the channel has a live (non-exited) process. */
  isLive(channel: string): boolean {
    const proc = this.procs.get(channel);
    return !!proc && !proc.exited;
  }

  /** ms since a live channel last produced output, or undefined if the channel
   *  is not live (exited/unknown). Drives the idle watchdog. */
  silentMsFor(channel: string): number | undefined {
    const proc = this.procs.get(channel);
    if (!proc || proc.exited) return undefined;
    // a budget-paused (SIGSTOP'd) worker is silent BY DESIGN — never flag it idle,
    // or the watchdog would tell the operator to "re-run" a deliberately-paused run
    if (proc.budgetPaused) return undefined;
    return Date.now() - proc.lastOutputAt;
  }

  /** live Claude agents with a transcript to cost (skips budget-paused ones). */
  costTargets(): Array<{ channel: string; transcriptPath: string; projectId?: string; agentId?: string }> {
    const out: Array<{ channel: string; transcriptPath: string; projectId?: string; agentId?: string }> = [];
    for (const proc of this.procs.values()) {
      if (proc.exited || proc.budgetPaused || !proc.transcriptPath) continue;
      out.push({
        channel: proc.session.id as string,
        transcriptPath: proc.transcriptPath,
        projectId: proc.session.projectId,
        agentId: proc.session.agentId as string | undefined,
      });
    }
    return out;
  }

  /** Apply externally-measured token/cost metrics (CostTracker) → session +
   *  a throttled metrics frame, reusing the telemetry plumbing the UI reads. */
  applyCostMetrics(
    channel: string,
    m: Pick<RunMetrics, "inputTokens" | "outputTokens" | "cacheReadTokens" | "costUsd">,
  ): void {
    const proc = this.procs.get(channel);
    if (!proc || proc.exited) return;
    proc.session.metrics = { ...proc.session.metrics, ...m };
    const now = Date.now();
    if (now - proc.lastMetricsSentAt >= this.store.getSettings().telemetry.metricsIntervalMs) {
      proc.lastMetricsSentAt = now;
      this.sendFrame(proc, { channel, type: "metrics", data: proc.session.metrics });
    }
  }

  /** Suspend a live run because it hit a budget cap — reversible via resume().
   *  SOFT CEILING: we SIGSTOP the worker's whole process GROUP (node-pty children
   *  are session leaders, so -pid targets the group: claude + its MCP children),
   *  which halts NEW API turns. An API request already in flight still completes
   *  and is billed, so a run can overshoot the cap by up to one turn. Returns
   *  false if the channel isn't live or is already paused. */
  budgetPause(channel: string): boolean {
    const proc = this.procs.get(channel);
    if (!proc || proc.exited || proc.budgetPaused || !proc.pty.pid) return false;
    if (!signalGroup(proc.pty.pid, "SIGSTOP")) return false; // process already gone
    proc.budgetPaused = true;
    this.setStatus(proc, "paused", "Budget paused");
    return true;
  }

  /** Resume a budget-paused run (SIGCONT the process group). Returns false if not paused. */
  resume(channel: string): boolean {
    const proc = this.procs.get(channel);
    if (!proc || proc.exited || !proc.budgetPaused || !proc.pty.pid) return false;
    const residentOccupancy = this.residentOccupancy() + this.admissionReservations;
    if (residentOccupancy > this.maxResidentProcesses) return false;
    const effectiveOccupancy = this.effectiveOccupancy() + this.admissionReservations;
    if (effectiveOccupancy >= this.store.getSettings().maxConcurrentSessions) return false;
    if (!signalGroup(proc.pty.pid, "SIGCONT")) return false;
    proc.budgetPaused = false;
    this.setStatus(proc, "running", "Resumed");
    return true;
  }

  /** ws is optional: scheduler/Lead spawns have no originating socket and are
   *  announced to all clients via a session_started broadcast instead */
  async spawn(
    req: SpawnRequest,
    ws?: WebSocket,
    authority: ChannelAuthority = ws ? "admin" : "system",
  ): Promise<TerminalSession> {
    req = this.normalizeSpawnRequest(req);
    if (this.procs.has(req.channel) || this.reservedChannels.has(req.channel)) {
      throw new SpawnError("SPAWN_FAILED", `channel ${req.channel} already exists`);
    }
    const releaseAdmission = this.reserveAdmission(req.channel);
    try {
      return await this.spawnAdmitted(req, ws, authority);
    } finally {
      releaseAdmission();
    }
  }

  private async spawnAdmitted(
    req: SpawnRequest,
    ws: WebSocket | undefined,
    authority: ChannelAuthority,
  ): Promise<TerminalSession> {
    let pty: IPty;
    let handle: RunnerHandle;
    let agentName: string;
    let agentId: TerminalSession["agentId"];
    let maxRuntimeMs: number | undefined;

    let launchDef: AgentDefinition | undefined =
      req.kind === "agent" && req.agentId ? this.store.getAgent(req.agentId) : undefined;
    if (req.kind === "chat") {
      if (authority === "system") {
        throw new SpawnError("SPAWN_FAILED", "ad-hoc chat requires an interactive operator launch");
      }
      if (!req.providerId) throw new SpawnError("SPAWN_FAILED", "providerId required");
      const provider = this.store.getProvider(req.providerId);
      if (!provider || !provider.enabled) {
        throw new SpawnError("SPAWN_FAILED", "selected chat provider is unavailable or disabled");
      }
      if (provider.mode !== "cli") {
        throw new SpawnError("SPAWN_FAILED", "selected provider has no interactive CLI runtime");
      }
      if (provider.models.length > 0 && !req.model) {
        throw new SpawnError("SPAWN_FAILED", "select a model reported by this provider");
      }
      if (req.model && !provider.models.some((model) => model.id === req.model)) {
        throw new SpawnError(
          "SPAWN_FAILED",
          "selected model is not present in the provider's current reported catalog",
        );
      }
      const now = new Date().toISOString();
      launchDef = {
        // A valid in-memory identity for the runner, deliberately never persisted.
        id: req.channel as AgentDefinition["id"],
        name: provider.name,
        description: req.model ?? "Provider native default",
        providerId: provider.id,
        // Empty bypasses a configured defaultModel when no live catalog exists;
        // the provider CLI chooses its current native default instead.
        model: req.model ?? "",
        systemPrompt:
          "You are an ad-hoc assistant in Daimon OS Master Chat. Answer the operator directly. " +
          "You are not a project agent and have no project-specific tools, skills, MCP servers, or secrets.",
        tools: [],
        isolation: "cli",
        permissionMode: "supervised",
        env: {},
        limits: {},
        skillIds: [],
        mcpServerIds: [],
        secretIds: [],
        createdAt: now,
        updatedAt: now,
      };
    }
    const spawnKind = launchDef ? this.store.getProvider(launchDef.providerId)?.kind : undefined;
    // Only app-selected definitions enter a provider adapter which can isolate
    // its trusted MCP config from the repository. Unsupported adapters get no
    // injected definitions; a Lead request carrying Daimon MCP fails in CliRunner.
    if (
      req.kind === "agent" &&
      launchDef &&
      launchDef.isolation === "cli" &&
      spawnKind &&
      trustedMcpCapability(spawnKind).supported &&
      !(req as TrustedMcpSpawnRequest).trustedMcpServers
    ) {
      req = {
        ...req,
        trustedMcpServers: this.store.mcpServersForSpawn(launchDef),
      } as TrustedMcpSpawnRequest;
    }

    if (req.kind === "shell") {
      try {
        // inject the project's opted-in vault secrets as env vars (agents get
        // this via CliRunner; shells get it here) so a manual script can use them
        ({ pty, handle } = this.shellRunner.spawnShell(
          req,
          this.store.secretsForProject(req.projectId),
        ));
      } catch (err) {
        throw new SpawnError("SPAWN_FAILED", err instanceof Error ? err.message : String(err));
      }
      agentName =
        req.displayName ?? (req.cwd ? basename(req.cwd) : undefined) ?? "shell";
    } else {
      if (!launchDef) {
        throw new SpawnError(
          "SPAWN_FAILED",
          req.kind === "chat" ? "chat provider unavailable" : `unknown agent ${req.agentId ?? ""}`,
        );
      }
      const def = launchDef;
      if (
        req.kind === "agent" &&
        authority === "system" &&
        def.isolation === "cli" &&
        !this.hasHostAutomationGrant(req.projectId, def.id)
      ) {
        throw new SpawnError(
          "SPAWN_FAILED",
          "autonomous host CLI execution requires a native-confirmed project/team grant or Docker isolation",
        );
      }
      const runner = this.runners[def.isolation];
      if (!runner) throw new SpawnError("SPAWN_FAILED", `no runner for "${def.isolation}"`);
      try {
        ({ pty, handle } = await runner.spawn(def, req));
      } catch (err) {
        throw new SpawnError("SPAWN_FAILED", err instanceof Error ? err.message : String(err));
      }
      agentId = req.kind === "agent" ? def.id : undefined;
      agentName = req.displayName ?? def.name;
      maxRuntimeMs = def.limits.maxRuntimeMs;
    }

    const session: TerminalSession = {
      id: req.channel as TerminalSession["id"],
      kind: req.kind,
      agentId,
      providerId: req.kind === "chat" ? launchDef?.providerId : undefined,
      model: req.kind === "chat" ? req.model : undefined,
      agentName,
      role: launchDef?.description, // drives the floating identity chip
      projectId: req.projectId,
      cwd: req.cwd,
      status: "spawning",
      statusLabel: "Spawning",
      activeTools: [],
      pid: pty.pid,
      containerId: handle.containerId,
      cols: req.cols,
      rows: req.rows,
      startedAt: new Date().toISOString(),
      metrics: emptyMetrics(),
    };

    const proc: ManagedProcess = {
      session,
      pty,
      handle,
      ring: new ReplayRingBuffer(),
      seq: 0,
      subscribers: ws ? new Set([ws]) : new Set(),
      batcher: null as unknown as OutputBatcher,
      telemetry: new OscTelemetryParser(),
      paused: false,
      exited: false,
      lastMetricsSentAt: 0,
      lastOutputAt: Date.now(),
      lastLifecycleOutputAt: 0,
      outputTail: "",
      cmd: handle.cmd,
      authority,
    };
    proc.batcher = new OutputBatcher((data) =>
      this.sendFrame(proc, { channel: req.channel, type: "stdout", data }),
    );
    // claude writes a per-session JSONL transcript keyed by --session-id (== our
    // channel); record its path so the CostTracker can read real token/cost
    if (spawnKind === "claude" && req.cwd) {
      proc.transcriptPath = claudeTranscriptPath(req.cwd, req.channel, this.claudeConfigBase);
    }
    this.procs.set(req.channel, proc);
    this.emitLifecycle(proc, "spawn", "observed");

    pty.onData((data) => {
      const { clean, events } = proc.telemetry.parse(data);
      for (const event of events) this.applyTelemetry(proc, event);
      if (clean) {
        proc.lastOutputAt = Date.now(); // resets the idle watchdog clock
        if (proc.lastOutputAt - proc.lastLifecycleOutputAt >= 2_000) {
          proc.lastLifecycleOutputAt = proc.lastOutputAt;
          this.emitLifecycle(proc, "output", "observed", true);
        }
        proc.batcher.accept(clean);
        // keep a rolling, ANSI-stripped tail of agent output for the exit log
        if (proc.session.kind === "agent") {
          proc.outputTail = (proc.outputTail + clean.replace(ANSI_RE, "")).slice(-OUTPUT_TAIL_MAX);
        }
      }
    });
    pty.onExit(({ exitCode, signal }) => this.handleExit(proc, exitCode, signal));

    if (maxRuntimeMs) {
      proc.timeoutHandle = setTimeout(() => {
        proc.killReason = "timeout";
        pty.kill("SIGKILL");
      }, maxRuntimeMs);
      proc.timeoutHandle.unref();
    }

    this.setStatus(
      proc,
      "running",
      req.kind === "shell" ? "Shell" : req.kind === "chat" ? "Chat ready" : "Spawned",
    );
    this.appLog?.emit(
      "info",
      "spawn",
      `${req.kind} "${agentName}" started${req.projectId ? ` in project` : ""}`,
      req.channel,
    );
    return session;
  }

  /**
   * Headless one-shot run for Fusion panel/judge sub-invocations: spawn the
   * agent's CLI in one-shot mode, capture its full ANSI-stripped stdout, and
   * resolve once it exits (or after `timeoutSeconds`, SIGKILL'ing it). There is
   * NO visible pane and NO ws — these runs analyze in the background — but they
   * DO occupy the concurrency cap and feed the cost meter exactly like a normal
   * spawn (the run is registered as a real ManagedProcess with no subscribers,
   * so liveAgentCount()/costTargets() see it).
   *
   * RECURSION: Fusion is triggered ONLY by Scheduler.maybeRunFusion, which fires
   * exclusively on a dispatched TASK. Panel/judge agents are run here via
   * runHeadless (NOT as tasks, NOT via Scheduler.dispatch), so they structurally
   * can never re-enter Fusion — even if a panel/judge agent itself has Fusion
   * enabled. `fusionDepth: 1` is carried on the spawn for telemetry/observability
   * (and as a tripwire should a future code path ever route a headless run back
   * through dispatch); it is not the primary guard — the structural separation is.
   */
  async runHeadless(
    agentId: string,
    prompt: string,
    opts: { timeoutSeconds: number; fusionDepth: number; cwd?: string; projectId?: string },
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean; latencyMs: number }> {
    const def = this.store.getAgent(agentId as TerminalSession["agentId"] & string);
    if (!def) throw new SpawnError("SPAWN_FAILED", `unknown agent ${agentId}`);
    if (def.isolation === "cli") {
      throw new SpawnError(
        "SPAWN_FAILED",
        "headless host CLI execution is disabled; use Docker isolation for background analysis",
      );
    }
    const runner = this.runners[def.isolation];
    if (!runner) throw new SpawnError("SPAWN_FAILED", `no runner for "${def.isolation}"`);

    const channel = newSessionId() as string;
    const releaseAdmission = this.reserveAdmission(channel);
    let req: SpawnRequest = {
      reqId: channel,
      kind: "agent",
      agentId: def.id,
      channel,
      cols: 100,
      rows: 30,
      cwd: opts.cwd,
      projectId: opts.projectId,
      oneShot: true,
      taskPrompt: prompt,
      fusionDepth: opts.fusionDepth,
    };
    try {
      req = this.normalizeSpawnRequest(req);

      const spawnKind = this.store.getProvider(def.providerId)?.kind;

      let pty: IPty;
      let handle: RunnerHandle;
      try {
        ({ pty, handle } = await runner.spawn(def, req));
      } catch (err) {
        throw new SpawnError("SPAWN_FAILED", err instanceof Error ? err.message : String(err));
      }

      const startedAt = Date.now();
      const session: TerminalSession = {
      id: channel as TerminalSession["id"],
      kind: "agent",
      agentId: def.id,
      agentName: def.name,
      role: def.description,
      projectId: req.projectId,
      cwd: req.cwd,
      status: "running",
      statusLabel: "Fusion (headless)",
      activeTools: [],
      pid: pty.pid,
      containerId: handle.containerId,
      cols: req.cols,
      rows: req.rows,
      startedAt: new Date().toISOString(),
      metrics: emptyMetrics(),
    };
    // minimal managed entry: no subscribers, no batcher frames — but real enough
    // that liveAgentCount()/costTargets() count it toward the cap + cost meter
      const proc: ManagedProcess = {
      session,
      pty,
      handle,
      ring: new ReplayRingBuffer(),
      seq: 0,
      subscribers: new Set(),
      batcher: null as unknown as OutputBatcher,
      telemetry: new OscTelemetryParser(),
      paused: false,
      exited: false,
      lastMetricsSentAt: 0,
      lastOutputAt: Date.now(),
      lastLifecycleOutputAt: 0,
      outputTail: "",
      authority: "system",
    };
      proc.batcher = new OutputBatcher(() => {});
      if (spawnKind === "claude" && req.cwd) {
        proc.transcriptPath = claudeTranscriptPath(req.cwd, channel, this.claudeConfigBase);
      }
      this.procs.set(channel, proc);
      releaseAdmission();

      return await new Promise((resolve) => {
      let captured = "";
      let timedOut = false;
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      // single guaranteed teardown: drop the registry entry (so it stops counting
      // toward the cap/cost meter), run cleanup, resolve once — no matter whether
      // we got here via onExit OR the timeout fallback. Without this, a SIGKILL
      // that doesn't re-fire onExit would leak the proc + never resolve.
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        if (!proc.exited) {
          proc.exited = true;
          proc.session.endedAt = new Date().toISOString();
          proc.session.exitCode = exitCode;
          void proc.handle.cleanup().catch(() => {});
        }
        this.procs.delete(channel);
        const output = captured.replace(ANSI_RE, "").trim();
        resolve({ output, exitCode, timedOut, latencyMs: Date.now() - startedAt });
      };
      pty.onData((data) => {
        const { clean } = proc.telemetry.parse(data);
        if (clean) {
          proc.lastOutputAt = Date.now();
          captured = (captured + clean).slice(-OUTPUT_TAIL_MAX);
        }
      });
      pty.onExit(({ exitCode }) => finish(exitCode));
      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        try {
          pty.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        // force-settle if onExit doesn't fire shortly after the kill (already-reaped
        // child, or a runner that swallows the signal) — guarantees no leak/hang
        graceTimer = setTimeout(() => finish(null), 1000);
        graceTimer.unref();
      }, Math.max(1, opts.timeoutSeconds) * 1000);
      timer.unref();
      });
    } finally {
      releaseAdmission();
    }
  }

  write(channel: string, data: string): boolean {
    const proc = this.mustGet(channel);
    if (proc.exited) return false;
    proc.pty.write(data);
    return true;
  }

  resize(channel: string, cols: number, rows: number): void {
    const proc = this.mustGet(channel);
    proc.session.cols = cols;
    proc.session.rows = rows;
    if (!proc.exited) proc.pty.resize(cols, rows);
  }

  attach(channel: string, ws: WebSocket, fromSeq = 0): void {
    const proc = this.mustGet(channel);
    // Replay BEFORE subscribing. This whole block is synchronous, so no live
    // frame can interleave into the replay window or be delivered twice —
    // everything after the subscribe below carries seq > ring.lastSeq.
    const frames = proc.ring.from(fromSeq);
    send(ws, makeFrame({
      channel,
      type: "replay_start",
      data: {
        fromSeq,
        count: frames.length,
        firstSeq: frames[0]?.seq ?? proc.ring.firstSeq,
      },
    }));
    for (const frame of frames) send(ws, frame);
    send(ws, makeFrame({
      channel,
      type: "replay_end",
      data: { lastSeq: proc.ring.lastSeq },
    }));
    proc.subscribers.add(ws);
  }

  detach(channel: string, ws: WebSocket): void {
    this.procs.get(channel)?.subscribers.delete(ws);
  }

  /** Remove a socket from every channel (connection closed). */
  detachSocket(ws: WebSocket): void {
    for (const proc of this.procs.values()) proc.subscribers.delete(ws);
  }

  kill(channel: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    const proc = this.mustGet(channel);
    if (proc.exited) return;
    proc.killReason = "killed";
    proc.pty.kill(signal);
  }

  /** Kill + free EVERY live channel, but keep the manager operational (unlike
   *  shutdown(), which is for app quit). Used by factory reset so wiping config
   *  doesn't leave orphaned agent terminals running (and burning tokens). */
  async closeAllChannels(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((ch) => this.close(ch)));
  }

  /** Destructive path: kill + runner cleanup + free the channel entirely. The
   *  reason drives the final pane status — "killed" for a user/Atropos close (the
   *  default), "completed" when closing a worker that already finished its task. */
  async close(channel: string, reason: ExitReason = "killed"): Promise<void> {
    const proc = this.procs.get(channel);
    if (!proc) return;
    if (proc.terminalization) await proc.terminalization;
    else if (!proc.exited) await this.terminalize(proc, 0, undefined, reason, true, true);
    this.releaseRegistry(proc);
  }

  snapshot(): ChannelSnapshot[] {
    return [...this.procs.values()].map((proc) => ({
      channel: proc.session.id as string,
      session: proc.session,
      lastSeq: proc.ring.lastSeq,
    }));
  }


  snapshotFor(authority: ChannelAuthority): ChannelSnapshot[] {
    return this.snapshot().filter((item) => this.canAccess(item.channel, authority, "read"));
  }

  canAccess(channel: string, authority: ChannelAuthority, operation: ChannelOperation): boolean {
    if (authority === "admin") return true;
    const proc = this.procs.get(channel);
    if (!proc) return false;
    if (proc.authority === "admin") return false;
    if (operation === "read") return true;
    return proc.authority === "renderer";
  }

  async shutdown(): Promise<void> {
    clearInterval(this.resumeTicker);
    clearInterval(this.heartbeatTicker);
    await Promise.all([...this.procs.keys()].map((ch) => this.close(ch)));
  }

  // ---- internals ----

  private normalizeSpawnRequest(req: SpawnRequest): SpawnRequest {
    if (!req.projectId) return req;
    const project = this.store.getProject(
      req.projectId as Parameters<ConfigStore["getProject"]>[0],
    );
    if (!project) throw new SpawnError("SPAWN_FAILED", `unknown project ${req.projectId}`);
    if (req.cwd && this.managedCwdAuthorizer?.(project.path, req.cwd)) {
      return { ...req, cwd: fsRealDirectory(req.cwd) };
    }
    try {
      return { ...req, cwd: resolveProjectCwd(project.path, req.cwd) };
    } catch (err) {
      throw new SpawnError(
        "SPAWN_FAILED",
        err instanceof Error ? err.message : "invalid project working directory",
      );
    }
  }

  private mustGet(channel: string): ManagedProcess {
    const proc = this.procs.get(channel);
    if (!proc) throw new SpawnError("UNKNOWN_CHANNEL", `no such channel ${channel}`);
    return proc;
  }

  private sendFrame(
    proc: ManagedProcess,
    body: Omit<ServerFrame, "v" | "ts" | "seq">,
  ): void {
    proc.seq += 1;
    const frame = {
      ...body,
      v: PROTOCOL_VERSION,
      ts: Date.now(),
      seq: proc.seq,
    } as ServerFrame;
    if (frame.type !== "metrics") proc.ring.push(frame);
    for (const ws of proc.subscribers) {
      send(ws, frame);
      if (ws.bufferedAmount > WS_HIGH_WATER_BYTES && !proc.paused && !proc.exited) {
        proc.paused = true;
        proc.pty.pause();
      }
    }
  }

  private resumeDrainedChannels(): void {
    for (const proc of this.procs.values()) {
      if (!proc.paused || proc.exited) continue;
      const drained = [...proc.subscribers].every(
        (ws) => ws.bufferedAmount < WS_LOW_WATER_BYTES,
      );
      if (drained) {
        proc.paused = false;
        proc.pty.resume();
      }
    }
  }

  private applyTelemetry(proc: ManagedProcess, event: TelemetryEvent): void {
    if (event.kind === "status") {
      this.setStatus(proc, event.status, event.label, event.activeTools, "reported");
      return;
    }
    proc.session.metrics = { ...proc.session.metrics, ...stripUndefined(event.metrics) };
    const now = Date.now();
    if (now - proc.lastMetricsSentAt >= this.store.getSettings().telemetry.metricsIntervalMs) {
      proc.lastMetricsSentAt = now;
      this.sendFrame(proc, {
        channel: proc.session.id as string,
        type: "metrics",
        data: proc.session.metrics,
      });
    }
  }

  private setStatus(
    proc: ManagedProcess,
    status: TerminalSession["status"],
    label?: string,
    activeTools?: string[],
    confidence: ProcessLifecycleEvent["confidence"] = "observed",
  ): void {
    proc.session.status = status;
    if (label) proc.session.statusLabel = label;
    if (activeTools) proc.session.activeTools = activeTools;
    this.sendFrame(proc, {
      channel: proc.session.id as string,
      type: "status",
      data: {
        status,
        label: proc.session.statusLabel,
        activeTools: proc.session.activeTools,
      },
    });
    this.emitLifecycle(proc, "status", confidence);
  }

  private emitLifecycle(
    proc: ManagedProcess,
    kind: ProcessLifecycleEvent["kind"],
    confidence: ProcessLifecycleEvent["confidence"],
    outputObserved = false,
  ): void {
    const event: ProcessLifecycleEvent = {
      kind,
      channel: proc.session.id as string,
      session: proc.session,
      confidence,
      outputObserved,
    };
    for (const hook of this.lifecycleHooks) {
      try { hook(event); } catch { /* observability cannot strand a process */ }
    }
  }

  private handleExit(proc: ManagedProcess, exitCode: number, signal?: number): void {
    if (proc.exited || !this.procs.has(proc.session.id as string)) return;
    const reason: ExitReason = proc.killReason ?? (exitCode === 0 ? "completed" : "crashed");
    void this.terminalize(proc, exitCode, signal, reason, false, false);
  }

  private terminalize(
    proc: ManagedProcess,
    exitCode: number,
    signal: number | undefined,
    reason: ExitReason,
    kill: boolean,
    removeImmediately: boolean,
  ): Promise<void> {
    if (proc.terminalization) return proc.terminalization;
    let resolve!: () => void;
    // Install the shared promise before killing: some PTY implementations invoke
    // onExit synchronously from kill(), and must observe this in-flight teardown.
    proc.terminalization = new Promise<void>((done) => { resolve = done; });
    void this.performTerminalization(proc, exitCode, signal, reason, kill, removeImmediately)
      .then(resolve, resolve);
    return proc.terminalization;
  }

  private async performTerminalization(
    proc: ManagedProcess,
    exitCode: number,
    signal: number | undefined,
    reason: ExitReason,
    kill: boolean,
    removeImmediately: boolean,
  ): Promise<void> {
    proc.exited = true;
    proc.batcher.dispose();
    if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
    proc.killReason = reason;
    if (kill) {
      try { proc.pty.kill("SIGKILL"); } catch { /* already dead */ }
    }
    if (!TERMINAL_STATUSES.has(proc.session.status)) {
      const status =
        reason === "completed" ? "completed" : reason === "killed" ? "killed" : "failed";
      // overwrite the (frozen) last telemetry label with a terminal one — a done
      // agent showing a stale spinner word ("Cogitating") reads as still-working.
      const label =
        status === "completed" ? "Done" : status === "killed" ? "Closed" : "Failed";
      this.setStatus(proc, status, label);
    }
    proc.session.endedAt = new Date().toISOString();
    proc.session.exitCode = exitCode;
    proc.session.exitReason = reason;
    proc.session.metrics.durationMs =
      Date.parse(proc.session.endedAt) - Date.parse(proc.session.startedAt);

    this.sendFrame(proc, {
      channel: proc.session.id as string,
      type: "exit",
      data: { exitCode, signal: signal ? String(signal) : undefined, reason },
    });
    this.emitLifecycle(proc, "exit", "observed");

    try { await proc.handle.cleanup(); } catch { /* best effort; runner may already be gone */ }
    // Build a detail block for the log row (shown when expanded).
    // For crashes we always include diagnostics even when there is no output,
    // since the most common crash scenario (bypass-permissions dialog, missing cwd,
    // bad MCP config) produces 0 bytes of visible output.
    const tailText = proc.session.kind === "agent" ? proc.outputTail.trim() : "";
    let detail: string | undefined;
    if (reason === "crashed" || tailText) {
      const lines: string[] = [];
      if (proc.cmd) lines.push(`command: ${proc.cmd}`);
      if (proc.session.cwd) lines.push(`cwd:     ${proc.session.cwd}`);
      lines.push(`exit:    code ${exitCode}${signal ? ` · signal ${signal}` : ""}`);
      if (tailText) lines.push(`\n--- last output ---\n${tailText}`);
      else if (reason === "crashed") lines.push("\n(no output captured — process exited before producing any)");
      detail = lines.join("\n");
    }
    this.appLog?.emit(
      reason === "completed" ? "info" : reason === "crashed" ? "error" : "warn",
      "exit",
      `"${proc.session.agentName}" exited (${reason}, code ${exitCode})`,
      proc.session.id as string,
      detail,
    );
    // Runtime mounts/config are gone before durable evidence capture. Hooks are
    // synchronous today; isolate failures so registry teardown is guaranteed.
    for (const hook of this.exitHooks) {
      try { hook(proc.session.id as string, reason); } catch { /* one hook cannot strand a process */ }
    }
    if (removeImmediately) {
      this.releaseRegistry(proc);
    } else {
      // Keep the ring buffer around so late attaches can read final output.
      proc.retentionHandle = setTimeout(() => this.releaseRegistry(proc), RING_RETENTION_MS);
      proc.retentionHandle.unref();
      this.evictExcessRetained();
    }
  }

  /** Spawn-and-complete loops must not accumulate ring buffers without bound. */
  private evictExcessRetained(): void {
    const retained = [...this.procs.values()]
      .filter((p) => p.exited)
      .sort((a, b) => Date.parse(a.session.endedAt ?? "") - Date.parse(b.session.endedAt ?? ""));
    for (const proc of retained.slice(0, Math.max(0, retained.length - MAX_RETAINED_PROCS))) {
      this.releaseRegistry(proc);
    }
  }

  private releaseRegistry(proc: ManagedProcess): void {
    if (proc.timeoutHandle) clearTimeout(proc.timeoutHandle);
    if (proc.retentionHandle) clearTimeout(proc.retentionHandle);
    proc.batcher.dispose();
    proc.subscribers.clear();
    this.procs.delete(proc.session.id as string);
  }

  private residentOccupancy(): number {
    return [...this.procs.values()].filter((proc) => !proc.exited).length;
  }

  private effectiveOccupancy(): number {
    return [...this.procs.values()].filter((proc) => !proc.exited && !proc.budgetPaused).length;
  }

  private reserveAdmission(channel: string): () => void {
    const residentOccupancy = this.residentOccupancy() + this.admissionReservations;
    if (residentOccupancy >= this.maxResidentProcesses) {
      throw new SpawnError(
        "LIMIT_EXCEEDED",
        `resident process cap (${this.maxResidentProcesses}) reached`,
      );
    }
    const maximum = this.store.getSettings().maxConcurrentSessions;
    if (this.effectiveOccupancy() + this.admissionReservations >= maximum) {
      throw new SpawnError("LIMIT_EXCEEDED", `max concurrent sessions (${maximum}) reached`);
    }
    this.admissionReservations += 1;
    this.reservedChannels.add(channel);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.admissionReservations -= 1;
      this.reservedChannels.delete(channel);
    };
  }
}

function fsRealDirectory(input: string): string {
  // Kept local to avoid widening the public project-path API to accept managed
  // paths. realpath+directory validation is still mandatory before spawn.
  const real = fs.realpathSync.native(input);
  if (!fs.statSync(real).isDirectory()) throw new Error("managed working directory is not a directory");
  return real;
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Signal a PTY child's whole process GROUP (node-pty children are session
 *  leaders, so the pid IS the group id → -pid targets the group). Falls back to
 *  the bare pid if the group send fails. Returns false only if both fail (the
 *  process is already gone). */
function signalGroup(pid: number, signal: "SIGSTOP" | "SIGCONT"): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
