import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_AUTO_RETRIES,
  DEFAULT_SERVER_PORT,
  newSessionId,
  WATCHDOG_SWEEP_MS,
} from "@daimon-os/shared";
import type { SystemPayload, Task } from "@daimon-os/shared";
import type { ConfigStore } from "../config/ConfigStore";
import type { AppLog } from "../gateway/AppLog";
import type { MemoryService } from "../memory/MemoryService";
import { FusionError, type FusionExecutionService } from "./FusionExecutionService";
import type { ProcessManager } from "./ProcessManager";
import { SpawnError } from "./ProcessManager";
import { tokensEqual } from "../security/auth";
import type { DurableExecutionStore } from "../durable/DurableExecutionStore";
import type { DurableRun } from "../durable/types";
import { WorktreeManager } from "../durable/WorktreeManager";
import { supportsAutomatedCostMetering } from "./CostTracker";
import type { ControlKernel } from "../control/ControlKernel";

/** How long the resident Lead must be QUIET (no PTY output) after all delegated
 *  work is done before the scheduler auto-settles its planning task. The grace
 *  lets the Lead print its summary / mark its own task done first, and avoids a
 *  premature settle while it's still creating a wave of tasks. */
const LEAD_SETTLE_GRACE_MS = 15_000;

/**
 * The orchestration gate. Tasks are first-class; the scheduler enforces the
 * dependency graph and concurrency cap, so independent tasks run in parallel
 * while dependents wait — the Lead authors the graph, the server runs it.
 *
 * Lifecycle: ready task (all deps done) → in_progress + auto-spawn the assigned
 * worker → worker exits → waiting_review → human approves → done → dependents
 * unblock → next wave. Review-gate on done; dispatch is autonomous.
 */
export class Scheduler {
  // per-project re-entrancy guard: evaluate() awaits spawns, so coalesce
  private evaluating = new Set<string>();
  private pending = new Set<string>();
  private watchdogTimer?: NodeJS.Timeout;
  private controlTimer?: NodeJS.Timeout;
  private lastLivenessCompactionAt = 0;
  /** Per-dispatch bearer, deliberately kept out of persisted task JSON. */
  private readonly completionCapabilities = new Map<
    string,
    { token: string; channel: string }
  >();
  /** Separate from review authority: one explicit input request per task/run,
   *  with exact-request retry support for an ambiguous HTTP response. */
  private readonly inputCapabilities = new Map<
    string,
    {
      token: string;
      channel: string;
      runId?: string;
      projectId: string;
      agentId: string;
      requestId: string;
      used: boolean;
      coordinationRequests: number;
      coordinationBytes: number;
      coordinationWindowStartedAt: number;
      coordinationWindowCount: number;
      grantId?: string;
    }
  >();

  constructor(
    private readonly store: ConfigStore,
    private readonly pm: ProcessManager,
    private readonly broadcast: (payload: SystemPayload) => void,
    private readonly appLog: AppLog,
    private readonly memory?: MemoryService,
    private readonly fusion?: FusionExecutionService,
    private readonly durable?: DurableExecutionStore,
    private readonly worktrees?: WorktreeManager,
    private readonly control?: ControlKernel,
  ) {}

  /** REST task create/update calls this; also the project Start flow. */
  onTasksChanged(projectId: string): void {
    void this.evaluate(projectId);
  }

  /** Recover persisted not-before wakeups and liveness leases. The durable DB is
   *  authoritative; the interval is only a local clock edge that re-evaluates
   *  due work after restart. */
  startControlLoop(): void {
    if (!this.control || this.controlTimer) return;
    const tick = () => {
      this.control!.expireLiveness();
      if (Date.now() - this.lastLivenessCompactionAt >= 60 * 60 * 1_000) {
        this.control!.compactLiveness();
        this.lastLivenessCompactionAt = Date.now();
      }
      for (const wakeup of this.control!.dueWakeups()) {
        this.control!.fireWakeup(wakeup.taskId);
        void this.evaluate(wakeup.projectId);
      }
    };
    tick();
    this.controlTimer = setInterval(tick, 1_000);
    this.controlTimer.unref();
  }

  stopControlLoop(): void {
    if (this.controlTimer) clearInterval(this.controlTimer);
    this.controlTimer = undefined;
  }

