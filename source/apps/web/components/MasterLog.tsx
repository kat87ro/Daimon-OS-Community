"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { channelRegistry } from "@/lib/gateway/ChannelRegistry";
import { gateway } from "@/lib/gateway/GatewayClient";
import { providerSupportsAdHocChat, selectReportedChatModel } from "@/lib/masterChat";
import { useAppLogStore } from "@/stores/applog";
import { useConfigStore } from "@/stores/config";
import { useLayoutStore } from "@/stores/layout";
import { useUiStore } from "@/stores/ui";
import { useAttentionStore } from "@/stores/attention";
import { useSessionStore } from "@/stores/sessions";
import { TerminalPane } from "./grid/TerminalPane";

const LEVEL_COLOR = { info: "text-soft", warn: "text-amber", error: "text-rust" } as const;

export function MasterLog({ embedded = false }: { embedded?: boolean } = {}) {
  const drawerOpen = useAppLogStore((s) => s.drawerOpen);
  const open = embedded || drawerOpen;
  const toggle = useAppLogStore((s) => s.toggleDrawer);
  const entries = useAppLogStore((s) => s.entries);
  const setAll = useAppLogStore((s) => s.setAll);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [tab, setTab] = useState<"chat" | "inbox" | "log">("chat");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<{ key: string; message: string } | null>(null);
  const attention = useAttentionStore((state) => state.records);
  const tasks = useAttentionStore((state) => state.tasks);
  const loading = useAttentionStore((state) => state.loading);
  const stale = useAttentionStore((state) => state.stale);
  const inboxError = useAttentionStore((state) => state.error);
  const refreshInbox = useAttentionStore((state) => state.refresh);
  const projects = useConfigStore((s) => s.projects);
  const agents = useConfigStore((s) => s.agents);
  const setActiveProject = useLayoutStore((s) => s.setActiveProject);
  const setFocused = useLayoutStore((s) => s.setFocused);
  const openModal = useUiStore((s) => s.openModal);

  useEffect(() => {
    if (open && entries.length === 0) {
      void api.log.list().then(setAll).catch(() => {});
    }
  }, [open, entries.length, setAll]);

  useEffect(() => {
    if (!open || tab !== "inbox") return;
    void refreshInbox();
  }, [open, refreshInbox, tab]);

  useEffect(() => {
    if (open && tab === "log") bottomRef.current?.scrollIntoView();
  }, [entries.length, open, tab]);

  if (!open) return null;

  return (
    <div className={clsx(
      "flex min-h-0 flex-col bg-panel",
      embedded ? "h-full flex-1" : "h-72 flex-none border-t border-line",
    )}>
      <div className="flex flex-none items-center justify-between border-b border-line px-3 py-1.5">
        <div className="flex items-center gap-1 rounded border border-line bg-ink p-0.5">
          <button
            onClick={() => setTab("chat")}
            className={clsx(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs",
              tab === "chat" ? "bg-raised text-text" : "text-soft hover:text-text",
            )}
          >
            <MessageSquare size={12} /> Chats
          </button>
          <button
            onClick={() => setTab("inbox")}
            className={clsx(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs",
              tab === "inbox" ? "bg-raised text-text" : "text-soft hover:text-text",
            )}
          >
            <Bot size={12} /> Needs input
            {attention.length > 0 && (
              <span className="rounded bg-amber/20 px-1 text-[9px] text-amber">{attention.length}</span>
            )}
          </button>
          <button
            onClick={() => setTab("log")}
            className={clsx(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs",
              tab === "log" ? "bg-raised text-text" : "text-soft hover:text-text",
            )}
          >
            <ScrollText size={12} /> Application log
          </button>
        </div>
        <div className="flex items-center gap-2">
          {tab === "inbox" && (
            <button
              onClick={() => void refreshInbox()}
              className="text-faint hover:text-soft disabled:opacity-40"
              title="Refresh master chat"
              disabled={loading}
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          )}
          {!embedded && (
            <button onClick={toggle} className="text-faint hover:text-soft" title="Close command center">
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      {tab === "chat" ? (
        <MasterChatWorkspace />
      ) : tab === "inbox" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {stale && (
            <p className="mb-2 rounded border border-amber/35 bg-amber/5 px-2.5 py-1.5 text-[10px] text-amber">
              Master Chat data is stale{inboxError ? `: ${inboxError}` : ". Refreshing…"}
            </p>
          )}
          {(() => {
            const durable = attention.map((item) => {
              const task = tasks.find((candidate) => candidate.id === item.taskId);
              return {
                key: `attention:${item.id}`,
                projectId: item.projectId,
                taskId: item.taskId,
                runId: item.runId,
                attentionId: item.id,
                channel: item.channel,
                link: item.link,
                options: item.options,
                agentName:
                  task?.assignedAgentName ??
                  agents.find((agent) => agent.id === item.agentId)?.name ??
                  "Unassigned agent",
                kind: item.kind,
                message: item.message,
                createdAt: item.createdAt,
              };
            });
            const items = durable.sort(
              (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
            );
            if (items.length === 0) {
              return (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                  <MessageSquare size={20} className="text-mint" />
                  <p className="text-xs font-medium text-text">No agent needs attention</p>
                  <p className="text-[11px] text-faint">
                    Explicit agent questions, failed runs and review decisions from every project appear here.
                  </p>
                </div>
              );
            }
            return (
              <div className="grid gap-2 lg:grid-cols-2">
                {items.map((item) => {
                  const project = projects.find((candidate) => candidate.id === item.projectId);
                  const root = project?.parentProjectId
                    ? projects.find((candidate) => candidate.id === project.parentProjectId)
                    : project;
                  const projectLabel = project?.parentProjectId
                    ? `${root?.name ?? "Unknown project"} / ${project.name}`
                    : (project?.name ?? "Unknown project");
                  const canReply = Boolean(item.channel) && item.kind === "input_required";
                  const draft = drafts[item.key] ?? "";
                  const goTo = () => {
                    if (item.projectId) setActiveProject(item.projectId);
                    if (item.channel) {
                      setFocused(item.channel);
                      channelRegistry.focus(item.channel);
                    } else if ("taskId" in item && item.taskId) {
                      openModal(
                        item.kind === "waiting_review"
                          ? { type: "review", taskId: item.taskId }
                          : { type: "task", projectId: item.projectId!, id: item.taskId },
                      );
                    }
                  };
                  return (
                    <article key={item.key} className="rounded border border-line bg-ink p-2.5">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-plum">{item.agentName}</p>
                          <p className="truncate text-[10px] text-sky">{projectLabel}</p>
                        </div>
                        <span
                          className={clsx(
                            "rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide",
                            item.kind === "failed" || item.kind === "policy_blocked"
                              ? "bg-rust/15 text-rust"
                              : item.kind === "waiting_review"
                                ? "bg-amber/15 text-amber"
                                : "bg-sky/15 text-sky",
                          )}
                        >
                          {item.kind.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-3 text-[11px] leading-relaxed text-soft">
                        {item.message}
                      </p>
                      {"options" in item && item.options && item.options.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {item.options.map((option) => (
                            <button
                              key={option}
                              disabled={replying === item.key}
                              onClick={async () => {
                                if (!("attentionId" in item) || !item.attentionId) return;
                                setReplying(item.key);
                                setReplyError(null);
                                try {
                                  await api.attention.respond(item.attentionId, option);
                                  await refreshInbox();
                                } catch (error) {
                                  setReplyError({
                                    key: item.key,
                                    message: error instanceof Error ? error.message : "Reply delivery failed",
                                  });
                                } finally {
                                  setReplying(null);
                                }
                              }}
                              className="rounded border border-sky/40 px-2 py-1 text-[10px] text-sky hover:bg-sky/10 disabled:opacity-40"
                            >
                              {option}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 flex gap-1.5">
                        <button
                          onClick={goTo}
                          className="flex items-center gap-1 rounded border border-line px-2 py-1 text-[10px] text-soft hover:border-amber hover:text-text"
                        >
                          <ExternalLink size={10} />
                          {item.channel ? "Open agent" : item.kind === "waiting_review" ? "Open decision" : "Open task"}
                        </button>
                      </div>
                      {canReply && item.channel && (
                        <div className="mt-2 flex gap-1.5">
                          <input
                            value={draft}
                            onChange={(event) =>
                              setDrafts((current) => ({ ...current, [item.key]: event.target.value }))
                            }
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" || !draft.trim()) return;
                              if (!("attentionId" in item) || !item.attentionId) return;
                              setReplying(item.key);
                              setReplyError(null);
                              void api.attention.respond(item.attentionId, draft.trim())
                                .then(async () => {
                                  setDrafts((current) => ({ ...current, [item.key]: "" }));
                                  await refreshInbox();
                                })
                                .catch((error) => setReplyError({
                                  key: item.key,
                                  message: error instanceof Error ? error.message : "Reply delivery failed",
                                }))
                                .finally(() => setReplying(null));
                            }}
                            placeholder="Reply to this agent…"
                            className="min-w-0 flex-1 rounded border border-line bg-raised px-2 py-1 text-[11px] text-text outline-none placeholder:text-faint focus:border-amber"
                          />
                          <button
                            disabled={!draft.trim() || replying === item.key}
                            onClick={async () => {
                              if (!("attentionId" in item) || !item.attentionId) return;
                              setReplying(item.key);
                              setReplyError(null);
                              try {
                                await api.attention.respond(item.attentionId, draft.trim());
                                setDrafts((current) => ({ ...current, [item.key]: "" }));
                                await refreshInbox();
                              } catch (error) {
                                setReplyError({
                                  key: item.key,
                                  message: error instanceof Error ? error.message : "Reply delivery failed",
                                });
                              } finally {
                                setReplying(null);
                              }
                            }}
                            className="rounded bg-amber px-2 text-ink disabled:opacity-40"
                            title="Send reply"
                          >
                            <Send size={11} />
                          </button>
                        </div>
                      )}
                      {replyError?.key === item.key && replying !== item.key && (
                        <p className="mt-1.5 text-[10px] text-rust">{replyError.message}</p>
                      )}
                    </article>
                  );
                })}
              </div>
            );
          })()}
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[11px] leading-relaxed">
        {entries.length === 0 && <p className="text-faint">no log entries yet</p>}
        {entries.map((e, i) => {
          const hasDetail = Boolean(e.detail);
          const isOpen = expanded === i;
          return (
            <div key={i}>
              <div
                className={clsx("flex items-start gap-2", hasDetail && "cursor-pointer hover:bg-raised/40")}
                onClick={() => hasDetail && setExpanded(isOpen ? null : i)}
              >
                <span className="flex-none text-faint">{new Date(e.ts).toLocaleTimeString()}</span>
                <span className={clsx("flex-none uppercase", LEVEL_COLOR[e.level])}>{e.source}</span>
                <span className="min-w-0 flex-1 text-soft">{e.message}</span>
                {hasDetail &&
                  (isOpen ? (
                    <ChevronDown size={12} className="flex-none text-faint" />
                  ) : (
                    <ChevronRight size={12} className="flex-none text-faint" />
                  ))}
              </div>
              {hasDetail && isOpen && (
                <pre className="mt-1 mb-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border border-line bg-ink/60 p-2 text-[11px] text-soft">
                  {e.detail}
                </pre>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      )}
    </div>
  );
}

/**
 * Provider-native conversations live in Master Chat, not in the project grid.
 * They intentionally reuse the supervised PTY transport while carrying no
 * configured Agent, project, team, tool, MCP, skill, or secret authority.
 */
function MasterChatWorkspace() {
  const providers = useConfigStore((state) => state.providers);
  const loadAll = useConfigStore((state) => state.loadAll);
  const sessions = useSessionStore((state) => state.sessions);
  const openModal = useUiStore((state) => state.openModal);
  const chatSessions = Object.values(sessions)
    .filter((session) => session.kind === "chat")
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const availableProviders = providers.filter(providerSupportsAdHocChat);
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [activeChat, setActiveChat] = useState<string | null>(null);
  const [creating, setCreating] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = availableProviders.find((provider) => provider.id === providerId);

  useEffect(() => {
    if (selectedProvider) return;
    setProviderId(availableProviders[0]?.id ?? "");
  }, [availableProviders, selectedProvider]);

  useEffect(() => {
    if (!selectedProvider) {
      setModel("");
      return;
    }
    setModel((current) => selectReportedChatModel(selectedProvider, current));
  }, [selectedProvider]);

  useEffect(() => {
    if (activeChat && chatSessions.some((session) => session.id === activeChat)) return;
    setActiveChat((chatSessions[0]?.id as string | undefined) ?? null);
  }, [activeChat, chatSessions]);

  const startChat = () => {
    if (!selectedProvider) return;
    if (selectedProvider.models.length > 0 && !model) {
      setError("Select a model reported by the provider.");
      return;
    }
    setError(null);
    const channel = gateway.spawnChat(selectedProvider, model || undefined);
    setActiveChat(channel);
    setCreating(false);
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-56 flex-none flex-col border-r border-line bg-ink/40">
        <div className="flex items-center justify-between border-b border-line px-2.5 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-faint">
            Conversations
          </span>
          <button
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
            className="rounded p-1 text-soft hover:bg-raised hover:text-amber"
            title="New provider chat"
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {chatSessions.length === 0 && (
            <p className="px-2 py-3 text-[10px] leading-relaxed text-faint">
              No conversations yet. A chat starts directly with a provider and does not require an Agent.
            </p>
          )}
          {chatSessions.map((session) => (
            <button
              key={session.id}
              onClick={() => {
                setActiveChat(session.id as string);
                setCreating(false);
              }}
              className={clsx(
                "mb-1 w-full rounded border px-2 py-1.5 text-left",
                activeChat === session.id && !creating
                  ? "border-amber/50 bg-amber/5"
                  : "border-transparent hover:border-line hover:bg-raised/50",
              )}
            >
              <p className="truncate text-[11px] font-medium text-text">{session.agentName}</p>
              <p className="truncate text-[9px] text-sky">
                {session.model ?? "Provider native default"}
              </p>
              <p className="mt-0.5 text-[9px] text-faint">{session.statusLabel}</p>
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setError(null);
            setCreating(true);
          }}
          className="m-2 flex items-center justify-center gap-1.5 rounded border border-line bg-raised px-2 py-1.5 text-[11px] text-soft hover:border-amber hover:text-text"
        >
          <MessageSquarePlus size={12} /> New chat
        </button>
      </aside>

      <section className="min-w-0 flex-1 p-2">
        {creating ? (
          <div className="flex h-full items-center justify-center">
            <div className="w-full max-w-xl rounded-lg border border-line bg-ink p-4">
              <div className="mb-4 flex items-start gap-2">
                <MessageSquarePlus size={18} className="mt-0.5 flex-none text-amber" />
                <div>
                  <h2 className="text-sm font-semibold text-text">Start a new provider chat</h2>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
                    No Agent is created or required. This supervised chat receives no project access,
                    Agent tools, MCP servers, skills, or vault secrets.
                  </p>
                </div>
              </div>

              {availableProviders.length === 0 ? (
                <div className="rounded border border-amber/30 bg-amber/5 p-3">
                  <p className="text-xs text-soft">No enabled interactive provider is configured.</p>
                  <button
                    onClick={() => openModal({ type: "provider" })}
                    className="mt-2 rounded border border-line px-2.5 py-1.5 text-[11px] text-amber hover:border-amber"
                  >
                    Add provider
                  </button>
                </div>
              ) : (
                <div className="grid gap-3">
                  <label className="grid gap-1 text-xs text-soft">
                    Provider
                    <select
                      value={providerId}
                      onChange={(event) => {
                        setProviderId(event.target.value);
                        setError(null);
                      }}
                      className="rounded border border-line bg-raised px-2 py-2 text-xs text-text outline-none focus:border-amber"
                    >
                      {availableProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>{provider.name}</option>
                      ))}
                    </select>
                  </label>

                  <label className="grid gap-1 text-xs text-soft">
                    Model
                    <select
                      value={model}
                      onChange={(event) => {
                        setModel(event.target.value);
                        setError(null);
                      }}
                      className="rounded border border-line bg-raised px-2 py-2 text-xs text-text outline-none focus:border-amber"
                    >
                      {selectedProvider?.models.length ? (
                        selectedProvider.models.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}{entry.label !== entry.id ? ` — ${entry.id}` : ""}
                          </option>
                        ))
                      ) : (
                        <option value="">Provider native default</option>
                      )}
                    </select>
                  </label>

                  <div className="flex items-center justify-between gap-3 rounded border border-sky/25 bg-sky/5 px-2.5 py-2">
                    <p className="text-[10px] leading-relaxed text-faint">
                      Model options are the saved live catalog reported by this provider. No built-in model list is used.
                    </p>
                    <button
                      disabled={!selectedProvider || refreshing}
                      onClick={async () => {
                        if (!selectedProvider) return;
                        setRefreshing(true);
                        setError(null);
                        try {
                          await api.providers.refreshModels(selectedProvider.id);
                          await loadAll();
                        } catch (refreshError) {
                          setError(
                            refreshError instanceof Error
                              ? refreshError.message
                              : "Provider model refresh failed",
                          );
                        } finally {
                          setRefreshing(false);
                        }
                      }}
                      className="flex flex-none items-center gap-1 rounded border border-line px-2 py-1 text-[10px] text-sky hover:border-sky disabled:opacity-40"
                    >
                      {refreshing
                        ? <LoaderCircle size={11} className="animate-spin" />
                        : <RefreshCw size={11} />}
                      Refresh models
                    </button>
                  </div>

                  {error && (
                    <p className="rounded border border-rust/40 bg-rust/10 px-2.5 py-1.5 text-[10px] text-rust">
                      {error}
                    </p>
                  )}
                  <div className="flex justify-end gap-2">
                    {chatSessions.length > 0 && (
                      <button
                        onClick={() => setCreating(false)}
                        className="rounded border border-line px-3 py-1.5 text-xs text-soft hover:text-text"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      disabled={!selectedProvider || (selectedProvider.models.length > 0 && !model)}
                      onClick={startChat}
                      className="rounded bg-amber px-3 py-1.5 text-xs font-medium text-ink hover:bg-amber/90 disabled:opacity-40"
                    >
                      Start chat
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : activeChat ? (
          <TerminalPane channel={activeChat} embedded />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquare size={22} className="text-mint" />
            <p className="text-xs font-medium text-text">Start a provider chat</p>
            <button
              onClick={() => setCreating(true)}
              className="rounded border border-line px-3 py-1.5 text-[11px] text-amber hover:border-amber"
            >
              New chat
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
