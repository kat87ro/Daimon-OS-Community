import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  MEMORY_FOLDER_NAME,
  type MemoryEntry,
  type MemorySettings,
  type MemoryStatus,
  type MemoryType,
  type MemoryWriteRequest,
  type Project,
  type ProjectMemoryIndexEntry,
} from "@daimon-os/shared";
import type { AppLog } from "../gateway/AppLog";
import type { ConfigStore } from "../config/ConfigStore";
import {
  ensureManagedDirectory,
  managedPathExists,
  readManagedText,
  removeManagedPath,
  writeManagedFileAtomic,
} from "../security/runtimeFiles";

/** The fixed folder tree created on demand under activeMemoryRoot. */
const MEMORY_SUBDIRS = [
  "agents",
  "teams",
  "projects",
  "sessions",
  "tasks",
  "indexes",
  "system",
] as const;

const MEMORY_INDEX_FILE = "indexes/memory-index.json";
const PATH_INDEX_FILE = "indexes/path-index.json";
const PROJECT_INDEX_FILE = "indexes/project-index.json";
const MEMORY_LIFECYCLE_FILE = "system/memory-lifecycle.json";
const AUDIT_LOG_FILE = "system/audit-log.md";
const SYNC_LOG_FILE = "system/sync-log.md";

/** Which folder a write of a given scope lands in (relative to root). */
function targetFolderFor(req: MemoryWriteRequest): string {
  if (req.projectId) return path.posix.join("projects", req.projectId);
  if (req.teamId) return path.posix.join("teams", req.teamId);
  if (req.agentId) return path.posix.join("agents", req.agentId);
  if (req.taskId) return "tasks";
  if (req.conversationId) return "sessions";
  // fall back to the taxonomy bucket under system when no scope is given
  return "system";
}

/**
 * Secret-redaction patterns. We scrub anything that looks like an API key,
 * bearer token, AWS key, private-key block, or `KEY=value`/`token: value` pair
 * BEFORE the body is written to disk — durable memory must never become a
 * plaintext credential store (it can be synced to an Obsidian vault / git).
 */
const REDACTION_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // PEM private-key blocks
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "[REDACTED-PRIVATE-KEY]" },
  // provider keys: sk-..., Anthropic sk-ant-..., OpenAI, GitHub ghp_/gho_/etc.
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: "[REDACTED]" },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "[REDACTED]" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: "[REDACTED]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: "[REDACTED]" },
  // Authorization: Bearer <token>
  { re: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, replace: "$1 [REDACTED]" },
  // generic KEY=value / token: value (api_key, secret, password, token, ...)
  {
    re: /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|password|passwd|token|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*)\s*[:=]\s*["']?([^\s"']{6,})["']?/gi,
    replace: '$1=[REDACTED]',
  },
];

function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of REDACTION_PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Stored index shape — a flat list of MemoryEntry rows. */
interface MemoryIndexFile {
  entries: MemoryEntry[];
}
/** path-index maps relative filePath → entry id (fast existence/dedup checks). */
type PathIndexFile = Record<string, string>;
interface ProjectIndexFile {
  projects: ProjectMemoryIndexEntry[];
}
type MemoryLifecycleFile = Record<string, Pick<MemoryEntry,
  "supersededById" | "revokedAt" | "revocationReason" | "updatedAt">>;

/**
 * Centralized Memory — lean v1. The SINGLE writer for all durable memory. Every
 * read/write resolves under one `activeMemoryRoot` (an Obsidian-vault subfolder
 * or an app-managed local fallback) and is path-guarded against traversal. No
 * database, no embeddings — markdown bodies with Obsidian YAML frontmatter plus
 * JSON indexes, written atomically (tmp+rename) exactly like ConfigStore/Vault.
 */
export class MemoryService {
  /** Resolved absolute path to the memory root, or undefined when unresolved/disabled. */
  private activeRoot?: string;
  private usingFallback = false;
  private lastError?: string;
  private lastIndexRebuild?: string;

  constructor(
    private readonly store: ConfigStore,
    private readonly dataDir: string,
    private readonly appLog: AppLog,
  ) {}

