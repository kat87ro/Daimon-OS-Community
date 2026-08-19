import { z } from "zod";
import {
  MAX_STDIN_BYTES,
  MAX_TASK_PROMPT_BYTES,
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  PROTOCOL_VERSION,
  WS_MAX_PAYLOAD_BYTES,
} from "./constants";
import {
  agentDefinitionSchema,
  appLogEntrySchema,
  exitReasonSchema,
  runMetricsSchema,
  runStatusSchema,
  terminalSessionSchema,
} from "./entities";
import { agentIdSchema, providerIdSchema } from "./ids";

const envelopeBase = {
  v: z.literal(PROTOCOL_VERSION),
  channel: z.string().min(1).max(128),
  seq: z.number().int().nonnegative().optional(),
  ts: z.number(),
};

// ---------- Server → client payloads ----------

export const statusPayloadSchema = z.object({
  status: runStatusSchema,
  label: z.string().max(1024),
  activeTools: z.array(z.string().max(256)).max(64),
});
export type StatusPayload = z.infer<typeof statusPayloadSchema>;

export const exitPayloadSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().optional(),
  reason: exitReasonSchema,
});
export type ExitPayload = z.infer<typeof exitPayloadSchema>;

export const channelSnapshotSchema = z.object({
  channel: z.string().max(128),
  session: terminalSessionSchema,
  lastSeq: z.number().int().nonnegative(),
});
export type ChannelSnapshot = z.infer<typeof channelSnapshotSchema>;

export const gatewayErrorCodeSchema = z.enum([
  "UNKNOWN_CHANNEL",
  "SPAWN_FAILED",
  "LIMIT_EXCEEDED",
  "BAD_FRAME",
  "UNAUTHORIZED",
  "BACKPRESSURE_DROP",
]);
export type GatewayErrorCode = z.infer<typeof gatewayErrorCodeSchema>;

export const systemPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hello"),
    sessionResume: z.boolean(),
    channels: z.array(channelSnapshotSchema).max(256),
  }),
  z.object({
    kind: z.literal("ack"),
    reqId: z.string().max(128),
    ok: z.literal(true),
    result: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("error"),
    reqId: z.string().max(128).optional(),
    code: gatewayErrorCodeSchema,
    message: z.string().max(4096),
  }),
  z.object({ kind: z.literal("heartbeat") }),
  // app-wide operational log streamed on the gateway channel
  z.object({ kind: z.literal("applog"), entry: appLogEntrySchema }),
  // a task changed — clients refetch /api/tasks for the project
  z.object({ kind: z.literal("tasks_changed"), projectId: z.string().max(128) }),
  // a durable inbox item opened/resolved — clients refetch /api/attention
  z.object({ kind: z.literal("attention_changed"), projectId: z.string().max(128) }),
  // a session the SERVER started (scheduler/Lead) — clients add the pane + attach
  z.object({ kind: z.literal("session_started"), session: terminalSessionSchema }),
  // config was wiped/replaced server-side (factory reset) — clients reload all config
  z.object({ kind: z.literal("config_changed") }),
]);
export type SystemPayload = z.infer<typeof systemPayloadSchema>;

export const serverFrameSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeBase, type: z.literal("stdout"), data: z.string().max(256 * 1024) }),
  // RESERVED: a PTY merges stdout/stderr into one stream, so today no runner
  // emits stderr frames. The type exists for future non-PTY runners only.
  z.object({ ...envelopeBase, type: z.literal("stderr"), data: z.string().max(256 * 1024) }),
  z.object({ ...envelopeBase, type: z.literal("status"), data: statusPayloadSchema }),
  z.object({ ...envelopeBase, type: z.literal("metrics"), data: runMetricsSchema }),
  z.object({ ...envelopeBase, type: z.literal("exit"), data: exitPayloadSchema }),
  z.object({ ...envelopeBase, type: z.literal("system"), data: systemPayloadSchema }),
  z.object({
    ...envelopeBase,
    type: z.literal("replay_start"),
    data: z.object({
      fromSeq: z.number().int(),
      count: z.number().int(),
      /** oldest seq actually retained — firstSeq > fromSeq + 1 means frames were evicted */
      firstSeq: z.number().int(),
    }),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal("replay_end"),
    data: z.object({ lastSeq: z.number().int() }),
  }),
]);
export type ServerFrame = z.infer<typeof serverFrameSchema>;
export type ServerFrameType = ServerFrame["type"];

// ---------- Client → server payloads ----------

