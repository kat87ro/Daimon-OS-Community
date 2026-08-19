"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Github, Link2, RefreshCw, ShieldCheck, Terminal } from "lucide-react";
import { api, type GitHubAccountStatus, type GitHubRemoteStatus } from "@/lib/api";
import { gateway } from "@/lib/gateway/GatewayClient";
import { useConfigStore } from "@/stores/config";

interface ProjectConnection {
  remote?: GitHubRemoteStatus;
  repository: string;
  loading: boolean;
  message?: string;
  error?: string;
}

export function GitHubSettings() {
  const projects = useConfigStore((state) => state.projects).filter((project) => !project.parentProjectId);
  const [account, setAccount] = useState<GitHubAccountStatus | null>(null);
  const [connections, setConnections] = useState<Record<string, ProjectConnection>>({});
  const [loading, setLoading] = useState(true);
  const [accountError, setAccountError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setAccountError(null);
    try {
      const [nextAccount, ...remotes] = await Promise.all([
        api.github.status(),
        ...projects.map((project) => api.github.project(project.id).catch(() => undefined)),
      ]);
      setAccount(nextAccount);
      setConnections((current) => Object.fromEntries(projects.map((project, index) => {
        const remote = remotes[index];
        return [project.id, {
          remote,
          repository: current[project.id]?.repository ?? remote?.repository ?? "",
          loading: false,
        }];
      })));
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "GitHub status could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [projects]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAuthPane = (mode: "login" | "switch") => {
    gateway.spawn({
      kind: "shell",
      displayName: mode === "login" ? "GitHub authentication" : "Switch GitHub account",
      command: mode === "login"
        ? "gh auth login --hostname github.com --git-protocol https --web --clipboard"
        : "gh auth switch --hostname github.com",
    });
  };

  const configure = async (projectId: string) => {
    const repository = connections[projectId]?.repository.trim() ?? "";
    setConnections((current) => ({
      ...current,
      [projectId]: { ...current[projectId], repository, loading: true, error: undefined, message: undefined },
    }));
    try {
      const result = await api.github.configure(projectId, repository);
      setConnections((current) => ({
        ...current,
        [projectId]: {
          repository: result.repository.nameWithOwner,
          remote: result.remote,
          loading: false,
          message: `Linked to ${result.repository.nameWithOwner}. No code was pushed.`,
        },
      }));
    } catch (cause) {
      setConnections((current) => ({
        ...current,
        [projectId]: {
          ...(current[projectId] ?? { repository, loading: false }),
          loading: false,
          error: cause instanceof Error ? cause.message : "Repository could not be linked",
        },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded border border-line bg-raised/40 p-3">
        <div className="flex flex-wrap items-start gap-3">
          <Github size={18} className={account?.authenticated ? "text-mint" : "text-soft"} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-text">GitHub account</p>
            {loading ? (
              <p className="mt-1 text-[11px] text-faint">Checking GitHub CLI and keyring authentication…</p>
            ) : account?.authenticated ? (
              <>
                <p className="mt-1 flex items-center gap-1 text-[11px] text-mint"><CheckCircle2 size={11} /> Connected as {account.login}</p>
                <p className="mt-1 text-[10px] text-faint">gh {account.version} · {account.gitProtocol} · credential source: {account.tokenSource ?? "GitHub CLI"}</p>
                {account.scopes && <p className="mt-1 text-[10px] text-faint">Scopes: {account.scopes.join(", ")}</p>}
              </>
            ) : (
              <p className="mt-1 text-[11px] text-amber">{account?.error ?? "No active github.com account."}</p>
            )}
            {accountError && <p className="mt-1 text-[11px] text-rust">{accountError}</p>}
          </div>
          <button onClick={() => void refresh()} disabled={loading} className="rounded border border-line p-2 text-soft hover:border-amber hover:text-text disabled:opacity-40" title="Refresh GitHub status">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          <button onClick={() => openAuthPane("login")} className="flex items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[11px] text-soft hover:border-amber hover:text-text">
            <Terminal size={12} /> Authenticate GitHub CLI
          </button>
          {account?.authenticated && (
            <button onClick={() => openAuthPane("switch")} className="flex items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[11px] text-soft hover:border-sky hover:text-sky">
              <ShieldCheck size={12} /> Switch active account
            </button>
          )}
          <a href="https://github.com/new" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[11px] text-soft hover:border-sky hover:text-sky">
            <ExternalLink size={12} /> Create repository on GitHub
          </a>
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-faint">Daimon reads the active account from GitHub CLI. Tokens remain in the OS keyring and are never copied into Daimon configuration.</p>
      </section>

      <section>
        <h3 className="text-xs font-semibold text-text">Project repositories</h3>
        <p className="mt-1 text-[10px] text-faint">Link an existing accessible GitHub repository to the local root project. Feature projects share their root repository.</p>
        {projects.length === 0 ? (
          <p className="mt-3 rounded border border-line bg-raised/40 p-3 text-[11px] text-faint">Create a root project first, then return here to link its GitHub repository.</p>
        ) : (
          <div className="mt-3 grid gap-2">
            {projects.map((project) => {
              const connection = connections[project.id] ?? { repository: "", loading: false };
              return (
                <div key={project.id} className="rounded border border-line bg-ink p-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-text">{project.name}</p>
                      <p className="truncate font-mono text-[9px] text-faint">{project.path}</p>
                    </div>
                    {connection.remote?.githubUrl && (
                      <a href={connection.remote.githubUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] text-sky hover:underline">
                        Open repository <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      value={connection.repository}
                      onChange={(event) => setConnections((current) => ({
                        ...current,
                        [project.id]: { ...connection, repository: event.target.value, message: undefined, error: undefined },
                      }))}
                      placeholder="owner/repository"
                      spellCheck={false}
                      className="min-w-0 flex-1 rounded border border-line bg-raised px-2.5 py-1.5 font-mono text-[11px] text-text outline-none placeholder:text-faint focus:border-amber"
                    />
                    <button
                      onClick={() => void configure(project.id)}
                      disabled={!account?.authenticated || !connection.repository.trim() || connection.loading}
                      className="flex items-center justify-center gap-1.5 rounded bg-amber px-3 py-1.5 text-[11px] font-medium text-ink hover:bg-amber/90 disabled:opacity-40"
                    >
                      <Link2 size={12} /> {connection.loading ? "Verifying…" : connection.remote?.configured ? "Update origin" : "Link origin"}
                    </button>
                  </div>
                  {connection.message && <p role="status" className="mt-2 text-[10px] text-mint">{connection.message}</p>}
                  {connection.error && <p role="alert" className="mt-2 text-[10px] text-rust">{connection.error}</p>}
                  {connection.remote?.configured && !connection.remote.repository && (
                    <p className="mt-2 text-[10px] text-amber">The current origin is not a supported github.com remote. Linking replaces only its URL after native confirmation.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
