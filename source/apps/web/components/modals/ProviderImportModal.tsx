"use client";

import { useEffect, useState } from "react";
import { Bot, Plug, Sparkles } from "lucide-react";
import { api, type ImportScan } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useUiStore } from "@/stores/ui";
import { Modal } from "./Modal";

type Picks = { skills: Set<number>; agents: Set<number>; mcpServers: Set<number> };

function Section<T>({
  title,
  icon: Icon,
  items,
  picked,
  toggle,
  render,
  getText,
  bulk,
}: {
  title: string;
  icon: typeof Bot;
  items: T[];
  picked: Set<number>;
  toggle: (i: number) => void;
  render: (item: T) => React.ReactNode;
  /** text used to filter rows; enables the search box */
  getText: (item: T) => string;
  /** set/clear a batch of original indices at once */
  bulk: (indices: number[], on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  // keep ORIGINAL indices so the picked-Set mapping stays correct while filtered
  const shown = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => !q.trim() || getText(item).toLowerCase().includes(q.trim().toLowerCase()));
  const shownIdx = shown.map((s) => s.i);

  return (
    <div className="rounded border border-line bg-raised/40 p-2.5">
      <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-white">
        <Icon size={13} className="text-amber" />
        {title}
        <span className="text-faint">
          {picked.size}/{items.length} selected
        </span>
        {items.length > 0 && (
          <span className="ml-auto flex gap-2 text-[10px] font-normal">
            <button onClick={() => bulk(shownIdx, true)} className="text-faint hover:text-amber">
              select shown
            </button>
            <button onClick={() => bulk(shownIdx, false)} className="text-faint hover:text-rust">
              clear
            </button>
          </span>
        )}
      </div>
      {items.length > 0 && (
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${title.toLowerCase()}…`}
          className="mb-1.5 w-full rounded border border-line bg-raised px-2 py-1 text-[11px] text-soft outline-none placeholder:text-faint focus:border-amber"
        />
      )}
      {items.length === 0 && <p className="text-[11px] text-faint">nothing found</p>}
      {items.length > 0 && shown.length === 0 && (
        <p className="text-[11px] text-faint">no match for “{q}”</p>
      )}
      <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
        {shown.map(({ item, i }) => (
          <label key={i} className="flex items-start gap-2 text-xs text-soft">
            <input
              type="checkbox"
              checked={picked.has(i)}
              onChange={() => toggle(i)}
              className="mt-0.5 accent-amber"
            />
            <span className="min-w-0">{render(item)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export function ProviderImportModal({ providerId }: { providerId: string }) {
  const providers = useConfigStore((s) => s.providers);
  const loadAll = useConfigStore((s) => s.loadAll);
  const closeModal = useUiStore((s) => s.closeModal);
  const provider = providers.find((p) => p.id === providerId);

  const [scan, setScan] = useState<ImportScan | null>(null);
  const [picks, setPicks] = useState<Picks>({
    skills: new Set(),
    agents: new Set(),
    mcpServers: new Set(),
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!provider) return;
    api.import
      .scan(provider.kind)
      .then((found) => {
        setScan(found);
        // everything starts UNCHECKED — search + tick exactly what you want.
        // Re-importing an existing item overwrites it (no duplicates).
        setPicks({ skills: new Set(), agents: new Set(), mcpServers: new Set() });
      })
      .catch(() => setScan({ skills: [], agents: [], mcpServers: [], connectors: [] }));
  }, [provider]);

  const toggle = (section: keyof Picks) => (i: number) =>
    setPicks((p) => {
      const next = new Set(p[section]);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return { ...p, [section]: next };
    });

  const bulk = (section: keyof Picks) => (indices: number[], on: boolean) =>
    setPicks((p) => {
      const next = new Set(p[section]);
      for (const i of indices) (on ? next.add(i) : next.delete(i));
      return { ...p, [section]: next };
    });

  if (!provider) return null;

  return (
    <Modal title={`Import global config — ${provider.name}`} wide>
      {!scan ? (
        <p className="text-xs text-faint">scanning {provider.kind} home…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-soft">
            Found existing {provider.kind} configuration on this machine. Pick what
            to bring into Daimon-OS:
          </p>
          <Section
            title="Skills"
            icon={Sparkles}
            items={scan.skills}
            picked={picks.skills}
            toggle={toggle("skills")}
            bulk={bulk("skills")}
            getText={(s) => `${s.name} ${s.plugin ?? ""} ${s.description ?? ""}`}
            render={(s) => (
              <>
                <span className="text-white">{s.name}</span>
                {s.source === "plugin" && (
                  <span className="ml-1.5 rounded bg-sky/15 px-1 py-px text-[9px] uppercase tracking-wide text-sky">
                    {s.plugin ?? "plugin"}
                  </span>
                )}
                {s.description && <span className="text-faint"> — {s.description}</span>}
              </>
            )}
          />
          <Section
            title="Agents"
            icon={Bot}
            items={scan.agents}
            picked={picks.agents}
            toggle={toggle("agents")}
            bulk={bulk("agents")}
            getText={(a) => `${a.name} ${a.description ?? ""}`}
            render={(a) => (
              <>
                <span className="text-white">{a.name}</span>
                {a.description && <span className="text-faint"> — {a.description}</span>}
              </>
            )}
          />
          <Section
            title="MCP servers"
            icon={Plug}
            items={scan.mcpServers}
            picked={picks.mcpServers}
            toggle={toggle("mcpServers")}
            bulk={bulk("mcpServers")}
            getText={(m) => `${m.name} ${m.url ?? ""} ${m.command ?? ""}`}
            render={(m) => (
              <>
                <span className="text-white">{m.name}</span>
                <span className="text-faint">
                  {" "}
                  — {m.transport === "http" ? m.url : `${m.command ?? ""} ${(m.args ?? []).join(" ")}`}
                </span>
              </>
            )}
          />
          {scan.connectors.length > 0 && (
            <div className="rounded border border-line bg-raised/40 p-2.5">
              <div className="mb-1 flex items-center gap-2 text-xs font-medium text-white">
                <Plug size={13} className="text-sky" />
                claude.ai connectors
                <span className="text-faint">{scan.connectors.length} connected</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {scan.connectors.map((c) => (
                  <span key={c} className="rounded-full border border-sky/40 px-2 py-0.5 text-[11px] text-sky">
                    {c}
                  </span>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
                These are account connectors (OAuth via your Claude login), not local MCP
                servers — there&apos;s nothing to import. Your Claude agents already get
                them automatically at runtime, as long as they run under your subscription
                login (no ANTHROPIC_API_KEY set).
              </p>
            </div>
          )}
          {result && <p className="text-xs text-mint">{result}</p>}
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const counts = await api.import.apply({
                    providerId,
                    kind: provider.kind,
                    skills: scan.skills.filter((_, i) => picks.skills.has(i)),
                    agents: scan.agents.filter((_, i) => picks.agents.has(i)),
                    mcpServers: scan.mcpServers.filter((_, i) => picks.mcpServers.has(i)),
                  });
                  await loadAll();
                  setResult(
                    `imported ${counts.skills} skills, ${counts.agents} agents, ${counts.mcpServers} MCP servers`,
                  );
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded bg-amber px-3 py-2 text-xs font-medium text-ink hover:bg-amber/90 disabled:opacity-40"
            >
              {busy ? "Importing…" : "Import selected"}
            </button>
            <button
              onClick={closeModal}
              className="rounded border border-line px-3 py-2 text-xs text-soft hover:border-amber"
            >
              {result ? "Done" : "Skip"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
