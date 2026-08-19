"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Plus, RotateCcw, X } from "lucide-react";
import { KANBAN_COLUMNS } from "@daimon-os/shared";
import type { Task, TaskStatus } from "@daimon-os/shared";
import { gateway } from "@/lib/gateway/GatewayClient";
import { useConfigStore } from "@/stores/config";
import { useTaskStore } from "@/stores/tasks";
import { useUiStore } from "@/stores/ui";

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  backlog: "border-faint/40",
  in_progress: "border-amber/50",
  waiting_review: "border-sky/50",
  blocked: "border-rust/50",
  failed: "border-rust/70",
  done: "border-mint/40",
};

const MANUAL_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  backlog: new Set(["blocked"]),
  blocked: new Set(["backlog"]),
  in_progress: new Set(),
  waiting_review: new Set(),
  failed: new Set(),
  done: new Set(["backlog"]),
};

export function KanbanBoard({ projectId }: { projectId: string }) {
  const tasks = useTaskStore((s) => s.tasks);
  const loadProject = useTaskStore((s) => s.loadProject);
  const saveTask = useTaskStore((s) => s.saveTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const retryTask = useTaskStore((s) => s.retryTask);
  const project = useConfigStore((s) => s.projects.find((p) => p.id === projectId));
  const openModal = useUiStore((s) => s.openModal);
  const [showAllDone, setShowAllDone] = useState(false);
  const DONE_PREVIEW = 5;

  // remove a task card — and if a worker is live on it, stop that worker first
  // so we never orphan a running agent (e.g. an idling interactive CLI)
  function removeTask(t: Task) {
    if (t.channel) gateway.close(t.channel);
    void deleteTask(t.id);
  }

  useEffect(() => {
    void loadProject(projectId);
  }, [projectId, loadProject]);

  const projectTasks = Object.values(tasks).filter((t) => t.projectId === projectId);
  const depTitle = (t: Task) =>
    t.dependsOn
      .map((id) => tasks[id]?.title)
      .filter(Boolean)
      .join(", ");

  const spent = projectTasks.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  const budget = project?.budgetUsd;
  const overBudget = budget !== undefined && spent >= budget;

  return (
    <main className="min-w-0 flex-1 overflow-x-auto bg-ink p-3">
      {spent > 0 && (
        <div className="mb-2 flex items-center gap-2 px-1 text-[11px]">
          <span className="text-soft">
            Spend: <span className={clsx("font-mono", overBudget ? "text-rust" : "text-mint")}>${spent.toFixed(2)}</span>
            {budget !== undefined && <span className="text-faint"> / ${budget.toFixed(2)} budget</span>}
          </span>
          {overBudget && <span className="text-rust">⚠ budget reached — workers paused</span>}
        </div>
      )}
      {/* mobile: horizontally scrollable scroll-snap lane row; desktop: standard board */}
      <div
        className="flex snap-x snap-mandatory gap-3 sm:snap-none"
        style={{ minWidth: "max-content" }}
      >
        {KANBAN_COLUMNS.map(({ status, label }) => {
          const col = projectTasks.filter((t) => t.status === status);
          const isDone = status === "done";
          const collapsed = isDone && !showAllDone && col.length > DONE_PREVIEW;
          const visible = collapsed ? col.slice(0, DONE_PREVIEW) : col;

          const renderCard = (t: Task) => (
            <div
              key={t.id}
              draggable={MANUAL_TRANSITIONS[t.status].size > 0}
              onDragStart={(e) => e.dataTransfer.setData("text/task", t.id)}
              className={clsx(
                "group relative cursor-grab rounded-lg border bg-raised p-2.5 text-xs active:cursor-grabbing",
                COLUMN_ACCENT[status],
              )}
            >
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  removeTask(t);
                }}
                title={t.channel ? "Stop the worker and delete this task" : "Delete this task"}
                className="absolute right-1 top-1 rounded p-0.5 text-faint opacity-0 hover:bg-rust/15 hover:text-rust group-hover:opacity-100"
              >
                <X size={12} />
              </button>
              <div className="pr-4 font-sans font-medium leading-snug text-text">{t.title}</div>
              {t.assignedAgentName && (
                <div className="mt-1 font-sans text-plum">
                  {t.assignedAgentName}
                  {t.channel && status === "in_progress" && !t.idle && (
                    <span className="ml-1 font-mono text-[10px] text-amber">● live</span>
                  )}
                  {status === "in_progress" && t.idle && (
                    <span
                      className="ml-1 font-mono text-[10px] text-rust"
                      title="No output for a while — the worker may have finished without reporting. Check the pane or re-run its review command."
                    >
                      ⚠ idle
                    </span>
                  )}
                </div>
              )}
              {status === "blocked" && depTitle(t) && (
                <div className="mt-1 font-mono text-[10px] text-rust">waiting on: {depTitle(t)}</div>
              )}
              {status === "waiting_review" && (
                <button
                  onClick={() => openModal({ type: "review", taskId: t.id })}
                  className="mt-2 flex items-center gap-1 rounded border border-mint/40 px-2 py-0.5 font-sans text-[11px] text-mint hover:bg-mint/10"
                >
                  <Check size={11} /> Review
                </button>
              )}
              {status === "failed" && (
                <button
                  onClick={() => void retryTask(t.id)}
                  className="mt-2 flex items-center gap-1 rounded border border-amber/50 px-2 py-0.5 font-sans text-[11px] text-amber hover:bg-amber/10"
                >
                  <RotateCcw size={11} /> Retry
                </button>
              )}
            </div>
          );

          return (
            <div
              key={status}
              className="flex w-[80vw] shrink-0 snap-start flex-col gap-2 sm:w-60 sm:flex-none"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const id = e.dataTransfer.getData("text/task");
                const t = id ? tasks[id] : undefined;
                if (t && MANUAL_TRANSITIONS[t.status].has(status)) {
                  void saveTask({ ...t, status });
                }
              }}
            >
              <div className="flex items-center justify-between px-1">
                <span className="font-sans text-xs font-semibold text-text">{label}</span>
                <span className="rounded-full bg-raised px-1.5 py-px font-mono text-[10px] text-soft">
                  {col.length}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                {visible.map(renderCard)}
                {collapsed && (
                  <button
                    onClick={() => setShowAllDone(true)}
                    className="rounded-lg border border-dashed border-line py-1.5 font-sans text-[11px] text-soft hover:border-mint hover:text-mint"
                  >
                    View completed ({col.length})
                  </button>
                )}
                {isDone && showAllDone && col.length > DONE_PREVIEW && (
                  <button
                    onClick={() => setShowAllDone(false)}
                    className="rounded-lg border border-dashed border-line py-1.5 font-sans text-[11px] text-faint hover:border-soft hover:text-soft"
                  >
                    Collapse completed
                  </button>
                )}
                {col.length === 0 && (
                  <div className="flex items-center justify-center rounded-lg border border-dashed border-line py-6 font-sans text-[11px] text-faint">
                    Drop tasks here
                  </div>
                )}
                <button
                  onClick={() => openModal({ type: "task", projectId })}
                  className="flex items-center justify-center gap-1 rounded-lg border border-dashed border-line py-2 font-sans text-[11px] text-faint hover:border-amber hover:text-amber"
                >
                  <Plus size={12} /> Add task
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {projectTasks.length === 0 && (
        <p className="mt-4 font-sans text-xs text-faint">
          No tasks yet — add one, or start the team Lead (Phase 2v2-B) to decompose the goal.
        </p>
      )}
    </main>
  );
}
