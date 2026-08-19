import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import { GATEWAY_WS_PATH, WS_MAX_PAYLOAD_BYTES } from "@daimon-os/shared";
import { ConfigStore } from "./config/ConfigStore";
import { acquireInstanceLock } from "./config/instanceLock";
import { MemoryService } from "./memory/MemoryService";
import { AppLog } from "./gateway/AppLog";
import { GatewayServer } from "./gateway/GatewayServer";
import { CostTracker } from "./process/CostTracker";
import { FusionExecutionService } from "./process/FusionExecutionService";
import { ProcessManager } from "./process/ProcessManager";
import { Scheduler } from "./process/Scheduler";
import { Triggers } from "./process/Triggers";
import { instantiateBlueprint } from "./process/blueprint";
import { DurableExecutionStore } from "./durable/DurableExecutionStore";
import { WorktreeManager } from "./durable/WorktreeManager";
import { ControlKernel } from "./control/ControlKernel";
import type { LivenessState } from "./control/types";
import { createGitService, type GitReadService } from "./git";
import { GitHubService } from "./github/GitHubService";
import { AuditStore } from "./audit/AuditStore";
import { AUDIT_RETENTION_MS } from "@daimon-os/shared";
import { CliRunner } from "./runners/CliRunner";
import { DockerRunner } from "./runners/DockerRunner";
import { MockRunner } from "./runners/MockRunner";
import {
  DAIMON_WS_PROTOCOL,
  NativeActionAccess,
  OrchestrationAccess,
  bearerToken,
  isHighEntropyToken,
  isLoopbackHost,
  tokenFromWebsocketProtocols,
  tokensEqual,
} from "./security/auth";

export interface DaimonApp {
  fastify: FastifyInstance;
  store: ConfigStore;
  pm: ProcessManager;
  gateway: GatewayServer;
  scheduler: Scheduler;
  triggers: Triggers;
  costTracker: CostTracker;
  fusion: FusionExecutionService;
  memory: MemoryService;
  durable: DurableExecutionStore;
  control: ControlKernel;
  audit: AuditStore;
  worktrees: WorktreeManager;
  git: GitReadService;
  orchestrationAccess: OrchestrationAccess;
  appLog: AppLog;
  wss: WebSocketServer;
  port: number;
  close(): Promise<void>;
}

const DEFAULT_DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
);

