"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { ExternalLink, Github, GitBranch, RefreshCw, Settings } from "lucide-react";
import { api, type GitHubRemoteStatus, type GitRepositorySnapshot } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Modal } from "./Modal";

export function GitModal({ projectId }: { projectId: string }) {
  const projects = useConfigStore((state) => state.projects);
  const project = projects.find((candidate) => candidate.id === projectId);
  const root = project?.parentProjectId
    ? projects.find((candidate) => candidate.id === project.parentProjectId)
    : project;
  const [snapshot, setSnapshot] = useState<GitRepositorySnapshot | null>(null);
  const [remote, setRemote] = useState<GitHubRemoteStatus | null>(null);
  const openModal = useUiStore((state) => state.openModal);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    setSnapshot(null);
    try {
      const [nextSnapshot, nextRemote] = await Promise.all([
        api.projects.git(projectId),
        api.github.project(projectId).catch(() => null),
      ]);
      setSnapshot(nextSnapshot);
      setRemote(nextRemote);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not inspect this repository");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [projectId]);

  return (
    <Modal title={`Git — ${root?.name ?? project?.name ?? "project"}`}>
      <div className="flex min-h-[32rem] flex-col gap-3">
        <div className="flex items-center gap-2 rounded border border-line bg-raised px-3 py-2">
          <GitBranch size={15} className="text-amber" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-text">
              {snapshot?.currentBranch ?? (snapshot?.detached ? "Detached HEAD" : "Loading repository…")}
            </p>
            <p className="truncate font-mono text-[10px] text-faint">
              {snapshot?.repoRoot ?? root?.path}
            </p>
          </div>
          {snapshot && (
            <div className="flex items-center gap-1.5 text-[10px]">
              <span className={snapshot.dirty ? "text-amber" : "text-mint"}>
                {snapshot.dirty ? `${snapshot.files.length} changed` : "clean"}
              </span>
              {(snapshot.ahead > 0 || snapshot.behind > 0) && (
                <span className="text-soft">↑{snapshot.ahead} ↓{snapshot.behind}</span>
              )}
            </div>
          )}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            title="Refresh Git status"
            className="rounded border border-line p-1.5 text-soft hover:border-amber hover:text-text disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {project?.parentProjectId && (
          <p className="rounded border border-sky/30 bg-sky/5 px-3 py-2 text-[11px] text-sky">
            Feature project “{project.name}” shares this root repository, while its goals, tasks,
            sessions and approvals remain independently scoped.
          </p>
        )}
        <section className="rounded border border-line bg-raised/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Github size={14} className={remote?.repository ? "text-mint" : "text-soft"} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-text">GitHub repository</p>
              <p className="truncate font-mono text-[10px] text-faint">
                {remote?.repository ?? (remote?.configured ? "origin is not a supported github.com URL" : "No GitHub origin linked")}
              </p>
            </div>
            {remote?.githubUrl && (
              <a href={remote.githubUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] text-sky hover:underline">
                Open <ExternalLink size={10} />
              </a>
            )}
            <button
              onClick={() => openModal({ type: "configuration", tab: "github" })}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[10px] text-soft hover:border-amber hover:text-text"
            >
              <Settings size={10} /> Configure GitHub
            </button>
          </div>
        </section>
        {error && <p className="rounded border border-rust/40 bg-rust/5 p-3 text-xs text-rust">{error}</p>}
        {snapshot && (
          <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[0.85fr_1.4fr]">
            <div className="flex min-h-0 flex-col gap-3">
              <section className="min-h-0 rounded border border-line bg-ink">
                <h3 className="border-b border-line px-3 py-2 text-xs font-semibold text-soft">
                  Working tree ({snapshot.files.length})
                </h3>
                <div className="max-h-44 overflow-y-auto p-2">
                  {snapshot.files.length === 0 ? (
                    <p className="px-1 py-2 text-[11px] text-faint">No local changes.</p>
                  ) : (
                    snapshot.files.map((file) => (
                      <div key={`${file.path}:${file.status}`} className="flex gap-2 py-0.5 font-mono text-[10px]">
                        <span className={clsx("w-6 flex-none", file.staged ? "text-mint" : "text-amber")}>
                          {file.status}
                        </span>
                        <span className="min-w-0 truncate text-soft" title={file.path}>{file.path}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>
              <section className="min-h-0 rounded border border-line bg-ink">
                <h3 className="border-b border-line px-3 py-2 text-xs font-semibold text-soft">
                  Recent commits
                </h3>
                <div className="max-h-52 overflow-y-auto p-2">
                  {snapshot.commits.map((commit) => (
                    <div key={commit.hash} className="border-b border-line/60 px-1 py-1.5 last:border-0">
                      <p className="line-clamp-2 text-[11px] text-text">{commit.subject}</p>
                      <p className="mt-0.5 font-mono text-[9px] text-faint">
                        {commit.shortHash} · {commit.authorName} · {new Date(commit.authoredAt).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </section>
            </div>
            <section className="flex min-h-0 flex-col rounded border border-line bg-ink">
              <div className="flex items-center justify-between border-b border-line px-3 py-2">
                <h3 className="text-xs font-semibold text-soft">Bounded working-tree diff</h3>
                {snapshot.truncated && <span className="text-[9px] uppercase text-amber">truncated</span>}
              </div>
              <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-relaxed text-soft">
                {snapshot.diff || "No tracked changes to display. Untracked files are listed at left."}
              </pre>
            </section>
          </div>
        )}
        <p className="text-[10px] leading-relaxed text-faint">
          This release exposes read-only status, history and evidence. Agent changes are promoted through
          Daimon’s exact-hash review workflow; direct stage, commit and push controls are intentionally absent.
        </p>
      </div>
    </Modal>
  );
}
