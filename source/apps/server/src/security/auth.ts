import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const DAIMON_WS_PROTOCOL = "daimon-v1";
const WS_AUTH_PREFIX = "daimon-auth.";

export interface OrchestrationGrant {
  readonly projectId: string;
  readonly teamId?: string;
  readonly supervisorAgentId?: string;
  readonly rosterHash?: string;
}

export type NativeAction = "spawn" | "start-project" | "configure-github";

/**
 * Short-lived, one-shot proof that Electron main confirmed an exact sensitive
 * action. Issuance requires the admin bearer; consumption deletes the grant
 * before checking it, so a malformed/replayed attempt cannot preserve it.
 */
export class NativeActionAccess {
  private readonly grants = new Map<string, {
    action: NativeAction;
    subjectHash: string;
    expiresAt: number;
  }>();

  issue(action: NativeAction, subjectHash: string, now = Date.now()): { token: string; expiresAt: number } {
    if (!/^[a-f0-9]{64}$/.test(subjectHash)) throw new Error("invalid native action subject hash");
    this.purge(now);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + 30_000;
    this.grants.set(tokenDigest(token), { action, subjectHash, expiresAt });
    return { token, expiresAt };
  }

  consume(token: string | undefined, action: NativeAction, subjectHash: string, now = Date.now()): boolean {
    if (!token) return false;
    const digest = tokenDigest(token);
    const grant = this.grants.get(digest);
    this.grants.delete(digest);
    return Boolean(
      grant &&
      grant.expiresAt >= now &&
      grant.action === action &&
      /^[a-f0-9]{64}$/.test(subjectHash) &&
      tokensEqual(grant.subjectHash, subjectHash),
    );
  }

  clear(): void {
    this.grants.clear();
  }

  private purge(now: number): void {
    for (const [digest, grant] of this.grants) {
      if (grant.expiresAt < now) this.grants.delete(digest);
    }
  }
}

export const ORCHESTRATION_TASK_LIMITS = Object.freeze({
  activeTasksPerProject: 128,
  activeTaskBytesPerProject: 8 * 1024 * 1024,
  creationsPerMinute: 32,
  creationsPerGrant: 512,
  createdBytesPerGrant: 32 * 1024 * 1024,
  updatesPerMinute: 64,
  updatesPerGrant: 2_048,
  updatedBytesPerGrant: 64 * 1024 * 1024,
});

export const ORCHESTRATION_INPUT_LIMITS = Object.freeze({
  openPerProject: 64,
  openPerTask: 4,
  requestsPerMinute: 16,
  requestsPerGrant: 128,
  requestedBytesPerGrant: 1024 * 1024,
});

interface TaskCreationUsage {
  windowStartedAt: number;
  windowCount: number;
  totalCount: number;
  totalBytes: number;
}

type InputRequestUsage = TaskCreationUsage;

export type TaskCreationAdmission =
  | { ok: true; release(): void }
  | { ok: false; statusCode: 403 | 409 | 429; error: string };
export type InputRequestAdmission = TaskCreationAdmission;
export type TaskUpdateAdmission = TaskCreationAdmission;

export interface ScopedRequest {
  method: string;
  pathname: string;
  projectId?: string;
  taskProjectId?: string;
  taskStatus?: string;
}

/**
 * In-memory registry for Lead MCP capabilities. Tokens rotate per project start,
 * die on gateway restart, and can access only project-scoped orchestration APIs.
 */
export class OrchestrationAccess {
  private readonly grants = new Map<string, OrchestrationGrant>();
  private readonly projectTokens = new Map<string, string>();
  private readonly activeGrants = new Set<OrchestrationGrant>();
  private readonly creationUsage = new WeakMap<OrchestrationGrant, TaskCreationUsage>();
  private readonly inputUsage = new WeakMap<OrchestrationGrant, InputRequestUsage>();
  private readonly updateUsage = new WeakMap<OrchestrationGrant, TaskCreationUsage>();

