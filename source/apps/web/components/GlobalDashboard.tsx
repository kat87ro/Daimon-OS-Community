"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  ChevronRight,
  GitBranch,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  ShieldCheck,
  Plus,
  RefreshCw,
  Target,
} from "lucide-react";
import type { Task } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useAttentionStore } from "@/stores/attention";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

const OPEN_TASKS = new Set<Task["status"]>([
  "backlog", "in_progress", "blocked", "waiting_review",
]);

export function GlobalDashboard() {
  const projects = useConfigStore((state) => state.projects);
  const providers = useConfigStore((state) => state.providers);
  const agents = useConfigStore((state) => state.agents);
  const goals = useConfigStore((state) => state.goals);
  // Select the stable record from Zustand; creating Object.values inside the
  // selector produces a new snapshot every read and React 18 treats it as an
  // infinite external-store update in production.
  const sessionRecord = useSessionStore((state) => state.sessions);
  const sessions = useMemo(() => Object.values(sessionRecord), [sessionRecord]);
  const attention = useAttentionStore((state) => state.records);
  const attentionLoading = useAttentionStore((state) => state.loading);
  const refreshAttention = useAttentionStore((state) => state.refresh);
  const setActiveProject = useLayoutStore((state) => state.setActiveProject);
  const setGlobalView = useLayoutStore((state) => state.setGlobalView);
  const openModal = useUiStore((state) => state.openModal);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [allTasks] = await Promise.all([api.tasks.list(), refreshAttention()]);
      setTasks(allTasks);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Dashboard refresh failed");
    } finally {
      setLoading(false);
    }
  }, [refreshAttention]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const roots = projects.filter((project) => !project.parentProjectId);
  const liveSessions = sessions.filter((session) =>
    !["completed", "failed", "killed"].includes(session.status),
  );
  const openTasks = tasks.filter((task) => OPEN_TASKS.has(task.status));
  const reviewTasks = tasks.filter((task) => task.status === "waiting_review");

  const tasksByProject = useMemo(() => {
    const result = new Map<string, Task[]>();
    for (const task of tasks) {
      const current = result.get(task.projectId) ?? [];
      current.push(task);
      result.set(task.projectId, current);
    }
    return result;
  }, [tasks]);

  const statCards = [
    { label: "Root projects", value: roots.length, detail: `${projects.length - roots.length} feature projects`, icon: Boxes, color: "text-amber" },
    { label: "Live agents", value: liveSessions.length, detail: `${agents.length} configured agents`, icon: Activity, color: "text-mint" },
    { label: "Need input", value: attention.length, detail: `${reviewTasks.length} awaiting review`, icon: MessageSquare, color: "text-sky" },
    { label: "Open delivery tasks", value: openTasks.length, detail: `${providers.length} provider connections`, icon: ListChecks, color: "text-plum" },
  ];

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-ink p-4 lg:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-text">
              <LayoutDashboard size={20} className="text-amber" />
              <h1 className="text-lg font-semibold">Dashboard</h1>
            </div>
            <p className="mt-1 text-xs text-soft">
              Every root project, feature, running agent, pending decision, and delivery queue in one place.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setGlobalView("master-chat")}
              className="flex items-center gap-1.5 rounded border border-sky/40 bg-sky/5 px-3 py-2 text-xs font-medium text-sky hover:bg-sky/10"
            >
              <MessageSquare size={13} /> Master Chat
              {attention.length > 0 && <span className="rounded-full bg-sky px-1.5 text-[10px] text-white">{attention.length}</span>}
            </button>
            <button
              onClick={() => setGlobalView("audit")}
              className="flex items-center gap-1.5 rounded border border-mint/40 bg-mint/5 px-3 py-2 text-xs font-medium text-mint hover:bg-mint/10"
            >
              <ShieldCheck size={13} /> Audit log
            </button>
            <button
              onClick={() => openModal({ type: "project" })}
              className="flex items-center gap-1.5 rounded bg-amber px-3 py-2 text-xs font-medium text-ink hover:bg-amber/90"
            >
              <Plus size={13} /> New project
            </button>
            <button
              onClick={() => void refresh()}
              disabled={loading || attentionLoading}
              title="Refresh dashboard"
              className="rounded border border-line p-2 text-soft hover:border-amber hover:text-text disabled:opacity-40"
            >
              <RefreshCw size={13} className={loading || attentionLoading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {error && (
          <p className="rounded border border-rust/40 bg-rust/5 px-3 py-2 text-xs text-rust">{error}</p>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {statCards.map(({ label, value, detail, icon: Icon, color }) => (
            <article key={label} className="rounded border border-line bg-panel p-3">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</p>
                <Icon size={14} className={color} />
              </div>
              <p className="mt-2 text-2xl font-semibold text-text">{value}</p>
              <p className="mt-1 text-[10px] text-soft">{detail}</p>
            </article>
          ))}
        </section>

        {roots.length === 0 ? (
          <section className="rounded border border-line bg-panel p-5">
            <h2 className="text-sm font-semibold text-text">Make Daimon usable in three steps</h2>
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <button
                onClick={() => openModal({ type: "configuration", tab: "providers" })}
                className="rounded border border-line bg-raised p-4 text-left hover:border-amber"
              >
                <Bot size={17} className="text-plum" />
                <p className="mt-2 text-xs font-semibold text-text">1. Configure providers</p>
                <p className="mt-1 text-[11px] text-soft">Connect Claude, Codex, Gemini, or an on-device Ollama/LM Studio model.</p>
              </button>
              <button
                onClick={() => openModal({ type: "project" })}
                className="rounded border border-line bg-raised p-4 text-left hover:border-amber"
              >
                <Boxes size={17} className="text-amber" />
                <p className="mt-2 text-xs font-semibold text-text">2. Add a root project</p>
                <p className="mt-1 text-[11px] text-soft">Select a Git repository, then add feature projects and goals beneath it.</p>
              </button>
              <button
                onClick={() => setGlobalView("master-chat")}
                className="rounded border border-line bg-raised p-4 text-left hover:border-sky"
              >
                <MessageSquare size={17} className="text-sky" />
                <p className="mt-2 text-xs font-semibold text-text">3. Operate from Master Chat</p>
                <p className="mt-1 text-[11px] text-soft">Answer agent questions and open decisions across every project.</p>
              </button>
            </div>
          </section>
        ) : (
          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-text">Project portfolio</h2>
              <span className="text-[10px] text-faint">Root projects and independently governed features</span>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {roots.map((root) => {
                const features = projects.filter((project) => project.parentProjectId === root.id);
                const scopedIds = new Set<string>([String(root.id), ...features.map((feature) => String(feature.id))]);
                const scopedTasks = tasks.filter((task) => scopedIds.has(String(task.projectId)));
                const scopedAttention = attention.filter((item) => scopedIds.has(String(item.projectId)));
                const scopedSessions = liveSessions.filter((session) => session.projectId && scopedIds.has(String(session.projectId)));
                return (
                  <article key={root.id} className="rounded border border-line bg-panel p-3">
                    <div className="flex items-start gap-3">
                      <button onClick={() => setActiveProject(root.id)} className="min-w-0 flex-1 text-left">
                        <p className="truncate text-sm font-semibold text-text">{root.name}</p>
                        <p className="truncate font-mono text-[10px] text-faint">{root.path}</p>
                      </button>
                      <button
                        onClick={() => setActiveProject(root.id)}
                        className="rounded border border-line p-1.5 text-soft hover:border-amber hover:text-text"
                        title={`Open ${root.name}`}
                      >
                        <ChevronRight size={13} />
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                      <span className="rounded bg-raised px-2 py-1 text-soft">{features.length} features</span>
                      <span className="rounded bg-raised px-2 py-1 text-mint">{scopedSessions.length} live</span>
                      <span className="rounded bg-raised px-2 py-1 text-sky">{scopedAttention.length} need input</span>
                      <span className="rounded bg-raised px-2 py-1 text-plum">{scopedTasks.filter((task) => OPEN_TASKS.has(task.status)).length} open tasks</span>
                    </div>
                    {features.length > 0 && (
                      <div className="mt-3 grid gap-1.5">
                        {features.map((feature) => (
                          <button
                            key={feature.id}
                            onClick={() => setActiveProject(feature.id)}
                            className="flex items-center justify-between rounded border border-line/70 bg-ink px-2.5 py-2 text-left hover:border-amber"
                          >
                            <span className="min-w-0 truncate text-[11px] text-soft">{feature.name}</span>
                            <span className="text-[9px] text-faint">
                              {(tasksByProject.get(feature.id) ?? []).filter((task) => OPEN_TASKS.has(task.status)).length} open
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                      <button onClick={() => openModal({ type: "project", parentProjectId: root.id })} className="flex items-center gap-1 text-[10px] text-soft hover:text-amber">
                        <GitBranch size={11} /> Add feature
                      </button>
                      <button onClick={() => openModal({ type: "goal", projectId: root.id })} className="flex items-center gap-1 text-[10px] text-soft hover:text-amber">
                        <Target size={11} /> Add goal
                      </button>
                      <button onClick={() => openModal({ type: "git", projectId: root.id })} className="flex items-center gap-1 text-[10px] text-soft hover:text-sky">
                        <GitBranch size={11} /> Git &amp; GitHub
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {goals.length > 0 && (
          <p className="text-[10px] text-faint">{goals.filter((goal) => goal.status === "active").length} active goals across {projects.length} project scopes.</p>
        )}
      </div>
    </main>
  );
}
