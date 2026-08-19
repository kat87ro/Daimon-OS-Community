"use client";

import { useState } from "react";
import { Lock, Trash2 } from "lucide-react";
import { newUuid } from "@daimon-os/shared";
import type { McpServer } from "@daimon-os/shared";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Field, SaveButton, Select, TextArea, TextInput } from "../sidebar/fields";
import { Modal } from "./Modal";

export function McpModal({ id }: { id?: string }) {
  const servers = useConfigStore((s) => s.mcpServers);
  const providers = useConfigStore((s) => s.providers);
  const saveMcpServer = useConfigStore((s) => s.saveMcpServer);
  const deleteMcpServer = useConfigStore((s) => s.deleteMcpServer);
  const closeModal = useUiStore((s) => s.closeModal);

  const existing = servers.find((m) => m.id === id);
  const [draft, setDraft] = useState<McpServer>(
    existing ?? {
      id: newUuid(),
      name: "",
      transport: "stdio",
      command: "",
      args: [],
      isDefault: false,
      enabled: true,
    },
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  return (
    <Modal title={existing ? `MCP server — ${existing.name}` : "New MCP server"}>
      <div className="flex flex-col gap-3">
        <Field label="Name (key in .mcp.json)">
          <TextInput value={draft.name} placeholder="e.g. daimon-tools" onChange={(name) => setDraft({ ...draft, name })} />
        </Field>
        <Field label="Used by provider">
          <Select
            value={draft.providerKind ?? ""}
            options={[
              { value: "", label: "— any provider (universal) —" },
              ...[...new Set(providers.map((p) => p.kind))].map((k) => ({
                value: k,
                label: k,
              })),
            ]}
            onChange={(v) =>
              setDraft({ ...draft, providerKind: (v || undefined) as McpServer["providerKind"] })
            }
          />
        </Field>
        <p className="text-[10px] leading-relaxed text-faint">
          Scoping a server to a provider (e.g. claude) means only agents on that
          CLI family get it, written into that CLI&apos;s own config format — a
          Claude agent never receives a Gemini server. &quot;Any&quot; applies to all.
        </p>
        <Field label="Transport">
          <Select
            value={draft.transport}
            options={[
              { value: "stdio", label: "stdio — local command" },
              { value: "http", label: "http — remote URL" },
            ]}
            onChange={(v) => setDraft({ ...draft, transport: v as McpServer["transport"] })}
          />
        </Field>
        {draft.transport === "stdio" ? (
          <>
            <Field label="Command">
              <TextInput value={draft.command ?? ""} placeholder="npx" onChange={(command) => setDraft({ ...draft, command })} />
            </Field>
            <Field label="Arguments (one per line)">
              <TextArea
                value={(draft.args ?? []).join("\n")}
                rows={3}
                onChange={(v) => setDraft({ ...draft, args: v.split("\n").map((s) => s.trim()).filter(Boolean) })}
              />
            </Field>
          </>
        ) : (
          <Field label="URL">
            <TextInput value={draft.url ?? ""} placeholder="https://mcp.example.com/sse" onChange={(url) => setDraft({ ...draft, url })} />
          </Field>
        )}
        <p className="text-[10px] leading-relaxed text-faint">
          MCP credentials are not accepted here because this configuration is written into a
          project folder. Store credentials in the encrypted Vault, opt the project into them,
          and the MCP process will inherit the scoped runtime environment.
        </p>
        <label className="flex items-center gap-2 text-xs text-soft">
          <input
            type="checkbox"
            checked={draft.isDefault}
            onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
            className="accent-amber"
          />
          Link to ALL spawned terminals/agents (default server)
        </label>
        <p className="text-[10px] leading-relaxed text-faint">
          Linked servers are written into the project folder&apos;s .mcp.json on
          spawn (merge-only — existing entries are never overwritten), so even a
          claude/codex you launch manually in that folder picks them up.
        </p>
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
                await saveMcpServer(draft);
                closeModal();
              } catch (e) {
                setSaveError(e instanceof Error ? e.message : "Save failed");
              } finally {
                setSaving(false);
              }
            }}
          />
          {existing &&
            (draft.builtin ? (
              <span
                className="ml-auto flex items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-faint"
                title="Core local server — protected from deletion"
              >
                <Lock size={12} /> Built-in
              </span>
            ) : (
              <button
                onClick={async () => {
                  await deleteMcpServer(existing.id);
                  closeModal();
                }}
                className="ml-auto flex items-center gap-1 rounded border border-line px-3 py-1.5 text-xs text-rust hover:border-rust"
              >
                <Trash2 size={12} /> Delete
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}
