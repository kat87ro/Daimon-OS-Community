import { z } from "zod";

export const AUDIT_RETENTION_DAYS = 5 as const;
export const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1_000;

export const auditCategorySchema = z.enum(["configuration", "work", "security"]);
export type AuditCategory = z.infer<typeof auditCategorySchema>;

export const auditOutcomeSchema = z.enum(["success", "failure", "warning"]);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

export const auditActorSchema = z.enum(["operator", "renderer", "lead", "system"]);
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditMetadataValueSchema = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type AuditMetadataValue = z.infer<typeof auditMetadataValueSchema>;

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  category: auditCategorySchema,
  action: z.string().min(1).max(96),
  outcome: auditOutcomeSchema,
  actor: auditActorSchema,
  projectId: z.string().uuid().optional(),
  entityType: z.string().min(1).max(64).optional(),
  entityId: z.string().min(1).max(256).optional(),
  summary: z.string().min(1).max(512),
  metadata: z.record(z.string().max(64), auditMetadataValueSchema),
}).strict();
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditSummarySchema = z.object({
  retentionDays: z.literal(AUDIT_RETENTION_DAYS),
  total: z.number().int().nonnegative(),
  configuration: z.number().int().nonnegative(),
  work: z.number().int().nonnegative(),
  security: z.number().int().nonnegative(),
  oldestRetainedAt: z.string().datetime().optional(),
  newestAt: z.string().datetime().optional(),
}).strict();
export type AuditSummary = z.infer<typeof auditSummarySchema>;
