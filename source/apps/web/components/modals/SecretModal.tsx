"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { Secret } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, Hint, SaveButton, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

export function SecretModal({ id }: { id?: string }) {
  const secrets = useConfigStore((s) => s.secrets);
  const saveSecret = useConfigStore((s) => s.saveSecret);
  const deleteSecret = useConfigStore((s) => s.deleteSecret);
  const closeModal = useUiStore((s) => s.closeModal);

  const existing = secrets.find((s) => s.id === id);
  const now = new Date().toISOString();
  const [draft, setDraft] = useState<Secret>(
    existing ?? {
      id: newUuid() as Secret["id"],
      key: "",
      label: "",
      group: "",
      createdAt: now,
      updatedAt: now,
    },
  );
  // write-only: empty means "keep the stored value" when editing
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const keyValid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(draft.key);
  const canSave = keyValid && (existing ? true : value.length > 0);

  return (
    <Modal title={existing ? `Secret — ${existing.key}` : "New secret"}>
      <div className="flex flex-col gap-3">
        <Field label="Env var name (how agents read it)">
          <TextInput
            value={draft.key}
            placeholder="e.g. FACEBOOK_PAGE_TOKEN"
            onChange={(key) => setDraft({ ...draft, key })}
          />
        </Field>
        <Hint>
          UPPER_SNAKE_CASE — letters, digits, underscore; no spaces, not starting with a
          digit. This becomes the environment variable your agents/MCP servers read.
          <br />
          e.g. <code className="not-italic text-soft">FACEBOOK_PAGE_TOKEN</code>,{" "}
          <code className="not-italic text-soft">FACEBOOK_PAGE_ID</code>,{" "}
          <code className="not-italic text-soft">INSTAGRAM_TOKEN</code>,{" "}
          <code className="not-italic text-soft">IG_USER_ID</code>,{" "}
          <code className="not-italic text-soft">OPENAI_API_KEY</code>
        </Hint>
        {!keyValid && draft.key.length > 0 && (
          <p className="-mt-1 text-[10px] text-rust">
            Invalid env var name — use letters, digits, underscore; don&apos;t start with a digit.
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Group (optional)">
            <TextInput
              value={draft.group ?? ""}
              placeholder="e.g. Facebook"
              onChange={(group) => setDraft({ ...draft, group })}
            />
          </Field>
          <Field label="Label (optional)">
            <TextInput
              value={draft.label ?? ""}
              placeholder="e.g. Page access token"
              onChange={(label) => setDraft({ ...draft, label })}
            />
          </Field>
        </div>
        <Hint>
          Group buckets related secrets in the sidebar (e.g.{" "}
          <span className="not-italic text-soft">Facebook</span>,{" "}
          <span className="not-italic text-soft">Instagram</span>). Label is a free-text note
          for yourself. Both are optional.
        </Hint>
        <Field label={existing ? "Value (leave blank to keep current)" : "Value"}>
          <TextInput
            value={value}
            type="password"
            placeholder={existing?.maskedValue ? `current: ${existing.maskedValue}` : "e.g. EAAGm0PX…ZDZD"}
            onChange={setValue}
          />
        </Field>
        <Hint>
          The raw secret/token — paste it exactly as the provider gives it (no quotes). Stored
          AES-256-GCM encrypted; after saving only a masked tail (e.g.{" "}
          <span className="not-italic text-soft">EAA…ZDZD</span>) is ever shown.
        </Hint>
        <p className="text-[10px] leading-relaxed text-faint">
          Stored AES-256-GCM encrypted on the server — never written to config or
          sent back to the browser (only the masked tail is). The{" "}
          <code className="text-soft">{draft.key || "ENV_VAR"}</code> environment variable is injected
          only when the project allows this secret and the specific agent is also granted it;
          MCP servers launched by that agent inherit the same scoped environment. Configure both
          grants in the project and agent editors.
        </p>
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
                await saveSecret(
                  { ...draft, updatedAt: new Date().toISOString() },
                  value || undefined,
                );
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
                await deleteSecret(existing.id);
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
