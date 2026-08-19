"use client";

import { create } from "zustand";
import type { Task } from "@daimon-os/shared";
import { api } from "@/lib/api";

interface TaskState {
  tasks: Record<string, Task>;
  loadProject(projectId: string): Promise<void>;
  saveTask(task: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  /** requeue a failed task so the scheduler re-dispatches it */
  retryTask(id: string): Promise<void>;
  pruneProjects(validProjectIds: string[]): void;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: {},

  async loadProject(projectId) {
    const list = await api.tasks.list(projectId);
    set((s) => {
      const next = { ...s.tasks };
      // replace this project's slice without disturbing other projects
      for (const [id, t] of Object.entries(next)) {
        if (t.projectId === projectId) delete next[id];
      }
      for (const t of list) next[t.id] = t;
      return { tasks: next };
    });
  },

  async saveTask(task) {
    const exists = Boolean(get().tasks[task.id]);
    const saved = await (exists ? api.tasks.update : api.tasks.create)({
      ...task,
      updatedAt: new Date().toISOString(),
    });
    set((s) => ({ tasks: { ...s.tasks, [saved.id]: saved } }));
  },

  async deleteTask(id) {
    await api.tasks.remove(id);
    set((s) => {
      const { [id]: _gone, ...rest } = s.tasks;
      return { tasks: rest };
    });
  },

  async retryTask(id) {
    // server requeues + re-dispatches; the tasks_changed broadcast refreshes us
    await api.tasks.retry(id);
  },

  pruneProjects(validProjectIds) {
    const valid = new Set(validProjectIds);
    set((state) => ({
      tasks: Object.fromEntries(
        Object.entries(state.tasks).filter(([, task]) => valid.has(task.projectId)),
      ),
    }));
  },
}));