  /**
   * ProcessManager.onExitHook → a worker process exited.
   * - "completed" (clean) → DONE, auto-unblocking dependents (the normal path is
   *   actually the curl self-report → waiting_review; this covers a worker that
   *   does exit cleanly).
   * - "crashed" → auto-retry up to DEFAULT_MAX_AUTO_RETRIES (requeue to backlog
   *   with a short backoff), then FAILED.
   * - "timeout" / "killed" / "budget_exceeded" → FAILED immediately (no
   *   auto-retry: a timeout will just time out again, and a kill was deliberate).
   * FAILED is terminal until a human hits Retry. Nothing ever silently stalls.
   */
  onWorkerExit(channel: string, reason: string): void {
    const task = this.store.listTasks().find((t) => t.channel === channel);
    if (!task || task.status !== "in_progress") return;
    const exitingRun = this.durable?.getRunBySession(channel);
    if (exitingRun && this.control) {
      for (const grant of this.control.listCapabilityGrants(task.projectId).filter(
        (candidate) => candidate.subjectType === "run" && candidate.subjectId === exitingRun.id && !candidate.revokedAt,
      )) this.control.revokeCapabilityGrant(grant.parentGrantId ?? grant.id);
    }
    this.completionCapabilities.delete(task.id);
    this.inputCapabilities.delete(task.id);
    const now = new Date().toISOString();

    if (reason === "completed") {
      const saved = this.finishWaitingReview(task, channel);
      this.appLog.emit(
        "info",
        "scheduler",
        `task "${task.title}" → ${saved.status} (completed${this.durable ? ", evidence captured" : ""})`,
      );
      this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
      void this.evaluate(task.projectId);
      return;
    }

    this.finishFailedRun(channel, reason);

    const retries = task.retryCount ?? 0;
    if (reason === "crashed" && retries < DEFAULT_MAX_AUTO_RETRIES) {
      // requeue for auto-retry; runPass re-dispatches once a slot is free
      this.store.upsertTask({
        ...task,
        status: "backlog",
        channel: undefined,
        idle: false,
        retryCount: retries + 1,
        updatedAt: now,
      });
      this.appLog.emit(
        "warn",
        "scheduler",
        `task "${task.title}" crashed — auto-retry ${retries + 1}/${DEFAULT_MAX_AUTO_RETRIES}`,
      );
      this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
      // best-effort delay before re-dispatch to soften a crash-loop. NOTE: this is
      // not a hard backoff — an unrelated tasks_changed for this project can run
      // evaluate() sooner and pick the requeued task up first. unref'd so it can't
      // hold the process open. (DAIMON_RETRY_BACKOFF_MS lets tests shrink it.)
      const backoffMs = Number(process.env.DAIMON_RETRY_BACKOFF_MS) || 5_000;
      const t = setTimeout(() => void this.evaluate(task.projectId), backoffMs);
      t.unref();
      return;
    }

    this.store.upsertTask({ ...task, status: "failed", channel: undefined, idle: false, updatedAt: now });
    this.appLog.emit(
      "error",
      "scheduler",
      `task "${task.title}" → failed (${reason}${retries ? `, after ${retries} auto-retr${retries === 1 ? "y" : "ies"}` : ""})`,
    );
    this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
    // a freed slot may let a queued task run
    void this.evaluate(task.projectId);
  }

  /** Manual retry from the UI: requeue a FAILED task so the scheduler re-dispatches it.
   *  Resets retryCount so the human-triggered retry gets a fresh auto-retry budget
   *  (a manual retry means "try again from scratch", not "you've used your retries"). */
  retryTask(taskId: string): boolean {
    const task = this.store.listTasks().find((t) => t.id === taskId);
    if (!task || task.status !== "failed") return false;
    this.store.upsertTask({
      ...task,
      status: "backlog",
      channel: undefined,
      idle: false,
      retryCount: 0,
      updatedAt: new Date().toISOString(),
    });
    this.appLog.emit("info", "scheduler", `task "${task.title}" manually retried`);
    this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
    void this.evaluate(task.projectId);
    return true;
  }

  /** Validate and atomically consume the capability for the task's current dispatch. */
  consumeCompletionCapability(taskId: string, supplied: string): boolean {
    const capability = this.completionCapabilities.get(taskId);
    if (!capability || !tokensEqual(capability.token, supplied)) return false;
    this.completionCapabilities.delete(taskId);
    return true;
  }

  revokeCompletionCapabilities(taskIds: Iterable<string>): void {
    for (const taskId of taskIds) {
      this.completionCapabilities.delete(taskId);
      this.inputCapabilities.delete(taskId);
      this.control?.cancelWakeup(taskId);
    }
  }

  claimInputCapability(
    taskId: string,
    supplied: string,
    requestId: string,
  ):
    | {
        ok: true;
        replay: boolean;
        channel: string;
        runId?: string;
        release(): void;
      }
    | { ok: false } {
    const capability = this.inputCapabilities.get(taskId);
    if (
      !capability ||
      !tokensEqual(capability.token, supplied) ||
      capability.requestId !== requestId ||
      capability.used
    ) {
      // The sole permitted replay is the same token + server-issued request id.
      if (
        capability?.used &&
        tokensEqual(capability.token, supplied) &&
        capability.requestId === requestId
      ) {
        return { ok: true, replay: true, channel: capability.channel, runId: capability.runId, release() {} };
      }
      return { ok: false };
    }
    capability.used = true;
    let released = false;
    return {
      ok: true,
      replay: false,
      channel: capability.channel,
      runId: capability.runId,
      release: () => {
        if (released) return;
        released = true;
        const current = this.inputCapabilities.get(taskId);
        if (current === capability) current.used = false;
      },
    };
  }

  coordinationIdentity(
    taskId: string,
    supplied: string,
  ): { projectId: string; agentId: string; runId?: string; channel: string } | undefined {
    const capability = this.inputCapabilities.get(taskId);
    const task = this.store.listTasks().find((candidate) => candidate.id === taskId);
    const project = task ? this.store.getProject(task.projectId as Parameters<ConfigStore["getProject"]>[0]) : undefined;
    const team = project?.teamId
      ? this.store.listTeams().find((candidate) => candidate.id === project.teamId)
      : undefined;
    if (!capability || !tokensEqual(capability.token, supplied) || !this.pm.isLive(capability.channel) ||
        !task || task.status !== "in_progress" || task.channel !== capability.channel ||
        task.projectId !== capability.projectId || task.assignedAgentId !== capability.agentId ||
        !team?.memberAgentIds.includes(capability.agentId as Parameters<ConfigStore["getAgent"]>[0]) ||
        (capability.grantId !== undefined && !this.control?.isCapabilityGrantActive(capability.grantId))) {
      return undefined;
    }
    return {
      projectId: capability.projectId,
      agentId: capability.agentId,
      runId: capability.runId,
      channel: capability.channel,
    };
  }

