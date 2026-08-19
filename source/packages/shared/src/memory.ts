import { z } from "zod";

/**
 * Centralized Memory — lean v1. All durable memory resolves through MemoryService
 * under a single `activeMemoryRoot` (an Obsidian-vault subfolder, or an app-managed
 * local folder fallback). Settings live in ConfigStore (config.json) like the rest.
 */

export const memoryStorageModeSchema = z.enum(["obsidian", "local"]);
export type MemoryStorageMode = z.infer<typeof memoryStorageModeSchema>;

/** Memory taxonomy (frontmatter `type`). */
export const memoryTypeSchema = z.enum(["semantic", "episodic", "procedural", "entity"]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const memoryConfidenceSchema = z.enum(["low", "medium", "high"]);
export type MemoryConfidence = z.infer<typeof memoryConfidenceSchema>;
export const memorySensitivitySchema = z.enum(["public", "internal", "confidential", "restricted"]);
export type MemorySensitivity = z.infer<typeof memorySensitivitySchema>;
export const memorySourceTypeSchema = z.enum(["human", "agent", "tool", "import"]);
export type MemorySourceType = z.infer<typeof memorySourceTypeSchema>;

export const memorySettingsSchema = z.object({
  enabled: z.boolean(),
  storageMode: memoryStorageModeSchema,
  /** Obsidian vault root (validated on startup when storageMode === "obsidian") */
  obsidianVaultPath: z.string().optional(),
  /** memory folder INSIDE the vault, e.g. <vault>/AgenticOS-Memory */
  obsidianMemoryFolderPath: z.string().optional(),
  /** app-managed fallback, e.g. <appData>/AgenticOS-Memory */
  localMemoryFolderPath: z.string().optional(),
  /** resolved at runtime by MemoryService — never trust the client's value */
  activeMemoryRoot: z.string().optional(),
  /** strict mode: error instead of falling back to local when Obsidian is invalid */
  strictObsidian: z.boolean(),
  /** queue proposed writes for approval instead of writing immediately (v1: default off) */
  requireApprovalBeforeWrite: z.boolean(),
  enableRetrieval: z.boolean(),
  enableSessionSummaries: z.boolean(),
  enableAgentMemory: z.boolean(),
  enableTeamMemory: z.boolean(),
  enableProjectMemory: z.boolean(),
  enableTaskMemory: z.boolean(),
  enableJsonIndexes: z.boolean(),
  /** v1: embeddings off — keyword/index retrieval only */
  enableEmbeddings: z.boolean(),
  /** initialize centralized project memory when a project is created/started */
  initProjectMemoryOnCreate: z.boolean(),
  /** attached teams get default read/write to that project's memory namespace */
  teamsCanWriteProjectMemory: z.boolean(),
  /** approx token budget for retrieval injected into an agent's context */
  retrievalTokenBudget: z.number().int().positive(),
  schemaVersion: z.number().int().positive(),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;

/** Sensible lean-v1 defaults (ConfigStore fills these via `??=`). */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: false,
  storageMode: "local",
  strictObsidian: false,
  requireApprovalBeforeWrite: false,
  enableRetrieval: true,
  enableSessionSummaries: true,
  enableAgentMemory: true,
  enableTeamMemory: true,
  enableProjectMemory: true,
  enableTaskMemory: true,
  enableJsonIndexes: true,
  enableEmbeddings: false,
  initProjectMemoryOnCreate: true,
  teamsCanWriteProjectMemory: true,
  retrievalTokenBudget: 2000,
  schemaVersion: 1,
};

/** The canonical memory folder name under a vault or the local app-data dir. */
export const MEMORY_FOLDER_NAME = "AgenticOS-Memory" as const;

/** A single durable memory record (the body lives as markdown; this is the index row). */
export const memoryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  /** path RELATIVE to activeMemoryRoot — never absolute (path-traversal guard) */
  filePath: z.string(),
  type: memoryTypeSchema,
  tags: z.array(z.string()).default([]),
  relatedAgents: z.array(z.string()).default([]),
  relatedTeams: z.array(z.string()).default([]),
  relatedProjects: z.array(z.string()).default([]),
  relatedTasks: z.array(z.string()).default([]),
  confidence: memoryConfidenceSchema.default("medium"),
  summary: z.string().optional(),
  checksum: z.string().optional(),
  sensitivity: memorySensitivitySchema.optional(),
  provenance: z.object({
    sourceType: memorySourceTypeSchema,
    sourceUri: z.string().max(2_048).optional(),
    capturedBy: z.string().min(1).max(256),
    capturedAt: z.string().datetime(),
  }).optional(),
  version: z.number().int().positive().optional(),
  expiresAt: z.string().datetime().optional(),
  supersedesId: z.string().optional(),
  supersededById: z.string().optional(),
  revokedAt: z.string().datetime().optional(),
  revocationReason: z.string().max(4_096).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/** Write request accepted by POST /api/memory/write and MemoryService.write(). */
export const memoryWriteRequestSchema = z.object({
  type: memoryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  tags: z.array(z.string()).optional(),
  confidence: memoryConfidenceSchema.optional(),
  sensitivity: memorySensitivitySchema.optional(),
  sourceType: memorySourceTypeSchema.optional(),
  sourceUri: z.string().max(2_048).optional(),
  capturedBy: z.string().min(1).max(256).optional(),
  expiresAt: z.string().datetime().optional(),
  supersedesId: z.string().optional(),
  /** scope — at most determines the target folder (agents/teams/projects/tasks/sessions) */
  agentId: z.string().optional(),
  teamId: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  conversationId: z.string().optional(),
});
export type MemoryWriteRequest = z.infer<typeof memoryWriteRequestSchema>;

/** Per-project memory index row (projects/{id} lives under activeMemoryRoot). */
export const projectMemoryIndexEntrySchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  /** the project's WORKSPACE path — metadata only; memory never lives here */
  workspaceProjectPath: z.string().optional(),
  /** memory path RELATIVE to activeMemoryRoot, e.g. "projects/<id>" */
  memoryPath: z.string(),
  teamIds: z.array(z.string()).default([]),
  agentIds: z.array(z.string()).default([]),
  memoryInitialized: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectMemoryIndexEntry = z.infer<typeof projectMemoryIndexEntrySchema>;

/** Returned by GET /api/settings/memory/status. */
export interface MemoryStatus {
  enabled: boolean;
  storageMode: MemoryStorageMode;
  activeMemoryRoot?: string;
  /** true when storageMode is obsidian but we fell back to local */
  usingFallback: boolean;
  rootExists: boolean;
  writable: boolean;
  totalMemories: number;
  totalProjects: number;
  projectsWithMemory: number;
  projectsMissingMemory: number;
  lastIndexRebuild?: string;
  lastError?: string;
}
