import crypto from "node:crypto";
import type {
  AgentDefinition,
  FusionConfig,
  FusionPanelResult,
  FusionRun,
  FusionRunStatus,
} from "@daimon-os/shared";
import type { ConfigStore, StoredFusionRun } from "../config/ConfigStore";
import type { AppLog } from "../gateway/AppLog";
import type { MemoryService } from "../memory/MemoryService";
import type { ProcessManager } from "./ProcessManager";
import { SpawnError } from "./ProcessManager";

/** Run `fn` over `items` with at most `limit` in flight. Never rejects — each
 *  result/rejection is returned positionally (like allSettled). */
async function runPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }>> {
  const results = new Array<{ status: "fulfilled"; value: R } | { status: "rejected"; reason: unknown }>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]!, i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Thrown when a Fusion run cannot proceed (invalid config, every panel agent
 * failed, or an unexpected error). The Scheduler maps this onto fail-open
 * behavior: failOpen=true → run the invoked agent normally; failOpen=false →
 * mark the task failed with this message.
 */
export class FusionError extends Error {
  constructor(
    readonly reason: FusionRun["failureReason"],
    message: string,
  ) {
    super(message);
    this.name = "FusionError";
  }
}

export interface FusionInvocation {
  invokedAgent: AgentDefinition;
  /** the task text (title + optional description) the invoked agent will run */
  task: string;
  teamId?: string;
  projectId?: string;
  teamLeaderAgentId?: string;
  /** the project working directory — the cwd for every headless panel/judge run */
  cwd?: string;
}

export interface FusionResult {
  fusionRunId: string;
  judgeAnalysis?: string;
  panelResults: FusionPanelResult[];
  failedPanelAgentIds: string[];
  /** the labeled block to PREPEND to the invoked agent's prompt */
  fusionContextForInvokedAgent: string;
  status: FusionRunStatus;
}

const PANEL_PROMPT_INSTRUCTION =
  "Return ONLY a single JSON object with these keys: " +
  '{"summary": string, "key_points": string[], "risks": string[], ' +
  '"recommendations": string[], "unknowns": string[], "confidence": "low"|"medium"|"high"}. ' +
  "Do not wrap it in prose; the JSON is parsed by a machine.";

const INJECTED_INSTRUCTION =
  "You have Fusion analysis from your configured panel agents and a judge synthesis above. " +
  "Use it to inform your work, but do NOT expose the raw internal Fusion JSON to the user. " +
  "Respond in your normal role as the agent assigned to this task.";

/**
 * Fusion capability — server-side orchestration of a multi-agent deliberation
 * that runs BEFORE a Fusion-enabled agent answers. A panel of agents analyze
 * the task independently (headless), a judge compares them (headless), and the
 * synthesis is injected into the invoked agent's prompt. The panel/judge never
 * answer the Lead; the invoked agent stays the responder. Fusion never recurses
 * (panel/judge run via pm.runHeadless with fusionDepth:1, not Scheduler.dispatch).
 */
export class FusionExecutionService {
  constructor(
    private readonly store: ConfigStore,
    private readonly pm: ProcessManager,
    private readonly memory: MemoryService | undefined,
    private readonly appLog: AppLog,
  ) {}

