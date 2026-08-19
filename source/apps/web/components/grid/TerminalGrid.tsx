"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import GridLayout, { type Layout } from "react-grid-layout";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { TerminalPane } from "./TerminalPane";

function EmptyTerminals() {
  const openModal = useUiStore((s) => s.openModal);
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <p className="font-sans text-sm font-semibold text-text">No terminals running</p>
        <p className="font-sans text-xs text-soft">
          Start a manual agent pane, run a task, or bring a project Lead online.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <button
            onClick={() => openModal({ type: "spawn", projectId: activeProjectId })}
            className="rounded-md bg-amber px-3 py-1.5 font-sans text-xs font-medium text-ink hover:bg-amber/90"
          >
            Spawn terminal
          </button>
          <button
            onClick={() => openModal({ type: "spawn", projectId: activeProjectId })}
            className="rounded-md border border-line px-3 py-1.5 font-sans text-xs text-soft hover:border-amber hover:text-amber"
          >
            Start agent
          </button>
        </div>
      </div>
    </div>
  );
}

// stable fallback — an inline `?? []` makes the zustand snapshot unstable and
// React aborts rendering with "getSnapshot should be cached"
const NO_PANES: Layout[] = [];

/** reactive <768px check so the grid switches to single-pane mode on phones */
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export function TerminalGrid() {
  const activeProjectId = useLayoutStore((s) => s.activeProjectId);
  const panes = useLayoutStore((s) => s.layouts[s.activeProjectId] ?? NO_PANES);
  const applyLayout = useLayoutStore((s) => s.applyLayout);
  const maximized = useLayoutStore((s) => s.maximizedChannel);
  const sessions = useSessionStore((s) => s.sessions);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const isMobile = useIsMobile();
  const [activePane, setActivePane] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  // keep the mobile selection valid as panes come and go; default to the newest
  useEffect(() => {
    if (panes.length === 0) {
      if (activePane !== null) setActivePane(null);
    } else if (!activePane || !panes.some((p) => p.i === activePane)) {
      setActivePane(panes[panes.length - 1]!.i);
    }
  }, [panes, activePane]);

  // ----- mobile: one pane at a time + a switcher strip -----
  // every pane stays MOUNTED (hidden, not unmounted) so xterm scrollback survives
  if (isMobile) {
    if (panes.length === 0) {
      return (
        <main className="flex min-w-0 flex-1 flex-col bg-ink">
          <EmptyTerminals />
        </main>
      );
    }
    const current =
      activePane && panes.some((p) => p.i === activePane) ? activePane : panes[panes.length - 1]!.i;
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-ink">
        <div className="flex flex-none gap-1 overflow-x-auto border-b border-line bg-panel px-1.5 py-1">
          {panes.map((p) => {
            const label = sessions[p.i]?.agentName ?? "shell";
            return (
              <button
                key={p.i}
                onClick={() => setActivePane(p.i)}
                // ~30% smaller than before so more spawned agents fit in the
                // strip and the terminal below gets more readable room
                className={clsx(
                  "min-h-[32px] max-w-[34vw] flex-none truncate rounded px-2 py-1 text-[10px] leading-tight",
                  current === p.i ? "bg-amber text-ink" : "bg-raised text-soft",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="relative min-h-0 flex-1">
          {panes.map((p) => (
            <div key={p.i} className={clsx("absolute inset-0 p-2", current === p.i ? "" : "hidden")}>
              <TerminalPane channel={p.i} />
            </div>
          ))}
        </div>
      </main>
    );
  }

  // ----- desktop: resizable grid -----
  const showMaximized = maximized && panes.some((p) => p.i === maximized);

  return (
    <main ref={ref} className="min-w-0 flex-1 overflow-y-auto bg-ink">
      {showMaximized ? (
        <div className="h-full p-2">
          <TerminalPane channel={maximized} />
        </div>
      ) : (
        <>
          {panes.length === 0 && <EmptyTerminals />}
          <GridLayout
            className="layout"
            layout={panes}
            cols={12}
            rowHeight={28}
            width={width}
            margin={[8, 8]}
            draggableHandle=".pane-drag-handle"
            onLayoutChange={(l) => applyLayout(activeProjectId, l)}
            compactType="vertical"
          >
            {panes.map((pane) => (
              <div key={pane.i}>
                <TerminalPane channel={pane.i} />
              </div>
            ))}
          </GridLayout>
        </>
      )}
    </main>
  );
}
