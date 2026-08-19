"use client";

import {
  GATEWAY_CHANNEL,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  emptyMetrics,
  newSessionId,
} from "@daimon-os/shared";
import type {
  AgentDefinition,
  ClientFrame,
  ProviderConfig,
  ServerFrame,
  SpawnRequest,
  SystemPayload,
  TerminalSession,
} from "@daimon-os/shared";
import { gatewayWsProtocols, gatewayWsUrl } from "@/lib/env";
import { useAppLogStore } from "@/stores/applog";
import { useAttentionStore } from "@/stores/attention";
import { useConfigStore } from "@/stores/config";
import { useGatewayStore } from "@/stores/gateway";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/sessions";
import { useTaskStore } from "@/stores/tasks";
import { channelRegistry } from "./ChannelRegistry";

export interface SpawnOptions {
  kind: "agent" | "shell" | "chat";
  agent?: AgentDefinition;
  /** saved provider selected for an ad-hoc Master Chat conversation */
  provider?: ProviderConfig;
  taskPrompt?: string;
  /** per-run model override for agent spawns */
  model?: string;
  cwd?: string;
  command?: string;
  projectId?: string;
  displayName?: string;
  cols?: number;
  rows?: number;
}

/**
 * Charon's passenger — the ONE WebSocket for the whole tab. Routes incoming
 * frames by channel: stdout/stderr go straight to xterm via the registry
 * (no React), everything low-frequency lands in zustand stores.
 */
class GatewayClient {
  private ws: WebSocket | null = null;
  private backoff = RECONNECT_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  /** last seq seen per channel — used to request gap replay on reconnect */
  private lastSeq = new Map<string, number>();
  /**
   * Channels currently replaying scrollback (epoch ms until which stdin is
   * muted). Replayed output contains the shell's old terminal-identity
   * queries (DA, OSC color probes); xterm auto-answers every one, and those
   * answers would land in the LIVE shell as typed garbage ("1;2c…").
   */
  private replayMuteUntil = new Map<string, number>();

  connect(): void {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) return; // idempotent
    this.closedByUser = false;
    useGatewayStore.getState().setConnState("connecting");

