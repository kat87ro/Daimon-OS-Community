import { z } from "zod";
import {
  agentIdSchema,
  blueprintIdSchema,
  projectIdSchema,
  providerIdSchema,
  scheduleIdSchema,
  secretIdSchema,
  sessionIdSchema,
  teamIdSchema,
} from "./ids";

// ---------- Providers ----------

export const modelInfoSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  /** Optional because catalogs must report these values; Daimon never invents them. */
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  inputCostPerMTok: z.number().nonnegative().optional(),
  outputCostPerMTok: z.number().nonnegative().optional(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

export const providerKindSchema = z.enum([
  "claude",
  "gemini",
  "codex",
  "hermes",
  "ollama",
  "lmstudio",
  "openrouter",
  "custom",
]);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** cli = shell out to the provider's CLI (subscription login, no key needed);
 *  api = direct HTTP (key usually required). */
export const providerModeSchema = z.enum(["cli", "api"]);
export type ProviderMode = z.infer<typeof providerModeSchema>;

/** Wire formats a custom/api provider can speak — "openai" + baseUrl covers
 *  most of the ecosystem (Ollama, OpenRouter, Groq, DeepSeek, vLLM…). */
export const apiFormatSchema = z.enum(["openai", "anthropic", "gemini"]);
export type ApiFormat = z.infer<typeof apiFormatSchema>;

/** Raw API keys never appear on this object — only a server-side ref + masked tail. */
export const providerConfigSchema = z.object({
  id: providerIdSchema,
  name: z.string().min(1),
  kind: providerKindSchema,
  mode: providerModeSchema,
  apiFormat: apiFormatSchema.optional(),
  baseUrl: z.string().url().optional(),
  /** CLI binary override for cli mode (local engines use the Codex agent CLI) */
  cliCommand: z.string().optional(),
  apiKeyRef: z.string().min(1),
  maskedKey: z.string().optional(),
  /** Empty means the provider's current native default. */
  defaultModel: z.string().max(256),
  models: z.array(modelInfoSchema),
  rateLimit: z
    .object({
      rpm: z.number().int().positive().optional(),
      tpm: z.number().int().positive().optional(),
    })
    .optional(),
  enabled: z.boolean(),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

/** Kind-specific defaults driving the "New provider" form. */
export const PROVIDER_PRESETS: Record<
  ProviderKind,
  {
    label: string;
    mode: ProviderMode;
    keyOptional: boolean;
    baseUrl?: string;
    apiFormat?: ApiFormat;
    defaultModel: string;
    models: string[];
  }
> = {
  claude: {
    label: "Claude (Anthropic)",
    mode: "cli",
    keyOptional: true,
    defaultModel: "",
    models: [],
  },
  gemini: {
    label: "Gemini (Google)",
    mode: "cli",
    keyOptional: true,
    defaultModel: "",
    models: [],
  },
  codex: {
    label: "Codex (OpenAI)",
    mode: "cli",
    keyOptional: true,
    defaultModel: "",
    models: [],
  },
  hermes: {
    label: "Hermes",
    mode: "cli",
    keyOptional: true,
    defaultModel: "",
    models: [],
  },
  ollama: {
    label: "Ollama (local)",
    // Ollama is the inference engine; Daimon uses Codex's supported local-provider
    // adapter for the actual tool-capable agent loop.
    mode: "cli",
    keyOptional: true,
    baseUrl: "http://127.0.0.1:11434",
    apiFormat: "openai",
    defaultModel: "",
    models: [],
  },
  lmstudio: {
    label: "LM Studio (local)",
    // LM Studio exposes an OpenAI-compatible loopback server. Codex supplies
    // the coding-agent/tool runtime; the selected model remains fully local.
    mode: "cli",
    keyOptional: true,
    baseUrl: "http://127.0.0.1:1234/v1",
    apiFormat: "openai",
    defaultModel: "",
    models: [],
  },
  openrouter: {
    label: "OpenRouter",
    mode: "api",
    keyOptional: false,
    baseUrl: "https://openrouter.ai/api/v1",
    apiFormat: "openai",
    defaultModel: "",
    models: [],
  },
  custom: {
    label: "Custom endpoint",
    mode: "api",
    keyOptional: true,
    apiFormat: "openai",
    defaultModel: "",
    models: [],
  },
};

// ---------- Agents ----------

/** how an agent runs: cli = the provider's real CLI in a PTY (Claude Code,
 *  Codex, Gemini — subscription auth, full TUI); mock = demo loop; docker =
 *  containerized. Field kept as `isolation` for config compatibility. */
export const isolationModeSchema = z.enum(["cli", "mock", "docker"]);
export type IsolationMode = z.infer<typeof isolationModeSchema>;

/**
 * Provider tool-authorization posture. Existing agents with no value are treated
 * as supervised. Host CLI execution accepts only `supervised`: `sandboxed` and
 * `unattended` are policy requests that require Docker isolation.
 */
export const permissionModeSchema = z.enum(["supervised", "sandboxed", "unattended"]);
export type PermissionMode = z.infer<typeof permissionModeSchema>;

const agentEnvironmentSchema = z
  .record(z.string().max(128), z.string().max(16 * 1024))
  .superRefine((env, ctx) => {
    if (Object.keys(env).length > 64) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "environment is limited to 64 entries" });
    }
  });

