import type {
  AgentDefinition,
  AppLogEntry,
  AuditCategory,
  AuditEntry,
  AuditSummary,
  Attachment,
  Blueprint,
  ChannelSnapshot,
  FusionConfig,
  FusionPanelResult,
  FusionRun,
  Goal,
  McpServer,
  MemoryEntry,
  MemorySettings,
  MemoryStatus,
  ModelInfo,
  OrchestratorSettings,
  Project,
  ProviderConfig,
  ProviderKind,
  Schedule,
  Secret,
  Skill,
  Task,
  Team,
} from "@daimon-os/shared";

/** the run-detail endpoint returns a FusionRun with its panel results attached */
export type FusionRunDetail = FusionRun & { panelResults: FusionPanelResult[] };

export interface ImportScan {
  skills: Array<{
    name: string;
    path: string;
    description: string;
    source: "personal" | "plugin";
    plugin?: string;
  }>;
  agents: Array<{ name: string; path: string; description: string }>;
  mcpServers: Array<Omit<McpServer, "id" | "isDefault" | "enabled">>;
  /** claude.ai account connectors (names only — informational, not importable) */
  connectors: string[];
}
import { useAppLogStore } from "@/stores/applog";
import { gatewayAuthToken, serverHttp } from "./env";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const token = gatewayAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${serverHttp()}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const message = `${init?.method ?? "GET"} ${path} → ${res.status}`;
    const full = detail ? `${message}: ${detail}` : message;
    // surfaced in the Application Log (with detail + unread-error badge); the
    // caller still gets the thrown error for inline handling.
    useAppLogStore.getState().append({
      ts: Date.now(),
      level: "error",
      source: "ui",
      message,
      detail: detail || undefined,
    });
    throw new Error(full);
  }
  return (await res.json()) as T;
}

