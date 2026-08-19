import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AUDIT_RETENTION_DAYS,
  AUDIT_RETENTION_MS,
  auditCategorySchema,
  auditOutcomeSchema,
  auditActorSchema,
  type AuditActor,
  type AuditCategory,
  type AuditEntry,
  type AuditMetadataValue,
  type AuditOutcome,
  type AuditSummary,
} from "@daimon-os/shared";

const MAX_QUERY_LIMIT = 500;
const MAX_RETAINED_ENTRIES = 50_000;
const MAX_METADATA_KEYS = 32;
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:secret|token|password|passphrase|api[-_]?key|authorization|cookie|private[-_]?key|credential)/i;
const SENSITIVE_TEXT = /((?:bearer\s+)|(?:secret|token|password|passphrase|api[-_]?key|authorization|cookie|private[-_]?key|credential)\s*[=:]\s*)[^\s,;]+/gi;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PROVIDER_TOKEN_LIKE = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{16,})\b/g;

export interface AuditRecordInput {
  category: AuditCategory;
  action: string;
  outcome?: AuditOutcome;
  actor: AuditActor;
  projectId?: string;
  entityType?: string;
  entityId?: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface AuditListQuery {
  category?: AuditCategory;
  projectId?: string;
  q?: string;
  beforeMs?: number;
  beforeId?: string;
  limit?: number;
}

interface AuditRow {
  id: string;
  created_at_ms: number;
  expires_at_ms: number;
  category: string;
  action: string;
  outcome: string;
  actor: string;
  project_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  summary: string;
  metadata_json: string;
}

/**
 * Redacted operator audit projection. This is intentionally separate from the
 * immutable durable execution ledger: its purpose is fast five-day inspection,
 * not permanent evidence retention. No prompts, terminal output, file contents,
 * or credential values are accepted by this interface.
 */
export class AuditStore {
  private readonly db: DatabaseSync;
  private purgeTimer?: NodeJS.Timeout;

