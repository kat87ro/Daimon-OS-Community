"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { GitBranch, Target, X } from "lucide-react";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";

export function ProjectTabs() {
  const projects = useConfigStore((s) => s.projects);
  const openTabs = useLayoutStore((s) => s.openTabs);
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const setActiveProject = useLayoutStore((s) => s.setActiveProject);
  const closeTab = useLayoutStore((s) => s.closeTab);
  const closeOtherTabs = useLayoutStore((s) => s.closeOtherTabs);
  const closeAllTabs = useLayoutStore((s) => s.closeAllTabs);
  const sessions = useSessionStore((s) => s.sessions);
  const openModal = useUiStore((s) => s.openModal);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const countOf = (projectId: string) =>
    Object.values(sessions).filter(
      (s) => (s.projectId ?? SCRATCH_PROJECT_ID) === projectId,
    ).length;

  const nameOf = (id: string) => {
    if (id === SCRATCH_PROJECT_ID) return "scratch";
    const project = projects.find((candidate) => candidate.id === id);
    if (!project) return "…";
    if (!project.parentProjectId) return project.name;
    const parent = projects.find((candidate) => candidate.id === project.parentProjectId);
    return `${parent?.name ?? "…"} / ${project.name}`;
  };

  return (
    <div className="flex h-10 flex-none items-stretch gap-1 overflow-x-auto border-b border-line bg-panel px-2">
      {openTabs.map((id) => {
        const count = countOf(id);
        const active = activeProjectId === id;
        return (
          <div
            key={id}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ id, x: e.clientX, y: e.clientY });
            }}
            className={clsx(
              "flex flex-none items-center rounded-t border-b-2",
              active
                ? "border-amber bg-raised text-text"
                : "border-transparent text-soft hover:text-text",
            )}
          >
            <button
              onClick={() => setActiveProject(id)}
              className={clsx(
                "flex items-center gap-1.5 px-3 py-1.5 text-[14px]",
                active && "font-medium",
              )}
            >
              {nameOf(id)}
              {count > 0 && (
                <span
                  className={clsx(
                    "rounded-full px-1.5 text-[11px] leading-4",
                    active ? "bg-amber/20 text-amber" : "bg-raised text-soft",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
            {id !== SCRATCH_PROJECT_ID && (
              <button
                onClick={() => closeTab(id)}
                title="Close tab (terminals keep running)"
                className="mr-1 rounded p-0.5 text-soft hover:text-rust"
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      <span className="ml-2 hidden flex-none self-center text-[11px] text-faint md:inline">
        open projects from the sidebar
      </span>

      {menu && (
        <div
          className="fixed z-50 min-w-40 rounded border border-line bg-panel py-1 text-xs shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {menu.id !== SCRATCH_PROJECT_ID && (() => {
            const project = projects.find((candidate) => candidate.id === menu.id);
            if (!project) return null;
            return (
              <>
                {!project.parentProjectId && (
                  <button
                    onClick={() => {
                      openModal({ type: "project", parentProjectId: project.id });
                      setMenu(null);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left text-soft hover:bg-raised"
                  >
                    <GitBranch size={11} /> Add feature project
                  </button>
                )}
                <button
                  onClick={() => {
                    openModal({ type: "goal", projectId: project.id });
                    setMenu(null);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1 text-left text-soft hover:bg-raised"
                >
                  <Target size={11} /> Add goal
                </button>
                <button
                  onClick={() => {
                    openModal({ type: "git", projectId: project.id });
                    setMenu(null);
                  }}
                  className="flex w-full items-center gap-2 border-b border-line px-3 py-1 text-left text-soft hover:bg-raised"
                >
                  <GitBranch size={11} /> Git integration
                </button>
              </>
            );
          })()}
          {(
            [
              { label: "Close tab", fn: () => closeTab(menu.id), off: menu.id === SCRATCH_PROJECT_ID },
              { label: "Close others", fn: () => closeOtherTabs(menu.id), off: false },
              { label: "Close all", fn: () => closeAllTabs(), off: false },
            ] as const
          ).map(({ label, fn, off }) => (
            <button
              key={label}
              disabled={off}
              onClick={() => {
                fn();
                setMenu(null);
              }}
              className="block w-full px-3 py-1 text-left text-soft hover:bg-raised disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