export const toolBindingSchema = z.object({
  name: z.string().min(1).max(128),
  kind: z.enum(["builtin", "mcp", "shell"]),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean(),
});
export type ToolBinding = z.infer<typeof toolBindingSchema>;

export const agentLimitsSchema = z.object({
  maxRuntimeMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
  maxConcurrentRuns: z.number().int().positive().optional(),
});
export type AgentLimits = z.infer<typeof agentLimitsSchema>;

// ---------- Fusion capability (multi-agent deliberation around an invocation) ----------

/** Per-agent Fusion config. When this agent is dispatched by the Lead in a team/
 *  project, a panel of agents independently analyze the task, a judge compares
 *  them, and the synthesis is injected into THIS agent's context before it runs.
 *  Existence/enabled/not-self checks happen server-side (the registry isn't
 *  visible to zod); the schema enforces shape, panel size, and no duplicates. */
export const fusionConfigSchema = z
  .object({
    panelAgentIds: z.array(agentIdSchema).min(1).max(8),
    judgeAgentId: agentIdSchema,
    includeTeamContext: z.boolean(),
    includeProjectMemory: z.boolean(),
    includeConversationContext: z.boolean(),
    includeAgentMemory: z.boolean(),
    includeFilesContext: z.boolean(),
    timeoutSeconds: z.number().int().positive(),
    maxToolCallsPerAgent: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive().nullable(),
    enabledToolsPolicy: z.enum(["inherit"]),
    failOpen: z.boolean(),
  })
  .superRefine((c, ctx) => {
    const seen = new Set<string>();
    for (const id of c.panelAgentIds) {
      if (seen.has(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate panel agent", path: ["panelAgentIds"] });
      }
      seen.add(id);
    }
    if (seen.has(c.judgeAgentId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "judge agent cannot also be a panel agent", path: ["judgeAgentId"] });
    }
  });
export type FusionConfig = z.infer<typeof fusionConfigSchema>;

export const DEFAULT_FUSION_CONFIG: Omit<FusionConfig, "panelAgentIds" | "judgeAgentId"> = {
  includeTeamContext: true,
  includeProjectMemory: true,
  includeConversationContext: true,
  includeAgentMemory: true,
  includeFilesContext: true,
  timeoutSeconds: 120,
  maxToolCallsPerAgent: 8,
  maxOutputTokens: null,
  enabledToolsPolicy: "inherit",
  failOpen: true,
};

