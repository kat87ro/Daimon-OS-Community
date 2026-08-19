"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  FolderOpen,
  HardDriveDownload,
  PencilLine,
  RefreshCw,
} from "lucide-react";
import { DEFAULT_MEMORY_SETTINGS } from "@daimon-os/shared";
import type { MemorySettings as MemorySettingsType, MemoryStatus } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { Field, Hint, NumberInput, SaveButton, Select, TextInput } from "../sidebar/fields";

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 text-xs text-soft">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-amber"
      />
      <span className="flex flex-col">
        <span>{label}</span>
        {hint && <span className="text-[10px] italic leading-relaxed text-faint">{hint}</span>}
      </span>
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-1 border-b border-line pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
      {children}
    </h3>
  );
}

export function MemorySettings() {
  const memory = useConfigStore((s) => s.memory);
  const saveMemory = useConfigStore((s) => s.saveMemory);

  const [draft, setDraft] = useState<MemorySettingsType>(memory ?? DEFAULT_MEMORY_SETTINGS);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickingVault, setPickingVault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close the load race: if the form mounted before config loaded, `draft` was
  // seeded with DEFAULT_MEMORY_SETTINGS. Adopt the real server settings the
  // moment they arrive — but only while the user hasn't edited yet, so it can
  // never clobber edits in progress. (draft is non-nullable, so we gate on a
  // `touched` flag instead of the `d ?? settings` trick the Orchestrator uses.)
  useEffect(() => {
    if (memory && !touched) setDraft(memory);
  }, [memory, touched]);

  // async-action result lines
  const [validateMsg, setValidateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [validating, setValidating] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [initMsg, setInitMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [initing, setIniting] = useState(false);

  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const patch = (p: Partial<MemorySettingsType>) => {
    setTouched(true);
    setDraft({ ...draft, ...p });
  };

  const refreshStatus = async () => {
    setStatusLoading(true);
    try {
      setStatus(await api.memory.status());
    } catch (e) {
      setStatus(null);
    } finally {
      setStatusLoading(false);
    }
  };

  const validate = async () => {
    setValidating(true);
    setValidateMsg(null);
    try {
      const saved = await saveMemory(draft);
      setDraft(saved);
      setTouched(false);
      const res = await api.memory.validate({});
      if (!res.ok) {
        setValidateMsg({ ok: false, text: res.error ?? "Validation failed" });
      } else {
        const fb = res.usingFallback ? " (using LOCAL fallback — Obsidian path invalid)" : "";
        setValidateMsg({
          ok: !res.usingFallback,
          text: `Resolved root: ${res.activeMemoryRoot ?? "—"}${fb}`,
        });
        if (res.activeMemoryRoot) patch({ activeMemoryRoot: res.activeMemoryRoot });
      }
    } catch (e) {
      setValidateMsg({ ok: false, text: (e as Error).message });
    } finally {
      setValidating(false);
    }
  };

  const testWrite = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await api.memory.testWrite();
      setTestMsg(
        res.ok
          ? { ok: true, text: `Wrote test file${res.path ? `: ${res.path}` : ""}` }
          : { ok: false, text: res.error ?? "Test write failed" },
      );
    } catch (e) {
      setTestMsg({ ok: false, text: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const rebuildIndex = async () => {
    setRebuilding(true);
    setRebuildMsg(null);
    try {
      const res = await api.memory.rebuildIndex();
      setRebuildMsg(
        res.ok
          ? {
              ok: true,
              text: `Index rebuilt${res.totalMemories !== undefined ? ` — ${res.totalMemories} memories` : ""}`,
            }
          : { ok: false, text: res.error ?? "Rebuild failed" },
      );
      void refreshStatus();
    } catch (e) {
      setRebuildMsg({ ok: false, text: (e as Error).message });
    } finally {
      setRebuilding(false);
    }
  };

  const initMissing = async () => {
    setIniting(true);
    setInitMsg(null);
    try {
      const projects = useConfigStore.getState().projects;
      let done = 0;
      for (const p of projects) {
        try {
          await api.memory.initProject(p.id);
          done += 1;
        } catch {
          /* skip failures, keep going */
        }
      }
      setInitMsg({ ok: true, text: `Initialized memory for ${done}/${projects.length} projects` });
      void refreshStatus();
    } catch (e) {
      setInitMsg({ ok: false, text: (e as Error).message });
    } finally {
      setIniting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (draft.retrievalTokenBudget <= 0) {
        setError("Retrieval token budget must be a positive number");
        return;
      }
      if (draft.storageMode === "obsidian" && !draft.obsidianVaultPath?.trim()) {
        setError("Obsidian vault path is required when storage mode is Obsidian");
        return;
      }
      const saved = await saveMemory(draft);
      setDraft(saved);
      setTouched(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const pickVault = async () => {
    setPickingVault(true);
    setError(null);
    try {
      const selected = await api.fs.pickFolder();
      if (selected.path) patch({ obsidianVaultPath: selected.path });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPickingVault(false);
    }
  };

  const ResultLine = ({ msg }: { msg: { ok: boolean; text: string } | null }) =>
    msg ? (
      <p className={`flex items-center gap-1 text-[11px] ${msg.ok ? "text-mint" : "text-rust"}`}>
        {msg.ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
        <span className="break-all">{msg.text}</span>
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-3">
      <Toggle
        label="Enable centralized memory"
        hint="Master switch — durable memory resolves through a single active root."
        checked={draft.enabled}
        onChange={(enabled) => patch({ enabled })}
      />

      <SectionTitle>Storage</SectionTitle>
      <Field label="Storage mode">
        <Select
          value={draft.storageMode}
          options={[
            { value: "obsidian", label: "Obsidian vault" },
            { value: "local", label: "Local (app-managed)" },
          ]}
          onChange={(v) => patch({ storageMode: v as MemorySettingsType["storageMode"] })}
        />
      </Field>

      {draft.storageMode === "obsidian" && (
        <>
          <Field label="Obsidian vault path">
            <div className="flex gap-2">
              <input
                readOnly
                value={draft.obsidianVaultPath ?? ""}
                placeholder="Select an existing Obsidian vault"
                className="w-full cursor-default rounded border border-line bg-raised px-2 py-1.5 text-xs text-white outline-none placeholder:italic placeholder:text-faint"
              />
              <button
                type="button"
                onClick={pickVault}
                disabled={pickingVault}
                className="flex shrink-0 items-center gap-1 rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
              >
                <FolderOpen size={12} /> {pickingVault ? "Selecting…" : "Browse"}
              </button>
            </div>
            <Hint>Desktop builds require an explicit native folder selection.</Hint>
          </Field>
          <Field label="Memory folder inside vault">
            <TextInput
              value={draft.obsidianMemoryFolderPath ?? ""}
              placeholder="AgenticOS-Memory"
              onChange={(v) => patch({ obsidianMemoryFolderPath: v })}
            />
          </Field>
          <Toggle
            label="Strict Obsidian"
            hint="Error instead of silently falling back to local when the vault is invalid."
            checked={draft.strictObsidian}
            onChange={(strictObsidian) => patch({ strictObsidian })}
          />
        </>
      )}

      <Field label="Local memory folder (fallback)">
        <TextInput
          value={draft.localMemoryFolderPath ?? ""}
          placeholder="<appData>/AgenticOS-Memory (default)"
          onChange={(v) => patch({ localMemoryFolderPath: v })}
        />
        <Hint>Used when storage mode is Local, or as the fallback for an invalid vault.</Hint>
      </Field>

      <Field label="Active memory root (resolved)">
        <input
          readOnly
          value={draft.activeMemoryRoot ?? status?.activeMemoryRoot ?? "— run Validate —"}
          className="w-full cursor-default rounded border border-line bg-ink px-2 py-1.5 text-xs text-soft outline-none"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={validate}
          disabled={validating}
          className="flex items-center gap-1 rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
        >
          <CheckCircle2 size={12} /> {validating ? "Saving & validating…" : "Save & validate"}
        </button>
        <button
          onClick={testWrite}
          disabled={testing}
          className="flex items-center gap-1 rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
        >
          <PencilLine size={12} /> {testing ? "Testing…" : "Test write"}
        </button>
        <button
          onClick={rebuildIndex}
          disabled={rebuilding}
          className="flex items-center gap-1 rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
        >
          <RefreshCw size={12} /> {rebuilding ? "Rebuilding…" : "Rebuild index"}
        </button>
      </div>
      <ResultLine msg={validateMsg} />
      <ResultLine msg={testMsg} />
      <ResultLine msg={rebuildMsg} />

      <SectionTitle>Status</SectionTitle>
      <div className="rounded border border-line bg-raised/40 p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1 text-[11px] text-soft">
            <Database size={12} className="text-sky" /> Memory status
          </span>
          <button
            onClick={refreshStatus}
            disabled={statusLoading}
            className="flex items-center gap-1 text-[10px] text-faint hover:text-amber disabled:opacity-50"
          >
            <RefreshCw size={10} /> {statusLoading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {status ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-soft">
            <span>Memories</span>
            <span className="text-right text-text">{status.totalMemories}</span>
            <span>Projects</span>
            <span className="text-right text-text">{status.totalProjects}</span>
            <span>With memory</span>
            <span className="text-right text-mint">{status.projectsWithMemory}</span>
            <span>Missing memory</span>
            <span className="text-right text-amber">{status.projectsMissingMemory}</span>
            <span>Using fallback</span>
            <span className={`text-right ${status.usingFallback ? "text-rust" : "text-mint"}`}>
              {status.usingFallback ? "yes" : "no"}
            </span>
            <span>Last rebuild</span>
            <span className="text-right text-text">{status.lastIndexRebuild ?? "—"}</span>
            {status.lastError && (
              <>
                <span className="text-rust">Last error</span>
                <span className="break-all text-right text-rust">{status.lastError}</span>
              </>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-faint">Refresh to load current status.</p>
        )}
      </div>

      <SectionTitle>Project memory</SectionTitle>
      <Toggle
        label="Initialize project memory on create"
        hint="Create a centralized memory namespace whenever a project is created/started."
        checked={draft.initProjectMemoryOnCreate}
        onChange={(initProjectMemoryOnCreate) => patch({ initProjectMemoryOnCreate })}
      />
      <Toggle
        label="Teams can write project memory"
        hint="Attached teams get default read/write to that project's memory namespace."
        checked={draft.teamsCanWriteProjectMemory}
        onChange={(teamsCanWriteProjectMemory) => patch({ teamsCanWriteProjectMemory })}
      />
      <div>
        <button
          onClick={initMissing}
          disabled={initing}
          className="flex items-center gap-1 rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
        >
          <HardDriveDownload size={12} /> {initing ? "Initializing…" : "Initialize missing project memory"}
        </button>
        <div className="mt-1">
          <ResultLine msg={initMsg} />
        </div>
      </div>

      <SectionTitle>Retrieval &amp; indexing</SectionTitle>
      <Toggle
        label="Enable retrieval"
        hint="Inject relevant memory into an agent's context (keyword/index, no embeddings in v1)."
        checked={draft.enableRetrieval}
        onChange={(enableRetrieval) => patch({ enableRetrieval })}
      />
      <Field label="Retrieval token budget">
        <NumberInput
          value={draft.retrievalTokenBudget}
          min={1}
          onChange={(v) => patch({ retrievalTokenBudget: v })}
        />
      </Field>
      <Toggle
        label="Session summaries"
        checked={draft.enableSessionSummaries}
        onChange={(enableSessionSummaries) => patch({ enableSessionSummaries })}
      />
      <Toggle
        label="Agent memory"
        checked={draft.enableAgentMemory}
        onChange={(enableAgentMemory) => patch({ enableAgentMemory })}
      />
      <Toggle
        label="Team memory"
        checked={draft.enableTeamMemory}
        onChange={(enableTeamMemory) => patch({ enableTeamMemory })}
      />
      <Toggle
        label="Project memory"
        checked={draft.enableProjectMemory}
        onChange={(enableProjectMemory) => patch({ enableProjectMemory })}
      />
      <Toggle
        label="Task memory"
        checked={draft.enableTaskMemory}
        onChange={(enableTaskMemory) => patch({ enableTaskMemory })}
      />
      <Toggle
        label="JSON indexes"
        hint="Maintain JSON index files alongside the markdown for fast lookup."
        checked={draft.enableJsonIndexes}
        onChange={(enableJsonIndexes) => patch({ enableJsonIndexes })}
      />

      {error && (
        <p className="flex items-center gap-1 text-[11px] text-rust">
          <AlertTriangle size={11} /> {error}
        </p>
      )}

      <div className="sticky bottom-0 -mx-4 -mb-4 flex items-center gap-2 border-t border-line bg-panel px-4 py-3">
        <SaveButton saving={saving} onClick={save} label="Save memory settings" />
        {memory == null && <span className="text-[10px] text-faint">defaults shown — not yet persisted</span>}
      </div>
    </div>
  );
}