export async function createApp(opts: {
  port: number;
  dataDir?: string;
}): Promise<DaimonApp> {
  const host = process.env.DAIMON_HOST ?? "127.0.0.1";
  const loopbackOnly = isLoopbackHost(host);
  const authToken = process.env.DAIMON_AUTH_TOKEN?.trim() || undefined;
  const rendererToken = process.env.DAIMON_RENDERER_TOKEN?.trim() || undefined;
  if (!loopbackOnly && (!authToken || !isHighEntropyToken(authToken))) {
    throw new Error(
      "refusing non-loopback gateway bind without a high-entropy DAIMON_AUTH_TOKEN " +
      "(use crypto.randomBytes(32).toString('base64url'))",
    );
  }
  if (!authToken) {
    throw new Error(
      "DAIMON_AUTH_TOKEN is required, including on loopback; generate one with " +
      "crypto.randomBytes(32).toString('base64url')",
    );
  }
  if (rendererToken && (!isHighEntropyToken(rendererToken) || tokensEqual(rendererToken, authToken))) {
    throw new Error("DAIMON_RENDERER_TOKEN must be high-entropy and distinct from the admin bearer");
  }
  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  // refuse a second live instance on the same data dir — two writers corrupt config
  const releaseLock = acquireInstanceLock(dataDir);
  const store = new ConfigStore(dataDir);
  const durable = new DurableExecutionStore(path.join(dataDir, "execution"));
  const control = new ControlKernel(path.join(dataDir, "control"));
  const audit = new AuditStore(path.join(dataDir, "audit"));
  if (audit.summary().total === 0) {
    audit.record({
      category: "configuration",
      action: "configuration.snapshot",
      actor: "system",
      entityType: "configuration",
      entityId: "current",
      summary: "Current configuration snapshot registered at gateway startup",
      metadata: {
        providers: store.listProviders().length,
        agents: store.listAgents().length,
        teams: store.listTeams().length,
        projects: store.listProjects().length,
        goals: store.listGoals().length,
        skills: store.listSkills().length,
        mcpServers: store.listMcpServers().length,
        schedules: store.listSchedules().length,
      },
    });
    const retentionCutoff = Date.now() - AUDIT_RETENTION_MS;
    for (const run of durable.listRuns().filter((candidate) => Date.parse(candidate.startedAt) >= retentionCutoff)) {
      audit.recordHistorical({
        category: "work",
        action: "run.snapshot",
        actor: "system",
        projectId: run.projectId,
        entityType: "run",
        entityId: run.id,
        summary: `Recent durable run is ${run.status}`,
        outcome: run.status === "failed" || run.status === "blocked" ? "failure" : "success",
        metadata: {
          taskId: run.taskId,
          status: run.status,
          subjectHash: run.subjectHash ?? null,
        },
      }, Date.parse(run.startedAt));
    }
  }
  const gitImplementation = createGitService(dataDir);
  const git: GitReadService = gitImplementation;
  const github = new GitHubService();
  const worktrees = new WorktreeManager(
    path.join(dataDir, "execution"),
    durable,
    gitImplementation,
  );
  worktrees.recoverInterruptedRuns();
  for (const effect of control.listEffects("planned").filter((candidate) => candidate.kind === "git-promotion")) {
    const run = effect.runId ? durable.getRun(effect.runId) : undefined;
    const subjectHash = run?.subjectHash;
    const inspection = run && subjectHash ? worktrees.inspectPromotionState(run, subjectHash) : "uncertain";
    if (run && subjectHash && inspection === "applied") {
      if (run.status !== "promoted") durable.markPromoted(run.id, subjectHash);
      control.settleEffect(effect.id, "committed", {
        result: { runId: run.id, subjectHash, canonicalRoot: run.canonicalRoot },
        detail: "recovered promotion from exact canonical Git evidence",
      });
    } else if (inspection === "not_applied") {
      control.settleEffect(effect.id, "failed", {
        detail: "recovery verified that the approved Git effect was not applied",
      });
    } else {
      control.settleEffect(effect.id, "uncertain", {
        detail: "gateway restarted during promotion and canonical Git evidence is inconclusive",
      });
    }
  }
  const orchestrationAccess = new OrchestrationAccess();
  const nativeActionAccess = new NativeActionAccess();
  const appLog = new AppLog();
  // centralized memory — single writer; resolve (and create) the active root up
  // front so the first task retrieval / project init has somewhere to write
  const memory = new MemoryService(store, dataDir, appLog);
  memory.resolveActiveRoot();
  // Trusted MCP files may carry a short-lived scoped Lead token. They are
  // per-process runtime state, never durable configuration; remove any residue
  // from a prior crash before accepting a new spawn.
  const trustedMcpRoot = path.join(dataDir, "runtime", "mcp");
  fs.rmSync(trustedMcpRoot, { recursive: true, force: true });
  fs.mkdirSync(trustedMcpRoot, { recursive: true, mode: 0o700 });
  const pm = new ProcessManager(store, {
    cli: new CliRunner(store, trustedMcpRoot),
    mock: new MockRunner(),
    docker: new DockerRunner(store),
  });
  pm.setAppLog(appLog);
  const auditedWorkSources = new Set([
    "attention", "budget", "exit", "fusion", "gateway", "lead", "schedule",
    "scheduler", "spawn", "task",
  ]);
  const stopAuditLogProjection = appLog.subscribe((entry) => {
    if (!auditedWorkSources.has(entry.source)) return;
    audit.record({
      category: entry.source === "gateway" ? "security" : "work",
      action: `${entry.source}.${entry.level}`,
      outcome: entry.level === "error" ? "failure" : entry.level === "warn" ? "warning" : "success",
      actor: "system",
      summary: entry.message,
      metadata: entry.channel ? { channel: entry.channel } : undefined,
    });
  });
  pm.setManagedCwdAuthorizer((projectRoot, requestedCwd) =>
    worktrees.isManagedWorktree(projectRoot, requestedCwd));

  // Browser WebSockets are NOT subject to CORS: without this check, any web
  // page the user visits could open ws://127.0.0.1:<gateway-port> and spawn a shell
  // (drive-by RCE). Browsers always send an Origin header on WS upgrades —
  // pin it to the known dashboard origins. Requests WITHOUT an Origin header
  // (curl, tests, future MCP clients) are allowed: a non-browser local
  // process could exec directly anyway, so the browser is the only vector
  // this gate must close.
  // Remote callers are authenticated as well as origin-checked. An operator can
  // explicitly set DAIMON_ALLOWED_ORIGINS="*", but it is never the default.
  const originsEnv =
    process.env.DAIMON_ALLOWED_ORIGINS ??
    "app://daimon,http://localhost:3000,http://127.0.0.1:3000,http://localhost:3777,http://127.0.0.1:3777";
  const allowAllOrigins = originsEnv.trim() === "*";
  const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, "");
  const allowedOrigins = new Set(
    originsEnv.split(",").map(normalizeOrigin).filter(Boolean),
  );
  if (!loopbackOnly) {
    appLog.emit("warn", "gateway", `bound to ${host} — remote access requires gateway authentication`);
  }

  const fastify = Fastify({ logger: false });
  // CORS only controls which responses a browser may read. It does not stop a
  // cross-origin no-cors POST from executing. Reject hostile browser origins
  // before route dispatch so destructive endpoints cannot be used as CSRF
  // sinks, even in an explicitly unauthenticated test harness.
  fastify.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    const fetchSite = req.headers["sec-fetch-site"];
    const suppliedOriginAllowed =
      typeof origin === "string" && allowedOrigins.has(normalizeOrigin(origin));
    if (
      !allowAllOrigins &&
      ((typeof origin === "string" && !suppliedOriginAllowed) ||
        (typeof origin !== "string" && fetchSite === "cross-site"))
    ) {
      return reply.code(403).send({ error: "browser origin is not allowed" });
    }
  });
  if (authToken) {
    fastify.addHook("preValidation", async (req, reply) => {
      const pathname = (req.raw.url ?? "").split("?", 1)[0];
      // CORS preflight performs no API action and cannot carry Authorization.
      if (
        req.method === "OPTIONS" ||
        pathname === "/api/health" ||
        (req.method === "POST" && /^\/api\/tasks\/[0-9a-f-]+\/review$/i.test(pathname ?? "")) ||
        (req.method === "POST" && /^\/api\/tasks\/[0-9a-f-]+\/input$/i.test(pathname ?? "")) ||
        /^\/api\/tasks\/[0-9a-f-]+\/coordination\/(?:peers|messages|artifacts(?:\/content|\/transfer)?)$/i.test(pathname ?? "") ||
        !pathname?.startsWith("/api/")
      ) {
        return;
      }
      const supplied = bearerToken(req.headers.authorization);
      if (tokensEqual(authToken, supplied)) return;
      if (rendererToken && tokensEqual(rendererToken, supplied)) {
        // The renderer is intentionally less trusted than Electron main. It may
        // operate the ordinary control plane, but cannot call destructive admin
        // routes or use the global human-approval bearer. Desktop-specific review
        // and reset actions cross narrow, native-confirmed IPC capabilities.
        if (
          pathname?.startsWith("/api/admin/") ||
          (pathname === "/api/secrets" && req.method !== "GET") ||
          (pathname?.startsWith("/api/secrets/") && req.method !== "GET") ||
          (pathname === "/api/agents" && req.method === "POST") ||
          (pathname === "/api/projects" && req.method === "POST") ||
          /^\/api\/attention\/[^/]+\/respond$/i.test(pathname ?? "") ||
          (req.method === "POST" && /^\/api\/projects\/[0-9a-f-]+\/start$/i.test(pathname ?? "")) ||
          (pathname === "/api/mcp" && req.method !== "GET") ||
          (pathname?.startsWith("/api/mcp/") && req.method !== "GET") ||
          (pathname?.startsWith("/api/import/") && req.method !== "GET") ||
          (req.method === "POST" && /^\/api\/skills\/[0-9a-f-]+\/clone$/i.test(pathname ?? "")) ||
          /^\/api\/runs\/[^/]+\/(?:approve|promote|diff)$/i.test(pathname ?? "")
        ) {
          return reply.code(403).send({ error: "this action requires a native desktop capability" });
        }
        if (pathname === "/api/providers" && req.method === "POST") {
          const provider = (req.body as { provider?: { id?: string; kind?: string; cliCommand?: string } } | undefined)?.provider;
          const expected = provider?.kind === "claude" ? "claude"
            : provider?.kind === "gemini" ? "gemini"
              : provider?.kind === "codex" || provider?.kind === "ollama" || provider?.kind === "lmstudio"
                ? "codex" : undefined;
          const existingCommand = provider?.id ? store.getProvider(provider.id as never)?.cliCommand : undefined;
          if (
            provider?.cliCommand?.trim() &&
            provider.cliCommand.trim() !== expected &&
            provider.cliCommand.trim() !== existingCommand
          ) {
            return reply.code(403).send({ error: "custom provider executables require the admin API" });
          }
        }
        return;
      }
      const grant = orchestrationAccess.grantFor(supplied);
      if (grant) {
        const grantedProject = store.getProject(grant.projectId as never);
        const grantedTeam = grantedProject?.teamId
          ? store.listTeams().find((candidate) => candidate.id === grantedProject.teamId)
          : undefined;
        const currentRosterHash = grantedTeam
          ? createHash("sha256").update(JSON.stringify([...grantedTeam.memberAgentIds].map(String).sort())).digest("hex")
          : undefined;
        if (!grantedProject || grantedProject.teamId !== grant.teamId ||
            (grant.supervisorAgentId !== undefined && grant.supervisorAgentId !== grantedTeam?.supervisorAgentId) ||
            (grant.rosterHash !== undefined && grant.rosterHash !== currentRosterHash)) {
          orchestrationAccess.revokeProject(grant.projectId);
          return reply.code(403).send({ error: "orchestration credential no longer matches the confirmed project roster" });
        }
        const query = req.query as { projectId?: string } | undefined;
        const body = req.body as { projectId?: string; status?: string } | undefined;
        const taskId =
          /^\/api\/tasks\/([0-9a-f-]+)$/i.exec(pathname)?.[1] ??
          /^\/api\/orchestration\/tasks\/([0-9a-f-]+)\/input$/i.exec(pathname)?.[1];
        // PATCH authorization always uses the authoritative stored task. A scoped
        // caller must never be able to select its authorization scope with body data.
        const taskProjectId = taskId
          ? store.listTasks().find((task) => task.id === taskId)?.projectId
          : body?.projectId;
        if (orchestrationAccess.authorizes(grant, {
          method: req.method,
          pathname,
          projectId: query?.projectId,
          taskProjectId,
          taskStatus: body?.status,
        })) return;
        return reply.code(403).send({ error: "orchestration credential is out of scope" });
      }
      return reply.code(401).send({ error: "unauthorized" });
    });
  }
  // Pin CORS to the same origin allowlist as the WS gate (above) instead of a
  // reflective `origin: true`. Without this, any web page the user visits could
  // issue cross-origin requests to the REST API (drive-by). No-Origin clients
  // (curl, tests, MCP) stay allowed; the LAN "*" opt-in is preserved.
  await fastify.register(cors, {
    origin: (origin, cb) =>
      cb(null, allowAllOrigins || !origin || allowedOrigins.has(normalizeOrigin(origin))),
    // Configuration uses PUT/PATCH and lifecycle actions use DELETE. The CORS
    // plugin's narrower default let POST provider saves work while silently
    // blocking settings and removal flows in the packaged app at preflight.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "content-type",
      "x-daimon-path-approval",
      "x-daimon-completion-capability",
      "x-daimon-input-capability",
      "x-daimon-coordination-capability",
      "x-daimon-native-action",
    ],
  });
  const wss = new WebSocketServer({
    server: fastify.server,
    path: GATEWAY_WS_PATH,
    maxPayload: WS_MAX_PAYLOAD_BYTES,
    handleProtocols: (protocols) =>
      protocols.has(DAIMON_WS_PROTOCOL) ? DAIMON_WS_PROTOCOL : false,
    verifyClient: (info: {
      origin?: string;
      req: { headers: Record<string, string | string[] | undefined> };
    }) => {
      const originAllowed = allowAllOrigins || !info.origin || allowedOrigins.has(normalizeOrigin(info.origin));
      if (!originAllowed) return false;
      if (!authToken) return true;
      const supplied = tokenFromWebsocketProtocols(info.req.headers["sec-websocket-protocol"]);
      if (tokensEqual(authToken, supplied)) {
        (info.req as typeof info.req & { daimonAccess?: string }).daimonAccess = "admin";
        return true;
      }
      if (rendererToken && tokensEqual(rendererToken, supplied)) {
        (info.req as typeof info.req & { daimonAccess?: string }).daimonAccess = "renderer";
        return true;
      }
      return false;
    },
  });
  const gateway = new GatewayServer(wss, pm, appLog);
  // Fusion: panel+judge deliberation injected into a Fusion-enabled agent's prompt
  // before it runs. Headless (no pane), counts toward the cap + cost meter.
  const fusion = new FusionExecutionService(store, pm, memory, appLog);
  // the scheduler drives task→worker dispatch; it broadcasts via the gateway
  const scheduler = new Scheduler(store, pm, (p) => gateway.broadcast(p), appLog, memory, fusion, durable, worktrees, control);
  pm.onLifecycleHook((event) => {
    const task = store.listTasks().find((candidate) => candidate.channel === event.channel);
    const run = durable.getRunBySession(event.channel);
    const terminal = event.session.status === "completed" || event.session.status === "failed" || event.session.status === "killed";
    control.observeLiveness({
      channel: event.channel,
      projectId: event.session.projectId,
      taskId: task?.id ?? run?.taskId,
      runId: run?.id,
      agentId: event.session.agentId,
      state: event.session.status as LivenessState,
      waitReason: event.session.status === "waiting_tool" || event.session.status === "paused"
        ? event.session.statusLabel
        : undefined,
      confidence: event.confidence,
      activeTools: event.session.activeTools,
      outputObserved: event.outputObserved,
      terminal,
    });
  });
  pm.onExitHook((channel, reason) => scheduler.onWorkerExit(channel, reason));
  pm.onExitHook((channel) => {
    const projectId = worktrees.cleanupLeadSession(channel);
    if (projectId) {
      orchestrationAccess.revokeProject(projectId);
      pm.revokeHostAutomation(projectId);
    }
  });
  scheduler.startWatchdog(); // flag in_progress workers that go silent (surface-only)
  scheduler.startControlLoop();
  const costTracker = new CostTracker(store, pm, (p) => gateway.broadcast(p), appLog);
  costTracker.start(); // read live Claude transcripts → token/cost + budget caps
  // schedules/triggers: fire a schedule → instantiate its blueprint onto its
  // project, then nudge the scheduler + clients exactly like a manual instantiate.
  // Guards (these fire UNATTENDED, so bound the blast radius):
  //  - project must still exist (a deleted project's schedule is cascade-removed,
  //    but guard anyway);
  //  - DRAINING: skip if the prior run's tasks for this schedule are still open,
  //    so a fast interval / churning watch path can't pile up unbounded task sets
  //    (execution concurrency is capped, but instantiation wasn't);
  //  - any error is logged, never thrown (a bad blueprint must not kill the ticker).
  const lastRunTasks = new Map<string, string[]>(); // scheduleId → last task ids
  const triggers = new Triggers(store, (schedule) => {
    try {
      if (!store.getProject(schedule.projectId as Parameters<ConfigStore["getProject"]>[0])) {
        appLog.emit("warn", "schedule", `"${schedule.name}" → project no longer exists — skipped`);
        return;
      }
      const blueprint = store.getBlueprint(schedule.blueprintId);
      if (!blueprint) {
        appLog.emit("warn", "schedule", `"${schedule.name}" references a missing blueprint — skipped`);
        return;
      }
      const prev = lastRunTasks.get(schedule.id) ?? [];
      if (prev.length) {
        const open = store
          .listTasks(schedule.projectId)
          .filter((t) => prev.includes(t.id) && t.status !== "done" && t.status !== "failed");
        if (open.length) {
          appLog.emit("info", "schedule", `"${schedule.name}" skipped — previous run still has ${open.length} open task(s)`);
          return;
        }
      }
      const created = instantiateBlueprint(store, blueprint, schedule.projectId, schedule.vars ?? {}, appLog);
      lastRunTasks.set(schedule.id, created.map((t) => t.id));
      appLog.emit("info", "schedule", `"${schedule.name}" fired → ${created.length} task(s)`);
      scheduler.onTasksChanged(schedule.projectId);
      gateway.broadcast({ kind: "tasks_changed", projectId: schedule.projectId });
    } catch (err) {
      appLog.emit("error", "schedule", `"${schedule.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  triggers.start();
  const { registerRoutes } = await import("./routes");
  registerRoutes(
    fastify,
    store,
    pm,
    appLog,
    scheduler,
    triggers,
    costTracker,
    memory,
    orchestrationAccess,
    nativeActionAccess,
    durable,
    control,
    audit,
    worktrees,
    git,
    gitImplementation,
    github,
    (p) => gateway.broadcast(p),
  );

  // A configured fixed port (Orchestrator settings) OVERRIDES the caller's port —
  // this is how a user pins the gateway to a known address for testing. 0/undefined
  // means "use the caller's port" (OS-assigned 0 in desktop, DEFAULT in standalone).
  const configuredPort = store.getSettings().gatewayPort;
  const desiredPort = configuredPort && configuredPort > 0 ? configuredPort : opts.port;
  try {
    await fastify.listen({ port: desiredPort, host });
  } catch (err) {
    // A pinned port that's already taken must NOT crash the gateway — fall back to
    // an OS-assigned free port so the app still boots (workers learn the real port).
    const code = (err as NodeJS.ErrnoException)?.code;
    if (desiredPort !== 0 && (code === "EADDRINUSE" || code === "EACCES")) {
      appLog.emit(
        "warn",
        "gateway",
        `configured port ${desiredPort} unavailable (${code}) — falling back to an OS-assigned port`,
      );
      await fastify.listen({ port: 0, host });
    } else {
      throw err;
    }
  }
  const address = fastify.server.address();
  const port = typeof address === "object" && address ? address.port : desiredPort;
  // Publish the AUTHORITATIVE bound port to the env so every in-process reader
  // (Scheduler's worker self-report curl, lead.ts's MCP gateway URL) targets the
  // real port — regardless of entry point (desktop/standalone), a configured
  // gatewayPort override, or an EADDRINUSE fallback. This is the single source of
  // truth for the live port; desktop-entry.ts no longer needs its own write.
  process.env.DAIMON_PORT = String(port);

  return {
    fastify,
    store,
    pm,
    gateway,
    scheduler,
    triggers,
    costTracker,
    fusion,
    memory,
    durable,
    control,
    audit,
    worktrees,
    git,
    orchestrationAccess,
    appLog,
    wss,
    port,
    close: async () => {
      scheduler.stopWatchdog();
      scheduler.stopControlLoop();
      triggers.stop();
      costTracker.stop();
      orchestrationAccess.clear();
      nativeActionAccess.clear();
      gateway.dispose();
      await pm.shutdown();
      stopAuditLogProjection();
      durable.close();
      control.close();
      audit.close();
      for (const client of wss.clients) client.terminate();
      await fastify.close();
      releaseLock();
    },
  };
}
