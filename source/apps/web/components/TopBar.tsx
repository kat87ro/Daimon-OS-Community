"use client";

import { useEffect } from "react";
import { ChevronDown, Circle, LayoutDashboard, MessageSquare, PanelLeft, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";
import { DaimonMark } from "./DaimonMark";
import { useAppLogStore } from "@/stores/applog";
import { useConfigStore } from "@/stores/config";
import { useGatewayStore } from "@/stores/gateway";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useAttentionStore } from "@/stores/attention";

const CONN_COLOR: Record<string, string> = {
  open: "text-mint",
  connecting: "text-amber",
  reconnecting: "text-amber",
  closed: "text-rust",
};

const VIEW_LABEL: Record<string, string> = {
  agents: "Agents",
  kanban: "Kanban",
  worklog: "Work Log",
};

export function TopBar() {
  const connState = useGatewayStore((s) => s.connState);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
  const sessionCount = useSessionStore((s) => Object.keys(s.sessions).length);
  const logOpen = useAppLogStore((s) => s.drawerOpen);
  const unreadErrors = useAppLogStore((s) => s.unreadErrors);
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const globalView = useLayoutStore((s) => s.globalView);
  const setGlobalView = useLayoutStore((s) => s.setGlobalView);
  const view = useLayoutStore((s) => s.projectView[s.activeProjectId] ?? "agents");
  const projects = useConfigStore((s) => s.projects);
  const durableInputRequests = useAttentionStore(
    (state) => state.records.filter((record) => record.kind === "input_required").length,
  );
  const refreshAttention = useAttentionStore((state) => state.refresh);
  const waitingAgents = durableInputRequests;

  useEffect(() => {
    void refreshAttention();
    const timer = window.setInterval(() => void refreshAttention(), 5_000);
    return () => window.clearInterval(timer);
  }, [refreshAttention]);

  const projectName =
    activeProjectId === SCRATCH_PROJECT_ID
      ? "scratch"
      : (projects.find((p) => p.id === activeProjectId)?.name ?? "…");
  const isScratch = activeProjectId === SCRATCH_PROJECT_ID;

  return (
    <header className="safe-pt flex min-h-[2.5rem] flex-none items-center gap-3 border-b border-line bg-panel px-3">
      <button
        onClick={toggleSidebar}
        className="flex min-h-[40px] items-center text-soft hover:text-text md:min-h-0"
        title="Toggle sidebar"
      >
        <PanelLeft size={16} />
      </button>
      <div className="flex items-center gap-2">
        <DaimonMark size={17} className="text-amber" />
        {/* full brand on desktop; phones get a current-context switcher instead */}
        <span className="hidden font-medium text-text md:inline">Daimon-OS</span>
        <span className="hidden text-xs text-faint md:inline">v0.2.1</span>
      </div>

      {/* mobile project + view switcher: tap to open the sidebar (project list) */}
      <button
        onClick={toggleSidebar}
        title="Switch project"
        className="flex min-h-[40px] min-w-0 items-center gap-1.5 rounded bg-raised px-2.5 text-[15px] text-text active:bg-line/60 md:hidden"
      >
        <span className="max-w-[40vw] truncate font-medium">{projectName}</span>
        {!isScratch && (
          <span className="text-[13px] text-soft">· {VIEW_LABEL[view]}</span>
        )}
        <ChevronDown size={14} className="flex-none text-soft" />
      </button>

      <div className="ml-auto flex items-center gap-3 text-xs">
        <div className="hidden items-center rounded border border-line bg-ink p-0.5 md:flex">
          <button
            onClick={() => setGlobalView("dashboard")}
            className={clsx(
              "flex items-center gap-1.5 rounded px-2 py-1",
              globalView === "dashboard" ? "bg-raised text-text" : "text-soft hover:text-text",
            )}
          >
            <LayoutDashboard size={13} /> Dashboard
          </button>
          <button
            onClick={() => setGlobalView("master-chat")}
            className={clsx(
              "relative flex items-center gap-1.5 rounded px-2 py-1",
              globalView === "master-chat" ? "bg-raised text-sky" : "text-soft hover:text-text",
            )}
          >
            <MessageSquare size={13} /> Master Chat
            {waitingAgents > 0 && (
              <span className="rounded-full bg-sky px-1.5 text-[9px] font-semibold text-white">{waitingAgents > 9 ? "9+" : waitingAgents}</span>
            )}
          </button>
          <button
            onClick={() => setGlobalView("audit")}
            className={clsx(
              "flex items-center gap-1.5 rounded px-2 py-1",
              globalView === "audit" ? "bg-raised text-mint" : "text-soft hover:text-text",
            )}
          >
            <ShieldCheck size={13} /> Audit
          </button>
        </div>
        <span
          className={clsx("flex items-center gap-1.5", CONN_COLOR[connState])}
          title={`gateway ${connState} · 1 socket · ${sessionCount} channel${sessionCount === 1 ? "" : "s"}`}
        >
          <Circle size={7} fill="currentColor" />
          <span className="hidden md:inline">
            gateway {connState} · 1 socket · {sessionCount} channel{sessionCount === 1 ? "" : "s"}
          </span>
        </span>
        <button
          onClick={() => setGlobalView("master-chat")}
          title={
            waitingAgents > 0
              ? `Master chat — ${waitingAgents} agent${waitingAgents === 1 ? "" : "s"} need input`
              : unreadErrors > 0
                ? `Command center — ${unreadErrors} new error${unreadErrors === 1 ? "" : "s"}`
                : "Master chat and application log"
          }
          className={clsx(
            "relative flex min-h-[40px] items-center hover:text-text md:min-h-0",
            waitingAgents > 0 ? "text-sky" : unreadErrors > 0 ? "text-rust" : globalView === "master-chat" || logOpen ? "text-amber" : "text-soft",
          )}
        >
          <MessageSquare size={16} />
          {(waitingAgents > 0 || unreadErrors > 0) && (
            <span className={clsx(
              "absolute -right-1.5 -top-1 flex min-w-[14px] items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-[14px] text-white",
              waitingAgents > 0 ? "bg-sky" : "bg-rust",
            )}>
              {waitingAgents > 9 ? "9+" : waitingAgents || (unreadErrors > 9 ? "9+" : unreadErrors)}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
