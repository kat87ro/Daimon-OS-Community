import fs from "node:fs";
import { COST_POLL_MS } from "@daimon-os/shared";
import type { AgentDefinition, AgentId, ProjectId, ProviderConfig, SystemPayload } from "@daimon-os/shared";
import type { ConfigStore } from "../config/ConfigStore";
import type { AppLog } from "../gateway/AppLog";
import type { ProcessManager } from "./ProcessManager";
import { readTranscriptTotals } from "./transcript";

/** Whether an automated run can enforce a configured monetary budget. Mock and
 * loopback-only local inference have no provider charge; current paid-provider
 * metering is the Claude host-CLI transcript format only. */
export function supportsAutomatedCostMetering(
  agent: AgentDefinition,
  provider: ProviderConfig | undefined,
): boolean {
  if (agent.isolation === "mock") return true;
  return agent.isolation === "cli" && (
    provider?.kind === "claude" || provider?.kind === "ollama" || provider?.kind === "lmstudio"
  );
}

/**
 * Reads real token/cost out of each live Claude worker's session transcript on
 * an interval, feeds it into the run's metrics (so the pane header + Work Log
 * show ↑in ↓out · $cost), persists the per-task cost, and enforces budgets:
 * a run over its agent's maxCostUsd, or a project over its budgetUsd, is paused
 * (SIGSTOP) and alerted — reversible via resume.
 *
 * Claude-only metering: automated dispatch fails closed before launching an
 * unmetered real provider whenever an agent or project budget is configured.
 *
 * Soft-accounting note: we only poll LIVE workers, so a worker's FINAL transcript
 * turn (written just before it exits, between polls) may not be costed/persisted —
 * per-project totals can undercount by up to the last turn. This is consistent
 * with the "soft ceiling" budget framing (a run can also overshoot by one in-flight
 * turn). Acceptable for a local cost lever; revisit if exact charge reconciliation is needed.
 */
export class CostTracker {
  private timer?: NodeJS.Timeout;
  /** channels already paused+alerted, so we don't re-alert every poll */
  private readonly alerted = new Set<string>();
  /** last transcript byte size per channel — skip re-parsing an unchanged file */
  private readonly lastSize = new Map<string, number>();

  constructor(
    private readonly store: ConfigStore,
    private readonly pm: ProcessManager,
    private readonly broadcast: (payload: SystemPayload) => void,
    private readonly appLog: AppLog,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), COST_POLL_MS);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A resumed run may spend past its cap again — let it re-trip the budget. */
  noteResumed(channel: string): void {
    this.alerted.delete(channel);
  }

  /** Test hook: run one cost sweep synchronously. */
  tick(): void {
    this.sweep();
  }

  private sweep(): void {
    // prune alert/size state for channels that are no longer live (a paused
    // worker that exited/was killed instead of resumed would otherwise leak).
    // Safe: deleting from a Set/Map during its own iteration is spec-guaranteed.
    for (const ch of this.alerted) if (!this.pm.isLive(ch)) this.alerted.delete(ch);
    for (const ch of this.lastSize.keys()) if (!this.pm.isLive(ch)) this.lastSize.delete(ch);

    const changedProjects = new Set<string>();
    for (const target of this.pm.costTargets()) {
      // skip re-parsing if the transcript hasn't grown since the last poll
      let size: number;
      try {
        size = fs.statSync(target.transcriptPath).size;
      } catch {
        continue; // not created yet
      }
      if (this.lastSize.get(target.channel) === size) continue;
      this.lastSize.set(target.channel, size);

      const totals = readTranscriptTotals(target.transcriptPath);
      if (!totals) continue;
      this.pm.applyCostMetrics(target.channel, totals);

      // persist the cost onto the task so the board can total per-project spend
      const task = this.store.listTasks().find((t) => t.channel === target.channel);
      if (task && task.costUsd !== totals.costUsd) {
        this.store.upsertTask({ ...task, costUsd: totals.costUsd, updatedAt: new Date().toISOString() });
        changedProjects.add(task.projectId);
      }
      this.enforce(target, totals.costUsd);
    }
    for (const pid of changedProjects) this.broadcast({ kind: "tasks_changed", projectId: pid });
  }

  private enforce(
    target: { channel: string; projectId?: string; agentId?: string },
    runCostUsd: number,
  ): void {
    if (this.alerted.has(target.channel)) return;

    const agent = target.agentId ? this.store.getAgent(target.agentId as AgentId) : undefined;
    const runCap = agent?.limits.maxCostUsd;
    const overRun = runCap !== undefined && runCostUsd >= runCap;

    const project = target.projectId
      ? this.store.getProject(target.projectId as ProjectId)
      : undefined;
    const projCap = project?.budgetUsd;
    const projTotal = project
      ? this.store.listTasks(project.id).reduce((s, t) => s + (t.costUsd ?? 0), 0)
      : 0;
    const overProj = projCap !== undefined && projTotal >= projCap;

    if (!overRun && !overProj) return;

    if (overProj && project) {
      // a project breach FREEZES the project: pause EVERY live worker of it, not
      // just the one that tipped it (else siblings keep spending past the cap)
      for (const t of this.pm.costTargets()) {
        if (t.projectId !== project.id || this.alerted.has(t.channel)) continue;
        if (this.pm.budgetPause(t.channel)) {
          this.alerted.add(t.channel);
          this.broadcast({ kind: "tasks_changed", projectId: project.id });
        }
      }
      this.appLog.emit(
        "warn",
        "budget",
        `project "${project.name}" hit its $${projCap!.toFixed(2)} budget (spent $${projTotal.toFixed(2)}) — all workers FROZEN. Resume each from its pane (raising the budget alone won't un-pause them).`,
      );
      return;
    }

    // per-run cap: pause just this worker
    if (this.pm.budgetPause(target.channel)) {
      this.alerted.add(target.channel);
      this.appLog.emit(
        "warn",
        "budget",
        `"${agent?.name ?? "worker"}" hit its $${runCap!.toFixed(2)} cost cap (spent $${runCostUsd.toFixed(2)}) — paused. Resume from the pane when ready.`,
      );
      if (target.projectId) this.broadcast({ kind: "tasks_changed", projectId: target.projectId });
    }
  }
}
