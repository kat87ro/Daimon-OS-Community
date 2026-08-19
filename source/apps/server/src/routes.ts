import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agentDefinitionSchema,
  blueprintSchema,
  fusionConfigSchema,
  goalSchema,
  mcpServerSchema,
  memorySettingsSchema,
  memoryTypeSchema,
  memoryWriteRequestSchema,
  newAgentId,
  type ModelInfo,
  orchestratorSettingsSchema,
  projectSchema,
  providerConfigSchema,
  providerKindSchema,
  providerModeSchema,
  scheduleSchema,
  secretSchema,
  skillSchema,
  spawnRequestSchema,
  taskSchema,
  taskInputRequestSchema,
  taskInputResponseSchema,
  teamSchema,
  PROVIDER_PRESETS,
} from "@daimon-os/shared";
import type {
  AgentId,
  BlueprintId,
  ProjectId,
  ProviderId,
  ProviderKind,
  ScheduleId,
  SecretId,
  SystemPayload,
  TeamId,
} from "@daimon-os/shared";
import { sanitizeSlug, type ConfigStore } from "./config/ConfigStore";
import type { AppLog } from "./gateway/AppLog";
import { readImportFile, scanProviderHome } from "./config/importScan";
import { cloneSkillToProviders } from "./config/skillClone";
import type { CostTracker } from "./process/CostTracker";
import type { MemoryService } from "./memory/MemoryService";
import type { ProcessManager } from "./process/ProcessManager";
import type { Scheduler } from "./process/Scheduler";
import type { Triggers } from "./process/Triggers";
import { instantiateBlueprint } from "./process/blueprint";
import { buildLeadSpawn } from "./process/lead";
import { KIND_CMD, resolveProviderExecutable } from "./runners/CliRunner";
import { validateOutboundUrl } from "./security/outboundUrl";
import { approveProjectRoot, resolveProjectFile } from "./security/projectPaths";
import type { NativeActionAccess, OrchestrationAccess } from "./security/auth";
import { ORCHESTRATION_INPUT_LIMITS, bearerToken, tokensEqual } from "./security/auth";
import type { DurableExecutionStore } from "./durable/DurableExecutionStore";
import type { ControlKernel } from "./control/ControlKernel";
import type { AuditStore, AuditRecordInput } from "./audit/AuditStore";
import { PromotionStateUncertainError, WorktreePolicyError, type WorktreeManager } from "./durable/WorktreeManager";
import { GitBusyError, GitTimeoutError, type GitHubRemoteAdmin, type GitReadService } from "./git";
import type { GitHubService } from "./github/GitHubService";
import {
  assertCreatableTaskStatus,
  clientTaskUpdate,
  isClientTaskTransitionAllowed,
  isScopedTaskTransitionAllowed,
} from "./process/taskTransitions";
import { trustedMcpCapability } from "./runners/CliRunner";
import {
  discoverCodexModels,
  providerDefaultCatalog,
  type ModelDiscoveryResult,
} from "./providers/modelDiscovery";

/** Setup-wizard connectivity test for a provider draft (pre-save). CLI mode
 *  checks the binary resolves on the gateway's PATH (the same PATH a spawned
 *  agent would see); API mode pings the configured endpoint. */
const providerTestSchema = z.object({
  kind: providerKindSchema,
  mode: providerModeSchema,
  cliCommand: z.string().optional(),
  baseUrl: z.string().optional(),
  apiFormat: z.enum(["openai", "anthropic", "gemini"]).optional(),
  apiKey: z.string().optional(),
});

/** Resolve + run `<cli> --version` to confirm the provider's CLI is installed
 *  and reachable. Returns a short human detail line. */
function testCliProvider(command: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = execFile(command, ["--version"], { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        const why = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? `'${command}' not found on PATH — install it (and ensure it's logged in)`
          : `'${command} --version' failed: ${(stderr || err.message).trim().slice(0, 160)}`;
        resolve({ ok: false, detail: why });
        return;
      }
      resolve({ ok: true, detail: `${command} found: ${(stdout || stderr).trim().slice(0, 120) || "ok"}` });
    });
    child.on("error", () => resolve({ ok: false, detail: `could not launch '${command}'` }));
  });
}

const providerUpsertSchema = z.object({
  provider: providerConfigSchema,
  /** Raw key, write-only: stored in the secrets file, returned masked. */
  apiKey: z.string().min(1).optional(),
});

const secretUpsertSchema = z.object({
  secret: secretSchema,
  /** Raw value, write-only: sealed in the encrypted vault, returned masked.
   *  Omit to edit metadata (key/label/group) without changing the stored value. */
  value: z.string().min(1).optional(),
});
const LAUNCH_CLI_KINDS = new Set<ProviderKind>([
  "claude", "gemini", "codex", "ollama", "lmstudio",
]);
const LOCAL_PROVIDER_KINDS = new Set<ProviderKind>(["ollama", "lmstudio"]);
const LOCAL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/;
const LOCAL_MODEL_RESPONSE_LIMIT = 512 * 1024;

function isLocalProviderKind(kind: ProviderKind): kind is "ollama" | "lmstudio" {
  return LOCAL_PROVIDER_KINDS.has(kind);
}

async function localProviderBaseUrl(
  kind: "ollama" | "lmstudio",
  raw?: string,
): Promise<URL> {
  const expectedRaw = PROVIDER_PRESETS[kind].baseUrl!;
  const candidate = new URL((raw?.trim() || expectedRaw).replace(/\/+$/, ""));
  const expected = new URL(expectedRaw);
  if (candidate.search || candidate.hash || candidate.username || candidate.password) {
    throw new Error("local provider URL cannot contain credentials, a query, or a fragment");
  }
  const normalizedPath = candidate.pathname.replace(/\/+$/, "") || "/";
  const expectedPath = expected.pathname.replace(/\/+$/, "") || "/";
  if (candidate.origin !== expected.origin || normalizedPath !== expectedPath) {
    throw new Error(
      `${PROVIDER_PRESETS[kind].label} is restricted to ${expectedRaw}; arbitrary network endpoints are not local providers`,
    );
  }
  return validateOutboundUrl(candidate.toString(), { requireLoopback: true });
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > LOCAL_MODEL_RESPONSE_LIMIT) throw new Error("model catalog response is too large");
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > LOCAL_MODEL_RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("model catalog response is too large");
    }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(body);
}

export async function probeLocalProvider(
  kind: "ollama" | "lmstudio",
  rawBaseUrl?: string,
): Promise<{ ok: boolean; detail: string; models: string[] }> {
  const base = await localProviderBaseUrl(kind, rawBaseUrl);
  const endpoint = kind === "ollama"
    ? new URL("/api/tags", base.origin)
    : new URL(`${base.pathname.replace(/\/$/, "")}/models`, base.origin);
  const response = await fetch(endpoint, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    return { ok: false, detail: `${PROVIDER_PRESETS[kind].label} returned HTTP ${response.status}`, models: [] };
  }
  const parsed = await boundedJson(response) as {
    models?: Array<{ name?: unknown; model?: unknown; capabilities?: unknown }>;
    data?: Array<{ id?: unknown }>;
  };
  const entries = kind === "ollama"
    ? (parsed?.models ?? []).map((entry) => ({
        id: typeof entry.model === "string" ? entry.model : entry.name,
        capabilities: Array.isArray(entry.capabilities) ? entry.capabilities : undefined,
      }))
    : (parsed?.data ?? []).map((entry) => ({ id: entry.id, capabilities: undefined }));
  const candidates = entries.filter((entry): entry is { id: string; capabilities: unknown[] | undefined } =>
    typeof entry.id === "string" && LOCAL_MODEL_ID.test(entry.id) && !entry.id.toLowerCase().endsWith(":cloud"));
  const toolCapable = candidates.filter((entry) =>
    !entry.capabilities || entry.capabilities.includes("tools"));
  const models = [...new Set(toolCapable.map((entry) => entry.id))].sort();
  const excluded = candidates.length - models.length;
  const detail = models.length > 0
    ? `${PROVIDER_PRESETS[kind].label} reachable; found ${models.length} local model${models.length === 1 ? "" : "s"}${excluded ? ` (${excluded} without tool support excluded)` : ""}.`
    : `${PROVIDER_PRESETS[kind].label} is reachable, but no local tool-capable model was found.`;
  return { ok: models.length > 0, detail, models };
}

function localModelInfo(ids: string[]): ModelInfo[] {
  return ids.map((id) => ({ id, label: id }));
}

async function discoverProviderModels(
  kind: ProviderKind,
  command: string,
  baseUrl?: string,
): Promise<ModelDiscoveryResult> {
  if (kind === "codex") return discoverCodexModels(command);
  if (kind === "claude" || kind === "gemini") return providerDefaultCatalog(kind);
  if (isLocalProviderKind(kind)) {
    try {
      const result = await probeLocalProvider(kind, baseUrl);
      return {
        ...result,
        models: localModelInfo(result.models),
        source: "provider-api",
      };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "local model engine is unavailable",
        models: [],
        source: "provider-api",
      };
    }
  }
  return {
    ok: false,
    detail: `provider kind '${kind}' has no model discovery adapter`,
    models: [],
    source: "provider-default",
  };
}