  async runFusionForAgentInvocation(inv: FusionInvocation): Promise<FusionResult> {
    const { invokedAgent, task } = inv;
    const config = invokedAgent.fusionConfig;
    if (!config) {
      throw new FusionError("invalid_fusion_config", "agent has no fusionConfig");
    }

    // validate against the live registry (existence + not-self + size + dups)
    const errors = this.store.validateFusionConfig(invokedAgent.id, config);
    if (errors.length) {
      throw new FusionError("invalid_fusion_config", errors.join("; "));
    }

    const startedAt = new Date().toISOString();
    const fusionRunId = crypto.randomUUID();

    this.appLog.emit(
      "info",
      "fusion",
      `triggered for "${invokedAgent.name}" — panel=[${config.panelAgentIds.join(", ")}] judge=${config.judgeAgentId}` +
        (inv.teamLeaderAgentId ? ` leader=${inv.teamLeaderAgentId}` : "") +
        (inv.teamId ? ` team=${inv.teamId}` : "") +
        (inv.projectId ? ` project=${inv.projectId}` : ""),
    );

    // --- PANEL: run panel agents headless, but with BOUNDED admission control so
    // they don't all race the global concurrency cap at once (which would turn a
    // benign capacity wait into spurious panel "failures"). Leave headroom for
    // the eventual judge + invoked agent and for unrelated project work. ---
    const cap = this.store.getSettings().maxConcurrentSessions;
    const panelLimit = Math.max(1, Math.min(config.panelAgentIds.length, Math.max(1, cap - 2)));
    const fusionStart = Date.now();
    const panelSettled = await runPool(config.panelAgentIds, panelLimit, (panelAgentId) =>
      this.runPanelAgent(panelAgentId, inv, config, fusionRunId),
    );
    const panelResults: FusionPanelResult[] = panelSettled.map((s, i) => {
      if (s.status === "fulfilled") return s.value;
      // a rejection (unexpected throw inside runPanelAgent) → record as failed
      return this.mkPanelResult(fusionRunId, config.panelAgentIds[i]!, {
        status: "failed",
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
      });
    });

    const failedPanelAgentIds = panelResults.filter((p) => p.status === "failed").map((p) => p.agentId);
    const ok = panelResults.filter((p) => p.status === "ok");
    if (failedPanelAgentIds.length) {
      this.appLog.emit(
        "warn",
        "fusion",
        `${failedPanelAgentIds.length}/${panelResults.length} panel agent(s) failed: ${failedPanelAgentIds.join(", ")}`,
      );
    }

    // ALL panel agents failed → cannot synthesize → persist a failed run + throw
    if (ok.length === 0) {
      this.persistRun(
        {
          id: fusionRunId,
          invokedAgentId: invokedAgent.id,
          teamLeaderAgentId: inv.teamLeaderAgentId,
          teamId: inv.teamId,
          projectId: inv.projectId,
          judgeAgentId: config.judgeAgentId,
          status: "failed",
          judgeStatus: "skipped",
          task,
          failureReason: "all_panel_agents_failed",
          failedPanelAgentIds,
          startedAt,
          completedAt: new Date().toISOString(),
        },
        panelResults,
      );
      throw new FusionError("all_panel_agents_failed", "every panel agent failed");
    }

    // --- JUDGE: compare the successful panel outputs, headless ---
    let judgeAnalysis: string | undefined;
    let judgeStatus: FusionRun["judgeStatus"] = "ok";
    try {
      const judgePrompt = this.buildJudgePrompt(task, ok);
      const judgeRun = await this.headlessWithCapRetry(config.judgeAgentId, judgePrompt, {
        timeoutSeconds: config.timeoutSeconds,
        fusionDepth: 1,
        cwd: inv.cwd,
        projectId: inv.projectId,
      });
      if (judgeRun.timedOut || judgeRun.exitCode !== 0 || !judgeRun.output.trim()) {
        throw new Error(judgeRun.timedOut ? "judge timed out" : "judge produced no usable output");
      }
      judgeAnalysis = lenientExtractJson(judgeRun.output) ?? judgeRun.output.trim();
      this.appLog.emit("info", "fusion", `judge ${config.judgeAgentId} ok (${judgeRun.latencyMs}ms)`);
    } catch (err) {
      // judge failure is NON-fatal: degrade to injecting the raw panel outputs
      judgeStatus = "degraded";
      this.appLog.emit(
        "warn",
        "fusion",
        `judge ${config.judgeAgentId} failed → degraded (raw panel outputs injected): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const status: FusionRunStatus = judgeStatus === "degraded" ? "degraded" : "completed";
    const fusionContextForInvokedAgent = this.buildInjectedContext(
      judgeStatus === "degraded" ? undefined : judgeAnalysis,
      ok,
    );

    this.persistRun(
      {
        id: fusionRunId,
        invokedAgentId: invokedAgent.id,
        teamLeaderAgentId: inv.teamLeaderAgentId,
        teamId: inv.teamId,
        projectId: inv.projectId,
        judgeAgentId: config.judgeAgentId,
        status,
        judgeStatus,
        task,
        judgeAnalysis: judgeStatus === "degraded" ? undefined : judgeAnalysis,
        failedPanelAgentIds,
        startedAt,
        completedAt: new Date().toISOString(),
      },
      panelResults,
    );

    // best-effort: record a memory summary of this Fusion deliberation
    if (inv.projectId) this.maybeWriteMemory(inv, status, ok.length, failedPanelAgentIds.length);

    this.appLog.emit(
      "info",
      "fusion",
      `completed for "${invokedAgent.name}" — status=${status} judge=${judgeStatus} ` +
        `panelOk=${ok.length} panelFailed=${failedPanelAgentIds.length} duration=${Date.now() - fusionStart}ms`,
    );

    return {
      fusionRunId,
      judgeAnalysis: judgeStatus === "degraded" ? undefined : judgeAnalysis,
      panelResults,
      failedPanelAgentIds,
      fusionContextForInvokedAgent,
      status,
    };
  }

  // ---- headless with cap retry ----

  /** runHeadless, but a transient LIMIT_EXCEEDED (the global concurrency cap was
   *  momentarily full) is retried with backoff rather than surfaced as a failure —
   *  capacity waits must not be mis-classified as panel/judge failures. */
  private async headlessWithCapRetry(
    agentId: string,
    prompt: string,
    opts: { timeoutSeconds: number; fusionDepth: number; cwd?: string; projectId?: string },
  ): Promise<Awaited<ReturnType<ProcessManager["runHeadless"]>>> {
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.pm.runHeadless(agentId, prompt, opts);
      } catch (err) {
        const capFull = err instanceof SpawnError && err.code === "LIMIT_EXCEEDED";
        if (capFull && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 1500 * attempt));
          continue;
        }
        throw err;
      }
    }
  }

  // ---- panel ----

  private async runPanelAgent(
    panelAgentId: string,
    inv: FusionInvocation,
    config: FusionConfig,
    fusionRunId: string,
  ): Promise<FusionPanelResult> {
    const prompt = this.buildPanelPrompt(panelAgentId, inv, config);
    // Failure-path timer: total elapsed incl. cap-retry backoff, unlike run.latencyMs
    // (which excludes retry waits) used by the timed-out / non-zero-exit / ok branches.
    const t0 = Date.now();
    try {
      const run = await this.headlessWithCapRetry(panelAgentId, prompt, {
        timeoutSeconds: config.timeoutSeconds,
        fusionDepth: 1,
        cwd: inv.cwd,
        projectId: inv.projectId,
      });
      if (run.timedOut) {
        return this.mkPanelResult(fusionRunId, panelAgentId, {
          status: "failed",
          error: "timed out",
          latencyMs: run.latencyMs,
        });
      }
      if (run.exitCode !== 0 || !run.output.trim()) {
        return this.mkPanelResult(fusionRunId, panelAgentId, {
          status: "failed",
          error: run.exitCode !== 0 ? `exited ${run.exitCode}` : "no output",
          latencyMs: run.latencyMs,
        });
      }
      return this.mkPanelResult(fusionRunId, panelAgentId, {
        status: "ok",
        output: run.output.trim(),
        latencyMs: run.latencyMs,
      });
    } catch (err) {
      return this.mkPanelResult(fusionRunId, panelAgentId, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - t0,
      });
    }
  }

  private buildPanelPrompt(panelAgentId: string, inv: FusionInvocation, config: FusionConfig): string {
    const parts: string[] = [
      "You are participating in a Fusion review. Several agents are independently " +
        "analyzing the SAME task; a judge will later compare your analyses. Analyze the " +
        "task independently and on its own merits. Do NOT answer or address the Team " +
        "Leader — you are not responding to the task, only analyzing it.",
    ];

    // optional context blocks per flags
    if (config.includeTeamContext && inv.teamId) {
      const team = this.store.listTeams().find((t) => t.id === inv.teamId);
      if (team) {
        const members = team.memberAgentIds
          .map((id) => this.store.getAgent(id as AgentDefinition["id"])?.name ?? id)
          .join(", ");
        parts.push(`## Team Context\nTeam: ${team.name}\nMembers: ${members}`);
      }
    }
    if (config.includeProjectMemory && inv.projectId) {
      let mem = "";
      try {
        mem =
          this.memory?.retrieve({
            projectId: inv.projectId,
            agentId: panelAgentId,
            taskTitle: inv.task,
          }) ?? "";
      } catch {
        mem = "";
      }
      if (mem) parts.push(mem.trimEnd());
    }

    parts.push(`## Task to analyze\n${inv.task}`);
    parts.push(PANEL_PROMPT_INSTRUCTION);
    return parts.join("\n\n");
  }

