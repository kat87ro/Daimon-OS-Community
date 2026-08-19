"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Check, ClipboardList, FileText, RotateCcw } from "lucide-react";
import { api, type ExecutionRun } from "@/lib/api";
import { useConfigStore } from "@/stores/config";
import { useTaskStore } from "@/stores/tasks";
import { useUiStore } from "@/stores/ui";
import { Modal } from "./Modal";

type FileMeta = { name: string; relPath: string; ext: string; size: number; mtimeMs: number };

const MD_EXT = new Set([".md", ".markdown"]);
const fmtSize = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Inline markdown: **bold** and `code`. */
function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**"))
      return (
        <strong key={i} className="font-semibold text-text">
          {p.slice(2, -2)}
        </strong>
      );
    if (p.startsWith("`") && p.endsWith("`"))
      return (
        <code key={i} className="rounded bg-ink px-1 font-mono text-[12px] text-amber">
          {p.slice(1, -1)}
        </code>
      );
    return <span key={i}>{p}</span>;
  });
}

/** Tiny dependency-free markdown renderer: headings, lists, code fences, paragraphs. */
function Markdown({ src }: { src: string }) {
  const lines = src.split("\n");
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const ln = lines[i] ?? "";
    if (ln.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        buf.push(lines[i] ?? "");
        i++;
      }
      i++;
      out.push(
        <pre
          key={key++}
          className="overflow-x-auto whitespace-pre rounded border border-line bg-ink p-2.5 font-mono text-[12px] text-soft"
        >
          {buf.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (h) {
      const level = (h[1] ?? "").length;
      const cls = level <= 1 ? "text-lg font-bold" : level === 2 ? "text-base font-semibold" : "text-sm font-semibold";
      out.push(
        <div key={key++} className={clsx("mt-3 text-text", cls)}>
          {renderInline(h[2] ?? "")}
        </div>,
      );
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(ln);
    if (bullet) {
      out.push(
        <div key={key++} className="ml-3 flex gap-2 text-soft">
          <span className="text-faint">•</span>
          <span>{renderInline(bullet[1] ?? "")}</span>
        </div>,
      );
      i++;
      continue;
    }
    const num = /^\s*\d+\.\s+/.test(ln);
    if (num) {
      out.push(
        <div key={key++} className="ml-3 text-soft">
          {renderInline(ln.trim())}
        </div>,
      );
      i++;
      continue;
    }
    if (ln.trim() === "") {
      out.push(<div key={key++} className="h-2" />);
      i++;
      continue;
    }
    out.push(
      <p key={key++} className="text-soft">
        {renderInline(ln)}
      </p>,
    );
    i++;
  }
  return <div className="flex flex-col gap-1 text-[13px] leading-relaxed">{out}</div>;
}

export function ReviewModal({ taskId }: { taskId: string }) {
  const task = useTaskStore((s) => s.tasks[taskId]);
  const saveTask = useTaskStore((s) => s.saveTask);
  const agents = useConfigStore((s) => s.agents);
  const closeModal = useUiStore((s) => s.closeModal);

  const [files, setFiles] = useState<FileMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // selected = "__instruction__" or a file relPath
  const [selected, setSelected] = useState<string>("__instruction__");
  const [body, setBody] = useState<{ content: string; truncated: boolean } | null>(null);
  const [loadingBody, setLoadingBody] = useState(false);
  const [run, setRun] = useState<ExecutionRun | null>(null);
  const [capturedDiff, setCapturedDiff] = useState<string>("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [acting, setActing] = useState(false);

  const projectId = task?.projectId;

  useEffect(() => {
    let cancelled = false;
    api.runs.list(taskId)
      .then(async (runs) => {
        const latest = runs[0] ?? null;
        if (cancelled) return;
        setRun(latest);
        if (latest?.diffArtifactHash) {
          const diff = await api.runs.diff(latest.id);
          if (!cancelled) {
            setCapturedDiff(diff || "(No file changes were produced.)");
            setSelected("__diff__");
          }
        }
      })
      .catch((error) => !cancelled && setActionError(error instanceof Error ? error.message : "could not load run evidence"));
    return () => { cancelled = true; };
  }, [taskId]);

  // load the deliverable list once, and auto-select the newest markdown file so
  // the reviewer sees the agent's OUTPUT first (not just the instruction)
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoadingList(true);
    api.projects
      .deliverables(projectId)
      .then((res) => {
        if (cancelled) return;
        setFiles(res.files);
      })
      .catch((e) => !cancelled && setListError(e instanceof Error ? e.message : "could not list files"))
      .finally(() => !cancelled && setLoadingList(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // load the selected file's content
  useEffect(() => {
    if (!projectId || selected === "__instruction__" || selected === "__diff__") {
      setBody(null);
      return;
    }
    let cancelled = false;
    setLoadingBody(true);
    api.projects
      .file(projectId, selected)
      .then((res) => !cancelled && setBody({ content: res.content, truncated: res.truncated }))
      .catch(() => !cancelled && setBody({ content: "Could not read this file.", truncated: false }))
      .finally(() => !cancelled && setLoadingBody(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, selected]);

  const selectedExt = useMemo(() => files.find((f) => f.relPath === selected)?.ext ?? "", [files, selected]);

  if (!task) {
    return (
      <Modal title="Review task">
        <p className="text-xs text-faint">task not found</p>
      </Modal>
    );
  }

  const agent = task.assignedAgentName ?? agents.find((a) => a.id === task.assignedAgentId)?.name ?? "—";

  return (
    <Modal title={`Review — ${task.title}`} xwide flush>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* header */}
        <div className="flex flex-none items-center gap-3 border-b border-line px-4 py-2.5 text-xs">
          <span className="text-faint">Assigned to</span>
          <span className="font-medium text-plum">{agent}</span>
          <span className="ml-3 text-faint">Status</span>
          <span className="rounded border border-sky/50 px-1.5 py-0.5 font-mono text-[11px] text-sky">
            {task.status}
          </span>
        </div>

        {/* two-pane: deliverable list + content */}
        <div className="flex min-h-0 flex-1">
          <div className="w-64 flex-none overflow-y-auto border-r border-line p-2">
            <button
              onClick={() => setSelected("__instruction__")}
              className={clsx(
                "mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                selected === "__instruction__"
                  ? "bg-raised font-medium text-text"
                  : "text-soft hover:bg-raised/60 hover:text-text",
              )}
            >
              <ClipboardList size={13} className="flex-none text-faint" />
              <span className="truncate">Task instruction</span>
            </button>
            <button
              onClick={() => setSelected("__diff__")}
              className={clsx(
                "mb-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                selected === "__diff__" ? "bg-raised font-medium text-text" : "text-soft hover:bg-raised/60 hover:text-text",
              )}
            >
              <FileText size={13} className="flex-none text-mint" />
              <span className="truncate">Captured Git diff</span>
            </button>
            <div className="mb-1 mt-3 px-2 text-[10px] uppercase tracking-wide text-faint">
              Canonical files (pre-promotion) {files.length > 0 && `(${files.length})`}
            </div>
            {loadingList && <p className="px-2 py-1 text-[11px] text-faint">scanning project folder…</p>}
            {listError && <p className="px-2 py-1 text-[11px] text-rust">{listError}</p>}
            {!loadingList && !listError && files.length === 0 && (
              <p className="px-2 py-1 text-[11px] leading-relaxed text-faint">
                No deliverable files found in the project folder yet.
              </p>
            )}
            {files.map((f) => (
              <button
                key={f.relPath}
                onClick={() => setSelected(f.relPath)}
                title={f.relPath}
                className={clsx(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs",
                  selected === f.relPath
                    ? "bg-raised font-medium text-text"
                    : "text-soft hover:bg-raised/60 hover:text-text",
                )}
              >
                <FileText
                  size={13}
                  className={clsx("flex-none", MD_EXT.has(f.ext) ? "text-mint" : "text-faint")}
                />
                <span className="truncate">{f.name}</span>
                <span className="ml-auto flex-none font-mono text-[10px] text-faint">{fmtSize(f.size)}</span>
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {selected === "__instruction__" ? (
              <>
                <div className="mb-2 text-xs uppercase tracking-wide text-faint">Task / instruction</div>
                <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-soft">
                  {task.description?.trim() || task.title}
                </div>
              </>
            ) : selected === "__diff__" ? (
              <>
                <div className="mb-3 text-xs uppercase tracking-wide text-faint">
                  Exact review subject {run?.subjectHash ? `— ${run.subjectHash}` : ""}
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-soft">
                  {capturedDiff || "Loading captured evidence…"}
                </pre>
              </>
            ) : loadingBody ? (
              <p className="text-xs text-faint">loading {selected}…</p>
            ) : body ? (
              <>
                <div className="mb-3 flex items-center gap-2">
                  <FileText size={13} className="text-mint" />
                  <span className="font-mono text-xs text-soft">{selected}</span>
                  {body.truncated && (
                    <span className="rounded border border-amber/50 px-1.5 py-0.5 text-[10px] text-amber">
                      truncated — large file
                    </span>
                  )}
                </div>
                {MD_EXT.has(selectedExt) ? (
                  <Markdown src={body.content} />
                ) : (
                  <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-soft">
                    {body.content}
                  </pre>
                )}
              </>
            ) : (
              <p className="text-xs text-faint">select a deliverable to view it</p>
            )}
          </div>
        </div>

        {/* sticky actions */}
        <div className="flex flex-none items-center gap-2 border-t border-line px-4 py-3">
          {actionError && <span className="mr-2 text-[11px] text-rust">{actionError}</span>}
          <button
            disabled={acting || !run?.subjectHash}
            onClick={async () => {
              if (!run?.subjectHash) return;
              setActing(true);
              setActionError(null);
              try {
                if (run.status === "waiting_review") await api.runs.approve(run.id, run.subjectHash);
                await api.runs.promote(run.id, run.subjectHash);
                closeModal();
              } catch (error) {
                setActionError(error instanceof Error ? error.message : "approval or promotion failed");
              } finally {
                setActing(false);
              }
            }}
            className="flex items-center gap-1.5 rounded bg-mint/15 px-3 py-2 text-xs font-medium text-mint hover:bg-mint/25 disabled:opacity-50"
          >
            <Check size={13} /> {acting ? "Applying…" : "Approve exact hash & apply locally"}
          </button>
          <button
            onClick={async () => {
              await saveTask({ ...task, status: "backlog" });
              closeModal();
            }}
            className="flex items-center gap-1.5 rounded border border-line px-3 py-2 text-xs text-soft hover:border-amber hover:text-amber"
          >
            <RotateCcw size={13} /> Request changes
          </button>
          <span className="ml-2 text-[11px] text-faint">
            Promotion applies locally without commit, merge, push, or deploy; requesting changes invalidates this captured run.
          </span>
          <button
            onClick={closeModal}
            className="ml-auto rounded border border-line px-3 py-2 text-xs text-faint hover:text-soft"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