export function registerRoutes(
  app: FastifyInstance,
  store: ConfigStore,
  pm: ProcessManager,
  appLog: AppLog,
  scheduler: Scheduler,
  triggers: Triggers,
  costTracker: CostTracker,
  memory: MemoryService,
  orchestrationAccess: OrchestrationAccess,
  nativeActionAccess: NativeActionAccess,
  durable: DurableExecutionStore,
  control: ControlKernel,
  audit: AuditStore,
  worktrees: WorktreeManager,
  git: GitReadService,
  gitAdmin: GitHubRemoteAdmin,
  github: GitHubService,
  broadcast: (payload: SystemPayload) => void,
): void {
  // Desktop renderer callers may only register a new filesystem root after the
  // operator selected that exact canonical directory in the native picker. The
  // one-time in-memory capability prevents a compromised renderer from silently
  // turning an arbitrary known account directory into a readable project.
  const projectPathApprovals = new Map<string, { path: string; expiresAt: number }>();
  let folderPickerActive = false;
  const isRendererRequest = (authorization: string | string[] | undefined): boolean => {
    const token = process.env.DAIMON_RENDERER_TOKEN?.trim();
    return Boolean(token && tokensEqual(token, bearerToken(authorization)));
  };
  const auditActorFor = (authorization: string | string[] | undefined): AuditRecordInput["actor"] => {
    if (isRendererRequest(authorization)) return "renderer";
    if (orchestrationAccess.grantFor(bearerToken(authorization))) return "lead";
    return "operator";
  };
  const auditRequest = (
    authorization: string | string[] | undefined,
    entry: Omit<AuditRecordInput, "actor">,
  ): void => {
    audit.record({ ...entry, actor: auditActorFor(authorization) });
  };
  // Failed calls are security evidence, but unauthenticated callers must not be
  // able to turn synchronous SQLite durability into an I/O amplification path.
  // Keep representative evidence plus a suppressed count, capped at five writes
  // per second for this low-value failure stream. Successful mutations remain
  // fully recorded by their route handlers.
  const FAILED_AUDIT_WINDOW_MS = 1_000;
  const MAX_FAILED_AUDIT_WRITES_PER_WINDOW = 5;
  let failedAuditWindowStartedAt = 0;
  let failedAuditWrites = 0;
  let failedAuditSuppressed = 0;
  app.addHook("onResponse", async (req, reply) => {
    if (
      !["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ||
      reply.statusCode < 400 ||
      !(req.raw.url ?? "").startsWith("/api/")
    ) return;
    const now = Date.now();
    if (now - failedAuditWindowStartedAt >= FAILED_AUDIT_WINDOW_MS) {
      failedAuditWindowStartedAt = now;
      failedAuditWrites = 0;
    }
    if (failedAuditWrites >= MAX_FAILED_AUDIT_WRITES_PER_WINDOW) {
      failedAuditSuppressed += 1;
      return;
    }
    failedAuditWrites += 1;
    const pathname = (req.raw.url ?? "").split("?", 1)[0] ?? "/api/unknown";
    auditRequest(req.headers.authorization, {
      category: "security",
      action: reply.statusCode === 401 || reply.statusCode === 403 ? "request.denied" : "request.failed",
      outcome: reply.statusCode >= 500 ? "failure" : "warning",
      entityType: "http_request",
      entityId: pathname,
      summary: `${req.method} ${pathname} returned HTTP ${reply.statusCode}`,
      metadata: {
        statusCode: reply.statusCode,
        ...(failedAuditSuppressed > 0 ? { suppressedSinceLastRecord: failedAuditSuppressed } : {}),
      },
    });
    failedAuditSuppressed = 0;
  });
  const consumePathApproval = (candidate: string, supplied: unknown): boolean => {
    if (typeof supplied !== "string") return false;
    const approval = projectPathApprovals.get(supplied);
    projectPathApprovals.delete(supplied);
    return Boolean(approval && approval.expiresAt >= Date.now() && approval.path === candidate);
  };
  const subjectHash = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  app.get("/api/health", async () => ({ ok: true, sessions: pm.size }));

  app.post("/api/admin/native-action", async (req, reply) => {
    const body = z.object({
      action: z.enum(["spawn", "start-project", "configure-github"]),
      subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    return nativeActionAccess.issue(body.data.action, body.data.subjectHash);
  });

  // Electron main owns the admin bearer and calls this only after an OS-native
  // confirmation for the exact request. The resulting pane is renderer-visible
  // and renderer-controllable, but the renderer cannot call this route or mint
  // a different process request with its scoped bearer.
  app.post("/api/admin/spawn", async (req, reply) => {
    const body = spawnRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!nativeActionAccess.consume(
      req.headers["x-daimon-native-action"] as string | undefined,
      "spawn",
      subjectHash(body.data),
    )) {
      return reply.code(403).send({ error: "a current one-time native launch confirmation is required" });
    }
    if (body.data.overrides?.env || body.data.overrides?.providerId) {
      return reply.code(400).send({ error: "native launch accepts only a model override" });
    }
    try {
      const session = await pm.spawn(body.data, undefined, "renderer");
      broadcast({ kind: "session_started", session });
      if (body.data.kind === "chat") {
        auditRequest(req.headers.authorization, {
          category: "work",
          action: "chat.started",
          entityType: "session",
          entityId: session.id,
          summary: `Ad-hoc chat started with "${session.agentName}"`,
          metadata: {
            providerId: body.data.providerId,
            model: body.data.model ?? "provider-native-default",
          },
        });
      }
      return session;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "failed to launch session" });
    }
  });

  // --- tasks ---
  app.get<{ Querystring: { projectId?: string } }>("/api/tasks", async (req) =>
    store.listTasks(req.query.projectId),
  );
  const orchestrationTaskSchema = z.object({
    projectId: z.string().uuid(),
    title: z.string().min(1).max(4_096),
    description: z.string().max(256 * 1024).optional(),
    assignedAgentName: z.string().min(1).max(512),
    dependsOn: z.array(z.string().uuid()).max(256).default([]),
    lane: taskSchema.shape.lane,
    priority: taskSchema.shape.priority,
    notBefore: taskSchema.shape.notBefore,
    parentTaskId: z.string().uuid().optional(),
  }).strict();
  app.post("/api/orchestration/tasks", async (req, reply) => {
    const grant = orchestrationAccess.grantFor(bearerToken(req.headers.authorization));
    if (!grant) return reply.code(403).send({ error: "a scoped orchestration credential is required" });
    const body = orchestrationTaskSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (body.data.projectId !== grant.projectId) {
      return reply.code(403).send({ error: "orchestration credential is out of project scope" });
    }
    const project = store.getProject(grant.projectId as ProjectId);
    const teamId = grant.teamId ?? project?.teamId;
    const team = teamId ? store.listTeams().find((item) => item.id === teamId) : undefined;
    if (!project || !team || project.teamId !== team.id) {
      return reply.code(409).send({ error: "project team is unavailable" });
    }
    const memberAgents = team.memberAgentIds
      .map((id) => store.getAgent(id))
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const agent = memberAgents.find((item) => item.name === body.data.assignedAgentName) ??
      memberAgents.find((item) => item.name.toLowerCase() === body.data.assignedAgentName.toLowerCase());
    if (!agent) return reply.code(400).send({ error: "assigned agent is not a member of the project team" });
    if (body.data.parentTaskId) {
      const parent = store.getTask(body.data.parentTaskId);
      if (!parent || parent.projectId !== project.id) {
        return reply.code(400).send({ error: "parent task must belong to the same project" });
      }
    }
    const now = new Date().toISOString();
    const activeTasks = store.listTasks(project.id).filter(
      (task) => task.status !== "done" && task.status !== "failed",
    );
    const taskBytes = (title: string, description?: string): number =>
      Buffer.byteLength(title, "utf8") + Buffer.byteLength(description ?? "", "utf8");
    const admission = orchestrationAccess.admitTaskCreation(grant, {
      activeTaskCount: activeTasks.length,
      activeTaskBytes: activeTasks.reduce(
        (sum, task) => sum + taskBytes(task.title, task.description),
        0,
      ),
      newTaskBytes: taskBytes(body.data.title, body.data.description),
    });
    if (!admission.ok) {
      return reply.code(admission.statusCode).send({ error: admission.error });
    }
    try {
      const saved = store.upsertTask(taskSchema.parse({
        id: crypto.randomUUID(), projectId: project.id, title: body.data.title,
        description: body.data.description, assignedAgentId: agent.id,
        assignedAgentName: agent.name, status: body.data.dependsOn.length ? "blocked" : "backlog",
        dependsOn: body.data.dependsOn, lane: body.data.lane, priority: body.data.priority,
        notBefore: body.data.notBefore, parentTaskId: body.data.parentTaskId,
        createdBy: "lead", createdAt: now, updatedAt: now,
      }));
      appLog.emit("info", "task", `Lead created task "${saved.title}" for ${agent.name}`);
      auditRequest(req.headers.authorization, {
        category: "work", action: "task.created", projectId: saved.projectId,
        entityType: "task", entityId: saved.id, summary: `Lead created task "${saved.title}" for ${agent.name}`,
        metadata: { assignedAgentId: agent.id, dependencyCount: saved.dependsOn.length },
      });
      scheduler.onTasksChanged(saved.projectId);
      return saved;
    } catch (error) {
      admission.release();
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid task" });
    }
  });
  app.post("/api/tasks", async (req, reply) => {
    const body = taskSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    let saved;
    try {
      if (store.getTask(body.data.id)) {
        return reply.code(409).send({ error: "task id already exists; use PATCH to update the authoritative task" });
      }
      assertCreatableTaskStatus(body.data.status);
      saved = store.upsertTask(body.data);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid task" });
    }
    appLog.emit("info", "task", `task "${saved.title}" → ${saved.status}`);
    auditRequest(req.headers.authorization, {
      category: "work", action: "task.created", projectId: saved.projectId,
      entityType: "task", entityId: saved.id, summary: `Task "${saved.title}" created`,
      metadata: { status: saved.status, assignedAgentId: saved.assignedAgentId ?? null },
    });
    // a created/approved task may make others runnable — let the scheduler react
    scheduler.onTasksChanged(saved.projectId);
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (req) => {
    const task = store.getTask(req.params.id);
    durable.resolveAttentionForTask(req.params.id, "task deleted by the local operator");
    scheduler.revokeCompletionCapabilities([req.params.id]);
    control.cancelWakeup(req.params.id);
    store.deleteTask(req.params.id);
    auditRequest(req.headers.authorization, {
      category: "work", action: "task.deleted", projectId: task?.projectId,
      entityType: "task", entityId: req.params.id,
      summary: task ? `Task "${task.title}" deleted` : "Task deleted",
    });
    return { ok: true };
  });
  // Partial update of a task. Server-side merge onto
  // the AUTHORITATIVE current task — never trust a client snapshot — so a stale
  // caller can't clobber server-owned fields (channel, idle, retryCount, costUsd)
  // that the worker/scheduler or the /review route mutate concurrently.
  const taskPatchSchema = z.object({
    status: taskSchema.shape.status.optional(),
    title: taskSchema.shape.title.optional(),
    description: z.string().max(256 * 1024).optional(),
    assignedAgentId: taskSchema.shape.assignedAgentId.optional(),
    assignedAgentName: taskSchema.shape.assignedAgentName.optional(),
    dependsOn: taskSchema.shape.dependsOn.optional(),
    lane: taskSchema.shape.lane,
    priority: taskSchema.shape.priority,
    notBefore: taskSchema.shape.notBefore,
    parentTaskId: taskSchema.shape.parentTaskId.optional(),
  }).strict();
  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (req, reply) => {
    const task = store.listTasks().find((t) => t.id === req.params.id);
    if (!task) return reply.code(404).send({ error: "unknown task" });
    const patch = taskPatchSchema.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: patch.error.issues });
    const scopedGrant = orchestrationAccess.grantFor(bearerToken(req.headers.authorization));
    if (scopedGrant) {
      const keys = Object.keys(patch.data);
      const scopedKeys = new Set(["status", "description", "lane", "priority", "notBefore"]);
      if (task.projectId !== scopedGrant.projectId || keys.some((key) => !scopedKeys.has(key))) {
        return reply.code(403).send({ error: "Lead task updates are limited to runtime-safe planning fields in its own project" });
      }
      if (
        ["description", "lane", "priority", "notBefore"].some((key) =>
          Object.prototype.hasOwnProperty.call(patch.data, key)) &&
        task.status !== "backlog" &&
        task.status !== "blocked"
      ) {
        return reply.code(409).send({ error: "task intent is frozen after dispatch" });
      }
      if (patch.data.status && !isScopedTaskTransitionAllowed(task.status, patch.data.status)) {
        return reply.code(409).send({ error: `scoped task transition ${task.status} → ${patch.data.status} is not allowed` });
      }
    }
    if (patch.data.status && !isClientTaskTransitionAllowed(task.status, patch.data.status)) {
      return reply
        .code(409)
        .send({ error: `task transition ${task.status} → ${patch.data.status} is server-owned` });
    }
    const requested = taskSchema.safeParse({
      ...task,
      ...patch.data,
      updatedAt: new Date().toISOString(),
    });
    if (!requested.success) return reply.code(400).send({ error: requested.error.issues });
    if (task.status === "waiting_review" && patch.data.status === "done") {
      return reply.code(409).send({
        error: "durable runs require exact-hash human approval and local promotion via the run endpoints",
      });
    }
    let updateAdmission: ReturnType<OrchestrationAccess["admitTaskUpdate"]> | undefined;
    if (scopedGrant) {
      const bytes = (value: { title: string; description?: string }): number =>
        Buffer.byteLength(value.title, "utf8") + Buffer.byteLength(value.description ?? "", "utf8");
      const active = store.listTasks(task.projectId).filter(
        (item) => item.status !== "done" && item.status !== "failed",
      );
      const activeTaskBytesAfter = active.reduce((sum, item) =>
        sum + bytes(item.id === task.id ? requested.data : item), 0);
      updateAdmission = orchestrationAccess.admitTaskUpdate(scopedGrant, {
        activeTaskBytesAfter,
        requestBytes: Buffer.byteLength(JSON.stringify(patch.data), "utf8"),
      });
      if (!updateAdmission.ok) {
        return reply.code(updateAdmission.statusCode).send({ error: updateAdmission.error });
      }
    }
    let saved;
    try {
      saved = store.upsertTask(clientTaskUpdate(task, requested.data));
    } catch (error) {
      if (updateAdmission?.ok) updateAdmission.release();
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid task update" });
    }
    if (task.status === "waiting_review" && saved.status === "backlog") {
      const invalidated = durable.requestChanges(saved.id);
      if (invalidated?.subjectHash) {
        const request = control.getApprovalByCorrelation(
          `run-promotion:${invalidated.id}:${invalidated.subjectHash}`,
        );
        if (request && !request.appliedAt) control.revokeApproval(request.id, "operator requested changes");
      }
      for (const grant of control.listCapabilityGrants(saved.projectId).filter(
        (candidate) => candidate.subjectType === "run" && candidate.subjectId === invalidated?.id,
      )) control.revokeCapabilityGrant(grant.id);
    }
    appLog.emit("info", "task", `task "${saved.title}" → ${saved.status}`);
    auditRequest(req.headers.authorization, {
      category: "work", action: "task.updated", projectId: saved.projectId,
      entityType: "task", entityId: saved.id, summary: `Task "${saved.title}" updated`,
      metadata: { fromStatus: task.status, toStatus: saved.status, changedFields: Object.keys(patch.data).join(",") },
    });
    broadcast({ kind: "tasks_changed", projectId: saved.projectId });
    scheduler.onTasksChanged(saved.projectId);
    return saved;
  });
  // Provider-agnostic completion signal. A worker (Claude, Gemini, Codex —
  // whatever the CLI) reports it has finished a pass by curl-ing this endpoint:
  //   curl -s -X POST http://127.0.0.1:<gateway-port>/api/tasks/<id>/review
  // (the exact port is injected into the worker's prompt — it's the gateway's
  // live bound port, dynamic in the desktop app, not a fixed default)
  // This replaces relying solely on an MCP tool for provider completion. Every
  // launch adapter receives the same one-time completion capability.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/review", async (req, reply) => {
    const task = store.listTasks().find((t) => t.id === req.params.id);
    if (!task) return reply.code(404).send({ error: "unknown task" });
    if (task.status !== "in_progress") {
      return reply.code(409).send({ error: "task is not in progress" });
    }
    const capability = req.headers["x-daimon-completion-capability"];
    if (typeof capability !== "string" || !scheduler.consumeCompletionCapability(task.id, capability)) {
      return reply.code(403).send({ error: "invalid or already-used completion capability" });
    }
    const workerChannel = task.channel; // capture before clearing, to close the worker
    appLog.emit(
      "info",
      "task",
      `"${task.title}" submitted; closing worker before durable evidence capture`,
    );
    // The worker finished its pass — close it (workers are ephemeral) so it frees
    // its concurrency slot and the Agents pane settles (no more ticking clock /
    // "running" status while it sits idle). A short grace lets THIS response flush
    // back to the worker's curl + a brief summary print before the PTY is killed.
    // The task's channel is already cleared, so the resulting "killed" exit won't
    // be mis-attributed to the (now done/waiting_review) task.
    if (workerChannel) {
      const t = setTimeout(() => void pm.close(workerChannel, "completed"), 250);
      t.unref();
    }
    return reply.code(202).send({ ok: true, status: "capturing_evidence" });
  });

  const inputRequestResult = (
    attention: ReturnType<DurableExecutionStore["openInputAttention"]>["attention"],
    idempotentReplay: boolean,
  ) => ({
    attentionId: attention.id,
    projectId: attention.projectId,
    taskId: attention.taskId,
    runId: attention.runId,
    agentId: attention.agentId,
    channel: attention.channel,
    link: attention.link ?? `/projects/${attention.projectId}/tasks/${attention.taskId}`,
    state: attention.state,
    idempotentReplay,
  });
  const inputLink = (projectId: string, taskId: string, channel?: string): string => {
    const query = new URLSearchParams({ projectId, taskId });
    if (channel) query.set("channel", channel);
    return `/?${query.toString()}`;
  };
  const inputBytes = (prompt: string, options: string[]): number =>
    Buffer.byteLength(prompt, "utf8") + options.reduce(
      (total, option) => total + Buffer.byteLength(option, "utf8"),
      0,
    );

  // Ephemeral worker authority. This capability is separate from completion:
  // requesting input can neither submit review nor be replayed for another run.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/input", async (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "unknown task" });
    if (task.status !== "in_progress" || !task.channel || !pm.isLive(task.channel)) {
      return reply.code(409).send({ error: "task has no active worker run" });
    }
    const body = taskInputRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const supplied = req.headers["x-daimon-input-capability"];
    if (typeof supplied !== "string") {
      return reply.code(403).send({ error: "invalid or already-used input capability" });
    }
    const claim = scheduler.claimInputCapability(task.id, supplied, body.data.requestId);
    if (!claim.ok || claim.channel !== task.channel) {
      return reply.code(403).send({ error: "invalid or already-used input capability" });
    }
    const existing = durable.getInputAttention(task.id, body.data.requestId);
    if (!existing) {
      const openProject = durable.countOpenInputAttention(task.projectId);
      const openTask = durable.countOpenInputAttention(task.projectId, task.id);
      if (
        openProject >= ORCHESTRATION_INPUT_LIMITS.openPerProject ||
        openTask >= ORCHESTRATION_INPUT_LIMITS.openPerTask
      ) {
        claim.release();
        return reply.code(409).send({ error: "input inbox is at its open-request limit" });
      }
    }
    try {
      const opened = durable.openInputAttention({
        projectId: task.projectId,
        taskId: task.id,
        runId: claim.runId,
        agentId: task.assignedAgentId,
        channel: task.channel,
        link: inputLink(task.projectId, task.id, task.channel),
        requestId: body.data.requestId,
        options: body.data.options,
        message: body.data.prompt,
      });
      appLog.emit("info", "attention", `worker requested operator input for "${task.title}"`);
      broadcast({ kind: "attention_changed", projectId: task.projectId });
      return reply.code(opened.created ? 201 : 200).send(
        inputRequestResult(opened.attention, !opened.created),
      );
    } catch (error) {
      claim.release();
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "input request could not be opened",
      });
    }
  });

  // Resident Lead authority. The scoped bearer must match the authoritative
  // project/team/task roster; request quotas are independent from task creation.
  app.post<{ Params: { id: string } }>("/api/orchestration/tasks/:id/input", async (req, reply) => {
    const grant = orchestrationAccess.grantFor(bearerToken(req.headers.authorization));
    if (!grant) return reply.code(403).send({ error: "a scoped orchestration credential is required" });
    const body = taskInputRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const task = store.getTask(req.params.id);
    if (!task) return reply.code(404).send({ error: "unknown task" });
    const project = store.getProject(task.projectId as ProjectId);
    const team = project?.teamId
      ? store.listTeams().find((candidate) => candidate.id === project.teamId)
      : undefined;
    if (
      task.projectId !== grant.projectId ||
      !team ||
      project?.teamId !== team.id ||
      (grant.teamId !== undefined && grant.teamId !== team.id) ||
      !task.assignedAgentId ||
      !team.memberAgentIds.includes(task.assignedAgentId)
    ) {
      return reply.code(403).send({ error: "input request is outside the scoped project team" });
    }
    if (!new Set(["backlog", "blocked", "in_progress"]).has(task.status)) {
      return reply.code(409).send({ error: "task is not in an input-requestable state" });
    }
    const channel = task.channel && pm.isLive(task.channel) ? task.channel : undefined;
    const run = channel ? durable.getRunBySession(channel) : undefined;
    const existing = durable.getInputAttention(task.id, body.data.requestId);
    if (existing) {
      try {
        const replayed = durable.openInputAttention({
          projectId: task.projectId,
          taskId: task.id,
          runId: run?.id,
          agentId: task.assignedAgentId,
          channel,
          link: inputLink(task.projectId, task.id, channel),
          requestId: body.data.requestId,
          options: body.data.options,
          message: body.data.prompt,
        });
        return reply.code(200).send(inputRequestResult(replayed.attention, true));
      } catch (error) {
        return reply.code(409).send({ error: error instanceof Error ? error.message : "idempotency conflict" });
      }
    }
    const admission = orchestrationAccess.admitInputRequest(grant, {
      openProjectRequests: durable.countOpenInputAttention(task.projectId),
      openTaskRequests: durable.countOpenInputAttention(task.projectId, task.id),
      requestBytes: inputBytes(body.data.prompt, body.data.options),
    });
    if (!admission.ok) return reply.code(admission.statusCode).send({ error: admission.error });
    try {
      const opened = durable.openInputAttention({
        projectId: task.projectId,
        taskId: task.id,
        runId: run?.id,
        agentId: task.assignedAgentId,
        channel,
        link: inputLink(task.projectId, task.id, channel),
        requestId: body.data.requestId,
        options: body.data.options,
        message: body.data.prompt,
      });
      appLog.emit("info", "attention", `Lead requested operator input for "${task.title}"`);
      broadcast({ kind: "attention_changed", projectId: task.projectId });
      return reply.code(201).send(inputRequestResult(opened.attention, false));
    } catch (error) {
      admission.release();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "input request could not be opened" });
    }
  });
  // Manual retry of a FAILED task → requeue so the scheduler re-dispatches it.
  app.post<{ Params: { id: string } }>("/api/tasks/:id/retry", async (req, reply) => {
    if (!scheduler.retryTask(req.params.id)) {
      return reply.code(409).send({ error: "task not found or not in a failed state" });
    }
    return { ok: true };
  });

  // --- durable control-kernel read models + structured coordination ---
  app.get("/api/control/summary", async () => control.summary());
  app.get<{ Querystring: { status?: string } }>("/api/control/effects", async (req, reply) => {
    const status = req.query.status
      ? z.enum(["planned", "committed", "failed", "uncertain", "reconciled"]).safeParse(req.query.status)
      : undefined;
    if (status && !status.success) return reply.code(400).send({ error: "unknown effect status" });
    return control.listEffects(status?.success ? status.data : undefined);
  });
  app.get<{ Querystring: { projectId?: string } }>("/api/control/delegations", async (req) =>
    control.listDelegations(req.query.projectId),
  );
  app.get<{ Querystring: { projectId?: string } }>("/api/control/liveness", async (req) => {
    control.expireLiveness();
    return control.listLiveness(req.query.projectId);
  });
  app.get<{ Querystring: { projectId?: string } }>("/api/control/lanes", async (req) =>
    control.listLanes(req.query.projectId),
  );
  app.get<{ Querystring: { state?: string } }>("/api/control/wakeups", async (req, reply) => {
    const state = req.query.state
      ? z.enum(["scheduled", "fired", "cancelled"]).safeParse(req.query.state)
      : undefined;
    if (state && !state.success) return reply.code(400).send({ error: "unknown wakeup state" });
    return control.listWakeups(state?.success ? state.data : undefined);
  });
  app.get("/api/control/state-schemas", async () => control.listStateSchemas());
  app.get<{ Querystring: { ownerType?: string; ownerId?: string } }>("/api/control/state", async (req) =>
    control.listState(req.query.ownerType, req.query.ownerId),
  );
  app.get<{ Querystring: { projectId?: string } }>("/api/control/grants", async (req) =>
    control.listCapabilityGrants(req.query.projectId),
  );
  app.get<{ Querystring: { status?: string } }>("/api/control/approvals", async (req, reply) => {
    const status = req.query.status
      ? z.enum(["pending", "approved", "rejected", "expired", "revoked"]).safeParse(req.query.status)
      : undefined;
    if (status && !status.success) return reply.code(400).send({ error: "unknown approval status" });
    return control.listApprovals(status?.success ? status.data : undefined);
  });

  const coordinationArtifactSchema = z.object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
    ownerAgentId: z.string().min(1).max(256),
    content: z.string().max(256 * 1024),
    mediaType: z.string().min(1).max(256).default("text/markdown"),
    expectedVersion: z.number().int().nonnegative(),
  }).strict();
  const projectAgentAllowed = (projectId: string, agentId: string): boolean => {
    const project = store.getProject(projectId as ProjectId);
    const team = project?.teamId
      ? store.listTeams().find((candidate) => candidate.id === project.teamId)
      : undefined;
    return Boolean(team?.memberAgentIds.includes(agentId as AgentId));
  };
  const scopedActorAllowed = (
    authorization: string | string[] | undefined,
    projectId: string,
    agentId: string,
  ): boolean => {
    const grant = orchestrationAccess.grantFor(bearerToken(authorization));
    if (!grant) return true;
    const project = store.getProject(projectId as ProjectId);
    const team = project?.teamId
      ? store.listTeams().find((candidate) => candidate.id === project.teamId)
      : undefined;
    return grant.projectId === projectId && team?.supervisorAgentId === agentId;
  };
  const scopedCoordinationUsage = new WeakMap<object, { count: number; bytes: number }>();
  const reserveScopedCoordination = (
    authorization: string | string[] | undefined,
    bytes: number,
  ): { ok: true; release(): void } | { ok: false; error: string } => {
    const grant = orchestrationAccess.grantFor(bearerToken(authorization));
    if (!grant) return { ok: true, release() {} };
    const usage = scopedCoordinationUsage.get(grant) ?? { count: 0, bytes: 0 };
    if (usage.count >= 512 || usage.bytes + bytes > 32 * 1024 * 1024) {
      return { ok: false, error: "scoped coordination budget exhausted" };
    }
    usage.count += 1;
    usage.bytes += bytes;
    scopedCoordinationUsage.set(grant, usage);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        usage.count = Math.max(0, usage.count - 1);
        usage.bytes = Math.max(0, usage.bytes - bytes);
      },
    };
  };
  app.get<{ Querystring: { projectId: string } }>("/api/control/artifacts", async (req, reply) => {
    if (!store.getProject(req.query.projectId as ProjectId)) return reply.code(404).send({ error: "unknown project" });
    return control.listArtifacts(req.query.projectId);
  });
  app.get<{ Querystring: { projectId: string; name: string } }>("/api/control/artifacts/content", async (req, reply) => {
    const artifact = control.latestArtifact(req.query.projectId, req.query.name);
    if (!artifact) return reply.code(404).send({ error: "unknown coordination artifact" });
    try {
      return { artifact, content: durable.readArtifact(artifact.contentHash).toString("utf8") };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "artifact content unavailable" });
    }
  });
  app.post("/api/control/artifacts", async (req, reply) => {
    if (isRendererRequest(req.headers.authorization)) {
      return reply.code(403).send({ error: "agent coordination writes require an agent-scoped or admin credential" });
    }
    const body = coordinationArtifactSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!projectAgentAllowed(body.data.projectId, body.data.ownerAgentId)) {
      return reply.code(403).send({ error: "artifact owner is not a project team member" });
    }
    if (!scopedActorAllowed(req.headers.authorization, body.data.projectId, body.data.ownerAgentId)) {
      return reply.code(403).send({ error: "scoped orchestration callers cannot impersonate another agent" });
    }
    try {
      control.validateArtifactPublish(body.data);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "artifact publish failed" });
    }
    const reservation = reserveScopedCoordination(
      req.headers.authorization,
      Buffer.byteLength(JSON.stringify(body.data), "utf8"),
    );
    if (!reservation.ok) return reply.code(409).send({ error: reservation.error });
    let persisted = false;
    try {
      const blob = durable.putArtifact(body.data.content, "coordination-artifact", body.data.mediaType, {
        projectId: body.data.projectId,
        name: body.data.name,
        ownerAgentId: body.data.ownerAgentId,
      });
      persisted = true;
      return control.publishArtifact({ ...body.data, contentHash: blob.sha256 });
    } catch (error) {
      if (!persisted) reservation.release();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "artifact publish failed" });
    }
  });
  app.post("/api/control/artifacts/transfer", async (req, reply) => {
    if (isRendererRequest(req.headers.authorization)) {
      return reply.code(403).send({ error: "artifact ownership transfer requires the admin API" });
    }
    const body = z.object({
      projectId: z.string().uuid(),
      name: z.string().min(1).max(256),
      expectedVersion: z.number().int().positive(),
      fromAgentId: z.string().min(1).max(256),
      toAgentId: z.string().min(1).max(256),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!projectAgentAllowed(body.data.projectId, body.data.fromAgentId) ||
        !projectAgentAllowed(body.data.projectId, body.data.toAgentId)) {
      return reply.code(403).send({ error: "artifact owners must be project team members" });
    }
    try {
      return control.transferArtifact(body.data);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "artifact transfer failed" });
    }
  });
  const coordinationMessageBaseSchema = z.object({
    projectId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(512),
    fromAgentId: z.string().min(1).max(256),
    toAgentId: z.string().min(1).max(256).optional(),
    kind: z.enum(["finding", "question", "answer", "handoff", "steering", "artifact", "status"]),
    body: z.string().min(1).max(256 * 1024),
    artifactName: z.string().min(1).max(256).optional(),
    artifactVersion: z.number().int().positive().optional(),
    causationId: z.string().min(1).max(256).optional(),
  }).strict();
  const coordinationMessageSchema = coordinationMessageBaseSchema.refine(
    (value) => Boolean(value.artifactName) === Boolean(value.artifactVersion), {
    message: "artifactName and artifactVersion must be supplied together",
  });
  app.get<{ Querystring: { projectId: string; since?: string } }>("/api/control/messages", async (req, reply) => {
    if (!store.getProject(req.query.projectId as ProjectId)) return reply.code(404).send({ error: "unknown project" });
    try {
      return control.listMessages(req.query.projectId, req.query.since).map((message) => ({
        ...message,
        body: durable.readArtifact(message.bodyArtifactHash).toString("utf8"),
      }));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "coordination messages unavailable" });
    }
  });
  app.post("/api/control/messages", async (req, reply) => {
    if (isRendererRequest(req.headers.authorization)) {
      return reply.code(403).send({ error: "agent coordination writes require an agent-scoped or admin credential" });
    }
    const body = coordinationMessageSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!projectAgentAllowed(body.data.projectId, body.data.fromAgentId) ||
        (body.data.toAgentId && !projectAgentAllowed(body.data.projectId, body.data.toAgentId))) {
      return reply.code(403).send({ error: "coordination participants must be project team members" });
    }
    if (!scopedActorAllowed(req.headers.authorization, body.data.projectId, body.data.fromAgentId)) {
      return reply.code(403).send({ error: "scoped orchestration callers cannot impersonate another agent" });
    }
    const { body: messageBody, ...messageFields } = body.data;
    const candidate = {
      ...messageFields,
      causationId: body.data.causationId ?? `message:${createHash("sha256").update(body.data.idempotencyKey).digest("hex")}`,
      bodyArtifactHash: createHash("sha256").update(messageBody).digest("hex"),
    };
    try {
      const replay = control.validateMessage(candidate);
      if (replay) return replay;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "coordination message failed" });
    }
    const reservation = reserveScopedCoordination(
      req.headers.authorization,
      Buffer.byteLength(JSON.stringify(body.data), "utf8"),
    );
    if (!reservation.ok) return reply.code(409).send({ error: reservation.error });
    let persisted = false;
    try {
      const blob = durable.putArtifact(messageBody, "coordination-message", "text/plain", {
        projectId: body.data.projectId,
        fromAgentId: body.data.fromAgentId,
        toAgentId: body.data.toAgentId,
      });
      persisted = true;
      return control.sendMessage({ ...candidate, bodyArtifactHash: blob.sha256 });
    } catch (error) {
      if (!persisted) reservation.release();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "coordination message failed" });
    }
  });

  // Run-lifetime worker coordination. Identity is inferred from the ephemeral
  // dispatch capability; a worker cannot nominate or impersonate fromAgentId.
  const coordinationCapability = (header: string | string[] | undefined): string =>
    typeof header === "string" ? header : "";
  const workerCoordinationMessageSchema = coordinationMessageBaseSchema.omit({
    projectId: true,
    fromAgentId: true,
  }).refine((value) => Boolean(value.artifactName) === Boolean(value.artifactVersion), {
    message: "artifactName and artifactVersion must be supplied together",
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id/coordination/peers", async (req, reply) => {
    const identity = scheduler.coordinationIdentity(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
    );
    if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
    const project = store.getProject(identity.projectId as ProjectId);
    const team = project?.teamId
      ? store.listTeams().find((candidate) => candidate.id === project.teamId)
      : undefined;
    return (team?.memberAgentIds ?? []).map((agentId) => {
      const member = store.getAgent(agentId);
      return { agentId, name: member?.name ?? agentId, role: member?.description, self: agentId === identity.agentId };
    });
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id/coordination/messages", async (req, reply) => {
    const identity = scheduler.coordinationIdentity(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
    );
    if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
    return control.listMessagesForAgent(identity.projectId, identity.agentId).map((message) => ({
      ...message,
      body: durable.readArtifact(message.bodyArtifactHash).toString("utf8"),
    }));
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/coordination/messages", async (req, reply) => {
    const identity = scheduler.coordinationIdentity(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
    );
    if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
    const body = workerCoordinationMessageSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (body.data.toAgentId && !projectAgentAllowed(identity.projectId, body.data.toAgentId)) {
      return reply.code(403).send({ error: "message recipient is not a project team member" });
    }
    const { body: messageBody, ...messageFields } = body.data;
    const candidate = {
      ...messageFields,
      projectId: identity.projectId,
      fromAgentId: identity.agentId,
      causationId: body.data.causationId ?? `message:${createHash("sha256").update(body.data.idempotencyKey).digest("hex")}`,
      bodyArtifactHash: createHash("sha256").update(messageBody).digest("hex"),
    };
    try {
      const replay = control.validateMessage(candidate);
      if (replay) return replay;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "worker coordination message failed" });
    }
    const reservation = scheduler.reserveCoordinationWrite(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
      Buffer.byteLength(JSON.stringify(body.data), "utf8"),
    );
    if (!reservation.ok) return reply.code(reservation.statusCode).send({ error: reservation.error });
    let persisted = false;
    try {
      const blob = durable.putArtifact(messageBody, "coordination-message", "text/plain", {
        projectId: identity.projectId,
        runId: identity.runId,
        fromAgentId: identity.agentId,
        toAgentId: body.data.toAgentId,
      });
      persisted = true;
      return control.sendMessage({ ...candidate, bodyArtifactHash: blob.sha256 });
    } catch (error) {
      if (!persisted) reservation.release();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "worker coordination message failed" });
    }
  });
  const workerArtifactSchema = coordinationArtifactSchema.omit({
    projectId: true,
    ownerAgentId: true,
  });
  app.get<{ Params: { id: string } }>("/api/tasks/:id/coordination/artifacts", async (req, reply) => {
    const identity = scheduler.coordinationIdentity(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
    );
    if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
    return control.listArtifacts(identity.projectId);
  });
  app.get<{ Params: { id: string }; Querystring: { name: string } }>(
    "/api/tasks/:id/coordination/artifacts/content",
    async (req, reply) => {
      const identity = scheduler.coordinationIdentity(
        req.params.id,
        coordinationCapability(req.headers["x-daimon-coordination-capability"]),
      );
      if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
      const artifact = control.latestArtifact(identity.projectId, req.query.name);
      if (!artifact) return reply.code(404).send({ error: "unknown coordination artifact" });
      return { artifact, content: durable.readArtifact(artifact.contentHash).toString("utf8") };
    },
  );
  app.post<{ Params: { id: string } }>("/api/tasks/:id/coordination/artifacts", async (req, reply) => {
    const identity = scheduler.coordinationIdentity(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
    );
    if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
    const body = workerArtifactSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      control.validateArtifactPublish({
        ...body.data,
        projectId: identity.projectId,
        ownerAgentId: identity.agentId,
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "worker artifact publish failed" });
    }
    const reservation = scheduler.reserveCoordinationWrite(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
      Buffer.byteLength(JSON.stringify(body.data), "utf8"),
    );
    if (!reservation.ok) return reply.code(reservation.statusCode).send({ error: reservation.error });
    let persisted = false;
    try {
      const blob = durable.putArtifact(body.data.content, "coordination-artifact", body.data.mediaType, {
        projectId: identity.projectId,
        runId: identity.runId,
        name: body.data.name,
        ownerAgentId: identity.agentId,
      });
      persisted = true;
      return control.publishArtifact({
        ...body.data,
        projectId: identity.projectId,
        ownerAgentId: identity.agentId,
        contentHash: blob.sha256,
      });
    } catch (error) {
      if (!persisted) reservation.release();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "worker artifact publish failed" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/tasks/:id/coordination/artifacts/transfer", async (req, reply) => {
    const identity = scheduler.coordinationIdentity(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
    );
    if (!identity) return reply.code(403).send({ error: "active worker coordination capability required" });
    const body = z.object({
      name: z.string().min(1).max(256),
      expectedVersion: z.number().int().positive(),
      toAgentId: z.string().min(1).max(256),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!projectAgentAllowed(identity.projectId, body.data.toAgentId)) {
      return reply.code(403).send({ error: "new artifact owner is not a project team member" });
    }
    const reservation = scheduler.reserveCoordinationWrite(
      req.params.id,
      coordinationCapability(req.headers["x-daimon-coordination-capability"]),
      Buffer.byteLength(JSON.stringify(body.data), "utf8"),
    );
    if (!reservation.ok) return reply.code(reservation.statusCode).send({ error: reservation.error });
    try {
      return control.transferArtifact({
        projectId: identity.projectId,
        name: body.data.name,
        expectedVersion: body.data.expectedVersion,
        fromAgentId: identity.agentId,
        toAgentId: body.data.toAgentId,
      });
    } catch (error) {
      reservation.release();
      return reply.code(409).send({ error: error instanceof Error ? error.message : "worker artifact transfer failed" });
    }
  });

  // --- durable execution evidence + attention inbox ---
  app.get<{ Querystring: { taskId?: string } }>("/api/runs", async (req) =>
    durable.listRuns(req.query.taskId),
  );
  app.get<{ Querystring: { state?: string } }>("/api/attention", async (req, reply) => {
    const state = z.enum(["open", "resolved", "all"]).safeParse(req.query.state ?? "open");
    if (!state.success) return reply.code(400).send({ error: "state must be open, resolved, or all" });
    return durable.listAttention(state.data);
  });
  app.post<{ Params: { id: string } }>("/api/attention/:id/respond", async (req, reply) => {
    const body = taskInputResponseSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const attention = durable.getAttention(req.params.id);
    if (!attention) return reply.code(404).send({ error: "unknown attention item" });
    if (attention.kind !== "input_required" || attention.state !== "open") {
      return reply.code(409).send({ error: "attention item is not an open input request" });
    }
    const task = store.getTask(attention.taskId);
    if (
      !attention.channel ||
      !task ||
      task.projectId !== attention.projectId ||
      task.channel !== attention.channel ||
      task.assignedAgentId !== attention.agentId ||
      !pm.isLive(attention.channel)
    ) {
      return reply.code(409).send({ error: "the authoritative task no longer has the recorded active channel" });
    }
    try {
      if (!pm.write(attention.channel, `${body.data.response}\n`)) {
        return reply.code(409).send({ error: "the recorded channel closed before delivery" });
      }
      const resolved = durable.resolveAttention(attention.id, "operator response delivered to the active channel");
      appLog.emit("info", "attention", `operator response delivered for "${task.title}"`);
      broadcast({ kind: "attention_changed", projectId: attention.projectId });
      return {
        attentionId: resolved.id,
        state: resolved.state,
        deliveredTo: attention.channel,
        resolvedAt: resolved.resolvedAt,
      };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "operator response could not be delivered",
      });
    }
  });
  const exactHashSchema = z.object({
    subjectHash: z.string().regex(/^[a-f0-9]{64}$/),
    responseId: z.string().min(1).max(256).optional(),
  }).strict();
  const requireHumanBearer = (authorization: string | string[] | undefined): boolean => {
    const configured = process.env.DAIMON_AUTH_TOKEN?.trim();
    return Boolean(configured && tokensEqual(configured, bearerToken(authorization)));
  };
  const syncRunControlState = (runId: string, status: string): void => {
    const state = control.getState(`run:${runId}`);
    if (!state) return;
    const latest = control.readStateLatest(state.id);
    const payload = latest.payload && typeof latest.payload === "object"
      ? { ...(latest.payload as Record<string, unknown>), status }
      : { status };
    control.updateState({ id: latest.id, expectedPayloadHash: latest.payloadHash, payload });
  };
  app.post<{ Params: { id: string } }>("/api/runs/:id/approve", async (req, reply) => {
    // A scoped Lead/MCP credential is intentionally insufficient. In standalone
    // tokenless dev, human approval/promotion is disabled rather than inferred.
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required for human approval" });
    }
    const body = exactHashSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const run = durable.getRun(req.params.id);
      if (!run) return reply.code(404).send({ error: "unknown run" });
      const routed = control.getApprovalByCorrelation(
        `run-promotion:${run.id}:${body.data.subjectHash}`,
      );
      if (!routed) return reply.code(409).send({ error: "approval request is unavailable" });
      control.decideApproval({
        id: routed.id,
        decision: "approved",
        decidedBy: "human-local",
        responseId: body.data.responseId ?? `desktop:${run.id}:${body.data.subjectHash}`,
      });
      const approval = durable.getApproval(req.params.id, body.data.subjectHash) ??
        durable.recordApproval(req.params.id, body.data.subjectHash);
      syncRunControlState(run.id, "approved");
      control.markApprovalApplied(routed.id);
      auditRequest(req.headers.authorization, {
        category: "work", action: "run.approved", projectId: run?.projectId,
        entityType: "run", entityId: req.params.id, summary: "Captured worker evidence approved",
        metadata: { subjectHash: body.data.subjectHash, taskId: run?.taskId ?? null },
      });
      return approval;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "approval failed" });
    }
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/diff", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required to read captured evidence" });
    }
    const run = durable.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "unknown run" });
    if (!run.diffArtifactHash) return reply.code(409).send({ error: "run has no captured diff" });
    try {
      return reply.type("text/plain; charset=utf-8").send(durable.readArtifact(run.diffArtifactHash));
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "evidence unavailable" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/promote", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required for promotion" });
    }
    const body = exactHashSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const run = durable.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "unknown run" });
    const existingEffect = control.getEffectByKey(`run-promotion:${run.id}:${body.data.subjectHash}`);
    if (
      (existingEffect?.status === "committed" || existingEffect?.status === "reconciled") &&
      run.status === "promoted"
    ) {
      const replayTask = store.getTask(run.taskId);
      if (!replayTask) return reply.code(409).send({ error: "run task is unavailable" });
      const saved = replayTask.status === "done" ? replayTask : store.upsertTask({
        ...replayTask,
        status: "done",
        updatedAt: new Date().toISOString(),
      });
      broadcast({ kind: "tasks_changed", projectId: saved.projectId });
      scheduler.onTasksChanged(saved.projectId);
      return { ok: true, task: saved, run, replay: true };
    }
    if (run.status !== "approved" && run.status !== "promoting") {
      return reply.code(409).send({ error: "run is not approved" });
    }
    const task = store.listTasks().find((item) => item.id === run.taskId);
    if (!task || task.status !== "waiting_review") {
      return reply.code(409).send({ error: "task is not waiting for review" });
    }
    try {
      const effect = control.beginEffect({
        idempotencyKey: `run-promotion:${run.id}:${body.data.subjectHash}`,
        projectId: run.projectId,
        runId: run.id,
        kind: "git-promotion",
        target: run.canonicalRoot,
        intent: { runId: run.id, taskId: run.taskId, subjectHash: body.data.subjectHash },
      }).effect;
      const promoting = durable.beginPromotion(run.id, body.data.subjectHash);
      syncRunControlState(run.id, "promoting");
      worktrees.promote(promoting, body.data.subjectHash);
      durable.markPromoted(run.id, body.data.subjectHash);
      syncRunControlState(run.id, "promoted");
      control.settleEffect(effect.id, effect.status === "failed" || effect.status === "uncertain" ? "reconciled" : "committed", {
        result: { runId: run.id, subjectHash: body.data.subjectHash, canonicalRoot: run.canonicalRoot },
      });
      durable.resolveAttentionForTask(task.id, "approved change promoted to the canonical checkout");
      const saved = store.upsertTask({ ...task, status: "done", updatedAt: new Date().toISOString() });
      auditRequest(req.headers.authorization, {
        category: "work", action: "run.promoted", projectId: saved.projectId,
        entityType: "run", entityId: run.id, summary: `Approved evidence promoted for task "${saved.title}"`,
        metadata: { subjectHash: body.data.subjectHash, taskId: saved.id },
      });
      broadcast({ kind: "tasks_changed", projectId: saved.projectId });
      scheduler.onTasksChanged(saved.projectId);
      return { ok: true, task: saved, run: durable.getRun(run.id) };
    } catch (error) {
      const effect = control.getEffectByKey(`run-promotion:${run.id}:${body.data.subjectHash}`);
      if (effect?.status === "planned") {
        control.settleEffect(
          effect.id,
          error instanceof PromotionStateUncertainError || !(error instanceof WorktreePolicyError) ? "uncertain" : "failed",
          {
          detail: `promotion requires reconciliation: ${error instanceof Error ? error.message : String(error)}`,
          },
        );
      }
      return reply.code(409).send({ error: error instanceof Error ? error.message : "promotion failed" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/control/approvals/:id/decision", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required for approval decisions" });
    }
    const body = z.object({
      decision: z.enum(["approved", "rejected"]),
      responseId: z.string().min(1).max(256),
      reason: z.string().max(4_096).optional(),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const approval = control.getApproval(req.params.id);
      if (!approval) return reply.code(404).send({ error: "unknown approval request" });
      if (approval.kind === "run-promotion") {
        return reply.code(409).send({ error: "run-promotion decisions must use the exact-hash run approval route" });
      }
      return control.decideApproval({
        id: req.params.id,
        decision: body.data.decision,
        responseId: body.data.responseId,
        reason: body.data.reason,
        decidedBy: "human-local",
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "approval decision failed" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/control/effects/:id/reconcile", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required for effect reconciliation" });
    }
    const body = z.object({}).strict().safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      const effect = control.getEffect(req.params.id);
      if (!effect) return reply.code(404).send({ error: "unknown effect" });
      if (effect.kind !== "git-promotion" || !effect.runId) {
        return reply.code(409).send({ error: "no evidence-backed reconciliation adapter is registered for this effect" });
      }
      const run = durable.getRun(effect.runId);
      if (!run?.subjectHash) return reply.code(409).send({ error: "promotion evidence is unavailable" });
      const inspection = worktrees.inspectPromotionState(run, run.subjectHash);
      if (inspection === "applied") {
        if (run.status !== "promoted") durable.markPromoted(run.id, run.subjectHash);
        syncRunControlState(run.id, "promoted");
        const task = store.getTask(run.taskId);
        if (task && task.status !== "done") {
          store.upsertTask({ ...task, status: "done", updatedAt: new Date().toISOString() });
          broadcast({ kind: "tasks_changed", projectId: task.projectId });
          scheduler.onTasksChanged(task.projectId);
        }
        const status = effect.status === "planned" ? "committed" : "reconciled";
        return control.settleEffect(effect.id, status, {
          result: { runId: run.id, subjectHash: run.subjectHash, canonicalRoot: run.canonicalRoot },
          detail: "reconciled from exact canonical Git evidence",
        });
      }
      if (inspection === "not_applied") {
        return control.settleEffect(effect.id, "failed", {
          detail: "exact canonical Git evidence confirms that the promotion is not applied",
        });
      }
      return effect.status === "uncertain" ? effect : control.settleEffect(effect.id, "uncertain", {
        detail: "canonical Git evidence remains inconclusive",
      });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "effect reconciliation failed" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/control/grants/:id/revoke", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required for capability revocation" });
    }
    try {
      return await scheduler.revokeCapabilityGrantRuntime(req.params.id);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "capability revocation failed" });
    }
  });

  // --- secrets vault (cross-project encrypted credentials) ---
  // GET returns METADATA ONLY (masked tail) — the raw value never leaves the server.
  app.get("/api/secrets", async () => store.listSecrets());
  app.post("/api/secrets", async (req, reply) => {
    const body = secretUpsertSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    // require a value when creating (no existing sealed value to keep)
    const exists = store.getSecret(body.data.secret.id);
    if (!exists && !body.data.value) {
      return reply.code(400).send({ error: "a value is required when creating a secret" });
    }
    const saved = store.upsertSecret(body.data.secret, body.data.value);
    appLog.emit("info", "secret", `secret "${saved.key}" saved`);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: exists ? "secret.updated" : "secret.created",
      entityType: "secret", entityId: saved.id, summary: `Vault secret metadata "${saved.label}" saved`,
      metadata: { key: saved.key, valueChanged: Boolean(body.data.value) },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/secrets/:id", async (req) => {
    const existing = store.getSecret(req.params.id as SecretId);
    store.deleteSecret(req.params.id as SecretId);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "secret.deleted", entityType: "secret", entityId: req.params.id,
      summary: existing ? `Vault secret metadata "${existing.label}" deleted` : "Vault secret metadata deleted",
    });
    return { ok: true };
  });

  // resume a budget-paused run (SIGCONT) and let it re-trip the cap if it spends more
  app.post<{ Params: { channel: string } }>("/api/sessions/:channel/resume", async (req, reply) => {
    if (!pm.resume(req.params.channel)) {
      return reply.code(409).send({ error: "session not found or not budget-paused" });
    }
    costTracker.noteResumed(req.params.channel);
    appLog.emit("info", "budget", `resumed ${req.params.channel.slice(0, 8)}`);
    return { ok: true };
  });

  // --- app master log ---
  app.get<{ Querystring: { limit?: string } }>("/api/log", async (req) =>
    appLog.recent(req.query.limit ? Number(req.query.limit) : 500),
  );

  // Structured five-day operator audit trail. The renderer may read this
  // redacted projection; scoped Lead credentials are rejected by the global
  // authorization hook and can never enumerate configuration activity.
  const auditQuerySchema = z.object({
    category: z.enum(["configuration", "work", "security"]).optional(),
    projectId: z.string().uuid().optional(),
    q: z.string().max(100).optional(),
    beforeMs: z.coerce.number().int().positive().optional(),
    beforeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }).strict().refine((value) => !value.beforeId || value.beforeMs !== undefined, {
    message: "beforeId requires beforeMs",
    path: ["beforeId"],
  });
  app.get("/api/audit", async (req, reply) => {
    const query = auditQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues });
    return audit.list(query.data);
  });
  app.get("/api/audit/summary", async () => audit.summary());

  // --- providers ---
  app.get("/api/providers", async () => store.listProviders());
  app.post("/api/providers", async (req, reply) => {
    const body = providerUpsertSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (body.data.provider.mode !== "cli" || !LAUNCH_CLI_KINDS.has(body.data.provider.kind)) {
      return reply.code(422).send({
        error: "This release executes Claude, Gemini, Codex, or the Codex local-model adapters for Ollama and LM Studio.",
      });
    }
    const localKind = isLocalProviderKind(body.data.provider.kind)
      ? body.data.provider.kind
      : undefined;
    if (localKind) {
      if (body.data.apiKey) {
        return reply.code(422).send({ error: "Local providers do not accept or persist an API key." });
      }
      if (!LOCAL_MODEL_ID.test(body.data.provider.defaultModel) ||
          body.data.provider.defaultModel.toLowerCase().endsWith(":cloud")) {
        return reply.code(422).send({
          error: "Choose a valid local model id; Ollama cloud aliases are not allowed in a local provider.",
        });
      }
      try {
        await localProviderBaseUrl(localKind, body.data.provider.baseUrl);
      } catch (error) {
        return reply.code(422).send({ error: error instanceof Error ? error.message : "invalid local provider URL" });
      }
    }
    const expectedCommand = KIND_CMD[body.data.provider.kind];
    if (
      body.data.provider.cliCommand?.trim() &&
      body.data.provider.cliCommand.trim() !== expectedCommand &&
      (!path.isAbsolute(body.data.provider.cliCommand.trim()) ||
        path.basename(body.data.provider.cliCommand.trim()) !== expectedCommand)
    ) {
      return reply.code(422).send({
        error: `Custom provider executables are disabled in this release; install '${expectedCommand}' on PATH.`,
      });
    }
    let cliCommand: string;
    try {
      cliCommand = resolveProviderExecutable(
        body.data.provider.kind,
        body.data.provider.cliCommand ?? expectedCommand,
      );
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof Error ? error.message : "approved provider executable is unavailable",
      });
    }
    const catalog = await discoverProviderModels(
      body.data.provider.kind,
      cliCommand,
      body.data.provider.baseUrl,
    );
    if (!catalog.ok) {
      return reply.code(422).send({ error: catalog.detail });
    }
    if (localKind && !catalog.models.some((model) => model.id === body.data.provider.defaultModel)) {
      return reply.code(422).send({
        error: "The selected local model is not present in the model catalog reported by the local engine.",
      });
    }
    const existingProvider = store.getProvider(body.data.provider.id);
    const saved = store.upsertProvider({
      ...body.data.provider,
      // Catalog entries are authoritative provider output. Renderer-supplied
      // lists are never persisted because they may be stale or fabricated.
      models: catalog.models,
      ...(localKind ? {
        baseUrl: PROVIDER_PRESETS[localKind].baseUrl,
        apiFormat: "openai" as const,
      } : {}),
      cliCommand,
    }, body.data.apiKey);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: existingProvider ? "provider.updated" : "provider.created",
      entityType: "provider", entityId: saved.id, summary: `Provider "${saved.name}" saved`,
      metadata: { kind: saved.kind, mode: saved.mode, enabled: saved.enabled, modelCount: saved.models?.length ?? 0 },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (req, reply) => {
    const existing = store.getProvider(req.params.id as ProviderId);
    try {
      store.deleteProvider(req.params.id as ProviderId);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: "provider.deleted", entityType: "provider", entityId: req.params.id,
        summary: existing ? `Provider "${existing.name}" deleted` : "Provider deleted",
      });
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "provider cannot be deleted" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/providers/:id/models", async (req, reply) => {
    const provider = store.getProvider(req.params.id as ProviderId);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    if (provider.mode !== "cli" || !LAUNCH_CLI_KINDS.has(provider.kind)) {
      return reply.code(422).send({ error: "provider has no supported model discovery adapter" });
    }
    let command: string;
    try {
      command = resolveProviderExecutable(
        provider.kind,
        provider.cliCommand ?? KIND_CMD[provider.kind],
      );
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof Error ? error.message : "approved provider executable is unavailable",
      });
    }
    const catalog = await discoverProviderModels(provider.kind, command, provider.baseUrl);
    if (!catalog.ok) return reply.code(502).send({ error: catalog.detail });
    const defaultModel = isLocalProviderKind(provider.kind) &&
      !catalog.models.some((model) => model.id === provider.defaultModel)
      ? (catalog.models[0]?.id ?? "")
      : provider.defaultModel;
    const updated = store.upsertProvider({ ...provider, defaultModel, models: catalog.models });
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "provider.models_refreshed", entityType: "provider", entityId: updated.id,
      summary: `Model catalog refreshed for provider "${updated.name}"`,
      metadata: { modelCount: catalog.models.length, source: catalog.source },
    });
    return { provider: updated, detail: catalog.detail, source: catalog.source };
  });
  // Setup-wizard connectivity test (pre-save). cli → binary resolves on PATH;
  // api → endpoint reachable. Never throws; always returns { ok, detail }.
  app.post("/api/providers/test", async (req, reply) => {
    const body = providerTestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const p = body.data;
    if (p.mode !== "cli" || !LAUNCH_CLI_KINDS.has(p.kind)) {
      return reply.code(422).send({
        ok: false,
        detail: "This release executes Claude, Gemini, Codex, or the Codex local-model adapters for Ollama and LM Studio.",
      });
    }
    if (p.mode === "cli") {
      const expectedCommand = KIND_CMD[p.kind];
      if (!expectedCommand) return { ok: false, detail: `kind '${p.kind}' needs an explicit CLI command` };
      if (p.cliCommand?.trim() && p.cliCommand.trim() !== expectedCommand) {
        return reply.code(422).send({ ok: false, detail: `Custom provider executables are disabled; install '${expectedCommand}' on PATH.` });
      }
      let command: string;
      try {
        command = resolveProviderExecutable(p.kind, expectedCommand);
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : `could not resolve '${expectedCommand}'`,
          models: [],
        };
      }
      const cli = await testCliProvider(command);
      if (!cli.ok) return { ...cli, models: [] };
      const catalog = await discoverProviderModels(p.kind, command, p.baseUrl);
      return {
        ...catalog,
        detail: `${cli.detail}. ${catalog.detail}`,
      };
    }
    // Retained as a defensive future adapter probe; the release gate above
    // makes this unreachable until API execution has conformance coverage.
    const baseUrl = p.baseUrl?.trim();
    if (!baseUrl) return { ok: false, detail: "api-mode provider needs a base URL" };
    try {
      const rawUrl = p.apiFormat === "openai" ? `${baseUrl.replace(/\/$/, "")}/models` : baseUrl;
      const url = await validateOutboundUrl(rawUrl, { allowOllamaLoopback: p.kind === "ollama" });
      const res = await fetch(url, {
        method: "GET",
        headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {},
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
      });
      return res.ok || res.status === 401 || res.status === 403
        ? { ok: res.ok, detail: res.ok ? `reachable (HTTP ${res.status})` : `reachable but auth rejected (HTTP ${res.status}) — check the API key` }
        : { ok: false, detail: `endpoint returned HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: `could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // --- agents ---
  app.get("/api/agents", async () => store.listAgents());
  app.post("/api/agents", async (req, reply) => {
    const body = agentDefinitionSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (body.data.env && Object.keys(body.data.env).length > 0) {
      return reply.code(422).send({
        error: "Agent environment values cannot be persisted; use scoped encrypted Vault secrets.",
      });
    }
    try {
      const existing = store.getAgent(body.data.id);
      const saved = store.upsertAgent(body.data);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: existing ? "agent.updated" : "agent.created",
        entityType: "agent", entityId: saved.id, summary: `Agent "${saved.name}" saved`,
        metadata: { providerId: saved.providerId, isolation: saved.isolation, enabledTools: saved.tools.filter((tool) => tool.enabled).length },
      });
      return saved;
    } catch (error) {
      return reply.code(422).send({
        error: error instanceof Error ? error.message : "agent configuration is invalid",
      });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/agents/:id", async (req, reply) => {
    const existing = store.getAgent(req.params.id as AgentId);
    try {
      store.deleteAgent(req.params.id as AgentId);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: "agent.deleted", entityType: "agent", entityId: req.params.id,
        summary: existing ? `Agent "${existing.name}" deleted` : "Agent deleted",
      });
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "agent cannot be deleted" });
    }
  });

  // --- Fusion: per-agent config + run audit log ---
  // current config for an agent (or 404 if the agent is unknown)
  app.get<{ Params: { id: string } }>("/api/agents/:id/fusion-config", async (req, reply) => {
    const agent = store.getAgent(req.params.id as AgentId);
    if (!agent) return reply.code(404).send({ error: "unknown agent" });
    return { fusionEnabled: agent.fusionEnabled ?? false, fusionConfig: agent.fusionConfig ?? null };
  });
  // set the config: zod validates shape/size/no-dups, then a server-side check
  // confirms the panel/judge agents EXIST and are not the agent itself (the zod
  // schema can't see the registry). Sets fusionEnabled + fusionConfig.
  app.put<{ Params: { id: string } }>("/api/agents/:id/fusion-config", async (req, reply) => {
    const agent = store.getAgent(req.params.id as AgentId);
    if (!agent) return reply.code(404).send({ error: "unknown agent" });
    const body = req.body as { fusionEnabled?: boolean; fusionConfig?: unknown };
    // DISABLE is a first-class path: when turning Fusion off (or no config given),
    // clear it WITHOUT validating — only validate the config when enabling. This
    // keeps ordinary agent edits and "turn Fusion off" from ever hitting a 400.
    if (body?.fusionEnabled === false || body?.fusionConfig == null) {
      const saved = store.upsertAgent({
        ...agent,
        fusionEnabled: false,
        fusionConfig: undefined,
        updatedAt: new Date().toISOString(),
      });
      appLog.emit("info", "fusion", `fusion disabled for "${saved.name}"`);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: "agent.fusion_disabled", entityType: "agent", entityId: saved.id,
        summary: `Fusion disabled for agent "${saved.name}"`,
      });
      return { fusionEnabled: false, fusionConfig: undefined };
    }
    const parsed = fusionConfigSchema.safeParse(body.fusionConfig);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues });
    const errors = store.validateFusionConfig(agent.id, parsed.data);
    if (errors.length) return reply.code(400).send({ error: errors });
    const saved = store.upsertAgent({
      ...agent,
      fusionEnabled: true,
      fusionConfig: parsed.data,
      updatedAt: new Date().toISOString(),
    });
    appLog.emit("info", "fusion", `fusion config saved for "${saved.name}" (enabled)`);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "agent.fusion_enabled", entityType: "agent", entityId: saved.id,
      summary: `Fusion configuration enabled for agent "${saved.name}"`,
      metadata: { panelSize: saved.fusionConfig?.panelAgentIds.length ?? 0, judgeAgentId: saved.fusionConfig?.judgeAgentId ?? null },
    });
    return { fusionEnabled: saved.fusionEnabled, fusionConfig: saved.fusionConfig };
  });
  // the persisted run log for an agent (newest first)
  app.get<{ Params: { id: string } }>("/api/agents/:id/fusion-runs", async (req) =>
    store.listFusionRuns(req.params.id),
  );
  // one run + its embedded panel results
  app.get<{ Params: { id: string } }>("/api/fusion-runs/:id", async (req, reply) => {
    const run = store.getFusionRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "unknown fusion run" });
    return run;
  });

  // --- teams ---
  app.get("/api/teams", async () => store.listTeams());
  // Least-privilege roster projection for the project-scoped Lead MCP token.
  app.get<{ Querystring: { projectId?: string } }>("/api/orchestration/context", async (req, reply) => {
    const project = req.query.projectId
      ? store.getProject(req.query.projectId as ProjectId)
      : undefined;
    if (!project?.teamId) return reply.code(404).send({ error: "project team not found" });
    const team = store.listTeams().find((item) => item.id === project.teamId);
    if (!team) return reply.code(404).send({ error: "project team not found" });
    const ids = new Set(team.memberAgentIds);
    return {
      team,
      agents: store.listAgents().filter((agent) => ids.has(agent.id)),
    };
  });
  app.post("/api/teams", async (req, reply) => {
    const body = teamSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (body.data.supervisorAgentId) {
      const supervisor = store.getAgent(body.data.supervisorAgentId);
      const provider = supervisor ? store.getProvider(supervisor.providerId) : undefined;
      const capability = provider ? trustedMcpCapability(provider.kind) : undefined;
      if (
        !provider ||
        provider.mode !== "cli" ||
        !provider.enabled ||
        supervisor?.isolation !== "cli" ||
        !capability?.supported
      ) {
        return reply.code(400).send({
          error: supervisor?.isolation !== "cli"
            ? "the team Lead must use the host CLI runtime with a private trusted Daimon MCP adapter"
            : capability?.reason ?? "the team Lead must use an enabled CLI provider with a private trusted MCP adapter",
        });
      }
    }
    try {
      const existing = store.listTeams().find((team) => team.id === body.data.id);
      const saved = store.upsertTeam(body.data);
      if (existing && (
        existing.supervisorAgentId !== saved.supervisorAgentId ||
        JSON.stringify([...existing.memberAgentIds].map(String).sort()) !== JSON.stringify([...saved.memberAgentIds].map(String).sort())
      )) {
        for (const project of store.listProjects().filter((candidate) => candidate.teamId === saved.id)) {
          orchestrationAccess.revokeProject(project.id);
          pm.revokeHostAutomation(project.id);
          const staleLeadSession = worktrees.leadSessionForProject(project.id);
          if (staleLeadSession) await pm.close(staleLeadSession, "killed");
          await scheduler.revokeWorkersOutsideTeam(project.id, saved.memberAgentIds);
        }
      }
      auditRequest(req.headers.authorization, {
        category: "configuration", action: existing ? "team.updated" : "team.created",
        entityType: "team", entityId: saved.id, summary: `Team "${saved.name}" saved`,
        metadata: { supervisorAgentId: saved.supervisorAgentId ?? null, memberCount: saved.memberAgentIds.length },
      });
      return saved;
    } catch (err) {
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : "invalid team" });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/teams/:id", async (req, reply) => {
    const existing = store.listTeams().find((team) => team.id === req.params.id);
    try {
      store.deleteTeam(req.params.id as TeamId);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: "team.deleted", entityType: "team", entityId: req.params.id,
        summary: existing ? `Team "${existing.name}" deleted` : "Team deleted",
      });
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "team cannot be deleted" });
    }
  });

  // --- projects ---
  app.get("/api/projects", async () => store.listProjects());
  app.get("/api/github/status", async () => github.status());
  app.get<{ Params: { id: string } }>("/api/projects/:id/github", async (req, reply) => {
    const project = store.getProject(req.params.id as ProjectId);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const root = project.parentProjectId
      ? store.getProject(project.parentProjectId as ProjectId)
      : project;
    if (!root) return reply.code(409).send({ error: "project root is missing" });
    try {
      return await gitAdmin.githubRemoteAsync(root.path);
    } catch (error) {
      if (error instanceof GitBusyError) {
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof GitTimeoutError) {
        return reply.code(504).send({ error: error.message });
      }
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "could not inspect the GitHub remote",
      });
    }
  });
  app.post<{ Params: { id: string } }>("/api/admin/projects/:id/github", async (req, reply) => {
    const body = z.object({
      repository: z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const project = store.getProject(req.params.id as ProjectId);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const root = project.parentProjectId
      ? store.getProject(project.parentProjectId as ProjectId)
      : project;
    if (!root) return reply.code(409).send({ error: "project root is missing" });
    if (!nativeActionAccess.consume(
      req.headers["x-daimon-native-action"] as string | undefined,
      "configure-github",
      subjectHash({ projectId: root.id, repository: body.data.repository }),
    )) {
      return reply.code(403).send({ error: "a current one-time native GitHub confirmation is required" });
    }
    try {
      const repository = await github.verifyRepository(body.data.repository);
      const remote = gitAdmin.configureGitHubRemote(root.path, repository.nameWithOwner);
      appLog.emit("info", "github", `${root.name} linked to ${repository.nameWithOwner}`);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: "project.github_linked", projectId: root.id,
        entityType: "project", entityId: root.id, summary: `Project "${root.name}" linked to GitHub`,
        metadata: { repository: repository.nameWithOwner },
      });
      return { repository, remote };
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "GitHub repository could not be linked",
      });
    }
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id/git", async (req, reply) => {
    const project = store.getProject(req.params.id as ProjectId);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    try {
      return await git.snapshotAsync(project.path, { commitLimit: 25 });
    } catch (error) {
      if (error instanceof GitBusyError) {
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof GitTimeoutError) {
        return reply.code(504).send({ error: error.message });
      }
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "could not inspect repository",
      });
    }
  });
  app.post("/api/projects", async (req, reply) => {
    const body = projectSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const existingProject = store.getProject(body.data.id);
    const parent = body.data.parentProjectId
      ? store.getProject(body.data.parentProjectId)
      : undefined;
    if (body.data.parentProjectId && !parent) {
      return reply.code(400).send({ error: "unknown parent project" });
    }
    if (parent?.parentProjectId) {
      return reply.code(400).send({ error: "feature projects can only be nested under a root project" });
    }
    if (existingProject && existingProject.parentProjectId !== body.data.parentProjectId) {
      return reply.code(409).send({ error: "a project's root/feature relationship cannot be changed" });
    }
    let approvedPath: string;
    try {
      approvedPath = parent?.path ?? approveProjectRoot(body.data.path);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid project path" });
    }
    const pathChanged = !existingProject || existingProject.path !== approvedPath;
    if (
      !parent && pathChanged && isRendererRequest(req.headers.authorization) &&
      !consumePathApproval(approvedPath, req.headers["x-daimon-path-approval"])
    ) {
      return reply.code(403).send({
        error: "select this project directory with the native folder picker before saving",
      });
    }
    let saved;
    try {
      if (existingProject && existingProject.teamId !== body.data.teamId) {
        orchestrationAccess.revokeProject(existingProject.id);
        pm.revokeHostAutomation(existingProject.id);
        const staleLeadSession = worktrees.leadSessionForProject(existingProject.id);
        if (staleLeadSession) await pm.close(staleLeadSession);
        const replacementTeam = body.data.teamId
          ? store.listTeams().find((candidate) => candidate.id === body.data.teamId)
          : undefined;
        await scheduler.revokeWorkersOutsideTeam(existingProject.id, replacementTeam?.memberAgentIds ?? []);
      }
      saved = store.upsertProject({ ...body.data, path: approvedPath });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "invalid project hierarchy" });
    }
    // centralized memory: initialize projects/{id} memory on create (NEVER inside
    // the workspace path). Best-effort — a disabled/erroring memory subsystem must
    // not block project creation; we log and continue (the project is marked
    // pending and can be initialized later via the init endpoint).
    maybeInitProjectMemory(store, memory, appLog, saved);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: existingProject ? "project.updated" : "project.created",
      projectId: saved.id, entityType: "project", entityId: saved.id, summary: `Project "${saved.name}" saved`,
      metadata: { parentProjectId: saved.parentProjectId ?? null, teamId: saved.teamId ?? null },
    });
    return saved;
  });
  // initialize (or re-attempt) centralized memory for a project — used by the UI
  // and by the create/start hooks when memory was off or failed at create time
  app.post<{ Params: { id: string } }>("/api/projects/:id/memory/init", async (req, reply) => {
    const project = store.getProject(req.params.id as ProjectId);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const settings = store.getMemorySettings();
    if (!settings.enabled || !settings.enableProjectMemory) {
      return reply.code(409).send({ error: "centralized project memory is disabled" });
    }
    try {
      const entry = memory.initProjectMemory(project);
      return { ok: true, entry };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : "failed to init project memory" });
    }
  });
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const rootProject = store.getProject(req.params.id as ProjectId);
    const removed = [
      req.params.id,
      ...store
        .listProjects()
        .filter((project) => project.parentProjectId === req.params.id)
        .map((project) => project.id),
    ];
    const removedSet = new Set(removed);
    const liveSessions = pm.snapshot().filter((snapshot) =>
      snapshot.session.projectId && removedSet.has(snapshot.session.projectId));
    const unsettledRuns = durable.listUnsettledRunsForProjects(removed);
    if (liveSessions.length || unsettledRuns.length) {
      return reply.code(409).send({
        error:
          "project deletion is blocked while agents or reviewable runs are active; close the panes and resolve or reject pending evidence first",
        liveSessions: liveSessions.map((snapshot) => snapshot.channel),
        unsettledRuns: unsettledRuns.map((run) => run.id),
      });
    }
    const removedTaskIds = store
      .listTasks()
      .filter((task) => removedSet.has(task.projectId))
      .map((task) => task.id);
    scheduler.revokeCompletionCapabilities(removedTaskIds);
    for (const taskId of removedTaskIds) {
      durable.resolveAttentionForTask(taskId, "project deleted by the local operator");
    }
    for (const projectId of removed) {
      orchestrationAccess.revokeProject(projectId);
      pm.revokeHostAutomation(projectId);
    }
    store.deleteProject(req.params.id as ProjectId);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "project.deleted", projectId: rootProject?.id,
      entityType: "project", entityId: req.params.id,
      summary: rootProject ? `Project "${rootProject.name}" and its feature configuration deleted` : "Project configuration deleted",
      metadata: { removedProjectCount: removed.length, removedTaskCount: removedTaskIds.length },
    });
    broadcast({ kind: "config_changed" });
    return { ok: true, removedProjectIds: removed };
  });

  // --- project deliverables (text files workers wrote into the project folder) ---
  // Lets the Review UI show the agent's actual output, not just the instruction.
  const DELIVERABLE_EXT = new Set([
    ".md", ".markdown", ".txt", ".json", ".yaml", ".yml", ".ts", ".tsx", ".js",
    ".jsx", ".py", ".sql", ".sh", ".csv", ".html", ".css", ".toml", ".mjs", ".cjs",
  ]);
  const SKIP_DIRS = new Set([
    "node_modules", ".git", ".next", "dist", "build", "out", ".venv", "__pycache__", ".turbo",
  ]);
  const MAX_FILE_BYTES = 512 * 1024;
  const isReadableDeliverablePath = (relativePath: string): boolean => {
    if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) return false;
    const segments = relativePath.split(/[\\/]+/);
    if (
      segments.length === 0 ||
      segments.length > 3 ||
      segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith(".") || SKIP_DIRS.has(segment))
    ) {
      return false;
    }
    return DELIVERABLE_EXT.has(path.extname(segments[segments.length - 1]!).toLowerCase());
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/deliverables", async (req, reply) => {
    const project = store.getProject(req.params.id as ProjectId);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    let root: string;
    try {
      root = fs.realpathSync.native(project.path);
      if (!fs.statSync(root).isDirectory()) return { root: project.path, files: [] };
    } catch {
      return { root: project.path, files: [] };
    }
    const files: Array<{ name: string; relPath: string; ext: string; size: number; mtimeMs: number }> = [];
    const walk = (dir: string, depth: number) => {
      if (files.length >= 200 || depth > 2) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(abs, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!DELIVERABLE_EXT.has(ext)) continue;
        try {
          const st = fs.statSync(abs);
          files.push({ name: e.name, relPath: path.relative(root, abs), ext, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* unreadable — skip */
        }
        if (files.length >= 200) return;
      }
    };
    walk(root, 0);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { root, files };
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/file",
    async (req, reply) => {
      const project = store.getProject(req.params.id as ProjectId);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const rel = (req.query.path ?? "").trim();
      if (!rel) return reply.code(400).send({ error: "missing path" });
      if (!isReadableDeliverablePath(rel)) {
        return reply.code(403).send({ error: "path is not an exposed deliverable" });
      }
      let abs: string;
      try {
        abs = resolveProjectFile(project.path, rel);
        const st = fs.statSync(abs);
        if (!st.isFile()) return reply.code(400).send({ error: "not a file" });
        const truncated = st.size > MAX_FILE_BYTES;
        const content = fs.readFileSync(abs).subarray(0, MAX_FILE_BYTES).toString("utf8");
        return { path: rel, size: st.size, truncated, content };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : "not found or unreadable" });
      }
    },
  );
  // start the team Lead for a project: spawns the supervisor agent (resident),
  // wired to the daimon-mcp server + a PM prompt built from the goal + roster
  app.post<{ Params: { id: string } }>("/api/projects/:id/start", async (req, reply) => {
    const project = store.getProject(req.params.id as ProjectId);
    if (!project) return reply.code(404).send({ error: "unknown project" });
    const startTeam = project.teamId
      ? store.listTeams().find((candidate) => candidate.id === project.teamId)
      : undefined;
    if (!nativeActionAccess.consume(
      req.headers["x-daimon-native-action"] as string | undefined,
      "start-project",
      subjectHash({
        projectId: project.id,
        teamId: project.teamId ?? null,
        supervisorAgentId: startTeam?.supervisorAgentId ?? null,
        memberAgentIds: [...(startTeam?.memberAgentIds ?? [])].map(String).sort(),
      }),
    )) {
      return reply.code(403).send({ error: "a current one-time native project-start confirmation is required" });
    }
    // ensure centralized memory exists before the Lead starts decomposing work
    // (best-effort — never blocks the Start flow)
    maybeInitProjectMemory(store, memory, appLog, project);
    const orchestrationToken = orchestrationAccess.rotate(project.id, project.teamId, {
      supervisorAgentId: startTeam?.supervisorAgentId,
      memberAgentIds: startTeam?.memberAgentIds ?? [],
    });
    let leadCwd: string;
    try {
      leadCwd = worktrees.prepareLead(project.path, project.id, crypto.randomUUID());
    } catch (error) {
      orchestrationAccess.revokeProject(project.id);
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "could not prepare isolated Lead worktree",
      });
    }
    let spawn;
    try {
      spawn = buildLeadSpawn(store, project, orchestrationToken, leadCwd);
    } catch (error) {
      worktrees.cleanupUnregisteredLead(project.path, leadCwd);
      orchestrationAccess.revokeProject(project.id);
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "invalid team Lead configuration",
      });
    }
    if (!spawn) {
      worktrees.cleanupUnregisteredLead(project.path, leadCwd);
      orchestrationAccess.revokeProject(project.id);
      return reply
        .code(400)
        .send({ error: "project needs an attached team with a supervisor agent" });
    }
    try {
      const team = startTeam;
      const approvedRoster: string[] = team
        ? [...new Set([
            ...(team.supervisorAgentId ? [team.supervisorAgentId as string] : []),
            ...team.memberAgentIds.map((id) => id as string),
          ])]
        : [];
      pm.grantHostAutomation(project.id, approvedRoster);
      const session = await pm.spawn(spawn);
      worktrees.registerLeadSession(session.id as string, project.id, project.path, leadCwd);
      // announce the Lead pane to every client + log it
      broadcast({ kind: "session_started", session });
      appLog.emit("info", "lead", `Lead "${session.agentName}" online for ${project.name}`);
      auditRequest(req.headers.authorization, {
        category: "work", action: "project.started", projectId: project.id,
        entityType: "session", entityId: session.id, summary: `Lead "${session.agentName}" started for project "${project.name}"`,
        metadata: { teamId: project.teamId ?? null, agentId: spawn.agentId },
      });

      // a visible "planning" task so the board shows orchestration has STARTED
      // (the Lead is a terminal, not a task — without this the Kanban looks empty
      // until the Lead emits its first create_task). Tied to the Lead's channel so
      // it moves to waiting_review when the Lead finishes; in_progress means the
      // scheduler never tries to dispatch a second worker for it.
      const now = new Date().toISOString();
      const planningTask = taskSchema.safeParse({
        id: crypto.randomUUID(),
        projectId: project.id,
        title: `Plan & delegate: ${project.name}`,
        description: "The Lead is decomposing the project goal into tasks and assigning them to the team.",
        assignedAgentId: spawn.agentId,
        assignedAgentName: session.agentName,
        status: "in_progress",
        dependsOn: [],
        createdBy: "lead",
        channel: session.id,
        createdAt: now,
        updatedAt: now,
      });
      if (planningTask.success) {
        store.upsertTask(planningTask.data);
        broadcast({ kind: "tasks_changed", projectId: project.id });
      }
      return session;
    } catch (err) {
      worktrees.cleanupUnregisteredLead(project.path, leadCwd);
      orchestrationAccess.revokeProject(project.id);
      pm.revokeHostAutomation(project.id);
      return reply
        .code(400)
        .send({ error: err instanceof Error ? err.message : "failed to start Lead" });
    }
  });

  // --- skills ---
  app.get("/api/skills", async () => store.listSkills());
  app.post("/api/skills", async (req, reply) => {
    const body = skillSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const existing = store.getSkill(body.data.id);
    const saved = store.upsertSkill(body.data);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: existing ? "skill.updated" : "skill.created",
      entityType: "skill", entityId: saved.id, summary: `Skill "${saved.name}" saved`,
      metadata: { source: saved.source },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (req) => {
    const existing = store.getSkill(req.params.id);
    store.deleteSkill(req.params.id);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "skill.deleted", entityType: "skill", entityId: req.params.id,
      summary: existing ? `Skill "${existing.name}" deleted` : "Skill deleted",
    });
    return { ok: true };
  });
  // clone a skill into a provider's CLI home (where the kind supports skills)
  app.post<{ Params: { id: string }; Body: { providerKinds?: string[] } }>(
    "/api/skills/:id/clone",
    async (req, reply) => {
      const skill = store.getSkill(req.params.id);
      if (!skill) return reply.code(404).send({ error: "unknown skill" });
      const kinds = z.array(providerKindSchema).safeParse(req.body.providerKinds ?? []);
      if (!kinds.success) return reply.code(400).send({ error: kinds.error.issues });
      const cloned = cloneSkillToProviders(skill.slug, skill.content, kinds.data);
      for (const k of cloned) appLog.emit("info", "skill", `cloned "${skill.name}" → ${k}`);
      auditRequest(req.headers.authorization, {
        category: "configuration", action: "skill.cloned", entityType: "skill", entityId: skill.id,
        summary: `Skill "${skill.name}" cloned to provider homes`, metadata: { providerCount: cloned.length },
      });
      return { cloned };
    },
  );

  // --- goals ---
  app.get("/api/goals", async () => store.listGoals());
  app.post("/api/goals", async (req, reply) => {
    const body = goalSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const existing = store.listGoals().find((goal) => goal.id === body.data.id);
    const saved = store.upsertGoal(body.data);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: existing ? "goal.updated" : "goal.created",
      projectId: saved.projectId, entityType: "goal", entityId: saved.id, summary: `Goal "${saved.title}" saved`,
      metadata: { status: saved.status },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/goals/:id", async (req) => {
    const existing = store.listGoals().find((goal) => goal.id === req.params.id);
    store.deleteGoal(req.params.id);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "goal.deleted", projectId: existing?.projectId,
      entityType: "goal", entityId: req.params.id,
      summary: existing ? `Goal "${existing.title}" deleted` : "Goal deleted",
    });
    return { ok: true };
  });

  // --- blueprints (reusable task-DAG templates) ---
  app.get("/api/blueprints", async () => store.listBlueprints());
  app.post("/api/blueprints", async (req, reply) => {
    const body = blueprintSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const saved = store.upsertBlueprint(body.data);
    appLog.emit("info", "blueprint", `blueprint "${saved.name}" saved`);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "blueprint.saved", entityType: "blueprint", entityId: saved.id,
      summary: `Blueprint "${saved.name}" saved`, metadata: { taskCount: saved.tasks.length },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/blueprints/:id", async (req) => {
    const existing = store.getBlueprint(req.params.id as BlueprintId);
    // deleting a blueprint drops its schedules too — re-arm so removed timers stop
    store.deleteBlueprint(req.params.id as BlueprintId);
    triggers.reload();
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "blueprint.deleted", entityType: "blueprint", entityId: req.params.id,
      summary: existing ? `Blueprint "${existing.name}" deleted` : "Blueprint deleted",
    });
    return { ok: true };
  });

  // --- schedules (cron / interval / watch triggers) ---
  app.get("/api/schedules", async () => store.listSchedules());
  app.post("/api/schedules", async (req, reply) => {
    const body = scheduleSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const saved = store.upsertSchedule(body.data);
    appLog.emit("info", "schedule", `schedule "${saved.name}" (${saved.kind}) saved`);
    triggers.reload(); // arm/disarm/re-time the changed schedule immediately
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "schedule.saved", projectId: saved.projectId,
      entityType: "schedule", entityId: saved.id, summary: `Schedule "${saved.name}" saved`,
      metadata: { kind: saved.kind, enabled: saved.enabled },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req) => {
    const existing = store.listSchedules().find((schedule) => schedule.id === req.params.id);
    store.deleteSchedule(req.params.id as ScheduleId);
    triggers.reload();
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "schedule.deleted", projectId: existing?.projectId,
      entityType: "schedule", entityId: req.params.id,
      summary: existing ? `Schedule "${existing.name}" deleted` : "Schedule deleted",
    });
    return { ok: true };
  });

  // --- instantiate a blueprint onto a project (manual fire) ---
  const instantiateSchema = z.object({
    blueprintId: z.string().uuid(),
    vars: z.record(z.string()).optional(),
  });
  app.post<{ Params: { id: string } }>(
    "/api/projects/:id/instantiate",
    async (req, reply) => {
      const body = instantiateSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const project = store.getProject(req.params.id as ProjectId);
      if (!project) return reply.code(404).send({ error: "unknown project" });
      const blueprint = store.getBlueprint(body.data.blueprintId as BlueprintId);
      if (!blueprint) return reply.code(404).send({ error: "unknown blueprint" });
      let created;
      try {
        created = instantiateBlueprint(store, blueprint, project.id, body.data.vars ?? {}, appLog);
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : "failed to instantiate blueprint" });
      }
      broadcast({ kind: "tasks_changed", projectId: project.id });
      scheduler.onTasksChanged(project.id);
      auditRequest(req.headers.authorization, {
        category: "work", action: "blueprint.instantiated", projectId: project.id,
        entityType: "blueprint", entityId: blueprint.id,
        summary: `Blueprint "${blueprint.name}" instantiated on project "${project.name}"`,
        metadata: { taskCount: created.length },
      });
      return created;
    },
  );

  // --- goal attachments (base64 upload, kept server-side, served back) ---
  const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB
  const MAX_ATTACHMENT_BODY_BYTES = 35 * 1024 * 1024;
  const uploadSchema = z.object({
    name: z.string().min(1).max(255),
    mime: z.string().max(255).default("application/octet-stream"),
    dataBase64: z.string().min(1).max(Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  });
  app.post("/api/attachments", { bodyLimit: MAX_ATTACHMENT_BODY_BYTES }, async (req, reply) => {
    const body = uploadSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const buf = Buffer.from(body.data.dataBase64, "base64");
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      return reply.code(413).send({ error: "attachment exceeds 25 MB" });
    }
    const id = crypto.randomUUID();
    try {
      store.writeAttachmentFile(id, buf, body.data.mime);
    } catch (error) {
      return reply.code(507).send({
        error: error instanceof Error ? error.message : "attachment storage unavailable",
      });
    }
    const attachment = {
      id,
      name: body.data.name,
      mime: body.data.mime,
      size: buf.length,
      isImage: body.data.mime.startsWith("image/"),
    };
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "attachment.staged", entityType: "attachment", entityId: id,
      summary: "Goal attachment staged",
      metadata: { mime: attachment.mime, size: attachment.size },
    });
    return attachment;
  });
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  app.get<{ Params: { id: string } }>("/api/attachments/:id", async (req, reply) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "bad id" });
    const file = store.attachmentFilePath(id);
    if (!file) return reply.code(404).send({ error: "not found" });
    const meta = store.findAttachment(id);
    const mime = store.attachmentMime(id) ?? "application/octet-stream";
    reply.header("content-type", mime);
    if (meta && !meta.isImage) {
      reply.header("content-disposition", `attachment; filename="${meta.name.replace(/"/g, "")}"`);
    }
    return reply.send(fs.createReadStream(file));
  });

  // --- native folder picker ------------------------------------------------
  // The server runs on the operator's own machine (single-operator local app),
  // so "Browse" opens the real OS folder dialog — Finder (macOS), File Explorer
  // (Windows), or a GTK chooser (Linux) — and returns the chosen absolute path.
  // A browser directory picker deliberately hides the real filesystem path, so
  // the dialog has to be driven server-side.
  app.post("/api/fs/pick-folder", async (_req, reply) => {
    if (folderPickerActive) {
      return reply.code(409).send({ error: "a native folder picker is already open" });
    }
    folderPickerActive = true;
    const pick = () =>
      new Promise<{ path: string } | { canceled: true }>((resolve, reject) => {
        let cmd: string;
        let args: string[];
        if (process.platform === "darwin") {
          cmd = "osascript";
          args = ["-e", 'POSIX path of (choose folder with prompt "Select project folder")'];
        } else if (process.platform === "win32") {
          cmd = "powershell";
          args = [
            "-NoProfile",
            "-STA",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select project folder'; if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }",
          ];
        } else {
          cmd = "zenity";
          args = ["--file-selection", "--directory", "--title=Select project folder"];
        }
        // fixed command + args (no user input interpolated → no shell injection);
        // generous timeout because the dialog blocks until the user picks/cancels
        execFile(cmd, args, { timeout: 10 * 60_000 }, (err, stdout) => {
          const out = (stdout ?? "").trim();
          if (out) {
            // osascript yields a trailing-slash POSIX path; normalize (keep "/")
            return resolve({ path: out.length > 1 ? out.replace(/[/\\]+$/, "") : out });
          }
          if (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT")
              return reject(new Error(`no native folder picker available (${cmd} not found)`));
            // user dismissed the dialog: osascript -128, zenity exit 1, empty stdout
            return resolve({ canceled: true });
          }
          return resolve({ canceled: true });
        });
      });
    try {
      const selected = await pick();
      if ("canceled" in selected) return selected;
      const approvedPath = approveProjectRoot(selected.path);
      const approvalToken = randomBytes(32).toString("base64url");
      projectPathApprovals.set(approvalToken, {
        path: approvedPath,
        expiresAt: Date.now() + 5 * 60_000,
      });
      // Opportunistically discard expired unused capabilities.
      for (const [token, approval] of projectPathApprovals) {
        if (approval.expiresAt < Date.now()) projectPathApprovals.delete(token);
      }
      return { path: approvedPath, approvalToken };
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : "folder picker failed" });
    } finally {
      folderPickerActive = false;
    }
  });

  // --- MCP servers ---
  app.get("/api/mcp", async () => store.listMcpServers());
  app.post("/api/mcp", async (req, reply) => {
    const body = mcpServerSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (body.data.env && Object.keys(body.data.env).length > 0) {
      return reply.code(422).send({
        error: "MCP environment values cannot be persisted; use the encrypted project Vault.",
      });
    }
    const existing = store.listMcpServers().find((server) => server.id === body.data.id);
    const saved = store.upsertMcpServer(body.data);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: existing ? "mcp.updated" : "mcp.created",
      entityType: "mcp", entityId: saved.id, summary: `MCP server "${saved.name}" saved`,
      metadata: { transport: saved.transport, enabled: saved.enabled, providerKind: saved.providerKind ?? null },
    });
    return saved;
  });
  app.delete<{ Params: { id: string } }>("/api/mcp/:id", async (req, reply) => {
    const target = store.listMcpServers().find((m) => m.id === req.params.id);
    if (target?.builtin) {
      return reply.code(409).send({ error: "built-in server cannot be deleted" });
    }
    store.deleteMcpServer(req.params.id);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "mcp.deleted", entityType: "mcp", entityId: req.params.id,
      summary: target ? `MCP server "${target.name}" deleted` : "MCP server deleted",
    });
    return { ok: true };
  });

  // --- import from the provider's standard CLI home ---
  app.get<{ Querystring: { kind: string } }>("/api/import/scan", async (req, reply) => {
    const kind = providerKindSchema.safeParse(req.query.kind);
    if (!kind.success) return reply.code(400).send({ error: "unknown kind" });
    return scanProviderHome(kind.data);
  });
  const importApplySchema = z.object({
    providerId: z.string().uuid().optional(),
    /** CLI family the scan came from — tags imported MCP servers so they are
     *  only ever materialized for matching-kind agents */
    kind: providerKindSchema.optional(),
    skills: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
    agents: z.array(z.object({ name: z.string(), path: z.string() })).default([]),
    // client-supplied defs are acceptable here: any local client can already
    // create arbitrary MCP servers via POST /api/mcp — same trust boundary.
    // innerType() drops the transport superRefine (stdio→command, http→url),
    // so each entry is re-validated against the full schema after assembly below
    mcpServers: z
      .array(mcpServerSchema.innerType().omit({ id: true, isDefault: true, enabled: true }))
      .default([]),
  });
  app.post("/api/import/apply", async (req, reply) => {
    const body = importApplySchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { providerId, kind, skills, agents, mcpServers } = body.data;
    if ((skills.length > 0 || agents.length > 0) && !kind) {
      return reply.code(400).send({ error: "provider kind is required for provider-home file imports" });
    }
    if (kind) {
      const scan = scanProviderHome(kind);
      const allowedSkills = new Set(scan.skills.map((item) => `${item.name}\0${item.path}`));
      const allowedAgents = new Set(scan.agents.map((item) => `${item.name}\0${item.path}`));
      if (skills.some((item) => !allowedSkills.has(`${item.name}\0${item.path}`)) ||
          agents.some((item) => !allowedAgents.has(`${item.name}\0${item.path}`))) {
        return reply.code(409).send({ error: "selected import files no longer match a fresh provider-home scan" });
      }
    }
    const now = new Date().toISOString();
    const imported = { skills: 0, agents: 0, mcpServers: 0 };
    for (const s of skills) {
      try {
        // OVERWRITE an existing skill with the same slug instead of duplicating
        // — reuse its id so upsertSkill replaces it in place
        const slug = sanitizeSlug(s.name);
        const existing = store.listSkills().find((x) => sanitizeSlug(x.slug) === slug);
        store.upsertSkill({
          id: existing?.id ?? crypto.randomUUID(),
          slug: s.name,
          name: s.name,
          description: existing?.description ?? "",
          source: "imported",
          content: readImportFile(s.path),
          updatedAt: now,
        });
        imported.skills += 1;
      } catch {
        // unreadable / outside allowed homes — skip, report via counts
      }
    }
    const provider = providerId
      ? store.getProvider(providerId as ProviderId)
      : store.listProviders()[0];
    for (const a of agents) {
      if (!provider) break;
      try {
        store.upsertAgent({
          id: newAgentId(),
          name: a.name,
          description: `imported from ${path.basename(path.dirname(a.path))}`,
          providerId: provider.id,
          systemPrompt: readImportFile(a.path),
          tools: [{ name: "bash", kind: "shell", enabled: true }],
          // imported agents run the REAL provider CLI (subscription login), not
          // the mock demo loop — switch to "mock" per-agent only for testing
          isolation: "cli",
          limits: { maxRuntimeMs: 30 * 60 * 1000 },
          createdAt: now,
          updatedAt: now,
        });
        imported.agents += 1;
      } catch {
        // skip unreadable
      }
    }
    // scope imported servers to the CLI family they came from: explicit `kind`
    // wins, else fall back to the selected provider's kind
    const importKind = kind ?? provider?.kind;
    for (const m of mcpServers) {
      // Imported provider configs frequently contain plaintext credentials.
      // Never copy those values into Daimon config or a project MCP file.
      if (m.env && Object.keys(m.env).length > 0) continue;
      const full = mcpServerSchema.safeParse({
        ...m,
        id: crypto.randomUUID(),
        providerKind: importKind,
        isDefault: false,
        enabled: true,
      });
      if (!full.success) continue; // transport-broken — skip, report via counts
      store.upsertMcpServer(full.data);
      imported.mcpServers += 1;
    }
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "provider_configuration.imported",
      entityType: "provider", entityId: provider?.id ?? providerId ?? "unassigned",
      summary: "Provider configuration import applied",
      metadata: { skills: imported.skills, agents: imported.agents, mcpServers: imported.mcpServers },
    });
    return imported;
  });

  // --- one-click sync: re-scan a provider's CLI home and pull ONLY what's new ---
  // Idempotent: items whose natural key already exists are skipped (never
  // clobbered), so a Claude MCP connection added after setup shows up on the
  // next sync without touching anything already configured.
  app.post<{ Body: { providerId?: string } }>("/api/import/sync", async (req, reply) => {
    const providerId = req.body?.providerId;
    const provider = providerId
      ? store.getProvider(providerId as ProviderId)
      : store.listProviders()[0];
    if (!provider) return reply.code(400).send({ error: "unknown provider" });

    const kind = provider.kind;
    const scan = scanProviderHome(kind);
    const now = new Date().toISOString();
    const added = { skills: [] as string[], agents: [] as string[], mcpServers: [] as string[] };
    const skipped = { skills: 0, agents: 0, mcpServers: 0 };

    const norm = (s: string) => s.trim().toLowerCase();

    // one-click sync pulls only personal ~/.claude/skills — plugin skills (often
    // hundreds) are opt-in via the selective import wizard, never auto-flooded
    for (const s of scan.skills.filter((x) => x.source === "personal")) {
      if (store.listSkills().some((x) => norm(x.name) === norm(s.name))) {
        skipped.skills += 1;
        continue;
      }
      try {
        store.upsertSkill({
          id: crypto.randomUUID(),
          slug: s.name,
          name: s.name,
          description: s.description ?? "",
          source: "imported",
          content: readImportFile(s.path),
          updatedAt: now,
        });
        added.skills.push(s.name);
      } catch {
        // unreadable / outside allowed homes — skip silently
      }
    }

    for (const a of scan.agents) {
      const dup = store
        .listAgents()
        .some((x) => x.providerId === provider.id && norm(x.name) === norm(a.name));
      if (dup) {
        skipped.agents += 1;
        continue;
      }
      try {
        store.upsertAgent({
          id: newAgentId(),
          name: a.name,
          description: `imported from ${path.basename(path.dirname(a.path))}`,
          providerId: provider.id,
          systemPrompt: readImportFile(a.path),
          tools: [{ name: "bash", kind: "shell", enabled: true }],
          // imported agents run the REAL provider CLI (subscription login), not
          // the mock demo loop — switch to "mock" per-agent only for testing
          isolation: "cli",
          limits: { maxRuntimeMs: 30 * 60 * 1000 },
          createdAt: now,
          updatedAt: now,
        });
        added.agents.push(a.name);
      } catch {
        // skip unreadable
      }
    }

    for (const m of scan.mcpServers) {
      if (m.env && Object.keys(m.env).length > 0) {
        skipped.mcpServers += 1;
        continue;
      }
      // a name collision with a same-kind OR universal server would clash on the
      // .mcp.json key — treat either as "already present"
      const dup = store
        .listMcpServers()
        .some((x) => x.name === m.name && (!x.providerKind || x.providerKind === kind));
      if (dup) {
        skipped.mcpServers += 1;
        continue;
      }
      const full = mcpServerSchema.safeParse({
        ...m,
        id: crypto.randomUUID(),
        providerKind: kind,
        isDefault: false,
        enabled: true,
      });
      if (!full.success) continue;
      store.upsertMcpServer(full.data);
      added.mcpServers.push(m.name);
    }

    auditRequest(req.headers.authorization, {
      category: "configuration", action: "provider_configuration.synchronized",
      entityType: "provider", entityId: provider.id, summary: `Provider "${provider.name}" configuration synchronized`,
      metadata: {
        skillsAdded: added.skills.length,
        agentsAdded: added.agents.length,
        mcpServersAdded: added.mcpServers.length,
      },
    });
    return { kind, added, skipped };
  });

  // --- settings & sessions ---
  app.get("/api/settings", async () => store.getSettings());
  app.put("/api/settings", async (req, reply) => {
    const body = orchestratorSettingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const saved = store.updateSettings(body.data);
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "settings.updated", entityType: "settings", entityId: "orchestrator",
      summary: "Orchestrator settings updated",
    });
    return saved;
  });
  app.get("/api/sessions", async () => pm.snapshot());

  // Factory reset — wipe ALL user config (providers, agents, teams, projects,
  // skills, MCP, goals, tasks, blueprints, schedules, secrets) back to a clean
  // slate so the user can start from scratch. Broadcasts config_changed so every
  // connected client reloads (and first-run detection re-opens the Setup Wizard).
  app.post("/api/admin/reset", async (req) => {
    // kill any running agent/shell terminals first — they reference config that's
    // about to vanish, and would otherwise keep running orphaned (burning tokens).
    await pm.closeAllChannels();
    worktrees.factoryReset();
    durable.factoryReset();
    control.factoryReset();
    store.factoryReset();
    auditRequest(req.headers.authorization, {
      category: "security", action: "configuration.factory_reset", outcome: "warning",
      entityType: "configuration", entityId: "all", summary: "Factory reset wiped configuration and closed sessions",
    });
    appLog.emit("warn", "admin", "factory reset — all configuration wiped, sessions closed");
    broadcast({ kind: "config_changed" });
    return { ok: true };
  });

  // --- centralized memory ---
  // settings: GET current, PUT a full validated MemorySettings. A PUT re-resolves
  // the active root so a storageMode/vault change takes effect immediately.
  app.get("/api/settings/memory", async () => store.getMemorySettings());
  app.put("/api/settings/memory", async (req, reply) => {
    const body = memorySettingsSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const current = store.getMemorySettings();
    let obsidianVaultPath = body.data.obsidianVaultPath?.trim();
    if (body.data.storageMode === "obsidian" && obsidianVaultPath) {
      try {
        obsidianVaultPath = approveProjectRoot(obsidianVaultPath);
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "invalid Obsidian vault path",
        });
      }
      const changed = current.obsidianVaultPath !== obsidianVaultPath;
      if (
        changed &&
        isRendererRequest(req.headers.authorization) &&
        !consumePathApproval(obsidianVaultPath, req.headers["x-daimon-path-approval"])
      ) {
        return reply.code(403).send({
          error: "select this Obsidian vault with the native folder picker before saving",
        });
      }
    }
    // activeMemoryRoot is server-resolved — never trust the client's value; strip
    // it and let resolveActiveRoot recompute below
    const { activeMemoryRoot: _ignored, ...rest } = body.data;
    store.updateMemorySettings({ ...rest, obsidianVaultPath });
    memory.resolveActiveRoot();
    appLog.emit("info", "memory", "memory settings updated");
    auditRequest(req.headers.authorization, {
      category: "configuration", action: "memory.settings_updated", entityType: "settings", entityId: "memory",
      summary: "Memory settings updated", metadata: { storageMode: rest.storageMode, enabled: rest.enabled },
    });
    return store.getMemorySettings();
  });
  // validate/resolve the active root (e.g. after pointing at an Obsidian vault)
  app.post("/api/settings/memory/validate", async () => {
    memory.resolveActiveRoot();
    const status = memory.status();
    return {
      ...status,
      ok: status.rootExists && status.writable && !status.lastError,
      error: status.lastError,
    };
  });
  // rescan the tree → rebuild the JSON indexes
  app.post("/api/settings/memory/rebuild-index", async (_req, reply) => {
    try {
      const out = memory.rebuildIndex();
      return { ok: true, ...out };
    } catch (err) {
      return reply
        .code(409)
        .send({ error: err instanceof Error ? err.message : "rebuild failed" });
    }
  });
  // write+delete a probe file to confirm the root is writable
  app.post("/api/settings/memory/test-write", async () => memory.testWrite());
  app.get("/api/settings/memory/status", async () => memory.status());

  // search the keyword index
  app.get<{
    Querystring: {
      q?: string;
      projectId?: string;
      agentId?: string;
      teamId?: string;
      type?: string;
      limit?: string;
      includeInactive?: string;
    };
  }>("/api/memory/search", async (req, reply) => {
    const type = req.query.type ? memoryTypeSchema.safeParse(req.query.type) : undefined;
    if (type && !type.success) return reply.code(400).send({ error: "unknown memory type" });
    return memory.search({
      q: req.query.q,
      projectId: req.query.projectId,
      agentId: req.query.agentId,
      teamId: req.query.teamId,
      type: type?.success ? type.data : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      includeInactive: req.query.includeInactive === "true",
    });
  });
  // write a durable memory (the single-writer entry point)
  app.post("/api/memory/write", async (req, reply) => {
    const body = memoryWriteRequestSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const settings = store.getMemorySettings();
    if (!settings.enabled) return reply.code(409).send({ error: "memory is disabled" });
    try {
      if (settings.requireApprovalBeforeWrite) {
        const proposed = memory.sanitizeWriteRequest(body.data);
        const artifact = durable.putArtifact(
          JSON.stringify(proposed),
          "memory-write-proposal",
          "application/json",
          { projectId: proposed.projectId ?? null, title: proposed.title },
        );
        const request = control.createApproval({
          correlationId: `memory-write:${artifact.sha256}`,
          projectId: proposed.projectId ?? "memory-global",
          taskId: proposed.taskId,
          kind: "memory-write",
          subjectHash: artifact.sha256,
          requestedBy: proposed.capturedBy ?? auditActorFor(req.headers.authorization),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
        });
        if (!request.replay) {
          control.routeApproval({
            approvalId: request.approval.id,
            channel: "desktop",
            recipient: "local-operator",
            status: "pending",
          });
        }
        return reply.code(202).send({ approval: request.approval, replay: request.replay });
      }
      const entry = memory.write(body.data);
      return entry;
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : "write failed" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/memory/approvals/:id/apply", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required to apply memory writes" });
    }
    const approval = control.getApproval(req.params.id);
    if (!approval || approval.kind !== "memory-write") {
      return reply.code(404).send({ error: "unknown memory-write approval" });
    }
    if (approval.appliedAt) return { ok: true, replay: true, approval };
    if (approval.status !== "approved") return reply.code(409).send({ error: "memory write is not approved" });
    try {
      const proposed = memoryWriteRequestSchema.parse(
        JSON.parse(durable.readArtifact(approval.subjectHash).toString("utf8")),
      );
      const entry = memory.write(proposed);
      control.markApprovalApplied(approval.id);
      return { ok: true, entry, approval: control.getApproval(approval.id) };
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "approved memory write failed" });
    }
  });
  app.post<{ Params: { id: string } }>("/api/memory/:id/revoke", async (req, reply) => {
    if (!requireHumanBearer(req.headers.authorization)) {
      return reply.code(403).send({ error: "the global desktop bearer is required to revoke memory" });
    }
    const body = z.object({ reason: z.string().trim().min(1).max(4_096) }).strict().safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    try {
      return memory.revoke(req.params.id, body.data.reason);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "memory revocation failed" });
    }
  });
  // fetch one entry + its markdown body
  app.get<{ Params: { id: string } }>("/api/memory/:id", async (req, reply) => {
    const found = memory.get(req.params.id);
    if (!found) return reply.code(404).send({ error: "unknown memory" });
    return found;
  });
}

/** Best-effort centralized-memory init for a project. Honors the enabled +
 *  initProjectMemoryOnCreate + enableProjectMemory flags; logs and continues on
 *  any failure so it can NEVER block project create/start. */
function maybeInitProjectMemory(
  store: ConfigStore,
  memory: MemoryService,
  appLog: AppLog,
  project: { id: string; name: string; path: string; teamId?: string; createdAt: string },
): void {
  const s = store.getMemorySettings();
  if (!s.enabled || !s.initProjectMemoryOnCreate || !s.enableProjectMemory) return;
  if (memory.hasProjectMemory(project.id)) return;
  try {
    memory.initProjectMemory(project as Parameters<MemoryService["initProjectMemory"]>[0]);
  } catch (err) {
    appLog.emit(
      "warn",
      "memory",
      `project "${project.name}" created but memory init failed (will stay pending): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
