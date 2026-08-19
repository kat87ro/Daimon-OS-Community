"use client";

import { useRef, useState } from "react";
import { FileText, Paperclip, Trash2, X } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { Attachment, Goal } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useAttachmentObjectUrls } from "@/lib/attachmentObjectUrls";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, SaveButton, Select, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const res = String(r.result);
      resolve(res.slice(res.indexOf(",") + 1)); // strip the data: prefix
    };
    r.readAsDataURL(file);
  });
}

/** a short label from the first non-empty line of the body, capped at 70 chars */
export function deriveTitle(description?: string): string {
  const line = (description ?? "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 70 ? `${line.slice(0, 70)}…` : line;
}

const fmtSize = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export function GoalModal({ projectId, id }: { projectId: string; id?: string }) {
  const goals = useConfigStore((s) => s.goals);
  const saveGoal = useConfigStore((s) => s.saveGoal);
  const deleteGoal = useConfigStore((s) => s.deleteGoal);
  const closeModal = useUiStore((s) => s.closeModal);
  const fileInput = useRef<HTMLInputElement>(null);

  const existing = goals.find((g) => g.id === id);
  const [draft, setDraft] = useState<Goal>(
    existing ?? {
      id: newUuid(),
      projectId: projectId as Goal["projectId"],
      title: "",
      status: "active",
      description: "",
      attachments: [],
      createdAt: new Date().toISOString(),
    },
  );
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attachments = draft.attachments ?? [];
  const { urls: attachmentUrls, loadError } = useAttachmentObjectUrls(attachments);

  async function onPickFiles(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      const added: Attachment[] = [];
      for (const file of Array.from(files)) {
        const dataBase64 = await readAsBase64(file);
        const meta = await api.attachments.upload({
          name: file.name,
          mime: file.type || "application/octet-stream",
          dataBase64,
        });
        added.push(meta);
      }
      setDraft((d) => ({ ...d, attachments: [...(d.attachments ?? []), ...added] }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed (max 25 MB per file)");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function removeAttachment(attId: string) {
    setDraft((d) => ({ ...d, attachments: (d.attachments ?? []).filter((a) => a.id !== attId) }));
  }

  return (
    <Modal title={existing ? `Goal — ${existing.title || "untitled"}` : "New goal"} wide>
      <div className="flex flex-col gap-3">
        <Field label="Goal (short title)">
          <TextInput
            value={draft.title}
            placeholder="auto-filled from the first line if left blank"
            onChange={(title) => setDraft({ ...draft, title })}
          />
        </Field>
        <Field label="Status">
          <Select
            value={draft.status}
            options={["open", "active", "done"]}
            onChange={(v) => setDraft({ ...draft, status: v as Goal["status"] })}
          />
        </Field>

        <div className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-soft">
            The goal — write it in full ({(draft.description ?? "").length} chars)
          </span>
          <textarea
            value={draft.description ?? ""}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Describe the goal in full: scope, requirements, constraints, examples, links… As long and detailed as you want. The Lead works from this."
            className="h-[55vh] min-h-[12rem] w-full resize-y overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-raised px-3 py-2 text-xs leading-relaxed text-white outline-none placeholder:text-faint focus:border-amber"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-soft">Attachments (images & files)</span>
            <button
              onClick={() => fileInput.current?.click()}
              disabled={uploading}
              className="flex items-center gap-1.5 rounded border border-line px-2.5 py-1 text-[11px] text-soft hover:border-amber hover:text-amber disabled:opacity-50"
            >
              <Paperclip size={12} /> {uploading ? "Uploading…" : "Attach"}
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => void onPickFiles(e.target.files)}
            />
          </div>
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group relative flex w-28 flex-col gap-1 rounded-lg border border-line bg-panel p-1.5"
                >
                  <button
                    onClick={() => removeAttachment(a.id)}
                    className="absolute right-1 top-1 rounded bg-ink/70 p-0.5 text-faint opacity-0 hover:text-rust group-hover:opacity-100"
                    title="Remove"
                  >
                    <X size={11} />
                  </button>
                  {a.isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={attachmentUrls[a.id]}
                      alt={a.name}
                      className="h-16 w-full rounded object-cover"
                    />
                  ) : (
                    <a
                      href={attachmentUrls[a.id]}
                      target="_blank"
                      rel="noreferrer"
                      download={a.name}
                      className="flex h-16 w-full items-center justify-center rounded bg-raised text-faint hover:text-amber"
                    >
                      <FileText size={22} />
                    </a>
                  )}
                  <span className="truncate text-[10px] text-soft" title={a.name}>
                    {a.name}
                  </span>
                  <span className="text-[9px] text-faint">{fmtSize(a.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-rust">{error}</p>}
        {loadError && <p className="text-xs text-rust">{loadError}</p>}
        <div className="flex items-center gap-2">
          <SaveButton
            saving={saving}
            onClick={async () => {
              // the title is just a short label — derive it from the body's first
              // line if the user only wrote the goal text
              const title = draft.title.trim() || deriveTitle(draft.description);
              if (!title) {
                setError("write the goal (or a short title)");
                return;
              }
              setSaving(true);
              setError(null);
              try {
                await saveGoal({ ...draft, title });
                closeModal();
              } catch (e) {
                setError(e instanceof Error ? e.message : "save failed");
              } finally {
                setSaving(false);
              }
            }}
          />
          {existing && (
            <button
              onClick={async () => {
                await deleteGoal(existing.id);
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
