"use client";

import { useState } from "react";
import { ListChecks, Plug, RefreshCw, Trash2 } from "lucide-react";
import { PROVIDER_PRESETS, newProviderId, providerKindSchema } from "@daimon-os/shared";
import type { ProviderConfig, ProviderKind } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { api } from "@/lib/api";
import { Field, SaveButton, Select, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

// only these CLI families expose a scannable config home
const SYNCABLE: ProviderKind[] = ["claude", "gemini", "codex"];
const LAUNCH_CLI_KINDS: ProviderKind[] = ["claude", "gemini", "codex", "ollama", "lmstudio"];
const LOCAL_KINDS: ProviderKind[] = ["ollama", "lmstudio"];

function fromPreset(kind: ProviderKind, base?: ProviderConfig): ProviderConfig {
  const preset = PROVIDER_PRESETS[kind];
  const id = base?.id ?? newProviderId();
  return {
    id,
    name: base?.name || preset.label,
    kind,
    mode: preset.mode,
    apiFormat: preset.apiFormat,
    baseUrl: preset.baseUrl,
    // ref derives from the provider id — collision-free, unlike Date.now()
    apiKeyRef: base?.apiKeyRef ?? `key-${id}`,
    maskedKey: base?.maskedKey,
    defaultModel: preset.defaultModel,
    models: [],
    enabled: true,
  };
}

export function ProviderModal({ id }: { id?: string }) {
  const providers = useConfigStore((s) => s.providers);
  const saveProvider = useConfigStore((s) => s.saveProvider);
  const deleteProvider = useConfigStore((s) => s.deleteProvider);
  const loadAll = useConfigStore((s) => s.loadAll);
  const openModal = useUiStore((s) => s.openModal);
  const pushModal = useUiStore((s) => s.pushModal);
  const closeModal = useUiStore((s) => s.closeModal);
  const patchTop = useUiStore((s) => s.patchTop);
  // ModalHost renders only the top-of-stack modal, so pushing the
  // "provider-import" child unmounts this editor and would discard the local
  // draft AND the write-only apiKey (which has no `existing` source to re-seed
  // from). We stash both on the provider ModalSpec — the same persistence
  // pattern AgentModal uses — so they survive the unmount and are restored when
  // the child pops back. Neither key is on the ModalSpec union, so we read them
  // with a local cast — patchTop already accepts arbitrary keys.
  const stashed = useUiStore((s) =>
    s.modal?.type === "provider"
      ? (s.modal as { draft?: ProviderConfig; apiKey?: string })
      : undefined,
  );

  const existing = providers.find((p) => p.id === id);
  const [draft, setDraft] = useState<ProviderConfig>(
    stashed?.draft ?? existing ?? fromPreset("claude"),
  );
  const [apiKey, setApiKey] = useState(stashed?.apiKey ?? "");
  const patch = (p: Partial<ProviderConfig>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    // mirror the draft onto the modal stack so the pushed child modal can pop
    // back to this editor with the in-progress edits intact
    patchTop({ draft: next });
  };
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testState, setTestState] = useState<{
    status: "idle" | "running" | "ok" | "fail";
    detail?: string;
  }>({ status: "idle" });

  async function runSync() {
    if (!existing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = await api.import.sync(existing.id);
      await loadAll();
      const a = r.added;
      const total = a.skills.length + a.agents.length + a.mcpServers.length;
      if (total === 0) {
        setSyncResult(`Already up to date — nothing new in your ${r.kind} CLI.`);
      } else {
        const parts: string[] = [];
        if (a.mcpServers.length) parts.push(`MCP: ${a.mcpServers.join(", ")}`);
        if (a.skills.length) parts.push(`skills: ${a.skills.join(", ")}`);
        if (a.agents.length) parts.push(`agents: ${a.agents.join(", ")}`);
        setSyncResult(`Synced ${total} new — ${parts.join(" · ")}`);
      }
    } catch {
      setSyncResult("Sync failed — is the server reachable?");
    } finally {
      setSyncing(false);
    }
  }
  const preset = PROVIDER_PRESETS[draft.kind];
  const isCli = draft.mode === "cli" && LAUNCH_CLI_KINDS.includes(draft.kind);
  const isLocal = LOCAL_KINDS.includes(draft.kind);

  const modelIds = draft.models.map((model) => model.id);
  const selectedCatalogModel = modelIds.includes(draft.defaultModel) ? draft.defaultModel : "";

  return (
    <Modal title={existing ? `Provider — ${existing.name}` : "New provider"}>
      <div className="flex flex-col gap-3">
        <Field label="Kind">
          <Select
            value={draft.kind}
            options={providerKindSchema.options.filter((k) => LAUNCH_CLI_KINDS.includes(k)).map((k) => ({
              value: k,
              label: PROVIDER_PRESETS[k].label,
            }))}
            onChange={(v) => {
              // switching kind re-derives every kind-specific default
              const next = fromPreset(v as ProviderKind, existing);
              setDraft(next);
              patchTop({ draft: next });
              setTestState({ status: "idle" });
            }}
          />
        </Field>
        <Field label="Name">
          <TextInput value={draft.name} onChange={(name) => patch({ name })} />
        </Field>

        {!isCli && (
          <p className="rounded border border-rust/40 bg-rust/10 px-2 py-1.5 text-[11px] text-rust">
            This legacy or non-agentic connection is configuration-only and cannot execute in this release.
            Choose a supported CLI provider or delete it.
          </p>
        )}

        {!isCli && (
          <>
            <Field label="Base URL">
              <TextInput
                value={draft.baseUrl ?? ""}
                placeholder={preset.baseUrl ?? "https://api.example.com/v1"}
                onChange={(baseUrl) => patch({ baseUrl: baseUrl || undefined })}
              />
            </Field>
            {draft.kind === "custom" && (
              <Field label="API wire format">
                <Select
                  value={draft.apiFormat ?? "openai"}
                  options={["openai", "anthropic", "gemini"]}
                  onChange={(v) => patch({ apiFormat: v as ProviderConfig["apiFormat"] })}
                />
              </Field>
            )}
          </>
        )}

        <Field label={isLocal ? "Local model" : "Default model"}>
          <Select
            value={selectedCatalogModel}
            options={isLocal
              ? (modelIds.length > 0
                  ? draft.models.map((model) => ({ value: model.id, label: model.label }))
                  : [{ value: "", label: "Discover models first" }])
              : [
                  { value: "", label: "Provider default (recommended)" },
                  ...draft.models.map((model) => ({ value: model.id, label: model.label })),
                ]}
            onChange={(defaultModel) => patch({ defaultModel })}
          />
        </Field>
        {!isLocal && (
          <Field label="…or an exact custom model id accepted by the provider">
            <TextInput
              value={draft.defaultModel}
              placeholder="Leave empty to track the provider default"
              onChange={(defaultModel) => patch({ defaultModel })}
            />
          </Field>
        )}

        {isCli && !isLocal && (
          <p className="text-[10px] leading-relaxed text-faint">
            cli mode launches the verified <code>{draft.kind}</code> executable from PATH using
            your existing subscription login — no key needed. Providers are used by
            agents only; plain shells never touch them.
          </p>
        )}

        {isCli && (
          <div className="rounded border border-sky/30 bg-sky/5 p-2 text-[10px] leading-relaxed text-soft">
            {isLocal ? (
              <>
                <p>
                  <b>{preset.label}</b> supplies inference on this Mac. Daimon uses the verified
                  Codex CLI as the coding-agent runtime, with a private credential-free profile.
                  Install Codex and start {draft.kind === "ollama" ? "Ollama" : "LM Studio's local server"} first.
                </p>
                <p className="mt-1 text-faint">
                  Endpoint: <code>{draft.baseUrl}</code>. Local providers reject remote hosts and
                  Ollama <code>:cloud</code> aliases.
                </p>
              </>
            ) : (
              <p>
                Daimon asks the installed provider CLI for its model catalog. If that CLI has no
                machine-readable catalog, Daimon uses the provider's native default instead of a stale built-in list.
              </p>
            )}
            <button
              type="button"
              disabled={testState.status === "running"}
              onClick={async () => {
                setTestState({ status: "running" });
                try {
                  const result = await api.providers.test({
                    kind: draft.kind,
                    mode: draft.mode,
                    baseUrl: draft.baseUrl,
                    apiFormat: draft.apiFormat,
                  });
                  if (result.ok) {
                    const ids = result.models.map((model) => model.id);
                    const next = {
                      ...draft,
                      defaultModel: ids.includes(draft.defaultModel)
                        ? draft.defaultModel
                        : isLocal
                          ? (ids[0] ?? "")
                          : draft.defaultModel,
                      models: result.models,
                    };
                    setDraft(next);
                    patchTop({ draft: next });
                  }
                  setTestState({ status: result.ok ? "ok" : "fail", detail: result.detail });
                } catch (cause) {
                  setTestState({
                    status: "fail",
                    detail: cause instanceof Error ? cause.message : "Connection test failed.",
                  });
                }
              }}
              className="mt-2 flex items-center gap-1.5 rounded border border-line px-2.5 py-1.5 text-xs text-soft hover:border-sky hover:text-sky disabled:opacity-50"
            >
              <RefreshCw size={12} className={testState.status === "running" ? "animate-spin" : ""} /> {testState.status === "running" ? "Discovering…" : "Test & refresh models"}
            </button>
            {testState.detail && (
              <p role={testState.status === "fail" ? "alert" : undefined} className={`mt-1 ${testState.status === "ok" ? "text-mint" : "text-rust"}`}>
                {testState.detail}
              </p>
            )}
          </div>
        )}

        {existing && SYNCABLE.includes(draft.kind) && (
          <div className="flex flex-col gap-1.5 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={runSync}
                disabled={syncing}
                className="flex w-fit items-center gap-1.5 rounded border border-line px-3 py-1.5 text-xs text-soft hover:border-sky hover:text-sky disabled:opacity-50"
                title={`Re-scan your ${draft.kind} CLI and pull any new skills, agents, MCP servers & connections`}
              >
                <RefreshCw size={12} className={syncing ? "animate-spin" : ""} />
                {syncing ? "Syncing…" : `Sync from ${draft.kind} CLI`}
              </button>
              <button
                onClick={() => pushModal({ type: "provider-import", providerId: existing.id })}
                className="flex w-fit items-center gap-1.5 rounded border border-line px-3 py-1.5 text-xs text-soft hover:border-amber hover:text-amber"
                title="Browse everything (incl. plugin skills) and pick what to import"
              >
                <ListChecks size={12} /> Browse &amp; import…
              </button>
            </div>
            {syncResult && <p className="text-[10px] leading-relaxed text-faint">{syncResult}</p>}
            <p className="text-[10px] leading-relaxed text-faint">
              <b>Sync</b> pulls anything new from your personal {draft.kind} config
              (skills, agents, MCP connections) without overwriting what you have.
              <b> Browse &amp; import</b> lets you hand-pick from everything —
              including your plugin skills.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          {saveError && (
            <p role="alert" className="basis-full rounded border border-rust/40 bg-rust/5 px-2 py-1.5 text-[11px] text-rust">
              {saveError}
            </p>
          )}
          <SaveButton
            saving={saving}
            disabled={!isCli}
            onClick={async () => {
              setSaving(true);
              setSaveError(null);
              try {
                // The server replaces this list with authoritative provider
                // output. Never merge stale UI or preset catalog entries.
                const merged: ProviderConfig = { ...draft };
                await saveProvider(merged, apiKey || undefined);
                if (!existing) {
                  // Return to a visible persisted state after the optional import.
                  // The previous replace-stack flow made Save look inert because
                  // Skip closed every modal and showed an empty scratch page.
                  openModal({
                    type: "configuration",
                    tab: "providers",
                    notice: `${merged.name} was saved and is ready for agents.`,
                  });
                  if (SYNCABLE.includes(merged.kind)) {
                    pushModal({ type: "provider-import", providerId: draft.id });
                  }
                } else {
                  openModal({
                    type: "configuration",
                    tab: "providers",
                    notice: `${merged.name} was updated.`,
                  });
                }
              } catch (cause) {
                setSaveError(cause instanceof Error ? cause.message : "Provider could not be saved.");
              } finally {
                setSaving(false);
              }
            }}
          />
          {existing && (
            <button
              onClick={async () => {
                await deleteProvider(existing.id);
                closeModal();
              }}
              className="ml-auto flex items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-rust hover:border-rust"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
