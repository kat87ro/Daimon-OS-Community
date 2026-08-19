"use client";

import { create } from "zustand";
import type { Layout } from "react-grid-layout";
import { SCRATCH_PROJECT_ID } from "@daimon-os/shared";

const COLS = 12;
const PANE_W = 4;
const PANE_H = 11;

export type GlobalView = "dashboard" | "master-chat" | "audit" | null;

interface LayoutState {
  /** one grid layout per project tab (key: projectId or "scratch") */
  layouts: Record<string, Layout[]>;
  /** editor-style tabs: only OPENED projects appear; scratch is always first */
  openTabs: string[];
  activeProjectId: string;
  /** A first-class, cross-project workspace. `null` means a project/scratch tab. */
  globalView: GlobalView;
  /** which of the 3 project pages is showing, per project */
  projectView: Record<string, "agents" | "kanban" | "worklog">;
  sidebarCollapsed: boolean;
  focusedChannel: string | null;
  maximizedChannel: string | null;
  /** sidebar tree expansion state, keyed by section/node id */
  expanded: Record<string, boolean>;
  addPane(channel: string, projectId?: string, opts?: { activate?: boolean }): void;
  removePane(channel: string): void;
  applyLayout(projectId: string, layout: Layout[]): void;
  /** opens the tab if needed and activates it */
  setActiveProject(id: string): void;
  setGlobalView(view: Exclude<GlobalView, null>): void;
  setProjectView(id: string, view: "agents" | "kanban" | "worklog"): void;
  /** closes the tab only — terminals keep running in the background */
  closeTab(id: string): void;
  /** close every tab except scratch (context menu) */
  closeOtherTabs(keepId: string): void;
  closeAllTabs(): void;
  /** drop tabs/layouts for projects that no longer exist (e.g. after a factory
   *  reset or an external delete) — scratch is always kept */
  pruneTabs(validProjectIds: string[]): void;
  toggleSidebar(): void;
  setSidebarCollapsed(collapsed: boolean): void;
  toggleExpanded(key: string): void;
  setFocused(channel: string | null): void;
  toggleMaximized(channel: string): void;
  /** projectId that owns a channel's pane, if any */
  projectOf(channel: string): string | undefined;
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  layouts: { [SCRATCH_PROJECT_ID]: [] },
  openTabs: [SCRATCH_PROJECT_ID],
  activeProjectId: SCRATCH_PROJECT_ID,
  // First launch must land on a useful control plane rather than an empty
  // scratch terminal. Projects remain one click away in the sidebar/tabs.
  globalView: "dashboard",
  projectView: {},
  sidebarCollapsed: false,
  focusedChannel: null,
  maximizedChannel: null,
  expanded: { projects: true, teams: false, agents: false, providers: false },

  addPane(channel, projectId = SCRATCH_PROJECT_ID, opts) {
    const layouts = get().layouts;
    const current = layouts[projectId] ?? [];
    if (current.some((p) => p.i === channel)) return;
    const pane: Layout = {
      i: channel,
      x: (current.length * PANE_W) % COLS,
      y: Infinity, // react-grid-layout: drop at the bottom, compact up
      w: PANE_W,
      h: PANE_H,
      minW: 3,
      minH: 6,
    };
    set((s) => ({
      layouts: { ...s.layouts, [projectId]: [...current, pane] },
      // a pane landing in a closed tab re-opens it (without stealing focus
      // unless this spawn was user-initiated)
      openTabs: s.openTabs.includes(projectId) ? s.openTabs : [...s.openTabs, projectId],
      ...(opts?.activate === false ? {} : { activeProjectId: projectId, focusedChannel: channel }),
      ...(opts?.activate === false ? {} : { globalView: null }),
    }));
  },

  removePane(channel) {
    set((s) => ({
      layouts: Object.fromEntries(
        Object.entries(s.layouts).map(([pid, panes]) => [
          pid,
          panes.filter((p) => p.i !== channel),
        ]),
      ),
      focusedChannel: s.focusedChannel === channel ? null : s.focusedChannel,
      maximizedChannel: s.maximizedChannel === channel ? null : s.maximizedChannel,
    }));
  },

  applyLayout(projectId, layout) {
    set((s) => {
      const prev = s.layouts[projectId] ?? [];
      return {
        layouts: {
          ...s.layouts,
          // preserve constraints; RGL strips custom fields
          [projectId]: layout.map((l) => ({
            ...(prev.find((p) => p.i === l.i) ?? l),
            ...l,
          })),
        },
      };
    });
  },

  setActiveProject: (id) =>
    set((s) => ({
      activeProjectId: id,
      globalView: null,
      maximizedChannel: null,
      openTabs: s.openTabs.includes(id) ? s.openTabs : [...s.openTabs, id],
    })),

  setGlobalView: (globalView) => set({ globalView, maximizedChannel: null }),

  setProjectView: (id, view) =>
    set((s) => ({ projectView: { ...s.projectView, [id]: view } })),

  closeTab: (id) =>
    set((s) => {
      if (id === SCRATCH_PROJECT_ID) return s; // scratch is permanent
      const openTabs = s.openTabs.filter((t) => t !== id);
      return {
        openTabs,
        activeProjectId:
          s.activeProjectId === id
            ? (openTabs[openTabs.length - 1] ?? SCRATCH_PROJECT_ID)
            : s.activeProjectId,
      };
    }),

  closeOtherTabs: (keepId) =>
    set((s) => ({
      openTabs: s.openTabs.filter((t) => t === SCRATCH_PROJECT_ID || t === keepId),
      activeProjectId: keepId,
    })),

  closeAllTabs: () =>
    set({ openTabs: [SCRATCH_PROJECT_ID], activeProjectId: SCRATCH_PROJECT_ID, globalView: "dashboard" }),

  pruneTabs: (validProjectIds) =>
    set((s) => {
      const valid = new Set([SCRATCH_PROJECT_ID, ...validProjectIds]);
      const openTabs = s.openTabs.filter((t) => valid.has(t));
      // drop layouts for tabs whose project is gone (frees their pane refs)
      const layouts = Object.fromEntries(
        Object.entries(s.layouts).filter(([pid]) => valid.has(pid)),
      );
      if (!layouts[SCRATCH_PROJECT_ID]) layouts[SCRATCH_PROJECT_ID] = [];
      return {
        layouts,
        openTabs: openTabs.length ? openTabs : [SCRATCH_PROJECT_ID],
        activeProjectId: valid.has(s.activeProjectId) ? s.activeProjectId : SCRATCH_PROJECT_ID,
        maximizedChannel: null,
      };
    }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  toggleExpanded: (key) =>
    set((s) => ({ expanded: { ...s.expanded, [key]: !s.expanded[key] } })),
  setFocused: (channel) => set({ focusedChannel: channel }),
  toggleMaximized: (channel) =>
    set((s) => ({
      maximizedChannel: s.maximizedChannel === channel ? null : channel,
    })),

  projectOf(channel) {
    for (const [pid, panes] of Object.entries(get().layouts)) {
      if (panes.some((p) => p.i === channel)) return pid;
    }
    return undefined;
  },
}));
