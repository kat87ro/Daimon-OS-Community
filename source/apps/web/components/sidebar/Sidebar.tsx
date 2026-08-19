"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  BookOpen,
  Bot,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderKanban,
  GitCommitHorizontal,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  ShieldCheck,
  Network,
  Plus,
  Settings,
  SlidersHorizontal,
  SquareTerminal,
  Target,
  Trash2,
} from "lucide-react";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import type { Project, Team } from "@daimon-os/shared";
import { channelRegistry } from "@/lib/gateway/ChannelRegistry";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useUiStore, type ModalSpec } from "@/stores/ui";
import { useAttentionStore } from "@/stores/attention";

function SectionHeader({
  id,
  label,
  icon: Icon,
  count,
  addModal,
}: {
  id: string;
  label: string;
  icon: typeof Bot;
  count?: number;
  addModal?: ModalSpec;
}) {
  const expanded = useLayoutStore((s) => s.expanded[id] ?? false);
  const toggleExpanded = useLayoutStore((s) => s.toggleExpanded);
  const openModal = useUiStore((s) => s.openModal);
  return (
    <div className="group flex min-h-[40px] items-center gap-1.5 rounded px-2 py-1.5 text-[13px] text-text hover:bg-raised/60 md:min-h-0">
      <button onClick={() => toggleExpanded(id)} className="flex flex-1 items-center gap-1.5">
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Icon size={14} className="text-faint" />
        <span className="font-semibold">{label}</span>
        {count !== undefined && (
          <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium text-soft">
            {count}
          </span>
        )}
      </button>
      {addModal && (
        <button
          onClick={() => openModal(addModal)}
          className="text-faint hover:text-amber md:invisible md:group-hover:visible"
          title={`New ${label.toLowerCase().replace(/s$/, "")}`}
          aria-label={`New ${label.toLowerCase().replace(/s$/, "")}`}
        >
          <Plus size={12} />
        </button>
      )}
    </div>
  );
}

function Leaf({
  label,
  depth,
  onClick,
  active,
  prefix,
  count,
}: {
  label: string;
  depth: number;
  onClick: () => void;
  active?: boolean;
  prefix?: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      style={{ paddingLeft: 22 + depth * 12 - 2 }}
      className={clsx(
        "flex min-h-[40px] w-full items-center gap-1.5 truncate rounded border-l-2 py-1.5 pr-2 text-left text-[12px] md:min-h-0",
        active
          ? "border-amber bg-raised text-text"
          : "border-transparent text-soft hover:bg-raised/60",
      )}
    >
      {prefix}
      <span className="truncate">{label}</span>
      {count !== undefined && (
        <span
          className={clsx(
            "ml-auto flex-none rounded px-1.5 py-0.5 text-[10px] font-medium text-soft",
            active ? "bg-ink/50" : "bg-raised",
          )}
        >
          {count}
        </span>
      )}
    </button>
  );
}

const STATUS_DOT: Record<string, string> = {
  spawning: "text-amber",
  running: "text-amber",
  waiting_tool: "text-sky",
  paused: "text-plum",
  completed: "text-mint",
  failed: "text-rust",
  killed: "text-faint",
};

function TeamNode({ team, depth }: { team: Team; depth: number }) {
  const teams = useConfigStore((s) => s.teams);
  const openModal = useUiStore((s) => s.openModal);
  const children = teams.filter((t) => t.parentId === team.id);
  return (
    <>
      <div
        className="group flex items-center rounded pr-1 hover:bg-raised/60"
        style={{ paddingLeft: 0 }}
      >
        <Leaf
          label={team.name}
          depth={depth}
          onClick={() => openModal({ type: "team", id: team.id })}
          prefix={<Network size={11} className="flex-none text-sky" />}
        />
        <button
          onClick={() => openModal({ type: "org-team", teamId: team.id })}
          title="Org chart for this team"
          aria-label="Org chart for this team"
          className="flex-none p-1 text-faint hover:text-amber"
        >
          <GitBranch size={11} />
        </button>
      </div>
      {children.map((c) => (
        <TeamNode key={c.id} team={c} depth={depth + 1} />
      ))}
    </>
  );
}

