import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_SCROLLBACK_LINES,
  DEFAULT_WATCHDOG_IDLE_MS,
  METRICS_INTERVAL_MS,
  newAgentId,
  newProviderId,
  newSecretId,
  newTeamId,
} from "@daimon-os/shared";
import type {
  AgentDefinition,
  AgentId,
  Blueprint,
  BlueprintId,
  FusionConfig,
  FusionPanelResult,
  FusionRun,
  Goal,
  McpServer,
  MemorySettings,
  OrchestratorSettings,
  Project,
  ProjectId,
  ProviderConfig,
  ProviderId,
  Schedule,
  ScheduleId,
  Secret,
  SecretId,
  Skill,
  Task,
  Team,
  TeamId,
} from "@daimon-os/shared";
import { Vault } from "./vault";

type SkillMeta = Omit<Skill, "content">;

/** A FusionRun with its panel results embedded (so a run + its results persist
 *  and load atomically as one record). */
export type StoredFusionRun = FusionRun & { panelResults: FusionPanelResult[] };

/** keep the run log bounded so a long-lived operator install can't grow it without limit */
const MAX_FUSION_RUNS = 200;

interface ConfigFile {
  providers: ProviderConfig[];
  agents: AgentDefinition[];
  teams: Team[];
  projects: Project[];
  skills: SkillMeta[];
  mcpServers: McpServer[];
  goals: Goal[];
  tasks: Task[];
  /** reusable task-DAG templates */
  blueprints: Blueprint[];
  /** automatic blueprint→project instantiation triggers */
  schedules: Schedule[];
  /** vault secret METADATA only — raw values live encrypted in the Vault, by id */
  secrets: Secret[];
  /** persisted Fusion runs (capped log) — each run embeds its panel results */
  fusionRuns: StoredFusionRun[];
  settings: OrchestratorSettings;
  /** centralized-memory settings — resolved root is filled at runtime by MemoryService */
  memory: MemorySettings;
}

/** pre-v0.2 configs used different provider kind names and had no mode */
const LEGACY_KIND_MAP: Record<string, ProviderConfig["kind"]> = {
  anthropic: "claude",
  openai: "codex",
  google: "gemini",
};

/**
 * File-backed config persistence. Raw API keys live in a separate secrets
 * file keyed by `apiKeyRef` — they are never embedded in provider objects
 * and therefore never serialized onto the wire.
 */
