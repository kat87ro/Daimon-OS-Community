"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { newTeamId } from "@daimon-os/shared";
import type { Team } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, SaveButton, Select, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

export function TeamModal({ id }: { id?: string }) {
  const teams = useConfigStore((s) => s.teams);
  const agents = useConfigStore((s) => s.agents);
  const providers = useConfigStore((s) => s.providers);
  const saveTeam = useConfigStore((s) => s.saveTeam);
  const deleteTeam = useConfigStore((s) => s.deleteTeam);
  const closeModal = useUiStore((s) => s.closeModal);

  const existing = teams.find((t) => t.id === id);
  // teams belong to ONE hierarchy: new teams nest under the root by default
  const rootTeam = teams.find((t) => t.parentId === null);
  const [draft, setDraft] = useState<Team>(() => {
    if (!existing) {
      return {
        id: newTeamId(),
        name: "",
        parentId: rootTeam?.id ?? null,
        memberAgentIds: [],
        orchestrationMode: "parallel",
      };
    }
    // Sanitize on load: drop any managers entries whose key or value is no longer
    // a member — stale refs from past edits or cascade-deleted agents cause 400s.
    const memberSet = new Set<string>(existing.memberAgentIds);
    const cleanManagers = existing.managers
      ? Object.fromEntries(
          Object.entries(existing.managers).filter(
            ([m, s]) => memberSet.has(m) && memberSet.has(s),
          ),
        )
      : undefined;
    return {
      ...existing,
      managers: cleanManagers && Object.keys(cleanManagers).length
        ? (cleanManagers as Team["managers"])
        : undefined,
    };
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [memberQuery, setMemberQuery] = useState("");

  // a team cannot be its own ancestor — exclude self and descendants from parent options
  const descendants = new Set<string>();
  const collect = (tid: string) => {
    if (descendants.has(tid)) return;
    descendants.add(tid);
    teams.filter((t) => t.parentId === tid).forEach((t) => collect(t.id));
  };
  collect(draft.id);
  const parentOptions = teams.filter((t) => !descendants.has(t.id));
  const members = agents.filter((a) => draft.memberAgentIds.includes(a.id));
  const leadCandidates = members.filter((agent) => {
    const provider = providers.find((item) => item.id === agent.providerId);
    return provider?.mode === "cli" &&
      provider.enabled &&
      (["claude", "codex", "gemini"] as const).includes(
        provider.kind as "claude" | "codex" | "gemini",
      ) &&
      agent.isolation === "cli";
  });
  // the name to show inside the team: per-team alias if set, else the real name
  const nameOf = (a: { id: string; name: string }) => draft.memberNames?.[a.id] || a.name;

  return (
    <Modal title={existing ? `Team — ${existing.name}` : "New team"}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput
            value={draft.name}
            placeholder="e.g. Core delivery"
            onChange={(name) => setDraft({ ...draft, name })}
          />
        </Field>
        <Field label="Parent team">
          <Select
            value={draft.parentId ?? ""}
            options={[
              { value: "", label: "— root (no parent) —" },
              ...parentOptions.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(v) =>
              setDraft({ ...draft, parentId: (v || null) as Team["parentId"] })
            }
          />
        </Field>
        <Field label="Orchestration mode">
          <Select
            value={draft.orchestrationMode}
            options={["parallel", "sequential", "supervisor"]}
            onChange={(v) =>
              setDraft({ ...draft, orchestrationMode: v as Team["orchestrationMode"] })
            }
          />
        </Field>
        <div className="flex flex-col gap-1.5 text-xs">
          <span className="text-soft">Members</span>
          <TextInput
            value={memberQuery}
            placeholder="Search agents…"
            onChange={setMemberQuery}
          />
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto pr-1">
            {agents
              .filter((a) =>
                a.name.toLowerCase().includes(memberQuery.trim().toLowerCase()),
              )
              .map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-soft">
                  <input
                    type="checkbox"
                    checked={draft.memberAgentIds.includes(a.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setDraft({
                          ...draft,
                          memberAgentIds: [...draft.memberAgentIds, a.id],
                        });
                      } else {
                        // unchecking a member also clears its alias + all reporting
                        // edges where it appears (as subordinate key OR superior value)
                        const names = { ...(draft.memberNames ?? {}) };
                        const mgrs = { ...(draft.managers ?? {}) };
                        delete names[a.id];
                        delete mgrs[a.id]; // remove as subordinate
                        for (const k of Object.keys(mgrs)) {
                          if (mgrs[k] === a.id) delete mgrs[k]; // remove as superior
                        }
                        setDraft({
                          ...draft,
                          memberAgentIds: draft.memberAgentIds.filter((mid) => mid !== a.id),
                          memberNames: (Object.keys(names).length
                            ? names
                            : undefined) as Team["memberNames"],
                          managers: (Object.keys(mgrs).length
                            ? mgrs
                            : undefined) as Team["managers"],
                          supervisorAgentId:
                            draft.supervisorAgentId === a.id
                              ? undefined
                              : draft.supervisorAgentId,
                        });
                      }
                    }}
                    className="accent-amber"
                  />
                  {a.name}
                </label>
              ))}
            {agents.filter((a) =>
              a.name.toLowerCase().includes(memberQuery.trim().toLowerCase()),
            ).length === 0 && (
              <span className="text-[11px] text-faint">no agents match “{memberQuery}”</span>
            )}
          </div>
        </div>

        {members.length > 0 && (
          <div className="flex flex-col gap-1.5 text-xs">
            <span className="text-soft">Member names in this team (optional)</span>
            <p className="text-[10px] leading-relaxed text-faint">
              A per-team label only — it does not rename the agent elsewhere.
            </p>
            {members.map((a) => (
              <div key={a.id} className="flex items-center gap-2">
                <span className="w-28 flex-none truncate text-faint">{a.name}</span>
                <TextInput
                  value={draft.memberNames?.[a.id] ?? ""}
                  placeholder={a.name}
                  onChange={(v) => {
                    const names = { ...(draft.memberNames ?? {}) };
                    if (v.trim()) names[a.id] = v;
                    else delete names[a.id];
                    setDraft({
                      ...draft,
                      memberNames: (Object.keys(names).length
                        ? names
                        : undefined) as Team["memberNames"],
                    });
                  }}
                />
              </div>
            ))}
          </div>
        )}

        {members.length > 0 && (
          <Field label="Team lead (top of the reporting line)">
            <Select
              value={draft.supervisorAgentId ?? ""}
              options={[
                { value: "", label: "— none —" },
                ...leadCandidates.map((a) => ({ value: a.id, label: nameOf(a) })),
              ]}
              onChange={(v) =>
                setDraft({
                  ...draft,
                  supervisorAgentId: (v || undefined) as Team["supervisorAgentId"],
                  // a member who becomes lead can't also report to someone
                  managers: (v
                    ? Object.fromEntries(
                        Object.entries(draft.managers ?? {}).filter(([m]) => m !== v),
                      )
                    : draft.managers) as Team["managers"],
                })
              }
            />
            <p className="mt-1 text-[10px] leading-relaxed text-faint">
              Any enabled Claude, Codex, Gemini, Ollama-local, or LM-Studio-local agent can be the Lead when its runtime policy is compatible.
            </p>
          </Field>
        )}

        {(() => {
          // reporting line: who each member takes tasks from. The supervisor is
          // the root; everyone else reports to the supervisor unless overridden.
          const memberAgents = agents.filter((a) => draft.memberAgentIds.includes(a.id));
          const reports = memberAgents.filter((a) => a.id !== draft.supervisorAgentId);
          if (!draft.supervisorAgentId || reports.length === 0) return null;
          // descendants of `id` in the current reporting graph (to forbid cycles)
          const descendantsOf = (id: string): Set<string> => {
            const out = new Set<string>();
            const stack = reports.filter((r) => (draft.managers?.[r.id] ?? draft.supervisorAgentId) === id).map((r) => r.id);
            while (stack.length) {
              const cur = stack.pop()!;
              if (out.has(cur)) continue;
              out.add(cur);
              for (const r of reports) {
                if ((draft.managers?.[r.id] ?? draft.supervisorAgentId) === cur) stack.push(r.id);
              }
            }
            return out;
          };
          return (
            <div className="flex flex-col gap-1.5 text-xs">
              <span className="text-soft">Reporting line (who each agent takes tasks from)</span>
              {reports.map((a) => {
                const banned = descendantsOf(a.id);
                const options = memberAgents.filter((s) => s.id !== a.id && !banned.has(s.id));
                return (
                  <div key={a.id} className="flex items-center gap-2">
                    <span className="w-28 flex-none truncate text-soft">{nameOf(a)}</span>
                    <span className="text-faint">reports to</span>
                    <select
                      value={draft.managers?.[a.id] ?? draft.supervisorAgentId}
                      onChange={(e) => {
                        const v = e.target.value;
                        const next = { ...(draft.managers ?? {}) };
                        if (v === draft.supervisorAgentId) delete next[a.id];
                        else next[a.id] = v as never;
                        setDraft({ ...draft, managers: next });
                      }}
                      className="flex-1 rounded border border-line bg-raised px-1.5 py-1 text-[11px] text-soft"
                    >
                      <option value={draft.supervisorAgentId}>
                        {(() => {
                          const sup = memberAgents.find((m) => m.id === draft.supervisorAgentId);
                          return sup ? nameOf(sup) : "Lead";
                        })()}{" "}
                        (Lead)
                      </option>
                      {options
                        .filter((o) => o.id !== draft.supervisorAgentId)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {nameOf(o)}
                          </option>
                        ))}
                    </select>
                  </div>
                );
              })}
            </div>
          );
        })()}

        {saveError && (
          <p className="rounded border border-rust/40 bg-rust/10 px-2 py-1.5 text-[11px] text-rust">
            {saveError}
          </p>
        )}
        <div className="flex items-center gap-2">
          <SaveButton
            saving={saving}
            disabled={!draft.name.trim()}
            onClick={async () => {
              setSaving(true);
              setSaveError(null);
              try {
                await saveTeam(draft);
                closeModal();
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : "Save failed");
              } finally {
                setSaving(false);
              }
            }}
          />
          {existing && (
            <button
              onClick={async () => {
                await deleteTeam(existing.id);
                closeModal();
              }}
              className="ml-auto flex items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-rust hover:border-rust"
              title="Children are reparented, not deleted"
            >
              <Trash2 size={12} /> Delete
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