  async revokeCapabilityGrantRuntime(id: string): Promise<ReturnType<ControlKernel["revokeCapabilityGrant"]>> {
    if (!this.control) throw new Error("control kernel is unavailable");
    const grantIds = new Set(this.control.listCapabilityGrantTree(id).map((grant) => grant.id));
    const channels = new Set<string>();
    for (const [taskId, capability] of this.inputCapabilities) {
      if (capability.grantId && grantIds.has(capability.grantId)) {
        channels.add(capability.channel);
        this.inputCapabilities.delete(taskId);
        this.completionCapabilities.delete(taskId);
      }
    }
    const revoked = this.control.revokeCapabilityGrant(id);
    await Promise.all([...channels].map((channel) => this.pm.close(channel, "killed")));
    return revoked;
  }

  async revokeWorkersOutsideTeam(projectId: string, allowedAgentIds: readonly string[]): Promise<void> {
    const allowed = new Set(allowedAgentIds);
    const channels = new Set<string>();
    const grants = new Set<string>();
    for (const [taskId, capability] of this.inputCapabilities) {
      if (capability.projectId === projectId && !allowed.has(capability.agentId)) {
        channels.add(capability.channel);
        if (capability.grantId) grants.add(capability.grantId);
        this.inputCapabilities.delete(taskId);
        this.completionCapabilities.delete(taskId);
      }
    }
    for (const grantId of grants) this.control?.revokeCapabilityGrant(grantId);
    await Promise.all([...channels].map((channel) => this.pm.close(channel, "killed")));
  }