export class ConfigStore {
  private config: ConfigFile;
  private readonly vault: Vault;
  private readonly configPath: string;
  private skillsDir!: string;
  private attachmentsDir!: string;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.configPath = path.join(dataDir, "config.json");
    this.vault = new Vault(dataDir);
    this.config = fs.existsSync(this.configPath)
      ? (JSON.parse(fs.readFileSync(this.configPath, "utf8")) as ConfigFile)
      : seedConfig();
    // migrations: pre-v0.2 config files
    this.config.projects ??= [];
    this.config.skills ??= [];
    this.config.mcpServers ??= [];
    this.config.goals ??= [];
    this.config.tasks ??= [];
    this.config.blueprints ??= [];
    this.config.schedules ??= [];
    this.config.secrets ??= [];
    this.config.fusionRuns ??= [];
    // centralized memory: seed defaults for configs written before the block existed
    this.config.memory ??= { ...DEFAULT_MEMORY_SETTINGS };
    // legacy configs predating the settings block would crash on the watchdog heal below
    this.config.settings ??= {
      maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      defaultIsolation: "mock",
      scrollbackLines: DEFAULT_SCROLLBACK_LINES,
      theme: "dark",
      telemetry: { metricsIntervalMs: METRICS_INTERVAL_MS },
      watchdog: { enabled: true, idleMs: DEFAULT_WATCHDOG_IDLE_MS },
    };
    // fill the watchdog default for configs written before the field existed
    this.config.settings.watchdog ??= { enabled: true, idleMs: DEFAULT_WATCHDOG_IDLE_MS };
    // one-time migration: move legacy PLAINTEXT provider keys (secrets.json) into
    // the encrypted vault keyed by the same apiKeyRef, then delete the plaintext
    // file so no raw key remains on disk.
    const legacyPath = path.join(dataDir, "secrets.json");
    if (fs.existsSync(legacyPath)) {
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Record<string, string>;
        for (const [ref, val] of Object.entries(legacy)) {
          if (!this.vault.has(ref)) this.vault.set(ref, val);
        }
        fs.rmSync(legacyPath); // keys are now encrypted in the vault
      } catch {
        /* malformed legacy file — leave it, don't lose data */
      }
    }
    // heal any pre-existing config whose slugs predate boundary sanitization,
    // then re-persist so a poisoned config.json is cleaned on disk, not just in memory
    const before = this.config.skills.map((s) => s.slug).join("\0");
    for (const s of this.config.skills) s.slug = sanitizeSlug(s.slug);
    let healed = this.config.skills.map((s) => s.slug).join("\0") !== before;
    for (const p of this.config.providers) {
      const mapped = LEGACY_KIND_MAP[p.kind as string];
      if (mapped) p.kind = mapped;
      p.mode ??= ["claude", "gemini", "codex", "hermes"].includes(p.kind) ? "cli" : "api";
    }
    // Security migration: older Agent/MCP definitions could persist raw env
    // values in config.json. Preserve each value in the encrypted Vault, expose
    // only metadata, and require the user to grant project+agent scope before it
    // can run again. MCP values are deliberately not auto-granted to any agent.
    const migrateEnv = (
      env: Record<string, string> | undefined,
      owner: string,
    ): SecretId[] => {
      const ids: SecretId[] = [];
      for (const [key, value] of Object.entries(env ?? {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") continue;
        const id = newSecretId();
        const now = new Date().toISOString();
        this.vault.set(id, value);
        this.config.secrets.push({
          id,
          key,
          label: `Migrated from ${owner}`,
          group: "Security migration",
          maskedValue: maskKey(value),
          createdAt: now,
          updatedAt: now,
        });
        ids.push(id);
      }
      return ids;
    };
    for (const agent of this.config.agents) {
      const migrated = migrateEnv(agent.env, `agent ${agent.name}`);
      if (agent.env && Object.keys(agent.env).length > 0) {
        agent.env = undefined;
        agent.secretIds = [...new Set([...(agent.secretIds ?? []), ...migrated])];
        healed = true;
      }
    }
    for (const server of this.config.mcpServers) {
      if (server.env && Object.keys(server.env).length > 0) {
        migrateEnv(server.env, `MCP ${server.name}`);
        server.env = undefined;
        healed = true;
      }
    }
    this.skillsDir = path.join(dataDir, "skills");
    fs.mkdirSync(this.skillsDir, { recursive: true });
    this.attachmentsDir = path.join(dataDir, "attachments");
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    // write seeded skill files for fresh installs (seedConfig metadata is in config,
    // but SKILL.md content lives on disk — must be written here once skillsDir is ready)
    for (const meta of this.config.skills) {
      const file = path.join(this.skillsDir, sanitizeSlug(meta.slug), "SKILL.md");
      if (!fs.existsSync(file) && meta.slug === SEEDED_SKILL_SLUG) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, SEEDED_SKILL_CONTENT, "utf8");
      }
    }
    if (!fs.existsSync(this.configPath) || healed) this.persist();
  }

  // --- providers ---
  listProviders(): ProviderConfig[] {
    return this.config.providers;
  }
  getProvider(id: ProviderId): ProviderConfig | undefined {
    return this.config.providers.find((p) => p.id === id);
  }
  upsertProvider(provider: ProviderConfig, apiKey?: string): ProviderConfig {
    if (apiKey) {
      this.vault.set(provider.apiKeyRef, apiKey); // encrypted at rest
      provider.maskedKey = maskKey(apiKey);
    }
    const i = this.config.providers.findIndex((p) => p.id === provider.id);
    if (i >= 0) this.config.providers[i] = provider;
    else this.config.providers.push(provider);
    this.persist();
    return provider;
  }
  deleteProvider(id: ProviderId): void {
    const provider = this.config.providers.find((p) => p.id === id);
    if (this.config.agents.some((agent) => agent.providerId === id)) {
      throw new Error("provider is used by agents; delete or reassign those agents first");
    }
    if (provider) this.vault.delete(provider.apiKeyRef); // don't orphan the key
    this.config.providers = this.config.providers.filter((p) => p.id !== id);
    this.persist();
  }
  /** Server-side only — resolves a ref to the raw key. Never expose via REST/WS. */
  resolveApiKey(ref: string): string | undefined {
    return this.vault.get(ref);
  }

  // --- secrets vault (cross-project, encrypted credentials) ---
  /** metadata only (masked tail, never the raw value) — safe to send over REST. */
  listSecrets(): Secret[] {
    return this.config.secrets;
  }
  getSecret(id: SecretId): Secret | undefined {
    return this.config.secrets.find((s) => s.id === id);
  }
  /** Upsert a secret's metadata; if `value` is provided it is (re)sealed in the
   *  vault and the masked tail refreshed. Omit `value` to edit label/group/key
   *  without changing the stored secret. */
  upsertSecret(secret: Secret, value?: string): Secret {
    if (value !== undefined && value !== "") {
      this.vault.set(secret.id, value);
      secret.maskedValue = maskKey(value);
    } else {
      // preserve the existing mask when only metadata changed
      secret.maskedValue = this.getSecret(secret.id)?.maskedValue ?? secret.maskedValue;
    }
    const i = this.config.secrets.findIndex((s) => s.id === secret.id);
    if (i >= 0) this.config.secrets[i] = secret;
    else this.config.secrets.push(secret);
    this.persist();
    return secret;
  }
  deleteSecret(id: SecretId): void {
    this.vault.delete(id);
    this.config.secrets = this.config.secrets.filter((s) => s.id !== id);
    // drop dangling references so a project never points at a missing secret
    for (const p of this.config.projects) {
      if (p.secretIds?.includes(id)) p.secretIds = p.secretIds.filter((x) => x !== id);
    }
    for (const agent of this.config.agents) {
      if (agent.secretIds?.includes(id)) agent.secretIds = agent.secretIds.filter((x) => x !== id);
    }
    this.persist();
  }
  /** Server-side only — raw value for a secret id. Never expose via REST/WS. */
  resolveSecret(id: SecretId): string | undefined {
    return this.vault.get(id);
  }
  /** env var map (key → raw value) for the secrets a project opted into —
   *  injected into the env of agents spawned in that project. Server-side only. */
  secretsForProject(projectId?: string): Record<string, string> {
    if (!projectId) return {};
    const project = this.config.projects.find((p) => p.id === projectId);
    const out: Record<string, string> = {};
    for (const id of project?.secretIds ?? []) {
      const meta = this.config.secrets.find((s) => s.id === id);
      const value = this.vault.get(id);
      if (meta && value !== undefined) out[meta.key] = value;
    }
    return out;
  }

  /** Secrets require two scopes: project approval and agent need. Missing agent
   *  scope means no secrets, preserving a fail-closed default. */
  secretsForAgent(projectId: string | undefined, agent: AgentDefinition): Record<string, string> {
    if (!projectId) return {};
    const project = this.config.projects.find((p) => p.id === projectId);
    const projectIds = new Set(project?.secretIds ?? []);
    const out: Record<string, string> = {};
    for (const id of agent.secretIds ?? []) {
      if (!projectIds.has(id)) continue;
      const meta = this.config.secrets.find((secret) => secret.id === id);
      const value = this.vault.get(id);
      if (meta && value !== undefined) out[meta.key] = value;
    }
    return out;
  }

  // --- agents ---
  listAgents(): AgentDefinition[] {
    return this.config.agents;
  }
  getAgent(id: AgentId): AgentDefinition | undefined {
    return this.config.agents.find((a) => a.id === id);
  }
  /** Whether a completed task by this agent auto-approves straight to "done".
   *  This is an explicit opt-in; absent/false requires human review. */
  agentAutoApprovesReview(agentId?: string): boolean {
    if (!agentId) return false;
    return this.getAgent(agentId as AgentId)?.autoApproveReview === true;
  }
  upsertAgent(agent: AgentDefinition): AgentDefinition {
    const provider = this.getProvider(agent.providerId);
    if (!provider) throw new Error("agent references an unknown provider");
    const requestedMcpIds = new Set(agent.mcpServerIds ?? []);
    if (requestedMcpIds.size !== (agent.mcpServerIds?.length ?? 0)) {
      throw new Error("agent MCP selections contain duplicates");
    }
    for (const id of requestedMcpIds) {
      const server = this.config.mcpServers.find((candidate) => candidate.id === id);
      if (!server) throw new Error(`agent references an unknown MCP connection: ${id}`);
      if (!server.enabled) throw new Error(`agent references a disabled MCP connection: ${server.name}`);
      if (server.providerKind && server.providerKind !== provider.kind) {
        throw new Error(`MCP connection "${server.name}" is not compatible with ${provider.kind}`);
      }
    }
    const i = this.config.agents.findIndex((a) => a.id === agent.id);
    if (i >= 0) this.config.agents[i] = agent;
    else this.config.agents.push(agent);
    this.persist();
    return agent;
  }
  deleteAgent(id: AgentId): void {
    if (this.config.teams.some((team) => team.memberAgentIds.includes(id))) {
      throw new Error("agent is attached to a team; remove it from the team first");
    }
    if (this.config.tasks.some((task) =>
      task.assignedAgentId === id && task.status !== "done" && task.status !== "failed")) {
      throw new Error("agent is referenced by active tasks; finish, delete, or reassign those tasks first");
    }
    if (this.config.agents.some((agent) =>
      agent.id !== id && agent.fusionConfig &&
      (agent.fusionConfig.judgeAgentId === id || agent.fusionConfig.panelAgentIds.includes(id)))) {
      throw new Error("agent is referenced by another agent's Fusion configuration");
    }
    // Completed history keeps its denormalized display name but must not retain
    // a dangling live-registry foreign key after the agent is deliberately removed.
    this.config.tasks = this.config.tasks.map((task) =>
      task.assignedAgentId === id ? { ...task, assignedAgentId: undefined } : task);
    this.config.agents = this.config.agents.filter((a) => a.id !== id);
    this.persist();
  }

  /**
   * Server-side Fusion config validation: zod enforces shape/size/no-dups, but
   * agent EXISTENCE and the not-self rule need the live registry. Returns a list
   * of human-readable errors ([] = valid). Used both by the PUT route and by the
   * Scheduler dispatch hook before a Fusion run.
   */
  validateFusionConfig(agentId: string, config: FusionConfig): string[] {
    const errors: string[] = [];
    const all = [...config.panelAgentIds, config.judgeAgentId];
    for (const id of all) {
      if (!this.getAgent(id as AgentId)) errors.push(`unknown agent: ${id}`);
      if (id === agentId) {
        errors.push("the invoked agent cannot also be a panel or judge agent");
      }
    }
    if (config.panelAgentIds.length < 1 || config.panelAgentIds.length > 8) {
      errors.push("panel must have between 1 and 8 agents");
    }
    if (new Set(config.panelAgentIds).size !== config.panelAgentIds.length) {
      errors.push("duplicate panel agent");
    }
    if (config.panelAgentIds.includes(config.judgeAgentId)) {
      errors.push("judge agent cannot also be a panel agent");
    }
    return [...new Set(errors)];
  }

  // --- fusion runs (persisted, capped audit log) ---
  listFusionRuns(agentId?: string): StoredFusionRun[] {
    const rows = agentId
      ? this.config.fusionRuns.filter((r) => r.invokedAgentId === agentId)
      : this.config.fusionRuns;
    // newest first
    return [...rows].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  getFusionRun(id: string): StoredFusionRun | undefined {
    return this.config.fusionRuns.find((r) => r.id === id);
  }
  addFusionRun(run: StoredFusionRun): StoredFusionRun {
    const i = this.config.fusionRuns.findIndex((r) => r.id === run.id);
    if (i >= 0) this.config.fusionRuns[i] = run;
    else this.config.fusionRuns.push(run);
    // cap: drop the oldest beyond the limit so the log can't grow unbounded
    if (this.config.fusionRuns.length > MAX_FUSION_RUNS) {
      this.config.fusionRuns = this.config.fusionRuns
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
        .slice(-MAX_FUSION_RUNS);
    }
    this.persist();
    return run;
  }

  // --- teams ---
  listTeams(): Team[] {
    return this.config.teams;
  }
  upsertTeam(team: Team): Team {
    if (team.parentId && !this.config.teams.some((candidate) => candidate.id === team.parentId)) {
      throw new Error("unknown parent team");
    }
    const unknownMember = team.memberAgentIds.find((id) => !this.getAgent(id));
    if (unknownMember) throw new Error(`unknown team member: ${unknownMember}`);
    if (team.supervisorAgentId && !team.memberAgentIds.includes(team.supervisorAgentId)) {
      throw new Error("the team Lead must be a member of the team");
    }
    // the org is a tree: reject any parent chain that loops back to this team
    // (the UI prevents it, but the persistence boundary must enforce it)
    let cursor = team.parentId;
    const visited = new Set<string>([team.id]);
    while (cursor) {
      if (visited.has(cursor)) {
        throw new Error(`team hierarchy cycle: "${team.name}" cannot be its own ancestor`);
      }
      visited.add(cursor);
      cursor = this.config.teams.find((t) => t.id === cursor)?.parentId ?? null;
    }
    // validate the in-team reporting line: every manager edge must connect two
    // members, no self-management, and the chain must not cycle
    const managers = team.managers ?? {};
    const memberSet = new Set<string>(team.memberAgentIds);
    for (const [member, superior] of Object.entries(managers)) {
      if (!memberSet.has(member)) throw new Error("reporting line references a non-member");
      if (!memberSet.has(superior)) throw new Error("a superior must be a team member");
      if (member === superior) throw new Error("an agent cannot report to itself");
    }
    for (const start of Object.keys(managers)) {
      const seen = new Set<string>([start]);
      let up: string | undefined = managers[start];
      while (up) {
        if (seen.has(up)) throw new Error("reporting line cycle detected");
        seen.add(up);
        up = managers[up];
      }
    }
    // prune per-team aliases: keep only members, drop blank ones (treat as unset)
    if (team.memberNames) {
      const pruned: Record<string, string> = {};
      for (const [member, alias] of Object.entries(team.memberNames)) {
        if (memberSet.has(member) && alias.trim()) pruned[member] = alias.trim();
      }
      team.memberNames = Object.keys(pruned).length ? pruned : undefined;
    }
    const i = this.config.teams.findIndex((t) => t.id === team.id);
    if (i >= 0) this.config.teams[i] = team;
    else this.config.teams.push(team);
    this.persist();
    return team;
  }
  deleteTeam(id: TeamId): void {
    if (this.config.projects.some((project) => project.teamId === id)) {
      throw new Error("team is attached to a project; detach it before deletion");
    }
    const deleted = this.config.teams.find((t) => t.id === id);
    this.config.teams = this.config.teams
      .filter((t) => t.id !== id)
      // reparent children to the deleted team's parent — no orphaned subtrees
      .map((t) =>
        t.parentId === id ? { ...t, parentId: deleted?.parentId ?? null } : t,
      );
    this.persist();
  }

  // --- projects ---
  listProjects(): Project[] {
    return this.config.projects;
  }
  getProject(id: ProjectId): Project | undefined {
    return this.config.projects.find((p) => p.id === id);
  }
  upsertProject(project: Project): Project {
    if (project.teamId && !this.config.teams.some((team) => team.id === project.teamId)) {
      throw new Error("project references an unknown team");
    }
    if (project.parentProjectId) {
      if (project.parentProjectId === project.id) {
        throw new Error("a project cannot be its own parent");
      }
      const parent = this.config.projects.find((p) => p.id === project.parentProjectId);
      if (!parent) throw new Error("unknown parent project");
      if (parent.parentProjectId) {
        throw new Error("feature projects can only be created under a root project");
      }
      if (project.path !== parent.path) {
        throw new Error("feature projects must share their root project's approved path");
      }
    } else {
      const children = this.config.projects.filter((p) => p.parentProjectId === project.id);
      if (children.some((child) => child.path !== project.path)) {
        throw new Error("move or remove feature projects before changing the root path");
      }
    }
    const i = this.config.projects.findIndex((p) => p.id === project.id);
    if (i >= 0) this.config.projects[i] = project;
    else this.config.projects.push(project);
    this.persist();
    return project;
  }
  deleteProject(id: ProjectId): void {
    const deletedIds = new Set<ProjectId>([id]);
    for (const project of this.config.projects) {
      if (project.parentProjectId === id) deletedIds.add(project.id);
    }
    const removedGoals = this.config.goals.filter((goal) => deletedIds.has(goal.projectId));
    for (const goal of removedGoals) {
      for (const attachment of goal.attachments ?? []) this.deleteAttachmentFile(attachment.id);
    }
    this.config.projects = this.config.projects.filter((p) => !deletedIds.has(p.id));
    // cascade: don't leave orphan tasks/goals/schedules pointed at a dead project
    // (a schedule on a deleted project would otherwise keep firing into the void)
    this.config.tasks = this.config.tasks.filter((t) => !deletedIds.has(t.projectId));
    this.config.goals = this.config.goals.filter((g) => !deletedIds.has(g.projectId));
    this.config.schedules = this.config.schedules.filter((s) => !deletedIds.has(s.projectId));
    this.persist();
  }

  // --- skills (metadata in config, SKILL.md content on disk) ---
  listSkills(): Skill[] {
    return this.config.skills.map((meta) => ({
      ...meta,
      content: this.readSkillContent(meta.slug),
    }));
  }
  getSkill(id: string): Skill | undefined {
    const meta = this.config.skills.find((s) => s.id === id);
    return meta ? { ...meta, content: this.readSkillContent(meta.slug) } : undefined;
  }
  upsertSkill(skill: Skill): Skill {
    // sanitize at the trust boundary: the PERSISTED slug must never traverse —
    // it is later used as a path segment by CliRunner skill-mounting
    const safe = { ...skill, slug: sanitizeSlug(skill.slug) };
    const { content, ...meta } = safe;
    const dir = path.join(this.skillsDir, meta.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
    const i = this.config.skills.findIndex((s) => s.id === safe.id);
    if (i >= 0) this.config.skills[i] = meta;
    else this.config.skills.push(meta);
    this.persist();
    return safe;
  }
  deleteSkill(id: string): void {
    const meta = this.config.skills.find((s) => s.id === id);
    if (meta) {
      fs.rmSync(path.join(this.skillsDir, sanitizeSlug(meta.slug)), {
        recursive: true,
        force: true,
      });
    }
    this.config.skills = this.config.skills.filter((s) => s.id !== id);
    this.persist();
  }
  private readSkillContent(slug: string): string {
    const file = path.join(this.skillsDir, sanitizeSlug(slug), "SKILL.md");
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  // --- MCP servers ---
  listMcpServers(): McpServer[] {
    return this.config.mcpServers;
  }
  upsertMcpServer(server: McpServer): McpServer {
    const i = this.config.mcpServers.findIndex((m) => m.id === server.id);
    if (i >= 0) this.config.mcpServers[i] = server;
    else this.config.mcpServers.push(server);
    this.persist();
    return server;
  }
  deleteMcpServer(id: string): void {
    const target = this.config.mcpServers.find((m) => m.id === id);
    if (target?.builtin) throw new Error("built-in MCP server cannot be deleted");
    this.config.mcpServers = this.config.mcpServers.filter((m) => m.id !== id);
    this.config.agents = this.config.agents.map((agent) => ({
      ...agent,
      mcpServerIds: agent.mcpServerIds?.filter((serverId) => serverId !== id),
    }));
    this.persist();
  }
  /**
   * Servers linked to a spawn: every enabled default + the agent's own picks,
   * RESTRICTED to the spawning provider's CLI family. A server tagged for one
   * provider kind (e.g. gemini) is never handed to an agent on another (claude)
   * — a Claude CLI can't drive a Gemini-specific MCP server. Untagged servers
   * are universal. A plain shell spawn (no agent/provider) gets only universal
   * servers.
   */
  mcpServersForSpawn(agent?: AgentDefinition): McpServer[] {
    const picked = new Set(agent?.mcpServerIds ?? []);
    const spawnKind = agent ? this.getProvider(agent.providerId)?.kind : undefined;
    return this.config.mcpServers.filter(
      (m) =>
        m.enabled &&
        (m.isDefault || picked.has(m.id)) &&
        (!m.providerKind || m.providerKind === spawnKind),
    );
  }

  // --- goals ---
  listGoals(): Goal[] {
    return this.config.goals;
  }
  upsertGoal(goal: Goal): Goal {
    const i = this.config.goals.findIndex((g) => g.id === goal.id);
    if (i >= 0) this.config.goals[i] = goal;
    else this.config.goals.push(goal);
    this.persist();
    return goal;
  }
  deleteGoal(id: string): void {
    const goal = this.config.goals.find((g) => g.id === id);
    // remove the goal's attachment files too — don't orphan blobs on disk
    for (const a of goal?.attachments ?? []) this.deleteAttachmentFile(a.id);
    this.config.goals = this.config.goals.filter((g) => g.id !== id);
    this.persist();
  }

  // --- goal attachments (bytes on disk, keyed by attachment id) ---
  private reclaimOrphanAttachments(now = Date.now()): void {
    const referenced = new Set(
      this.config.goals.flatMap((goal) => (goal.attachments ?? []).map((item) => item.id)),
    );
    const cutoff = now - 60 * 60 * 1000;
    for (const entry of fs.readdirSync(this.attachmentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.endsWith(".mime")) continue;
      if (referenced.has(entry.name)) continue;
      const file = path.join(this.attachmentsDir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.mtimeMs < cutoff) this.deleteAttachmentFile(entry.name);
    }
  }

  writeAttachmentFile(id: string, data: Buffer, mime?: string): void {
    this.reclaimOrphanAttachments();
    const entries = fs.readdirSync(this.attachmentsDir, { withFileTypes: true });
    let totalBytes = 0;
    let stagedCount = 0;
    const referenced = new Set(
      this.config.goals.flatMap((goal) => (goal.attachments ?? []).map((item) => item.id)),
    );
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(".mime")) continue;
      const stat = fs.lstatSync(path.join(this.attachmentsDir, entry.name));
      totalBytes += stat.size;
      if (!referenced.has(entry.name)) stagedCount += 1;
    }
    if (stagedCount >= 50) throw new Error("attachment staging limit reached");
    if (totalBytes + data.length > 250 * 1024 * 1024) {
      throw new Error("attachment storage quota exceeded");
    }
    // id is a server-generated uuid, never user input → safe as a filename
    fs.writeFileSync(path.join(this.attachmentsDir, id), data);
    // sidecar so we can serve the right content-type even before the goal that
    // references this attachment is saved (findAttachment would miss it)
    if (mime) fs.writeFileSync(path.join(this.attachmentsDir, `${id}.mime`), mime, "utf8");
  }
  attachmentMime(id: string): string | undefined {
    const found = this.findAttachment(id)?.mime;
    if (found) return found;
    try {
      return fs.readFileSync(path.join(this.attachmentsDir, `${id}.mime`), "utf8").trim();
    } catch {
      return undefined;
    }
  }
  attachmentFilePath(id: string): string | undefined {
    const file = path.join(this.attachmentsDir, id);
    return fs.existsSync(file) ? file : undefined;
  }
  deleteAttachmentFile(id: string): void {
    fs.rmSync(path.join(this.attachmentsDir, id), { force: true });
    fs.rmSync(path.join(this.attachmentsDir, `${id}.mime`), { force: true });
  }
  /** the attachment metadata (mime/name) by id, searched across all goals */
  findAttachment(id: string) {
    for (const g of this.config.goals) {
      const a = g.attachments?.find((x) => x.id === id);
      if (a) return a;
    }
    return undefined;
  }

  // --- tasks ---
  listTasks(projectId?: string): Task[] {
    return projectId
      ? this.config.tasks.filter((t) => t.projectId === projectId)
      : this.config.tasks;
  }
  getTask(id: string): Task | undefined {
    return this.config.tasks.find((t) => t.id === id);
  }
  upsertTask(task: Task): Task {
    // referential integrity: every dependency must be an existing task in the
    // SAME project — the scheduler reads dependsOn to gate execution, so a
    // dangling or cross-project id would wedge a task in "blocked" forever
    for (const depId of task.dependsOn) {
      if (depId === task.id) throw new Error("a task cannot depend on itself");
      const dep = this.config.tasks.find((t) => t.id === depId);
      if (!dep) throw new Error(`unknown dependency task ${depId}`);
      if (dep.projectId !== task.projectId) {
        throw new Error("dependency must belong to the same project");
      }
    }
    // reject cycles only. The pre-existing graph is acyclic by induction, so
    // this task can introduce a cycle ONLY if its dependency closure reaches
    // back to itself. Reaching an intermediate node by two paths (a diamond /
    // shared dependency) is legal and must NOT be flagged — so we skip nodes
    // already explored and throw solely when task.id reappears.
    const explored = new Set<string>();
    const stack = [...new Set(task.dependsOn)];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === task.id) throw new Error("task dependency cycle detected");
      if (explored.has(id)) continue; // shared dep already walked — fine
      explored.add(id);
      const dep = this.config.tasks.find((t) => t.id === id);
      if (dep) stack.push(...dep.dependsOn);
    }
    const i = this.config.tasks.findIndex((t) => t.id === task.id);
    if (i >= 0) this.config.tasks[i] = task;
    else this.config.tasks.push(task);
    this.persist();
    return task;
  }
  deleteTask(id: string): void {
    this.config.tasks = this.config.tasks.filter((t) => t.id !== id);
    this.persist();
  }

  // --- blueprints (reusable task-DAG templates) ---
  listBlueprints(): Blueprint[] {
    return this.config.blueprints;
  }
  getBlueprint(id: BlueprintId): Blueprint | undefined {
    return this.config.blueprints.find((b) => b.id === id);
  }
  upsertBlueprint(blueprint: Blueprint): Blueprint {
    const i = this.config.blueprints.findIndex((b) => b.id === blueprint.id);
    if (i >= 0) this.config.blueprints[i] = blueprint;
    else this.config.blueprints.push(blueprint);
    this.persist();
    return blueprint;
  }
  deleteBlueprint(id: BlueprintId): void {
    this.config.blueprints = this.config.blueprints.filter((b) => b.id !== id);
    // a schedule pointing at a deleted blueprint could never fire — drop them
    this.config.schedules = this.config.schedules.filter((s) => s.blueprintId !== id);
    this.persist();
  }

  // --- schedules (cron / interval / watch triggers) ---
  listSchedules(): Schedule[] {
    return this.config.schedules;
  }
  getSchedule(id: ScheduleId): Schedule | undefined {
    return this.config.schedules.find((s) => s.id === id);
  }
  upsertSchedule(schedule: Schedule): Schedule {
    const i = this.config.schedules.findIndex((s) => s.id === schedule.id);
    if (i >= 0) this.config.schedules[i] = schedule;
    else this.config.schedules.push(schedule);
    this.persist();
    return schedule;
  }
  deleteSchedule(id: ScheduleId): void {
    this.config.schedules = this.config.schedules.filter((s) => s.id !== id);
    this.persist();
  }

  /**
   * Wipe all user configuration back to a clean slate (the empty seedConfig):
   * providers, agents, teams, projects, skills, MCP servers, goals, tasks,
   * blueprints, schedules, secrets, fusion runs. Also clears the encrypted vault
   * and removes on-disk skill + attachment files. Settings + memory return to
   * defaults. Intentionally LEAVES the isolated claude-config dir, the memory
   * root, and the instance lock alone (they are runtime/continuity state, not
   * user config). Used by the "Reset to factory" action so the user can start
   * from scratch.
   */
  factoryReset(): void {
    this.config = seedConfig();
    this.vault.clear();
    // remove on-disk skill content + goal attachments (metadata lived in config)
    for (const dir of [this.skillsDir, this.attachmentsDir]) {
      try {
        for (const entry of fs.readdirSync(dir)) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
      } catch {
        /* dir missing or unreadable — nothing to clear */
      }
    }
    this.persist();
  }

  // --- settings ---
  getSettings(): OrchestratorSettings {
    return this.config.settings;
  }
  updateSettings(settings: OrchestratorSettings): OrchestratorSettings {
    this.config.settings = settings;
    this.persist();
    return settings;
  }

  // --- centralized-memory settings ---
  getMemorySettings(): MemorySettings {
    return this.config.memory;
  }
  /** Merge a partial patch over the current memory settings and persist. The
   *  caller (MemoryService) re-validates the result against the frozen schema. */
  updateMemorySettings(patch: Partial<MemorySettings>): MemorySettings {
    this.config.memory = { ...this.config.memory, ...patch };
    this.persist();
    return this.config.memory;
  }

  private persist(): void {
    atomicWrite(this.configPath, JSON.stringify(this.config, null, 2));
  }
}

