import { z } from "zod";

export const durableRunStatusSchema = z.enum([
  "preparing",
  "running",
  "waiting_review",
  "approved",
  "promoting",
  "promoted",
  "failed",
  "blocked",
]);
export type DurableRunStatus = z.infer<typeof durableRunStatusSchema>;

export const runEventTypeSchema = z.enum([
  "run.started",
  "run.waiting_review",
  "run.approved",
  "run.promotion_intended",
  "run.promoted",
  "run.failed",
  "run.blocked",
  "worktree.prepared",
  "artifact.captured",
  "attention.opened",
  "attention.resolved",
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const gitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const optionalText = z.string().max(4_096).optional();

export const eventPayloadSchemas: Record<RunEventType, z.ZodTypeAny> = {
  "run.started": z.object({ runId: id, taskId: id, projectId: id, attempt: z.number().int().positive() }).strict(),
  "run.waiting_review": z.object({ runId: id, subjectHash: hash, diffArtifactHash: hash }).strict(),
  "run.approved": z.object({ runId: id, subjectHash: hash, approvalId: id }).strict(),
  "run.promotion_intended": z.object({ runId: id, subjectHash: hash }).strict(),
  "run.promoted": z.object({ runId: id, subjectHash: hash }).strict(),
  "run.failed": z.object({ runId: id, reason: z.string().min(1).max(4_096) }).strict(),
  "run.blocked": z.object({ runId: id, reason: z.string().min(1).max(4_096) }).strict(),
  "worktree.prepared": z.object({ runId: id, baseHead: gitObjectId, branch: id }).strict(),
  "artifact.captured": z.object({ runId: id, artifactHash: hash, kind: id }).strict(),
  "attention.opened": z.object({
    attentionId: id,
    projectId: id.optional(),
    runId: id.optional(),
    taskId: id,
    agentId: id.optional(),
    channel: id.optional(),
    link: z.string().max(2_048).optional(),
    requestId: id.optional(),
    options: z.array(z.string().max(512)).max(16).optional(),
    kind: id,
    message: optionalText,
  }).strict(),
  "attention.resolved": z.object({ attentionId: id, resolution: optionalText }).strict(),
};

export interface DurableRun {
  id: string;
  taskId: string;
  projectId: string;
  sessionId?: string;
  attempt: number;
  status: DurableRunStatus;
  canonicalRoot: string;
  worktreePath?: string;
  worktreeBranch?: string;
  baseHead?: string;
  /** Exact approved canonical state inherited when this run was prepared. */
  parentSubjectHash?: string;
  subjectHash?: string;
  diffArtifactHash?: string;
  statusArtifactHash?: string;
  startedAt: string;
  completedAt?: string;
  outcome?: string;
  metrics: Record<string, number | string | boolean | null>;
}

export interface DurableArtifact {
  sha256: string;
  kind: string;
  mediaType: string;
  byteLength: number;
  storagePath: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  taskId: string;
  subjectHash: string;
  decision: "approved";
  approvedBy: "human-local";
  createdAt: string;
}

export interface AttentionItem {
  id: string;
  projectId: string;
  taskId: string;
  runId?: string;
  agentId?: string;
  channel?: string;
  link?: string;
  requestId?: string;
  options?: string[];
  kind: "waiting_review" | "failed" | "policy_blocked" | "input_required";
  state: "open" | "resolved";
  message: string;
  createdAt: string;
  resolvedAt?: string;
}