  // ---- judge ----

  private buildJudgePrompt(task: string, panelOk: FusionPanelResult[]): string {
    const analyses = panelOk
      .map((p, i) => `### Panel analysis ${i + 1} (agent ${p.agentId})\n${p.output ?? ""}`)
      .join("\n\n");
    return [
      "You are the judge in a Fusion review. Below are independent analyses of the same " +
        "task from a panel of agents. Compare them, reconcile disagreements, and synthesize " +
        "a single coherent analysis the assigned agent can act on. Do NOT answer the task " +
        "yourself — produce a synthesis of the panel's analyses.",
      `## Task\n${task}`,
      `## Panel analyses\n${analyses}`,
      'Return ONLY a single valid JSON object: {"synthesis": string, "consensus": string[], ' +
        '"disagreements": string[], "recommended_approach": string, "open_risks": string[]}. ' +
        "Output valid JSON only — no prose around it.",
    ].join("\n\n");
  }

  // ---- injected context ----

  private buildInjectedContext(judgeAnalysis: string | undefined, panelOk: FusionPanelResult[]): string {
    const lines: string[] = ["## Fusion Analysis"];
    if (judgeAnalysis) {
      lines.push("Judge synthesis of the panel review:", judgeAnalysis);
    } else {
      // degraded: judge failed → inject the raw panel outputs instead
      lines.push("Judge synthesis unavailable — raw panel analyses follow:");
      panelOk.forEach((p, i) => {
        lines.push(`### Panel analysis ${i + 1} (agent ${p.agentId})`, p.output ?? "");
      });
    }
    lines.push("", INJECTED_INSTRUCTION);
    return lines.join("\n");
  }

