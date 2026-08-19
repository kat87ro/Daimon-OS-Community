"use client";

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { FusionRun, FusionRunStatus } from "@daimon-os/shared";
import { api, type FusionRunDetail } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { Modal } from "./Modal";

const STATUS_CLS: Record<FusionRunStatus, string> = {
  running: "text-sky border-sky",
  completed: "text-mint border-mint",
  degraded: "text-amber border-amber",
  failed: "text-rust border-rust",
};

function StatusPill({ status }: { status: FusionRunStatus }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_CLS[status]}`}
    >
      {status}
    </span>
  );
}

function fmt(ts?: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function FusionRunsModal({ agentId }: { agentId: string }) {
  const agents = useConfigStore((s) => s.agents);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const [runs, setRuns] = useState<FusionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FusionRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    api.fusion
      .runs(agentId)
      .then((r) => alive && setRuns(r))
      .catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [agentId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let alive = true;
    setDetailLoading(true);
    setDetail(null);
    api.fusion
      .run(selectedId)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(String(e?.message ?? e)))
      .finally(() => alive && setDetailLoading(false));
    return () => {
      alive = false;
    };
  }, [selectedId]);

  const title = `Fusion runs — ${agentName(agentId)}`;

  // ---- detail view ----
  if (selectedId) {
    return (
      <Modal title={title} wide>
        <button
          onClick={() => setSelectedId(null)}
          className="mb-3 flex items-center gap-1 text-xs text-faint hover:text-soft"
        >
          <ChevronLeft size={12} /> Back to runs
        </button>
        {detailLoading && <p className="text-xs text-faint">Loading run…</p>}
        {detail && (
          <div className="flex flex-col gap-3 text-xs">
            <div className="flex items-center gap-2">
              <StatusPill status={detail.status} />
              <span className="font-mono text-[10px] text-faint">{detail.id}</span>
            </div>
            <div className="rounded border border-line bg-raised p-2">
              <div className="text-soft">Task</div>
              <div className="mt-1 whitespace-pre-wrap text-text">{detail.task}</div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-soft">
              <div>
                Judge: <span className="text-text">{agentName(detail.judgeAgentId)}</span>{" "}
                <span className="text-faint">({detail.judgeStatus})</span>
              </div>
              <div>
                Started: <span className="text-text">{fmt(detail.startedAt)}</span>
              </div>
              <div>
                Completed: <span className="text-text">{fmt(detail.completedAt)}</span>
              </div>
              {detail.failureReason && (
                <div className="text-rust">Failure: {detail.failureReason}</div>
              )}
            </div>
            {detail.judgeAnalysis && (
              <div className="rounded border border-line bg-raised p-2">
                <div className="text-soft">Judge analysis</div>
                <div className="mt-1 whitespace-pre-wrap text-text">{detail.judgeAnalysis}</div>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <div className="text-soft">Panel results ({detail.panelResults.length})</div>
              {detail.panelResults.length === 0 && (
                <p className="text-[11px] text-faint">no panel results recorded</p>
              )}
              {detail.panelResults.map((p) => (
                <div key={p.id} className="rounded border border-line bg-raised p-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                        p.status === "ok" ? "text-mint border-mint" : "text-rust border-rust"
                      }`}
                    >
                      {p.status}
                    </span>
                    <span className="text-text">{agentName(p.agentId)}</span>
                    <span className="font-mono text-[10px] text-faint">{p.agentId}</span>
                    {p.latencyMs !== undefined && (
                      <span className="ml-auto font-mono text-[10px] text-faint">
                        {p.latencyMs} ms
                      </span>
                    )}
                  </div>
                  {p.output && (
                    <div className="mt-1 whitespace-pre-wrap text-[11px] text-text">{p.output}</div>
                  )}
                  {p.error && (
                    <div className="mt-1 whitespace-pre-wrap text-[11px] text-rust">{p.error}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>
    );
  }

  // ---- list view ----
  return (
    <Modal title={title} wide>
      {error && <p className="mb-2 text-xs text-rust">{error}</p>}
      {runs === null && !error && <p className="text-xs text-faint">Loading runs…</p>}
      {runs && runs.length === 0 && (
        <p className="text-xs text-faint">No fusion runs recorded for this agent yet.</p>
      )}
      {runs && runs.length > 0 && (
        <div className="flex flex-col gap-2">
          {runs.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelectedId(r.id)}
              className="flex flex-col gap-1 rounded border border-line bg-raised p-2 text-left hover:border-amber"
            >
              <div className="flex items-center gap-2">
                <StatusPill status={r.status} />
                <span className="truncate text-xs text-text">{r.task}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-faint">
                <span>start {fmt(r.startedAt)}</span>
                <span>end {fmt(r.completedAt)}</span>
                <span>judge {r.judgeStatus}</span>
                {r.failedPanelAgentIds.length > 0 && (
                  <span className="text-amber">{r.failedPanelAgentIds.length} panel failed</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