async function httpBlob(path: string, signal?: AbortSignal): Promise<Blob> {
  const headers = new Headers();
  const token = gatewayAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${serverHttp()}${path}`, { headers, signal });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.blob();
}

async function httpText(path: string): Promise<string> {
  const headers = new Headers();
  const token = gatewayAuthToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const res = await fetch(`${serverHttp()}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text().catch(() => "")}`);
  return res.text();
}

export interface ExecutionRun {
  id: string;
  taskId: string;
  projectId: string;
  attempt: number;
  status: "preparing" | "running" | "waiting_review" | "approved" | "promoting" | "promoted" | "failed" | "blocked";
  subjectHash?: string;
  diffArtifactHash?: string;
  startedAt: string;
  completedAt?: string;
  outcome?: string;
}

export interface AttentionRecord {
  id: string;
  projectId: string;
  taskId: string;
  runId?: string;
  agentId?: string;
  /** Active local process channel, when a reply can be delivered safely. */
  channel?: string;
  link?: string;
  requestId?: string;
  options?: string[];
  kind: "waiting_review" | "failed" | "policy_blocked" | "input_required";
  state: "open" | "resolved";
  message: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface GitRepositorySnapshot {
  repoRoot: string;
  currentBranch: string | null;
  detached: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  files: Array<{ path: string; originalPath?: string; status: string; staged: boolean }>;
  branches: Array<{ name: string; head: string; current: boolean }>;
  commits: Array<{
    hash: string;
    shortHash: string;
    authoredAt: string;
    authorName: string;
    authorEmail: string;
    subject: string;
  }>;
  diff: string;
  truncated: boolean;
}

export interface GitHubAccountStatus {
  installed: boolean;
  authenticated: boolean;
  host: "github.com";
  executable?: string;
  version?: string;
  login?: string;
  gitProtocol?: "https" | "ssh";
  tokenSource?: string;
  scopes?: string[];
  error?: string;
}

export interface GitHubRemoteStatus {
  configured: boolean;
  name: "origin";
  url?: string;
  repository?: string;
  githubUrl?: string;
}

export interface GitHubLinkResult {
  repository: {
    nameWithOwner: string;
    url: string;
    defaultBranch: string | null;
    isPrivate: boolean;
    viewerPermission: string;
  };
  remote: GitHubRemoteStatus;
}

const projectPathApprovals = new Map<string, string>();

export const api = {
  /** gateway liveness — used by the Setup Wizard's port/connection test */
  health: () => http<{ ok: boolean; sessions: number }>("/api/health"),
  audit: {
    list: (filters: { category?: AuditCategory; projectId?: string; q?: string; beforeMs?: number; beforeId?: string; limit?: number } = {}) => {
      const query = new URLSearchParams();
      if (filters.category) query.set("category", filters.category);
      if (filters.projectId) query.set("projectId", filters.projectId);
      if (filters.q) query.set("q", filters.q);
      if (filters.beforeMs !== undefined) query.set("beforeMs", String(filters.beforeMs));
      if (filters.beforeId) query.set("beforeId", filters.beforeId);
      if (filters.limit !== undefined) query.set("limit", String(filters.limit));
      const suffix = query.toString();
      return http<AuditEntry[]>(`/api/audit${suffix ? `?${suffix}` : ""}`);
    },
    summary: () => http<AuditSummary>("/api/audit/summary"),
  },
  github: {
    status: () => http<GitHubAccountStatus>("/api/github/status"),
    project: (id: string) => http<GitHubRemoteStatus>(`/api/projects/${id}/github`),
    configure: async (id: string, repository: string) => {
      if (typeof window === "undefined" || !window.daimon?.configureGitHubProject) {
        throw new Error("GitHub repository linking requires the trusted desktop application");
      }
      const response = await window.daimon.configureGitHubProject(id, repository);
      if (!response.ok || !response.result) {
        throw new Error(response.canceled ? "GitHub linking canceled" : "GitHub linking failed");
      }
      return response.result as GitHubLinkResult;
    },
  },
  providers: {
    list: () => http<ProviderConfig[]>("/api/providers"),
    save: (provider: ProviderConfig, apiKey?: string) =>
      http<ProviderConfig>("/api/providers", {
        method: "POST",
        body: JSON.stringify({ provider, apiKey }),
      }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/providers/${id}`, { method: "DELETE" }),
    refreshModels: (id: string) =>
      http<{ provider: ProviderConfig; detail: string; source: string }>(`/api/providers/${id}/models`, {
        method: "POST",
      }),
    /** wizard connectivity test for a provider draft (pre-save) */
    test: (draft: {
      kind: string;
      mode: string;
      cliCommand?: string;
      baseUrl?: string;
      apiFormat?: string;
      apiKey?: string;
    }) =>
      http<{ ok: boolean; detail: string; models: ModelInfo[]; source?: string }>("/api/providers/test", {
        method: "POST",
        body: JSON.stringify(draft),
      }),
  },
  agents: {
    list: () => http<AgentDefinition[]>("/api/agents"),
    save: async (agent: AgentDefinition) => {
      if (typeof window !== "undefined" && window.daimon?.saveAgent) {
        const result = await window.daimon.saveAgent(agent);
        if (!result.ok || !result.agent) throw new Error(result.canceled ? "Agent save canceled" : "Agent save failed");
        return result.agent as AgentDefinition;
      }
      return http<AgentDefinition>("/api/agents", {
        method: "POST",
        body: JSON.stringify(agent),
      });
    },
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/agents/${id}`, { method: "DELETE" }),
  },
  fusion: {
    // server returns the current fusion state for an agent (empty/404 → treat as off)
    getConfig: (agentId: string) =>
      http<{ fusionEnabled: boolean; fusionConfig: FusionConfig | null }>(
        `/api/agents/${agentId}/fusion-config`,
      ),
    saveConfig: (
      agentId: string,
      payload: { fusionEnabled: boolean; fusionConfig: FusionConfig | null },
    ) =>
      http<{ fusionEnabled: boolean; fusionConfig: FusionConfig | null }>(
        `/api/agents/${agentId}/fusion-config`,
        { method: "PUT", body: JSON.stringify(payload) },
      ),
    runs: (agentId: string) =>
      http<FusionRun[]>(`/api/agents/${agentId}/fusion-runs`),
    run: (runId: string) => http<FusionRunDetail>(`/api/fusion-runs/${runId}`),
  },
  teams: {
    list: () => http<Team[]>("/api/teams"),
    save: (team: Team) =>
      http<Team>("/api/teams", { method: "POST", body: JSON.stringify(team) }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/teams/${id}`, { method: "DELETE" }),
  },
  projects: {
    list: () => http<Project[]>("/api/projects"),
    save: async (project: Project) => {
      if (typeof window !== "undefined" && window.daimon?.saveProject) {
        const result = await window.daimon.saveProject(project);
        if (!result.ok || !result.project) throw new Error(result.canceled ? "Project save canceled" : "Project save failed");
        return result.project as Project;
      }
      const approval = projectPathApprovals.get(project.path);
      try {
        return await http<Project>("/api/projects", {
          method: "POST",
          headers: approval ? { "x-daimon-path-approval": approval } : undefined,
          body: JSON.stringify(project),
        });
      } finally {
        if (approval) projectPathApprovals.delete(project.path);
      }
    },
    remove: (id: string) =>
      http<{ ok: boolean; removedProjectIds: string[] }>(`/api/projects/${id}`, { method: "DELETE" }),
    start: async (id: string) => {
      if (typeof window !== "undefined" && window.daimon?.startProject) {
        const result = await window.daimon.startProject(id);
        if (!result.ok || !result.session) {
          throw new Error(result.canceled ? "Project start canceled" : "Project start failed");
        }
        return result.session as { id: string };
      }
      return http<{ id: string }>(`/api/projects/${id}/start`, { method: "POST", body: "{}" });
    },
    instantiate: (id: string, blueprintId: string, vars?: Record<string, string>) =>
      http<Task[]>(`/api/projects/${id}/instantiate`, {
        method: "POST",
        body: JSON.stringify({ blueprintId, vars }),
      }),
    /** text files the workers wrote into the project folder (newest first) */
    deliverables: (id: string) =>
      http<{
        root: string;
        files: Array<{ name: string; relPath: string; ext: string; size: number; mtimeMs: number }>;
      }>(`/api/projects/${id}/deliverables`),
    /** read one deliverable's content (containment-guarded, size-capped) */
    file: (id: string, relPath: string) =>
      http<{ path: string; size: number; truncated: boolean; content: string }>(
        `/api/projects/${id}/file?path=${encodeURIComponent(relPath)}`,
      ),
    git: (id: string) =>
      http<GitRepositorySnapshot>(`/api/projects/${id}/git`),
  },
  skills: {
    list: () => http<Skill[]>("/api/skills"),
    save: (skill: Skill) =>
      http<Skill>("/api/skills", { method: "POST", body: JSON.stringify(skill) }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/skills/${id}`, { method: "DELETE" }),
    clone: async (id: string, providerKinds: string[]) => {
      if (typeof window !== "undefined" && window.daimon?.cloneSkill) {
        const response = await window.daimon.cloneSkill(id, providerKinds);
        if (!response.ok || !response.result) {
          throw new Error(response.canceled ? "Skill installation canceled" : "Skill installation failed");
        }
        return response.result as { cloned: string[] };
      }
      return http<{ cloned: string[] }>(`/api/skills/${id}/clone`, {
        method: "POST",
        body: JSON.stringify({ providerKinds }),
      });
    },
  },
  tasks: {
    list: (projectId?: string) =>
      http<Task[]>(`/api/tasks${projectId ? `?projectId=${projectId}` : ""}`),
    create: (task: Task) =>
      http<Task>("/api/tasks", { method: "POST", body: JSON.stringify(task) }),
    update: (task: Task) =>
      http<Task>(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: task.title,
          description: task.description,
          assignedAgentId: task.assignedAgentId,
          assignedAgentName: task.assignedAgentName,
          dependsOn: task.dependsOn,
          lane: task.lane,
          priority: task.priority,
          notBefore: task.notBefore,
          parentTaskId: task.parentTaskId,
          status: task.status,
        }),
      }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
    retry: (id: string) =>
      http<{ ok: boolean }>(`/api/tasks/${id}/retry`, { method: "POST", body: "{}" }),
  },
  runs: {
    list: (taskId?: string) => http<ExecutionRun[]>(`/api/runs${taskId ? `?taskId=${taskId}` : ""}`),
    diff: (runId: string) =>
      typeof window !== "undefined" && window.daimon?.getRunDiff
        ? window.daimon.getRunDiff(runId).then((result) => {
            if (!result.ok || result.diff === undefined) throw new Error(result.canceled ? "Diff review canceled" : "Diff unavailable");
            return result.diff;
          })
        : httpText(`/api/runs/${runId}/diff`),
    approve: async (runId: string, subjectHash: string) => {
      if (typeof window !== "undefined" && window.daimon?.approveRun) {
        const result = await window.daimon.approveRun(runId, subjectHash);
        if (!result.ok) throw new Error(result.canceled ? "approval canceled" : "approval failed");
        return result;
      }
      return http(`/api/runs/${runId}/approve`, {
        method: "POST",
        body: JSON.stringify({ subjectHash }),
      });
    },
    promote: (runId: string, subjectHash: string) =>
      typeof window !== "undefined" && window.daimon?.promoteRun
        ? window.daimon.promoteRun(runId, subjectHash)
        : http(`/api/runs/${runId}/promote`, { method: "POST", body: JSON.stringify({ subjectHash }) }),
  },
  log: {
    list: (limit = 500) => http<AppLogEntry[]>(`/api/log?limit=${limit}`),
  },
  attention: {
    list: (state: "open" | "resolved" | "all" = "open") =>
      http<AttentionRecord[]>(`/api/attention?state=${state}`),
    respond: async (attentionId: string, response: string) => {
      if (typeof window !== "undefined" && window.daimon?.respondToAttention) {
        const result = await window.daimon.respondToAttention(attentionId, response);
        if (!result.ok || !result.result) throw new Error(result.canceled ? "Response canceled" : "Response failed");
        return result.result as { attentionId: string; state: "resolved"; deliveredTo: string; resolvedAt: string };
      }
      return http<{ attentionId: string; state: "resolved"; deliveredTo: string; resolvedAt: string }>(
        `/api/attention/${attentionId}/respond`,
        { method: "POST", body: JSON.stringify({ response }) },
      );
    },
  },
  goals: {
    list: () => http<Goal[]>("/api/goals"),
    save: (goal: Goal) =>
      http<Goal>("/api/goals", { method: "POST", body: JSON.stringify(goal) }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/goals/${id}`, { method: "DELETE" }),
  },
  attachments: {
    upload: (payload: { name: string; mime: string; dataBase64: string }) =>
      http<Attachment>("/api/attachments", { method: "POST", body: JSON.stringify(payload) }),
    /** Auth-aware binary fetch; callers should expose a short-lived object URL. */
    download: (id: string, signal?: AbortSignal) =>
      httpBlob(`/api/attachments/${id}`, signal),
  },
  fs: {
    /** open the OS-native folder dialog on the (local) server and return the
     *  chosen absolute path; `canceled` when the user dismisses the dialog */
    pickFolder: async () => {
      const result = await http<{ path?: string; approvalToken?: string; canceled?: boolean }>(
        "/api/fs/pick-folder",
        { method: "POST" },
      );
      if (result.path && result.approvalToken) {
        projectPathApprovals.set(result.path, result.approvalToken);
      }
      return result;
    },
  },
  mcp: {
    list: () => http<McpServer[]>("/api/mcp"),
    save: async (server: McpServer) => {
      if (typeof window !== "undefined" && window.daimon?.saveMcpServer) {
        const result = await window.daimon.saveMcpServer(server);
        if (!result.ok || !result.server) throw new Error(result.canceled ? "MCP trust canceled" : "MCP save failed");
        return result.server as McpServer;
      }
      return http<McpServer>("/api/mcp", { method: "POST", body: JSON.stringify(server) });
    },
    remove: async (id: string) => {
      if (typeof window !== "undefined" && window.daimon?.removeMcpServer) {
        const result = await window.daimon.removeMcpServer(id);
        if (!result.ok) throw new Error(result.canceled ? "MCP removal canceled" : "MCP removal failed");
        return { ok: true };
      }
      return http<{ ok: boolean }>(`/api/mcp/${id}`, { method: "DELETE" });
    },
  },
  secrets: {
    // metadata only (masked tail) — the raw value never leaves the server
    list: () => http<Secret[]>("/api/secrets"),
    save: async (secret: Secret, value?: string) => {
      const payload = { secret, value };
      if (typeof window !== "undefined" && window.daimon?.saveSecret) {
        const result = await window.daimon.saveSecret(payload);
        if (!result.ok || !result.secret) throw new Error(result.canceled ? "Secret save canceled" : "Secret save failed");
        return result.secret as Secret;
      }
      return http<Secret>("/api/secrets", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    remove: async (id: string) => {
      if (typeof window !== "undefined" && window.daimon?.removeSecret) {
        const result = await window.daimon.removeSecret(id);
        if (!result.ok) throw new Error(result.canceled ? "Secret removal canceled" : "Secret removal failed");
        return { ok: true };
      }
      return http<{ ok: boolean }>(`/api/secrets/${id}`, { method: "DELETE" });
    },
  },
  blueprints: {
    list: () => http<Blueprint[]>("/api/blueprints"),
    save: (bp: Blueprint) =>
      http<Blueprint>("/api/blueprints", { method: "POST", body: JSON.stringify(bp) }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/blueprints/${id}`, { method: "DELETE" }),
  },
  schedules: {
    list: () => http<Schedule[]>("/api/schedules"),
    save: (s: Schedule) =>
      http<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(s) }),
    remove: (id: string) =>
      http<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),
  },
  import: {
    scan: (kind: ProviderKind) => http<ImportScan>(`/api/import/scan?kind=${kind}`),
    apply: async (payload: {
      providerId?: string;
      kind?: ProviderKind;
      skills: ImportScan["skills"];
      agents: ImportScan["agents"];
      mcpServers: ImportScan["mcpServers"];
    }) => {
      if (typeof window !== "undefined" && window.daimon?.applyProviderImport) {
        const response = await window.daimon.applyProviderImport(payload);
        if (!response.ok || !response.result) throw new Error(response.canceled ? "Import canceled" : "Import failed");
        return response.result as { skills: number; agents: number; mcpServers: number };
      }
      return http<{ skills: number; agents: number; mcpServers: number }>(
        "/api/import/apply",
        { method: "POST", body: JSON.stringify(payload) },
      );
    },
    sync: async (providerId: string) => {
      if (typeof window !== "undefined" && window.daimon?.syncProviderImport) {
        const response = await window.daimon.syncProviderImport(providerId);
        if (!response.ok || !response.result) throw new Error(response.canceled ? "Sync canceled" : "Sync failed");
        return response.result as {
          kind: ProviderKind;
          added: { skills: string[]; agents: string[]; mcpServers: string[] };
          skipped: { skills: number; agents: number; mcpServers: number };
        };
      }
      return http<{
        kind: ProviderKind;
        added: { skills: string[]; agents: string[]; mcpServers: string[] };
        skipped: { skills: number; agents: number; mcpServers: number };
      }>("/api/import/sync", {
        method: "POST",
        body: JSON.stringify({ providerId }),
      });
    },
  },
  sessions: {
    list: () => http<ChannelSnapshot[]>("/api/sessions"),
    resume: (channel: string) =>
      http<{ ok: boolean }>(`/api/sessions/${channel}/resume`, { method: "POST", body: "{}" }),
  },
  settings: {
    get: () => http<OrchestratorSettings>("/api/settings"),
    save: (settings: OrchestratorSettings) =>
      http<OrchestratorSettings>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      }),
  },
  admin: {
    /** Wipe ALL configuration back to a clean slate (factory reset). */
    reset: () =>
      typeof window !== "undefined" && window.daimon?.factoryReset
        ? window.daimon.factoryReset()
        : http<{ ok: boolean }>("/api/admin/reset", { method: "POST", body: "{}" }),
  },
  memory: {
    get: () => http<MemorySettings>("/api/settings/memory"),
    save: async (settings: MemorySettings) => {
      const vaultPath = settings.storageMode === "obsidian"
        ? settings.obsidianVaultPath?.trim()
        : undefined;
      const approval = vaultPath ? projectPathApprovals.get(vaultPath) : undefined;
      try {
        return await http<MemorySettings>("/api/settings/memory", {
          method: "PUT",
          headers: approval ? { "x-daimon-path-approval": approval } : undefined,
          body: JSON.stringify(settings),
        });
      } finally {
        if (approval && vaultPath) projectPathApprovals.delete(vaultPath);
      }
    },
    validate: (partial: Partial<MemorySettings>) =>
      http<{ ok: boolean; activeMemoryRoot?: string; usingFallback: boolean; error?: string }>(
        "/api/settings/memory/validate",
        { method: "POST", body: JSON.stringify(partial) },
      ),
    rebuildIndex: () =>
      http<{ ok: boolean; totalMemories?: number; lastIndexRebuild?: string; error?: string }>(
        "/api/settings/memory/rebuild-index",
        { method: "POST", body: "{}" },
      ),
    testWrite: () =>
      http<{ ok: boolean; path?: string; error?: string }>("/api/settings/memory/test-write", {
        method: "POST",
        body: "{}",
      }),
    status: () => http<MemoryStatus>("/api/settings/memory/status"),
    search: (params: { q?: string; projectId?: string; type?: string; limit?: number }) => {
      const qs = new URLSearchParams();
      if (params.q) qs.set("q", params.q);
      if (params.projectId) qs.set("projectId", params.projectId);
      if (params.type) qs.set("type", params.type);
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      const suffix = qs.toString();
      return http<MemoryEntry[]>(`/api/memory/search${suffix ? `?${suffix}` : ""}`);
    },
    initProject: (projectId: string) =>
      http<{ ok: boolean }>(`/api/projects/${projectId}/memory/init`, {
        method: "POST",
        body: "{}",
      }),
  },
};
