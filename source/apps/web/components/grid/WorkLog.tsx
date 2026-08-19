"use client";

import { useEffect } from "react";
import type { Task } from "@daimon-os/shared";
import { useTaskStore } from "@/stores/tasks";
import { TaskStatusBadge } from "./TaskStatusBadge";

export function WorkLog({ projectId }: { projectId: string }) {
  const tasks = useTaskStore((s) => s.tasks);
  const loadProject = useTaskStore((s) => s.loadProject);

  useEffect(() => {
    void loadProject(projectId);
  }, [projectId, loadProject]);

  const rows = Object.values(tasks)
    .filter((t) => t.projectId === projectId)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const blockedOn = (t: Task) =>
    t.dependsOn.map((id) => tasks[id]?.title).filter(Boolean).join(", ");

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-ink p-3">
      {rows.length === 0 ? (
        <p className="font-sans text-xs text-faint">No tasks logged for this project yet.</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-line text-left font-sans text-soft">
              <th className="py-1.5 pr-3 font-semibold">Task</th>
              <th className="py-1.5 pr-3 font-semibold">Agent</th>
              <th className="py-1.5 pr-3 font-semibold">Status</th>
              <th className="py-1.5 pr-3 font-semibold">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b border-line/60 hover:bg-raised/40">
                <td className="py-1.5 pr-3 font-sans text-text">
                  {t.title}
                  {t.createdBy === "lead" && (
                    <span className="ml-1.5 font-mono text-[10px] text-faint">(by Lead)</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 font-sans text-plum">{t.assignedAgentName ?? "—"}</td>
                <td className="py-1.5 pr-3">
                  <TaskStatusBadge status={t.status} />
                  {t.status === "blocked" && blockedOn(t) && (
                    <span className="ml-1.5 font-sans text-soft">waiting on {blockedOn(t)}</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 font-mono text-soft">
                  {new Date(t.updatedAt).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
