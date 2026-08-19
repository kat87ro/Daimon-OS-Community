import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DurableExecutionStore } from "./DurableExecutionStore";
import type { DurableRun } from "./types";
import { managedPathExists, removeManagedPath } from "../security/runtimeFiles";
import { GitService } from "../git/GitService";

export class WorktreePolicyError extends Error {}
export class PromotionStateUncertainError extends WorktreePolicyError {}
export type PromotionInspection = "applied" | "not_applied" | "uncertain";

export interface PreparedWorktree {
  canonicalRoot: string;
  path: string;
  branch: string;
  baseHead: string;
  parentSubjectHash?: string;
}

export interface CapturedWorktree {
  subjectHash: string;
  diffArtifactHash: string;
  statusArtifactHash: string;
}

/** Isolates scheduler workers from the operator's canonical checkout. */
export class WorktreeManager {
  private readonly root: string;
  private readonly leadWorktrees = new Map<string, { canonicalRoot: string; path: string; projectId: string }>();
  private readonly managedPaths = new Map<string, string>();
  private readonly git: GitService;

  constructor(dataDir: string, private readonly durable: DurableExecutionStore, git?: GitService) {
    const worktreeRoot = path.join(dataDir, "worktrees");
    fs.mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync.native(worktreeRoot);
    this.git = git ?? new GitService(path.join(dataDir, "git-runtime"));
  }

  /** Bounded startup recovery for only Daimon-owned paths and interrupted rows. */
  recoverInterruptedRuns(): void {
    for (const run of this.durable.listInterruptedRuns().slice(0, 500)) {
      let reason = "gateway restarted while the worker was active";
      try {
        if (run.worktreePath && fs.existsSync(run.worktreePath)) {
          const captured = this.captureAndCleanup(run);
          this.durable.updateRun(run.id, captured);
        }
      } catch (error) {
        reason += `; recovery evidence capture failed: ${error instanceof Error ? error.message : String(error)}`;
        if (run.worktreePath) this.cleanupRaw(run.canonicalRoot, run.worktreePath, run.worktreeBranch ?? "");
      }
      this.durable.markRunFailed(run.id, reason, run.metrics);
      this.durable.openAttention({ projectId: run.projectId, taskId: run.taskId, runId: run.id, kind: "failed", message: reason });
    }
    for (const run of this.durable.listPromotingRuns().slice(0, 500)) {
      this.durable.openAttention({
        projectId: run.projectId, taskId: run.taskId, runId: run.id, kind: "policy_blocked",
        message: "promotion was interrupted; retry promotion with the same exact approved subject hash",
      });
    }
    this.cleanupStaleLeadWorktrees();
  }

