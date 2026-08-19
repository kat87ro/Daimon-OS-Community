"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Plug, Server, Sparkles, XCircle } from "lucide-react";
import { PROVIDER_PRESETS, newProviderId, providerKindSchema } from "@daimon-os/shared";
import type { ProviderConfig, ProviderKind } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, Hint, Select, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

const LAUNCH_CLI_KINDS: ProviderKind[] = ["claude", "gemini", "codex", "ollama", "lmstudio"];
const LOCAL_KINDS: ProviderKind[] = ["ollama", "lmstudio"];

/** live gateway port injected by the desktop preload (undefined in plain web) */
function liveGatewayPort(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const p = (window as unknown as { __DAIMON_PORT__?: number | null }).__DAIMON_PORT__;
  return typeof p === "number" && p > 0 ? p : undefined;
}

function fromPreset(kind: ProviderKind): ProviderConfig {
  const preset = PROVIDER_PRESETS[kind];
  const id = newProviderId();
  return {
    id,
    name: preset.label,
    kind,
    mode: preset.mode,
    apiFormat: preset.apiFormat,
    baseUrl: preset.baseUrl,
    apiKeyRef: `key-${id}`,
    defaultModel: preset.defaultModel,
    models: [],
    enabled: true,
  };
}

type TestState = { status: "idle" | "running" | "ok" | "fail"; detail?: string };

const STEPS = ["Connection", "Provider", "Done"] as const;

/**
 * First-run Setup Wizard — provider-agnostic onboarding. Walks the user through
 * (1) confirming the gateway connection / port, (2) adding + TESTING at least one
 * provider, (3) finishing (marks settings.onboarded so it never re-nags). Opened
 * automatically from the Dashboard on a fresh/empty install; also skippable.
 */
