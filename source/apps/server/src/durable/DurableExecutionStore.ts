import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { eventPayloadSchemas, runEventTypeSchema } from "./types";
import type {
  ApprovalRecord,
  AttentionItem,
  DurableArtifact,
  DurableRun,
  DurableRunStatus,
  RunEventType,
} from "./types";

// `parent_subject_hash` is a nullable, older-reader-safe extension of schema 2.
// Keep the compatibility marker at 2 so a previously packaged desktop can
// still open data touched by a newer source checkout. Schema 3 existed briefly
// during development for this additive column and is normalized below only
// after proving that exact known shape is present.
const SCHEMA_VERSION = 2;
const TRANSITIONAL_ADDITIVE_SCHEMA_VERSION = 3;
const MAX_EVENT_BYTES = 64 * 1024;
const ZERO_HASH = "0".repeat(64);
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:secret|token|password|passphrase|api[-_]?key|authorization|cookie|private[-_]?key)/i;

interface EventRow {
  stream_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  previous_hash: string;
  event_hash: string;
  created_at: string;
}

/**
 * Transactional local execution ledger. Events are append-only and hash-linked;
 * mutable tables are rebuildable query projections, never the audit authority.
 */
export class DurableExecutionStore {
  private readonly db: DatabaseSync;
  private readonly artifactsDir: string;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.artifactsDir = path.join(dataDir, "artifacts", "sha256");
    fs.mkdirSync(this.artifactsDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, "execution.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT version FROM schema_meta LIMIT 1").get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (version === TRANSITIONAL_ADDITIVE_SCHEMA_VERSION) {
      const hasKnownAdditiveColumn = this.db.prepare(
        "SELECT COUNT(*) AS count FROM pragma_table_info('runs') WHERE name = 'parent_subject_hash'",
      ).get() as { count: number };
      if (Number(hasKnownAdditiveColumn.count) !== 1) {
        throw new Error("execution database schema 3 does not match the known additive transition");
      }
      this.db.exec("BEGIN IMMEDIATE; UPDATE schema_meta SET version = 2; COMMIT;");
      version = SCHEMA_VERSION;
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(`execution database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE events (
          stream_id TEXT NOT NULL,
          sequence INTEGER NOT NULL CHECK(sequence > 0),
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_hash TEXT NOT NULL CHECK(length(previous_hash) = 64),
          event_hash TEXT NOT NULL CHECK(length(event_hash) = 64),
          created_at TEXT NOT NULL,
          PRIMARY KEY(stream_id, sequence),
          UNIQUE(event_hash)
        ) STRICT;
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          session_id TEXT,
          attempt INTEGER NOT NULL CHECK(attempt > 0),
          status TEXT NOT NULL,
          canonical_root TEXT NOT NULL,
          worktree_path TEXT,
          worktree_branch TEXT,
          base_head TEXT,
          parent_subject_hash TEXT CHECK(parent_subject_hash IS NULL OR length(parent_subject_hash) = 64),
          subject_hash TEXT,
          diff_artifact_hash TEXT,
          status_artifact_hash TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT,
          metrics_json TEXT NOT NULL,
          UNIQUE(task_id, attempt)
        ) STRICT;
        CREATE INDEX runs_task_started_idx ON runs(task_id, started_at DESC);
        CREATE INDEX runs_session_idx ON runs(session_id);
        CREATE TABLE artifacts (
          sha256 TEXT PRIMARY KEY CHECK(length(sha256) = 64),
          kind TEXT NOT NULL,
          media_type TEXT NOT NULL,
          byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
          storage_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          metadata_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE approvals (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id),
          task_id TEXT NOT NULL,
          subject_hash TEXT NOT NULL CHECK(length(subject_hash) = 64),
          decision TEXT NOT NULL CHECK(decision = 'approved'),
          approved_by TEXT NOT NULL CHECK(approved_by = 'human-local'),
          created_at TEXT NOT NULL,
          UNIQUE(run_id, subject_hash)
        ) STRICT;
        CREATE TRIGGER approvals_immutable_update BEFORE UPDATE ON approvals BEGIN
          SELECT RAISE(ABORT, 'approval records are immutable');
        END;
        CREATE TRIGGER approvals_immutable_delete BEFORE DELETE ON approvals BEGIN
          SELECT RAISE(ABORT, 'approval records are immutable');
        END;
        CREATE TABLE attention (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          run_id TEXT,
          agent_id TEXT,
          channel TEXT,
          link TEXT,
          request_id TEXT,
          options_json TEXT,
          kind TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('open', 'resolved')),
          message TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        ) STRICT;
        CREATE INDEX attention_state_created_idx ON attention(state, created_at DESC);
        CREATE UNIQUE INDEX attention_task_request_idx
          ON attention(task_id, kind, request_id) WHERE request_id IS NOT NULL;
        DELETE FROM schema_meta;
        INSERT INTO schema_meta(version) VALUES (2);
        COMMIT;
      `);
    }
    if (version === 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE attention ADD COLUMN agent_id TEXT;
        ALTER TABLE attention ADD COLUMN channel TEXT;
        ALTER TABLE attention ADD COLUMN link TEXT;
        ALTER TABLE attention ADD COLUMN request_id TEXT;
        ALTER TABLE attention ADD COLUMN options_json TEXT;
        CREATE UNIQUE INDEX attention_task_request_idx
          ON attention(task_id, kind, request_id) WHERE request_id IS NOT NULL;
        UPDATE schema_meta SET version = 2;
        COMMIT;
      `);
    }
    if (version === 1 || version === 2) {
      const lineageColumn = this.db.prepare(
        "SELECT COUNT(*) AS count FROM pragma_table_info('runs') WHERE name = 'parent_subject_hash'",
      ).get() as { count: number };
      if (Number(lineageColumn.count) === 0) {
        this.db.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE runs ADD COLUMN parent_subject_hash TEXT
            CHECK(parent_subject_hash IS NULL OR length(parent_subject_hash) = 64);
          COMMIT;
        `);
      }
    }
  }

  appendEvent(streamId: string, eventType: RunEventType, payload: unknown): EventRow {
    if (!streamId || streamId.length > 256) throw new Error("invalid event stream id");
    runEventTypeSchema.parse(eventType);
    const safePayload = redact(payload);
    const parsedPayload = eventPayloadSchemas[eventType].parse(safePayload) as unknown;
    const payloadJson = canonicalJson(parsedPayload);
    if (Buffer.byteLength(payloadJson) > MAX_EVENT_BYTES) throw new Error("event payload exceeds 64 KiB");
    const createdAt = new Date().toISOString();
    const ownsTransaction = !this.db.isTransaction;
    if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(
        "SELECT sequence, event_hash FROM events WHERE stream_id = ? ORDER BY sequence DESC LIMIT 1",
      ).get(streamId) as { sequence: number; event_hash: string } | undefined;
      const sequence = (previous?.sequence ?? 0) + 1;
      const previousHash = previous?.event_hash ?? ZERO_HASH;
      const eventHash = hashEvent(streamId, sequence, eventType, payloadJson, previousHash, createdAt);
      this.db.prepare(
        "INSERT INTO events(stream_id, sequence, event_type, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(streamId, sequence, eventType, payloadJson, previousHash, eventHash, createdAt);
      if (ownsTransaction) this.db.exec("COMMIT");
      return { stream_id: streamId, sequence, event_type: eventType, payload_json: payloadJson, previous_hash: previousHash, event_hash: eventHash, created_at: createdAt };
    } catch (error) {
      if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  verifyStream(streamId: string): { valid: boolean; events: number; error?: string } {
    const rows = this.db.prepare(
      "SELECT stream_id, sequence, event_type, payload_json, previous_hash, event_hash, created_at FROM events WHERE stream_id = ? ORDER BY sequence",
    ).all(streamId) as unknown as EventRow[];
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;
    for (const row of rows) {
      const expected = hashEvent(row.stream_id, row.sequence, row.event_type, row.payload_json, row.previous_hash, row.created_at);
      if (row.sequence !== expectedSequence || row.previous_hash !== previousHash || row.event_hash !== expected) {
        return { valid: false, events: rows.length, error: `hash chain mismatch at sequence ${row.sequence}` };
      }
      previousHash = row.event_hash;
      expectedSequence += 1;
    }
    return { valid: true, events: rows.length };
  }

  nextAttempt(taskId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(attempt), 0) AS attempt FROM runs WHERE task_id = ?").get(taskId) as { attempt: number };
    return row.attempt + 1;
  }

  createRun(input: Omit<DurableRun, "startedAt" | "metrics"> & { metrics?: DurableRun["metrics"] }): DurableRun {
    const startedAt = new Date().toISOString();
    const run: DurableRun = { ...input, startedAt, metrics: input.metrics ?? {} };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO runs(
        id, task_id, project_id, session_id, attempt, status, canonical_root,
        worktree_path, worktree_branch, base_head, parent_subject_hash, subject_hash, diff_artifact_hash,
        status_artifact_hash, started_at, completed_at, outcome, metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(run.id, run.taskId, run.projectId, run.sessionId ?? null, run.attempt, run.status,
          run.canonicalRoot, run.worktreePath ?? null, run.worktreeBranch ?? null, run.baseHead ?? null,
          run.parentSubjectHash ?? null, run.subjectHash ?? null, run.diffArtifactHash ?? null, run.statusArtifactHash ?? null,
          startedAt, run.completedAt ?? null, run.outcome ?? null, canonicalJson(run.metrics));
      this.appendEvent(`run:${run.id}`, "run.started", { runId: run.id, taskId: run.taskId, projectId: run.projectId, attempt: run.attempt });
      if (run.worktreePath && run.baseHead && run.worktreeBranch) {
        this.appendEvent(`run:${run.id}`, "worktree.prepared", { runId: run.id, baseHead: run.baseHead, branch: run.worktreeBranch });
      }
      this.db.exec("COMMIT");
      return run;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateRun(id: string, patch: Partial<Pick<DurableRun,
    "sessionId" | "status" | "worktreePath" | "worktreeBranch" | "baseHead" | "parentSubjectHash" | "subjectHash" |
    "diffArtifactHash" | "statusArtifactHash" | "completedAt" | "outcome" | "metrics">>): DurableRun {
    const current = this.getRun(id);
    if (!current) throw new Error(`unknown run ${id}`);
    const next = { ...current, ...patch };
    this.db.prepare(`UPDATE runs SET session_id=?, status=?, worktree_path=?, worktree_branch=?, base_head=?,
      parent_subject_hash=?, subject_hash=?, diff_artifact_hash=?, status_artifact_hash=?, completed_at=?, outcome=?, metrics_json=? WHERE id=?`)
      .run(next.sessionId ?? null, next.status, next.worktreePath ?? null, next.worktreeBranch ?? null,
        next.baseHead ?? null, next.parentSubjectHash ?? null, next.subjectHash ?? null, next.diffArtifactHash ?? null,
        next.statusArtifactHash ?? null, next.completedAt ?? null, next.outcome ?? null,
        canonicalJson(next.metrics), id);
    return next;
  }

  getRun(id: string): DurableRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? decodeRun(row) : undefined;
  }

  getRunBySession(sessionId: string): DurableRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1").get(sessionId) as Record<string, unknown> | undefined;
    return row ? decodeRun(row) : undefined;
  }

  latestRunForTask(taskId: string): DurableRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY attempt DESC LIMIT 1").get(taskId) as Record<string, unknown> | undefined;
    return row ? decodeRun(row) : undefined;
  }

  listRuns(taskId?: string): DurableRun[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC").all(taskId)
      : this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeRun);
  }

  /** True only when the exact checkout diff is already represented by a
   * completed, human-approved promotion against the same canonical HEAD. */
  hasPromotedState(canonicalRoot: string, baseHead: string, subjectHash: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM runs
      WHERE status = 'promoted'
        AND canonical_root = ?
        AND base_head = ?
        AND subject_hash = ?
      LIMIT 1
    `).get(canonicalRoot, baseHead, subjectHash);
    return Boolean(row);
  }

  /** Deletion safety query. Unlike listRuns(), this is intentionally unbounded
   * and filtered in SQLite so an old reviewable run cannot fall outside the
   * 500-row UI/read-model window. */
  listUnsettledRunsForProjects(projectIds: readonly string[]): DurableRun[] {
    if (projectIds.length === 0) return [];
    const statement = this.db.prepare(`
      SELECT * FROM runs
      WHERE project_id = ?
        AND status IN ('preparing', 'running', 'waiting_review', 'approved', 'promoting')
      ORDER BY started_at
    `);
    const rows = projectIds.flatMap((projectId) =>
      statement.all(projectId) as unknown as Record<string, unknown>[],
    );
    return rows.map(decodeRun);
  }

  listInterruptedRuns(): DurableRun[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status IN ('preparing', 'running') ORDER BY started_at").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeRun);
  }

  listPromotingRuns(): DurableRun[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'promoting' ORDER BY started_at").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeRun);
  }

  putArtifact(content: Buffer | string, kind: string, mediaType: string, metadata: Record<string, unknown> = {}): DurableArtifact {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dir = path.join(this.artifactsDir, sha256.slice(0, 2));
    const storagePath = path.join(dir, sha256);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(storagePath)) {
      const temp = `${storagePath}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" });
      try {
        fs.renameSync(temp, storagePath);
      } catch (error) {
        if (!fs.existsSync(storagePath)) throw error;
        fs.rmSync(temp, { force: true });
      }
    }
    const createdAt = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO artifacts
      (sha256, kind, media_type, byte_length, storage_path, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256, kind, mediaType, bytes.byteLength, storagePath, createdAt, canonicalJson(redact(metadata)));
    return { sha256, kind, mediaType, byteLength: bytes.byteLength, storagePath, createdAt, metadata: redact(metadata) as Record<string, unknown> };
  }

  readArtifact(sha256: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("invalid artifact hash");
    const row = this.db.prepare("SELECT storage_path FROM artifacts WHERE sha256 = ?").get(sha256) as { storage_path: string } | undefined;
    if (!row) throw new Error("artifact not found");
    const resolved = fs.realpathSync.native(row.storage_path);
    const root = fs.realpathSync.native(this.artifactsDir);
    if (!resolved.startsWith(root + path.sep)) throw new Error("artifact path escaped storage root");
    const bytes = fs.readFileSync(resolved);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("artifact integrity check failed");
    return bytes;
  }

  recordApproval(runId: string, subjectHash: string): ApprovalRecord {
    const run = this.getRun(runId);
    if (!run || run.subjectHash !== subjectHash || run.status !== "waiting_review") {
      throw new Error("approval subject does not match a waiting review run");
    }
    const record: ApprovalRecord = {
      id: randomUUID(), runId, taskId: run.taskId, subjectHash,
      decision: "approved", approvedBy: "human-local", createdAt: new Date().toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO approvals(id, run_id, task_id, subject_hash, decision, approved_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(record.id, record.runId, record.taskId, record.subjectHash, record.decision, record.approvedBy, record.createdAt);
      this.updateRun(runId, { status: "approved" });
      this.appendEvent(`run:${runId}`, "run.approved", { runId, subjectHash, approvalId: record.id });
      this.db.exec("COMMIT");
      return record;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markWaitingReview(
    runId: string,
    captured: { subjectHash: string; diffArtifactHash: string; statusArtifactHash: string },
    metrics: DurableRun["metrics"],
  ): DurableRun {
    const run = this.getRun(runId);
    if (!run || (run.status !== "running" && run.status !== "preparing")) {
      throw new Error("run is not active");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.updateRun(runId, {
        ...captured, status: "waiting_review", metrics,
        completedAt: new Date().toISOString(), outcome: "worker_completed",
      });
      this.appendEvent(`run:${runId}`, "run.waiting_review", {
        runId, subjectHash: captured.subjectHash, diffArtifactHash: captured.diffArtifactHash,
      });
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markRunFailed(runId: string, reason: string, metrics: DurableRun["metrics"]): DurableRun {
    const safeReason = reason.slice(0, 4_096);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.setRunTerminal(runId, "failed", safeReason, metrics);
      this.appendEvent(`run:${runId}`, "run.failed", { runId, reason: safeReason });
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requestChanges(taskId: string): DurableRun | undefined {
    const run = this.latestRunForTask(taskId);
    if (!run || (run.status !== "waiting_review" && run.status !== "approved")) return undefined;
    const updated = this.markRunFailed(run.id, "human requested changes; captured approval subject invalidated", run.metrics);
    this.resolveAttentionForTask(taskId, "human requested changes");
    return updated;
  }

  hasApproval(runId: string, subjectHash: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS ok FROM approvals WHERE run_id = ? AND subject_hash = ?").get(runId, subjectHash));
  }

  getApproval(runId: string, subjectHash: string): ApprovalRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM approvals WHERE run_id = ? AND subject_hash = ? LIMIT 1",
    ).get(runId, subjectHash) as Record<string, unknown> | undefined;
    return row ? {
      id: String(row.id),
      runId: String(row.run_id),
      taskId: String(row.task_id),
      subjectHash: String(row.subject_hash),
      decision: "approved",
      approvedBy: "human-local",
      createdAt: String(row.created_at),
    } : undefined;
  }

  beginPromotion(runId: string, subjectHash: string): DurableRun {
    const run = this.getRun(runId);
    if (!run || (run.status !== "approved" && run.status !== "promoting")) {
      throw new Error("run is not approved for promotion");
    }
    if (run.subjectHash !== subjectHash || !this.hasApproval(runId, subjectHash)) {
      throw new Error("promotion subject does not match exact approval");
    }
    if (run.status === "promoting") return run;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.updateRun(runId, { status: "promoting" });
      this.appendEvent(`run:${runId}`, "run.promotion_intended", { runId, subjectHash });
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markPromoted(runId: string, subjectHash: string): DurableRun {
    const run = this.getRun(runId);
    if (!run || run.status !== "promoting" || run.subjectHash !== subjectHash) {
      throw new Error("run has no matching promotion intent");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.updateRun(runId, { status: "promoted", completedAt: new Date().toISOString(), outcome: "promoted_to_canonical" });
      this.appendEvent(`run:${runId}`, "run.promoted", { runId, subjectHash });
      this.db.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  openAttention(input: Omit<AttentionItem, "id" | "state" | "createdAt">): AttentionItem {
    const existing = input.kind === "input_required" && input.requestId
      ? undefined
      : this.db.prepare(
        "SELECT * FROM attention WHERE task_id = ? AND kind = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1",
      ).get(input.taskId, input.kind) as Record<string, unknown> | undefined;
    if (existing) return decodeAttention(existing);
    const item: AttentionItem = { ...input, id: randomUUID(), state: "open", createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO attention(
      id, project_id, task_id, run_id, agent_id, channel, link, request_id,
      options_json, kind, state, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(
      item.id, item.projectId, item.taskId, item.runId ?? null,
      item.agentId ?? null, item.channel ?? null, item.link ?? null,
      item.requestId ?? null, item.options ? canonicalJson(item.options) : null,
      item.kind, item.message, item.createdAt,
    );
    this.appendEvent(`attention:${item.id}`, "attention.opened", {
      attentionId: item.id, projectId: item.projectId, runId: item.runId,
      taskId: item.taskId, agentId: item.agentId, channel: item.channel,
      link: item.link, requestId: item.requestId, options: item.options,
      kind: item.kind, message: item.message,
    });
    return item;
  }

  getAttention(id: string): AttentionItem | undefined {
    const row = this.db.prepare("SELECT * FROM attention WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? decodeAttention(row) : undefined;
  }

  getInputAttention(taskId: string, requestId: string): AttentionItem | undefined {
    const row = this.db.prepare(
      "SELECT * FROM attention WHERE task_id = ? AND kind = 'input_required' AND request_id = ? LIMIT 1",
    ).get(taskId, requestId) as Record<string, unknown> | undefined;
    return row ? decodeAttention(row) : undefined;
  }

  countOpenInputAttention(projectId: string, taskId?: string): number {
    const row = taskId
      ? this.db.prepare("SELECT COUNT(*) AS count FROM attention WHERE project_id = ? AND task_id = ? AND kind = 'input_required' AND state = 'open'").get(projectId, taskId)
      : this.db.prepare("SELECT COUNT(*) AS count FROM attention WHERE project_id = ? AND kind = 'input_required' AND state = 'open'").get(projectId);
    return Number((row as { count: number }).count);
  }

  openInputAttention(input: Omit<AttentionItem, "id" | "kind" | "state" | "createdAt" | "resolvedAt"> & {
    requestId: string;
    options: string[];
  }): { attention: AttentionItem; created: boolean } {
    const existing = this.getInputAttention(input.taskId, input.requestId);
    if (existing) {
      if (
        existing.projectId !== input.projectId ||
        existing.runId !== input.runId ||
        existing.agentId !== input.agentId ||
        existing.channel !== input.channel ||
        existing.message !== input.message ||
        canonicalJson(existing.options ?? []) !== canonicalJson(input.options)
      ) {
        throw new Error("input request id was already used with different content");
      }
      return { attention: existing, created: false };
    }
    return {
      attention: this.openAttention({ ...input, kind: "input_required" }),
      created: true,
    };
  }

  resolveAttention(id: string, resolution: string): AttentionItem {
    const item = this.getAttention(id);
    if (!item) throw new Error("unknown attention item");
    if (item.state !== "open") throw new Error("attention item is already resolved");
    const resolvedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE attention SET state='resolved', resolved_at=? WHERE id=? AND state='open'")
        .run(resolvedAt, id);
      this.appendEvent(`attention:${id}`, "attention.resolved", { attentionId: id, resolution });
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    return { ...item, state: "resolved", resolvedAt };
  }

  resolveAttentionForTask(taskId: string, resolution: string): void {
    const rows = this.db.prepare("SELECT id FROM attention WHERE task_id = ? AND state = 'open'").all(taskId) as unknown as Array<{ id: string }>;
    const resolvedAt = new Date().toISOString();
    for (const row of rows) {
      this.db.prepare("UPDATE attention SET state='resolved', resolved_at=? WHERE id=?").run(resolvedAt, row.id);
      this.appendEvent(`attention:${row.id}`, "attention.resolved", { attentionId: row.id, resolution });
    }
  }

  listAttention(state: "open" | "resolved" | "all" = "open"): AttentionItem[] {
    const rows = state === "all"
      ? this.db.prepare("SELECT * FROM attention ORDER BY created_at DESC LIMIT 500").all()
      : this.db.prepare("SELECT * FROM attention WHERE state = ? ORDER BY created_at DESC LIMIT 500").all(state);
    return (rows as unknown as Record<string, unknown>[]).map(decodeAttention);
  }

  /** Rebuild the attention read model from the immutable event ledger. */
  rebuildAttentionProjection(): void {
    const events = this.db.prepare(
      "SELECT event_type, payload_json, created_at FROM events WHERE event_type IN ('attention.opened','attention.resolved') ORDER BY created_at, stream_id, sequence",
    ).all() as unknown as Array<{ event_type: RunEventType; payload_json: string; created_at: string }>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM attention");
      for (const event of events) {
        const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
        if (event.event_type === "attention.opened") {
          if (
            typeof payload.attentionId !== "string" ||
            typeof payload.taskId !== "string" ||
            typeof payload.kind !== "string"
          ) {
            throw new Error("invalid attention.opened event in ledger");
          }
          const runId = typeof payload.runId === "string" ? payload.runId : undefined;
          const run = runId ? this.getRun(runId) : undefined;
          const projectId = typeof payload.projectId === "string" ? payload.projectId : (run?.projectId ?? "unknown");
          const options = Array.isArray(payload.options)
            ? payload.options.filter((item): item is string => typeof item === "string")
            : undefined;
          this.db.prepare(`INSERT INTO attention(
            id, project_id, task_id, run_id, agent_id, channel, link, request_id,
            options_json, kind, state, message, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(
            payload.attentionId, projectId, payload.taskId, runId ?? null,
            typeof payload.agentId === "string" ? payload.agentId : null,
            typeof payload.channel === "string" ? payload.channel : null,
            typeof payload.link === "string" ? payload.link : null,
            typeof payload.requestId === "string" ? payload.requestId : null,
            options ? canonicalJson(options) : null,
            payload.kind, typeof payload.message === "string" ? payload.message : "", event.created_at,
          );
        } else {
          if (typeof payload.attentionId !== "string") throw new Error("invalid attention.resolved event in ledger");
          this.db.prepare("UPDATE attention SET state='resolved', resolved_at=? WHERE id=?").run(event.created_at, payload.attentionId);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setRunTerminal(runId: string, status: DurableRunStatus, outcome: string, metrics: DurableRun["metrics"]): DurableRun {
    return this.updateRun(runId, { status, outcome, metrics, completedAt: new Date().toISOString() });
  }

  factoryReset(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER IF EXISTS approvals_immutable_update;
      DROP TRIGGER IF EXISTS approvals_immutable_delete;
      DELETE FROM approvals;
      DELETE FROM attention;
      DELETE FROM events;
      DELETE FROM runs;
      DELETE FROM artifacts;
      CREATE TRIGGER approvals_immutable_update BEFORE UPDATE ON approvals BEGIN
        SELECT RAISE(ABORT, 'approval records are immutable');
      END;
      CREATE TRIGGER approvals_immutable_delete BEFORE DELETE ON approvals BEGIN
        SELECT RAISE(ABORT, 'approval records are immutable');
      END;
      COMMIT;
    `);
    fs.rmSync(this.artifactsDir, { recursive: true, force: true });
    fs.mkdirSync(this.artifactsDir, { recursive: true, mode: 0o700 });
  }
}

function hashEvent(streamId: string, sequence: number, eventType: string, payloadJson: string, previousHash: string, createdAt: string): string {
  return createHash("sha256").update(canonicalJson({ streamId, sequence, eventType, payloadJson, previousHash, createdAt })).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortJson(v)]));
  }
  return value;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error("payload nesting exceeds limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("payload contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("payload array exceeds limit");
    return value.map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 256) throw new Error("payload object exceeds limit");
    return Object.fromEntries(entries
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1)]));
  }
  throw new Error("payload is not JSON serializable");
}

function decodeRun(row: Record<string, unknown>): DurableRun {
  return {
    id: String(row.id), taskId: String(row.task_id), projectId: String(row.project_id),
    sessionId: row.session_id ? String(row.session_id) : undefined, attempt: Number(row.attempt),
    status: String(row.status) as DurableRunStatus, canonicalRoot: String(row.canonical_root),
    worktreePath: row.worktree_path ? String(row.worktree_path) : undefined,
    worktreeBranch: row.worktree_branch ? String(row.worktree_branch) : undefined,
    baseHead: row.base_head ? String(row.base_head) : undefined,
    parentSubjectHash: row.parent_subject_hash ? String(row.parent_subject_hash) : undefined,
    subjectHash: row.subject_hash ? String(row.subject_hash) : undefined,
    diffArtifactHash: row.diff_artifact_hash ? String(row.diff_artifact_hash) : undefined,
    statusArtifactHash: row.status_artifact_hash ? String(row.status_artifact_hash) : undefined,
    startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : undefined,
    outcome: row.outcome ? String(row.outcome) : undefined,
    metrics: JSON.parse(String(row.metrics_json)) as DurableRun["metrics"],
  };
}

function decodeAttention(row: Record<string, unknown>): AttentionItem {
  return {
    id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id),
    runId: row.run_id ? String(row.run_id) : undefined,
    agentId: row.agent_id ? String(row.agent_id) : undefined,
    channel: row.channel ? String(row.channel) : undefined,
    link: row.link ? String(row.link) : undefined,
    requestId: row.request_id ? String(row.request_id) : undefined,
    options: row.options_json ? JSON.parse(String(row.options_json)) as string[] : undefined,
    kind: String(row.kind) as AttentionItem["kind"], state: String(row.state) as AttentionItem["state"],
    message: String(row.message), createdAt: String(row.created_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
  };
}
