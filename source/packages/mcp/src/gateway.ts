import type {
  AgentDefinition,
  Task,
  TaskInputRequest,
  TaskInputRequestResult,
  Team,
} from "@daimon-os/shared";

/**
 * Thin REST client the daimon-mcp tools call against the local gateway. Kept
 * separate from the stdio wiring so the tool logic is unit-testable without a
 * live MCP transport.
 */
export class GatewayClient {
  private context?: Promise<{ team: Team; agents: AgentDefinition[] }>;

  constructor(
    private readonly baseUrl: string,
    private readonly projectId: string,
    private readonly teamId?: string,
    private readonly authToken: string | undefined = process.env.DAIMON_MCP_TOKEN,
  ) {}

  private async http<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (init?.body) headers.set("content-type", "application/json");
    if (this.authToken) headers.set("authorization", `Bearer ${this.authToken}`);
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      // Preserve the gateway's bounded validation/quota reason so a Lead can
      // correct its request instead of blindly retrying a 409/429 response.
      const raw = (await res.text()).slice(0, 1_024);
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as { error?: unknown };
        if (typeof parsed.error === "string") detail = parsed.error;
      } catch {
        // Non-JSON gateway/proxy response: retain the bounded text.
      }
      throw new Error(
        `${init?.method ?? "GET"} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  /**
   * The scoped Lead credential cannot enumerate the global agent registry. Keep
   * one project/team projection for this MCP process instead; Lead MCP servers
   * are restarted when a project run starts, so the cache has run lifetime.
   */
  private orchestrationContext(): Promise<{ team: Team; agents: AgentDefinition[] }> {
    this.context ??= this.http<{ team: Team; agents: AgentDefinition[] }>(
      `/api/orchestration/context?projectId=${encodeURIComponent(this.projectId)}`,
    );
    return this.context;
  }

  /** team roster with the reporting line, so the Lead delegates down the chain:
   *  each member shows who it reports to and who reports to it. */
  async listTeam(): Promise<
    {
      name: string;
      role?: string;
      agentId: string;
      isLead: boolean;
      reportsTo?: string;
      directReports: string[];
    }[]
  > {
    const { team, agents } = await this.orchestrationContext();
    const ids = new Set(team?.memberAgentIds ?? []);
    const nameOf = (id?: string) => agents.find((a) => a.id === id)?.name;
    const superiorOf = (id: string) =>
      team?.managers?.[id] ?? (id === team?.supervisorAgentId ? undefined : team?.supervisorAgentId);
    return agents
      .filter((a) => ids.has(a.id))
      .map((a) => ({
        name: a.name,
        role: a.description,
        agentId: a.id,
        isLead: a.id === team?.supervisorAgentId,
        reportsTo: nameOf(superiorOf(a.id)),
        directReports: [...ids]
          .filter((id) => id !== a.id && superiorOf(id) === a.id)
          .map((id) => nameOf(id))
          .filter((n): n is string => Boolean(n)),
      }));
  }

  async listTasks(): Promise<Task[]> {
    return this.http<Task[]>(`/api/tasks?projectId=${this.projectId}`);
  }

  async getTask(id: string): Promise<Task | undefined> {
    return (await this.listTasks()).find((t) => t.id === id);
  }

  async createTask(input: {
    title: string;
    description?: string;
    assignedAgentName?: string;
    dependsOn?: string[];
    lane?: string;
    priority?: number;
    notBefore?: string;
  }): Promise<Task> {
    const { team, agents } = await this.orchestrationContext();
    const memberIds = new Set(team.memberAgentIds);
    const assignableAgents = agents.filter((candidate) => memberIds.has(candidate.id));
    let agent: AgentDefinition | undefined;
    if (input.assignedAgentName) {
      // exact, then case-insensitive — but a name that matches NOTHING is a hard
      // error: an unassigned task is silently skipped by the scheduler forever,
      // so fail loudly back to the Lead instead of creating a dead task
      agent =
        assignableAgents.find((a) => a.name === input.assignedAgentName) ??
        assignableAgents.find(
          (a) => a.name.toLowerCase() === input.assignedAgentName!.toLowerCase(),
        );
      if (!agent) {
        throw new Error(
          `No agent named "${input.assignedAgentName}". Call list_team for the exact member names and retry with one of those.`,
        );
      }
    }
    const deps = input.dependsOn ?? [];
    if (!agent) throw new Error("assignedAgentName is required for orchestration tasks");
    return this.http<Task>("/api/orchestration/tasks", {
      method: "POST",
      body: JSON.stringify({
        projectId: this.projectId,
        title: input.title,
        description: input.description,
        assignedAgentName: agent.name,
        dependsOn: deps,
        lane: input.lane,
        priority: input.priority,
        notBefore: input.notBefore,
      }),
    });
  }

  async updateTask(
    id: string,
    patch: Partial<Pick<Task, "status" | "description" | "lane" | "priority" | "notBefore">>,
  ): Promise<Task> {
    // PATCH with ONLY the caller's fields — the server merges onto the
    // authoritative task, so we never read-modify-write a stale snapshot that
    // would clobber server-owned fields (channel, idle, retryCount, costUsd).
    return this.http<Task>(`/api/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  }

  async requestInput(id: string, input: TaskInputRequest): Promise<TaskInputRequestResult> {
    return this.http<TaskInputRequestResult>(`/api/orchestration/tasks/${id}/input`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async publishArtifact(input: {
    name: string;
    content: string;
    mediaType?: string;
    expectedVersion: number;
  }): Promise<unknown> {
    const { team } = await this.orchestrationContext();
    if (!team.supervisorAgentId) throw new Error("project team has no supervisor identity");
    return this.http("/api/control/artifacts", {
      method: "POST",
      body: JSON.stringify({
        projectId: this.projectId,
        ownerAgentId: team.supervisorAgentId,
        mediaType: input.mediaType ?? "text/markdown",
        ...input,
      }),
    });
  }

  async listArtifacts(): Promise<unknown> {
    return this.http(`/api/control/artifacts?projectId=${encodeURIComponent(this.projectId)}`);
  }

  async readArtifact(name: string): Promise<unknown> {
    return this.http(
      `/api/control/artifacts/content?projectId=${encodeURIComponent(this.projectId)}&name=${encodeURIComponent(name)}`,
    );
  }

  async sendMessage(input: {
    idempotencyKey: string;
    kind: "finding" | "question" | "answer" | "handoff" | "steering" | "artifact" | "status";
    body: string;
    toAgentName?: string;
    artifactName?: string;
    artifactVersion?: number;
    causationId?: string;
  }): Promise<unknown> {
    const { team, agents } = await this.orchestrationContext();
    if (!team.supervisorAgentId) throw new Error("project team has no supervisor identity");
    const toAgent = input.toAgentName
      ? agents.find((candidate) => candidate.name === input.toAgentName) ??
        agents.find((candidate) => candidate.name.toLowerCase() === input.toAgentName!.toLowerCase())
      : undefined;
    if (input.toAgentName && !toAgent) throw new Error(`No project agent named "${input.toAgentName}"`);
    const { toAgentName: _name, ...message } = input;
    return this.http("/api/control/messages", {
      method: "POST",
      body: JSON.stringify({
        projectId: this.projectId,
        fromAgentId: team.supervisorAgentId,
        toAgentId: toAgent?.id,
        ...message,
        causationId: input.causationId ?? `message:${input.idempotencyKey.slice(0, 248)}`,
      }),
    });
  }

  async listMessages(since?: string): Promise<unknown> {
    const query = new URLSearchParams({ projectId: this.projectId });
    if (since) query.set("since", since);
    return this.http(`/api/control/messages?${query.toString()}`);
  }
}
