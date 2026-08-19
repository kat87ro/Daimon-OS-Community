"use client";

import { Pencil, Shield, Trash2 } from "lucide-react";
import type { AgentDefinition, Team } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Modal } from "./Modal";

function initials(name: string): string {
  const parts = name.split(/[\s\-_]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function Node({
  agent,
  lead,
  displayName,
}: {
  agent: AgentDefinition;
  lead?: boolean;
  /** per-team alias; falls back to the agent's real name */
  displayName?: string;
}) {
  const shown = displayName || agent.name;
  const aliased = shown !== agent.name;
  return (
    <div
      className={
        "flex w-40 items-center gap-2.5 rounded-lg border bg-panel px-3 py-2.5 " +
        (lead ? "border-sky/60" : "border-line")
      }
    >
      <div
        className={
          "flex h-9 w-9 flex-none items-center justify-center rounded-md text-[12px] font-medium " +
          (lead ? "bg-sky/15 text-sky" : "bg-raised text-soft")
        }
      >
        {initials(shown)}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-white">{shown}</div>
        <div className="truncate text-[10px] uppercase tracking-wide text-faint">
          {/* when aliased, the subtitle reveals the real agent so the mapping stays clear */}
          {aliased ? agent.name : lead ? "lead" : agent.description || "member"}
        </div>
      </div>
    </div>
  );
}

/** recursive reporting tree: a node + the members who take tasks from it */
function ReportTree({
  team,
  agents,
  agentId,
  isLead,
  visited,
}: {
  team: Team;
  agents: AgentDefinition[];
  agentId: string;
  isLead?: boolean;
  visited: ReadonlySet<string>;
}) {
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  // effective superior of a member = explicit manager, else the supervisor
  const superiorOf = (id: string) => team.managers?.[id] ?? team.supervisorAgentId;
  const reports = team.memberAgentIds
    .filter((id) => id !== agentId && !visited.has(id) && superiorOf(id) === agentId)
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is AgentDefinition => Boolean(a));
  const next = new Set(visited).add(agentId);

  return (
    <div className="flex flex-col items-center">
      <Node agent={agent} lead={isLead} displayName={team.memberNames?.[agent.id]} />
      {reports.length > 0 && <div className="h-4 w-px bg-line" />}
      {reports.length > 0 && (
        <div className="relative flex flex-wrap justify-center gap-4 pt-4">
          {reports.length > 1 && (
            <div className="absolute left-[12%] right-[12%] top-0 h-px bg-line" />
          )}
          {reports.map((r) => (
            <div key={r.id} className="flex flex-col items-center">
              <div className="h-4 w-px bg-line" />
              <ReportTree team={team} agents={agents} agentId={r.id} visited={next} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TeamBlock({
  team,
  depth,
  visited = new Set<string>(),
}: {
  team: Team;
  depth: number;
  visited?: ReadonlySet<string>;
}) {
  const teams = useConfigStore((s) => s.teams);
  const agents = useConfigStore((s) => s.agents);
  const pushModal = useUiStore((s) => s.pushModal);
  const deleteTeam = useConfigStore((s) => s.deleteTeam);

  const byId = (id: string) => agents.find((a) => a.id === id);
  const lead = team.supervisorAgentId ? byId(team.supervisorAgentId) : undefined;
  const memberAgents = team.memberAgentIds
    .map(byId)
    .filter((a): a is AgentDefinition => Boolean(a));
  const looseMembers = memberAgents.filter((a) => a.id !== lead?.id);
  // count members actually reachable from the lead (a broken/hand-edited
  // reporting line could orphan some) so we can surface "N not shown"
  const reachable = (() => {
    if (!lead) return memberAgents.length;
    const superiorOf = (id: string) => team.managers?.[id] ?? team.supervisorAgentId;
    const seen = new Set<string>([lead.id]);
    let added = true;
    while (added) {
      added = false;
      for (const m of memberAgents) {
        if (!seen.has(m.id) && seen.has(superiorOf(m.id) ?? "")) {
          seen.add(m.id);
          added = true;
        }
      }
    }
    return seen.size;
  })();
  const orphaned = memberAgents.length - reachable;
  // guard against a malformed (hand-edited) cyclic parentId — never recurse into
  // a team already on this path, or the render would infinite-loop
  const nextVisited = new Set(visited).add(team.id);
  const children = teams.filter((t) => t.parentId === team.id && !visited.has(t.id));

  return (
    <div
      className="rounded-xl border border-line bg-raised/30 p-4"
      style={{ marginLeft: depth * 16 }}
    >
      <div className="flex items-start">
        <div>
          <div className="text-[15px] font-medium text-white">{team.name}</div>
          {lead && (
            <div className="mt-0.5 flex items-center gap-1 text-[12px] text-faint">
              <Shield size={11} /> Lead: {team.memberNames?.[lead.id] ?? lead.name}
            </div>
          )}
        </div>
        <span className="ml-auto rounded-full bg-sky/15 px-2.5 py-0.5 text-[11px] text-sky">
          {team.memberAgentIds.length} member{team.memberAgentIds.length === 1 ? "" : "s"}
        </span>
      </div>

      {lead && orphaned > 0 && (
        <p className="mt-2 text-[11px] text-rust">
          {orphaned} member{orphaned === 1 ? "" : "s"} not shown — broken reporting line
        </p>
      )}
      {lead ? (
        <div className="mt-4 flex justify-center">
          <ReportTree team={team} agents={agents} agentId={lead.id} isLead visited={new Set()} />
        </div>
      ) : looseMembers.length > 0 ? (
        <div className="mt-4 flex flex-wrap justify-center gap-4">
          {looseMembers.map((m) => (
            <Node key={m.id} agent={m} />
          ))}
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-faint">no members yet</p>
      )}

      <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
        <button
          onClick={() => pushModal({ type: "team", id: team.id })}
          className="flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-[12px] text-soft hover:border-amber hover:text-amber"
        >
          <Pencil size={12} /> Edit
        </button>
        <button
          onClick={async () => {
            await deleteTeam(team.id);
          }}
          title="Delete team (children reparent)"
          className="ml-auto flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-[12px] text-rust hover:border-rust"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {children.length > 0 && (
        <div className="mt-3 flex flex-col gap-3">
          {children.map((c) => (
            <TeamBlock key={c.id} team={c} depth={0} visited={nextVisited} />
          ))}
        </div>
      )}
    </div>
  );
}

export function OrgChartModal({ rootTeamId }: { rootTeamId?: string } = {}) {
  const teams = useConfigStore((s) => s.teams);
  const roots = rootTeamId
    ? teams.filter((t) => t.id === rootTeamId)
    : teams.filter((t) => t.parentId === null);
  const title = rootTeamId
    ? `Org chart — ${teams.find((t) => t.id === rootTeamId)?.name ?? "team"}`
    : "Master org chart (all teams)";

  return (
    <Modal title={title} wide>
      <div className="flex flex-col gap-4">
        {roots.map((t) => (
          <TeamBlock key={t.id} team={t} depth={0} />
        ))}
        {roots.length === 0 && (
          <p className="text-[13px] text-faint">no teams yet — create one from the sidebar</p>
        )}
        <p className="text-[11px] text-faint">
          The supervisor (LEAD) dispatches workers when you Start work on a project that
          has this team attached.
        </p>
      </div>
    </Modal>
  );
}
