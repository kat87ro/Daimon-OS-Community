import type { AgentId, Blueprint, Goal, Task } from "@daimon-os/shared";
import type { ConfigStore } from "../config/ConfigStore";
import type { AppLog } from "../gateway/AppLog";

/** Substitute `{goal}` and `{key}` placeholders from `vars` into a template.
 *  Unknown placeholders are left untouched so a typo is visible, not silently
 *  blanked. `{goal}` is just a conventional var key — pass it in `vars`. */
function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match,
  );
}

/**
 * Materialize a blueprint's task DAG onto a project. For each blueprint task we
 * mint a real task id, map ref→id, template the title/description, resolve
 * dependsOn refs to real ids, set "blocked" when it has deps else "backlog",
 * and resolve assignedAgentName → agent id (case-insensitive; an unmatched name
 * is left unassigned with a warning). Each task is persisted via upsertTask in
 * dependency-safe order (deps exist before dependents, since refs only point at
 * tasks already declared earlier or later — we insert in two passes by topo of
 * the ref graph). If the blueprint carries a goalTemplate, an active Goal is
 * created too. Returns the created tasks.
 */
export function instantiateBlueprint(
  store: ConfigStore,
  blueprint: Blueprint,
  projectId: string,
  vars: Record<string, string> = {},
  appLog?: AppLog,
): Task[] {
  const now = new Date().toISOString();

  // ref → real task id, assigned up front so dependsOn can be resolved regardless
  // of declaration order within the blueprint
  const refToId = new Map<string, string>();
  for (const bt of blueprint.tasks) refToId.set(bt.ref, crypto.randomUUID());

  // resolve agent names once (case-insensitive)
  const agents = store.listAgents();
  const agentByName = new Map<string, AgentId>();
  for (const a of agents) agentByName.set(a.name.trim().toLowerCase(), a.id);

  // upsertTask enforces that every dependency already exists in the same project,
  // so we must persist in topological order (a task before anything that depends
  // on it). Kahn over the ref graph; the blueprint DAG is assumed acyclic.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const bt of blueprint.tasks) {
    indegree.set(bt.ref, 0);
    dependents.set(bt.ref, []);
  }
  for (const bt of blueprint.tasks) {
    for (const dep of bt.dependsOn) {
      if (!indegree.has(dep)) continue; // dangling ref — ignored (logged below)
      indegree.set(bt.ref, (indegree.get(bt.ref) ?? 0) + 1);
      dependents.get(dep)!.push(bt.ref);
    }
  }
  const byRef = new Map(blueprint.tasks.map((t) => [t.ref, t] as const));
  const queue = [...indegree.entries()].filter(([, d]) => d === 0).map(([r]) => r);
  const order: string[] = [];
  while (queue.length) {
    const ref = queue.shift()!;
    order.push(ref);
    for (const next of dependents.get(ref) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  // a true cycle leaves some refs unreached by Kahn — reject the WHOLE blueprint
  // UP FRONT, before persisting anything, so we never leave a half-instantiated
  // DAG behind (validate-then-commit / reversible-by-construction).
  if (order.length !== blueprint.tasks.length) {
    throw new Error(`blueprint "${blueprint.name}" has a dependency cycle — no tasks created`);
  }

  // build every task in memory first; only then commit. Because the graph is
  // acyclic and we persist in topo order, each task's deps already exist when
  // upsertTask runs, so the commit loop cannot throw mid-way.
  const toCommit: Task[] = [];
  for (const ref of order) {
    const bt = byRef.get(ref)!;
    const id = refToId.get(ref)!;
    const deps = bt.dependsOn
      .map((d) => refToId.get(d))
      .filter((x): x is string => Boolean(x));

    let assignedAgentId: AgentId | undefined;
    let assignedAgentName: string | undefined;
    if (bt.assignedAgentName) {
      const match = agentByName.get(bt.assignedAgentName.trim().toLowerCase());
      if (match) {
        assignedAgentId = match;
        assignedAgentName = bt.assignedAgentName;
      } else {
        appLog?.emit(
          "warn",
          "blueprint",
          `task "${bt.titleTemplate}" references unknown agent "${bt.assignedAgentName}" — left unassigned`,
        );
      }
    }

    const task: Task = {
      id,
      projectId: projectId as Task["projectId"],
      title: fill(bt.titleTemplate, vars),
      description: bt.descriptionTemplate ? fill(bt.descriptionTemplate, vars) : undefined,
      assignedAgentId,
      assignedAgentName,
      status: deps.length ? "blocked" : "backlog",
      dependsOn: deps,
      createdBy: "lead",
      createdAt: now,
      updatedAt: now,
    };
    toCommit.push(task);
  }

  const created: Task[] = toCommit.map((t) => store.upsertTask(t));

  if (blueprint.goalTemplate) {
    const goal: Goal = {
      id: crypto.randomUUID(),
      projectId: projectId as Goal["projectId"],
      title: fill(blueprint.name, vars),
      status: "active",
      description: fill(blueprint.goalTemplate, vars),
      createdAt: now,
    };
    store.upsertGoal(goal);
  }

  appLog?.emit(
    "info",
    "blueprint",
    `instantiated "${blueprint.name}" → ${created.length} task(s) onto project ${projectId}`,
  );
  return created;
}