    const ws = new WebSocket(gatewayWsUrl(), gatewayWsProtocols());
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = RECONNECT_MIN_MS;
      useGatewayStore.getState().setConnState("open");
    };
    ws.onmessage = (ev) => this.onFrame(JSON.parse(ev.data as string) as ServerFrame);
    ws.onclose = () => {
      if (this.closedByUser) {
        useGatewayStore.getState().setConnState("closed");
        return;
      }
      useGatewayStore.getState().setConnState("reconnecting");
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS);
    };
    ws.onerror = () => {
      useAppLogStore.getState().logError("gateway socket error", undefined, "gateway");
    };
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  // ---- outbound ----

  spawn(opts: SpawnOptions): string {
    const channel = newSessionId() as string;
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 24;
    const kind = opts.kind;
    const agentName =
      opts.displayName ??
      (kind === "agent"
        ? (opts.agent?.name ?? "agent")
        : kind === "chat"
          ? (opts.provider?.name ?? "provider chat")
          : (opts.cwd?.split("/").filter(Boolean).pop() ?? "shell"));
    // optimistic: pane + session render in "spawning" before the ack lands
    useSessionStore.getState().upsert({
      id: channel as TerminalSession["id"],
      kind,
      agentId: kind === "agent" ? opts.agent?.id : undefined,
      providerId: kind === "chat" ? opts.provider?.id : undefined,
      model: kind === "chat" ? opts.model : undefined,
      agentName,
      role: kind === "chat" ? (opts.model ?? "Provider native default") : undefined,
      projectId: opts.projectId,
      cwd: opts.cwd,
      status: "spawning",
      statusLabel: "Spawning",
      activeTools: [],
      cols,
      rows,
      startedAt: new Date().toISOString(),
      metrics: emptyMetrics(),
    });
    if (kind !== "chat") useLayoutStore.getState().addPane(channel, opts.projectId);
    const request: SpawnRequest = {
      // reqId === channel is LOAD-BEARING: the error handler tears down the
      // optimistic pane via payload.reqId (see onSystem "error" case)
      reqId: channel,
      kind,
      agentId: kind === "agent" ? opts.agent?.id : undefined,
      providerId: kind === "chat" ? opts.provider?.id : undefined,
      model: kind === "chat" ? opts.model : undefined,
      channel,
      cols,
      rows,
      cwd: opts.cwd,
      command: opts.command,
      projectId: opts.projectId,
      displayName: opts.displayName,
      taskPrompt: opts.taskPrompt || undefined,
      overrides: kind === "agent" && opts.model ? { model: opts.model } : undefined,
    };
    let delivered = true;
    if (typeof window !== "undefined" && window.daimon?.launchSession) {
      // Electron main shows an OS-native confirmation for this exact bounded
      // request and performs the admin call. The renderer never receives a
      // reusable host-process capability or the admin bearer.
      void window.daimon.launchSession(request).then((result) => {
        if (result.ok && result.session) return;
        useLayoutStore.getState().removePane(channel);
        useSessionStore.getState().remove(channel);
        if (!result.canceled) {
          useAppLogStore.getState().logError("native process launch failed", undefined, "gateway");
        }
      }).catch((error: unknown) => {
        useLayoutStore.getState().removePane(channel);
        useSessionStore.getState().remove(channel);
        useAppLogStore.getState().logError(
          "native process launch failed",
          error instanceof Error ? error.message : String(error),
          "gateway",
        );
      });
    } else {
      delivered = this.send({
        channel: GATEWAY_CHANNEL,
        type: "spawn",
        data: request,
      });
    }
    if (!delivered) {
      // no socket → no ack will ever come; don't strand a "Spawning…" pane
      useLayoutStore.getState().removePane(channel);
      useSessionStore.getState().remove(channel);
    }
    return channel;
  }

  /** convenience for the per-agent ▶ button */
  spawnAgent(agent: AgentDefinition, taskPrompt = "", projectId?: string): string {
    return this.spawn({ kind: "agent", agent, taskPrompt, projectId });
  }

  /** Start a provider-native Master Chat conversation without persisting an Agent. */
  spawnChat(provider: ProviderConfig, model?: string): string {
    return this.spawn({ kind: "chat", provider, model });
  }

  sendStdin(channel: string, data: string): boolean {
    // drop xterm's auto-responses to REPLAYED escape queries (see replayMuteUntil)
    if ((this.replayMuteUntil.get(channel) ?? 0) > Date.now()) return false;
    return this.send({ channel, type: "stdin", data });
  }

  sendResize(channel: string, cols: number, rows: number): void {
    this.send({ channel, type: "resize", data: { cols, rows } });
  }

  kill(channel: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    this.send({ channel, type: "kill", data: { signal } });
  }

  /** Close pane: destroys the server-side run AND the local pane state. */
  close(channel: string): void {
    this.send({ channel, type: "close", data: null });
    useLayoutStore.getState().removePane(channel);
    useSessionStore.getState().remove(channel);
    channelRegistry.drop(channel);
    this.lastSeq.delete(channel);
    // a channel closed mid-replay would otherwise leave a MAX_SAFE_INTEGER mute
    // sentinel behind forever (unbounded map growth over a long session)
    this.replayMuteUntil.delete(channel);
  }

  // ---- inbound ----

  private onFrame(frame: ServerFrame): void {
    const prevSeq = this.lastSeq.get(frame.channel) ?? 0;
    if (frame.seq !== undefined && frame.seq > prevSeq) {
      this.lastSeq.set(frame.channel, frame.seq);
    }
    switch (frame.type) {
      case "stdout":
      case "stderr":
        // belt-and-braces dedup: never write a seq we've already rendered
        // (e.g. a replay overlapping frames that arrived live)
        if (frame.seq !== undefined && frame.seq <= prevSeq) return;
        channelRegistry.write(frame.channel, frame.data);
        return;
      case "status":
        useSessionStore.getState().applyStatus(frame.channel, frame.data);
        return;
      case "metrics":
        useSessionStore.getState().applyMetrics(frame.channel, frame.data);
        return;
      case "exit": {
        // Panes are NEVER auto-closed — a finished agent stays open and usable so
        // you can read its work and hand it more instructions. Its output is also
        // saved to the app log (expandable). Close panes yourself from the pane
        // header or the Kanban card when you're done with them.
        useSessionStore.getState().applyExit(frame.channel, frame.data);
        return;
      }
      case "system":
        this.onSystem(frame.data);
        return;
      case "replay_start": {
        // mute stdin while history replays (and a grace period after, since
        // xterm processes writes asynchronously)
        this.replayMuteUntil.set(frame.channel, Number.MAX_SAFE_INTEGER);
        // the ring evicted frames we never saw — say so instead of silently
        // stitching new output onto stale scrollback
        const lost = frame.data.firstSeq - frame.data.fromSeq - 1;
        if (lost > 0) {
          channelRegistry.write(
            frame.channel,
            `\r\n\x1b[2m--- output truncated: ${lost} frame${lost === 1 ? "" : "s"} lost while disconnected ---\x1b[0m\r\n`,
          );
        }
        return;
      }
      case "replay_end":
        this.replayMuteUntil.set(frame.channel, Date.now() + 300);
        return;
    }
  }

  private onSystem(payload: SystemPayload): void {
    const sessions = useSessionStore.getState();
    const layout = useLayoutStore.getState();
    switch (payload.kind) {
      case "hello": {
        useGatewayStore.getState().setChannelCount(payload.channels.length);
        const liveChannels = new Set(payload.channels.map((c) => c.channel));
        // reconcile: local sessions the server no longer knows died with a
        // gateway restart — mark them dead instead of leaving zombie panes
        // that swallow keystrokes (every stdin would be UNKNOWN_CHANNEL)
        for (const [channel, session] of Object.entries(sessions.sessions)) {
          if (liveChannels.has(channel)) continue;
          if (["completed", "failed", "killed"].includes(session.status)) continue;
          sessions.applyExit(channel, { exitCode: null, reason: "crashed" });
          sessions.applyStatus(channel, {
            status: "killed",
            label: "Lost — gateway restarted",
            activeTools: [],
          });
          channelRegistry.write(
            channel,
            "\r\n\x1b[2m--- session lost (gateway restarted) — close this pane and respawn ---\x1b[0m\r\n",
          );
          this.lastSeq.delete(channel);
        }
        for (const snap of payload.channels) {
          sessions.upsert(snap.session);
          // Project/scratch panes rejoin their grid; ad-hoc chats stay exclusively
          // inside Master Chat and must never yank the operator to scratch.
          if (snap.session.kind !== "chat") {
            layout.addPane(snap.channel, snap.session.projectId, { activate: false });
          }
          // replay only what we missed
          const from = this.lastSeq.get(snap.channel) ?? 0;
          this.send({ channel: snap.channel, type: "attach", data: { fromSeq: from } });
        }
        return;
      }
      case "ack": {
        const session = payload.result as TerminalSession | undefined;
        if (session) sessions.upsert(session);
        useGatewayStore
          .getState()
          .setChannelCount(Object.keys(sessions.sessions).length);
        return;
      }
      case "error":
        useAppLogStore
          .getState()
          .logError(payload.message, payload.code ? `code: ${payload.code}` : undefined, "gateway");
        if (payload.reqId) {
          // failed spawn — tear down the optimistic pane. Works because
          // spawn() sets reqId === channel; keep them coupled.
          layout.removePane(payload.reqId);
          sessions.remove(payload.reqId);
        }
        return;
      case "heartbeat":
        return;
      case "applog":
        useAppLogStore.getState().append(payload.entry);
        return;
      case "tasks_changed":
        void useTaskStore.getState().loadProject(payload.projectId);
        return;
      case "attention_changed":
        void useAttentionStore.getState().refresh();
        return;
      case "config_changed":
        // server wiped/replaced config (factory reset) — reload everything so the
        // UI reflects the clean slate, then close any open project tabs whose
        // project no longer exists (otherwise a wiped project lingers as a ghost
        // tab). First-run detection re-runs on the empty config.
        void useConfigStore
          .getState()
          .loadAll()
          .then(() => {
            const projects = useConfigStore.getState().projects;
            const projectIds = projects.map((p) => p.id as string);
            useLayoutStore.getState().pruneTabs(projectIds);
            useTaskStore.getState().pruneProjects(projectIds);
          });
        return;
      case "session_started": {
        // server-initiated pane (scheduler worker or Lead) — render + attach it
        const session = payload.session;
        useSessionStore.getState().upsert(session);
        if (session.kind !== "chat") {
          useLayoutStore.getState().addPane(session.id as string, session.projectId, {
            activate: false,
          });
        }
        this.send({ channel: session.id as string, type: "attach", data: { fromSeq: 0 } });
        return;
      }
    }
  }

  /** @returns false when the socket is down — callers must not assume delivery */
  private send(body: Omit<ClientFrame, "v" | "ts">): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      // never drop silently — a lost frame reads as "typing does nothing"
      useAppLogStore
        .getState()
        .logError(`gateway not connected — "${body.type}" frame dropped`, undefined, "gateway");
      return false;
    }
    this.ws.send(JSON.stringify({ ...body, v: PROTOCOL_VERSION, ts: Date.now() }));
    return true;
  }
}

// Survive Next.js Fast Refresh: editing this module would otherwise create a
// fresh disconnected instance while the old one keeps the socket — every
// spawn/stdin after an HMR update would vanish into the orphaned singleton.
const globalRef = globalThis as { __daimonGateway?: GatewayClient };
export const gateway = (globalRef.__daimonGateway ??= new GatewayClient());
