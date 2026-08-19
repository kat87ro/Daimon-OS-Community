"use client";

import { create } from "zustand";

export type ModalSpec =
  | { type: "spawn"; projectId?: string }
  | { type: "project"; id?: string; parentProjectId?: string }
  | { type: "git"; projectId: string }
  | { type: "team"; id?: string }
  | { type: "org" }
  | { type: "agent"; id?: string }
  | { type: "fusion-runs"; agentId: string }
  | { type: "provider"; id?: string }
  | { type: "skill"; id?: string }
  | { type: "skill-clone"; skillId: string }
  | { type: "mcp"; id?: string }
  | { type: "secret"; id?: string }
  | { type: "blueprint"; id?: string }
  | { type: "schedule"; id?: string }
  | { type: "task"; projectId: string; id?: string }
  | { type: "goal"; projectId: string; id?: string }
  | { type: "review"; taskId: string }
  | { type: "org-team"; teamId: string }
  | { type: "provider-import"; providerId: string }
  | { type: "configuration"; tab?: string; notice?: string }
  | { type: "settings" }
  | { type: "setup-wizard" }
  | { type: "docs"; section?: string };

interface UiState {
  /** modal stack — the top is the visible modal. `pushModal` layers a child
   *  (e.g. an editor opened from Configuration) so it can go BACK instead of
   *  closing the whole thing. `modal` mirrors the top for existing consumers. */
  stack: ModalSpec[];
  modal: ModalSpec | null;
  /** replace the stack — the default for a fresh modal (no back target) */
  openModal(modal: ModalSpec): void;
  /** layer a modal ON TOP of the current one (Back returns to it) */
  pushModal(modal: ModalSpec): void;
  /** pop one level — returns to the previous modal, or closes if none left.
   *  (Editors call this on save/cancel, so a pushed editor returns to its parent.) */
  closeModal(): void;
  /** dismiss the entire stack */
  closeAll(): void;
  /** shallow-merge a patch into the top spec (e.g. remember the active tab) */
  patchTop(patch: Record<string, unknown>): void;
}

const top = (stack: ModalSpec[]): ModalSpec | null => stack[stack.length - 1] ?? null;

export const useUiStore = create<UiState>((set) => ({
  stack: [],
  modal: null,
  openModal: (modal) => set({ stack: [modal], modal }),
  pushModal: (modal) => set((s) => { const stack = [...s.stack, modal]; return { stack, modal: top(stack) }; }),
  closeModal: () => set((s) => { const stack = s.stack.slice(0, -1); return { stack, modal: top(stack) }; }),
  closeAll: () => set({ stack: [], modal: null }),
  patchTop: (patch) =>
    set((s) => {
      if (s.stack.length === 0) return {};
      const stack = [...s.stack];
      stack[stack.length - 1] = { ...stack[stack.length - 1], ...patch } as ModalSpec;
      return { stack, modal: top(stack) };
    }),
}));
