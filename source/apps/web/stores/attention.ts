"use client";

import { create } from "zustand";
import type { Task } from "@daimon-os/shared";
import { api, type AttentionRecord } from "@/lib/api";

interface AttentionState {
  records: AttentionRecord[];
  tasks: Task[];
  loading: boolean;
  stale: boolean;
  error?: string;
  requestSequence: number;
  lastUpdatedAt?: number;
  refresh(): Promise<void>;
}

/**
 * One application-wide projection of the operator attention inbox. Both the
 * top-bar badge and Master Chat read this store, so they cannot disagree after
 * a drawer refresh or a failed/late request.
 */
export const useAttentionStore = create<AttentionState>((set, get) => ({
  records: [],
  tasks: [],
  loading: false,
  stale: true,
  requestSequence: 0,
  refresh: async () => {
    const requestSequence = get().requestSequence + 1;
    set({ requestSequence, loading: true });
    try {
      const [records, tasks] = await Promise.all([
        api.attention.list("open"),
        api.tasks.list(),
      ]);
      if (get().requestSequence !== requestSequence) return;
      set({
        records,
        tasks,
        loading: false,
        stale: false,
        error: undefined,
        lastUpdatedAt: Date.now(),
      });
    } catch (error) {
      if (get().requestSequence !== requestSequence) return;
      set({
        loading: false,
        stale: true,
        error: error instanceof Error ? error.message : "Could not refresh Master Chat",
      });
    }
  },
}));