  // ---------- root resolution ----------

  /**
   * Resolve (and create) the active memory root from settings. Obsidian mode
   * validates the vault path; on failure it either errors (strict) or falls back
   * to the local app-data folder. Local mode uses <dataDir>/AgenticOS-Memory.
   * Idempotent + best-effort: never throws — records lastError instead.
   */
  resolveActiveRoot(): string | undefined {
    const s = this.store.getMemorySettings();
    this.usingFallback = false;
    this.lastError = undefined;

    const localRoot = path.resolve(this.dataDir, MEMORY_FOLDER_NAME);

    if (!s.enabled) {
      // still record the would-be root so status/UI can show where it WOULD live,
      // but do not create anything until enabled
      this.activeRoot = undefined;
      return undefined;
    }

    let rootBase: string;
    if (s.storageMode === "obsidian") {
      const vault = s.obsidianVaultPath?.trim();
      const vaultOk = !!vault && this.isReadableDir(vault);
      if (vaultOk) {
        rootBase = fs.realpathSync.native(vault!);
      } else if (s.strictObsidian) {
        this.lastError = vault
          ? `Obsidian vault path is not a readable directory: ${vault}`
          : "Obsidian storage mode is set but no vault path is configured";
        this.appLog.emit("error", "memory", this.lastError);
        this.activeRoot = undefined;
        return undefined;
      } else {
        // non-strict: degrade to local rather than disable memory entirely
        this.usingFallback = true;
        rootBase = fs.realpathSync.native(this.dataDir);
        this.appLog.emit(
          "warn",
          "memory",
          `Obsidian vault unavailable (${vault ?? "unset"}) — falling back to local memory at ${localRoot}`,
        );
      }
    } else {
      rootBase = fs.realpathSync.native(this.dataDir);
    }

    try {
      const resolved = ensureManagedDirectory(rootBase, MEMORY_FOLDER_NAME);
      this.activeRoot = resolved;
      this.ensureTree(resolved);
      // persist the resolved root + fallback flag so status/clients reflect reality
      this.store.updateMemorySettings({
        activeMemoryRoot: resolved,
        ...(s.storageMode === "obsidian" && this.usingFallback
          ? { localMemoryFolderPath: localRoot }
          : {}),
        ...(s.storageMode === "obsidian" && !this.usingFallback
          ? { obsidianMemoryFolderPath: resolved }
          : {}),
      });
      return resolved;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.appLog.emit("error", "memory", `failed to create memory root: ${this.lastError}`);
      this.activeRoot = undefined;
      return undefined;
    }
  }

  private isReadableDir(p: string): boolean {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  }

  /** Create the folder tree + empty indexes on demand (idempotent). */
  private ensureTree(root: string): void {
    for (const sub of MEMORY_SUBDIRS) ensureManagedDirectory(root, sub);
    // seed index files if absent so reads never miss
    if (!managedPathExists(root, MEMORY_INDEX_FILE)) {
      this.writeJson(path.join(root, MEMORY_INDEX_FILE), { entries: [] } satisfies MemoryIndexFile);
    }
    if (!managedPathExists(root, PATH_INDEX_FILE)) {
      this.writeJson(path.join(root, PATH_INDEX_FILE), {} satisfies PathIndexFile);
    }
    if (!managedPathExists(root, PROJECT_INDEX_FILE)) {
      this.writeJson(path.join(root, PROJECT_INDEX_FILE), { projects: [] } satisfies ProjectIndexFile);
    }
    if (!managedPathExists(root, MEMORY_LIFECYCLE_FILE)) {
      this.writeJson(path.join(root, MEMORY_LIFECYCLE_FILE), {} satisfies MemoryLifecycleFile);
    }
  }

  // ---------- path guard ----------