export const agentDefinitionSchema = z.object({
  id: agentIdSchema,
  name: z.string().min(1),
  description: z.string().optional(),
  providerId: providerIdSchema,
  model: z.string().max(512).optional(),
  systemPrompt: z.string().max(256 * 1024),
  tools: z.array(toolBindingSchema).max(128),
  isolation: isolationModeSchema,
  /** Defaults to supervised at runtime for backward compatibility. */
  permissionMode: permissionModeSchema.optional(),
  dockerImage: z.string().optional(),
  env: agentEnvironmentSchema.optional(),
  limits: agentLimitsSchema,
  teamId: teamIdSchema.optional(),
  /** attached skills (skill ids) — mounted into the project on spawn */
  skillIds: z.array(z.string()).optional(),
  /** MCP servers linked to this agent IN ADDITION to the global defaults */
  mcpServerIds: z.array(z.string().uuid()).max(64).optional(),
  /** Least-privilege subset of secrets also approved by the project. */
  secretIds: z.array(secretIdSchema).max(64).optional(),
  /** Explicit opt-in to automatic approval. Undefined/false requires a human
   *  review before dependents are released. */
  autoApproveReview: z.boolean().optional(),
  /** Fusion capability — disabled by default; only applies when this agent is
   *  invoked through the team/project execution path */
  fusionEnabled: z.boolean().optional(),
  fusionConfig: fusionConfigSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

// ---------- Fusion runs (persisted, auditable) ----------

export const fusionRunStatusSchema = z.enum(["running", "completed", "degraded", "failed"]);
export type FusionRunStatus = z.infer<typeof fusionRunStatusSchema>;

export const fusionFailureReasonSchema = z.enum([
  "all_panel_agents_failed",
  "panel_agent_unavailable",
  "judge_agent_unavailable",
  "permission_denied",
  "timeout",
  "tool_error",
  "budget_exceeded",
  "invalid_fusion_config",
  "unexpected_error",
]);
export type FusionFailureReason = z.infer<typeof fusionFailureReasonSchema>;

export const fusionPanelResultSchema = z.object({
  id: z.string(),
  fusionRunId: z.string(),
  agentId: z.string(),
  status: z.enum(["ok", "failed"]),
  output: z.string().optional(),
  error: z.string().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
});
export type FusionPanelResult = z.infer<typeof fusionPanelResultSchema>;

export const fusionRunSchema = z.object({
  id: z.string(),
  invokedAgentId: z.string(),
  teamLeaderAgentId: z.string().optional(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  judgeAgentId: z.string(),
  status: fusionRunStatusSchema,
  /** "ok" | "degraded" (judge failed → raw panel injected) */
  judgeStatus: z.enum(["ok", "degraded", "skipped"]),
  task: z.string(),
  judgeAnalysis: z.string().optional(),
  failureReason: fusionFailureReasonSchema.optional(),
  failedPanelAgentIds: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
});
export type FusionRun = z.infer<typeof fusionRunSchema>;

// ---------- Skills ----------

export const skillSchema = z.object({
  id: z.string().uuid(),
  // slug becomes a filesystem path segment — reject traversal at the edge
  slug: z.string().min(1).regex(/^[a-z0-9-_]+$/i, "slug must be alphanumeric/-/_"),
  name: z.string().min(1),
  description: z.string(),
  source: z.enum(["created", "imported"]),
  /** full SKILL.md markdown — persisted to disk server-side */
  content: z.string(),
  updatedAt: z.string().datetime(),
});
export type Skill = z.infer<typeof skillSchema>;

// ---------- MCP servers ----------

export const mcpServerSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    transport: z.enum(["stdio", "http"]),
    /** stdio transport */
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    /** http/sse transport */
    url: z.string().optional(),
    /** Non-secret environment only. Credential values belong in the encrypted
     *  Vault and are selected per project; never persist them in MCP config. */
    env: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "invalid environment variable name"),
      z.string().max(16 * 1024),
    ).superRefine((env, ctx) => {
      if (Object.keys(env).length > 64) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "environment is limited to 64 entries" });
      }
    }).optional(),
    /** which CLI family this server belongs to. Set = only agents on a
     *  matching-kind provider get it, materialized in THAT CLI's config
     *  format/location. Unset = universal (any provider), legacy default. */
    providerKind: providerKindSchema.optional(),
    /** default servers are linked to EVERY spawned terminal/agent of a
     *  compatible provider kind (see providerKind) */
    isDefault: z.boolean(),
    enabled: z.boolean(),
    /** a core/protected server (e.g. the local node_repl) — editable but NOT
     *  deletable, enforced both in the UI and server-side */
    builtin: z.boolean().optional(),
  })
  .superRefine((server, ctx) => {
    // a broken entry would be written verbatim into real .mcp.json files
    if (server.transport === "stdio" && !server.command?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "stdio transport requires a command",
        path: ["command"],
      });
    }
    if (server.transport === "http" && !server.url?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "http transport requires a url",
        path: ["url"],
      });
    }
  });
