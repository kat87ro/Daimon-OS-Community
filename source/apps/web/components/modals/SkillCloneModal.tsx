"use client";

import { useState } from "react";
import type { ProviderKind } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Modal } from "./Modal";

// kinds with a native skill folder Daimon can clone into
const SUPPORTED: ProviderKind[] = ["claude"];

export function SkillCloneModal({ skillId }: { skillId: string }) {
  const skills = useConfigStore((s) => s.skills);
  const providers = useConfigStore((s) => s.providers);
  const closeModal = useUiStore((s) => s.closeModal);
  const skill = skills.find((s) => s.id === skillId);

  // only offer providers the user actually has, of a supported kind
  const targets = providers.filter((p) => SUPPORTED.includes(p.kind));
  const [picked, setPicked] = useState<Set<ProviderKind>>(
    new Set(targets.map((p) => p.kind)),
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!skill) return null;

  return (
    <Modal title={`Clone "${skill.name}" to providers`}>
      <div className="flex flex-col gap-3">
        <p className="text-xs text-soft">
          Copy this skill into a provider&apos;s CLI home so its agents discover it
          natively. Merge-only — an existing skill there is never overwritten.
        </p>
        {targets.length === 0 ? (
          <p className="text-xs text-faint">
            no skill-capable providers configured (Claude supports this; Codex/Gemini
            have no native skill folder).
          </p>
        ) : (
          targets.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-xs text-soft">
              <input
                type="checkbox"
                checked={picked.has(p.kind)}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(p.kind);
                    else next.delete(p.kind);
                    return next;
                  })
                }
                className="accent-amber"
              />
              {p.name} <span className="text-faint">(~/.{p.kind}/skills)</span>
            </label>
          ))
        )}
        {done && <p className="text-xs text-mint">{done}</p>}
        <div className="flex gap-2">
          {targets.length > 0 && (
            <button
              disabled={busy || picked.size === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  const res = await api.skills.clone(skill.id, [...picked]);
                  setDone(
                    res.cloned.length
                      ? `cloned to: ${res.cloned.join(", ")}`
                      : "nothing cloned (already present)",
                  );
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded bg-amber px-3 py-2 text-xs font-medium text-ink hover:bg-amber/90 disabled:opacity-40"
            >
              {busy ? "Cloning…" : "Clone"}
            </button>
          )}
          <button
            onClick={closeModal}
            className="rounded border border-line px-3 py-2 text-xs text-soft hover:border-amber"
          >
            {done ? "Done" : "Skip"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
