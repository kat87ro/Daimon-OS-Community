import { z } from "zod";

declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

export type ProviderId = Brand<string, "ProviderId">;
export type AgentId = Brand<string, "AgentId">;
export type TeamId = Brand<string, "TeamId">;
export type ProjectId = Brand<string, "ProjectId">;
export type SecretId = Brand<string, "SecretId">;
export type BlueprintId = Brand<string, "BlueprintId">;
export type ScheduleId = Brand<string, "ScheduleId">;
/** SessionId doubles as the WebSocket channel id for that run. */
export type SessionId = Brand<string, "SessionId">;

const uuid = () => z.string().uuid();

export const providerIdSchema = uuid() as unknown as z.ZodType<ProviderId>;
export const agentIdSchema = uuid() as unknown as z.ZodType<AgentId>;
export const teamIdSchema = uuid() as unknown as z.ZodType<TeamId>;
export const projectIdSchema = uuid() as unknown as z.ZodType<ProjectId>;
export const secretIdSchema = uuid() as unknown as z.ZodType<SecretId>;
export const blueprintIdSchema = uuid() as unknown as z.ZodType<BlueprintId>;
export const scheduleIdSchema = uuid() as unknown as z.ZodType<ScheduleId>;
export const sessionIdSchema = uuid() as unknown as z.ZodType<SessionId>;

/**
 * RFC-4122 v4 UUID that works EVERYWHERE — including a phone loading the app over
 * plain http on a LAN IP. `crypto.randomUUID()` only exists in a secure context
 * (https or localhost), so on http://<lan-ip> it is `undefined` and throws; we
 * fall back to `crypto.getRandomValues` (available in insecure contexts too),
 * then to Math.random as a last resort (fine for ephemeral client-side ids).
 */
export function newUuid(): string {
  // structural type — the shared tsconfig has no DOM lib, so the global `Crypto`
  // type isn't in scope; both Node 20 and browsers expose these methods.
  const c = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (a: Uint8Array) => Uint8Array;
    };
  }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
    const h = Array.from(b, (x: number) => x.toString(16).padStart(2, "0"));
    return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const newProviderId = (): ProviderId => newUuid() as ProviderId;
export const newAgentId = (): AgentId => newUuid() as AgentId;
export const newTeamId = (): TeamId => newUuid() as TeamId;
export const newProjectId = (): ProjectId => newUuid() as ProjectId;
export const newSecretId = (): SecretId => newUuid() as SecretId;
export const newBlueprintId = (): BlueprintId => newUuid() as BlueprintId;
export const newScheduleId = (): ScheduleId => newUuid() as ScheduleId;
export const newSessionId = (): SessionId => newUuid() as SessionId;