export type McpServer = z.infer<typeof mcpServerSchema>;

// ---------- Tasks (orchestration board) ----------

export const taskStatusSchema = z.enum([
  "backlog",
  "blocked", // dependsOn not all done — "waiting for Agent X"
  "in_progress",
  "waiting_review", // worker finished; awaiting human approval
  "done",
  "failed", // dispatch error, crash, or kill — terminal until retried
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  projectId: projectIdSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  assignedAgentId: agentIdSchema.optional(),
  assignedAgentName: z.string().optional(), // denormalized for the board
  status: taskStatusSchema,
  dependsOn: z.array(z.string()),
  /** Fair-scheduler lane. Independent lanes receive service before one busy
   *  producer can consume every available worker slot. */
  lane: z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/).optional(),
  /** Ordering inside a lane. The scheduler clamps the effective value to
   *  -100..100 and preserves FIFO ordering for equal priorities. */
  priority: z.number().int().min(-100).max(100).optional(),
  /** Durable local wake-up boundary. A ready task is not dispatchable before
   *  this instant, even across a gateway restart. */
  notBefore: z.string().datetime().optional(),
  parentTaskId: z.string().optional(),
  createdBy: z.enum(["human", "lead"]),
  /** worker pane channel while the task is running */
  channel: z.string().optional(),
  /** watchdog flag: in_progress but the worker has been silent past the idle
   *  threshold — surfaced in the UI (does NOT change status). Cleared on new
   *  output or any status transition. */
  idle: z.boolean().optional(),
  /** how many times this task has been auto-retried after a failed/crashed run */
  retryCount: z.number().int().nonnegative().optional(),
  /** running/last USD cost of this task's worker (from its Claude transcript) */
  costUsd: z.number().nonnegative().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof taskSchema>;

/** Provider-neutral contract used by both ephemeral workers and the scoped
 *  Lead MCP. requestId is caller-stable so a transport retry cannot create a
 *  second inbox item. The server applies an additional aggregate-byte quota. */
export const TASK_INPUT_LIMITS = Object.freeze({
  promptBytes: 4 * 1024,
  optionCount: 16,
  optionBytes: 512,
  aggregateBytes: 12 * 1024,
  responseBytes: 8 * 1024,
});

const utf8ByteLength = (value: string): number => {
  const Encoder = (globalThis as unknown as {
    TextEncoder: new () => { encode(input: string): Uint8Array };
  }).TextEncoder;
  return new Encoder().encode(value).byteLength;
};

export const taskInputRequestSchema = z.object({
  requestId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(TASK_INPUT_LIMITS.promptBytes),
  options: z.array(
    z.string().trim().min(1).max(TASK_INPUT_LIMITS.optionBytes),
  ).max(TASK_INPUT_LIMITS.optionCount).default([]),
}).strict().superRefine((value, ctx) => {
  const bytes = utf8ByteLength(value.prompt) + value.options.reduce(
    (total, option) => total + utf8ByteLength(option),
    0,
  );
  if (bytes > TASK_INPUT_LIMITS.aggregateBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `input request exceeds ${TASK_INPUT_LIMITS.aggregateBytes} UTF-8 bytes`,
    });
  }
  if (new Set(value.options).size !== value.options.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "input request options must be unique" });
  }
});
export type TaskInputRequest = z.infer<typeof taskInputRequestSchema>;

