import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalRequest,
  ApprovalRoute,
  ApprovalStatus,
  CapabilityGrant,
  CapabilityScope,
  ControlKernelSummary,
  CoordinationArtifact,
  CoordinationMessage,
  DelegationRecord,
  EffectRecord,
  EffectStatus,
  LivenessRecord,
  LivenessState,
  NetworkCapability,
  ObservationConfidence,
  SchedulerCandidate,
  SchedulerLaneState,
  SchedulerWakeup,
  StateSchemaRecord,
  VersionedStateRecord,
} from "./types";

const SCHEMA_VERSION = 2;
const ZERO_HASH = "0".repeat(64);
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/;
const MAX_JSON_BYTES = 256 * 1024;
const SENSITIVE_KEY = /(?:secret|token|password|passphrase|api[-_]?key|authorization|cookie|private[-_]?key)/i;
const REDACTED = "[REDACTED]";

type JsonObject = Record<string, unknown>;

/**
 * Durable local control kernel. Callers express domain intent; transaction,
 * idempotency, hash chaining, projection updates, and recovery semantics remain
 * inside this module.
 */
export class ControlKernel {
  private readonly db: DatabaseSync;
  private readonly stateMigrations = new Map<string, {
    name: string;
    migrate: (payload: unknown) => unknown;
  }>();

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(dataDir, "control.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec("CREATE TABLE IF NOT EXISTS control_schema_meta (version INTEGER NOT NULL)");
    const row = this.db.prepare("SELECT version FROM control_schema_meta LIMIT 1").get() as
      | { version: number }
      | undefined;
    const version = row?.version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`control database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version === 0) {
      this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE control_events (
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
      CREATE TABLE effects (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        project_id TEXT,
        run_id TEXT,
        kind TEXT NOT NULL,
        target TEXT NOT NULL,
        intent_hash TEXT NOT NULL CHECK(length(intent_hash) = 64),
        status TEXT NOT NULL CHECK(status IN ('planned','committed','failed','uncertain','reconciled')),
        result_hash TEXT CHECK(result_hash IS NULL OR length(result_hash) = 64),
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX effects_status_idx ON effects(status, updated_at DESC);
      CREATE TABLE delegations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        run_id TEXT,
        parent_delegation_id TEXT REFERENCES delegations(id),
        parent_agent_id TEXT,
        child_agent_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        model TEXT,
        instruction_hash TEXT NOT NULL CHECK(length(instruction_hash) = 64),
        instruction_artifact_hash TEXT NOT NULL CHECK(length(instruction_artifact_hash) = 64),
        policy_hash TEXT NOT NULL CHECK(length(policy_hash) = 64),
        capability_grant_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, child_agent_id)
      ) STRICT;
      CREATE INDEX delegations_project_created_idx ON delegations(project_id, created_at DESC);
      CREATE TABLE liveness (
        channel TEXT PRIMARY KEY,
        project_id TEXT,
        task_id TEXT,
        run_id TEXT,
        agent_id TEXT,
        state TEXT NOT NULL,
        wait_reason TEXT,
        confidence TEXT NOT NULL CHECK(confidence IN ('reported','observed','inferred')),
        active_tools_json TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        last_output_at TEXT,
        lease_expires_at TEXT NOT NULL,
        terminal INTEGER NOT NULL CHECK(terminal IN (0,1))
      ) STRICT;
      CREATE INDEX liveness_project_idx ON liveness(project_id, terminal, last_event_at DESC);
      CREATE TABLE scheduler_lanes (
        project_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        weight INTEGER NOT NULL CHECK(weight > 0),
        dispatch_count INTEGER NOT NULL CHECK(dispatch_count >= 0),
        last_dispatched_at TEXT,
        PRIMARY KEY(project_id, lane)
      ) STRICT;
      CREATE TABLE scheduler_wakeups (
        task_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        wake_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('scheduled','fired','cancelled')),
        created_at TEXT NOT NULL,
        fired_at TEXT
      ) STRICT;
      CREATE INDEX scheduler_wakeups_due_idx ON scheduler_wakeups(state, wake_at);
      CREATE TABLE state_schemas (
        name TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        compatibility_hash TEXT NOT NULL CHECK(length(compatibility_hash) = 64),
        created_at TEXT NOT NULL,
        PRIMARY KEY(name, version)
      ) STRICT;
      CREATE TABLE versioned_state (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        schema_name TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK(schema_version > 0),
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64),
        migration_history_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(schema_name, schema_version) REFERENCES state_schemas(name, version)
      ) STRICT;
      CREATE INDEX versioned_state_owner_idx ON versioned_state(owner_type, owner_id);
      CREATE TABLE capability_grants (
        id TEXT PRIMARY KEY,
        parent_grant_id TEXT REFERENCES capability_grants(id),
        project_id TEXT NOT NULL,
        subject_type TEXT NOT NULL CHECK(subject_type IN ('agent','run','remote-peer')),
        subject_id TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        issued_by TEXT NOT NULL CHECK(issued_by IN ('human-local','daimon')),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        receipt_hash TEXT NOT NULL UNIQUE CHECK(length(receipt_hash) = 64)
      ) STRICT;
      CREATE INDEX capability_grants_subject_idx ON capability_grants(project_id, subject_type, subject_id);
      CREATE TABLE coordination_artifacts (
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        owner_agent_id TEXT NOT NULL,
        content_hash TEXT NOT NULL CHECK(length(content_hash) = 64),
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, name, version)
      ) STRICT;
      CREATE TABLE coordination_messages (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('finding','question','answer','handoff','steering','artifact','status')),
        body_artifact_hash TEXT NOT NULL CHECK(length(body_artifact_hash) = 64),
        artifact_name TEXT,
        artifact_version INTEGER,
        causation_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id,idempotency_key)
      ) STRICT;
      CREATE INDEX coordination_messages_project_idx ON coordination_messages(project_id, created_at DESC);
      CREATE TABLE approval_requests (
        id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        task_id TEXT,
        run_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('run-promotion','memory-write','capability','effect','policy')),
        subject_hash TEXT NOT NULL CHECK(length(subject_hash) = 64),
        requested_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','revoked')),
        policy_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        decision_reason TEXT,
        response_id TEXT UNIQUE,
        applied_at TEXT
      ) STRICT;
      CREATE INDEX approval_requests_status_idx ON approval_requests(status, expires_at);
      CREATE TABLE approval_routes (
        id TEXT PRIMARY KEY,
        approval_id TEXT NOT NULL REFERENCES approval_requests(id),
        channel TEXT NOT NULL CHECK(channel IN ('desktop','mcp','external')),
        recipient TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','expired')),
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(approval_id, channel, recipient, attempt)
      ) STRICT;
      DELETE FROM control_schema_meta;
      INSERT INTO control_schema_meta(version) VALUES (2);
      COMMIT;
    `);
      return;
    }
    if (version === 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE coordination_messages_v2 (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL,
          project_id TEXT NOT NULL,
          from_agent_id TEXT NOT NULL,
          to_agent_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('finding','question','answer','handoff','steering','artifact','status')),
          body_artifact_hash TEXT NOT NULL CHECK(length(body_artifact_hash) = 64),
          artifact_name TEXT,
          artifact_version INTEGER,
          causation_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(project_id,idempotency_key)
        ) STRICT;
        INSERT INTO coordination_messages_v2(
          id,idempotency_key,project_id,from_agent_id,to_agent_id,kind,body_artifact_hash,
          artifact_name,artifact_version,causation_id,created_at
        ) SELECT id,idempotency_key,project_id,from_agent_id,to_agent_id,kind,body_artifact_hash,
          artifact_name,artifact_version,COALESCE(causation_id,'legacy:' || id),created_at
          FROM coordination_messages;
        DROP TABLE coordination_messages;
        ALTER TABLE coordination_messages_v2 RENAME TO coordination_messages;
        CREATE INDEX coordination_messages_project_idx ON coordination_messages(project_id, created_at DESC);
        UPDATE control_schema_meta SET version=2;
        COMMIT;
      `);
    }
  }

  private transaction<T>(fn: () => T): T {
    const owns = !this.db.isTransaction;
    if (owns) this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      if (owns) this.db.exec("COMMIT");
      return result;
    } catch (error) {
      if (owns && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private appendEvent(streamId: string, eventType: string, payload: unknown): void {
    if (!NAME.test(streamId) || !NAME.test(eventType)) throw new Error("invalid control event identity");
    const payloadJson = canonicalJson(redact(payload));
    if (Buffer.byteLength(payloadJson) > MAX_JSON_BYTES) throw new Error("control event payload exceeds 256 KiB");
    const previous = this.db.prepare(
      "SELECT sequence, event_hash FROM control_events WHERE stream_id=? ORDER BY sequence DESC LIMIT 1",
    ).get(streamId) as { sequence: number; event_hash: string } | undefined;
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.event_hash ?? ZERO_HASH;
    const createdAt = new Date().toISOString();
    const eventHash = sha256(canonicalJson({ streamId, sequence, eventType, payloadJson, previousHash, createdAt }));
    this.db.prepare(`INSERT INTO control_events(
      stream_id, sequence, event_type, payload_json, previous_hash, event_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      streamId,
      sequence,
      eventType,
      payloadJson,
      previousHash,
      eventHash,
      createdAt,
    );
  }

  verifyStream(streamId: string): { valid: boolean; events: number; error?: string } {
    const rows = this.db.prepare(
      "SELECT * FROM control_events WHERE stream_id=? ORDER BY sequence",
    ).all(streamId) as unknown as Array<Record<string, unknown>>;
    let previousHash = ZERO_HASH;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const expected = sha256(canonicalJson({
        streamId: row.stream_id,
        sequence: row.sequence,
        eventType: row.event_type,
        payloadJson: row.payload_json,
        previousHash: row.previous_hash,
        createdAt: row.created_at,
      }));
      if (Number(row.sequence) !== index + 1 || row.previous_hash !== previousHash || row.event_hash !== expected) {
        return { valid: false, events: rows.length, error: `hash chain mismatch at sequence ${row.sequence}` };
      }
      previousHash = String(row.event_hash);
    }
    return { valid: true, events: rows.length };
  }

  beginEffect(input: {
    idempotencyKey: string;
    projectId?: string;
    runId?: string;
    kind: string;
    target: string;
    intent: unknown;
  }): { effect: EffectRecord; replay: boolean } {
    const idempotencyKey = bounded(input.idempotencyKey, 512, "effect idempotency key");
    const kind = named(input.kind, "effect kind");
    const target = bounded(input.target, 2_048, "effect target");
    const intentHash = sha256(canonicalJson(redact(input.intent)));
    const existing = this.getEffectByKey(idempotencyKey);
    if (existing) {
      if (existing.kind !== kind || existing.target !== target || existing.intentHash !== intentHash) {
        throw new Error("effect idempotency key was already used with different intent");
      }
      return { effect: existing, replay: true };
    }
    const now = new Date().toISOString();
    const effect: EffectRecord = {
      id: randomUUID(),
      idempotencyKey,
      projectId: input.projectId,
      runId: input.runId,
      kind,
      target,
      intentHash,
      status: "planned",
      createdAt: now,
      updatedAt: now,
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO effects(
        id,idempotency_key,project_id,run_id,kind,target,intent_hash,status,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'planned',?,?)`).run(
        effect.id, effect.idempotencyKey, effect.projectId ?? null, effect.runId ?? null,
        effect.kind, effect.target, effect.intentHash, now, now,
      );
      this.appendEvent(`effect:${effect.id}`, "effect.planned", effect);
    });
    return { effect, replay: false };
  }

  settleEffect(
    id: string,
    status: Exclude<EffectStatus, "planned">,
    input: { result?: unknown; detail?: string } = {},
  ): EffectRecord {
    const current = this.getEffect(id);
    if (!current) throw new Error("unknown effect");
    const resultHash = input.result === undefined ? current.resultHash : sha256(canonicalJson(redact(input.result)));
    const detail = input.detail ? bounded(input.detail, 4_096, "effect detail") : undefined;
    if (current.status === "committed" || current.status === "reconciled") {
      if ((status === current.status || status === "reconciled") && current.resultHash === resultHash) return current;
      throw new Error("settled effect is immutable");
    }
    if (status === "reconciled" && current.status !== "uncertain" && current.status !== "failed") {
      throw new Error("only uncertain or failed effects can be reconciled");
    }
    const updatedAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE effects SET status=?,result_hash=?,detail=?,updated_at=? WHERE id=?")
        .run(status, resultHash ?? null, detail ?? null, updatedAt, id);
      this.appendEvent(`effect:${id}`, `effect.${status}`, { id, status, resultHash, detail });
    });
    return { ...current, status, resultHash, detail, updatedAt };
  }

  getEffect(id: string): EffectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM effects WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? decodeEffect(row) : undefined;
  }

  getEffectByKey(idempotencyKey: string): EffectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM effects WHERE idempotency_key=?").get(idempotencyKey) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeEffect(row) : undefined;
  }

  listEffects(status?: EffectStatus): EffectRecord[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM effects WHERE status=? ORDER BY updated_at DESC LIMIT 500").all(status)
      : this.db.prepare("SELECT * FROM effects ORDER BY updated_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeEffect);
  }

  recordDelegation(input: Omit<DelegationRecord, "id" | "createdAt">): DelegationRecord {
    for (const value of [input.instructionHash, input.instructionArtifactHash, input.policyHash]) assertHash(value);
    const existing = input.runId
      ? this.db.prepare("SELECT * FROM delegations WHERE run_id=? AND child_agent_id=?")
        .get(input.runId, input.childAgentId) as Record<string, unknown> | undefined
      : undefined;
    if (existing) {
      const decoded = decodeDelegation(existing);
      const same = decoded.instructionHash === input.instructionHash &&
        decoded.policyHash === input.policyHash &&
        decoded.capabilityGrantId === input.capabilityGrantId;
      if (!same) throw new Error("run delegation already exists with different policy or instruction");
      return decoded;
    }
    const grant = this.getCapabilityGrant(input.capabilityGrantId);
    if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now()) {
      throw new Error("delegation capability grant is unavailable");
    }
    if (grant.projectId !== input.projectId || grant.subjectId !== (input.runId ?? input.childAgentId)) {
      throw new Error("delegation capability grant does not match the child scope");
    }
    const record: DelegationRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO delegations(
        id,project_id,task_id,run_id,parent_delegation_id,parent_agent_id,child_agent_id,
        provider_kind,model,instruction_hash,instruction_artifact_hash,policy_hash,capability_grant_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, record.projectId, record.taskId, record.runId ?? null,
        record.parentDelegationId ?? null, record.parentAgentId ?? null, record.childAgentId,
        record.providerKind, record.model ?? null, record.instructionHash,
        record.instructionArtifactHash, record.policyHash, record.capabilityGrantId, record.createdAt,
      );
      this.appendEvent(`delegation:${record.id}`, "delegation.recorded", record);
    });
    return record;
  }

  listDelegations(projectId?: string): DelegationRecord[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM delegations WHERE project_id=? ORDER BY created_at DESC LIMIT 500").all(projectId)
      : this.db.prepare("SELECT * FROM delegations ORDER BY created_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeDelegation);
  }

  observeLiveness(input: {
    channel: string;
    projectId?: string;
    taskId?: string;
    runId?: string;
    agentId?: string;
    state: LivenessState;
    waitReason?: string;
    confidence: ObservationConfidence;
    activeTools?: string[];
    outputObserved?: boolean;
    leaseMs?: number;
    terminal?: boolean;
  }): LivenessRecord {
    const now = new Date();
    const current = this.getLiveness(input.channel);
    if (current?.terminal && !input.terminal) throw new Error("terminal liveness record cannot return to active state");
    const record: LivenessRecord = {
      channel: bounded(input.channel, 128, "channel"),
      projectId: input.projectId ?? current?.projectId,
      taskId: input.taskId ?? current?.taskId,
      runId: input.runId ?? current?.runId,
      agentId: input.agentId ?? current?.agentId,
      state: input.state,
      waitReason: input.waitReason ? bounded(input.waitReason, 1_024, "wait reason") : undefined,
      confidence: input.confidence,
      activeTools: normalizeNames(input.activeTools ?? current?.activeTools ?? [], 64),
      lastEventAt: now.toISOString(),
      lastOutputAt: input.outputObserved ? now.toISOString() : current?.lastOutputAt,
      leaseExpiresAt: new Date(now.getTime() + Math.max(1_000, input.leaseMs ?? 30_000)).toISOString(),
      terminal: input.terminal ?? false,
    };
    const materialChange = !current ||
      current.state !== record.state ||
      current.waitReason !== record.waitReason ||
      current.confidence !== record.confidence ||
      current.terminal !== record.terminal ||
      canonicalJson(current.activeTools) !== canonicalJson(record.activeTools);
    this.transaction(() => {
      this.db.prepare(`INSERT INTO liveness(
        channel,project_id,task_id,run_id,agent_id,state,wait_reason,confidence,active_tools_json,
        last_event_at,last_output_at,lease_expires_at,terminal
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(channel) DO UPDATE SET
        project_id=excluded.project_id,task_id=excluded.task_id,run_id=excluded.run_id,
        agent_id=excluded.agent_id,state=excluded.state,wait_reason=excluded.wait_reason,
        confidence=excluded.confidence,active_tools_json=excluded.active_tools_json,
        last_event_at=excluded.last_event_at,last_output_at=excluded.last_output_at,
        lease_expires_at=excluded.lease_expires_at,terminal=excluded.terminal`).run(
        record.channel, record.projectId ?? null, record.taskId ?? null, record.runId ?? null,
        record.agentId ?? null, record.state, record.waitReason ?? null, record.confidence,
        canonicalJson(record.activeTools), record.lastEventAt, record.lastOutputAt ?? null,
        record.leaseExpiresAt, record.terminal ? 1 : 0,
      );
      const streamId = `liveness:${record.channel}`;
      const streamEvents = this.db.prepare("SELECT COUNT(*) count FROM control_events WHERE stream_id=?")
        .get(streamId) as { count: number };
      if (materialChange && Number(streamEvents.count) < 256) {
        this.appendEvent(streamId, "liveness.observed", {
          state: record.state,
          waitReason: record.waitReason,
          confidence: record.confidence,
          activeTools: record.activeTools,
          leaseExpiresAt: record.leaseExpiresAt,
          terminal: record.terminal,
        });
      }
    });
    return record;
  }

  compactLiveness(now = new Date(), retentionMs = 7 * 24 * 60 * 60 * 1_000): number {
    const cutoff = new Date(now.getTime() - Math.max(60_000, retentionMs)).toISOString();
    const stale = this.db.prepare(
      "SELECT channel FROM liveness WHERE terminal=1 AND last_event_at<? LIMIT 500",
    ).all(cutoff) as Array<{ channel: string }>;
    if (stale.length === 0) return 0;
    this.transaction(() => {
      const deleteEvents = this.db.prepare("DELETE FROM control_events WHERE stream_id=?");
      const deleteProjection = this.db.prepare("DELETE FROM liveness WHERE channel=?");
      for (const row of stale) {
        deleteEvents.run(`liveness:${row.channel}`);
        deleteProjection.run(row.channel);
      }
    });
    return stale.length;
  }

  getLiveness(channel: string): LivenessRecord | undefined {
    const row = this.db.prepare("SELECT * FROM liveness WHERE channel=?").get(channel) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeLiveness(row) : undefined;
  }

  listLiveness(projectId?: string): LivenessRecord[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM liveness WHERE project_id=? ORDER BY last_event_at DESC LIMIT 500").all(projectId)
      : this.db.prepare("SELECT * FROM liveness ORDER BY last_event_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeLiveness);
  }

  expireLiveness(now = new Date()): LivenessRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM liveness WHERE terminal=0 AND state!='unknown' AND lease_expires_at < ?",
    ).all(now.toISOString()) as unknown as Record<string, unknown>[];
    return rows.map((row) => this.observeLiveness({
      ...decodeLiveness(row),
      state: "unknown",
      waitReason: "liveness lease expired",
      confidence: "inferred",
      terminal: false,
    }));
  }

  configureLane(projectId: string, lane: string, weight = 1): SchedulerLaneState {
    const normalizedLane = named(lane, "scheduler lane");
    if (!Number.isInteger(weight) || weight < 1 || weight > 100) throw new Error("lane weight must be 1..100");
    this.db.prepare(`INSERT INTO scheduler_lanes(project_id,lane,weight,dispatch_count)
      VALUES (?,?,?,0) ON CONFLICT(project_id,lane) DO UPDATE SET weight=excluded.weight`)
      .run(projectId, normalizedLane, weight);
    return this.getLane(projectId, normalizedLane)!;
  }

  selectWork(projectId: string, candidates: SchedulerCandidate[], limit: number, now = new Date()): SchedulerCandidate[] {
    if (!Number.isInteger(limit) || limit < 0 || limit > 256) throw new Error("selection limit must be 0..256");
    const unique = new Map<string, SchedulerCandidate>();
    for (const candidate of candidates) {
      if (unique.has(candidate.taskId)) throw new Error("duplicate scheduler candidate");
      const lane = named(candidate.lane || "default", "scheduler lane");
      const priority = Math.max(-100, Math.min(100, Math.trunc(candidate.priority)));
      if (!Number.isFinite(Date.parse(candidate.createdAt))) throw new Error("candidate createdAt is invalid");
      if (candidate.notBefore && !Number.isFinite(Date.parse(candidate.notBefore))) throw new Error("candidate notBefore is invalid");
      if (!candidate.notBefore || Date.parse(candidate.notBefore) <= now.getTime()) {
        unique.set(candidate.taskId, { ...candidate, lane, priority });
      }
    }
    const groups = new Map<string, SchedulerCandidate[]>();
    for (const candidate of unique.values()) {
      const group = groups.get(candidate.lane) ?? [];
      group.push(candidate);
      groups.set(candidate.lane, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
    }
    return this.transaction(() => {
      for (const lane of groups.keys()) this.configureLane(projectId, lane);
      const selected: SchedulerCandidate[] = [];
      while (selected.length < limit && [...groups.values()].some((group) => group.length > 0)) {
        const states = [...groups.keys()]
          .filter((lane) => (groups.get(lane)?.length ?? 0) > 0)
          .map((lane) => this.getLane(projectId, lane)!)
          .sort((a, b) =>
            a.dispatchCount / a.weight - b.dispatchCount / b.weight ||
            (a.lastDispatchedAt ?? "").localeCompare(b.lastDispatchedAt ?? "") ||
            a.lane.localeCompare(b.lane),
          );
        const chosen = states[0];
        if (!chosen) break;
        const candidate = groups.get(chosen.lane)!.shift()!;
        const dispatchedAt = now.toISOString();
        this.db.prepare(`UPDATE scheduler_lanes SET dispatch_count=dispatch_count+1,last_dispatched_at=?
          WHERE project_id=? AND lane=?`).run(dispatchedAt, projectId, chosen.lane);
        this.appendEvent(`scheduler:${projectId}`, "scheduler.selected", {
          taskId: candidate.taskId,
          lane: candidate.lane,
          priority: candidate.priority,
          dispatchedAt,
        });
        selected.push(candidate);
      }
      return selected;
    });
  }

  getLane(projectId: string, lane: string): SchedulerLaneState | undefined {
    const row = this.db.prepare("SELECT * FROM scheduler_lanes WHERE project_id=? AND lane=?")
      .get(projectId, lane) as Record<string, unknown> | undefined;
    return row ? decodeLane(row) : undefined;
  }

  listLanes(projectId?: string): SchedulerLaneState[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM scheduler_lanes WHERE project_id=? ORDER BY lane").all(projectId)
      : this.db.prepare("SELECT * FROM scheduler_lanes ORDER BY project_id,lane").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeLane);
  }

  scheduleWakeup(projectId: string, taskId: string, wakeAt: string): SchedulerWakeup {
    if (!Number.isFinite(Date.parse(wakeAt))) throw new Error("wakeup timestamp is invalid");
    const existing = this.getWakeup(taskId);
    if (existing?.state === "scheduled" && existing.projectId === projectId && existing.wakeAt === wakeAt) {
      return existing;
    }
    const now = new Date().toISOString();
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO scheduler_wakeups(task_id,project_id,wake_at,state,created_at)
        VALUES (?,?,?,'scheduled',?) ON CONFLICT(task_id) DO UPDATE SET
        project_id=excluded.project_id,wake_at=excluded.wake_at,state='scheduled',fired_at=NULL`)
        .run(taskId, projectId, wakeAt, now);
      this.appendEvent(`wakeup:${taskId}`, "wakeup.scheduled", { projectId, taskId, wakeAt });
      return this.getWakeup(taskId)!;
    });
  }

  dueWakeups(now = new Date()): SchedulerWakeup[] {
    const rows = this.db.prepare(
      "SELECT * FROM scheduler_wakeups WHERE state='scheduled' AND wake_at<=? ORDER BY wake_at",
    ).all(now.toISOString()) as unknown as Record<string, unknown>[];
    return rows.map(decodeWakeup);
  }

  fireWakeup(taskId: string, now = new Date()): SchedulerWakeup {
    const current = this.getWakeup(taskId);
    if (!current) throw new Error("unknown wakeup");
    if (current.state === "fired") return current;
    if (current.state !== "scheduled") throw new Error("wakeup is not scheduled");
    if (Date.parse(current.wakeAt) > now.getTime()) throw new Error("wakeup is not due");
    return this.transaction(() => {
      this.db.prepare("UPDATE scheduler_wakeups SET state='fired',fired_at=? WHERE task_id=?")
        .run(now.toISOString(), taskId);
      this.appendEvent(`wakeup:${taskId}`, "wakeup.fired", { taskId, firedAt: now.toISOString() });
      return this.getWakeup(taskId)!;
    });
  }

  cancelWakeup(taskId: string): SchedulerWakeup | undefined {
    const current = this.getWakeup(taskId);
    if (!current || current.state === "cancelled") return current;
    return this.transaction(() => {
      this.db.prepare("UPDATE scheduler_wakeups SET state='cancelled' WHERE task_id=?").run(taskId);
      this.appendEvent(`wakeup:${taskId}`, "wakeup.cancelled", { taskId });
      return this.getWakeup(taskId)!;
    });
  }

  getWakeup(taskId: string): SchedulerWakeup | undefined {
    const row = this.db.prepare("SELECT * FROM scheduler_wakeups WHERE task_id=?").get(taskId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeWakeup(row) : undefined;
  }

  listWakeups(state?: SchedulerWakeup["state"]): SchedulerWakeup[] {
    const rows = state
      ? this.db.prepare("SELECT * FROM scheduler_wakeups WHERE state=? ORDER BY wake_at").all(state)
      : this.db.prepare("SELECT * FROM scheduler_wakeups ORDER BY wake_at").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeWakeup);
  }

  registerStateSchema(name: string, version: number, compatibility: unknown): StateSchemaRecord {
    const schemaName = named(name, "state schema name");
    if (!Number.isInteger(version) || version < 1) throw new Error("state schema version must be positive");
    const compatibilityHash = sha256(canonicalJson(redact(compatibility)));
    const existing = this.getStateSchema(schemaName, version);
    if (existing) {
      if (existing.compatibilityHash !== compatibilityHash) throw new Error("state schema version already has different compatibility");
      return existing;
    }
    const record = { name: schemaName, version, compatibilityHash, createdAt: new Date().toISOString() };
    this.transaction(() => {
      this.db.prepare("INSERT INTO state_schemas(name,version,compatibility_hash,created_at) VALUES (?,?,?,?)")
        .run(record.name, record.version, record.compatibilityHash, record.createdAt);
      this.appendEvent(`schema:${record.name}`, "schema.registered", record);
    });
    return record;
  }

  getStateSchema(name: string, version: number): StateSchemaRecord | undefined {
    const row = this.db.prepare("SELECT * FROM state_schemas WHERE name=? AND version=?").get(name, version) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeStateSchema(row) : undefined;
  }

  listStateSchemas(name?: string): StateSchemaRecord[] {
    const rows = name
      ? this.db.prepare("SELECT * FROM state_schemas WHERE name=? ORDER BY version").all(name)
      : this.db.prepare("SELECT * FROM state_schemas ORDER BY name,version").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeStateSchema);
  }

  putState(input: {
    id: string;
    ownerType: string;
    ownerId: string;
    schemaName: string;
    schemaVersion: number;
    payload: unknown;
  }): VersionedStateRecord {
    if (this.getState(input.id)) throw new Error("state instance already exists");
    if (!this.getStateSchema(input.schemaName, input.schemaVersion)) throw new Error("unregistered state schema version");
    const payloadJson = checkedJson(input.payload, "state payload");
    const now = new Date().toISOString();
    const record: VersionedStateRecord = {
      ...input,
      payload: JSON.parse(payloadJson),
      payloadHash: sha256(payloadJson),
      migrationHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO versioned_state(
        id,owner_type,owner_id,schema_name,schema_version,payload_json,payload_hash,
        migration_history_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, named(record.ownerType, "state owner type"), record.ownerId,
        record.schemaName, record.schemaVersion, payloadJson, record.payloadHash, "[]", now, now,
      );
      this.appendEvent(`state:${record.id}`, "state.created", {
        id: record.id, schemaName: record.schemaName, schemaVersion: record.schemaVersion,
        payloadHash: record.payloadHash,
      });
    });
    return record;
  }

  updateState(input: { id: string; expectedPayloadHash: string; payload: unknown }): VersionedStateRecord {
    assertHash(input.expectedPayloadHash);
    const current = this.getState(input.id);
    if (!current) throw new Error("unknown state instance");
    if (current.payloadHash !== input.expectedPayloadHash) throw new Error("state changed before update");
    const payloadJson = checkedJson(input.payload, "state payload");
    const payloadHash = sha256(payloadJson);
    const updatedAt = new Date().toISOString();
    this.transaction(() => {
      const result = this.db.prepare(`UPDATE versioned_state SET payload_json=?,payload_hash=?,updated_at=?
        WHERE id=? AND payload_hash=?`).run(payloadJson, payloadHash, updatedAt, input.id, input.expectedPayloadHash);
      if (result.changes !== 1) throw new Error("state changed before update");
      this.appendEvent(`state:${input.id}`, "state.updated", {
        schemaVersion: current.schemaVersion,
        priorPayloadHash: current.payloadHash,
        payloadHash,
      });
    });
    return { ...current, payload: JSON.parse(payloadJson), payloadHash, updatedAt };
  }

  registerStateMigration(
    schemaName: string,
    fromVersion: number,
    toVersion: number,
    migration: string,
    migrate: (payload: unknown) => unknown,
  ): void {
    if (toVersion !== fromVersion + 1) throw new Error("state migrations must advance exactly one version");
    if (!this.getStateSchema(schemaName, fromVersion) || !this.getStateSchema(schemaName, toVersion)) {
      throw new Error("state migration schemas must be registered first");
    }
    const key = `${schemaName}:${fromVersion}:${toVersion}`;
    const existing = this.stateMigrations.get(key);
    if (existing && existing.name !== migration) throw new Error("state migration step already has a different name");
    this.stateMigrations.set(key, { name: bounded(migration, 256, "migration name"), migrate });
  }

  readStateLatest(id: string, targetVersion?: number): VersionedStateRecord {
    let current = this.getState(id);
    if (!current) throw new Error("unknown state instance");
    const latest = targetVersion ?? Math.max(...this.listStateSchemas(current.schemaName).map((schema) => schema.version));
    while (current.schemaVersion < latest) {
      const step = this.stateMigrations.get(`${current.schemaName}:${current.schemaVersion}:${current.schemaVersion + 1}`);
      if (!step) throw new Error(`no compatible migration from ${current.schemaName} v${current.schemaVersion}`);
      current = this.migrateState({
        id: current.id,
        expectedPayloadHash: current.payloadHash,
        toVersion: current.schemaVersion + 1,
        migration: step.name,
        payload: step.migrate(current.payload),
      });
    }
    if (current.schemaVersion !== latest) throw new Error("requested state version is older than the stored version");
    return current;
  }

  migrateState(input: {
    id: string;
    expectedPayloadHash: string;
    toVersion: number;
    migration: string;
    payload: unknown;
  }): VersionedStateRecord {
    assertHash(input.expectedPayloadHash);
    const current = this.getState(input.id);
    if (!current) throw new Error("unknown state instance");
    if (current.payloadHash !== input.expectedPayloadHash) throw new Error("state changed before migration");
    if (input.toVersion <= current.schemaVersion) throw new Error("state migration must increase the version");
    if (!this.getStateSchema(current.schemaName, input.toVersion)) throw new Error("target state schema version is unregistered");
    const payloadJson = checkedJson(input.payload, "migrated state payload");
    const updatedAt = new Date().toISOString();
    const history = [...current.migrationHistory, {
      fromVersion: current.schemaVersion,
      toVersion: input.toVersion,
      migration: bounded(input.migration, 256, "migration name"),
      migratedAt: updatedAt,
    }];
    const payloadHash = sha256(payloadJson);
    this.transaction(() => {
      this.db.prepare(`UPDATE versioned_state SET schema_version=?,payload_json=?,payload_hash=?,
        migration_history_json=?,updated_at=? WHERE id=?`).run(
        input.toVersion, payloadJson, payloadHash, canonicalJson(history), updatedAt, input.id,
      );
      this.appendEvent(`state:${input.id}`, "state.migrated", {
        fromVersion: current.schemaVersion, toVersion: input.toVersion,
        migration: input.migration, priorPayloadHash: current.payloadHash, payloadHash,
      });
    });
    return { ...current, schemaVersion: input.toVersion, payload: JSON.parse(payloadJson), payloadHash, migrationHistory: history, updatedAt };
  }

  getState(id: string): VersionedStateRecord | undefined {
    const row = this.db.prepare("SELECT * FROM versioned_state WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeState(row) : undefined;
  }

  listState(ownerType?: string, ownerId?: string): VersionedStateRecord[] {
    const rows = ownerType && ownerId
      ? this.db.prepare("SELECT * FROM versioned_state WHERE owner_type=? AND owner_id=? ORDER BY updated_at DESC").all(ownerType, ownerId)
      : this.db.prepare("SELECT * FROM versioned_state ORDER BY updated_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeState);
  }

  issueCapabilityGrant(input: {
    parentGrantId?: string;
    projectId: string;
    subjectType: CapabilityGrant["subjectType"];
    subjectId: string;
    scope: CapabilityScope;
    issuedBy: CapabilityGrant["issuedBy"];
    expiresAt: string;
  }): CapabilityGrant {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error("capability grant expiry must be in the future");
    }
    const scope = normalizeScope(input.scope);
    const parent = input.parentGrantId ? this.getCapabilityGrant(input.parentGrantId) : undefined;
    if (input.parentGrantId && !parent) throw new Error("unknown parent capability grant");
    if (parent) {
      if (parent.revokedAt || Date.parse(parent.expiresAt) <= Date.now()) throw new Error("parent capability grant is inactive");
      if (parent.projectId !== input.projectId) throw new Error("child capability project does not match parent");
      if (expiresAt.getTime() > Date.parse(parent.expiresAt)) throw new Error("child capability cannot outlive parent");
      assertScopeSubset(scope, parent.scope);
    } else if (input.issuedBy !== "human-local") {
      throw new Error("root capability grants require local-human authority");
    }
    const issuedAt = new Date().toISOString();
    const base = {
      id: randomUUID(), parentGrantId: input.parentGrantId, projectId: input.projectId,
      subjectType: input.subjectType, subjectId: input.subjectId, scope,
      issuedBy: input.issuedBy, issuedAt, expiresAt: expiresAt.toISOString(),
    };
    const grant: CapabilityGrant = { ...base, receiptHash: sha256(canonicalJson(base)) };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO capability_grants(
        id,parent_grant_id,project_id,subject_type,subject_id,scope_json,issued_by,
        issued_at,expires_at,receipt_hash
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        grant.id, grant.parentGrantId ?? null, grant.projectId, grant.subjectType,
        grant.subjectId, canonicalJson(grant.scope), grant.issuedBy, grant.issuedAt,
        grant.expiresAt, grant.receiptHash,
      );
      this.appendEvent(`grant:${grant.id}`, "grant.issued", grant);
    });
    return grant;
  }

  revokeCapabilityGrant(id: string): CapabilityGrant {
    const current = this.getCapabilityGrant(id);
    if (!current) throw new Error("unknown capability grant");
    if (current.revokedAt) return current;
    const revokedAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM capability_grants WHERE id=?
        UNION ALL
        SELECT child.id FROM capability_grants child JOIN descendants parent ON child.parent_grant_id=parent.id
      ) UPDATE capability_grants SET revoked_at=? WHERE id IN (SELECT id FROM descendants) AND revoked_at IS NULL`)
        .run(id, revokedAt);
      this.appendEvent(`grant:${id}`, "grant.revoked", { id, revokedAt, descendantsRevoked: true });
    });
    return { ...current, revokedAt };
  }

  listCapabilityGrantTree(id: string): CapabilityGrant[] {
    const rows = this.db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM capability_grants WHERE id=?
      UNION ALL
      SELECT child.id FROM capability_grants child JOIN descendants parent ON child.parent_grant_id=parent.id
    ) SELECT grant.* FROM capability_grants grant JOIN descendants ON descendants.id=grant.id`)
      .all(id) as unknown as Record<string, unknown>[];
    return rows.map(decodeGrant);
  }

  isCapabilityGrantActive(id: string, now = new Date()): boolean {
    const rows = this.db.prepare(`WITH RECURSIVE ancestry(id,parent_grant_id,revoked_at,expires_at) AS (
      SELECT id,parent_grant_id,revoked_at,expires_at FROM capability_grants WHERE id=?
      UNION ALL
      SELECT parent.id,parent.parent_grant_id,parent.revoked_at,parent.expires_at
        FROM capability_grants parent JOIN ancestry child ON parent.id=child.parent_grant_id
    ) SELECT revoked_at,expires_at FROM ancestry`).all(id) as Array<{ revoked_at: string | null; expires_at: string }>;
    return rows.length > 0 && rows.every((row) => !row.revoked_at && Date.parse(row.expires_at) > now.getTime());
  }

  getCapabilityGrant(id: string): CapabilityGrant | undefined {
    const row = this.db.prepare("SELECT * FROM capability_grants WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeGrant(row) : undefined;
  }

  listCapabilityGrants(projectId?: string): CapabilityGrant[] {
    const rows = projectId
      ? this.db.prepare("SELECT * FROM capability_grants WHERE project_id=? ORDER BY issued_at DESC LIMIT 500").all(projectId)
      : this.db.prepare("SELECT * FROM capability_grants ORDER BY issued_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeGrant);
  }

  publishArtifact(input: {
    projectId: string;
    name: string;
    ownerAgentId: string;
    contentHash: string;
    mediaType: string;
    expectedVersion: number;
  }): CoordinationArtifact {
    const { name, actualVersion } = this.validateArtifactPublish(input);
    const artifact: CoordinationArtifact = {
      projectId: input.projectId,
      name,
      version: actualVersion + 1,
      ownerAgentId: input.ownerAgentId,
      contentHash: input.contentHash,
      mediaType: bounded(input.mediaType, 256, "artifact media type"),
      createdAt: new Date().toISOString(),
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO coordination_artifacts(
        project_id,name,version,owner_agent_id,content_hash,media_type,created_at
      ) VALUES (?,?,?,?,?,?,?)`).run(
        artifact.projectId, artifact.name, artifact.version, artifact.ownerAgentId,
        artifact.contentHash, artifact.mediaType, artifact.createdAt,
      );
      this.appendEvent(`coord-artifact:${artifact.projectId}:${artifact.name}`, "artifact.published", artifact);
    });
    return artifact;
  }

  validateArtifactPublish(input: {
    projectId: string;
    name: string;
    ownerAgentId: string;
    contentHash?: string;
    mediaType: string;
    expectedVersion: number;
  }): { name: string; actualVersion: number } {
    if (input.contentHash !== undefined) assertHash(input.contentHash);
    const name = named(input.name, "coordination artifact name");
    bounded(input.mediaType, 256, "artifact media type");
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw new Error("expected artifact version must be non-negative");
    const current = this.latestArtifact(input.projectId, name);
    const actualVersion = current?.version ?? 0;
    if (actualVersion !== input.expectedVersion) throw new Error(`artifact version conflict: expected ${input.expectedVersion}, current ${actualVersion}`);
    if (current && current.ownerAgentId !== input.ownerAgentId) throw new Error("only the current artifact owner may publish a new version");
    return { name, actualVersion };
  }

  transferArtifact(input: { projectId: string; name: string; expectedVersion: number; fromAgentId: string; toAgentId: string }): CoordinationArtifact {
    const current = this.latestArtifact(input.projectId, input.name);
    if (!current || current.version !== input.expectedVersion || current.ownerAgentId !== input.fromAgentId) {
      throw new Error("artifact ownership transfer does not match current version and owner");
    }
    const next: CoordinationArtifact = {
      ...current,
      version: current.version + 1,
      ownerAgentId: input.toAgentId,
      createdAt: new Date().toISOString(),
    };
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO coordination_artifacts(
        project_id,name,version,owner_agent_id,content_hash,media_type,created_at
      ) VALUES (?,?,?,?,?,?,?)`).run(
        next.projectId, next.name, next.version, next.ownerAgentId,
        next.contentHash, next.mediaType, next.createdAt,
      );
      this.appendEvent(`coord-artifact:${next.projectId}:${next.name}`, "artifact.transferred", {
        projectId: next.projectId,
        name: next.name,
        version: next.version,
        fromAgentId: input.fromAgentId,
        toAgentId: input.toAgentId,
      });
      return next;
    });
  }

  latestArtifact(projectId: string, name: string): CoordinationArtifact | undefined {
    const row = this.db.prepare(`SELECT * FROM coordination_artifacts
      WHERE project_id=? AND name=? ORDER BY version DESC LIMIT 1`).get(projectId, name) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeArtifact(row) : undefined;
  }

  listArtifacts(projectId: string): CoordinationArtifact[] {
    const rows = this.db.prepare(`SELECT a.* FROM coordination_artifacts a JOIN (
      SELECT project_id,name,MAX(version) version FROM coordination_artifacts WHERE project_id=? GROUP BY project_id,name
    ) latest ON a.project_id=latest.project_id AND a.name=latest.name AND a.version=latest.version
      ORDER BY a.name`).all(projectId) as unknown as Record<string, unknown>[];
    return rows.map(decodeArtifact);
  }

  sendMessage(input: Omit<CoordinationMessage, "id" | "createdAt">): CoordinationMessage {
    const existing = this.validateMessage(input);
    if (existing) return existing;
    const message: CoordinationMessage = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO coordination_messages(
        id,idempotency_key,project_id,from_agent_id,to_agent_id,kind,body_artifact_hash,
        artifact_name,artifact_version,causation_id,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        message.id, message.idempotencyKey, message.projectId, message.fromAgentId,
        message.toAgentId ?? null, message.kind, message.bodyArtifactHash,
        message.artifactName ?? null, message.artifactVersion ?? null,
        message.causationId, message.createdAt,
      );
      this.appendEvent(`coordination:${message.projectId}`, "coordination.message", message);
    });
    return message;
  }

  validateMessage(input: Omit<CoordinationMessage, "id" | "createdAt">): CoordinationMessage | undefined {
    assertHash(input.bodyArtifactHash);
    named(input.idempotencyKey, "coordination idempotency key");
    named(input.causationId, "coordination causation id");
    const existing = this.db.prepare(
      "SELECT * FROM coordination_messages WHERE project_id=? AND idempotency_key=?",
    ).get(input.projectId, input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      const message = decodeMessage(existing);
      const same = message.projectId === input.projectId &&
        message.fromAgentId === input.fromAgentId &&
        message.toAgentId === input.toAgentId &&
        message.kind === input.kind &&
        message.bodyArtifactHash === input.bodyArtifactHash &&
        message.artifactName === input.artifactName &&
        message.artifactVersion === input.artifactVersion &&
        message.causationId === input.causationId;
      if (!same) throw new Error("coordination idempotency key was already used with different content");
      return message;
    }
    if (input.artifactName) {
      const artifact = this.latestArtifact(input.projectId, input.artifactName);
      if (!artifact || artifact.version !== input.artifactVersion) throw new Error("coordination message references a stale or missing artifact");
    }
    return undefined;
  }

  listMessages(projectId: string, since?: string): CoordinationMessage[] {
    const rows = since
      ? this.db.prepare("SELECT * FROM coordination_messages WHERE project_id=? AND created_at>? ORDER BY created_at LIMIT 500").all(projectId, since)
      : this.db.prepare("SELECT * FROM coordination_messages WHERE project_id=? ORDER BY created_at DESC LIMIT 500").all(projectId);
    return (rows as unknown as Record<string, unknown>[]).map(decodeMessage);
  }

  listMessagesForAgent(projectId: string, agentId: string, since?: string): CoordinationMessage[] {
    const rows = since
      ? this.db.prepare(`SELECT * FROM coordination_messages
          WHERE project_id=? AND created_at>? AND (to_agent_id IS NULL OR to_agent_id=? OR from_agent_id=?)
          ORDER BY created_at LIMIT 500`).all(projectId, since, agentId, agentId)
      : this.db.prepare(`SELECT * FROM coordination_messages
          WHERE project_id=? AND (to_agent_id IS NULL OR to_agent_id=? OR from_agent_id=?)
          ORDER BY created_at DESC LIMIT 500`).all(projectId, agentId, agentId);
    return (rows as unknown as Record<string, unknown>[]).map(decodeMessage);
  }

  createApproval(input: {
    correlationId: string;
    projectId: string;
    taskId?: string;
    runId?: string;
    kind: ApprovalRequest["kind"];
    subjectHash: string;
    requestedBy: string;
    policy?: ApprovalRequest["policy"];
    expiresAt: string;
  }): { approval: ApprovalRequest; replay: boolean } {
    assertHash(input.subjectHash);
    if (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now()) {
      throw new Error("approval expiry must be in the future");
    }
    const existing = this.getApprovalByCorrelation(input.correlationId);
    if (existing) {
      if (existing.subjectHash !== input.subjectHash || existing.kind !== input.kind || existing.projectId !== input.projectId) {
        throw new Error("approval correlation id was already used with different content");
      }
      return { approval: existing, replay: true };
    }
    const approval: ApprovalRequest = {
      id: randomUUID(),
      correlationId: bounded(input.correlationId, 256, "approval correlation id"),
      projectId: input.projectId,
      taskId: input.taskId,
      runId: input.runId,
      kind: input.kind,
      subjectHash: input.subjectHash,
      requestedBy: bounded(input.requestedBy, 256, "approval requester"),
      status: "pending",
      policy: input.policy ?? { requiredRole: "local-operator", quorum: 1 },
      expiresAt: new Date(input.expiresAt).toISOString(),
      createdAt: new Date().toISOString(),
    };
    if (!Number.isInteger(approval.policy.quorum) || approval.policy.quorum !== 1) {
      throw new Error("the local product supports exactly one local approver");
    }
    this.transaction(() => {
      this.db.prepare(`INSERT INTO approval_requests(
        id,correlation_id,project_id,task_id,run_id,kind,subject_hash,requested_by,status,
        policy_json,expires_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        approval.id, approval.correlationId, approval.projectId, approval.taskId ?? null,
        approval.runId ?? null, approval.kind, approval.subjectHash, approval.requestedBy,
        approval.status, canonicalJson(approval.policy), approval.expiresAt, approval.createdAt,
      );
      this.appendEvent(`approval:${approval.id}`, "approval.requested", approval);
    });
    return { approval, replay: false };
  }

  routeApproval(input: {
    approvalId: string;
    channel: ApprovalRoute["channel"];
    recipient: string;
    status?: ApprovalRoute["status"];
  }): ApprovalRoute {
    const approval = this.getApproval(input.approvalId);
    if (!approval || approval.status !== "pending") throw new Error("approval is not pending");
    const row = this.db.prepare(`SELECT COALESCE(MAX(attempt),0) attempt FROM approval_routes
      WHERE approval_id=? AND channel=? AND recipient=?`).get(
      input.approvalId, input.channel, input.recipient,
    ) as { attempt: number };
    const now = new Date().toISOString();
    const route: ApprovalRoute = {
      id: randomUUID(), approvalId: input.approvalId, channel: input.channel,
      recipient: bounded(input.recipient, 256, "approval recipient"),
      status: input.status ?? "pending", attempt: Number(row.attempt) + 1,
      createdAt: now, updatedAt: now,
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO approval_routes(
        id,approval_id,channel,recipient,status,attempt,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run(
        route.id, route.approvalId, route.channel, route.recipient, route.status,
        route.attempt, route.createdAt, route.updatedAt,
      );
      this.appendEvent(`approval:${approval.id}`, "approval.routed", route);
    });
    return route;
  }

  decideApproval(input: {
    id: string;
    decision: "approved" | "rejected";
    decidedBy: string;
    responseId: string;
    reason?: string;
    now?: Date;
  }): ApprovalRequest {
    const current = this.getApproval(input.id);
    if (!current) throw new Error("unknown approval");
    if (current.responseId === input.responseId) return current;
    if (current.status !== "pending") throw new Error("approval is no longer pending");
    const now = input.now ?? new Date();
    if (Date.parse(current.expiresAt) <= now.getTime()) {
      this.expireApprovals(now);
      throw new Error("approval has expired");
    }
    const reason = input.reason ? bounded(input.reason, 4_096, "approval reason") : undefined;
    this.transaction(() => {
      this.db.prepare(`UPDATE approval_requests SET status=?,decided_at=?,decided_by=?,
        decision_reason=?,response_id=? WHERE id=? AND status='pending'`).run(
        input.decision, now.toISOString(), input.decidedBy, reason ?? null, input.responseId, input.id,
      );
      this.appendEvent(`approval:${input.id}`, "approval.decided", {
        decision: input.decision, decidedAt: now.toISOString(), decidedBy: input.decidedBy,
        reason, responseId: input.responseId,
      });
    });
    return this.getApproval(input.id)!;
  }

  markApprovalApplied(id: string): ApprovalRequest {
    const current = this.getApproval(id);
    if (!current || current.status !== "approved") throw new Error("approval is not approved");
    if (current.appliedAt) return current;
    const appliedAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE approval_requests SET applied_at=? WHERE id=? AND applied_at IS NULL")
        .run(appliedAt, id);
      this.appendEvent(`approval:${id}`, "approval.applied", { id, appliedAt });
    });
    return { ...current, appliedAt };
  }

  expireApprovals(now = new Date()): ApprovalRequest[] {
    const rows = this.db.prepare("SELECT id FROM approval_requests WHERE status='pending' AND expires_at<=?")
      .all(now.toISOString()) as unknown as Array<{ id: string }>;
    return rows.map(({ id }) => this.transaction(() => {
      this.db.prepare("UPDATE approval_requests SET status='expired',decided_at=? WHERE id=? AND status='pending'")
        .run(now.toISOString(), id);
      this.db.prepare("UPDATE approval_routes SET status='expired',updated_at=? WHERE approval_id=? AND status IN ('pending','delivered')")
        .run(now.toISOString(), id);
      this.appendEvent(`approval:${id}`, "approval.expired", { id, expiredAt: now.toISOString() });
      return this.getApproval(id)!;
    }));
  }

  revokeApproval(id: string, reason: string): ApprovalRequest {
    const current = this.getApproval(id);
    if (!current) throw new Error("unknown approval");
    if (current.appliedAt) throw new Error("an applied approval cannot be revoked");
    if (current.status === "revoked") return current;
    const decidedAt = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE approval_requests SET status='revoked',decided_at=?,decision_reason=? WHERE id=?")
        .run(decidedAt, bounded(reason, 4_096, "approval revocation reason"), id);
      this.appendEvent(`approval:${id}`, "approval.revoked", { id, decidedAt, reason });
    });
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeApproval(row) : undefined;
  }

  getApprovalByCorrelation(correlationId: string): ApprovalRequest | undefined {
    const row = this.db.prepare("SELECT * FROM approval_requests WHERE correlation_id=?").get(correlationId) as
      | Record<string, unknown>
      | undefined;
    return row ? decodeApproval(row) : undefined;
  }

  listApprovals(status?: ApprovalStatus): ApprovalRequest[] {
    this.expireApprovals();
    const rows = status
      ? this.db.prepare("SELECT * FROM approval_requests WHERE status=? ORDER BY created_at DESC LIMIT 500").all(status)
      : this.db.prepare("SELECT * FROM approval_requests ORDER BY created_at DESC LIMIT 500").all();
    return (rows as unknown as Record<string, unknown>[]).map(decodeApproval);
  }

  listApprovalRoutes(approvalId: string): ApprovalRoute[] {
    const rows = this.db.prepare("SELECT * FROM approval_routes WHERE approval_id=? ORDER BY attempt")
      .all(approvalId) as unknown as Record<string, unknown>[];
    return rows.map(decodeApprovalRoute);
  }

  summary(): ControlKernelSummary {
    this.expireApprovals();
    this.expireLiveness();
    const effectCounts = counts<EffectStatus>(this.db, "effects", "status", ["planned", "committed", "failed", "uncertain", "reconciled"]);
    const approvalCounts = counts<ApprovalStatus>(this.db, "approval_requests", "status", ["pending", "approved", "rejected", "expired", "revoked"]);
    const scalar = (sql: string, ...params: Array<string | number>): number =>
      Number((this.db.prepare(sql).get(...params) as { count: number }).count);
    return {
      effects: effectCounts,
      delegations: scalar("SELECT COUNT(*) count FROM delegations"),
      liveAgents: scalar("SELECT COUNT(*) count FROM liveness WHERE terminal=0 AND state!='unknown'"),
      pendingWakeups: scalar("SELECT COUNT(*) count FROM scheduler_wakeups WHERE state='scheduled'"),
      stateInstances: scalar("SELECT COUNT(*) count FROM versioned_state"),
      activeGrants: scalar(
        "SELECT COUNT(*) count FROM capability_grants WHERE revoked_at IS NULL AND expires_at>?",
        new Date().toISOString(),
      ),
      artifacts: scalar("SELECT COUNT(*) count FROM coordination_artifacts"),
      messages: scalar("SELECT COUNT(*) count FROM coordination_messages"),
      approvals: approvalCounts,
    };
  }

  factoryReset(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM approval_routes;
      DELETE FROM approval_requests;
      DELETE FROM coordination_messages;
      DELETE FROM coordination_artifacts;
      DELETE FROM capability_grants;
      DELETE FROM versioned_state;
      DELETE FROM state_schemas;
      DELETE FROM scheduler_wakeups;
      DELETE FROM scheduler_lanes;
      DELETE FROM liveness;
      DELETE FROM delegations;
      DELETE FROM effects;
      DELETE FROM control_events;
      COMMIT;
    `);
  }
}

function decodeEffect(row: Record<string, unknown>): EffectRecord {
  return {
    id: String(row.id), idempotencyKey: String(row.idempotency_key),
    projectId: text(row.project_id), runId: text(row.run_id), kind: String(row.kind),
    target: String(row.target), intentHash: String(row.intent_hash), status: String(row.status) as EffectStatus,
    resultHash: text(row.result_hash), detail: text(row.detail),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function decodeDelegation(row: Record<string, unknown>): DelegationRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), taskId: String(row.task_id),
    runId: text(row.run_id), parentDelegationId: text(row.parent_delegation_id),
    parentAgentId: text(row.parent_agent_id), childAgentId: String(row.child_agent_id),
    providerKind: String(row.provider_kind), model: text(row.model),
    instructionHash: String(row.instruction_hash), instructionArtifactHash: String(row.instruction_artifact_hash),
    policyHash: String(row.policy_hash), capabilityGrantId: String(row.capability_grant_id),
    createdAt: String(row.created_at),
  };
}