  factoryReset(): void {
    for (const [sessionId] of this.leadWorktrees) this.cleanupLeadSession(sessionId);
    for (const run of this.durable.listRuns()) {
      if (!run.worktreePath) continue;
      try { this.cleanupRaw(run.canonicalRoot, run.worktreePath, run.worktreeBranch ?? ""); } catch { /* app-owned path cleanup follows */ }
    }
    this.cleanupStaleLeadWorktrees();
    // Worker worktrees were already closed/captured by ProcessManager exit hooks.
    // Any remaining directory is app-owned and may be deleted, but never follow a symlink.
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      const target = path.join(this.root, entry.name);
      if (entry.isSymbolicLink()) {
        fs.unlinkSync(target);
      } else if (entry.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
    this.managedPaths.clear();
  }

  prepare(projectRoot: string, taskId: string, runId: string): PreparedWorktree {
    const canonicalRoot = fs.realpathSync.native(projectRoot);
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new WorktreePolicyError("project root is not a directory");
    const repoRoot = this.git.repositoryRoot(canonicalRoot);
    const realRepoRoot = fs.realpathSync.native(repoRoot);
    if (realRepoRoot !== canonicalRoot) {
      throw new WorktreePolicyError("scheduler isolation requires the project path to be the Git repository root");
    }
    const baseHead = this.git.resolveHead(canonicalRoot);
    if (!/^[a-f0-9]{40,64}$/i.test(baseHead)) throw new WorktreePolicyError("Git HEAD could not be resolved");
    const inherited = this.approvedCanonicalState(canonicalRoot, baseHead);
    const opaque = createHash("sha256").update(`${taskId}\0${runId}`).digest("hex").slice(0, 24);
    const branch = `daimon/run-${opaque}`;
    const worktreePath = path.join(this.root, opaque);
    if (fs.existsSync(worktreePath)) throw new WorktreePolicyError("isolated worktree path already exists");
    try {
      // Prune registrations whose app-owned path disappeared during a prior
      // crash. The canonical root is authoritative; never derive a repository
      // to mutate from a stale worktree's attacker-writable `.git` file.
      try { this.git.pruneWorktrees(canonicalRoot); } catch { /* add remains fail-closed */ }
      this.git.addWorkerWorktree(canonicalRoot, worktreePath, branch, baseHead);
      this.git.checkout(worktreePath, baseHead);
      this.assertWorktreeRepository(worktreePath, canonicalRoot);
      if (inherited.patch.byteLength > 0) {
        this.git.checkPatch(worktreePath, inherited.patch);
        this.git.applyPatch(worktreePath, inherited.patch);
      }
    } catch (error) {
      this.cleanupRaw(canonicalRoot, worktreePath, branch);
      throw error;
    }
    const realWorktree = fs.realpathSync.native(worktreePath);
    const realRoot = fs.realpathSync.native(this.root);
    if (!realWorktree.startsWith(realRoot + path.sep)) {
      this.cleanupRaw(canonicalRoot, worktreePath, branch);
      throw new WorktreePolicyError("worktree path escaped the managed worktree root");
    }
    this.managedPaths.set(realWorktree, canonicalRoot);
    return { canonicalRoot, path: realWorktree, branch, baseHead, parentSubjectHash: inherited.subjectHash };
  }

  /**
   * The resident Lead receives an isolated detached checkout too. Its scoped MCP
   * token and copied goal assets are therefore never written to the canonical
   * checkout. Lead changes are intentionally discarded: a Lead plans/delegates;
   * write-capable delivery is performed by durable worker runs.
   */
  prepareLead(projectRoot: string, projectId: string, instanceId: string): string {
    const canonicalRoot = fs.realpathSync.native(projectRoot);
    const repoRoot = fs.realpathSync.native(this.git.repositoryRoot(canonicalRoot));
    if (repoRoot !== canonicalRoot) {
      throw new WorktreePolicyError("Lead isolation requires the project path to be the Git repository root");
    }
    const head = this.git.resolveHead(canonicalRoot);
    const inherited = this.approvedCanonicalState(canonicalRoot, head);
    const opaque = createHash("sha256").update(`lead\0${projectId}\0${instanceId}`).digest("hex").slice(0, 24);
    const worktreePath = path.join(this.root, `lead-${opaque}`);
    if (fs.existsSync(worktreePath)) throw new WorktreePolicyError("Lead worktree path already exists");
    try { this.git.pruneWorktrees(canonicalRoot); } catch { /* add remains fail-closed */ }
    this.git.addDetachedWorktree(canonicalRoot, worktreePath, head);
    this.assertWorktreeRepository(worktreePath, canonicalRoot);
    if (inherited.patch.byteLength > 0) {
      this.git.checkPatch(worktreePath, inherited.patch);
      this.git.applyPatch(worktreePath, inherited.patch);
    }
    const realWorktree = fs.realpathSync.native(worktreePath);
    this.managedPaths.set(realWorktree, canonicalRoot);
    return realWorktree;
  }

  registerLeadSession(sessionId: string, projectId: string, canonicalRoot: string, leadWorktree: string): void {
    const root = fs.realpathSync.native(this.root);
    const worktree = fs.realpathSync.native(leadWorktree);
    if (!worktree.startsWith(root + path.sep)) throw new WorktreePolicyError("unmanaged Lead worktree path");
    this.leadWorktrees.set(sessionId, { projectId, canonicalRoot: fs.realpathSync.native(canonicalRoot), path: worktree });
  }

  leadSessionForProject(projectId: string): string | undefined {
    for (const [sessionId, item] of this.leadWorktrees) {
      if (item.projectId === projectId) return sessionId;
    }
    return undefined;
  }

  cleanupLeadSession(sessionId: string): string | undefined {
    const item = this.leadWorktrees.get(sessionId);
    if (!item) return undefined;
    this.leadWorktrees.delete(sessionId);
    this.cleanupRaw(item.canonicalRoot, item.path, "");
    return item.projectId;
  }

  cleanupUnregisteredLead(canonicalRoot: string, leadWorktree: string): void {
    this.cleanupRaw(canonicalRoot, leadWorktree, "");
  }

  isManagedWorktree(projectRoot: string, requestedCwd: string): boolean {
    try {
      const cwd = fs.realpathSync.native(requestedCwd);
      const canonical = fs.realpathSync.native(projectRoot);
      return this.managedPaths.get(cwd) === canonical;
    } catch {
      return false;
    }
  }

  captureAndCleanup(run: DurableRun): CapturedWorktree {
    if (!run.worktreePath || !run.worktreeBranch || !run.baseHead) {
      throw new WorktreePolicyError("run has no managed worktree");
    }
    const realRoot = fs.realpathSync.native(this.root);
    const realWorktree = fs.realpathSync.native(run.worktreePath);
    if (!realWorktree.startsWith(realRoot + path.sep)) throw new WorktreePolicyError("unmanaged worktree path");
    try {
      this.assertWorktreeRepository(realWorktree, run.canonicalRoot);
      this.restoreRuntimeConfig(realWorktree, run.baseHead);
      this.git.stageAll(realWorktree);
      const raw = this.git.rawStagedDiff(realWorktree, run.baseHead);
      rejectUnsafeGitModes(raw);
      const diff = this.git.binaryStagedDiff(realWorktree, run.baseHead);
      const status = this.git.statusEvidence(realWorktree);
      const diffArtifact = this.durable.putArtifact(diff, "git-diff", "application/vnd.git.diff", {
        runId: run.id, taskId: run.taskId, baseHead: run.baseHead,
      });
      const statusArtifact = this.durable.putArtifact(status, "git-status", "application/octet-stream", {
        runId: run.id, taskId: run.taskId, baseHead: run.baseHead,
      });
      this.durable.appendEvent(`run:${run.id}`, "artifact.captured", { runId: run.id, artifactHash: diffArtifact.sha256, kind: "git-diff" });
      this.durable.appendEvent(`run:${run.id}`, "artifact.captured", { runId: run.id, artifactHash: statusArtifact.sha256, kind: "git-status" });
      return { subjectHash: diffArtifact.sha256, diffArtifactHash: diffArtifact.sha256, statusArtifactHash: statusArtifact.sha256 };
    } finally {
      this.cleanupRaw(run.canonicalRoot, run.worktreePath, run.worktreeBranch);
    }
  }

  /** Never persist/promote generated MCP runtime config; it may contain credentials. */
  private restoreRuntimeConfig(worktree: string, baseHead: string): void {
    for (const relative of [
      ".mcp.json",
      ".gemini/settings.json",
      ".codex/config.toml",
      ".claude/skills",
      ".daimon/goal-assets",
    ]) {
      const tracked = this.git.objectPathExists(worktree, baseHead, relative);
      // Remove the whole app-managed path first, even when it was tracked at
      // base. `git checkout` restores tracked entries but does not remove extra
      // untracked mounted files within a tracked directory.
      removeManagedPath(worktree, relative);
      if (tracked) {
        this.git.restorePath(worktree, baseHead, relative);
        // A repository may track one of these paths as a symlink. Reject instead
        // of letting later cleanup or materialization follow it.
        managedPathExists(worktree, relative);
      }
    }
  }

  promote(run: DurableRun, expectedSubjectHash: string): void {
    if (!run.diffArtifactHash || run.subjectHash !== expectedSubjectHash || run.diffArtifactHash !== expectedSubjectHash) {
      throw new WorktreePolicyError("promotion subject hash does not match captured evidence");
    }
    if (!this.durable.hasApproval(run.id, expectedSubjectHash)) {
      throw new WorktreePolicyError("an exact-subject human approval is required");
    }
    const canonicalRoot = fs.realpathSync.native(run.canonicalRoot);
    const currentHead = this.git.resolveHead(canonicalRoot);
    if (currentHead !== run.baseHead) throw new WorktreePolicyError("canonical HEAD changed since this run; re-run against the current revision");
    const patch = this.durable.readArtifact(expectedSubjectHash);
    if (createHash("sha256").update(patch).digest("hex") !== expectedSubjectHash) {
      throw new WorktreePolicyError("captured diff integrity check failed");
    }
    const dirty = this.git.isDirty(canonicalRoot);
    if (dirty) {
      if (this.isExactPatchApplied(canonicalRoot, expectedSubjectHash)) return;
      const currentPatch = this.git.workingTreeDiffAgainstHead(canonicalRoot);
      const currentHash = createHash("sha256").update(currentPatch).digest("hex");
      if (!run.parentSubjectHash || currentHash !== run.parentSubjectHash ||
          !this.durable.hasPromotedState(canonicalRoot, run.baseHead, currentHash)) {
        throw new WorktreePolicyError("canonical checkout is dirty with changes outside the approved predecessor; promotion refused");
      }
      this.replaceApprovedState(canonicalRoot, currentPatch, patch, currentHash, expectedSubjectHash);
      return;
    }
    if (run.parentSubjectHash) {
      throw new WorktreePolicyError("the approved predecessor is missing from the canonical checkout; promotion refused");
    }
    if (patch.byteLength > 0) {
      this.git.checkPatch(canonicalRoot, patch);
      this.git.applyPatch(canonicalRoot, patch);
    }
    if (!this.isExactPatchApplied(canonicalRoot, expectedSubjectHash)) {
      throw new PromotionStateUncertainError("post-promotion checkout does not exactly match the approved subject");
    }
  }

  inspectPromotionState(run: DurableRun, expectedSubjectHash: string): PromotionInspection {
    try {
      if (!run.baseHead || run.subjectHash !== expectedSubjectHash || run.diffArtifactHash !== expectedSubjectHash) {
        return "uncertain";
      }
      const canonicalRoot = fs.realpathSync.native(run.canonicalRoot);
      if (this.git.resolveHead(canonicalRoot) !== run.baseHead) return "uncertain";
      const patch = this.git.workingTreeDiffAgainstHead(canonicalRoot);
      const currentHash = createHash("sha256").update(patch).digest("hex");
      if (currentHash === expectedSubjectHash) return "applied";
      if (patch.byteLength === 0 && !run.parentSubjectHash) return "not_applied";
      if (run.parentSubjectHash && currentHash === run.parentSubjectHash &&
          this.durable.hasPromotedState(canonicalRoot, run.baseHead, currentHash)) {
        return "not_applied";
      }
      return "uncertain";
    } catch {
      return "uncertain";
    }
  }

  private approvedCanonicalState(canonicalRoot: string, baseHead: string): { patch: Buffer; subjectHash?: string } {
    if (!this.git.isDirty(canonicalRoot)) return { patch: Buffer.alloc(0) };
    const patch = this.git.workingTreeDiffAgainstHead(canonicalRoot);
    const subjectHash = createHash("sha256").update(patch).digest("hex");
    if (!this.durable.hasPromotedState(canonicalRoot, baseHead, subjectHash)) {
      throw new WorktreePolicyError("canonical checkout contains changes that are not an exact approved promotion");
    }
    return { patch, subjectHash };
  }

  private replaceApprovedState(
    canonicalRoot: string,
    priorPatch: Buffer,
    nextPatch: Buffer,
    priorHash: string,
    nextHash: string,
  ): void {
    this.git.checkReversePatch(canonicalRoot, priorPatch);
    this.git.reversePatch(canonicalRoot, priorPatch);
    try {
      if (nextPatch.byteLength > 0) {
        this.git.checkPatch(canonicalRoot, nextPatch);
        this.git.applyPatch(canonicalRoot, nextPatch);
      }
      if (!this.isExactPatchApplied(canonicalRoot, nextHash)) {
        throw new WorktreePolicyError("post-promotion checkout does not exactly match the approved successor subject");
      }
    } catch (error) {
      try {
        const current = this.git.workingTreeDiffAgainstHead(canonicalRoot);
        const currentHash = createHash("sha256").update(current).digest("hex");
        if (current.byteLength > 0 && currentHash === nextHash) {
          this.git.checkReversePatch(canonicalRoot, nextPatch);
          this.git.reversePatch(canonicalRoot, nextPatch);
        }
        if (priorPatch.byteLength > 0) {
          this.git.checkPatch(canonicalRoot, priorPatch);
          this.git.applyPatch(canonicalRoot, priorPatch);
        }
        if (!this.isExactPatchApplied(canonicalRoot, priorHash)) {
          throw new Error("approved predecessor rollback verification failed");
        }
      } catch (rollbackError) {
        throw new PromotionStateUncertainError(
          `promotion failed and approved predecessor rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
      throw error;
    }
  }

  private isExactPatchApplied(canonicalRoot: string, expectedSubjectHash: string): boolean {
    try {
      const currentPatch = this.git.workingTreeDiffAgainstHead(canonicalRoot);
      return createHash("sha256").update(currentPatch).digest("hex") === expectedSubjectHash;
    } catch {
      return false;
    }
  }

  private cleanupStaleLeadWorktrees(): void {
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true }).slice(0, 500)) {
      if (!entry.isDirectory() || !entry.name.startsWith("lead-")) continue;
      const target = path.join(this.root, entry.name);
      try {
        // Never trust the stale checkout's `.git` pointer to select a repository
        // for mutation. Remove only the app-owned directory; the next operation
        // against an authoritative canonical project prunes its stale metadata.
        const stat = fs.lstatSync(target);
        if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(target, { recursive: true, force: true });
      } catch { /* bounded app-owned cleanup is best effort */ }
    }
  }

  private assertWorktreeRepository(worktree: string, canonicalRoot: string): void {
    const actual = fs.realpathSync.native(this.git.commonGitDirectory(worktree));
    const expected = fs.realpathSync.native(this.git.commonGitDirectory(canonicalRoot));
    if (actual !== expected) throw new WorktreePolicyError("managed worktree Git metadata no longer belongs to the canonical repository");
  }

  private cleanupRaw(canonicalRoot: string, worktreePath: string, branch: string): void {
    try { this.managedPaths.delete(fs.realpathSync.native(worktreePath)); } catch { this.managedPaths.delete(path.resolve(worktreePath)); }
    try { this.git.removeWorktree(canonicalRoot, worktreePath); } catch { /* recovery prune follows */ }
    try { this.git.pruneWorktrees(canonicalRoot); } catch { /* best effort */ }
    if (branch) {
      try { this.git.deleteManagedBranch(canonicalRoot, branch); } catch { /* branch may not exist */ }
    }
    try {
      const resolved = path.resolve(worktreePath);
      if (resolved.startsWith(path.resolve(this.root) + path.sep)) fs.rmSync(resolved, { recursive: true, force: true });
    } catch { /* evidence is already durable; startup recovery may retry */ }
  }
}

function rejectUnsafeGitModes(raw: Buffer): void {
  const text = raw.toString("utf8");
  // A patch that creates a symlink or gitlink can redirect a later process outside
  // the approved root. Existing unchanged links never appear in this diff.
  if (/:(?:\d{6}) (?:120000|160000) /.test(text)) {
    throw new WorktreePolicyError("changes to symlinks or submodules require manual handling and cannot be promoted");
  }
}
