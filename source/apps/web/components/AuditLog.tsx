"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Clock3, RefreshCw, Search, ShieldCheck } from "lucide-react";
import type { AuditCategory, AuditEntry, AuditSummary } from "@daimon-os/shared";
import { api } from "@/lib/api";
import { useConfigStore } from "@/stores/config";

const CATEGORY_STYLE: Record<AuditCategory, string> = {
  configuration: "border-plum/40 bg-plum/10 text-plum",
  work: "border-sky/40 bg-sky/10 text-sky",
  security: "border-amber/40 bg-amber/10 text-amber",
};

const OUTCOME_STYLE: Record<AuditEntry["outcome"], string> = {
  success: "text-mint",
  warning: "text-amber",
  failure: "text-rust",
};

export function AuditLog() {
  const projects = useConfigStore((state) => state.projects);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [category, setCategory] = useState<AuditCategory | "">("");
  const [projectId, setProjectId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextEntries, nextSummary] = await Promise.all([
        api.audit.list({
          category: category || undefined,
          projectId: projectId || undefined,
          q: search.trim() || undefined,
          limit: 200,
        }),
        api.audit.summary(),
      ]);
      setEntries(nextEntries);
      setSummary(nextSummary);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audit log could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [category, projectId, search]);

  useEffect(() => {
    const debounce = window.setTimeout(() => void refresh(), 200);
    const poll = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(debounce);
      window.clearInterval(poll);
    };
  }, [refresh]);

  const loadMore = async () => {
    const oldest = entries[entries.length - 1];
    if (!oldest) return;
    setLoadingMore(true);
    setError(null);
    try {
      const older = await api.audit.list({
        category: category || undefined,
        projectId: projectId || undefined,
        q: search.trim() || undefined,
        beforeMs: Date.parse(oldest.createdAt),
        beforeId: oldest.id,
        limit: 200,
      });
      setEntries((current) => [...current, ...older]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Older audit entries could not be loaded");
    } finally {
      setLoadingMore(false);
    }
  };

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [String(project.id), project.name])),
    [projects],
  );

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-ink p-4 lg:p-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-text">
              <ShieldCheck size={20} className="text-amber" />
              <h1 className="text-lg font-semibold">Audit log</h1>
            </div>
            <p className="mt-1 text-xs text-soft">
              Redacted configuration and work history. Entries expire automatically after exactly five days.
            </p>
          </div>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded border border-line px-3 py-2 text-xs text-soft hover:border-amber hover:text-text disabled:opacity-40"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {[
            ["Retained", summary?.total ?? 0, "text-text"],
            ["Configuration", summary?.configuration ?? 0, "text-plum"],
            ["Work", summary?.work ?? 0, "text-sky"],
            ["Security", summary?.security ?? 0, "text-amber"],
            ["Retention", `${summary?.retentionDays ?? 5} days`, "text-mint"],
          ].map(([label, value, color]) => (
            <article key={String(label)} className="rounded border border-line bg-panel p-3">
              <p className="text-[10px] uppercase tracking-wide text-faint">{label}</p>
              <p className={clsx("mt-1 text-lg font-semibold", color)}>{value}</p>
            </article>
          ))}
        </section>

        <section className="grid gap-2 rounded border border-line bg-panel p-3 md:grid-cols-[minmax(0,1fr)_180px_220px]">
          <label className="relative">
            <Search size={13} className="absolute left-2.5 top-2.5 text-faint" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search action, summary, or entity id"
              className="w-full rounded border border-line bg-ink py-2 pl-8 pr-3 text-xs text-text outline-none focus:border-amber"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as AuditCategory | "")}
            className="rounded border border-line bg-ink px-2.5 py-2 text-xs text-text outline-none focus:border-amber"
          >
            <option value="">All categories</option>
            <option value="configuration">Configuration</option>
            <option value="work">Work</option>
            <option value="security">Security</option>
          </select>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="rounded border border-line bg-ink px-2.5 py-2 text-xs text-text outline-none focus:border-amber"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </section>

        {error && <p className="rounded border border-rust/40 bg-rust/5 px-3 py-2 text-xs text-rust">{error}</p>}

        <section className="overflow-hidden rounded border border-line bg-panel">
          {entries.length === 0 && !loading ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-1 text-center">
              <ShieldCheck size={21} className="text-mint" />
              <p className="text-xs font-medium text-text">No retained audit entries match</p>
              <p className="text-[11px] text-faint">New configuration and agent work events appear here automatically.</p>
            </div>
          ) : (
            <div className="divide-y divide-line">
              {entries.map((entry) => {
                const metadata = Object.entries(entry.metadata);
                return (
                  <article key={entry.id} className="grid gap-2 p-3 hover:bg-raised/30 lg:grid-cols-[170px_120px_minmax(0,1fr)]">
                    <div className="text-[10px] text-faint">
                      <p className="flex items-center gap-1 font-mono text-soft">
                        <Clock3 size={10} /> {new Date(entry.createdAt).toLocaleString()}
                      </p>
                      <p className="mt-1">expires {new Date(entry.expiresAt).toLocaleString()}</p>
                    </div>
                    <div className="flex flex-wrap content-start gap-1.5">
                      <span className={clsx("rounded border px-1.5 py-0.5 text-[9px] uppercase", CATEGORY_STYLE[entry.category])}>
                        {entry.category}
                      </span>
                      <span className={clsx("text-[10px]", OUTCOME_STYLE[entry.outcome])}>{entry.outcome}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-mono text-[10px] text-amber">{entry.action}</span>
                        <span className="text-[10px] text-faint">by {entry.actor}</span>
                        {entry.projectId && (
                          <span className="text-[10px] text-sky">{projectNames.get(entry.projectId) ?? entry.projectId}</span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-text">{entry.summary}</p>
                      {(entry.entityType || entry.entityId) && (
                        <p className="mt-1 truncate font-mono text-[10px] text-faint">
                          {[entry.entityType, entry.entityId].filter(Boolean).join(":")}
                        </p>
                      )}
                      {metadata.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {metadata.map(([key, value]) => (
                            <span key={key} className="rounded bg-ink px-1.5 py-0.5 font-mono text-[9px] text-soft">
                              {key}={String(value)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {entries.length >= 200 && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="self-center rounded border border-line px-4 py-2 text-xs text-soft hover:border-amber hover:text-text disabled:opacity-40"
          >
            {loadingMore ? "Loading…" : "Load older retained entries"}
          </button>
        )}
      </div>
    </main>
  );
}
