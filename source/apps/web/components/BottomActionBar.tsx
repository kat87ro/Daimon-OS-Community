"use client";

import { useState } from "react";
import clsx from "clsx";
import { ListChecks, Play, SquareTerminal, Users } from "lucide-react";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useAppLogStore } from "@/stores/applog";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";

/**
 * Mobile-only (md:hidden) bottom action bar. Four large touch targets that
 * mirror the primary actions in the project header so they stay reachable
 * with a thumb. Hidden on the scratch tab (terminals-only, no Lead/tasks).
 */
export function BottomActionBar() {
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const setProjectView = useLayoutStore((s) => s.setProjectView);
  const openModal = useUiStore((s) => s.openModal);
  const logError = useAppLogStore((s) => s.logError);
  const [starting, setStarting] = useState(false);

  if (activeProjectId === SCRATCH_PROJECT_ID) return null;

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

  const items = [
    {
      key: "terminal",
      label: "Terminal",
      icon: SquareTerminal,
      onClick: () => openModal({ type: "spawn", projectId: activeProjectId }),
    },
    {
      key: "task",
      label: "Task",
      icon: ListChecks,
      onClick: () => openModal({ type: "task", projectId: activeProjectId }),
    },
    {
      key: "agents",
      label: "Agents",
      icon: Users,
      onClick: () => setProjectView(activeProjectId, "agents"),
    },
  ] as const;

  return (
    <nav className="safe-pb flex flex-none items-stretch border-t border-line bg-panel md:hidden">
      {items.map(({ key, label, icon: Icon, onClick }) => (
        <button
          key={key}
          onClick={onClick}
          className="flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-soft active:bg-raised"
        >
          <Icon size={18} />
          <span className="text-xs">{label}</span>
        </button>
      ))}
      <button
        onClick={startWork}
        disabled={starting}
        className="flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-amber active:bg-raised disabled:opacity-50"
      >
        <Play size={18} />
        <span className="text-xs">{starting ? "Starting…" : "Start"}</span>
      </button>
    </nav>
  );
}
