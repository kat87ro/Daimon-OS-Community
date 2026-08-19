"use client";

import { useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { newProjectId, newUuid } from "@daimon-os/shared";
import type { Project } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, Hint, NumberInput, SaveButton, Select, TextArea, TextInput } from "../sidebar/fields";
import { deriveTitle } from "./GoalModal";
import { Modal } from "./Modal";

export function ProjectModal({ id, parentProjectId }: { id?: string; parentProjectId?: string }) {
  const projects = useConfigStore((s) => s.projects);
  const teams = useConfigStore((s) => s.teams);
  const goals = useConfigStore((s) => s.goals);
  const secrets = useConfigStore((s) => s.secrets);
  const blueprints = useConfigStore((s) => s.blueprints);
  const saveProject = useConfigStore((s) => s.saveProject);
  const deleteProject = useConfigStore((s) => s.deleteProject);
  const saveGoal = useConfigStore((s) => s.saveGoal);
  const deleteGoal = useConfigStore((s) => s.deleteGoal);
  const closeModal = useUiStore((s) => s.closeModal);
  const pushModal = useUiStore((s) => s.pushModal);
  const patchTop = useUiStore((s) => s.patchTop);
  // ModalHost renders only the top-of-stack modal, so pushing a child (e.g.
  // the goal editor) unmounts this editor and would discard local draft state.
  // We stash the draft on the project ModalSpec (the same persistence pattern
  // AgentModal uses) so it survives the unmount and is restored when the child
  // pops back. `draft` isn't on the ModalSpec union, so we read it with a local
  // cast — patchTop already accepts arbitrary keys.
  const stashedDraft = useUiStore(
    (s) => (s.modal?.type === "project" ? (s.modal as { draft?: Project }).draft : undefined),
  );
  const [newGoal, setNewGoal] = useState("");
  const [initialGoal, setInitialGoal] = useState("");
  const [blueprintId, setBlueprintId] = useState("");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState<string | null>(null);

  const existing = projects.find((p) => p.id === id);
  const parent = projects.find((p) => p.id === (existing?.parentProjectId ?? parentProjectId));
  const isFeatureProject = Boolean(parent);
  const [draft, setDraft] = useState<Project>(
    stashedDraft ??
      existing ?? {
        id: newProjectId(),
        name: "",
        path: parent?.path ?? "",
        parentProjectId: parent?.id,
        createdAt: new Date().toISOString(),
      },
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const patch = (p: Partial<Project>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    // mirror the draft onto the modal stack so a pushed child modal can pop
    // back to this editor with the in-progress edits intact
    patchTop({ draft: next });
  };

  async function pickFolder() {
    setPicking(true);
    setError(null);
    try {
      const res = await api.fs.pickFolder();
      if (res.path) patch({ path: res.path });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open the folder picker");
    } finally {
      setPicking(false);
    }
  }

  return (
    <Modal
      title={
        existing
          ? `${existing.parentProjectId ? "Feature" : "Project"} — ${existing.name}`
          : isFeatureProject
            ? `New feature under ${parent?.name ?? "project"}`
            : "New project"
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput
            value={draft.name}
            placeholder="e.g. Codex playground"
            onChange={(name) => patch({ name })}
          />
        </Field>
        <Field
          label={
            isFeatureProject
              ? "Git workspace inherited from the root project"
              : "Folder path (cwd for every terminal in this project)"
          }
        >
          <div className="flex gap-2">
            <div className="flex-1">
              <TextInput
                value={draft.path}
                placeholder="/Users/you/Projects/my-app"
                disabled={isFeatureProject}
                onChange={(path) => patch({ path })}
              />
            </div>
            {!isFeatureProject && (
              <button
                onClick={() => void pickFolder()}
                disabled={picking}
                className="flex flex-none items-center gap-1.5 rounded border border-line px-3 text-xs text-soft hover:border-amber hover:text-amber disabled:opacity-50"
              >
                <FolderOpen size={13} /> {picking ? "Opening…" : "Browse"}
              </button>
            )}
          </div>
          <Hint>
            {isFeatureProject
              ? "Feature projects have independent goals, tasks, sessions, budget and Lead, but cannot escape the root project's approved Git checkout."
              : "Opens your system folder picker (Finder / File Explorer) to choose the folder."}
          </Hint>
        </Field>
        <Field label="Attached team (optional)">
          <Select
            value={draft.teamId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...teams.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(v) => patch({ teamId: (v || undefined) as Project["teamId"] })}
          />
        </Field>
        <Field label="Secrets this project's agents can use (injected as env vars)">
          {secrets.length === 0 ? (
            <p className="text-[11px] text-faint">
              No secrets yet — add them in the Secrets section of the sidebar.
            </p>
          ) : (
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded border border-line bg-raised p-2">
              {secrets.map((sec) => {
                const on = draft.secretIds?.includes(sec.id) ?? false;
                return (
                  <label key={sec.id} className="flex items-center gap-2 text-xs text-soft">
                    <input
                      type="checkbox"
                      checked={on}
                      className="accent-amber"
                      onChange={(e) => {
                        const set = new Set(draft.secretIds ?? []);
                        if (e.target.checked) set.add(sec.id);
                        else set.delete(sec.id);
                        patch({ secretIds: [...set] });
                      }}
                    />
                    <span className="font-mono text-[11px]">{sec.key}</span>
                    {sec.group && <span className="text-faint">· {sec.group}</span>}
                    {sec.maskedValue && (
                      <span className="ml-auto font-mono text-[10px] text-faint">{sec.maskedValue}</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </Field>
        <Field label="Budget (USD, optional) — pauses workers when spend reaches it">
          <NumberInput
            value={draft.budgetUsd ?? 0}
            min={0}
            onChange={(v) => patch({ budgetUsd: v > 0 ? v : undefined })}
          />
        </Field>
        <Hint>
          Total measured spend across this project&apos;s runs. At the cap, running
          workers are paused (SIGSTOP) and a Work Log alert fires — resume from the
          pane header. 0 = no cap. Providers that cannot report cost are blocked
          from unattended execution rather than silently bypassing the cap.
        </Hint>
        {!existing && (
          <Field label="Initial goal — the Lead works from this">
            <TextArea
              value={initialGoal}
              rows={10}
              placeholder="Describe the goal in full — scope, requirements, constraints, examples, links. As long and detailed as you want. After creating, click the goal chip to edit it or attach files/images."
              onChange={setInitialGoal}
            />
          </Field>
        )}
        {existing && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-soft">Goals</span>
            {goals
              .filter((g) => g.projectId === existing.id)
              .map((g) => (
                <div key={g.id} className="flex items-center gap-2 text-xs">
                  <select
                    value={g.status}
                    onChange={(e) =>
                      void saveGoal({ ...g, status: e.target.value as typeof g.status })
                    }
                    className="rounded border border-line bg-raised px-1 py-0.5 text-[11px] text-soft"
                  >
                    <option value="open">open</option>
                    <option value="active">active</option>
                    <option value="done">done</option>
                  </select>
                  <button
                    onClick={() => pushModal({ type: "goal", projectId: existing.id, id: g.id })}
                    className="flex-1 truncate text-left text-soft hover:text-amber"
                    title="Open goal — details & attachments"
                  >
                    {g.title}
                    {(g.attachments?.length ?? 0) > 0 && (
                      <span className="ml-1 text-faint">📎{g.attachments!.length}</span>
                    )}
                  </button>
                  <button
                    onClick={() => {
                      if (!window.confirm(`Delete goal "${g.title}"? This cannot be undone.`)) return;
                      void deleteGoal(g.id).catch(() => {});
                    }}
                    className="text-faint hover:text-rust"
                    title="Delete goal"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            <div className="flex gap-2">
              <input
                value={newGoal}
                onChange={(e) => setNewGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newGoal.trim()) {
                    void saveGoal({
                      id: newUuid(),
                      projectId: existing.id,
                      title: newGoal.trim(),
                      status: "open",
                      createdAt: new Date().toISOString(),
                    });
                    setNewGoal("");
                  }
                }}
                placeholder="new goal — Enter to add"
                className="w-full rounded border border-line bg-raised px-2 py-1 text-xs outline-none placeholder:text-faint focus:border-amber"
              />
            </div>
          </div>
        )}
        {existing && (
          <Field label="Start from blueprint — instantiates its task-DAG onto this project">
            <div className="flex gap-2">
              <div className="flex-1">
                <Select
                  value={blueprintId}
                  options={[
                    { value: "", label: blueprints.length ? "— select a blueprint —" : "— no blueprints yet —" },
                    ...blueprints.map((b) => ({ value: b.id, label: b.name })),
                  ]}
                  onChange={(v) => {
                    setBlueprintId(v);
                    setRunMsg(null);
                  }}
                />
              </div>
              <button
                disabled={!blueprintId || running}
                onClick={async () => {
                  setRunning(true);
                  setRunMsg(null);
                  try {
                    const tasks = await api.projects.instantiate(existing.id, blueprintId);
                    setRunMsg(`Created ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`);
                  } catch (e) {
                    setRunMsg(e instanceof Error ? e.message : "instantiate failed");
                  } finally {
                    setRunning(false);
                  }
                }}
                className="flex-none rounded border border-line px-3 text-xs text-soft hover:border-amber hover:text-amber disabled:opacity-50"
              >
                {running ? "Running…" : "Run"}
              </button>
            </div>
            {runMsg && <p className="mt-1 text-[11px] text-faint">{runMsg}</p>}
          </Field>
        )}
        {error && <p className="text-xs text-rust">{error}</p>}
        <div className="flex items-center gap-2">
          <SaveButton
            saving={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await saveProject(draft);
                // attach the initial goal (active) to a brand-new project. The
                // full text is the DESCRIPTION (long body); the title is a short
                // derived label so chips/lists stay readable.
                if (!existing && initialGoal.trim()) {
                  await saveGoal({
                    id: newUuid(),
                    projectId: draft.id,
                    title: deriveTitle(initialGoal) || "Project goal",
                    description: initialGoal.trim(),
                    status: "active",
                    createdAt: new Date().toISOString(),
                  });
                }
                closeModal();
              } catch (e) {
                setError(e instanceof Error ? e.message : "save failed — is the path a real folder?");
              } finally {
                setSaving(false);
              }
            }}
          />
          {existing && (
            <button
              onClick={async () => {
                await deleteProject(existing.id);
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
