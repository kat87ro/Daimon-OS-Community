import type { IncomingMessage } from "node:http";
import type { WebSocket, WebSocketServer } from "ws";
import {
  GATEWAY_CHANNEL,
  HEARTBEAT_INTERVAL_MS,
  decodeClientFrame,
  makeFrame,
} from "@daimon-os/shared";
import type { ClientFrame, GatewayErrorCode, SystemPayload } from "@daimon-os/shared";
import type { AppLog } from "./AppLog";
import {
  ProcessManager,
  SpawnError,
  type ChannelAuthority,
  type ChannelOperation,
} from "../process/ProcessManager";

/**
 * Charon — the single multiplexed gateway. Every browser tab holds exactly
 * one socket; all terminal streams, control frames, and telemetry cross on
 * this one boat, routed by the frame's channel id.
 */
export class GatewayServer {
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubLog: () => void;
  private readonly connectionAuthority = new WeakMap<WebSocket, ChannelAuthority>();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly pm: ProcessManager,
    private readonly appLog: AppLog,
  ) {
    wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        this.sendSystem(ws, { kind: "heartbeat" });
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
    // fan new app-log entries out to every connected tab live
    this.unsubLog = appLog.subscribe((entry) => {
      for (const ws of wss.clients) this.sendSystem(ws, { kind: "applog", entry });
    });
  }

  /** broadcast a control payload to all tabs (used by the task scheduler) */
  broadcast(payload: SystemPayload): void {
    for (const ws of this.wss.clients) {
      const authority = this.connectionAuthority.get(ws) ?? "admin";
      if (
        payload.kind === "session_started" &&
        !this.pm.canAccess(payload.session.id as string, authority, "read")
      ) continue;
      this.sendSystem(ws, payload);
    }
  }

  dispose(): void {
    clearInterval(this.heartbeat);
    this.unsubLog();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const requested = (req as IncomingMessage & { daimonAccess?: string }).daimonAccess;
    const access: ChannelAuthority = requested === "renderer" ? "renderer" : "admin";
    this.connectionAuthority.set(ws, access);
    const channels = this.pm.snapshotFor(access);
    this.sendSystem(ws, {
      kind: "hello",
      sessionResume: channels.length > 0,
      channels,
    });

    ws.on("message", (raw) => {
      const res = decodeClientFrame(
        typeof raw === "string" ? raw : new Uint8Array(raw as Buffer),
      );
      if (!res.ok) {
        this.sendError(ws, "BAD_FRAME", res.error);
        return;
      }
      void this.handleFrame(ws, res.frame, access);
    });

    ws.on("close", () => this.pm.detachSocket(ws));
    // an abrupt client drop (ECONNRESET/EPIPE) emits 'error'; an unhandled 'error'
    // on a ws is an uncaught exception that kills the whole gateway process. Swallow
    // it — 'close' fires right after and detachSocket() does the cleanup.
    ws.on("error", () => {});
  }

  private async handleFrame(
    ws: WebSocket,
    frame: ClientFrame,
    access: ChannelAuthority,
  ): Promise<void> {
    try {
      switch (frame.type) {
        case "ping":
          this.sendSystem(ws, { kind: "heartbeat" });
          return;
        case "spawn": {
          if (access === "renderer" && !this.pm.rendererMaySpawn(frame.data)) {
            this.sendError(
              ws,
              "UNAUTHORIZED",
              "process launch is not exposed to the renderer WebSocket; use the native-confirmed desktop capability",
              frame.data.reqId,
            );
            return;
          }
          if (access === "renderer" && frame.data.overrides?.env) {
            this.sendError(
              ws,
              "UNAUTHORIZED",
              "renderer-controlled process environment overrides are not allowed",
              frame.data.reqId,
            );
            return;
          }
          const session = await this.pm.spawn(frame.data, ws, access);
          this.sendSystem(ws, { kind: "ack", reqId: frame.data.reqId, ok: true, result: session });
          return;
        }
        case "stdin":
          if (!this.authorizeChannel(ws, frame.channel, access, "control")) return;
          this.pm.write(frame.channel, frame.data);
          return;
        case "resize":
          if (!this.authorizeChannel(ws, frame.channel, access, "control")) return;
          this.pm.resize(frame.channel, frame.data.cols, frame.data.rows);
          return;
        case "attach":
          if (!this.authorizeChannel(ws, frame.channel, access, "read")) return;
          this.pm.attach(frame.channel, ws, frame.data.fromSeq ?? 0);
          return;
        case "detach":
          if (!this.authorizeChannel(ws, frame.channel, access, "read")) return;
          this.pm.detach(frame.channel, ws);
          return;
        case "kill":
          if (!this.authorizeChannel(ws, frame.channel, access, "control")) return;
          this.pm.kill(frame.channel, frame.data.signal ?? "SIGTERM");
          return;
        case "close":
          if (!this.authorizeChannel(ws, frame.channel, access, "control")) return;
          await this.pm.close(frame.channel);
          return;
      }
    } catch (err) {
      if (err instanceof SpawnError) {
        const reqId = frame.type === "spawn" ? frame.data.reqId : undefined;
        this.sendError(ws, err.code, err.message, reqId);
      } else {
        this.sendError(ws, "SPAWN_FAILED", err instanceof Error ? err.message : String(err));
      }
    }
  }

  private authorizeChannel(
    ws: WebSocket,
    channel: string,
    authority: ChannelAuthority,
    operation: ChannelOperation,
  ): boolean {
    if (this.pm.canAccess(channel, authority, operation)) return true;
    this.sendError(ws, "UNAUTHORIZED", "channel is not available to this connection");
    return false;
  }

  private sendSystem(ws: WebSocket, payload: SystemPayload): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(
      JSON.stringify(
        makeFrame({ channel: GATEWAY_CHANNEL, type: "system", data: payload }),
      ),
    );
  }

  private sendError(
    ws: WebSocket,
    code: GatewayErrorCode,
    message: string,
    reqId?: string,
  ): void {
    this.sendSystem(ws, { kind: "error", code, message, reqId });
  }
}
