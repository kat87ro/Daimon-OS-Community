"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  KanbanSquare,
  ListChecks,
  MoreHorizontal,
  Play,
  Plus,
  SquareTerminal,
  Users,
} from "lucide-react";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { channelRegistry } from "@/lib/gateway/ChannelRegistry";
import { useAppLogStore } from "@/stores/applog";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { KanbanBoard } from "./KanbanBoard";
import { TerminalGrid } from "./TerminalGrid";
import { WorkLog } from "./WorkLog";

const PAGES = [
  { id: "agents", label: "Agents", icon: SquareTerminal },
  { id: "kanban", label: "Kanban", icon: KanbanSquare },
  { id: "worklog", label: "Work Log", icon: ListChecks },
] as const;

export function ProjectView() {
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  // scratch is terminals-only; real projects get the 3-page nav
  const view = useLayoutStore((s) => s.projectView[s.activeProjectId] ?? "agents");
  const setProjectView = useLayoutStore((s) => s.setProjectView);
  const logError = useAppLogStore((s) => s.logError);
  const openModal = useUiStore((s) => s.openModal);
  const [starting, setStarting] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!overflow) return;
    const close = (e: MouseEvent) => {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflow(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [overflow]);

  // returning to the (kept-mounted) Agents grid doesn't change its size, so the
  // panes' ResizeObserver never fires — force a repaint or xterm shows a black
  // canvas until the user manually resizes. rAF lets the overlay unmount first.
  useEffect(() => {
    if (view !== "agents") return;
    const id = requestAnimationFrame(() => channelRegistry.refreshAll());
    return () => cancelAnimationFrame(id);
  }, [view]);

  if (activeProjectId === SCRATCH_PROJECT_ID) return <TerminalGrid />;

  const startWork = async () => {
    setStarting(true);
    try {
      await api.projects.start(activeProjectId);
      setProjectView(activeProjectId, "agents");
    } catch (e) {
      logError(e instanceof Error ? e.message : "could not start the Lead", undefined, "lead");
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line bg-panel px-2">
        {/* segmented control: current sub-view is unmistakable */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-md border border-line bg-ink p-0.5 sm:flex-none">
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setProjectView(activeProjectId, id)}
              aria-pressed={view === id}
              className={clsx(
                "flex flex-none items-center gap-1.5 rounded px-3 py-1.5 text-[13px]",
                view === id
                  ? "bg-raised font-medium text-text"
                  : "text-soft hover:text-text",
              )}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* primary actions, near the project context */}
        <div className="ml-auto flex flex-none items-center gap-1.5">
          <button
            onClick={() => openModal({ type: "task", projectId: activeProjectId })}
            title="Add a task to this project"
            className="hidden items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[13px] text-soft hover:text-text md:flex"
          >
            <Plus size={13} />
            Add task
          </button>
          <button
            onClick={() => openModal({ type: "spawn", projectId: activeProjectId })}
            title="Spawn agent terminals for this project"
            className="hidden items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-[13px] text-soft hover:text-text md:flex"
          >
            <Users size={13} />
            Spawn agents
          </button>
          <button
            onClick={startWork}
            disabled={starting}
            title="Bring the team Lead online to decompose the goal into tasks"
            className="hidden items-center gap-1.5 rounded bg-amber px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-amber/90 disabled:opacity-50 md:flex"
          >
            <Play size={13} />
            {starting ? "Starting…" : "Start work"}
          </button>

          {/* overflow: advanced/secondary actions (kept off the hot path) */}
          <div className="relative" ref={overflowRef}>
            <button
              onClick={() => setOverflow((o) => !o)}
              title="More actions"
              className={clsx(
                "flex min-h-[36px] items-center rounded border border-line px-2 text-soft hover:text-text",
                overflow && "text-text",
              )}
            >
              <MoreHorizontal size={16} />
            </button>
            {overflow && (
              <div className="absolute right-0 top-full z-50 mt-1 min-w-44 rounded border border-line bg-panel py-1 text-[13px] shadow-xl">
                {/* phones reach Start/Task/Spawn from the bottom bar, but keep
                    them here too so the overflow is self-sufficient */}
                <button
                  onClick={() => {
                    openModal({ type: "task", projectId: activeProjectId });
                    setOverflow(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-raised hover:text-text md:hidden"
                >
                  <Plus size={13} /> Add task
                </button>
                <button
                  onClick={() => {
                    openModal({ type: "spawn", projectId: activeProjectId });
                    setOverflow(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-raised hover:text-text md:hidden"
                >
                  <Users size={13} /> Spawn agents
                </button>
                <button
                  onClick={() => {
                    openModal({ type: "goal", projectId: activeProjectId });
                    setOverflow(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-raised hover:text-text"
                >
                  <Plus size={13} /> Add goal
                </button>
                <button
                  onClick={() => {
                    openModal({ type: "project", id: activeProjectId });
                    setOverflow(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-soft hover:bg-raised hover:text-text"
                >
                  Project settings
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {/* TerminalGrid stays MOUNTED across page switches so xterm instances
            (and their scrollback) survive — Kanban/Work Log overlay on top */}
        <TerminalGrid />
        {view !== "agents" && (
          <div className="absolute inset-0 flex flex-col bg-ink">
            {view === "kanban" && <KanbanBoard projectId={activeProjectId} />}
            {view === "worklog" && <WorkLog projectId={activeProjectId} />}
          </div>
        )}
      </div>
    </div>
  );
}
