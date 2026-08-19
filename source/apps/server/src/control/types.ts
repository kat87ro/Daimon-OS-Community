export type EffectStatus = "planned" | "committed" | "failed" | "uncertain" | "reconciled";

export interface EffectRecord {
  id: string;
  idempotencyKey: string;
  projectId?: string;
  runId?: string;
  kind: string;
  target: string;
  intentHash: string;
  status: EffectStatus;
  resultHash?: string;
  detail?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DelegationRecord {
  id: string;
  projectId: string;
  taskId: string;
  runId?: string;
  parentDelegationId?: string;
  parentAgentId?: string;
  childAgentId: string;
  providerKind: string;
  model?: string;
  instructionHash: string;
  instructionArtifactHash: string;
  policyHash: string;
  capabilityGrantId: string;
  createdAt: string;
}

export type LivenessState =
  | "queued"
  | "spawning"
  | "running"
  | "waiting_tool"
  | "waiting_input"
  | "waiting_review"
  | "backoff"
  | "paused"
  | "completed"
  | "failed"
  | "killed"
  | "unknown";

export type ObservationConfidence = "reported" | "observed" | "inferred";

export interface LivenessRecord {
  channel: string;
  projectId?: string;
  taskId?: string;
  runId?: string;
  agentId?: string;
  state: LivenessState;
  waitReason?: string;
  confidence: ObservationConfidence;
  activeTools: string[];
  lastEventAt: string;
  lastOutputAt?: string;
  leaseExpiresAt: string;
  terminal: boolean;
}

export interface SchedulerCandidate {
  taskId: string;
  lane: string;
  priority: number;
  createdAt: string;
  notBefore?: string;
}

export interface SchedulerLaneState {
  projectId: string;
  lane: string;
  weight: number;
  dispatchCount: number;
  lastDispatchedAt?: string;
}

export interface SchedulerWakeup {
  taskId: string;
  projectId: string;
  wakeAt: string;
  state: "scheduled" | "fired" | "cancelled";
  createdAt: string;
  firedAt?: string;
}

export interface StateSchemaRecord {
  name: string;
  version: number;
  compatibilityHash: string;
  createdAt: string;
}

export interface VersionedStateRecord {
  id: string;
  ownerType: string;
  ownerId: string;
  schemaName: string;
  schemaVersion: number;
  payload: unknown;
  payloadHash: string;
  migrationHistory: Array<{
    fromVersion: number;
    toVersion: number;
    migration: string;
    migratedAt: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

export type NetworkCapability = "none" | "loopback" | "allowlist" | "unrestricted";

export interface CapabilityScope {
  tools: string[];
  secrets: string[];
  paths: string[];
  network: NetworkCapability;
}

export interface CapabilityGrant {
  id: string;
  parentGrantId?: string;
  projectId: string;
  subjectType: "agent" | "run" | "remote-peer";
  subjectId: string;
  scope: CapabilityScope;
  issuedBy: "human-local" | "daimon";
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  receiptHash: string;
}

export interface CoordinationArtifact {
  projectId: string;
  name: string;
  version: number;
  ownerAgentId: string;
  contentHash: string;
  mediaType: string;
  createdAt: string;
}

export interface CoordinationMessage {
  id: string;
  idempotencyKey: string;
  projectId: string;
  fromAgentId: string;
  toAgentId?: string;
  kind: "finding" | "question" | "answer" | "handoff" | "steering" | "artifact" | "status";
  bodyArtifactHash: string;
  artifactName?: string;
  artifactVersion?: number;
  causationId: string;
  createdAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "revoked";

export interface ApprovalRequest {
  id: string;
  correlationId: string;
  projectId: string;
  taskId?: string;
  runId?: string;
  kind: "run-promotion" | "memory-write" | "capability" | "effect" | "policy";
  subjectHash: string;
  requestedBy: string;
  status: ApprovalStatus;
  policy: {
    requiredRole: string;
    quorum: number;
  };
  expiresAt: string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  responseId?: string;
  appliedAt?: string;
}

export interface ApprovalRoute {
  id: string;
  approvalId: string;
  channel: "desktop" | "mcp" | "external";
  recipient: string;
  status: "pending" | "delivered" | "failed" | "expired";
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface ControlKernelSummary {
  effects: Record<EffectStatus, number>;
  delegations: number;
  liveAgents: number;
  pendingWakeups: number;
  stateInstances: number;
  activeGrants: number;
  artifacts: number;
  messages: number;
  approvals: Record<ApprovalStatus, number>;
}