export function SetupWizardModal() {
  const providers = useConfigStore((s) => s.providers);
  const settings = useConfigStore((s) => s.settings);
  const saveProvider = useConfigStore((s) => s.saveProvider);
  const saveSettings = useConfigStore((s) => s.saveSettings);
  const closeAll = useUiStore((s) => s.closeAll);

  const [step, setStep] = useState(0);

  // --- step 1: connection ---
  const livePort = liveGatewayPort();
  const [conn, setConn] = useState<TestState>({ status: "idle" });

  // --- step 2: provider draft ---
  const [draft, setDraft] = useState<ProviderConfig>(() => fromPreset("claude"));
  const [apiKey, setApiKey] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [savingProvider, setSavingProvider] = useState(false);
  const preset = PROVIDER_PRESETS[draft.kind];
  const isCli = draft.mode === "cli" && LAUNCH_CLI_KINDS.includes(draft.kind);
  const isLocal = LOCAL_KINDS.includes(draft.kind);

  const patch = (p: Partial<ProviderConfig>) => {
    setDraft({ ...draft, ...p });
    setTest({ status: "idle" });
  };

  async function finish() {
    // mark onboarded so the wizard never re-opens (even if no provider was added)
    if (settings) await saveSettings({ ...settings, onboarded: true });
    closeAll();
  }

  return (
    <Modal title="Welcome to Daimon OS — Setup">
      <div className="flex flex-col gap-4">
        {/* step indicator */}
        <ol className="flex items-center gap-2 text-[11px]">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full border text-[10px] ${
                  i === step
                    ? "border-amber bg-amber/20 text-amber"
                    : i < step
                      ? "border-mint bg-mint/20 text-mint"
                      : "border-line text-faint"
                }`}
              >
                {i < step ? "✓" : i + 1}
              </span>
              <span className={i === step ? "text-text" : "text-faint"}>{label}</span>
              {i < STEPS.length - 1 && <span className="text-faint">→</span>}
            </li>
          ))}
        </ol>

        {/* ── Step 1: Connection ─────────────────────────────────────────────── */}
        {step === 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-text">
              <Server size={15} className="text-sky" /> Gateway connection
            </div>
            <p className="text-xs leading-relaxed text-soft">
              Daimon runs a local gateway on <code>127.0.0.1</code> that drives every agent.
              {livePort !== undefined
                ? ` It's live on port ${livePort}.`
                : " The desktop app picks a free port automatically."}{" "}
              Test it below before continuing.
            </p>
            <button
              onClick={async () => {
                setConn({ status: "running" });
                try {
                  const h = await api.health();
                  setConn(
                    h.ok
                      ? { status: "ok", detail: `Gateway responding${livePort ? ` on ${livePort}` : ""}.` }
                      : { status: "fail", detail: "Gateway did not return ok." },
                  );
                } catch (e) {
                  setConn({ status: "fail", detail: e instanceof Error ? e.message : String(e) });
                }
              }}
              className="flex w-fit items-center gap-1.5 rounded border border-line px-3 py-1.5 text-xs text-soft hover:border-sky hover:text-sky"
            >
              <Plug size={12} /> Test connection
            </button>
            <TestRow state={conn} />
            <Hint>
              The gateway port is auto-assigned. To pin a fixed port (e.g. for external tools),
              set it later in Configuration → Orchestrator → Gateway port (needs a restart).
            </Hint>
          </div>
        )}

        {/* ── Step 2: Provider ───────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-text">
              <Plug size={15} className="text-amber" /> Add a provider
            </div>
            {providers.length > 0 && (
              <p className="flex items-center gap-1.5 text-[11px] text-mint">
                <CheckCircle2 size={12} /> {providers.length} provider
                {providers.length === 1 ? "" : "s"} configured:{" "}
                {providers.map((p) => p.name).join(", ")}
              </p>
            )}
            <Field label="Kind">
              <Select
                value={draft.kind}
                options={providerKindSchema.options.filter((k) => LAUNCH_CLI_KINDS.includes(k)).map((k) => ({
                  value: k,
                  label: PROVIDER_PRESETS[k].label,
                }))}
                onChange={(v) => {
                  setDraft(fromPreset(v as ProviderKind));
                  setApiKey("");
                  setTest({ status: "idle" });
                }}
              />
            </Field>
            <Field label="Name">
              <TextInput value={draft.name} onChange={(name) => patch({ name })} />
            </Field>

            {!isCli && (
              <Field label="Base URL">
                <TextInput
                  value={draft.baseUrl ?? ""}
                  placeholder={preset.baseUrl ?? "https://api.example.com/v1"}
                  onChange={(baseUrl) => patch({ baseUrl: baseUrl || undefined })}
                />
              </Field>
            )}

            {isCli && !isLocal && (
              <Hint>
                cli mode launches the verified <code>{draft.kind}</code> executable from PATH using your
                existing subscription login — make sure that CLI is installed and logged in.
              </Hint>
            )}
            {isLocal && (
              <Hint>
                Start {draft.kind === "ollama" ? "Ollama" : "LM Studio's local server"} at <code>{draft.baseUrl}</code>.
                Daimon uses the installed Codex CLI for the tool-capable agent loop, but does not
                link your OpenAI credential into this local run. Testing discovers local models.
              </Hint>
            )}
            {isCli && (
              <Field label={isLocal ? "Local model" : "Default model"}>
                <Select
                  value={draft.models.some((model) => model.id === draft.defaultModel) ? draft.defaultModel : ""}
                  options={isLocal
                    ? (draft.models.length > 0
                        ? draft.models.map((model) => ({ value: model.id, label: model.label }))
                        : [{ value: "", label: "Discover models first" }])
                    : [
                        { value: "", label: "Provider default (recommended)" },
                        ...draft.models.map((model) => ({ value: model.id, label: model.label })),
                      ]}
                  onChange={(defaultModel) => patch({ defaultModel })}
                />
              </Field>
            )}
            {!isLocal && (
              <Field label="Exact custom model id (optional)">
                <TextInput
                  value={draft.defaultModel}
                  placeholder="Leave empty to track the provider default"
                  onChange={(defaultModel) => patch({ defaultModel })}
                />
              </Field>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={async () => {
                  setTest({ status: "running" });
                  try {
                    const r = await api.providers.test({
                      kind: draft.kind,
                      mode: draft.mode,
                      baseUrl: draft.baseUrl,
                      apiFormat: draft.apiFormat,
                      apiKey: apiKey || undefined,
                    });
                    if (r.ok) {
                      const ids = r.models.map((model) => model.id);
                      setDraft((current) => ({
                        ...current,
                        defaultModel: ids.includes(current.defaultModel)
                          ? current.defaultModel
                          : isLocal
                            ? (ids[0] ?? "")
                            : current.defaultModel,
                        models: r.models,
                      }));
                    }
                    setTest({ status: r.ok ? "ok" : "fail", detail: r.detail });
                  } catch (e) {
                    setTest({ status: "fail", detail: e instanceof Error ? e.message : String(e) });
                  }
                }}
                className="flex items-center gap-1.5 rounded border border-line px-3 py-1.5 text-xs text-soft hover:border-sky hover:text-sky"
              >
                <Plug size={12} /> Test &amp; discover models
              </button>
              <button
                disabled={savingProvider}
                onClick={async () => {
                  setSavingProvider(true);
                  try {
                    await saveProvider(draft, apiKey || undefined);
                    // reset the form for an optional second provider
                    setDraft(fromPreset(draft.kind));
                    setApiKey("");
                    setTest({ status: "idle" });
                  } finally {
                    setSavingProvider(false);
                  }
                }}
                className="flex items-center gap-1.5 rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber disabled:opacity-50"
              >
                {savingProvider ? "Adding…" : "Add provider"}
              </button>
            </div>
            <TestRow state={test} />
          </div>
        )}

        {/* ── Step 3: Done ───────────────────────────────────────────────────── */}
        {step === 2 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-text">
              <Sparkles size={15} className="text-mint" /> You're set up
            </div>
            <p className="text-xs leading-relaxed text-soft">
              {providers.length > 0
                ? `${providers.length} provider${providers.length === 1 ? "" : "s"} ready. `
                : "No provider added yet — you can add one anytime from the sidebar. "}
              Next: create <b>Agents</b> (pick a provider), group them into a <b>Team</b> with a
              Lead, then make a <b>Project</b> with a goal and hit <b>Start work</b>. The Lead
              breaks the goal into tasks and delegates to the team — works with any of your CLI
              providers, not just Claude.
            </p>
            <Hint>You can reopen this later, or reset everything from Configuration → Orchestrator.</Hint>
          </div>
        )}

        {/* ── Footer nav ─────────────────────────────────────────────────────── */}
        <div className="flex items-center gap-2 border-t border-line pt-3">
          {step > 0 && (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="rounded border border-line px-3 py-1.5 text-xs text-soft hover:border-amber"
            >
              Back
            </button>
          )}
          <button
            onClick={() => void finish()}
            className="ml-auto rounded px-3 py-1.5 text-xs text-faint hover:text-soft"
          >
            Skip setup
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              className="rounded border border-line bg-raised px-3 py-1.5 text-xs text-white hover:border-amber"
            >
              {step === 1 && providers.length === 0 ? "Skip for now →" : "Next →"}
            </button>
          ) : (
            <button
              onClick={() => void finish()}
              className="rounded border border-mint bg-mint/20 px-3 py-1.5 text-xs text-mint hover:bg-mint/30"
            >
              Finish
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** small inline test-result row (idle/spinner/ok/fail) */
function TestRow({ state }: { state: TestState }) {
  if (state.status === "idle") return null;
  if (state.status === "running") {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-soft">
        <Loader2 size={12} className="animate-spin" /> Testing…
      </p>
    );
  }
  const ok = state.status === "ok";
  return (
    <p className={`flex items-start gap-1.5 text-[11px] ${ok ? "text-mint" : "text-rust"}`}>
      {ok ? <CheckCircle2 size={12} className="mt-0.5 flex-none" /> : <XCircle size={12} className="mt-0.5 flex-none" />}
      <span>{state.detail}</span>
    </p>
  );
}
