"use client";

import clsx from "clsx";
import type { TaskStatus } from "@daimon-os/shared";

/**
 * Single source of truth for the Kanban status colour scheme. Full Tailwind
 * class strings (not interpolated) so the JIT compiler emits them. Reused by the
 * spawned-agent pane header and anywhere a task's status is shown.
 */
export const TASK_STATUS_STYLE: Record<TaskStatus, { label: string; chip: string; dot: string }> = {
  backlog: { label: "Backlog", chip: "border-faint/50 bg-faint/10 text-faint", dot: "bg-faint" },
  blocked: { label: "Blocked", chip: "border-plum/50 bg-plum/10 text-plum", dot: "bg-plum" },
  in_progress: { label: "In Progress", chip: "border-amber/50 bg-amber/10 text-amber", dot: "bg-amber" },
  waiting_review: { label: "Review", chip: "border-sky/50 bg-sky/10 text-sky", dot: "bg-sky" },
  done: { label: "Done", chip: "border-mint/50 bg-mint/10 text-mint", dot: "bg-mint" },
  failed: { label: "Failed", chip: "border-rust/60 bg-rust/10 text-rust", dot: "bg-rust" },
};

/** A compact, colour-coded Kanban status chip (dot + label). */
export function TaskStatusBadge({
  status,
  className,
  pulse,
}: {
  status: TaskStatus;
  className?: string;
  /** breathe the dot for live/in-progress states */
  pulse?: boolean;
}) {
  const s = TASK_STATUS_STYLE[status];
  return (
    <span
      title={`Task status: ${s.label}`}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded border px-1.5 py-px font-mono text-[10px] leading-none",
        s.chip,
        className,
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", s.dot, pulse && "animate-pulse")} />
      {s.label}
    </span>
  );
}
