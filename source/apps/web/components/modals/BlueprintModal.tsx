"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { Blueprint, BlueprintTask } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, Hint, SaveButton, Select, TextArea, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

export function BlueprintModal({ id }: { id?: string }) {
  const blueprints = useConfigStore((s) => s.blueprints);
  const teams = useConfigStore((s) => s.teams);
  const agents = useConfigStore((s) => s.agents);
  const saveBlueprint = useConfigStore((s) => s.saveBlueprint);
  const deleteBlueprint = useConfigStore((s) => s.deleteBlueprint);
  const closeModal = useUiStore((s) => s.closeModal);

  const existing = blueprints.find((b) => b.id === id);
  const now = new Date().toISOString();
  const [draft, setDraft] = useState<Blueprint>(
    existing ?? {
      id: newUuid() as Blueprint["id"],
      name: "",
      description: "",
      tasks: [],
      createdAt: now,
      updatedAt: now,
    },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function setTask(i: number, patch: Partial<BlueprintTask>) {
    setDraft({
      ...draft,
      tasks: draft.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    });
  }
  function addTask() {
    setDraft({
      ...draft,
      tasks: [
        ...draft.tasks,
        { ref: `t${draft.tasks.length + 1}`, titleTemplate: "", dependsOn: [] },
      ],
    });
  }
  function removeTask(i: number) {
    const removedRef = draft.tasks[i]?.ref;
    setDraft({
      ...draft,
      tasks: draft.tasks
        .filter((_, j) => j !== i)
        .map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== removedRef) })),
    });
  }

  const refs = draft.tasks.map((t) => t.ref.trim());
  const dupRef = refs.some((r, i) => r && refs.indexOf(r) !== i);
  const canSave =
    draft.name.trim().length > 0 &&
    draft.tasks.every((t) => t.ref.trim() && t.titleTemplate.trim()) &&
    !dupRef; // refs must be unique (mirrors the server-side schema guard)

  return (
    <Modal title={existing ? `Blueprint — ${existing.name}` : "New blueprint"}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput
            value={draft.name}
            placeholder="e.g. Weekly content pipeline"
            onChange={(name) => setDraft({ ...draft, name })}
          />
        </Field>
        <Field label="Description (optional)">
          <TextArea
            value={draft.description ?? ""}
            rows={2}
            placeholder="What this blueprint produces when instantiated onto a project"
            onChange={(description) => setDraft({ ...draft, description })}
          />
        </Field>
        <Field label="Attach team on instantiate (optional)">
          <Select
            value={draft.teamId ?? ""}
            options={[
              { value: "", label: "— none —" },
              ...teams.map((t) => ({ value: t.id, label: t.name })),
            ]}
            onChange={(v) => setDraft({ ...draft, teamId: (v || undefined) as Blueprint["teamId"] })}
          />
        </Field>
        <Field label="Goal template (optional)">
          <TextArea
            value={draft.goalTemplate ?? ""}
            rows={3}
            placeholder="Templated goal text created alongside the tasks. {goal} and {var} are substituted on instantiate."
            onChange={(goalTemplate) => setDraft({ ...draft, goalTemplate })}
          />
        </Field>
        <Hint>
          <code className="not-italic text-soft">{"{goal}"}</code> and any{" "}
          <code className="not-italic text-soft">{"{var}"}</code> in titles, descriptions, or the
          goal template are substituted from the vars passed when instantiating onto a project.
        </Hint>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-soft">Tasks (DAG)</span>
            <button
              onClick={addTask}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[11px] text-soft hover:border-amber hover:text-amber"
            >
              <Plus size={11} /> Add task
            </button>
          </div>
          {draft.tasks.length === 0 && (
            <p className="text-[11px] text-faint">No tasks yet — add at least one.</p>
          )}
          {draft.tasks.map((task, i) => (
            <div key={i} className="flex flex-col gap-2 rounded border border-line bg-raised p-2">
              <div className="flex items-start gap-2">
                <div className="w-24 flex-none">
                  <Field label="Ref">
                    <TextInput
                      value={task.ref}
                      placeholder="t1"
                      onChange={(ref) => setTask(i, { ref })}
                    />
                  </Field>
                </div>
                <div className="flex-1">
                  <Field label="Title template">
                    <TextInput
                      value={task.titleTemplate}
                      placeholder="e.g. Draft post about {goal}"
                      onChange={(titleTemplate) => setTask(i, { titleTemplate })}
                    />
                  </Field>
                </div>
                <button
                  onClick={() => removeTask(i)}
                  title="Remove task"
                  className="mt-5 flex-none p-1 text-faint hover:text-rust"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <Field label="Description template (optional)">
                <TextArea
                  value={task.descriptionTemplate ?? ""}
                  rows={2}
                  onChange={(descriptionTemplate) => setTask(i, { descriptionTemplate })}
                />
              </Field>
              <Field label="Assigned agent (optional)">
                <Select
                  value={task.assignedAgentName ?? ""}
                  options={[
                    { value: "", label: "— unassigned —" },
                    ...agents.map((a) => ({ value: a.name, label: a.name })),
                  ]}
                  onChange={(v) => setTask(i, { assignedAgentName: v || undefined })}
                />
              </Field>
              {draft.tasks.filter((_, j) => j !== i).length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-soft">Depends on</span>
                  <div className="flex flex-wrap gap-2">
                    {draft.tasks
                      .filter((_, j) => j !== i)
                      .map((other) => {
                        const on = task.dependsOn.includes(other.ref);
                        return (
                          <label key={other.ref || `idx${i}`} className="flex items-center gap-1 text-[11px] text-soft">
                            <input
                              type="checkbox"
                              checked={on}
                              className="accent-amber"
                              onChange={(e) => {
                                const set = new Set(task.dependsOn);
                                if (e.target.checked) set.add(other.ref);
                                else set.delete(other.ref);
                                setTask(i, { dependsOn: [...set] });
                              }}
                            />
                            <span className="font-mono">{other.ref || "—"}</span>
                          </label>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {dupRef && (
          <p className="text-[11px] text-rust">Task refs must be unique — rename the duplicate.</p>
        )}
        {saveError && (
          <p className="rounded border border-rust/40 bg-rust/10 px-2 py-1.5 text-[11px] text-rust">{saveError}</p>
        )}
        <div className="flex items-center gap-2">
          <SaveButton
            saving={saving}
            disabled={!canSave}
            onClick={async () => {
              setSaving(true);
              setSaveError(null);
              try {
                await saveBlueprint({ ...draft, updatedAt: new Date().toISOString() });
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
                await deleteBlueprint(existing.id);
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
