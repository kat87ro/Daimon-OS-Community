export interface UpdateInfo {
  version: string;
  url: string;
}

declare global {
  interface Window {
    daimon?: {
      launchSession(request: unknown): Promise<{ ok: boolean; canceled: boolean; session?: unknown }>;
      startProject(projectId: string): Promise<{ ok: boolean; canceled: boolean; session?: unknown }>;
      configureGitHubProject(projectId: string, repository: string): Promise<{ ok: boolean; canceled: boolean; result?: unknown }>;
      getRunDiff(runId: string): Promise<{ ok: boolean; canceled: boolean; diff?: string }>;
      respondToAttention(attentionId: string, response: string): Promise<{ ok: boolean; canceled: boolean; result?: unknown }>;
      saveSecret(payload: unknown): Promise<{ ok: boolean; canceled: boolean; secret?: unknown }>;
      removeSecret(id: string): Promise<{ ok: boolean; canceled: boolean }>;
      saveAgent(agent: unknown): Promise<{ ok: boolean; canceled: boolean; agent?: unknown }>;
      saveProject(project: unknown): Promise<{ ok: boolean; canceled: boolean; project?: unknown }>;
      approveRun(runId: string, subjectHash: string): Promise<{ ok: boolean; canceled: boolean }>;
      promoteRun(runId: string, subjectHash: string): Promise<{ ok: boolean }>;
      saveMcpServer(server: unknown): Promise<{ ok: boolean; canceled: boolean; server?: unknown }>;
      removeMcpServer(id: string): Promise<{ ok: boolean; canceled: boolean }>;
      applyProviderImport(payload: unknown): Promise<{ ok: boolean; canceled: boolean; result?: unknown }>;
      syncProviderImport(providerId: string): Promise<{ ok: boolean; canceled: boolean; result?: unknown }>;
      cloneSkill(skillId: string, providerKinds: string[]): Promise<{ ok: boolean; canceled: boolean; result?: unknown }>;
      factoryReset(): Promise<{ ok: boolean; canceled: boolean; error?: string }>;
      onUpdateAvailable(cb: (info: UpdateInfo) => void): () => void;
      checkForUpdates(): Promise<void>;
    };
  }
}

export {};