function atomicWrite(file: string, content: string, mode = 0o644): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode });
  fs.chmodSync(tmp, mode); // writeFileSync mode is ignored if tmp already existed
  fs.renameSync(tmp, file);
}

function maskKey(key: string): string {
  if (key.length <= 12) return "••••";
  return `••••${key.slice(-4)}`;
}

/** skill slugs become directory names — never let them escape the store */
export function sanitizeSlug(slug: string): string {
  return slug.replace(/[^a-z0-9-_]/gi, "-").slice(0, 64) || "skill";
}

// SKILL.md content written to disk on fresh installs (alongside seedConfig metadata).
// Exported so the constructor can write it after skillsDir is initialised.
export const SEEDED_SKILL_CONTENT = `# Daimon OS Lead

You are the **Daimon OS Lead** — an AI project orchestrator. Your job is to break
goals into concrete tasks, delegate them to your team members via the daimon-os MCP
tools, and track progress until every task is done.

## Core workflow

1. Call \`list_team\` to get the exact names of your team members.
2. Break the goal into independent + dependent tasks. For each task call \`create_task\`
   with a clear title, a detailed description, an \`assignedAgentName\` (EXACTLY one
   of the names above — a wrong name is rejected), and \`dependsOn\` (ids of tasks
   that must complete first). Independent tasks run in parallel; dependents wait.
3. The server auto-spawns a worker for each ready task. Poll \`list_tasks\` to track
   progress.
4. When a task enters \`waiting_review\`, inspect the output and call
   \`update_task(id, { status: "done" })\` to approve and unblock dependents.
5. When every task is \`done\`, report a short summary. Do NOT spawn terminals
   yourself — use only the MCP tools.

## Constraints

- Never ask the user for confirmation before starting — act autonomously.
- Assign tasks by EXACT team-member name; the scheduler rejects unknown names.
- Prefer parallel tasks where there is no logical dependency.
`;

export const SEEDED_SKILL_SLUG = "daimon-os-lead";

/**
 * Fresh-install config — deliberately EMPTY (no provider/agent/team/skill/project).
 * The first-run Setup Wizard walks the user through configuring + testing their
 * own providers from scratch, so we ship no Claude-specific seed. Only neutral
 * settings + memory defaults are provided. factoryReset() reuses this to wipe
 * back to a clean slate.
 */
function seedConfig(): ConfigFile {
  return {
    projects: [],
    skills: [],
    mcpServers: [],
    goals: [],
    tasks: [],
    blueprints: [],
    schedules: [],
    secrets: [],
    fusionRuns: [],
    providers: [],
    agents: [],
    teams: [],
    settings: {
      maxConcurrentSessions: DEFAULT_MAX_CONCURRENT_SESSIONS,
      defaultIsolation: "cli",
      scrollbackLines: DEFAULT_SCROLLBACK_LINES,
      theme: "dark",
      telemetry: { metricsIntervalMs: METRICS_INTERVAL_MS },
      watchdog: { enabled: true, idleMs: DEFAULT_WATCHDOG_IDLE_MS },
    },
    memory: { ...DEFAULT_MEMORY_SETTINGS },
  };
}