  /**
   * Resolve a caller-supplied RELATIVE path under the active root and refuse any
   * absolute path or `..` traversal that escapes the root. Returns the safe
   * absolute path. Throws on a missing root or an escape attempt — callers must
   * never write outside the memory tree.
   */
  private safeResolve(relPath: string): string {
    if (!this.activeRoot) throw new Error("memory root is not resolved");
    if (path.isAbsolute(relPath)) {
      throw new Error("memory paths must be relative to the memory root");
    }
    const root = path.resolve(this.activeRoot);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`path traversal blocked: "${relPath}"`);
    }
    return abs;
  }

  // ---------- atomic IO ----------

  private writeFileAtomic(abs: string, content: string): void {
    if (!this.activeRoot) throw new Error("memory root is not resolved");
    const relative = path.relative(this.activeRoot, abs);
    writeManagedFileAtomic(this.activeRoot, relative, content);
  }
  private writeJson(abs: string, value: unknown): void {
    this.writeFileAtomic(abs, JSON.stringify(value, null, 2) + "\n");
  }
  private readJson<T>(abs: string, fallback: T): T {
    try {
      if (!this.activeRoot) return fallback;
      const relative = path.relative(this.activeRoot, abs);
      const content = readManagedText(this.activeRoot, relative);
      return content === undefined ? fallback : JSON.parse(content) as T;
    } catch {
      return fallback;
    }
  }

  private readMemoryIndex(): MemoryIndexFile {
    return this.readJson(this.safeResolve(MEMORY_INDEX_FILE), { entries: [] });
  }
  private writeMemoryIndex(idx: MemoryIndexFile): void {
    this.writeJson(this.safeResolve(MEMORY_INDEX_FILE), idx);
  }
  private readPathIndex(): PathIndexFile {
    return this.readJson(this.safeResolve(PATH_INDEX_FILE), {});
  }
  private writePathIndex(idx: PathIndexFile): void {
    this.writeJson(this.safeResolve(PATH_INDEX_FILE), idx);
  }
  private readProjectIndex(): ProjectIndexFile {
    return this.readJson(this.safeResolve(PROJECT_INDEX_FILE), { projects: [] });
  }
  private writeProjectIndex(idx: ProjectIndexFile): void {
    this.writeJson(this.safeResolve(PROJECT_INDEX_FILE), idx);
  }
  private readLifecycle(): MemoryLifecycleFile {
    return this.readJson(this.safeResolve(MEMORY_LIFECYCLE_FILE), {});
  }
  private writeLifecycle(lifecycle: MemoryLifecycleFile): void {
    this.writeJson(this.safeResolve(MEMORY_LIFECYCLE_FILE), lifecycle);
  }

  private audit(line: string): void {
    if (!this.activeRoot) return;
    try {
      const existing = readManagedText(this.activeRoot, AUDIT_LOG_FILE) ?? "";
      writeManagedFileAtomic(
        this.activeRoot,
        AUDIT_LOG_FILE,
        `${existing}- ${new Date().toISOString()} — ${line}\n`,
      );
    } catch {
      /* audit is best-effort — never block a write on a log append */
    }
  }

  // ---------- markdown + frontmatter ----------

  private buildMarkdown(entry: MemoryEntry, req: MemoryWriteRequest, body: string): string {
    const fm: string[] = ["---"];
    fm.push(`id: ${entry.id}`);
    fm.push(`type: ${entry.type}`);
    fm.push(`title: ${yamlScalar(entry.title)}`);
    if (req.agentId) fm.push(`agent_id: ${req.agentId}`);
    if (req.teamId) fm.push(`team_id: ${req.teamId}`);
    if (req.projectId) fm.push(`project_id: ${req.projectId}`);
    if (req.taskId) fm.push(`task_id: ${req.taskId}`);
    if (req.conversationId) fm.push(`conversation_id: ${req.conversationId}`);
    fm.push(`source: agentic-os`);
    fm.push(`confidence: ${entry.confidence}`);
    fm.push(`sensitivity: ${entry.sensitivity ?? "internal"}`);
    fm.push(`memory_version: ${entry.version ?? 1}`);
    if (entry.provenance) {
      fm.push(`source_type: ${entry.provenance.sourceType}`);
      fm.push(`captured_by: ${yamlScalar(entry.provenance.capturedBy)}`);
      fm.push(`captured_at: ${entry.provenance.capturedAt}`);
      if (entry.provenance.sourceUri) fm.push(`source_uri: ${yamlScalar(entry.provenance.sourceUri)}`);
    }
    if (entry.expiresAt) fm.push(`expires_at: ${entry.expiresAt}`);
    if (entry.supersedesId) fm.push(`supersedes_id: ${entry.supersedesId}`);
    fm.push(`created_at: ${entry.createdAt}`);
    fm.push(`updated_at: ${entry.updatedAt}`);
    fm.push(`tags: [${entry.tags.map(yamlScalar).join(", ")}]`);
    fm.push("---", "");
    return fm.join("\n") + `\n# ${entry.title}\n\n${body}\n`;
  }

  // ---------- write ----------

  /** Sanitise a proposed write before it enters any durable approval or artifact
   *  store. The write path calls this again so callers cannot bypass redaction. */
  sanitizeWriteRequest(req: MemoryWriteRequest): MemoryWriteRequest {
    return {
      ...req,
      title: redactSecrets(req.title),
      content: redactSecrets(req.content),
      tags: req.tags?.map(redactSecrets),
      sourceUri: req.sourceUri ? redactSecrets(req.sourceUri) : undefined,
    };
  }

  /**
   * The single durable write. Classifies scope → target folder, redacts secrets,
   * writes a frontmatter markdown body, and updates the JSON indexes. Dedupes on
   * (title + content checksum): an identical re-write returns the existing entry
   * without creating a second file.
   */
  write(req: MemoryWriteRequest): MemoryEntry {
    if (!this.activeRoot) throw new Error("memory is disabled or its root is unresolved");

    req = this.sanitizeWriteRequest(req);
    const cleanContent = req.content;
    const checksum = crypto
      .createHash("sha256")
      .update(`${req.title}\n${cleanContent}`)
      .digest("hex")
      .slice(0, 16);

    const idx = this.readMemoryIndex();
    const superseded = req.supersedesId
      ? idx.entries.find((entry) => entry.id === req.supersedesId)
      : undefined;
    if (req.supersedesId && !superseded) throw new Error("superseded memory does not exist");
    if (superseded?.revokedAt) throw new Error("a revoked memory cannot be superseded");
    const folder = targetFolderFor(req);
    const expectedAgents = req.agentId ? [req.agentId] : [];
    const expectedTeams = req.teamId ? [req.teamId] : [];
    const expectedProjects = req.projectId ? [req.projectId] : [];
    const expectedTasks = req.taskId ? [req.taskId] : [];
    const same = (left: string[], right: string[]): boolean =>
      left.length === right.length && left.every((value, index) => value === right[index]);
    // Dedupe only an active record in the same governance scope. A
    // supersession is always a new lifecycle event and conversation-scoped
    // records cannot be proven equivalent because the index has no conversation
    // identity column.
    const existing = !req.supersedesId && !req.conversationId
      ? idx.entries.find((entry) =>
          entry.title === req.title && entry.checksum === checksum && entry.type === req.type &&
          !entry.revokedAt && !entry.supersededById &&
          (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()) &&
          path.posix.dirname(entry.filePath) === folder &&
          same(entry.relatedAgents, expectedAgents) &&
          same(entry.relatedTeams, expectedTeams) &&
          same(entry.relatedProjects, expectedProjects) &&
          same(entry.relatedTasks, expectedTasks))
      : undefined;
    if (existing) {
      this.audit(`write deduped "${req.title}" (${existing.id})`);
      return existing;
    }

    const now = new Date().toISOString();
    const tags = Array.from(
      new Set([...(req.tags ?? []), "agentic-os", "memory"]),
    );
    const id = crypto.randomUUID();
    const fileName = `${slugify(req.title)}-${id.slice(0, 8)}.md`;
    const relPath = path.posix.join(folder, fileName);

    const entry: MemoryEntry = {
      id,
      title: req.title,
      filePath: relPath,
      type: req.type,
      tags,
      relatedAgents: req.agentId ? [req.agentId] : [],
      relatedTeams: req.teamId ? [req.teamId] : [],
      relatedProjects: req.projectId ? [req.projectId] : [],
      relatedTasks: req.taskId ? [req.taskId] : [],
      confidence: req.confidence ?? "medium",
      summary: firstLine(cleanContent),
      checksum,
      sensitivity: req.sensitivity ?? "internal",
      provenance: {
        sourceType: req.sourceType ?? "human",
        sourceUri: req.sourceUri,
        capturedBy: req.capturedBy ?? "local-operator",
        capturedAt: now,
      },
      version: (superseded?.version ?? 0) + 1,
      expiresAt: req.expiresAt,
      supersedesId: superseded?.id,
      createdAt: now,
      updatedAt: now,
    };

    const abs = this.safeResolve(relPath);
    this.writeFileAtomic(abs, this.buildMarkdown(entry, req, cleanContent));

    if (superseded) {
      superseded.supersededById = entry.id;
      superseded.updatedAt = now;
      const lifecycle = this.readLifecycle();
      lifecycle[superseded.id] = {
        ...lifecycle[superseded.id],
        supersededById: entry.id,
        updatedAt: now,
      };
      this.writeLifecycle(lifecycle);
    }
    idx.entries.push(entry);
    this.writeMemoryIndex(idx);
    const pathIdx = this.readPathIndex();
    pathIdx[relPath] = id;
    this.writePathIndex(pathIdx);

    if (req.projectId) this.touchProjectIndex(req.projectId);
    this.audit(`write "${req.title}" → ${relPath} (${entry.type})`);
    return entry;
  }

  // ---------- search ----------

  /** Keyword/index lookup over memory-index.json — no embeddings (lean v1). */
  search(opts: {
    q?: string;
    projectId?: string;
    agentId?: string;
    teamId?: string;
    type?: MemoryType;
    limit?: number;
    includeInactive?: boolean;
  }): MemoryEntry[] {
    if (!this.activeRoot) return [];
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 25;
    const q = opts.q?.trim().toLowerCase();
    let rows = this.readMemoryIndex().entries;
    if (!opts.includeInactive) {
      const now = Date.now();
      rows = rows.filter((entry) =>
        !entry.revokedAt &&
        !entry.supersededById &&
        (!entry.expiresAt || Date.parse(entry.expiresAt) > now));
    }

    if (opts.projectId) rows = rows.filter((e) => e.relatedProjects.includes(opts.projectId!));
    if (opts.agentId) rows = rows.filter((e) => e.relatedAgents.includes(opts.agentId!));
    if (opts.teamId) rows = rows.filter((e) => e.relatedTeams.includes(opts.teamId!));
    if (opts.type) rows = rows.filter((e) => e.type === opts.type);
    if (q) {
      rows = rows.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          (e.summary?.toLowerCase().includes(q) ?? false) ||
          e.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }
    // newest first
    rows = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rows.slice(0, limit);
  }

  // ---------- get ----------

  get(id: string): { entry: MemoryEntry; content: string } | undefined {
    if (!this.activeRoot) return undefined;
    const entry = this.readMemoryIndex().entries.find((e) => e.id === id);
    if (!entry) return undefined;
    let content = "";
    try {
      content = readManagedText(this.activeRoot, entry.filePath) ?? "";
    } catch {
      content = "";
    }
    return { entry, content };
  }

  revoke(id: string, reason: string): MemoryEntry {
    if (!this.activeRoot) throw new Error("memory is disabled or its root is unresolved");
    const idx = this.readMemoryIndex();
    const entry = idx.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error("unknown memory");
    if (entry.revokedAt) return entry;
    entry.revokedAt = new Date().toISOString();
    entry.revocationReason = reason.trim().slice(0, 4_096) || "revoked by local operator";
    entry.updatedAt = entry.revokedAt;
    this.writeMemoryIndex(idx);
    const lifecycle = this.readLifecycle();
    lifecycle[entry.id] = {
      ...lifecycle[entry.id],
      revokedAt: entry.revokedAt,
      revocationReason: entry.revocationReason,
      updatedAt: entry.updatedAt,
    };
    this.writeLifecycle(lifecycle);
    this.audit(`revoke "${entry.title}" (${entry.id}) — ${entry.revocationReason}`);
    return entry;
  }

  // ---------- retrieve (context injection) ----------

  /**
   * Build a labeled "Relevant Memory" block within a rough token budget (~4 chars
   * ≈ 1 token), or "" when memory/retrieval is disabled or nothing matches. Prefers
   * the indexed summaries over scanning bodies (lean v1, keyword-ranked).
   */
  retrieve(opts: {
    projectId?: string;
    agentId?: string;
    teamId?: string;
    taskTitle?: string;
    tokenBudget?: number;
  }): string {
    const s = this.store.getMemorySettings();
    if (!s.enabled || !s.enableRetrieval || !this.activeRoot) return "";

    const budget = opts.tokenBudget ?? s.retrievalTokenBudget;
    if (!budget || budget <= 0) return "";

    // candidate pool: anything scoped to this project/agent/team, then keyword-rank
    // against the task title words
    const pool = this.search({
      projectId: opts.projectId,
      agentId: opts.agentId,
      teamId: opts.teamId,
      limit: 100,
    });
    if (pool.length === 0) return "";

    const words = (opts.taskTitle ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const scored = pool
      .filter((entry) => entry.sensitivity !== "restricted")
      .map((e) => {
        const hay = `${e.title} ${e.summary ?? ""} ${e.tags.join(" ")}`.toLowerCase();
        const score = words.reduce((n, w) => (hay.includes(w) ? n + 1 : n), 0);
        return { e, score };
      })
      .sort((a, b) => b.score - a.score || b.e.updatedAt.localeCompare(a.e.updatedAt));

    const charBudget = budget * 4; // ~4 chars per token
    const header = "## Relevant Memory\n\n";
    let body = "";
    for (const { e } of scored) {
      const block = [
        `- Source: ${e.title} (${e.type}; id=${e.id})`,
        `  Summary: ${e.summary ?? "(no summary)"}`,
        `  Confidence: ${e.confidence}`,
        `  Sensitivity: ${e.sensitivity ?? "internal"}`,
        `  Provenance: ${e.provenance?.sourceType ?? "legacy"} via ${e.provenance?.capturedBy ?? "unknown"}`,
        `  Retrieval reason: scoped match${words.some((word) => `${e.title} ${e.summary ?? ""} ${e.tags.join(" ")}`.toLowerCase().includes(word)) ? " + task keyword match" : ""}`,
        `  Last updated: ${e.updatedAt}`,
        "",
      ].join("\n");
      if (header.length + body.length + block.length > charBudget) break;
      body += block;
    }
    return body ? header + body : "";
  }

  // ---------- project memory ----------

  /**
   * Create centralized memory for a project under projects/{id}/ (NEVER inside the
   * project's workspace folder — the workspace `path` is stored as metadata only).
   * Templates the seven canonical notes from the project fields, registers the
   * project in project-index.json with memoryInitialized:true, and audit-logs it.
   */
  initProjectMemory(project: Project): ProjectMemoryIndexEntry {
    if (!this.activeRoot) throw new Error("memory is disabled or its root is unresolved");
    const memRel = path.posix.join("projects", project.id);
    ensureManagedDirectory(this.activeRoot, memRel);

    const now = new Date().toISOString();
    const fm = (title: string) =>
      [
        "---",
        `project_id: ${project.id}`,
        `project_name: ${yamlScalar(project.name)}`,
        `source: agentic-os`,
        `created_at: ${now}`,
        `updated_at: ${now}`,
        `tags: [agentic-os, memory, project]`,
        "---",
        "",
        `# ${project.name} — ${title}`,
        "",
      ].join("\n");

    const files: Record<string, string> = {
      "project.md":
        fm("Project") +
        [
          `- Project ID: ${project.id}`,
          // workspace path is METADATA ONLY — memory does not live there
          `- Workspace path (metadata): ${project.path}`,
          project.teamId ? `- Team: ${project.teamId}` : "- Team: (none attached)",
          "",
        ].join("\n"),
      "context.md": fm("Context") + "Durable background and domain context for this project.\n",
      "decisions.md": fm("Decisions") + "Architecture decisions and rationale (ADR-style).\n",
      "timeline.md": fm("Timeline") + "Chronological log of notable events.\n",
      "team.md": fm("Team") + "Agents, roles, and reporting lines on this project.\n",
      "tasks.md": fm("Tasks") + "Task-level learnings and outcomes.\n",
      "artifacts.md": fm("Artifacts") + "Deliverables produced and where they live.\n",
      "memory.md": fm("Memory") + "Free-form curated memory for this project.\n",
    };
    for (const [name, content] of Object.entries(files)) {
      const relative = path.posix.join(memRel, name);
      const abs = this.safeResolve(relative);
      // don't clobber an existing curated note on re-init
      if (!managedPathExists(this.activeRoot, relative)) this.writeFileAtomic(abs, content);
    }

    const entry = this.touchProjectIndex(project.id, {
      projectName: project.name,
      workspaceProjectPath: project.path,
      teamIds: project.teamId ? [project.teamId] : [],
      memoryInitialized: true,
    });
    this.audit(`initProjectMemory "${project.name}" → ${memRel}`);
    this.appLog.emit("info", "memory", `initialized centralized memory for project "${project.name}"`);
    return entry;
  }

  /** Upsert a project's row in project-index.json (creating it if needed). */
  private touchProjectIndex(
    projectId: string,
    patch?: Partial<ProjectMemoryIndexEntry>,
  ): ProjectMemoryIndexEntry {
    const idx = this.readProjectIndex();
    const now = new Date().toISOString();
    const memPath = path.posix.join("projects", projectId);
    let row = idx.projects.find((p) => p.projectId === projectId);
    if (!row) {
      row = {
        projectId,
        projectName: patch?.projectName ?? projectId,
        workspaceProjectPath: patch?.workspaceProjectPath,
        memoryPath: memPath,
        teamIds: patch?.teamIds ?? [],
        agentIds: patch?.agentIds ?? [],
        memoryInitialized: patch?.memoryInitialized ?? false,
        createdAt: now,
        updatedAt: now,
      };
      idx.projects.push(row);
    } else {
      Object.assign(row, patch, { memoryPath: memPath, updatedAt: now });
    }
    this.writeProjectIndex(idx);
    return row;
  }

  /** True when a project already has initialized centralized memory. */
  hasProjectMemory(projectId: string): boolean {
    if (!this.activeRoot) return false;
    return this.readProjectIndex().projects.some(
      (p) => p.projectId === projectId && p.memoryInitialized,
    );
  }

  // ---------- maintenance ----------

  /** Rescan the markdown tree and rebuild the JSON indexes from frontmatter. */
  rebuildIndex(): { totalMemories: number } {
    if (!this.activeRoot) throw new Error("memory is disabled or its root is unresolved");
    const root = this.activeRoot;
    const entries: MemoryEntry[] = [];
    const pathIdx: PathIndexFile = {};
    const lifecycle = this.readLifecycle();

    const scanDirs = ["agents", "teams", "projects", "sessions", "tasks", "system"];
    for (const dir of scanDirs) {
      const base = path.join(root, dir);
      for (const abs of walkMarkdown(base)) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        const text = readManagedText(root, rel) ?? "";
        const parsed = parseFrontmatter(text);
        if (!parsed) continue;
        const id = (parsed.id as string) ?? crypto.randomUUID();
        const created = (parsed.created_at as string) ?? new Date().toISOString();
        const entry: MemoryEntry = {
          id,
          title: (parsed.title as string) ?? path.basename(abs, ".md"),
          filePath: rel,
          type: ((parsed.type as MemoryType) ?? "semantic"),
          tags: (parsed.tags as string[]) ?? [],
          relatedAgents: parsed.agent_id ? [String(parsed.agent_id)] : [],
          relatedTeams: parsed.team_id ? [String(parsed.team_id)] : [],
          relatedProjects: parsed.project_id ? [String(parsed.project_id)] : [],
          relatedTasks: parsed.task_id ? [String(parsed.task_id)] : [],
          confidence: ((parsed.confidence as MemoryEntry["confidence"]) ?? "medium"),
          summary: firstLine(stripFrontmatter(text)),
          checksum: undefined,
          sensitivity: (parsed.sensitivity as MemoryEntry["sensitivity"]) ?? "internal",
          provenance: parsed.source_type ? {
            sourceType: parsed.source_type as NonNullable<MemoryEntry["provenance"]>["sourceType"],
            sourceUri: parsed.source_uri ? String(parsed.source_uri) : undefined,
            capturedBy: String(parsed.captured_by ?? "index-rebuild"),
            capturedAt: String(parsed.captured_at ?? created),
          } : undefined,
          version: Number(parsed.memory_version ?? 1),
          expiresAt: parsed.expires_at ? String(parsed.expires_at) : undefined,
          supersedesId: parsed.supersedes_id ? String(parsed.supersedes_id) : undefined,
          createdAt: created,
          updatedAt: (parsed.updated_at as string) ?? created,
        };
        Object.assign(entry, lifecycle[id]);
        entries.push(entry);
        pathIdx[rel] = id;
      }
    }
    this.writeMemoryIndex({ entries });
    this.writePathIndex(pathIdx);
    this.lastIndexRebuild = new Date().toISOString();
    this.appendSyncLog(`rebuildIndex → ${entries.length} memories`);
    this.audit(`rebuildIndex → ${entries.length} memories`);
    return { totalMemories: entries.length };
  }

  /** Write+delete a probe file to verify the root is writable. */
  testWrite(): { ok: boolean; path?: string; error?: string } {
    if (!this.activeRoot) return { ok: false, error: "memory root is not resolved" };
    const rel = path.posix.join("system", `.probe-${crypto.randomUUID().slice(0, 8)}`);
    try {
      const abs = this.safeResolve(rel);
      this.writeFileAtomic(abs, "probe\n");
      removeManagedPath(this.activeRoot, rel);
      return { ok: true, path: rel };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private appendSyncLog(line: string): void {
    if (!this.activeRoot) return;
    try {
      const existing = readManagedText(this.activeRoot, SYNC_LOG_FILE) ?? "";
      writeManagedFileAtomic(
        this.activeRoot,
        SYNC_LOG_FILE,
        `${existing}- ${new Date().toISOString()} — ${line}\n`,
      );
    } catch {
      /* best-effort */
    }
  }

  // ---------- status ----------

  status(): MemoryStatus {
    const s = this.store.getMemorySettings();
    const rootExists = !!this.activeRoot && this.isReadableDir(this.activeRoot);
    const probe = this.activeRoot ? this.testWrite() : { ok: false };
    const memories = this.activeRoot ? this.readMemoryIndex().entries.length : 0;
    const projects = this.activeRoot ? this.readProjectIndex().projects : [];
    const withMem = projects.filter((p) => p.memoryInitialized).length;
    return {
      enabled: s.enabled,
      storageMode: s.storageMode,
      activeMemoryRoot: this.activeRoot,
      usingFallback: this.usingFallback,
      rootExists,
      writable: probe.ok,
      totalMemories: memories,
      totalProjects: projects.length,
      projectsWithMemory: withMem,
      projectsMissingMemory: Math.max(0, projects.length - withMem),
      lastIndexRebuild: this.lastIndexRebuild,
      lastError: this.lastError,
    };
  }
}

// ---------- helpers ----------

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "memory"
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.slice(0, 200);
}

/** Minimal YAML scalar quoting — wrap in double quotes if it has YAML-significant chars. */
function yamlScalar(s: string): string {
  if (/^[A-Za-z0-9 _.\-/]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function* walkMarkdown(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMarkdown(abs);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      yield abs;
    }
  }
}

function stripFrontmatter(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? text.slice(m[0].length) : text;
}

/** Tiny YAML frontmatter parser — handles scalars and `[a, b]` flow lists only. */
function parseFrontmatter(text: string): Record<string, unknown> | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return undefined;
  const out: Record<string, unknown> = {};
  for (const raw of m[1]!.split("\n")) {
    const line = raw.trimEnd();
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (!key) continue;
    if (val.startsWith("[") && val.endsWith("]")) {
      out[key] = val
        .slice(1, -1)
        .split(",")
        .map((x) => unquote(x.trim()))
        .filter((x) => x.length > 0);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}
