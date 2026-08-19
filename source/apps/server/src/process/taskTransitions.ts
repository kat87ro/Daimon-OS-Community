import type { Task, TaskStatus } from "@daimon-os/shared";

/** Status changes a REST/UI/MCP caller may request. Runtime states stay server-owned. */
const CLIENT_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  backlog: new Set(["backlog", "blocked"]),
  blocked: new Set(["blocked", "backlog"]),
  in_progress: new Set(["in_progress"]),
  // Only the exact-hash promotion endpoint may transition a reviewed task to done.
  waiting_review: new Set(["waiting_review", "backlog"]),
  done: new Set(["done", "backlog"]),
  failed: new Set(["failed"]),
};

export function isClientTaskTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  return CLIENT_TRANSITIONS[from].has(to);
}

/** A project-scoped Lead may request changes before approval, but cannot replay
 * human-completed work. Global UI callers retain the broader transition table. */
export function isScopedTaskTransitionAllowed(from: TaskStatus, to: TaskStatus): boolean {
  if (from === "done") return false;
  return isClientTaskTransitionAllowed(from, to);
}

export function clientTaskUpdate(current: Task, requested: Task): Task {
  if (!isClientTaskTransitionAllowed(current.status, requested.status)) {
    throw new Error(`task transition ${current.status} → ${requested.status} is server-owned`);
  }
  const editable = current.status === "backlog" || current.status === "blocked" || current.status === "done";
  return {
    ...current,
    title: editable ? requested.title : current.title,
    description: requested.description,
    assignedAgentId: editable ? requested.assignedAgentId : current.assignedAgentId,
    assignedAgentName: editable ? requested.assignedAgentName : current.assignedAgentName,
    dependsOn: editable ? requested.dependsOn : current.dependsOn,
    lane: editable ? requested.lane : current.lane,
    priority: editable ? requested.priority : current.priority,
    notBefore: editable ? requested.notBefore : current.notBefore,
    parentTaskId: editable ? requested.parentTaskId : current.parentTaskId,
    status: requested.status,
    updatedAt: new Date().toISOString(),
  };
}

export function assertCreatableTaskStatus(status: TaskStatus): void {
  if (status !== "backlog" && status !== "blocked") {
    throw new Error(`new tasks must start in backlog or blocked, not ${status}`);
  }
}
