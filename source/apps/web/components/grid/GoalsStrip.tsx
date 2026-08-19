"use client";

import clsx from "clsx";
import { Target } from "lucide-react";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import type { Goal } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";

const STATUS_STYLE: Record<Goal["status"], string> = {
  open: "border-line text-soft",
  active: "border-amber/50 text-amber",
  done: "border-mint/40 text-mint line-through",
};

export function GoalsStrip() {
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const goals = useConfigStore((s) => s.goals);
  const openModal = useUiStore((s) => s.openModal);

  if (activeProjectId === SCRATCH_PROJECT_ID) return null;
  const projectGoals = goals.filter((g) => g.projectId === activeProjectId);

  return (
    <div className="flex h-8 flex-none items-center gap-1.5 overflow-x-auto border-b border-line bg-panel px-3">
      <Target size={12} className="flex-none text-faint" />
      {projectGoals.map((g) => (
        <button
          key={g.id}
          title="Open goal — edit details & attachments"
          onClick={() => openModal({ type: "goal", projectId: activeProjectId, id: g.id })}
          className={clsx(
            "flex-none rounded-full border px-2.5 py-0.5 text-[11px]",
            STATUS_STYLE[g.status],
          )}
        >
          {g.title}
          {(g.attachments?.length ?? 0) > 0 && (
            <span className="ml-1 rounded-full bg-line/60 px-1 text-[9px] text-soft">
              📎{g.attachments!.length}
            </span>
          )}
        </button>
      ))}
      <button
        onClick={() => openModal({ type: "goal", projectId: activeProjectId })}
        className="flex-none rounded-full border border-dashed border-line px-2 py-0.5 text-[11px] text-faint hover:border-amber hover:text-amber"
      >
        + goal
      </button>
    </div>
  );
}