  reserveCoordinationWrite(
    taskId: string,
    supplied: string,
    bytes: number,
  ):
    | { ok: true; identity: { projectId: string; agentId: string; runId?: string; channel: string }; release(): void }
    | { ok: false; statusCode: 403 | 409 | 429; error: string } {
    const identity = this.coordinationIdentity(taskId, supplied);
    const capability = this.inputCapabilities.get(taskId);
    if (!identity || !capability) {
      return { ok: false, statusCode: 403, error: "active worker coordination capability required" };
    }
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > 256 * 1024) {
      return { ok: false, statusCode: 409, error: "coordination write exceeds the per-request byte limit" };
    }
    const now = Date.now();
    if (now - capability.coordinationWindowStartedAt >= 60_000) {
      capability.coordinationWindowStartedAt = now;
      capability.coordinationWindowCount = 0;
    }
    if (capability.coordinationWindowCount >= 32) {
      return { ok: false, statusCode: 429, error: "worker coordination write rate exceeded" };
    }
    if (capability.coordinationRequests >= 256 || capability.coordinationBytes + bytes > 8 * 1024 * 1024) {
      return { ok: false, statusCode: 409, error: "worker coordination run budget exhausted" };
    }
    capability.coordinationWindowCount += 1;
    capability.coordinationRequests += 1;
    capability.coordinationBytes += bytes;
    let released = false;
    return {
      ok: true,
      identity,
      release: () => {
        if (released) return;
        released = true;
        capability.coordinationWindowCount = Math.max(0, capability.coordinationWindowCount - 1);
        capability.coordinationRequests = Math.max(0, capability.coordinationRequests - 1);
        capability.coordinationBytes = Math.max(0, capability.coordinationBytes - bytes);
      },
    };
  }

  /** Worker self-report path: capture immutable evidence before opening review. */
  submitForReview(taskId: string): Task {
    const task = this.store.listTasks().find((item) => item.id === taskId);
    if (!task || task.status !== "in_progress") throw new Error("task is not in progress");
    return this.finishWaitingReview(task, task.channel);
  }

  private finishWaitingReview(task: Task, channel?: string): Task {
    this.completionCapabilities.delete(task.id);
    this.inputCapabilities.delete(task.id);
    this.durable?.resolveAttentionForTask(task.id, "worker run submitted for review");
    if (!this.durable || !this.worktrees || !channel) {
      const autoApprove = this.store.agentAutoApprovesReview(task.assignedAgentId);
      return this.store.upsertTask({ ...task, status: autoApprove ? "done" : "waiting_review", channel: undefined, idle: false, updatedAt: new Date().toISOString() });
    }
    const run = this.durable.getRunBySession(channel);
    // Resident Leads/manual legacy sessions are intentionally not worker runs.
    if (!run) {
      const autoApprove = this.store.agentAutoApprovesReview(task.assignedAgentId);
      return this.store.upsertTask({ ...task, status: autoApprove ? "done" : "waiting_review", channel: undefined, idle: false, updatedAt: new Date().toISOString() });
    }
    try {
      const captured = this.worktrees.captureAndCleanup(run);
      this.durable.markWaitingReview(run.id, captured, this.metricsFor(channel));
      this.updateRunControlState(run.id, "waiting_review");
      if (this.control) {
        const request = this.control.createApproval({
          correlationId: `run-promotion:${run.id}:${captured.subjectHash}`,
          projectId: task.projectId,
          taskId: task.id,
          runId: run.id,
          kind: "run-promotion",
          subjectHash: captured.subjectHash,
          requestedBy: task.assignedAgentId ?? "scheduled-worker",
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        });
        if (!request.replay) {
          this.control.routeApproval({
            approvalId: request.approval.id,
            channel: "desktop",
            recipient: "local-operator",
            status: "delivered",
          });
        }
      }
      this.durable.openAttention({
        projectId: task.projectId, taskId: task.id, runId: run.id, kind: "waiting_review",
        message: `Review captured change ${captured.subjectHash.slice(0, 12)} before promotion.`,
      });
      return this.store.upsertTask({ ...task, status: "waiting_review", channel: undefined, idle: false, updatedAt: new Date().toISOString() });
    } catch (error) {
      const reason = `evidence capture failed: ${error instanceof Error ? error.message : String(error)}`;
      this.durable.markRunFailed(run.id, reason, this.metricsFor(channel));
      this.updateRunControlState(run.id, "failed");
      this.durable.openAttention({ projectId: task.projectId, taskId: task.id, runId: run.id, kind: "failed", message: reason });
      return this.store.upsertTask({ ...task, status: "failed", channel: undefined, idle: false, updatedAt: new Date().toISOString() });
    }
  }

  private finishFailedRun(channel: string, outcome: string): void {
    if (!this.durable || !this.worktrees) return;
    const run = this.durable.getRunBySession(channel);
    if (!run || run.completedAt) return;
    this.durable.resolveAttentionForTask(run.taskId, "worker run ended before an operator response was delivered");
    let reason = outcome;
    try {
      const captured = this.worktrees.captureAndCleanup(run);
      this.durable.updateRun(run.id, captured);
    } catch (error) {
      reason += `; evidence capture failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.durable.markRunFailed(run.id, reason, this.metricsFor(channel));
    this.updateRunControlState(run.id, "failed");
    this.durable.openAttention({ projectId: run.projectId, taskId: run.taskId, runId: run.id, kind: "failed", message: reason });
  }

  private metricsFor(channel: string): Record<string, number | string | boolean | null> {
    const session = this.pm.snapshot().find((item) => item.channel === channel)?.session;
    return session ? { ...session.metrics } : {};
  }

  private updateRunControlState(runId: string, status: string): void {
    if (!this.control) return;
    const state = this.control.getState(`run:${runId}`);
    if (!state) return;
    const latest = this.control.readStateLatest(state.id);
    const payload = latest.payload && typeof latest.payload === "object"
      ? { ...(latest.payload as Record<string, unknown>), status }
      : { status };
    this.control.updateState({ id: latest.id, expectedPayloadHash: latest.payloadHash, payload });
  }

  /** Test hook: run one idle-watchdog sweep synchronously (the production sweep
   *  runs on a WATCHDOG_SWEEP_MS interval). */
  tickWatchdog(): void {
    this.sweepIdle();
  }

  /** Start the idle-worker watchdog (surface-only: flags, never changes status). */
  startWatchdog(): void {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => this.sweepIdle(), WATCHDOG_SWEEP_MS);
    this.watchdogTimer.unref();
  }
  stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
  }

  /** Flag any in_progress worker silent past the idle threshold; un-flag if its
   *  output resumed. Surface-only — never moves the card (per the design choice). */
  private sweepIdle(): void {
    const cfg = this.store.getSettings().watchdog;
    if (!cfg?.enabled) return;
    const changed = new Set<string>();
    for (const task of this.store.listTasks()) {
      if (task.status !== "in_progress" || !task.channel) continue;
      const silent = this.pm.silentMsFor(task.channel);
      if (silent === undefined) continue; // not live — the exit hook owns this case
      const idle = silent > cfg.idleMs;
      if (idle && !task.idle) {
        this.store.upsertTask({ ...task, idle: true, updatedAt: new Date().toISOString() });
        this.appLog.emit(
          "warn",
          "watchdog",
          `"${task.title}" idle ${Math.round(silent / 1000)}s — the worker may have finished without reporting; check the pane or re-run its review command`,
        );
        changed.add(task.projectId);
      } else if (!idle && task.idle) {
        this.store.upsertTask({ ...task, idle: false, updatedAt: new Date().toISOString() });
        changed.add(task.projectId);
      }
    }
    for (const pid of changed) this.broadcast({ kind: "tasks_changed", projectId: pid });
  }

  private async evaluate(projectId: string): Promise<void> {
    if (this.evaluating.has(projectId)) {
      this.pending.add(projectId); // re-run once the in-flight pass finishes
      return;
    }
    this.evaluating.add(projectId);
    try {
      await this.runPass(projectId);
    } finally {
      this.evaluating.delete(projectId);
      if (this.pending.delete(projectId)) void this.evaluate(projectId);
    }
  }

  private async runPass(projectId: string): Promise<void> {
    const project = this.store.getProject(projectId as Parameters<ConfigStore["getProject"]>[0]);
    if (!project) return;
    const tasks = this.store.listTasks(projectId);
    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));

    if (this.control) {
      const byId = new Map(tasks.map((task) => [task.id, task]));
      for (const wakeup of this.control.listWakeups("scheduled").filter((item) => item.projectId === projectId)) {
        const task = byId.get(wakeup.taskId);
        if (!task || task.status !== "backlog" || !task.notBefore || task.notBefore !== wakeup.wakeAt) {
          this.control.cancelWakeup(wakeup.taskId);
        }
      }
    }

    // normalize readiness display: unmet deps → blocked; ready-but-waiting → backlog
    for (const t of tasks) {
      if (t.status !== "backlog" && t.status !== "blocked") continue;
      const ready = t.dependsOn.every((d) => done.has(d));
      const want: Task["status"] = ready ? "backlog" : "blocked";
      if (t.status !== want) {
        this.store.upsertTask({ ...t, status: want, updatedAt: new Date().toISOString() });
      }
    }

    const cap = this.store.getSettings().maxConcurrentSessions;
    const ready: Task[] = [];
    const now = new Date();
    // re-read after normalization and project ready work into the durable fair
    // scheduler. Future not-before tasks receive a persisted wake-up.
    for (const t of this.store.listTasks(projectId)) {
      if (t.status !== "backlog") continue;
      if (!t.dependsOn.every((d) => done.has(d))) continue; // not ready
      if (!t.assignedAgentId) {
        // ready but no assignee → never dispatches. Surface it instead of a
        // silent skip, so a Lead mis-assignment is visible in the Work Log.
        this.appLog.emit(
          "warn",
          "scheduler",
          `"${t.title}" is ready but has no assigned agent — it will not run until assigned`,
        );
        continue;
      }
      if (t.notBefore && Date.parse(t.notBefore) > now.getTime()) {
        this.control?.scheduleWakeup(projectId, t.id, t.notBefore);
        continue;
      }
      ready.push(t);
    }

    const available = Math.max(0, cap - this.pm.liveAgentCount());
    const selectedIds = this.control
      ? new Set(this.control.selectWork(projectId, ready.map((task) => ({
          taskId: task.id,
          lane: task.lane ?? "default",
          priority: task.priority ?? 0,
          createdAt: task.createdAt,
          notBefore: task.notBefore,
        })), available, now).map((candidate) => candidate.taskId))
      : new Set(ready.slice(0, available).map((task) => task.id));
    for (const task of ready) {
      if (!selectedIds.has(task.id)) {
        if (available === 0) {
          this.appLog.emit("info", "scheduler", `"${task.title}" queued — at concurrency cap (${cap})`);
        }
        continue;
      }
      const wakeup = this.control?.getWakeup(task.id);
      if (wakeup?.state === "scheduled") {
        if (Date.parse(wakeup.wakeAt) <= now.getTime()) this.control!.fireWakeup(task.id, now);
        else this.control!.cancelWakeup(task.id);
      }
      await this.dispatch(task, project.path);
    }

    this.maybeSettleLeadTask(projectId);
  }

  /**
   * Auto-settle the Lead's "Plan & delegate" task once every delegated subtask is
   * done. The Lead is resident and frequently forgets to mark its own task done
   * (or finishes its summary without doing so), leaving the Kanban card and the
   * agent pane stuck on "in progress" forever. This is the safety net.
   *
   * The planning task is the only one assigned to the team's supervisor (the Lead
   * never assigns subtasks to itself). We require ≥1 other task and ALL of them
   * "done" (waiting_review / failed keep the Lead in progress — work isn't truly
   * complete), and we wait for the Lead to go quiet so we don't settle mid-plan.
   * The task's channel is KEPT so its pane links to the now-done task and settles
   * (clock stops, badge → Done) while the resident Lead stays alive for follow-up.
   */
  private maybeSettleLeadTask(projectId: string): void {
    const project = this.store.getProject(projectId as Parameters<ConfigStore["getProject"]>[0]);
    if (!project?.teamId) return;
    const team = this.store.listTeams().find((t) => t.id === project.teamId);
    const leadId = team?.supervisorAgentId ?? team?.memberAgentIds[0];
    if (!leadId) return;
    const tasks = this.store.listTasks(projectId);
    const planning = tasks.find((t) => t.assignedAgentId === leadId && t.status === "in_progress");
    if (!planning) return;
    const others = tasks.filter((t) => t.id !== planning.id);
    if (others.length === 0 || !others.every((t) => t.status === "done")) return;

    // wait until the Lead has been quiet for the grace (undefined = process gone → settle now)
    const silentMs = planning.channel
      ? (this.pm.silentMsFor(planning.channel) ?? Infinity)
      : Infinity;
    if (silentMs < LEAD_SETTLE_GRACE_MS) {
      // nothing else re-triggers evaluate once tasks stop changing — re-check on a timer
      const t = setTimeout(
        () => void this.evaluate(projectId),
        LEAD_SETTLE_GRACE_MS - silentMs + 500,
      );
      t.unref();
      return;
    }
    this.store.upsertTask({ ...planning, status: "done", updatedAt: new Date().toISOString() });
    this.appLog.emit(
      "info",
      "scheduler",
      `Lead task "${planning.title}" → done (all delegated work complete)`,
    );
    this.broadcast({ kind: "tasks_changed", projectId });
  }

  /**
   * Worker prompt. Scheduled workers are one-shot provider processes: a clean
   * process exit is the provider-neutral completion signal. This keeps the
   * completion boundary inside ProcessManager instead of requiring a sandboxed
   * worker to reach the privileged loopback control plane.
   */
  private buildTaskPrompt(
    task: Task,
    inputCapability: string,
    inputRequestId: string,
    prefix?: string,
  ): string {
    const body = task.description ? `${task.title}\n\n${task.description}` : task.title;
    // DAIMON_PORT is the authoritative bound port — the desktop gateway binds an
    // OS-assigned free port and writes it back here (see desktop-entry.ts), so a
    // worker is told the REAL port. PORT/4040 are the dev/standalone fallbacks.
    // Reading process.env.PORT here sent workers to a dead 4040 in the packaged
    // app → curl connection-refused on self-report.
    const baseUrl = `http://127.0.0.1:${process.env.DAIMON_PORT ?? process.env.PORT ?? DEFAULT_SERVER_PORT}`;
    const inputCmd =
      "curl -s -X POST" +
      ` -H ${shellQuote(`X-Daimon-Input-Capability: ${inputCapability}`)}` +
      ` -H ${shellQuote("Content-Type: application/json")}` +
      ` --data ${shellQuote(JSON.stringify({
        requestId: inputRequestId,
        prompt: "REPLACE WITH THE SPECIFIC INFORMATION YOU NEED",
        options: [],
      }))}` +
      ` ${baseUrl}/api/tasks/${task.id}/input`;
    const coordinationHeader = shellQuote(`X-Daimon-Coordination-Capability: ${inputCapability}`);
    const coordinationBase = `${baseUrl}/api/tasks/${task.id}/coordination`;
    const coordinationCommands = [
      `List project peers: curl -s -H ${coordinationHeader} ${coordinationBase}/peers`,
      `Read peer messages: curl -s -H ${coordinationHeader} ${coordinationBase}/messages`,
      `Send a typed message: curl -s -X POST -H ${coordinationHeader} -H ${shellQuote("Content-Type: application/json")} --data ${shellQuote(JSON.stringify({
        idempotencyKey: "REPLACE-WITH-A-STABLE-UNIQUE-ID",
        kind: "finding",
        body: "REPLACE WITH THE BOUNDED MESSAGE",
      }))} ${coordinationBase}/messages`,
      `List owned artifacts: curl -s -H ${coordinationHeader} ${coordinationBase}/artifacts`,
    ].join("\n    ");
    // best-effort centralized-memory injection: a labeled "Relevant Memory" block
    // is prepended when memory + retrieval are enabled. It must NEVER throw — a
    // memory hiccup must not block dispatching the worker.
    let memoryBlock = "";
    try {
      memoryBlock =
        this.memory?.retrieve({
          projectId: task.projectId,
          agentId: task.assignedAgentId,
          taskTitle: task.title,
        }) ?? "";
    } catch {
      memoryBlock = "";
    }
    return [
      // Fusion synthesis (when present) leads the prompt so the worker sees the
      // panel/judge analysis before anything else
      ...(prefix ? [prefix.trimEnd()] : []),
      ...(memoryBlock ? [memoryBlock.trimEnd()] : []),
      `Task: ${body}`,
      "Do the work now. Write any deliverables to files in this project folder so the next agent can use them.",
      `If and only if essential operator information is missing, make one explicit input request by running the command below after replacing the prompt and optional choices in its JSON body. This opens the durable input inbox without submitting your work for review. Do not use waiting_tool telemetry as an input-request signal. Reuse the exact requestId if the HTTP response is lost:\n\n    ${inputCmd}`,
      `For structured coordination with project peers, use the scoped, run-lifetime endpoints below. Messages are typed and idempotent; shared artifacts are versioned and reject stale writes. Do not place secrets in messages or artifacts.\n\n    ${coordinationCommands}`,
      "When you have finished a complete pass, verify the bounded deliverables, give a one-paragraph summary of what you did and where they are, then exit normally. Do not remain at an interactive prompt.",
      "A clean process exit ends this isolated run. The gateway removes runtime-only files, captures the exact Git diff as evidence, and requires a new attempt for follow-up changes.",
    ].join("\n\n");
  }

  /**
   * Run the Fusion deliberation for a task's assigned agent, if enabled. Returns:
   *  - undefined: no Fusion (disabled) OR fail-open ran normally with no prefix
   *  - string:    the Fusion context to PREPEND to the worker's prompt
   *  - "task_failed": Fusion was required (failOpen=false) but invalid/failed —
   *                   the task has been marked failed + broadcast; caller returns.
   * Never throws — Fusion must never crash dispatch.
   */
  private async maybeRunFusion(task: Task, cwd: string): Promise<string | undefined | "task_failed"> {
    const agent = task.assignedAgentId ? this.store.getAgent(task.assignedAgentId) : undefined;
    if (!agent?.fusionEnabled || !agent.fusionConfig || !this.fusion) return undefined;

    const config = agent.fusionConfig;
    const failOpen = config.failOpen;

    // validate first so an invalid config is a fast, typed decision (no headless spawns)
    const errors = this.store.validateFusionConfig(agent.id, config);
    if (errors.length) {
      if (failOpen) {
        this.appLog.emit(
          "warn",
          "fusion",
          `invalid_fusion_config for "${agent.name}" — running normally (fail_open): ${errors.join("; ")}`,
        );
        return undefined;
      }
      this.failTask(task, `Fusion config invalid: ${errors.join("; ")}`);
      return "task_failed";
    }

    const project = this.store.getProject(task.projectId as Parameters<ConfigStore["getProject"]>[0]);
    try {
      const result = await this.fusion.runFusionForAgentInvocation({
        invokedAgent: agent,
        task: task.description ? `${task.title}\n\n${task.description}` : task.title,
        teamId: project?.teamId,
        projectId: task.projectId,
        teamLeaderAgentId: this.store
          .listTeams()
          .find((t) => t.id === project?.teamId)?.supervisorAgentId,
        cwd,
      });
      return result.fusionContextForInvokedAgent;
    } catch (err) {
      const reason = err instanceof FusionError ? err.reason : "unexpected_error";
      if (failOpen) {
        this.appLog.emit(
          "warn",
          "fusion",
          `Fusion failed for "${task.title}" (${reason}) — running normally (fail_open): ${err instanceof Error ? err.message : String(err)}`,
        );
        return undefined;
      }
      this.failTask(task, `Fusion failed (${reason}): ${err instanceof Error ? err.message : String(err)}`);
      return "task_failed";
    }
  }

  /** Mark a task failed with a clear message + broadcast (shared by Fusion fail-closed). */
  private failTask(task: Task, message: string, source: "fusion" | "budget" = "fusion"): void {
    this.store.upsertTask({
      ...task,
      status: "failed",
      channel: undefined,
      idle: false,
      updatedAt: new Date().toISOString(),
    });
    this.appLog.emit("error", source, `task "${task.title}" failed: ${message}`);
    this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
  }

  private async dispatch(task: Task, cwd: string): Promise<void> {
    const agent = task.assignedAgentId ? this.store.getAgent(task.assignedAgentId) : undefined;
    const provider = agent ? this.store.getProvider(agent.providerId) : undefined;
    const project = this.store.getProject(task.projectId as Parameters<ConfigStore["getProject"]>[0]);
    const budgetConfigured = project?.budgetUsd !== undefined || agent?.limits.maxCostUsd !== undefined;
    if (agent && budgetConfigured && !supportsAutomatedCostMetering(agent, provider)) {
      this.failTask(
        task,
        `automated ${provider?.kind ?? "unknown"} dispatch is blocked because a budget is configured but this runtime has no enforceable cost meter`,
        "budget",
      );
      return;
    }
    const channel = newSessionId() as string;
    let run: DurableRun | undefined;
    let workerCwd = cwd;
    if (this.durable && this.worktrees) {
      const runId = randomUUID();
      const attempt = this.durable.nextAttempt(task.id);
      try {
        const prepared = this.worktrees.prepare(cwd, task.id, runId);
        workerCwd = prepared.path;
        run = this.durable.createRun({
          id: runId, taskId: task.id, projectId: task.projectId, sessionId: channel,
          attempt, status: "preparing", canonicalRoot: prepared.canonicalRoot,
          worktreePath: prepared.path, worktreeBranch: prepared.branch, baseHead: prepared.baseHead,
          parentSubjectHash: prepared.parentSubjectHash,
        });
        this.durable.resolveAttentionForTask(task.id, "a new isolated attempt started");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const blocked = this.durable.createRun({
          id: runId, taskId: task.id, projectId: task.projectId, attempt,
          status: "blocked", canonicalRoot: cwd, completedAt: new Date().toISOString(), outcome: reason,
        });
        this.durable.appendEvent(`run:${blocked.id}`, "run.blocked", { runId: blocked.id, reason });
        this.durable.openAttention({ projectId: task.projectId, taskId: task.id, runId: blocked.id, kind: "policy_blocked", message: reason });
        this.store.upsertTask({ ...task, status: "failed", channel: undefined, idle: false, updatedAt: new Date().toISOString() });
        this.appLog.emit("error", "scheduler", `blocked "${task.title}": ${reason}`);
        this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
        return;
      }
    }
    // --- Fusion hook: BEFORE spawning the invoked worker, if the assigned agent
    // has Fusion enabled, run the panel+judge deliberation and prepend the
    // synthesis to the worker's prompt. Fusion must NEVER crash dispatch; on any
    // failure it honors failOpen (true → run normally + log; false → fail task).
    // Guarded so Fusion runs at most once per task (it returns a prefix synchronously
    // here, the worker is then spawned exactly once). Panel/judge are headless.
    const fusionOutcome = await this.maybeRunFusion(task, workerCwd);
    if (fusionOutcome === "task_failed") {
      if (run) this.finishFailedRun(channel, "fusion_failed");
      return;
    }
    const fusionPrefix = fusionOutcome; // undefined | string (the injected context)
    const completionCapability = randomBytes(32).toString("base64url");
    const inputCapability = randomBytes(32).toString("base64url");
    const inputRequestId = randomUUID();
    this.completionCapabilities.set(task.id, { token: completionCapability, channel });
    this.inputCapabilities.set(task.id, {
      token: inputCapability,
      channel,
      runId: run?.id,
      projectId: task.projectId,
      agentId: task.assignedAgentId!,
      requestId: inputRequestId,
      used: false,
      coordinationRequests: 0,
      coordinationBytes: 0,
      coordinationWindowStartedAt: Date.now(),
      coordinationWindowCount: 0,
    });

    try {
      const taskPrompt = this.buildTaskPrompt(
        task,
        inputCapability,
        inputRequestId,
        fusionPrefix,
      );
      if (run && this.durable && this.control && agent) {
        this.control.registerStateSchema("run-state", 1, {
          required: ["runId", "taskId", "attempt", "status"],
          status: ["preparing", "running", "waiting_review", "approved", "promoting", "promoted", "failed", "blocked"],
        });
        this.control.registerStateSchema("run-state", 2, {
          required: ["runId", "taskId", "attempt", "status", "policyVersion"],
          status: ["preparing", "running", "waiting_review", "approved", "promoting", "promoted", "failed", "blocked"],
        });
        this.control.registerStateMigration("run-state", 1, 2, "add-policy-version", (payload) => ({
          ...(payload && typeof payload === "object" ? payload as Record<string, unknown> : {}),
          policyVersion: 1,
        }));
        this.control.putState({
          id: `run:${run.id}`,
          ownerType: "run",
          ownerId: run.id,
          schemaName: "run-state",
          schemaVersion: 2,
          payload: {
            runId: run.id,
            taskId: task.id,
            attempt: run.attempt,
            status: run.status,
            baseHead: run.baseHead,
            policyVersion: 1,
          },
        });
        const projectSecrets = new Set(project?.secretIds ?? []);
        const grantedSecrets = (agent.secretIds ?? []).filter((id) => projectSecrets.has(id));
        const network = provider?.kind === "ollama" || provider?.kind === "lmstudio"
          ? "loopback" as const
          : !provider
            ? "none" as const
            : "unrestricted" as const;
        const expiresAt = new Date(Date.now() + Math.max(60_000, Math.min(
          agent.limits.maxRuntimeMs ?? 24 * 60 * 60 * 1_000,
          24 * 60 * 60 * 1_000,
        ))).toISOString();
        const scope = {
          tools: [
            ...agent.tools.filter((tool) => tool.enabled).map((tool) => tool.name),
            "daimon:request_input",
            "daimon:coordination",
          ],
          secrets: grantedSecrets,
          paths: [workerCwd],
          network,
        };
        const parentGrant = this.control.issueCapabilityGrant({
          projectId: task.projectId,
          subjectType: "agent",
          subjectId: agent.id,
          scope,
          issuedBy: "human-local",
          expiresAt,
        });
        const grant = this.control.issueCapabilityGrant({
          parentGrantId: parentGrant.id,
          projectId: task.projectId,
          subjectType: "run",
          subjectId: run.id,
          scope,
          issuedBy: "daimon",
          expiresAt,
        });
        const runtimeCapability = this.inputCapabilities.get(task.id);
        if (runtimeCapability) runtimeCapability.grantId = grant.id;
        const reviewablePrompt = taskPrompt.replaceAll(inputCapability, "[REDACTED-RUNTIME-CAPABILITY]");
        const instruction = this.durable.putArtifact(reviewablePrompt, "delegation-instruction", "text/plain", {
          projectId: task.projectId,
          taskId: task.id,
          runId: run.id,
          childAgentId: agent.id,
        });
        const team = project?.teamId
          ? this.store.listTeams().find((candidate) => candidate.id === project.teamId)
          : undefined;
        const policy = {
          permissionMode: agent.permissionMode ?? "supervised",
          isolation: agent.isolation,
          tools: [
            ...agent.tools.filter((tool) => tool.enabled).map((tool) => tool.name),
            "daimon:request_input",
            "daimon:coordination",
          ].sort(),
          secrets: grantedSecrets.slice().sort(),
          limits: agent.limits,
          providerKind: provider?.kind ?? "unknown",
          model: agent.model ?? provider?.defaultModel,
        };
        this.control.recordDelegation({
          projectId: task.projectId,
          taskId: task.id,
          runId: run.id,
          parentAgentId: team?.supervisorAgentId,
          childAgentId: agent.id,
          providerKind: provider?.kind ?? "unknown",
          model: agent.model ?? provider?.defaultModel,
          instructionHash: createHash("sha256").update(taskPrompt).digest("hex"),
          instructionArtifactHash: instruction.sha256,
          policyHash: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
          capabilityGrantId: grant.id,
        });
      }
      const session = await this.pm.spawn({
        reqId: channel,
        kind: "agent",
        agentId: task.assignedAgentId,
        channel,
        cols: 100,
        rows: 30,
        cwd: workerCwd,
        projectId: task.projectId,
        // Scheduled delivery is terminal: provider exit is the completion signal,
        // then durable evidence capture and human review own follow-up. Manual
        // panes remain interactive through the explicit spawn flow.
        oneShot: true,
        taskPrompt,
      });
      this.store.upsertTask({
        ...task,
        status: "in_progress",
        channel,
        idle: false, // fresh run — clear any stale idle flag from a prior attempt
        costUsd: 0, // fresh run = fresh transcript; don't carry the prior attempt's
        //            cost (else a retry double-counts against the project budget)
        updatedAt: new Date().toISOString(),
      });
      if (run && this.durable) {
        this.durable.updateRun(run.id, { sessionId: channel, status: "running" });
        this.updateRunControlState(run.id, "running");
      }
      this.appLog.emit("info", "scheduler", `dispatched "${task.title}" → ${session.agentName}`);
      this.broadcast({ kind: "session_started", session });
      this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
    } catch (err) {
      this.completionCapabilities.delete(task.id);
      this.inputCapabilities.delete(task.id);
      // LIMIT_EXCEEDED is a transient capacity wait, NOT a failure — leave the
      // task in backlog (we never moved it to in_progress) so the next pass
      // re-dispatches it once a slot frees. Marking it failed here would turn a
      // benign "all slots busy" into a terminal error (e.g. when a paused sibling
      // briefly skews the count).
      if (err instanceof SpawnError && err.code === "LIMIT_EXCEEDED") {
        if (run) this.finishFailedRun(channel, "capacity_wait");
        this.appLog.emit("info", "scheduler", `"${task.title}" queued — ${err.message}`);
        return;
      }
      if (run) this.finishFailedRun(channel, `spawn_failed: ${err instanceof Error ? err.message : String(err)}`);
      // a real spawn failure (bad command, etc.) → FAILED instead of leaving it
      // in backlog, otherwise the next evaluate() re-dispatches it forever (a
      // spawn-fail loop). It surfaces with a Retry button.
      this.store.upsertTask({
        ...task,
        status: "failed",
        channel: undefined,
        idle: false,
        updatedAt: new Date().toISOString(),
      });
      this.appLog.emit(
        "error",
        "scheduler",
        `failed to dispatch "${task.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
      this.broadcast({ kind: "tasks_changed", projectId: task.projectId });
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
