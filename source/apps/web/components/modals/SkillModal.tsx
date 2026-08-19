"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { Skill } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, SaveButton, TextArea, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

const TEMPLATE = `---
name: my-skill
description: One line on when to use this skill.
---

# My skill

Instructions the agent follows when this skill is attached.
`;

export function SkillModal({ id }: { id?: string }) {
  const skills = useConfigStore((s) => s.skills);
  const saveSkill = useConfigStore((s) => s.saveSkill);
  const deleteSkill = useConfigStore((s) => s.deleteSkill);
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);

  const existing = skills.find((s) => s.id === id);
  const [draft, setDraft] = useState<Skill>(
    existing ?? {
      id: newUuid(),
      slug: "",
      name: "",
      description: "",
      source: "created",
      content: TEMPLATE,
      updatedAt: new Date().toISOString(),
    },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  return (
    <Modal title={existing ? `Skill — ${existing.name}` : "New skill"} wide>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <TextInput
              value={draft.name}
              placeholder="e.g. sql-tuning"
              onChange={(name) =>
                setDraft({ ...draft, name, slug: draft.slug || name.toLowerCase().replace(/\s+/g, "-") })
              }
            />
          </Field>
          <Field label="Description">
            <TextInput
              value={draft.description}
              placeholder="when should an agent use it?"
              onChange={(description) => setDraft({ ...draft, description })}
            />
          </Field>
        </div>
        <Field label="SKILL.md content — paste any .md file here to install it">
          <TextArea
            value={draft.content}
            rows={14}
            onChange={(content) => {
              // pasted SKILL.md frontmatter prefills empty fields, so a raw
              // paste installs without retyping name/description
              const fmName = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
              const fmDesc = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
              setDraft({
                ...draft,
                content,
                name: draft.name || fmName || "",
                slug: draft.slug || (fmName ?? "").toLowerCase().replace(/\s+/g, "-"),
                description: draft.description || fmDesc || "",
              });
            }}
          />
        </Field>
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
                await saveSkill({ ...draft, updatedAt: new Date().toISOString() });
                // new skill → offer to clone it to skill-capable providers
                if (existing) closeModal();
                else openModal({ type: "skill-clone", skillId: draft.id });
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
                await deleteSkill(existing.id);
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