  // ---- persistence + memory ----

  private mkPanelResult(
    fusionRunId: string,
    agentId: string,
    rest: Omit<FusionPanelResult, "id" | "fusionRunId" | "agentId" | "createdAt">,
  ): FusionPanelResult {
    return {
      id: crypto.randomUUID(),
      fusionRunId,
      agentId,
      createdAt: new Date().toISOString(),
      ...rest,
    };
  }

  private persistRun(run: FusionRun, panelResults: FusionPanelResult[]): void {
    try {
      const stored: StoredFusionRun = { ...run, panelResults };
      this.store.addFusionRun(stored);
    } catch (err) {
      // persistence must never crash a dispatch — log and move on
      this.appLog.emit(
        "error",
        "fusion",
        `failed to persist fusion run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private maybeWriteMemory(
    inv: FusionInvocation,
    status: FusionRunStatus,
    panelOk: number,
    panelFailed: number,
  ): void {
    const settings = this.store.getMemorySettings();
    if (!settings.enabled) return;
    try {
      this.memory?.write({
        title: `Fusion review: ${inv.task.slice(0, 80)}`,
        content:
          `Fusion deliberation for agent "${inv.invokedAgent.name}" on task "${inv.task}". ` +
          `Status: ${status}. Panel agents OK: ${panelOk}, failed: ${panelFailed}.`,
        type: "episodic",
        projectId: inv.projectId,
        agentId: inv.invokedAgent.id,
        teamId: inv.teamId,
        confidence: "medium",
        tags: ["fusion"],
      });
    } catch {
      /* best-effort — never block on a memory write */
    }
  }
}

/**
 * Lenient JSON extraction: pull the first balanced {...} block out of a possibly
 * prose-wrapped output and validate it parses. Returns the JSON substring (so it
 * is re-serializable/injectable) or undefined when no valid object is found.
 */
export function lenientExtractJson(text: string): string | undefined {
  // strip a ```json fence if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const haystack = fenced?.[1] ?? text;
  const start = haystack.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < haystack.length; i++) {
    const ch = haystack[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = haystack.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