  rotate(projectId: string, teamId?: string, security?: {
    supervisorAgentId?: string;
    memberAgentIds?: readonly string[];
  }): string {
    this.revokeProject(projectId);
    const token = randomBytes(32).toString("base64url");
    const digest = tokenDigest(token);
    const grant = Object.freeze({
      projectId,
      teamId,
      supervisorAgentId: security?.supervisorAgentId,
      rosterHash: security?.memberAgentIds
        ? createHash("sha256").update(JSON.stringify([...security.memberAgentIds].map(String).sort())).digest("hex")
        : undefined,
    });
    this.grants.set(digest, grant);
    this.activeGrants.add(grant);
    this.creationUsage.set(grant, {
      windowStartedAt: Date.now(),
      windowCount: 0,
      totalCount: 0,
      totalBytes: 0,
    });
    this.inputUsage.set(grant, {
      windowStartedAt: Date.now(),
      windowCount: 0,
      totalCount: 0,
      totalBytes: 0,
    });
    this.updateUsage.set(grant, {
      windowStartedAt: Date.now(),
      windowCount: 0,
      totalCount: 0,
      totalBytes: 0,
    });
    this.projectTokens.set(projectId, digest);
    return token;
  }

  revokeProject(projectId: string): void {
    const digest = this.projectTokens.get(projectId);
    if (digest) {
      const grant = this.grants.get(digest);
      if (grant) this.activeGrants.delete(grant);
      this.grants.delete(digest);
    }
    this.projectTokens.delete(projectId);
  }

  clear(): void {
    this.grants.clear();
    this.projectTokens.clear();
    this.activeGrants.clear();
  }

  grantFor(token: string | undefined): OrchestrationGrant | undefined {
    return token ? this.grants.get(tokenDigest(token)) : undefined;
  }

