"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { DEFAULT_FUSION_CONFIG, newAgentId } from "@daimon-os/shared";
import type { AgentDefinition, FusionConfig } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, Hint, NumberInput, SaveButton, Select, TextArea, TextInput } from "../sidebar/fields";
import { SearchableChecklist } from "../sidebar/SearchableChecklist";
import { Modal } from "./Modal";
import {
  buildAgentToolOptions,
  selectedAgentToolValues,
  selectionToAgentTools,
} from "@/lib/agentToolCatalog";

export function AgentModal({ id }: { id?: string }) {
  const agents = useConfigStore((s) => s.agents);
  const providers = useConfigStore((s) => s.providers);
  const skills = useConfigStore((s) => s.skills);
  const mcpServers = useConfigStore((s) => s.mcpServers);
  const secrets = useConfigStore((s) => s.secrets);
  const saveAgent = useConfigStore((s) => s.saveAgent);
  const deleteAgent = useConfigStore((s) => s.deleteAgent);
  const closeModal = useUiStore((s) => s.closeModal);
  const pushModal = useUiStore((s) => s.pushModal);
  const patchTop = useUiStore((s) => s.patchTop);
  // ModalHost renders only the top-of-stack modal, so pushing a child (e.g.
  // Fusion runs) unmounts this editor and would discard local draft state.
  // We stash the draft on the agent ModalSpec (the same persistence pattern
  // ConfigurationModal uses for its active tab) so it survives the unmount and
  // is restored when the child pops back. `draft` isn't on the ModalSpec union,
  // so we read it with a local cast — patchTop already accepts arbitrary keys.
  const stashedDraft = useUiStore(
    (s) => (s.modal?.type === "agent" ? (s.modal as { draft?: AgentDefinition }).draft : undefined),
  );

  const existing = agents.find((a) => a.id === id);
  const now = new Date().toISOString();
  const [draft, setDraft] = useState<AgentDefinition>(
    stashedDraft ??
      existing ?? {
        id: newAgentId(),
        name: "",
        providerId: providers[0]?.id ?? ("" as AgentDefinition["providerId"]),
        systemPrompt: "You are a helpful agent.",
        tools: [{ name: "bash", kind: "shell", enabled: true }],
        isolation: "cli", // new agents run the provider's real CLI by default
        permissionMode: "supervised",
        autoApproveReview: false,
        limits: { maxRuntimeMs: 30 * 60 * 1000 },
        createdAt: now,
        updatedAt: now,
      },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const patch = (p: Partial<AgentDefinition>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    // mirror the draft onto the modal stack so a pushed child modal can pop
    // back to this editor with the in-progress edits intact
    patchTop({ draft: next });
  };

  const provider = providers.find((p) => p.id === draft.providerId);
  const toolOptions = buildAgentToolOptions(provider?.kind, draft.tools, mcpServers);
  const selectedToolValues = selectedAgentToolValues(
    draft.tools,
    draft.mcpServerIds ?? [],
    toolOptions,
  );

  // model options for THIS agent's provider; "" = inherit the provider default.
  // a cheaper model here (e.g. a worker on haiku/sonnet) cuts cost vs. the lead.
  const modelOptions = [
    {
      value: "",
      label: `(provider default${provider?.defaultModel ? ` — ${provider.defaultModel}` : ""})`,
    },
    ...(provider?.models ?? []).map((m) => ({ value: m.id, label: m.label || m.id })),
  ];

  // ----- Fusion capability -----
  // other agents are eligible for panel/judge (never this agent itself)
  const otherAgents = agents.filter((a) => a.id !== draft.id);
  const fusionEnabled = draft.fusionEnabled ?? false;
  const fc = draft.fusionConfig;

  const setFusionEnabled = (on: boolean) => {
    if (on && !draft.fusionConfig) {
      // seed from defaults with an empty panel/judge the user fills in
      patch({
        fusionEnabled: true,
        fusionConfig: { ...DEFAULT_FUSION_CONFIG, panelAgentIds: [], judgeAgentId: "" as FusionConfig["judgeAgentId"] },
      });
    } else {
      patch({ fusionEnabled: on });
    }
  };
  const patchFusion = (p: Partial<FusionConfig>) => {
    const base: FusionConfig =
      draft.fusionConfig ?? {
        ...DEFAULT_FUSION_CONFIG,
        panelAgentIds: [],
        judgeAgentId: "" as FusionConfig["judgeAgentId"],
      };
    patch({ fusionConfig: { ...base, ...p } });
  };
  const togglePanelAgent = (agentId: FusionConfig["panelAgentIds"][number], on: boolean) => {
    const cur = fc?.panelAgentIds ?? [];
    patchFusion({
      panelAgentIds: on ? [...cur, agentId] : cur.filter((x) => x !== agentId),
    });
  };

  // client-side validation (mirrors the server's 400 conditions)
  const fusionErrors: string[] = [];
  if (fusionEnabled) {
    const panel = fc?.panelAgentIds ?? [];
    if (panel.length < 1 || panel.length > 8) fusionErrors.push("Select 1–8 panel agents.");
    if (new Set(panel).size !== panel.length) fusionErrors.push("Panel has duplicate agents.");
    if (panel.includes(draft.id as FusionConfig["panelAgentIds"][number]))
      fusionErrors.push("An agent cannot be on its own panel.");
    if (!fc?.judgeAgentId) fusionErrors.push("A judge agent is required.");
    if (fc?.judgeAgentId === draft.id) fusionErrors.push("An agent cannot judge itself.");
  }
  const fusionInvalid = fusionEnabled && fusionErrors.length > 0;

  const panelPreview = (fc?.panelAgentIds ?? [])
    .map((aid) => agents.find((a) => a.id === aid)?.name ?? aid)
    .join(", ");
  const judgePreview = fc?.judgeAgentId
    ? agents.find((a) => a.id === fc.judgeAgentId)?.name ?? fc.judgeAgentId
    : "—";
  const contextPreview = fc
    ? [
        fc.includeTeamContext && "team",
        fc.includeProjectMemory && "project memory",
        fc.includeConversationContext && "conversation",
        fc.includeAgentMemory && "agent memory",
        fc.includeFilesContext && "files",
      ]
        .filter(Boolean)
        .join(", ") || "none"
    : "none";

  return (
    <Modal title={existing ? `Agent — ${existing.name}` : "New agent"} wide>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput value={draft.name} placeholder="e.g. Kim" onChange={(name) => patch({ name })} />
          </Field>
          <Field label="Provider">
            <Select
              value={draft.providerId}
              options={providers.map((p) => ({ value: p.id, label: p.name }))}
              // clear the model override too — a model id from the old provider is
              // invalid for the new one and would be sent to the CLI on spawn
              onChange={(v) =>
                patch({ providerId: v as AgentDefinition["providerId"], model: undefined })
              }
            />
          </Field>
        </div>
        <Field label="Model (override — leave on default to inherit the provider)">
          <Select
            value={draft.model ?? ""}
            options={modelOptions}
            onChange={(v) => patch({ model: v || undefined })}
          />
        </Field>
        <p className="-mt-1 text-[10px] leading-relaxed text-faint">
          Choose from the selected provider&apos;s discovered catalog. Empty tracks the provider&apos;s
          current default without pinning a model name in Daimon.
        </p>
        <Field label="Description / role">
          <TextInput
            value={draft.description ?? ""}
            placeholder="e.g. Software Engineer"
            onChange={(description) => patch({ description })}
          />
        </Field>
        <Field label="System prompt">
          <TextArea value={draft.systemPrompt} rows={4} onChange={(systemPrompt) => patch({ systemPrompt })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-soft">Tools</span>
            <SearchableChecklist
              options={toolOptions}
              selected={selectedToolValues}
              searchPlaceholder="Search provider tools and MCP connections…"
              placeholder="Select tools"
              onChange={(values) => patch(selectionToAgentTools(values, toolOptions))}
            />
            <span className="text-[9px] leading-relaxed text-faint">
              MCP selections attach real connections. Provider tools describe the agent&apos;s intended
              capabilities; CLI approvals and Docker policy remain the enforcement boundary.
            </span>
          </div>
          <Field label="Runtime">
            <Select
              value={draft.isolation}
              options={[
                { value: "cli", label: "cli — real provider CLI (Claude Code/Codex/…)" },
                { value: "mock", label: "mock — demo loop" },
                { value: "docker", label: "docker — containerized" },
              ]}
              onChange={(v) => patch({ isolation: v as AgentDefinition["isolation"] })}
            />
          </Field>
        </div>
        {draft.isolation === "docker" && (
          <Field label="Docker image">
            <TextInput
              value={draft.dockerImage ?? ""}
              placeholder="e.g. daimon-runner:latest"
              onChange={(dockerImage) => patch({ dockerImage })}
            />
          </Field>
        )}
        {draft.isolation === "cli" && (
          <Field label="CLI permissions">
            <Select
              value={draft.permissionMode ?? "supervised"}
              options={[
                { value: "supervised", label: "supervised — explicitly trusted host CLI" },
                { value: "sandboxed", label: "sandboxed — requires Docker isolation" },
                { value: "unattended", label: "unattended — requires Docker isolation" },
              ]}
              onChange={(v) => patch({ permissionMode: v as AgentDefinition["permissionMode"] })}
            />
            {(draft.permissionMode ?? "supervised") !== "supervised" && (
              <Hint>
                Host provider CLIs are never presented as sandboxed. Select Docker isolation for
                sandboxed or unattended execution.
              </Hint>
            )}
          </Field>
        )}
        <label className="flex items-start gap-2 text-xs text-soft">
          <input
            type="checkbox"
            checked={draft.autoApproveReview === true}
            onChange={(e) => patch({ autoApproveReview: e.target.checked })}
            className="mt-0.5 accent-amber"
          />
          <span>
            <span className="text-text">Auto-approve reviews</span>
            <span className="block text-[11px] leading-relaxed text-faint">
              Off (default): completed work stops in “Waiting for Review”. Enable only when this
              agent&apos;s work may safely unblock dependent tasks without a human decision.
            </span>
          </span>
        </label>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-soft">Skills</span>
          {skills.length === 0 && <span className="text-[11px] text-faint">none yet — create one in the sidebar</span>}
          <div className="flex max-h-36 flex-col gap-1 overflow-y-auto">
            {skills.map((sk) => (
              <label key={sk.id} className="flex items-center gap-2 text-soft">
                <input
                  type="checkbox"
                  checked={(draft.skillIds ?? []).includes(sk.id)}
                  onChange={(e) =>
                    patch({
                      skillIds: e.target.checked
                        ? [...(draft.skillIds ?? []), sk.id]
                        : (draft.skillIds ?? []).filter((x) => x !== sk.id),
                    })
                  }
                  className="accent-amber"
                />
                {sk.name}
              </label>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-soft">Secrets this agent needs</span>
          <span className="text-[10px] leading-relaxed text-faint">
            A secret reaches a run only when both this agent and the selected project allow it.
          </span>
          {secrets.length === 0 ? (
            <span className="text-[11px] text-faint">none configured</span>
          ) : (
            <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded border border-line bg-raised p-2">
              {secrets.map((secret) => (
                <label key={secret.id} className="flex items-center gap-2 text-soft">
                  <input
                    type="checkbox"
                    checked={(draft.secretIds ?? []).includes(secret.id)}
                    onChange={(event) => patch({
                      secretIds: event.target.checked
                        ? [...(draft.secretIds ?? []), secret.id]
                        : (draft.secretIds ?? []).filter((secretId) => secretId !== secret.id),
                    })}
                    className="accent-amber"
                  />
                  <span className="font-mono text-[11px]">{secret.key}</span>
                  {secret.maskedValue && (
                    <span className="ml-auto text-[10px] text-faint">{secret.maskedValue}</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
        {/* ---------- Fusion capability ---------- */}
        <div className="mt-1 flex flex-col gap-3 rounded border border-line bg-raised/40 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-text">Fusion Capability</div>
              <p className="mt-0.5 text-[10px] leading-relaxed text-faint">
                When this agent is called during team execution, it can consult a configured panel
                of agents before responding.
              </p>
            </div>
            <label className="flex flex-none items-center gap-2 text-xs text-soft">
              <input
                type="checkbox"
                checked={fusionEnabled}
                onChange={(e) => setFusionEnabled(e.target.checked)}
                className="accent-amber"
              />
              Enable
            </label>
          </div>

          {fusionEnabled && fc && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1 text-xs">
                  <span className="text-soft">Panel Agents (1–8)</span>
                  {otherAgents.length === 0 && (
                    <span className="text-[11px] text-faint">no other agents available</span>
                  )}
                  <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                    {otherAgents.map((a) => (
                      <label key={a.id} className="flex items-center gap-2 text-soft">
                        <input
                          type="checkbox"
                          checked={fc.panelAgentIds.includes(a.id)}
                          onChange={(e) => togglePanelAgent(a.id, e.target.checked)}
                          className="accent-amber"
                        />
                        {a.name}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <Field label="Judge Agent">
                    <Select
                      value={fc.judgeAgentId}
                      options={[
                        { value: "", label: "— select judge —" },
                        ...otherAgents.map((a) => ({ value: a.id, label: a.name })),
                      ]}
                      onChange={(v) =>
                        patchFusion({ judgeAgentId: v as FusionConfig["judgeAgentId"] })
                      }
                    />
                  </Field>
                  <div className="flex flex-col gap-1 text-xs">
                    <span className="text-soft">Context Included</span>
                    {(
                      [
                        ["includeTeamContext", "Team context"],
                        ["includeProjectMemory", "Project memory"],
                        ["includeConversationContext", "Conversation context"],
                        ["includeAgentMemory", "Agent memory"],
                        ["includeFilesContext", "Files context"],
                      ] as Array<[keyof FusionConfig, string]>
                    ).map(([key, label]) => (
                      <label key={key} className="flex items-center gap-2 text-soft">
                        <input
                          type="checkbox"
                          checked={fc[key] as boolean}
                          onChange={(e) => patchFusion({ [key]: e.target.checked } as Partial<FusionConfig>)}
                          className="accent-amber"
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <Field label="Timeout (s)">
                  <NumberInput
                    value={fc.timeoutSeconds}
                    min={1}
                    onChange={(timeoutSeconds) => patchFusion({ timeoutSeconds })}
                  />
                </Field>
                <Field label="Max tool calls / agent">
                  <NumberInput
                    value={fc.maxToolCallsPerAgent}
                    min={1}
                    onChange={(maxToolCallsPerAgent) => patchFusion({ maxToolCallsPerAgent })}
                  />
                </Field>
                <Field label="Max output tokens (blank = none)">
                  <TextInput
                    value={fc.maxOutputTokens === null ? "" : String(fc.maxOutputTokens)}
                    placeholder="unlimited"
                    onChange={(v) => {
                      const t = v.trim();
                      patchFusion({ maxOutputTokens: t === "" ? null : Number(t) });
                    }}
                  />
                </Field>
              </div>

              <div className="rounded border border-line bg-ink/40 px-2 py-1.5 text-[10px] leading-relaxed text-soft">
                <span className="text-faint">Panel:</span> {panelPreview || "—"}{" "}
                <span className="text-faint">· Judge:</span> {judgePreview}{" "}
                <span className="text-faint">· Context:</span> {contextPreview}
              </div>

              {fusionErrors.length > 0 && (
                <ul className="flex flex-col gap-0.5 text-[10px] text-rust">
                  {fusionErrors.map((e) => (
                    <li key={e}>• {e}</li>
                  ))}
                </ul>
              )}

              {existing && (
                <button
                  type="button"
                  onClick={() => pushModal({ type: "fusion-runs", agentId: existing.id })}
                  className="self-start text-[11px] text-sky hover:underline"
                >
                  View Fusion runs →
                </button>
              )}
            </div>
          )}
          {fusionEnabled && !existing && (
            <Hint>Save this agent first to view its fusion runs.</Hint>
          )}
        </div>

        <div className="flex items-center gap-2">
          <SaveButton
            saving={saving}
            disabled={fusionInvalid}
            onClick={async () => {
              setSaving(true);
              setSaveError(null);
              try {
                const updatedAt = new Date().toISOString();
                await saveAgent({ ...draft, updatedAt });
                // persist fusion via the dedicated endpoint (single source of truth for
                // fusion validation). The server accepts the disable case without a 400;
                // a failure here surfaces inline rather than stranding the saved agent.
                await api.fusion.saveConfig(draft.id, {
                  fusionEnabled,
                  fusionConfig: fusionEnabled ? (draft.fusionConfig ?? null) : null,
                });
                closeModal();
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : "save failed");
              } finally {
                setSaving(false);
              }
            }}
          />
          {existing && (
            <button
              onClick={async () => {
                await deleteAgent(existing.id);
                closeModal();
              }}
              className="ml-auto flex items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-rust hover:border-rust"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
        {saveError && <p className="text-[11px] text-rust">{saveError}</p>}
      </div>
    </Modal>
  );
}