function decodeLiveness(row: Record<string, unknown>): LivenessRecord {
  return {
    channel: String(row.channel), projectId: text(row.project_id), taskId: text(row.task_id),
    runId: text(row.run_id), agentId: text(row.agent_id), state: String(row.state) as LivenessState,
    waitReason: text(row.wait_reason), confidence: String(row.confidence) as ObservationConfidence,
    activeTools: parseJson(row.active_tools_json, []) as string[], lastEventAt: String(row.last_event_at),
    lastOutputAt: text(row.last_output_at), leaseExpiresAt: String(row.lease_expires_at), terminal: Number(row.terminal) === 1,
  };
}

function decodeLane(row: Record<string, unknown>): SchedulerLaneState {
  return {
    projectId: String(row.project_id), lane: String(row.lane), weight: Number(row.weight),
    dispatchCount: Number(row.dispatch_count), lastDispatchedAt: text(row.last_dispatched_at),
  };
}

function decodeWakeup(row: Record<string, unknown>): SchedulerWakeup {
  return {
    taskId: String(row.task_id), projectId: String(row.project_id), wakeAt: String(row.wake_at),
    state: String(row.state) as SchedulerWakeup["state"], createdAt: String(row.created_at), firedAt: text(row.fired_at),
  };
}

function decodeStateSchema(row: Record<string, unknown>): StateSchemaRecord {
  return { name: String(row.name), version: Number(row.version), compatibilityHash: String(row.compatibility_hash), createdAt: String(row.created_at) };
}