export function Sidebar() {
  const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const expanded = useLayoutStore((s) => s.expanded);
  const toggleExpanded = useLayoutStore((s) => s.toggleExpanded);
  const setActiveProject = useLayoutStore((s) => s.setActiveProject);
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const globalView = useLayoutStore((s) => s.globalView);
  const setGlobalView = useLayoutStore((s) => s.setGlobalView);
  const setFocused = useLayoutStore((s) => s.setFocused);
  const focusedChannel = useLayoutStore((s) => s.focusedChannel);
  const projects = useConfigStore((s) => s.projects);
  const teams = useConfigStore((s) => s.teams);
  const agents = useConfigStore((s) => s.agents);
  // Providers/Skills/MCP/Secrets/Blueprints now live in the Configuration hub.
  const schedules = useConfigStore((s) => s.schedules);
  const goals = useConfigStore((s) => s.goals);
  const deleteProject = useConfigStore((s) => s.deleteProject);
  const deleteGoal = useConfigStore((s) => s.deleteGoal);
  const sessions = useSessionStore((s) => s.sessions);
  const openModal = useUiStore((s) => s.openModal);
  const attentionCount = useAttentionStore((s) => s.records.length);
  const [projectMenu, setProjectMenu] = useState<{
    projectId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!projectMenu) return;
    const close = () => setProjectMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [projectMenu]);

  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  if (collapsed) {
    // the thin rail is desktop-only; on phones a collapsed sidebar is fully
    // hidden so the content gets the whole screen (toggle via the TopBar)
    return (
      <aside className="hidden w-11 flex-none flex-col items-center gap-2 border-r border-line bg-panel py-2 md:flex">
        <button title="Spawn terminal" aria-label="Spawn terminal" onClick={() => openModal({ type: "spawn" })} className="rounded bg-amber p-1.5 text-ink">
          <Plus size={14} />
        </button>
        <SquareTerminal size={15} className="text-faint" />
      </aside>
    );
  }

  const sessionsOf = (projectId: string) =>
    Object.values(sessions).filter((s) => (s.projectId ?? SCRATCH_PROJECT_ID) === projectId);

  const renderProject = (project: Project, depth = 0) => {
    const procs = sessionsOf(project.id);
    const children = projects.filter((candidate) => candidate.parentProjectId === project.id);
    const projectGoals = goals.filter((goal) => goal.projectId === project.id);
    const featuresOpen = expanded[`features:${project.id}`] ?? true;
    const goalsOpen = expanded[`goals:${project.id}`] ?? false;
    return (
      <div key={project.id}>
        <div
          className={clsx(
            "flex items-center rounded pr-1",
            activeProjectId === project.id ? "" : "hover:bg-raised/60",
          )}
          onContextMenu={(event) => {
            event.preventDefault();
            setProjectMenu({ projectId: project.id, x: event.clientX, y: event.clientY });
          }}
        >
          <Leaf
            label={project.name}
            count={procs.length}
            depth={depth}
            active={activeProjectId === project.id}
            onClick={() => setActiveProject(project.id)}
            prefix={
              project.parentProjectId ? (
                <GitBranch size={11} className="flex-none text-sky" />
              ) : (
                <FolderKanban size={11} className="flex-none text-amber" />
              )
            }
          />
          <button
            onClick={() => openModal({ type: "project", id: project.id })}
            title={`Edit ${project.parentProjectId ? "feature" : "project"}`}
            aria-label={`Edit ${project.parentProjectId ? "feature" : "project"}`}
            className="flex-none p-1 text-faint hover:text-amber"
          >
            <Settings size={11} />
          </button>
        </div>

        {!project.parentProjectId && (
          <>
            <button
              onClick={() => toggleExpanded(`features:${project.id}`)}
              className="flex w-full items-center gap-1 rounded py-0.5 text-left text-[11px] text-faint hover:text-soft"
              style={{ paddingLeft: 24 + depth * 12 }}
            >
              {featuresOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              <GitBranch size={10} className="flex-none" />
              Features ({children.length})
            </button>
            {featuresOpen && (
              <>
                {children.map((child) => renderProject(child, depth + 1))}
                <button
                  onClick={() =>
                    openModal({ type: "project", parentProjectId: project.id })
                  }
                  className="flex w-full items-center gap-1 py-0.5 text-left text-[11px] text-faint hover:text-amber"
                  style={{ paddingLeft: 40 + depth * 12 }}
                >
                  <Plus size={10} /> feature project
                </button>
              </>
            )}
          </>
        )}

        <button
          onClick={() => toggleExpanded(`goals:${project.id}`)}
          className="flex w-full items-center gap-1 rounded py-0.5 text-left text-[11px] text-faint hover:text-soft"
          style={{ paddingLeft: 24 + depth * 12 }}
        >
          {goalsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <Target size={10} className="flex-none" />
          Goals ({projectGoals.length})
        </button>
        {goalsOpen && (
          <>
            {projectGoals.map((goal) => (
              <div key={goal.id} className="group flex items-center rounded pr-1 hover:bg-raised/60">
                <Leaf
                  label={goal.title}
                  depth={depth + 2}
                  onClick={() =>
                    openModal({ type: "goal", projectId: project.id, id: goal.id })
                  }
                  prefix={
                    <Circle
                      size={6}
                      fill="currentColor"
                      className={clsx(
                        "flex-none",
                        goal.status === "done"
                          ? "text-mint"
                          : goal.status === "active"
                            ? "text-amber"
                            : "text-faint",
                      )}
                    />
                  }
                />
                <button
                  onClick={() => {
                    if (window.confirm(`Delete goal "${goal.title}"? This cannot be undone.`)) {
                      void deleteGoal(goal.id).catch(() => {});
                    }
                  }}
                  title="Delete goal"
                  aria-label="Delete goal"
                  className="flex-none p-1 text-faint hover:text-rust"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            <button
              onClick={() => openModal({ type: "goal", projectId: project.id })}
              className="flex w-full items-center gap-1 py-0.5 text-left text-[11px] text-faint hover:text-amber"
              style={{ paddingLeft: 40 + depth * 12 }}
            >
              <Plus size={10} /> goal
            </button>
          </>
        )}

        {activeProjectId === project.id &&
          procs.map((session) => (
            <Leaf
              key={session.id as string}
              label={session.agentName}
              depth={depth + 1}
              active={focusedChannel === (session.id as string)}
              onClick={() => {
                setActiveProject(project.id);
                setFocused(session.id as string);
                channelRegistry.focus(session.id as string);
              }}
              prefix={
                <Circle
                  size={7}
                  fill="currentColor"
                  className={clsx("flex-none", STATUS_DOT[session.status])}
                />
              }
            />
          ))}
      </div>
    );
  };

  return (
    <>
      {/* tap-to-dismiss backdrop, mobile only (sidebar is an overlay there) */}
      <div
        className="fixed inset-0 z-30 bg-black/50 md:hidden"
        onClick={toggleSidebar}
      />
    <aside className="fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-none flex-col border-r border-line bg-panel pt-[env(safe-area-inset-top)] md:static md:z-auto md:max-w-none md:pt-0">
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <div className="mb-2 grid gap-1 border-b border-line pb-2">
          <button
            onClick={() => setGlobalView("dashboard")}
            className={clsx(
              "flex min-h-[40px] items-center gap-2 rounded px-2 text-left text-[13px] font-semibold md:min-h-0 md:py-2",
              globalView === "dashboard" ? "bg-raised text-text" : "text-soft hover:bg-raised/60 hover:text-text",
            )}
          >
            <LayoutDashboard size={14} className="text-amber" /> Dashboard
          </button>
          <button
            onClick={() => setGlobalView("master-chat")}
            className={clsx(
              "flex min-h-[40px] items-center gap-2 rounded px-2 text-left text-[13px] font-semibold md:min-h-0 md:py-2",
              globalView === "master-chat" ? "bg-raised text-text" : "text-soft hover:bg-raised/60 hover:text-text",
            )}
          >
            <MessageSquare size={14} className="text-sky" />
            <span>Master Chat</span>
            {attentionCount > 0 && (
              <span className="ml-auto rounded-full bg-sky px-1.5 text-[10px] text-white">{attentionCount > 99 ? "99+" : attentionCount}</span>
            )}
          </button>
          <button
            onClick={() => setGlobalView("audit")}
            className={clsx(
              "flex min-h-[40px] items-center gap-2 rounded px-2 text-left text-[13px] font-semibold md:min-h-0 md:py-2",
              globalView === "audit" ? "bg-raised text-text" : "text-soft hover:bg-raised/60 hover:text-text",
            )}
          >
            <ShieldCheck size={14} className="text-mint" /> Audit log
          </button>
        </div>
        <SectionHeader
          id="projects"
          label="Projects"
          icon={FolderKanban}
          count={projects.length}
          addModal={{ type: "project" }}
        />
        {expanded.projects && (
          <>
            <Leaf
              label="scratch"
              count={sessionsOf(SCRATCH_PROJECT_ID).length}
              depth={0}
              active={activeProjectId === SCRATCH_PROJECT_ID}
              onClick={() => setActiveProject(SCRATCH_PROJECT_ID)}
              prefix={<SquareTerminal size={11} className="flex-none text-faint" />}
            />
            {projects.filter((project) => !project.parentProjectId).map((project) => renderProject(project))}
          </>
        )}

        <SectionHeader id="teams" label="Teams" icon={Network} count={teams.length} addModal={{ type: "team" }} />
        {expanded.teams && (
          <>
            <Leaf
              label="Org hierarchy view"
              depth={0}
              onClick={() => openModal({ type: "org" })}
              prefix={<Network size={11} className="flex-none text-amber" />}
            />
            {teams.filter((t) => t.parentId === null).map((t) => (
              <TeamNode key={t.id} team={t} depth={0} />
            ))}
          </>
        )}

        <SectionHeader id="agents" label="Agents" icon={Bot} count={agents.length} addModal={{ type: "agent" }} />
        {expanded.agents &&
          agents.map((a) => (
            <Leaf
              key={a.id}
              label={a.description ? `${a.name} — ${a.description}` : a.name}
              depth={0}
              onClick={() => openModal({ type: "agent", id: a.id })}
              prefix={<Bot size={11} className="flex-none text-plum" />}
            />
          ))}

        {/* Providers · API Tokens · Skills · MCP servers · Blueprints live in the
            Configuration hub (gear / Configuration entry) — not duplicated here. */}

        <SectionHeader id="schedules" label="Schedules" icon={CalendarClock} count={schedules.length} addModal={{ type: "schedule" }} />
        {expanded.schedules &&
          schedules.map((s) => (
            <Leaf
              key={s.id}
              label={`${s.name}${s.enabled ? "" : " · off"}`}
              depth={0}
              onClick={() => openModal({ type: "schedule", id: s.id })}
              prefix={<CalendarClock size={11} className="flex-none text-sky" />}
            />
          ))}
        {expanded.schedules && schedules.length === 0 && (
          <p className="px-5 py-1 text-[10px] text-faint">
            cron / interval / watch triggers that fire a blueprint
          </p>
        )}
        {/* Goals and independently orchestrated feature projects are nested under
            their owning root project above. */}
      </div>

      <div className="flex flex-none flex-col gap-2 border-t border-line p-2">
        <button
          onClick={() => openModal({ type: "docs" })}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-line bg-raised px-3 py-2 text-xs font-medium text-soft hover:border-amber hover:text-text"
        >
          <BookOpen size={14} /> Documentation
        </button>
        <button
          onClick={() => openModal({ type: "configuration" })}
          className="flex w-full items-center justify-center gap-1.5 rounded border border-line bg-raised px-3 py-2 text-xs font-medium text-soft hover:border-amber hover:text-text"
        >
          <SlidersHorizontal size={14} /> Configuration
        </button>
        <button
          onClick={() => openModal({ type: "spawn" })}
          className="flex w-full items-center justify-center gap-1.5 rounded bg-amber px-3 py-2 text-xs font-medium text-ink hover:bg-amber/90"
        >
          <Plus size={14} /> Spawn terminal
        </button>
      </div>
    </aside>
      {projectMenu && (() => {
        const project = projects.find((candidate) => candidate.id === projectMenu.projectId);
        if (!project) return null;
        const actions = [
          ...(!project.parentProjectId
            ? [{ label: "Add feature project", run: () => openModal({ type: "project", parentProjectId: project.id }) }]
            : []),
          { label: "Add goal", run: () => openModal({ type: "goal", projectId: project.id }) },
          { label: "Git integration", run: () => openModal({ type: "git", projectId: project.id }) },
          { label: `Edit ${project.parentProjectId ? "feature" : "project"}`, run: () => openModal({ type: "project", id: project.id }) },
          {
            label: `Delete ${project.parentProjectId ? "feature" : "project"}`,
            run: () => {
              const detail = project.parentProjectId
                ? "Its goals, tasks and schedules will also be removed."
                : "Its feature projects, goals, tasks and schedules will also be removed.";
              if (window.confirm(`Delete "${project.name}"? ${detail}`)) {
                void deleteProject(project.id).catch(() => {});
              }
            },
            danger: true,
          },
        ];
        return (
          <div
            className="fixed z-[70] min-w-44 rounded border border-line bg-panel py-1 text-xs shadow-xl"
            style={{ left: projectMenu.x, top: projectMenu.y }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-line px-3 py-1.5 font-medium text-text">
              {project.name}
            </div>
            {actions.map((action) => (
              <button
                key={action.label}
                onClick={() => {
                  action.run();
                  setProjectMenu(null);
                }}
                className={clsx(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-raised",
                  action.danger ? "text-rust" : "text-soft",
                )}
              >
                {action.label === "Git integration" && <GitCommitHorizontal size={12} />}
                {action.label}
              </button>
            ))}
          </div>
        );
      })()}
    </>
  );
}