  constructor(readonly dataDir: string, private readonly now: () => number = Date.now) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const databasePath = path.join(dataDir, "audit.sqlite");
    this.db = new DatabaseSync(databasePath);
    try { fs.chmodSync(databasePath, 0o600); } catch { /* best effort on non-POSIX platforms */ }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS audit_entries (
        id TEXT PRIMARY KEY,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('configuration', 'work', 'security')),
        action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 96),
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'warning')),
        actor TEXT NOT NULL CHECK(actor IN ('operator', 'renderer', 'lead', 'system')),
        project_id TEXT,
        entity_type TEXT,
        entity_id TEXT,
        summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 512),
        metadata_json TEXT NOT NULL,
        CHECK(expires_at_ms = created_at_ms + ${AUDIT_RETENTION_MS})
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_entries_expiry_idx ON audit_entries(expires_at_ms);
      CREATE INDEX IF NOT EXISTS audit_entries_recent_idx ON audit_entries(created_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS audit_entries_project_idx ON audit_entries(project_id, created_at_ms DESC);
    `);
    this.purgeExpired();
  }

  close(): void {
    if (this.purgeTimer) clearTimeout(this.purgeTimer);
    this.purgeTimer = undefined;
    this.db.close();
  }

  record(input: AuditRecordInput): AuditEntry {
    return this.recordAt(input, this.now())!;
  }

  /**
   * Project a historical event without resetting its retention clock. Returns
   * undefined when the source event has already reached the five-day boundary.
   */
  recordHistorical(input: AuditRecordInput, occurredAtMs: number): AuditEntry | undefined {
    const currentMs = this.now();
    if (!Number.isFinite(occurredAtMs) || occurredAtMs > currentMs) {
      throw new Error("historical audit timestamp must be finite and not in the future");
    }
    if (occurredAtMs + AUDIT_RETENTION_MS <= currentMs) return undefined;
    return this.recordAt(input, Math.trunc(occurredAtMs));
  }

  private recordAt(input: AuditRecordInput, createdAtMs: number): AuditEntry | undefined {
    const category = auditCategorySchema.parse(input.category);
    const outcome = auditOutcomeSchema.parse(input.outcome ?? "success");
    const actor = auditActorSchema.parse(input.actor);
    const expiresAtMs = createdAtMs + AUDIT_RETENTION_MS;
    const action = boundedText(input.action, 96, "audit action");
    const summary = redactText(boundedText(input.summary, 512, "audit summary"));
    const entityType = optionalBoundedText(input.entityType, 64);
    const entityId = optionalBoundedText(input.entityId, 256);
    const projectId = input.projectId?.trim() || undefined;
    const metadata = sanitizeMetadata(input.metadata);
    const id = randomUUID();

    this.purgeExpired(false);
    this.db.prepare(`
      INSERT INTO audit_entries(
        id, created_at_ms, expires_at_ms, category, action, outcome, actor,
        project_id, entity_type, entity_id, summary, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      createdAtMs,
      expiresAtMs,
      category,
      action,
      outcome,
      actor,
      projectId ?? null,
      entityType ?? null,
      entityId ?? null,
      summary,
      JSON.stringify(metadata),
    );
    const capacityResult = this.db.prepare(`
      DELETE FROM audit_entries
      WHERE id IN (
        SELECT id FROM audit_entries
        ORDER BY created_at_ms DESC, id DESC
        LIMIT -1 OFFSET ${MAX_RETAINED_ENTRIES}
      )
    `).run();
    if (Number(capacityResult.changes) > 0) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.scheduleNextPurge();
    return decodeRow({
      id,
      created_at_ms: createdAtMs,
      expires_at_ms: expiresAtMs,
      category,
      action,
      outcome,
      actor,
      project_id: projectId ?? null,
      entity_type: entityType ?? null,
      entity_id: entityId ?? null,
      summary,
      metadata_json: JSON.stringify(metadata),
    });
  }

  list(query: AuditListQuery = {}): AuditEntry[] {
    this.purgeExpired();
    const clauses = ["expires_at_ms > ?"];
    const values: Array<string | number> = [this.now()];
    if (query.category) {
      clauses.push("category = ?");
      values.push(auditCategorySchema.parse(query.category));
    }
    if (query.projectId) {
      clauses.push("project_id = ?");
      values.push(query.projectId);
    }
    if (query.beforeMs !== undefined && Number.isFinite(query.beforeMs)) {
      const beforeMs = Math.trunc(query.beforeMs);
      if (query.beforeId) {
        clauses.push("(created_at_ms < ? OR (created_at_ms = ? AND id < ?))");
        values.push(beforeMs, beforeMs, query.beforeId);
      } else {
        clauses.push("created_at_ms < ?");
        values.push(beforeMs);
      }
    }
    const q = query.q?.trim().slice(0, 100);
    if (q) {
      clauses.push("(lower(summary) LIKE ? OR lower(action) LIKE ? OR lower(COALESCE(entity_id, '')) LIKE ?)");
      const pattern = `%${q.toLowerCase()}%`;
      values.push(pattern, pattern, pattern);
    }
    const limit = Math.max(1, Math.min(MAX_QUERY_LIMIT, Math.trunc(query.limit ?? 200)));
    values.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM audit_entries
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at_ms DESC, id DESC
      LIMIT ?
    `).all(...values) as unknown as AuditRow[];
    return rows.map(decodeRow);
  }

  summary(): AuditSummary {
    this.purgeExpired();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN category = 'configuration' THEN 1 ELSE 0 END) AS configuration,
        SUM(CASE WHEN category = 'work' THEN 1 ELSE 0 END) AS work,
        SUM(CASE WHEN category = 'security' THEN 1 ELSE 0 END) AS security,
        MIN(created_at_ms) AS oldest,
        MAX(created_at_ms) AS newest
      FROM audit_entries
      WHERE expires_at_ms > ?
    `).get(this.now()) as {
      total: number;
      configuration: number;
      work: number;
      security: number;
      oldest: number | null;
      newest: number | null;
    };
    return {
      retentionDays: AUDIT_RETENTION_DAYS,
      total: Number(row.total),
      configuration: Number(row.configuration),
      work: Number(row.work),
      security: Number(row.security),
      ...(row.oldest === null ? {} : { oldestRetainedAt: new Date(Number(row.oldest)).toISOString() }),
      ...(row.newest === null ? {} : { newestAt: new Date(Number(row.newest)).toISOString() }),
    };
  }

  purgeExpired(reschedule = true): number {
    const result = this.db.prepare("DELETE FROM audit_entries WHERE expires_at_ms <= ?").run(this.now());
    if (Number(result.changes) > 0) this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (reschedule) this.scheduleNextPurge();
    return Number(result.changes);
  }

  private scheduleNextPurge(): void {
    if (this.purgeTimer) clearTimeout(this.purgeTimer);
    this.purgeTimer = undefined;
    const row = this.db.prepare("SELECT MIN(expires_at_ms) AS next_expiry FROM audit_entries").get() as {
      next_expiry: number | null;
    };
    if (row.next_expiry === null) return;
    const delay = Math.max(0, Number(row.next_expiry) - this.now());
    this.purgeTimer = setTimeout(() => this.purgeExpired(), delay);
    this.purgeTimer.unref();
  }
}

function decodeRow(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    expiresAt: new Date(Number(row.expires_at_ms)).toISOString(),
    category: auditCategorySchema.parse(row.category),
    action: row.action,
    outcome: auditOutcomeSchema.parse(row.outcome),
    actor: auditActorSchema.parse(row.actor),
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.entity_type ? { entityType: row.entity_type } : {}),
    ...(row.entity_id ? { entityId: row.entity_id } : {}),
    summary: row.summary,
    metadata: JSON.parse(row.metadata_json) as Record<string, AuditMetadataValue>,
  };
}

function boundedText(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed.slice(0, max);
}

function optionalBoundedText(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function redactText(value: string): string {
  return value
    .replace(SENSITIVE_TEXT, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(JWT_LIKE, REDACTED)
    .replace(PROVIDER_TOKEN_LIKE, REDACTED);
}

function sanitizeMetadata(input: Record<string, unknown> | undefined): Record<string, AuditMetadataValue> {
  if (!input) return {};
  const result: Record<string, AuditMetadataValue> = {};
  for (const [rawKey, rawValue] of Object.entries(input).slice(0, MAX_METADATA_KEYS)) {
    const key = rawKey.trim().slice(0, 64);
    if (!key) continue;
    if (SENSITIVE_KEY.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    if (rawValue === null || typeof rawValue === "boolean") result[key] = rawValue;
    else if (typeof rawValue === "number" && Number.isFinite(rawValue)) result[key] = rawValue;
    else if (typeof rawValue === "string") result[key] = redactText(rawValue.slice(0, 256));
  }
  return result;
}
