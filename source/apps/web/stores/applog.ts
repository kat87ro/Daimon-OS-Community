"use client";

import { create } from "zustand";
import type { AppLogEntry } from "@daimon-os/shared";

const MAX = 1000;

interface AppLogState {
  entries: AppLogEntry[];
  drawerOpen: boolean;
  /** error entries that arrived while the log was closed — drives the icon badge */
  unreadErrors: number;
  append(entry: AppLogEntry): void;
  /** record a client/gateway-side error into the log (server entries arrive via append) */
  logError(message: string, detail?: string, source?: string): void;
  setAll(entries: AppLogEntry[]): void;
  toggleDrawer(): void;
}

export const useAppLogStore = create<AppLogState>((set) => ({
  entries: [],
  drawerOpen: false,
  unreadErrors: 0,
  append: (entry) =>
    set((s) => ({
      entries: [...s.entries, entry].slice(-MAX),
      // count errors that land while the drawer is closed (server OR client)
      unreadErrors:
        entry.level === "error" && !s.drawerOpen ? s.unreadErrors + 1 : s.unreadErrors,
    })),
  logError: (message, detail, source = "client") =>
    set((s) => {
      const entry: AppLogEntry = { ts: Date.now(), level: "error", source, message, detail };
      return {
        entries: [...s.entries, entry].slice(-MAX),
        unreadErrors: s.drawerOpen ? s.unreadErrors : s.unreadErrors + 1,
      };
    }),
  setAll: (entries) => set({ entries: entries.slice(-MAX) }),
  // opening the drawer clears the unread-error badge (you've now seen them)
  toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen, unreadErrors: s.drawerOpen ? s.unreadErrors : 0 })),
}));
