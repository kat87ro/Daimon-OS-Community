"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { Schedule, ScheduleKind } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, Hint, SaveButton, Select, TextArea, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

const SPEC_HINT: Record<ScheduleKind, string> = {
  cron: 'cron expression (minute resolution), e.g. "0 9 * * *" — every day at 09:00',
  interval: 'milliseconds between runs, e.g. "3600000" — every hour',
  watch: 'absolute path; a create/change under it fires (debounced), e.g. "/Users/you/inbox"',
};

export function ScheduleModal({ id }: { id?: string }) {
  const schedules = useConfigStore((s) => s.schedules);
  const blueprints = useConfigStore((s) => s.blueprints);
  const projects = useConfigStore((s) => s.projects);
  const saveSchedule = useConfigStore((s) => s.saveSchedule);
  const deleteSchedule = useConfigStore((s) => s.deleteSchedule);
  const closeModal = useUiStore((s) => s.closeModal);

  const existing = schedules.find((s) => s.id === id);
  const now = new Date().toISOString();
  const [draft, setDraft] = useState<Schedule>(
    existing ?? {
      id: newUuid() as Schedule["id"],
      name: "",
      blueprintId: (blueprints[0]?.id ?? "") as Schedule["blueprintId"],
      projectId: (projects[0]?.id ?? "") as Schedule["projectId"],
      kind: "cron",
      spec: "",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canSave =
    draft.name.trim().length > 0 &&
    draft.blueprintId.length > 0 &&
    draft.projectId.length > 0 &&
    draft.spec.trim().length > 0;

  return (
    <Modal title={existing ? `Schedule — ${existing.name}` : "New schedule"}>
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <TextInput
            value={draft.name}
            placeholder="e.g. Daily morning run"
            onChange={(name) => setDraft({ ...draft, name })}
          />
        </Field>
        <Field label="Blueprint">
          <Select
            value={draft.blueprintId}
            options={[
              { value: "", label: blueprints.length ? "— select a blueprint —" : "— no blueprints yet —" },
              ...blueprints.map((b) => ({ value: b.id, label: b.name })),
            ]}
            onChange={(v) => setDraft({ ...draft, blueprintId: v as Schedule["blueprintId"] })}
          />
        </Field>
        <Field label="Project">
          <Select
            value={draft.projectId}
            options={[
              { value: "", label: projects.length ? "— select a project —" : "— no projects yet —" },
              ...projects.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={(v) => setDraft({ ...draft, projectId: v as Schedule["projectId"] })}
          />
        </Field>
        <Field label="Kind">
          <Select
            value={draft.kind}
            options={[
              { value: "cron", label: "cron — at a clock time" },
              { value: "interval", label: "interval — every N ms" },
              { value: "watch", label: "watch — on filesystem change" },
            ]}
            onChange={(v) => setDraft({ ...draft, kind: v as ScheduleKind })}
          />
        </Field>
        <Field label="Spec">
          <TextInput
            value={draft.spec}
            placeholder={
              draft.kind === "cron" ? "0 9 * * *" : draft.kind === "interval" ? "3600000" : "/Users/you/inbox"
            }
            onChange={(spec) => setDraft({ ...draft, spec })}
          />
        </Field>
        <Hint>{SPEC_HINT[draft.kind]}</Hint>
        <Field label="Vars (KEY=value, one per line) — passed to instantiate">
          <TextArea
            value={Object.entries(draft.vars ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")}
            rows={2}
            placeholder="goal=Publish the weekly digest"
            onChange={(v) =>
              setDraft({
                ...draft,
                vars: Object.fromEntries(
                  v
                    .split("\n")
                    .map((l) => l.split("="))
                    .filter((p) => p[0]?.trim())
                    .map((p) => [p[0]!.trim(), p.slice(1).join("=").trim()]),
                ),
              })
            }
          />
        </Field>
        <label className="flex items-center gap-2 text-xs text-soft">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="accent-amber"
          />
          Enabled
        </label>
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
                await saveSchedule({ ...draft, updatedAt: new Date().toISOString() });
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
                await deleteSchedule(existing.id);
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
