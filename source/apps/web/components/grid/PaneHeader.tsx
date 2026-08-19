"use client";

import { useEffect, useState, type MouseEvent } from "react";
import clsx from "clsx";
import { Maximize2, Minimize2, Play, Skull, X } from "lucide-react";
import type { RunStatus, TaskStatus } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { gateway } from "@/lib/gateway/GatewayClient";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useTaskStore } from "@/stores/tasks";
import { TaskStatusBadge } from "./TaskStatusBadge";

const DOT: Record<RunStatus, string> = {
  spawning: "bg-amber animate-pulse",
  running: "bg-amber",
  waiting_tool: "bg-sky",
  paused: "bg-plum",
  completed: "bg-mint",
  failed: "bg-rust",
  killed: "bg-faint",
};

const LIVE: ReadonlySet<RunStatus> = new Set(["spawning", "running", "waiting_tool", "paused"]);

// terminal Kanban states settle the pane even if its PTY lingers open
const TASK_TERMINAL: ReadonlySet<TaskStatus> = new Set(["done", "failed"]);

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function PaneHeader({ channel, embedded = false }: { channel: string; embedded?: boolean }) {
  const session = useSessionStore((s) => s.sessions[channel]);
  // the task this pane is running, if any — linked by its worker channel
  const task = useTaskStore((s) => {
    for (const t of Object.values(s.tasks)) if (t.channel === channel) return t;
    return undefined;
  });
  const maximized = useLayoutStore((s) => s.maximizedChannel === channel);
  const toggleMaximized = useLayoutStore((s) => s.toggleMaximized);
  const [now, setNow] = useState(() => Date.now());

  const procLive = session ? LIVE.has(session.status) : false;
  // "settled" = the PTY ended OR the linked task reached a terminal Kanban state.
  // Either way the work is finished, so we stop the clock and drop the "…".
  const settled = !procLive || (task ? TASK_TERMINAL.has(task.status) : false);
  useEffect(() => {
    if (settled) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [settled]);

  if (!session) return <div className="h-7 border-b border-line" />;

  // freeze at endedAt when the PTY exited; otherwise the clock stops the moment
  // we settle (the interval above is cleared, so `now` no longer advances)
  const elapsed = session.endedAt
    ? Date.parse(session.endedAt) - Date.parse(session.startedAt)
    : now - Date.parse(session.startedAt);

  return (
    <div className="pane-drag-handle flex h-7 flex-none cursor-grab items-center gap-2 border-b border-line bg-raised px-2 text-xs">
      <span className={clsx("h-2 w-2 flex-none rounded-full", DOT[session.status])} />
      <span className="truncate font-sans font-medium text-text">{session.agentName}</span>
      <span className={clsx("truncate font-sans", settled ? "text-mint" : "text-amber")}>
        {settled ? session.statusLabel : `${session.statusLabel}…`}
      </span>
      {task && (
        <TaskStatusBadge status={task.status} pulse={task.status === "in_progress" && !settled} className="flex-none" />
      )}
      {session.activeTools.map((tool) => (
        <span
          key={tool}
          className="flex-none rounded bg-sky/15 px-1 py-px font-mono text-[10px] leading-none text-sky"
        >
          {tool}
        </span>
      ))}
      <span className="ml-auto flex-none font-mono text-soft">
        {fmtElapsed(elapsed)} · ↑{fmtTokens(session.metrics.inputTokens)} ↓
        {fmtTokens(session.metrics.outputTokens)}
        {session.metrics.costUsd > 0 && ` · $${session.metrics.costUsd.toFixed(2)}`}
      </span>
      {session.status === "paused" && (
        <button
          title="Resume (budget-paused)"
          onMouseDown={stopDrag}
          onClick={() => void api.sessions.resume(channel)}
          className="-my-1 flex-none rounded p-1 text-mint hover:bg-mint/10 hover:text-mint/80"
        >
          <Play size={13} />
        </button>
      )}
      {procLive && (
        <button
          title="Kill (Atropos)"
          onMouseDown={stopDrag}
          onClick={() => gateway.kill(channel)}
          className="-my-1 flex-none rounded p-1 text-soft hover:bg-rust/10 hover:text-rust"
        >
          <Skull size={13} />
        </button>
      )}
      {!embedded && (
        <button
          title={maximized ? "Restore" : "Maximize"}
          onMouseDown={stopDrag}
          onClick={() => toggleMaximized(channel)}
          className="-my-1 flex-none rounded p-1 text-soft hover:bg-line/40 hover:text-text"
        >
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      )}
      <button
        title="Close pane"
        onMouseDown={stopDrag}
        onClick={() => gateway.close(channel)}
        className="-my-1 flex-none rounded p-1 text-soft hover:bg-rust/10 hover:text-rust"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// the header is react-grid-layout's drag handle, which captures mousedown and
// eats button clicks — stop it so the control buttons actually fire
function stopDrag(e: MouseEvent) {
  e.stopPropagation();
}
