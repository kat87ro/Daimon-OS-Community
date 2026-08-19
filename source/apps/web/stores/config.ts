"use client";

import { create } from "zustand";
import type {
  AgentDefinition,
  Blueprint,
  Goal,
  McpServer,
  MemorySettings,
  OrchestratorSettings,
  Project,
  ProviderConfig,
  Schedule,
  Secret,
  Skill,
  Team,
} from "@daimon-os/shared";
import { DEFAULT_MEMORY_SETTINGS } from "@daimon-os/shared";
import { api } from "@/lib/api";

interface ConfigState {
  providers: ProviderConfig[];
  agents: AgentDefinition[];
  teams: Team[];
  projects: Project[];
  skills: Skill[];
  mcpServers: McpServer[];
  goals: Goal[];
  secrets: Secret[];
  blueprints: Blueprint[];
  schedules: Schedule[];
  settings: OrchestratorSettings | null;
  memory: MemorySettings | null;
  loaded: boolean;
  loadAll(): Promise<void>;
  saveSecret(s: Secret, value?: string): Promise<void>;
  deleteSecret(id: string): Promise<void>;
  saveProject(p: Project): Promise<void>;
  deleteProject(id: string): Promise<void>;
  saveSkill(s: Skill): Promise<void>;
  deleteSkill(id: string): Promise<void>;
  saveMcpServer(m: McpServer): Promise<void>;
  deleteMcpServer(id: string): Promise<void>;
  saveGoal(g: Goal): Promise<void>;
  deleteGoal(id: string): Promise<void>;
  saveProvider(p: ProviderConfig, apiKey?: string): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  saveAgent(a: AgentDefinition): Promise<void>;
  deleteAgent(id: string): Promise<void>;
  saveTeam(t: Team): Promise<void>;
  deleteTeam(id: string): Promise<void>;
  saveBlueprint(b: Blueprint): Promise<void>;
  deleteBlueprint(id: string): Promise<void>;
  saveSchedule(s: Schedule): Promise<void>;
  deleteSchedule(id: string): Promise<void>;
  saveSettings(s: OrchestratorSettings): Promise<void>;
  saveMemory(patch: Partial<MemorySettings>): Promise<MemorySettings>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  providers: [],
  agents: [],
  teams: [],
  projects: [],
  skills: [],
  mcpServers: [],
  goals: [],
  secrets: [],
  blueprints: [],
  schedules: [],
  settings: null,
  memory: null,
  loaded: false,

  async loadAll() {
    const [providers, agents, teams, projects, skills, mcpServers, goals, secrets, blueprints, schedules, settings, memory] =
      await Promise.all([
        api.providers.list(),
        api.agents.list(),
        api.teams.list(),
        api.projects.list(),
        api.skills.list(),
        api.mcp.list(),
        api.goals.list(),
        api.secrets.list(),
        api.blueprints.list(),
        api.schedules.list(),
        api.settings.get(),
        api.memory.get(),
      ]);
    set({ providers, agents, teams, projects, skills, mcpServers, goals, secrets, blueprints, schedules, settings, memory, loaded: true });
  },

  async saveSecret(s, value) {
    const saved = await api.secrets.save(s, value);
    set({ secrets: upsert(get().secrets, saved) });
  },
  async deleteSecret(id) {
    await api.secrets.remove(id);
    set({
      secrets: get().secrets.filter((s) => s.id !== id),
      // server also strips the id from project.secretIds — mirror locally
      projects: get().projects.map((p) =>
        p.secretIds?.includes(id as Secret["id"])
          ? { ...p, secretIds: p.secretIds.filter((x) => x !== id) }
          : p,
      ),
    });
  },

  async saveGoal(g) {
    const saved = await api.goals.save(g);
    set({ goals: upsert(get().goals, saved) });
  },
  async deleteGoal(id) {
    await api.goals.remove(id);
    set({ goals: get().goals.filter((g) => g.id !== id) });
  },

  async saveSkill(s) {
    const saved = await api.skills.save(s);
    set({ skills: upsert(get().skills, saved) });
  },
  async deleteSkill(id) {
    await api.skills.remove(id);
    set({ skills: get().skills.filter((s) => s.id !== id) });
  },

  async saveMcpServer(m) {
    const saved = await api.mcp.save(m);
    set({ mcpServers: upsert(get().mcpServers, saved) });
  },
  async deleteMcpServer(id) {
    await api.mcp.remove(id);
    set({ mcpServers: get().mcpServers.filter((m) => m.id !== id) });
  },

  async saveProject(p) {
    const saved = await api.projects.save(p);
    set({ projects: upsert(get().projects, saved) });
  },
  async deleteProject(id) {
    const removed = new Set([
      id,
      ...get().projects
        .filter((project) => project.parentProjectId === id)
        .map((project) => project.id),
    ]);
    await api.projects.remove(id);
    set({
      projects: get().projects.filter((project) => !removed.has(project.id)),
      goals: get().goals.filter((goal) => !removed.has(goal.projectId)),
      schedules: get().schedules.filter((schedule) => !removed.has(schedule.projectId)),
    });
  },

  async saveProvider(p, apiKey) {
    const saved = await api.providers.save(p, apiKey);
    set({
      providers: upsert(get().providers, saved),
    });
  },
  async deleteProvider(id) {
    await api.providers.remove(id);
    set({ providers: get().providers.filter((p) => p.id !== id) });
  },

  async saveAgent(a) {
    const saved = await api.agents.save(a);
    set({ agents: upsert(get().agents, saved) });
  },
  async deleteAgent(id) {
    await api.agents.remove(id);
    set({ agents: get().agents.filter((a) => a.id !== id) });
  },

  async saveTeam(t) {
    const saved = await api.teams.save(t);
    set({ teams: upsert(get().teams, saved) });
  },
  async deleteTeam(id) {
    await api.teams.remove(id);
    // server reparents children — refetch so the tree reflects it
    set({ teams: await api.teams.list() });
  },

  async saveBlueprint(b) {
    const saved = await api.blueprints.save(b);
    set({ blueprints: upsert(get().blueprints, saved) });
  },
  async deleteBlueprint(id) {
    await api.blueprints.remove(id);
    set({ blueprints: get().blueprints.filter((b) => b.id !== id) });
  },

  async saveSchedule(s) {
    const saved = await api.schedules.save(s);
    set({ schedules: upsert(get().schedules, saved) });
  },
  async deleteSchedule(id) {
    await api.schedules.remove(id);
    set({ schedules: get().schedules.filter((s) => s.id !== id) });
  },

  async saveSettings(s) {
    set({ settings: await api.settings.save(s) });
  },

  async saveMemory(patch) {
    const current = get().memory ?? DEFAULT_MEMORY_SETTINGS;
    const saved = await api.memory.save({ ...current, ...patch });
    set({ memory: saved });
    return saved;
  },
}));

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  return i >= 0 ? list.map((x, j) => (j === i ? item : x)) : [...list, item];
}
