"use client";

import { create } from "zustand";
import type {
  ExitPayload,
  RunMetrics,
  StatusPayload,
  TerminalSession,
} from "@daimon-os/shared";

/**
 * Low-frequency session state only — status changes, ~1 Hz metrics, exits.
 * stdout NEVER touches this store; it flows straight to xterm via the
 * ChannelRegistry, so 10+ streaming terminals cause zero React re-renders.
 */
interface SessionState {
  sessions: Record<string, TerminalSession>;
  upsert(session: TerminalSession): void;
  applyStatus(channel: string, status: StatusPayload): void;
  applyMetrics(channel: string, metrics: RunMetrics): void;
  applyExit(channel: string, exit: ExitPayload): void;
  remove(channel: string): void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: {},

  upsert: (session) =>
    set((s) => ({ sessions: { ...s.sessions, [session.id as string]: session } })),

  applyStatus: (channel, status) =>
    set((s) => {
      const cur = s.sessions[channel];
      if (!cur) return s;
      return {
        sessions: {
          ...s.sessions,
          [channel]: {
            ...cur,
            status: status.status,
            statusLabel: status.label,
            activeTools: status.activeTools,
          },
        },
      };
    }),

  applyMetrics: (channel, metrics) =>
    set((s) => {
      const cur = s.sessions[channel];
      if (!cur) return s;
      return { sessions: { ...s.sessions, [channel]: { ...cur, metrics } } };
    }),

  applyExit: (channel, exit) =>
    set((s) => {
      const cur = s.sessions[channel];
      if (!cur) return s;
      const status =
        exit.reason === "completed"
          ? ("completed" as const)
          : exit.reason === "killed"
            ? ("killed" as const)
            : ("failed" as const);
      return {
        sessions: {
          ...s.sessions,
          [channel]: {
            ...cur,
            status,
            exitCode: exit.exitCode,
            exitReason: exit.reason,
            endedAt: cur.endedAt ?? new Date().toISOString(),
          },
        },
      };
    }),

  remove: (channel) =>
    set((s) => {
      const { [channel]: _gone, ...rest } = s.sessions;
      return { sessions: rest };
    }),
}));