export const spawnRequestSchema = z
  .object({
    reqId: z.string().min(1).max(128),
    kind: z.enum(["agent", "shell", "chat"]),
    /** required when kind === "agent" */
    agentId: agentIdSchema.optional(),
    /** required when kind === "chat"; resolved from saved provider config */
    providerId: providerIdSchema.optional(),
    /** exact provider-reported model id; omit to use the provider's native default */
    model: z.string().min(1).max(256).optional(),
    channel: z.string().uuid(),
    cols: z.number().int().positive().max(MAX_TERMINAL_COLS),
    rows: z.number().int().positive().max(MAX_TERMINAL_ROWS),
    /** working directory — usually the project path; defaults to $HOME for shells */
    cwd: z.string().max(4096).optional(),
    /** startup command written to the shell after spawn (e.g. "claude" or "codex") */
    command: z.string().max(8192).optional(),
    projectId: z.string().uuid().optional(),
    displayName: z.string().max(256).optional(),
    taskPrompt: z.string().max(MAX_TASK_PROMPT_BYTES).optional(),
    /** one-shot worker: run the task to completion and EXIT (e.g. claude -p),
     *  so the scheduler sees it finish and unblocks dependents. The Lead runs
     *  interactive (omit/false) because it must keep polling + delegating. */
    oneShot: z.boolean().optional(),
    /** Fusion recursion guard: >0 means this spawn is part of a Fusion run
     *  (a panel/judge sub-invocation), so it must NEVER trigger Fusion again. */
    fusionDepth: z.number().int().nonnegative().max(16).optional(),
    overrides: agentDefinitionSchema
      // Kept for internal/mock harness compatibility. GatewayServer rejects this
      // field for renderer authority, and native runners deliberately ignore it.
      .pick({ model: true, providerId: true, env: true })
      .partial()
      .optional(),
  })
  .superRefine((req, ctx) => {
    if (req.kind === "agent" && !req.agentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agentId is required when kind is 'agent'",
        path: ["agentId"],
      });
    }
    if (req.kind === "chat" && !req.providerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "providerId is required when kind is 'chat'",
        path: ["providerId"],
      });
    }
    if (req.kind !== "chat" && (req.providerId || req.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "providerId and model are reserved for ad-hoc chat sessions",
        path: [req.providerId ? "providerId" : "model"],
      });
    }
    if (
      req.kind === "chat" &&
      (req.agentId || req.projectId || req.cwd || req.command || req.taskPrompt ||
        req.oneShot || req.fusionDepth !== undefined || req.overrides)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ad-hoc chat cannot inherit agent, project, command, task, or override authority",
        path: ["kind"],
      });
    }
  });
export type SpawnRequest = z.infer<typeof spawnRequestSchema>;

export const clientFrameSchema = z.discriminatedUnion("type", [
  z.object({ ...envelopeBase, type: z.literal("spawn"), data: spawnRequestSchema }),
  z.object({ ...envelopeBase, type: z.literal("stdin"), data: z.string().max(MAX_STDIN_BYTES) }),
  z.object({
    ...envelopeBase,
    type: z.literal("resize"),
    data: z.object({
      cols: z.number().int().positive().max(MAX_TERMINAL_COLS),
      rows: z.number().int().positive().max(MAX_TERMINAL_ROWS),
    }),
  }),
  z.object({
    ...envelopeBase,
    type: z.literal("attach"),
    data: z.object({ fromSeq: z.number().int().nonnegative().optional() }),
  }),
  z.object({ ...envelopeBase, type: z.literal("detach"), data: z.null() }),
  z.object({
    ...envelopeBase,
    type: z.literal("kill"),
    data: z.object({ signal: z.enum(["SIGTERM", "SIGKILL"]).optional() }),
  }),
  z.object({ ...envelopeBase, type: z.literal("close"), data: z.null() }),
  z.object({ ...envelopeBase, type: z.literal("ping"), data: z.null() }),
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type ClientFrameType = ClientFrame["type"];

export type Frame = ServerFrame | ClientFrame;
export type FrameType = Frame["type"];

// ---------- Helpers ----------

type DistributedOmit<T, K extends keyof Frame> = T extends unknown
  ? Omit<T, K>
  : never;

/** Stamp protocol version + timestamp onto a frame body. */
export function makeFrame<T extends DistributedOmit<Frame, "v" | "ts">>(
  body: T,
): T & { v: typeof PROTOCOL_VERSION; ts: number } {
  return { ...body, v: PROTOCOL_VERSION, ts: Date.now() };
}

export type DecodeResult<T> =
  | { ok: true; frame: T }
  | { ok: false; error: string };

function decode<T>(schema: z.ZodType<T>, raw: unknown): DecodeResult<T> {
  let value: unknown = raw;
  if (typeof raw === "string" || raw instanceof Uint8Array) {
    // ES2022-only shared builds do not include DOM typings, while both supported
    // runtimes (modern browsers and Node) expose the WHATWG text codecs.
    const codecs = globalThis as unknown as {
      TextEncoder: new () => { encode(value: string): Uint8Array };
      TextDecoder: new () => { decode(value: Uint8Array): string };
    };
    const byteLength =
      typeof raw === "string" ? new codecs.TextEncoder().encode(raw).byteLength : raw.byteLength;
    if (byteLength > WS_MAX_PAYLOAD_BYTES) {
      return { ok: false, error: "frame exceeds maximum payload" };
    }
    try {
      value = JSON.parse(
        typeof raw === "string" ? raw : new codecs.TextDecoder().decode(raw),
      );
    } catch {
      return { ok: false, error: "invalid JSON" };
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, frame: parsed.data }
    : { ok: false, error: parsed.error.issues[0]?.message ?? "invalid frame" };
}

export const decodeClientFrame = (raw: unknown): DecodeResult<ClientFrame> =>
  decode(clientFrameSchema, raw);

export const decodeServerFrame = (raw: unknown): DecodeResult<ServerFrame> =>
  decode(serverFrameSchema, raw);

/** Telemetry events runners embed in PTY output via OSC 6973 (Argus channel). */
export const telemetryEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    status: runStatusSchema,
    label: z.string().optional(),
    activeTools: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("metrics"), metrics: runMetricsSchema.partial() }),
]);
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
