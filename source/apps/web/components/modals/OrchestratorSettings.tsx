"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import type { OrchestratorSettings as OrchestratorSettingsType } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { Field, Hint, NumberInput, SaveButton, Select } from "../sidebar/fields";

/** the gateway's actual live port, injected into the renderer by the desktop
 *  preload bridge (window.__DAIMON_PORT__). undefined in a plain web build. */
function liveGatewayPort(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const p = (window as unknown as { __DAIMON_PORT__?: number | null }).__DAIMON_PORT__;
  return typeof p === "number" && p > 0 ? p : undefined;
}

/** Orchestrator settings form — rendered inline inside the Configuration hub
 *  (and reused by the standalone SettingsModal). Saves in place and stays put,
 *  mirroring the Memory tab, so it lives comfortably as a Configuration tab. */
export function OrchestratorSettings({ onSaved }: { onSaved?: () => void }) {
  const settings = useConfigStore((s) => s.settings);
  const saveSettings = useConfigStore((s) => s.saveSettings);
  const loadAll = useConfigStore((s) => s.loadAll);
  const [draft, setDraft] = useState<OrchestratorSettingsType | null>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Close the load race: if the form mounted before config loaded, adopt the
  // real server settings the moment they arrive — but only while the draft is
  // still empty, so it can never clobber edits in progress.
  useEffect(() => {
    if (settings) setDraft((d) => d ?? settings);
  }, [settings]);

  if (!draft) {
    return <p className="text-xs text-faint">settings not loaded yet</p>;
  }
  const patch = (p: Partial<OrchestratorSettingsType>) => {
    setDraft({ ...draft, ...p });
    setSaved(false);
  };

  const livePort = liveGatewayPort();
  const configuredPort = draft.gatewayPort ?? 0;
  const pendingRestart = configuredPort > 0 && livePort !== undefined && configuredPort !== livePort;

  return (
    <div className="flex flex-col gap-3">
      <Field label="Max concurrent sessions">
        <NumberInput
          value={draft.maxConcurrentSessions}
          min={1}
          max={64}
          onChange={(v) => patch({ maxConcurrentSessions: v })}
        />
      </Field>
      <Field label="Default isolation">
        <Select
          value={draft.defaultIsolation}
          options={["mock", "docker"]}
          onChange={(v) => patch({ defaultIsolation: v as "mock" | "docker" })}
        />
      </Field>
      <Field label="Scrollback lines">
        <NumberInput
          value={draft.scrollbackLines}
          min={500}
          max={50000}
          onChange={(v) => patch({ scrollbackLines: v })}
        />
      </Field>
      <Field label="Metrics interval (ms)">
        <NumberInput
          value={draft.telemetry.metricsIntervalMs}
          min={250}
          max={10000}
          onChange={(v) => patch({ telemetry: { metricsIntervalMs: v } })}
        />
      </Field>
      <Field label="Gateway port">
        <NumberInput
          value={configuredPort}
          min={0}
          max={65535}
          onChange={(v) => patch({ gatewayPort: v })}
        />
      </Field>
      <Hint>
        0 = automatic (OS-assigned, recommended). Set a fixed port to pin the gateway to a
        known address for testing.{" "}
        {livePort !== undefined ? `Gateway is live on ${livePort}. ` : ""}
        {pendingRestart
          ? `Restart the app to bind ${configuredPort}.`
          : "Takes effect after restarting the app. Falls back to an automatic port if the chosen one is in use."}
      </Hint>
      <div className="flex items-center gap-2">
        <SaveButton
          saving={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await saveSettings(draft);
              setSaved(true);
              onSaved?.();
            } finally {
              setSaving(false);
            }
          }}
        />
        {saved && (
          <span className="flex items-center gap-1 text-[11px] text-mint">
            <CheckCircle2 size={12} /> Saved
          </span>
        )}
      </div>

      {/* Danger zone — factory reset wipes ALL config back to a clean slate */}
      <div className="mt-2 flex flex-col gap-2 rounded border border-rust/40 bg-rust/5 p-3">
        <div className="flex items-center gap-1.5 text-xs font-medium text-rust">
          <TriangleAlert size={13} /> Danger zone
        </div>
        <p className="text-[11px] leading-relaxed text-soft">
          Reset to factory wipes <b>all</b> providers, agents, teams, projects, skills, MCP
          servers, goals, schedules, and secrets — starting you from scratch. This cannot be
          undone. Running terminals keep going until they exit.
        </p>
        {confirmReset ? (
          <div className="flex items-center gap-2">
            <button
              disabled={resetting}
              onClick={async () => {
                setResetting(true);
                try {
                  await api.admin.reset();
                  await loadAll();
                } finally {
                  setResetting(false);
                  setConfirmReset(false);
                }
              }}
              className="rounded border border-rust bg-rust/20 px-3 py-1.5 text-xs text-rust hover:bg-rust/30 disabled:opacity-50"
            >
              {resetting ? "Resetting…" : "Yes, wipe everything"}
            </button>
            <button
              disabled={resetting}
              onClick={() => setConfirmReset(false)}
              className="rounded border border-line px-3 py-1.5 text-xs text-soft hover:border-amber disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmReset(true)}
            className="self-start rounded border border-rust/60 px-3 py-1.5 text-xs text-rust hover:bg-rust/10"
          >
            Reset to factory…
          </button>
        )}
      </div>
    </div>
  );
}