  /**
   * Atomically reserve one scoped task creation against both the project's
   * current queue and the lifetime/rate budget of this rotated capability.
   * The route is synchronous between this call and persistence; `release`
   * refunds the reservation if referential validation rejects the task.
   */
  admitTaskCreation(
    grant: OrchestrationGrant,
    input: {
      activeTaskCount: number;
      activeTaskBytes: number;
      newTaskBytes: number;
      now?: number;
    },
  ): TaskCreationAdmission {
    if (!this.activeGrants.has(grant)) {
      return { ok: false, statusCode: 403, error: "orchestration credential is no longer active" };
    }
    if (input.activeTaskCount >= ORCHESTRATION_TASK_LIMITS.activeTasksPerProject) {
      return { ok: false, statusCode: 409, error: "project orchestration queue is at its task limit" };
    }
    if (
      input.newTaskBytes < 0 ||
      input.activeTaskBytes + input.newTaskBytes > ORCHESTRATION_TASK_LIMITS.activeTaskBytesPerProject
    ) {
      return { ok: false, statusCode: 409, error: "project orchestration queue is at its byte limit" };
    }

    const usage = this.creationUsage.get(grant);
    if (!usage) {
      return { ok: false, statusCode: 403, error: "orchestration credential is no longer active" };
    }
    const now = input.now ?? Date.now();
    if (now - usage.windowStartedAt >= 60_000) {
      usage.windowStartedAt = now;
      usage.windowCount = 0;
    }
    if (usage.windowCount >= ORCHESTRATION_TASK_LIMITS.creationsPerMinute) {
      return { ok: false, statusCode: 429, error: "orchestration task creation rate exceeded" };
    }
    if (usage.totalCount >= ORCHESTRATION_TASK_LIMITS.creationsPerGrant) {
      return { ok: false, statusCode: 409, error: "orchestration credential exhausted its task budget" };
    }
    if (usage.totalBytes + input.newTaskBytes > ORCHESTRATION_TASK_LIMITS.createdBytesPerGrant) {
      return { ok: false, statusCode: 409, error: "orchestration credential exhausted its byte budget" };
    }

    usage.windowCount += 1;
    usage.totalCount += 1;
    usage.totalBytes += input.newTaskBytes;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        usage.windowCount = Math.max(0, usage.windowCount - 1);
        usage.totalCount = Math.max(0, usage.totalCount - 1);
        usage.totalBytes = Math.max(0, usage.totalBytes - input.newTaskBytes);
      },
    };
  }

  admitInputRequest(
    grant: OrchestrationGrant,
    input: {
      openProjectRequests: number;
      openTaskRequests: number;
      requestBytes: number;
      now?: number;
    },
  ): InputRequestAdmission {
    if (!this.activeGrants.has(grant)) {
      return { ok: false, statusCode: 403, error: "orchestration credential is no longer active" };
    }
    if (input.openProjectRequests >= ORCHESTRATION_INPUT_LIMITS.openPerProject) {
      return { ok: false, statusCode: 409, error: "project input inbox is at its open-request limit" };
    }
    if (input.openTaskRequests >= ORCHESTRATION_INPUT_LIMITS.openPerTask) {
      return { ok: false, statusCode: 409, error: "task input inbox is at its open-request limit" };
    }
    const usage = this.inputUsage.get(grant);
    if (!usage) {
      return { ok: false, statusCode: 403, error: "orchestration credential is no longer active" };
    }
    const now = input.now ?? Date.now();
    if (now - usage.windowStartedAt >= 60_000) {
      usage.windowStartedAt = now;
      usage.windowCount = 0;
    }
    if (usage.windowCount >= ORCHESTRATION_INPUT_LIMITS.requestsPerMinute) {
      return { ok: false, statusCode: 429, error: "orchestration input-request rate exceeded" };
    }
    if (usage.totalCount >= ORCHESTRATION_INPUT_LIMITS.requestsPerGrant) {
      return { ok: false, statusCode: 409, error: "orchestration credential exhausted its input-request budget" };
    }
    if (
      input.requestBytes < 0 ||
      usage.totalBytes + input.requestBytes > ORCHESTRATION_INPUT_LIMITS.requestedBytesPerGrant
    ) {
      return { ok: false, statusCode: 409, error: "orchestration credential exhausted its input-request byte budget" };
    }
    usage.windowCount += 1;
    usage.totalCount += 1;
    usage.totalBytes += input.requestBytes;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        usage.windowCount = Math.max(0, usage.windowCount - 1);
        usage.totalCount = Math.max(0, usage.totalCount - 1);
        usage.totalBytes = Math.max(0, usage.totalBytes - input.requestBytes);
      },
    };
  }

  admitTaskUpdate(
    grant: OrchestrationGrant,
    input: { activeTaskBytesAfter: number; requestBytes: number; now?: number },
  ): TaskUpdateAdmission {
    if (!this.activeGrants.has(grant)) {
      return { ok: false, statusCode: 403, error: "orchestration credential is no longer active" };
    }
    if (
      input.activeTaskBytesAfter < 0 ||
      input.activeTaskBytesAfter > ORCHESTRATION_TASK_LIMITS.activeTaskBytesPerProject
    ) {
      return { ok: false, statusCode: 409, error: "project orchestration queue is at its byte limit" };
    }
    const usage = this.updateUsage.get(grant);
    if (!usage) {
      return { ok: false, statusCode: 403, error: "orchestration credential is no longer active" };
    }
    const now = input.now ?? Date.now();
    if (now - usage.windowStartedAt >= 60_000) {
      usage.windowStartedAt = now;
      usage.windowCount = 0;
    }
    if (usage.windowCount >= ORCHESTRATION_TASK_LIMITS.updatesPerMinute) {
      return { ok: false, statusCode: 429, error: "orchestration task update rate exceeded" };
    }
    if (usage.totalCount >= ORCHESTRATION_TASK_LIMITS.updatesPerGrant) {
      return { ok: false, statusCode: 409, error: "orchestration credential exhausted its update budget" };
    }
    if (
      input.requestBytes < 0 ||
      usage.totalBytes + input.requestBytes > ORCHESTRATION_TASK_LIMITS.updatedBytesPerGrant
    ) {
      return { ok: false, statusCode: 409, error: "orchestration credential exhausted its update byte budget" };
    }
    usage.windowCount += 1;
    usage.totalCount += 1;
    usage.totalBytes += input.requestBytes;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        usage.windowCount = Math.max(0, usage.windowCount - 1);
        usage.totalCount = Math.max(0, usage.totalCount - 1);
        usage.totalBytes = Math.max(0, usage.totalBytes - input.requestBytes);
      },
    };
  }

  authorizes(grant: OrchestrationGrant, request: ScopedRequest): boolean {
    if (request.pathname === "/api/orchestration/context" && request.method === "GET") {
      return request.projectId === grant.projectId;
    }
    if (request.pathname === "/api/tasks" && request.method === "GET") {
      return request.projectId === grant.projectId;
    }
    if (request.pathname === "/api/orchestration/tasks" && request.method === "POST") {
      return request.taskProjectId === grant.projectId;
    }
    if (/^\/api\/orchestration\/tasks\/[0-9a-f-]+\/input$/i.test(request.pathname) && request.method === "POST") {
      return request.taskProjectId === grant.projectId;
    }
    if (/^\/api\/tasks\/[0-9a-f-]+$/i.test(request.pathname) && request.method === "PATCH") {
      // A Lead may update its plan/work description and runtime-safe states, but
      // can never turn a review into human acceptance using the raw REST API.
      return request.taskProjectId === grant.projectId && request.taskStatus !== "done";
    }
    if (
      ["/api/control/artifacts", "/api/control/messages"].includes(request.pathname) &&
      (request.method === "GET" || request.method === "POST")
    ) {
      return (request.projectId ?? request.taskProjectId) === grant.projectId;
    }
    if (request.pathname === "/api/control/artifacts/content" && request.method === "GET") {
      return request.projectId === grant.projectId;
    }
    return false;
  }
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Identify loopback binds. Production still requires a gateway token on loopback. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * Refuse human phrases/repeated filler for a remotely reachable listener. The
 * estimate is deliberately conservative: at least 32 UTF-8 bytes and 128 bits
 * of Shannon entropy. `crypto.randomBytes(32).toString("base64url")` passes.
 */