export const taskInputRequestResultSchema = z.object({
  attentionId: z.string().uuid(),
  projectId: projectIdSchema,
  taskId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  agentId: agentIdSchema.optional(),
  channel: sessionIdSchema.optional(),
  /** App-relative, server-authored navigation hint; never caller-controlled. */
  link: z.string().max(2_048),
  state: z.enum(["open", "resolved"]),
  idempotentReplay: z.boolean(),
}).strict();
export type TaskInputRequestResult = z.infer<typeof taskInputRequestResultSchema>;

export const taskInputResponseSchema = z.object({
  response: z.string().trim().min(1).max(TASK_INPUT_LIMITS.responseBytes),
}).strict().superRefine((value, ctx) => {
  if (utf8ByteLength(value.response) > TASK_INPUT_LIMITS.responseBytes) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `operator response exceeds ${TASK_INPUT_LIMITS.responseBytes} UTF-8 bytes`,
    });
  }
});
export type TaskInputResponse = z.infer<typeof taskInputResponseSchema>;

export const KANBAN_COLUMNS: ReadonlyArray<{ status: TaskStatus; label: string }> = [
  { status: "backlog", label: "Backlog" },
  { status: "in_progress", label: "In Progress" },
  { status: "waiting_review", label: "Waiting for Review" },
  { status: "blocked", label: "Blocked" },
  { status: "failed", label: "Failed" },
  { status: "done", label: "Done" },
];

// ---------- Application log ----------

export const appLogEntrySchema = z.object({
  ts: z.number(),
  level: z.enum(["info", "warn", "error"]),
  source: z.string(),
  message: z.string(),
  channel: z.string().optional(),
  /** long-form body (e.g. an agent's final output) — shown when the row is
   *  expanded in the app log */
  detail: z.string().optional(),
});
export type AppLogEntry = z.infer<typeof appLogEntrySchema>;

// ---------- Teams / org hierarchy ----------

export const teamSchema = z.object({
  id: teamIdSchema,
  name: z.string().min(1),
  parentId: teamIdSchema.nullable(),
  memberAgentIds: z.array(agentIdSchema),
  orchestrationMode: z.enum(["parallel", "sequential", "supervisor"]),
  supervisorAgentId: agentIdSchema.optional(),
  /** reporting line WITHIN the team: memberAgentId → its superior agent id
   *  (who it takes tasks from). Absent entries default to reporting to the
   *  supervisor. The supervisor itself has no entry (it's the root). */
  managers: z.record(agentIdSchema).optional(),
  /** per-team display name for a member: memberAgentId → alias. Does NOT rename
   *  the agent globally — only how it appears within THIS team. Absent = use
   *  the agent's real name. */
  memberNames: z.record(z.string()).optional(),
});
export type Team = z.infer<typeof teamSchema>;

// ---------- Projects ----------

export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string().min(1),
  /**
   * Optional root workspace this project belongs to. A child project is a
   * feature-sized, independently orchestrated scope which shares the root's
   * approved Git checkout. The server deliberately permits one level only so
   * path trust and deletion semantics remain unambiguous.
   */
  parentProjectId: projectIdSchema.optional(),
  /** absolute path on disk — the cwd for every terminal spawned in this project */
  path: z.string().min(1),
  color: z.string().optional(),
  teamId: teamIdSchema.optional(),
  /** vault secrets this project may use — injected as env vars into its agents */
  secretIds: z.array(secretIdSchema).optional(),
  /** spend cap in USD across this project's runs; breaching it pauses workers */
  budgetUsd: z.number().positive().optional(),
  createdAt: z.string().datetime(),
});
export type Project = z.infer<typeof projectSchema>;

// ---------- Secrets vault (cross-project credentials, encrypted at rest) ----------

/** A credential stored encrypted server-side. The raw value NEVER rides the wire
 *  or appears in this object — only the masked tail does. The `key` is the env var
 *  name injected into agents of any project that opts into this secret. */
