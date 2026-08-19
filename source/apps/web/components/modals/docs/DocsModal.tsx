"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Lightbulb,
  Search,
  ShieldAlert,
} from "lucide-react";
import { Modal } from "../Modal";
import { DOC_GROUPS, DOC_SECTIONS } from "./content";
import { sectionText, type DocBlock, type DocSection } from "./types";

const CALLOUT: Record<
  NonNullable<Extract<DocBlock, { kind: "callout" }>["tone"]>,
  { cls: string; icon: typeof Info }
> = {
  info: { cls: "border-sky/40 text-sky", icon: Info },
  tip: { cls: "border-mint/40 text-mint", icon: Lightbulb },
  warn: { cls: "border-amber/40 text-amber", icon: AlertTriangle },
  security: { cls: "border-rust/40 text-rust", icon: ShieldAlert },
};

function Block({ b }: { b: DocBlock }) {
  switch (b.kind) {
    case "p":
      return <p className="text-sm leading-relaxed text-soft">{b.text}</p>;
    case "h":
      return (
        <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-faint">
          {b.text}
        </h3>
      );
    case "steps":
      return (
        <ol className="ml-5 list-decimal space-y-1.5 text-sm text-soft marker:text-faint">
          {b.items.map((it, i) => (
            <li key={i} className="pl-1">
              {it}
            </li>
          ))}
        </ol>
      );
    case "list":
      return (
        <ul className="ml-5 list-disc space-y-1.5 text-sm text-soft marker:text-faint">
          {b.items.map((it, i) => (
            <li key={i} className="pl-1">
              {it}
            </li>
          ))}
        </ul>
      );
    case "callout": {
      const { cls, icon: Icon } = CALLOUT[b.tone];
      return (
        <div className={`flex gap-2 rounded-lg border bg-raised/40 px-3 py-2 ${cls}`}>
          <Icon size={15} className="mt-0.5 flex-none" />
          <div className="min-w-0">
            {b.title && <p className="text-xs font-semibold">{b.title}</p>}
            <p className="text-[12px] leading-relaxed text-soft">{b.text}</p>
          </div>
        </div>
      );
    }
    case "path":
      return (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          {b.segments.map((seg, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-faint" />}
              <span className="rounded border border-line bg-raised px-2 py-0.5 font-medium text-soft">
                {seg}
              </span>
            </span>
          ))}
        </div>
      );
    case "cards":
      return (
        <div className="grid gap-2 sm:grid-cols-2">
          {b.items.map((c, i) => (
            <div key={i} className="rounded-lg border border-line bg-raised p-3">
              <div className="text-xs font-medium text-text">{c.title}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-soft">{c.text}</p>
            </div>
          ))}
        </div>
      );
    case "kv":
      return (
        <div className="rounded-lg border border-line bg-raised/50 px-3 py-1.5">
          {b.title && (
            <p className="border-b border-line/60 py-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
              {b.title}
            </p>
          )}
          <dl>
            {b.items.map((it, i) => (
              <div key={i} className="flex gap-3 border-b border-line/40 py-1.5 last:border-0">
                <dt className="w-36 flex-none font-mono text-[11px] text-amber">{it.k}</dt>
                <dd className="text-[12px] leading-relaxed text-soft">{it.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-lg border border-line bg-ink/60 p-3 font-mono text-[11px] leading-relaxed text-soft">
          {b.text}
        </pre>
      );
    case "img":
      return (
        <figure className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={b.src}
            alt={b.alt}
            loading="lazy"
            className="w-full rounded-lg border border-line"
          />
          {b.caption && <figcaption className="text-[11px] text-faint">{b.caption}</figcaption>}
        </figure>
      );
  }
}

export function DocsModal({ section }: { section?: string }) {
  const byId = useMemo(() => {
    const m = new Map<string, DocSection>();
    for (const s of DOC_SECTIONS) m.set(s.id, s);
    return m;
  }, []);
  const index = useMemo(() => DOC_SECTIONS.map((s) => ({ id: s.id, text: sectionText(s) })), []);

  const initial = section && byId.has(section) ? section : DOC_SECTIONS[0]?.id;
  const [activeId, setActiveId] = useState<string | undefined>(initial);
  const [query, setQuery] = useState("");
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());

  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => new Set(q ? index.filter((s) => s.text.includes(q)).map((s) => s.id) : index.map((s) => s.id)),
    [q, index],
  );

  // groups → only their matching sections; hide empty groups while searching
  const groups = DOC_GROUPS.map((g) => ({
    label: g.label,
    ids: g.sectionIds.filter((id) => matches.has(id)),
  })).filter((g) => g.ids.length > 0);

  const firstMatch = groups[0]?.ids[0];
  // jump content to the first match when the active section is filtered out
  const currentId = q && activeId && !matches.has(activeId) ? firstMatch : activeId;
  const current = currentId ? byId.get(currentId) : undefined;

  const SearchBox = (
    <div className="relative">
      <Search size={13} className="pointer-events-none absolute left-2 top-2 text-faint" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the docs…"
        aria-label="Search documentation"
        className="w-full rounded border border-line bg-ink/40 py-1.5 pl-7 pr-2 text-xs text-text placeholder:text-faint focus:border-amber focus:outline-none"
      />
    </div>
  );

  return (
    <Modal title="Project Documentation & How-To Guide" huge flush>
      {/* desktop page tree */}
      <nav className="hidden w-60 flex-none flex-col border-r border-line md:flex">
        <div className="flex-none border-b border-line p-2">{SearchBox}</div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.length === 0 ? (
            <p className="px-2 py-4 text-[11px] text-faint">No matches for “{query}”.</p>
          ) : (
            groups.map((g) => {
              const open = q ? true : !closedGroups.has(g.label);
              return (
                <div key={g.label} className="mb-1">
                  <button
                    onClick={() =>
                      setClosedGroups((prev) => {
                        const next = new Set(prev);
                        next.has(g.label) ? next.delete(g.label) : next.add(g.label);
                        return next;
                      })
                    }
                    className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-faint hover:text-soft"
                  >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {g.label}
                  </button>
                  {open &&
                    g.ids.map((id) => {
                      const s = byId.get(id);
                      if (!s) return null;
                      const Icon = s.icon;
                      const isActive = currentId === id;
                      return (
                        <button
                          key={id}
                          onClick={() => setActiveId(id)}
                          className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${
                            isActive
                              ? "bg-raised font-medium text-text"
                              : "text-soft hover:bg-raised/60 hover:text-text"
                          }`}
                        >
                          <Icon size={13} className={isActive ? "text-amber" : "text-faint"} />
                          <span className="truncate">{s.title}</span>
                        </button>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>
      </nav>

      {/* content column (with a mobile picker on top) */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-none space-y-2 border-b border-line p-2 md:hidden">
          {SearchBox}
          <select
            value={currentId ?? ""}
            onChange={(e) => setActiveId(e.target.value)}
            aria-label="Documentation section"
            className="w-full rounded border border-line bg-ink/40 px-2 py-1.5 text-xs text-text focus:border-amber focus:outline-none"
          >
            {groups.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.ids.map((id) => (
                  <option key={id} value={id}>
                    {byId.get(id)?.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {current ? (
            <article className="mx-auto max-w-3xl space-y-3 p-5">
              <div className="flex items-center gap-2 border-b border-line pb-3">
                <current.icon size={18} className="text-amber" />
                <h1 className="text-lg font-semibold text-text">{current.title}</h1>
              </div>
              {current.blocks.map((b, i) => (
                <Block key={i} b={b} />
              ))}
            </article>
          ) : (
            <p className="p-6 text-sm text-faint">Select a topic to begin.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
