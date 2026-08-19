"use client";

import { useState } from "react";
import {
  Brain,
  Github,
  KeyRound,
  LayoutTemplate,
  Lock,
  Plug,
  Plus,
  Settings,
  Sparkles,
} from "lucide-react";
import { useConfigStore } from "@/stores/config";
import { useUiStore, type ModalSpec } from "@/stores/ui";
import { Modal } from "./Modal";
import { MemorySettings } from "./MemorySettings";
import { OrchestratorSettings } from "./OrchestratorSettings";
import { GitHubSettings } from "./GitHubSettings";

type TabKey =
  | "providers"
  | "github"
  | "secrets"
  | "skills"
  | "mcp"
  | "blueprints"
  | "memory"
  | "orchestrator";

const TABS: Array<{ key: TabKey; label: string; icon: typeof KeyRound }> = [
  { key: "providers", label: "Providers", icon: KeyRound },
  { key: "github", label: "GitHub", icon: Github },
  { key: "secrets", label: "API Tokens", icon: Lock },
  { key: "skills", label: "Skills", icon: Sparkles },
  { key: "mcp", label: "MCP Servers", icon: Plug },
  { key: "blueprints", label: "Blueprints", icon: LayoutTemplate },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "orchestrator", label: "Orchestrator", icon: Settings },
];

/** Compact, click-to-edit managed list that reuses the existing entity editors. */
function ManagedList({
  items,
  emptyHint,
  iconColor,
  icon: Icon,
  editModal,
  addModal,
}: {
  items: Array<{ id: string; label: string }>;
  emptyHint: string;
  iconColor: string;
  icon: typeof KeyRound;
  editModal: (id: string) => ModalSpec;
  addModal: ModalSpec;
}) {
  const pushModal = useUiStore((s) => s.pushModal);
  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={() => pushModal(addModal)}
        className="mb-1 flex items-center gap-1.5 self-start rounded border border-line bg-raised px-2.5 py-1.5 text-xs text-white hover:border-amber"
      >
        <Plus size={12} /> Add
      </button>
      {items.length === 0 ? (
        <p className="px-1 py-2 text-[11px] text-faint">{emptyHint}</p>
      ) : (
        items.map((it) => (
          <button
            key={it.id}
            onClick={() => pushModal(editModal(it.id))}
            className="flex w-full items-center gap-2 truncate rounded border border-transparent px-2 py-1.5 text-left text-xs text-soft hover:border-line hover:bg-raised/60 hover:text-text"
          >
            <Icon size={12} className={`flex-none ${iconColor}`} />
            <span className="truncate">{it.label}</span>
          </button>
        ))
      )}
    </div>
  );
}

export function ConfigurationModal({ tab, notice }: { tab?: string; notice?: string }) {
  const providers = useConfigStore((s) => s.providers);
  const secrets = useConfigStore((s) => s.secrets);
  const skills = useConfigStore((s) => s.skills);
  const mcpServers = useConfigStore((s) => s.mcpServers);
  const blueprints = useConfigStore((s) => s.blueprints);

  const patchTop = useUiStore((s) => s.patchTop);
  const initial = (TABS.some((t) => t.key === tab) ? tab : "providers") as TabKey;
  const [active, setActive] = useState<TabKey>(initial);
  // remember the active tab on the modal spec so opening an editor (pushed on top)
  // and pressing Back returns to THIS tab, not the default
  const selectTab = (key: TabKey) => {
    setActive(key);
    patchTop({ tab: key });
  };

  return (
    <Modal title="Configuration" xwide>
      <div className="flex flex-col gap-3">
        {notice && (
          <p role="status" className="rounded border border-mint/40 bg-mint/5 px-3 py-2 text-xs text-mint">
            {notice}
          </p>
        )}
        {/* top tab strip — sticky so navigation stays in reach on long
            settings tabs (Memory / Orchestrator); amber underline on active */}
        <div className="sticky top-0 z-10 flex flex-none flex-wrap gap-1 border-b border-line bg-panel pb-1">
          {TABS.map((t) => {
            const isActive = active === t.key;
            return (
              <button
                key={t.key}
                onClick={() => selectTab(t.key)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs ${
                  isActive
                    ? "border-amber font-medium text-text"
                    : "border-transparent text-soft hover:text-text"
                }`}
              >
                <t.icon size={13} className={isActive ? "text-amber" : "text-faint"} />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="min-h-[200px]">
          {active === "providers" && (
            <ManagedList
              items={providers.map((p) => ({
                id: p.id,
                label: `${p.name}${p.maskedKey ? "" : " · subscription"}`,
              }))}
              emptyHint="No providers configured. Add one to connect a CLI/API."
              icon={KeyRound}
              iconColor="text-amber"
              editModal={(id) => ({ type: "provider", id })}
              addModal={{ type: "provider" }}
            />
          )}
          {active === "github" && <GitHubSettings />}
          {active === "secrets" && (
            <ManagedList
              items={secrets.map((s) => ({
                id: s.id,
                label: `${s.group ? `${s.group} · ` : ""}${s.key}`,
              }))}
              emptyHint="No API tokens stored. Add encrypted keys/tokens here."
              icon={Lock}
              iconColor="text-rust"
              editModal={(id) => ({ type: "secret", id })}
              addModal={{ type: "secret" }}
            />
          )}
          {active === "skills" && (
            <ManagedList
              items={skills.map((sk) => ({
                id: sk.id,
                label: sk.description ? `${sk.name} — ${sk.description}` : sk.name,
              }))}
              emptyHint="No skills yet. Create one, paste a .md, or import via a provider."
              icon={Sparkles}
              iconColor="text-mint"
              editModal={(id) => ({ type: "skill", id })}
              addModal={{ type: "skill" }}
            />
          )}
          {active === "mcp" && (
            <ManagedList
              items={mcpServers.map((m) => ({
                id: m.id,
                label: `${m.name}${m.isDefault ? " · all spawns" : ""}`,
              }))}
              emptyHint="No MCP servers configured yet."
              icon={Plug}
              iconColor="text-sky"
              editModal={(id) => ({ type: "mcp", id })}
              addModal={{ type: "mcp" }}
            />
          )}
          {active === "blueprints" && (
            <ManagedList
              items={blueprints.map((b) => ({
                id: b.id,
                label: b.description ? `${b.name} — ${b.description}` : b.name,
              }))}
              emptyHint="No blueprints yet. Create a reusable task-DAG template."
              icon={LayoutTemplate}
              iconColor="text-mint"
              editModal={(id) => ({ type: "blueprint", id })}
              addModal={{ type: "blueprint" }}
            />
          )}
          {active === "memory" && <MemorySettings />}
          {active === "orchestrator" && <OrchestratorSettings />}
        </div>
      </div>
    </Modal>
  );
}