export const secretSchema = z.object({
  id: secretIdSchema,
  /** env var name injected into the agent process, e.g. INSTAGRAM_TOKEN */
  key: z
    .string()
    .min(1)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid env var name (A-Z, 0-9, _)"),
  /** human label, e.g. "Instagram access token" */
  label: z.string().optional(),
  /** logical grouping for the UI, e.g. "Instagram", "Facebook" */
  group: z.string().optional(),
  /** display-only tail of the value, e.g. "abc…xyz"; the raw value is encrypted */
  maskedValue: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Secret = z.infer<typeof secretSchema>;

// ---------- Blueprints (reusable task-DAG templates) + Schedules/Triggers ----------

/** One task in a blueprint. `ref` is a blueprint-local id used by other tasks'
 *  dependsOn; on instantiation each ref becomes a real task id. Title/description
 *  are templates: `{goal}` and any `{var}` are substituted from instantiate vars. */
export const blueprintTaskSchema = z.object({
  ref: z.string().min(1),
  titleTemplate: z.string().min(1),
  descriptionTemplate: z.string().optional(),
  assignedAgentName: z.string().optional(),
  /** refs of other tasks in THIS blueprint that must finish first */
  dependsOn: z.array(z.string()).default([]),
});
export type BlueprintTask = z.infer<typeof blueprintTaskSchema>;

export const blueprintSchema = z
  .object({
    id: blueprintIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    /** team to attach when instantiating onto a project (optional) */
    teamId: teamIdSchema.optional(),
    /** optional goal text to create alongside the tasks (templated) */
    goalTemplate: z.string().optional(),
    tasks: z.array(blueprintTaskSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((bp, ctx) => {
    // refs must be unique — a duplicate would collide in the ref→id map and
    // silently drop a task / mis-wire deps on instantiation
    const seen = new Set<string>();
    for (const t of bp.tasks) {
      if (seen.has(t.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate task ref "${t.ref}" — refs must be unique within a blueprint`,
          path: ["tasks"],
        });
      }
      seen.add(t.ref);
    }
  });
export type Blueprint = z.infer<typeof blueprintSchema>;

/** A 5-field minute-resolution cron expression. Each field accepts: star,
 *  a number N, a step on star (star-slash-N), a number-step (N/N), a range A-B,
 *  a range-step (A-B/N), or a comma-list of those. */
export function isCronExpr(spec: string): boolean {
  const fields = spec.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const field = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/;
  return fields.every((f) => field.test(f));
}

export const scheduleKindSchema = z.enum(["cron", "interval", "watch"]);
export type ScheduleKind = z.infer<typeof scheduleKindSchema>;

/** Fires a blueprint instantiation onto a project automatically.
 *  - cron:     `spec` = 5-field cron expr (minute resolution), e.g. "0 9 * * *"
 *  - interval: `spec` = milliseconds between runs, e.g. "3600000"
 *  - watch:    `spec` = absolute path; a create/change under it fires (debounced) */
export const scheduleSchema = z
  .object({
    id: scheduleIdSchema,
    name: z.string().min(1),
    blueprintId: blueprintIdSchema,
    projectId: projectIdSchema,
    kind: scheduleKindSchema,
    spec: z.string().min(1),
    /** template vars passed to instantiate (e.g. { goal: "…" }) */
    vars: z.record(z.string()).optional(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((s, ctx) => {
    // validate spec per kind so a malformed schedule is rejected at save time
    // rather than silently never firing
    if (s.kind === "cron" && !isCronExpr(s.spec)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "cron spec must be a 5-field expression, e.g. \"0 9 * * *\"", path: ["spec"] });
    } else if (s.kind === "interval") {
      const ms = Number(s.spec);
      if (!Number.isFinite(ms) || ms < 1000) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "interval spec must be milliseconds ≥ 1000", path: ["spec"] });
      }
    } else if (s.kind === "watch" && !s.spec.startsWith("/")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "watch spec must be an absolute path", path: ["spec"] });
    }
  });
export type Schedule = z.infer<typeof scheduleSchema>;

/** Pseudo-project for terminals not assigned to any project tab. */
export const SCRATCH_PROJECT_ID = "scratch" as const;

// ---------- Goals ----------

/** a file/image attached to a goal — bytes live server-side under data/attachments */
export const attachmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** true for image/* — the UI renders a thumbnail */
  isImage: z.boolean(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const goalSchema = z.object({
  id: z.string().uuid(),
  projectId: projectIdSchema,
  title: z.string().min(1),
  status: z.enum(["open", "active", "done"]),
  notes: z.string().optional(),
  /** the long-form goal body — markdown, as detailed as the user wants */
  description: z.string().optional(),
  /** files & pictures attached to the goal */
  attachments: z.array(attachmentSchema).optional(),
  createdAt: z.string().datetime(),
});
export type Goal = z.infer<typeof goalSchema>;

// ---------- Terminal sessions (runs) ----------

/**
 * `chat` is an operator-started, provider-native conversation. It deliberately
 * has no persisted AgentDefinition, project authority, tools, or vault scope.
 */
export const sessionKindSchema = z.enum(["agent", "shell", "chat"]);
export type SessionKind = z.infer<typeof sessionKindSchema>;

export const runStatusSchema = z.enum([
  "spawning",
  "running",
  "waiting_tool",
  "paused",
  "completed",
  "failed",
  "killed",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "completed",
  "failed",
  "killed",
]);

export const runMetricsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type RunMetrics = z.infer<typeof runMetricsSchema>;

export const emptyMetrics = (): RunMetrics => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  toolCalls: 0,
  durationMs: 0,
});

export const exitReasonSchema = z.enum([
  "completed",
  "killed",
  "crashed",
  "timeout",
  "budget_exceeded",
]);
export type ExitReason = z.infer<typeof exitReasonSchema>;

export const terminalSessionSchema = z.object({
  id: sessionIdSchema,
  kind: sessionKindSchema,
  /** present only for kind === "agent" */
  agentId: agentIdSchema.optional(),
  /** present only for kind === "chat" */
  providerId: providerIdSchema.optional(),
  /** exact provider-reported model id; absent means the provider's native default */
  model: z.string().min(1).max(256).optional(),
  /** display name: agent name, or shell displayName / folder basename */
  agentName: z.string(),
  /** agent's role for the floating chip, e.g. "Software Engineer" */
  role: z.string().optional(),
  projectId: z.string().optional(),
  cwd: z.string().optional(),
  status: runStatusSchema,
  statusLabel: z.string(),
  activeTools: z.array(z.string()),
  pid: z.number().int().optional(),
  containerId: z.string().optional(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
  exitReason: exitReasonSchema.optional(),
  metrics: runMetricsSchema,
});
export type TerminalSession = z.infer<typeof terminalSessionSchema>;

// ---------- Orchestrator (global) settings ----------

export const orchestratorSettingsSchema = z.object({
  maxConcurrentSessions: z.number().int().positive(),
  defaultIsolation: isolationModeSchema,
  scrollbackLines: z.number().int().positive(),
  theme: z.enum(["dark", "light", "system"]),
  telemetry: z.object({ metricsIntervalMs: z.number().int().positive() }),
  /** Fixed gateway listen port. 0 / undefined = automatic (OS-assigned in the
   *  desktop app, DEFAULT_SERVER_PORT in standalone). A positive value pins the
   *  gateway to that port — overriding the default — so it can be reached at a
   *  known address for testing. Applied at gateway startup (needs a restart);
   *  falls back to an OS-assigned port if the chosen one is already in use. */
  gatewayPort: z.number().int().min(0).max(65535).optional(),
  /** First-run Setup Wizard completed/dismissed. Undefined/false on a fresh
   *  (empty) install → the wizard opens once; set true on finish or skip so it
   *  never nags again. */
  onboarded: z.boolean().optional(),
  /** Watchdog: flag an in_progress worker that has been silent past idleMs.
   *  Surface-only — never changes task status. Optional for back-compat with
   *  configs written before this field existed (ConfigStore fills the default). */
  watchdog: z
    .object({
      enabled: z.boolean(),
      idleMs: z.number().int().positive(),
    })
    .optional(),
});
export type OrchestratorSettings = z.infer<typeof orchestratorSettingsSchema>;