function decodeState(row: Record<string, unknown>): VersionedStateRecord {
  return {
    id: String(row.id), ownerType: String(row.owner_type), ownerId: String(row.owner_id),
    schemaName: String(row.schema_name), schemaVersion: Number(row.schema_version),
    payload: parseJson(row.payload_json, null), payloadHash: String(row.payload_hash),
    migrationHistory: parseJson(row.migration_history_json, []) as VersionedStateRecord["migrationHistory"],
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function decodeGrant(row: Record<string, unknown>): CapabilityGrant {
  return {
    id: String(row.id), parentGrantId: text(row.parent_grant_id), projectId: String(row.project_id),
    subjectType: String(row.subject_type) as CapabilityGrant["subjectType"], subjectId: String(row.subject_id),
    scope: parseJson(row.scope_json, normalizeScope({ tools: [], secrets: [], paths: [], network: "none" })) as CapabilityScope,
    issuedBy: String(row.issued_by) as CapabilityGrant["issuedBy"], issuedAt: String(row.issued_at),
    expiresAt: String(row.expires_at), revokedAt: text(row.revoked_at), receiptHash: String(row.receipt_hash),
  };
}

function decodeArtifact(row: Record<string, unknown>): CoordinationArtifact {
  return {
    projectId: String(row.project_id), name: String(row.name), version: Number(row.version),
    ownerAgentId: String(row.owner_agent_id), contentHash: String(row.content_hash),
    mediaType: String(row.media_type), createdAt: String(row.created_at),
  };
}

function decodeMessage(row: Record<string, unknown>): CoordinationMessage {
  return {
    id: String(row.id), idempotencyKey: String(row.idempotency_key), projectId: String(row.project_id),
    fromAgentId: String(row.from_agent_id), toAgentId: text(row.to_agent_id),
    kind: String(row.kind) as CoordinationMessage["kind"], bodyArtifactHash: String(row.body_artifact_hash),
    artifactName: text(row.artifact_name), artifactVersion: row.artifact_version == null ? undefined : Number(row.artifact_version),
    causationId: String(row.causation_id), createdAt: String(row.created_at),
  };
}

function decodeApproval(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: String(row.id), correlationId: String(row.correlation_id), projectId: String(row.project_id),
    taskId: text(row.task_id), runId: text(row.run_id), kind: String(row.kind) as ApprovalRequest["kind"],
    subjectHash: String(row.subject_hash), requestedBy: String(row.requested_by),
    status: String(row.status) as ApprovalStatus,
    policy: parseJson(row.policy_json, { requiredRole: "local-operator", quorum: 1 }) as ApprovalRequest["policy"],
    expiresAt: String(row.expires_at), createdAt: String(row.created_at), decidedAt: text(row.decided_at),
    decidedBy: text(row.decided_by), decisionReason: text(row.decision_reason), responseId: text(row.response_id),
    appliedAt: text(row.applied_at),
  };
}

function decodeApprovalRoute(row: Record<string, unknown>): ApprovalRoute {
  return {
    id: String(row.id), approvalId: String(row.approval_id), channel: String(row.channel) as ApprovalRoute["channel"],
    recipient: String(row.recipient), status: String(row.status) as ApprovalRoute["status"], attempt: Number(row.attempt),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function counts<T extends string>(db: DatabaseSync, table: string, column: string, values: readonly T[]): Record<T, number> {
  const result = Object.fromEntries(values.map((value) => [value, 0])) as Record<T, number>;
  const rows = db.prepare(`SELECT ${column} value,COUNT(*) count FROM ${table} GROUP BY ${column}`).all() as unknown as Array<{ value: T; count: number }>;
  for (const row of rows) if (row.value in result) result[row.value] = Number(row.count);
  return result;
}

function normalizeScope(scope: CapabilityScope): CapabilityScope {
  const network: NetworkCapability = scope.network;
  if (!new Set<NetworkCapability>(["none", "loopback", "allowlist", "unrestricted"]).has(network)) {
    throw new Error("invalid network capability");
  }
  return {
    tools: normalizeNames(scope.tools, 128),
    secrets: normalizeNames(scope.secrets, 128),
    paths: [...new Set(scope.paths.map((item) => bounded(item, 4_096, "capability path")))].sort(),
    network,
  };
}

function assertScopeSubset(child: CapabilityScope, parent: CapabilityScope): void {
  const subset = (items: string[], allowed: string[]): boolean => items.every((item) => allowed.includes(item));
  if (!subset(child.tools, parent.tools) || !subset(child.secrets, parent.secrets) || !subset(child.paths, parent.paths)) {
    throw new Error("child capability scope exceeds parent authority");
  }
  const rank: Record<NetworkCapability, number> = { none: 0, loopback: 1, allowlist: 2, unrestricted: 3 };
  if (rank[child.network] > rank[parent.network]) throw new Error("child network capability exceeds parent authority");
}

function normalizeNames(values: string[], max: number): string[] {
  if (values.length > max) throw new Error(`capability list exceeds ${max} entries`);
  return [...new Set(values.map((value) => {
    const normalized = bounded(value.trim(), 256, "capability name");
    if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
      throw new Error("capability name contains control characters");
    }
    return normalized;
  }))].sort();
}

function checkedJson(value: unknown, label: string): string {
  const json = canonicalJson(redact(value));
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw new Error(`${label} exceeds 256 KiB`);
  return json;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]));
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite JSON number");
  return value;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 16) throw new Error("payload nesting exceeds limit");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return sortJson(value);
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new Error("payload array exceeds limit");
    return value.map((item) => redact(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonObject);
    if (entries.length > 256) throw new Error("payload object exceeds limit");
    return Object.fromEntries(entries
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1)]));
  }
  throw new Error("payload is not JSON serializable");
}

function parseJson(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertHash(value: string): void {
  if (!HASH.test(value)) throw new Error("expected SHA-256 hash");
}

function named(value: string, label: string): string {
  const normalized = bounded(value.trim(), 256, label);
  if (!NAME.test(normalized)) throw new Error(`${label} contains unsupported characters`);
  return normalized;
}

function bounded(value: string, max: number, label: string): string {
  if (!value || value.length > max) throw new Error(`${label} must be 1..${max} characters`);
  return value;
}

function text(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}
