"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { Task } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useTaskStore } from "@/stores/tasks";
import { useUiStore } from "@/stores/ui";
import { Field, NumberInput, SaveButton, Select, TextArea, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

export function TaskModal({ projectId, id }: { projectId: string; id?: string }) {
  const tasks = useTaskStore((s) => s.tasks);
  const saveTask = useTaskStore((s) => s.saveTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const agents = useConfigStore((s) => s.agents);
  const closeModal = useUiStore((s) => s.closeModal);

  const existing = id ? tasks[id] : undefined;
  const [draft, setDraft] = useState<Task>(
    existing ?? {
      id: newUuid(),
      projectId: projectId as Task["projectId"],
      title: "",
      status: "backlog",
      dependsOn: [],
      createdBy: "human",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const projectTasks = Object.values(tasks).filter(
    (t) => t.projectId === projectId && t.id !== draft.id,
  );
  const statusOptions: Task["status"][] = !existing
    ? ["backlog", "blocked"]
    : existing.status === "backlog" || existing.status === "blocked"
      ? ["backlog", "blocked"]
      : existing.status === "done"
        ? ["done", "backlog"]
        : existing.status === "waiting_review"
          ? ["waiting_review", "backlog"]
          : [existing.status];

  return (
    <Modal title={existing ? `Task — ${existing.title}` : "New task"}>
      <div className="flex flex-col gap-3">
        <Field label="Title">
          <TextInput value={draft.title} onChange={(title) => setDraft({ ...draft, title })} />
        </Field>
        <Field label="Description">
          <TextArea value={draft.description ?? ""} rows={3} onChange={(description) => setDraft({ ...draft, description })} />
        </Field>
        <Field label="Assign to agent">
          <Select
            value={draft.assignedAgentId ?? ""}
            options={[
              { value: "", label: "— unassigned —" },
              ...agents.map((a) => ({ value: a.id, label: a.name })),
            ]}
            onChange={(v) => {
              const agent = agents.find((a) => a.id === v);
              setDraft({
                ...draft,
                assignedAgentId: (v || undefined) as Task["assignedAgentId"],
                assignedAgentName: agent?.name,
              });
            }}
          />
        </Field>
        <Field label="Status">
          <Select
            value={draft.status}
            options={statusOptions}
            onChange={(v) => setDraft({ ...draft, status: v as Task["status"] })}
          />
          {(draft.status === "in_progress" || draft.status === "waiting_review" || draft.status === "failed") && (
            <p className="mt-1 text-[11px] text-faint">
              Runtime and review transitions are server-owned. Use Review, Request changes, or Retry.
            </p>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Scheduler lane">
            <TextInput
              value={draft.lane ?? "default"}
              onChange={(lane) => setDraft({ ...draft, lane: lane || undefined })}
            />
          </Field>
          <Field label="Priority (-100..100)">
            <NumberInput
              value={draft.priority ?? 0}
              min={-100}
              max={100}
              onChange={(priority) => setDraft({ ...draft, priority })}
            />
          </Field>
        </div>
        <Field label="Not before (ISO 8601, optional)">
          <TextInput
            value={draft.notBefore ?? ""}
            placeholder="2026-08-18T07:00:00.000Z"
            onChange={(notBefore) => setDraft({ ...draft, notBefore: notBefore || undefined })}
          />
        </Field>
        {projectTasks.length > 0 && (
          <div className="flex flex-col gap-1 text-xs">
            <span className="text-soft">Depends on (blocks until these are done)</span>
            {projectTasks.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-soft">
                <input
                  type="checkbox"
                  checked={draft.dependsOn.includes(t.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      dependsOn: e.target.checked
                        ? [...draft.dependsOn, t.id]
                        : draft.dependsOn.filter((d) => d !== t.id),
                    })
                  }
                  className="accent-amber"
                />
                {t.title}
              </label>
            ))}
          </div>
        )}
        {saveError && (
          <p className="rounded border border-rust/40 bg-rust/10 px-2 py-1.5 text-[11px] text-rust">{saveError}</p>
        )}
        <div className="flex items-center gap-2">
          <SaveButton
            saving={saving}
            onClick={async () => {
              setSaving(true);
              setSaveError(null);
              try {
                await saveTask(draft);
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
                await deleteTask(existing.id);
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