export function isHighEntropyToken(token: string): boolean {
  const bytes = Buffer.from(token, "utf8");
  if (bytes.byteLength < 32) return false;
  const counts = new Map<number, number>();
  for (const byte of bytes) counts.set(byte, (counts.get(byte) ?? 0) + 1);
  let bitsPerByte = 0;
  for (const count of counts.values()) {
    const p = count / bytes.byteLength;
    bitsPerByte -= p * Math.log2(p);
  }
  return bitsPerByte * bytes.byteLength >= 128;
}

/** Fixed-size digest comparison avoids leaking token length through the compare. */
export function tokensEqual(expected: string, supplied: string | undefined): boolean {
  if (supplied === undefined) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer[ \t]+([^ \t]+)[ \t]*$/i.exec(header);
  return match?.[1];
}

/** Browser-safe, non-query WebSocket credential transport. */
export function websocketAuthProtocol(token: string): string {
  return `${WS_AUTH_PREFIX}${Buffer.from(token, "utf8").toString("base64url")}`;
}

export function tokenFromWebsocketProtocols(
  header: string | string[] | undefined,
): string | undefined {
  if (typeof header !== "string" || header.length > 2048) return undefined;
  const protocols = header.split(",").map((part) => part.trim());
  if (protocols.length > 8 || protocols.some((protocol) => protocol.length > 1024)) {
    return undefined;
  }
  const encoded = protocols
    .find((protocol) => protocol.startsWith(WS_AUTH_PREFIX))
    ?.slice(WS_AUTH_PREFIX.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
}
