import fs from "node:fs";
import path from "node:path";
import {
  HardenedGitExecutor,
  GitExecutionError,
  GitSecurityError,
  GitTimeoutError,
  GIT_READ_MAX_BYTES,
} from "./HardenedGitExecutor";
import type {
  GitFileStatus,
  GitHubRemoteAdmin,
  GitHubRemoteStatus,
  GitLocalBranch,
  GitReadService,
  GitRecentCommit,
  GitRepositorySnapshot,
  GitRepositorySummary,
  GitStatus,
  GitTextDiff,
} from "./types";

const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/i;
const DEFAULT_ASYNC_SNAPSHOT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_ASYNC_SNAPSHOTS = 2;

export class GitBusyError extends GitExecutionError {}

export interface GitServiceOptions {
  asyncSnapshotTimeoutMs?: number;
  maxConcurrentAsyncSnapshots?: number;
}

export class GitService implements GitReadService, GitHubRemoteAdmin {
  private readonly executor: HardenedGitExecutor;
  private readonly asyncSnapshotTimeoutMs: number;
  private readonly maxConcurrentAsyncSnapshots: number;
  private activeAsyncSnapshots = 0;

  constructor(runtimeRoot: string, options: GitServiceOptions = {}) {
    this.executor = new HardenedGitExecutor(runtimeRoot);
    this.asyncSnapshotTimeoutMs = boundedInteger(
      options.asyncSnapshotTimeoutMs,
      DEFAULT_ASYNC_SNAPSHOT_TIMEOUT_MS,
      25,
      30_000,
    );
    this.maxConcurrentAsyncSnapshots = boundedInteger(
      options.maxConcurrentAsyncSnapshots,
      DEFAULT_MAX_CONCURRENT_ASYNC_SNAPSHOTS,
      1,
      8,
    );
  }

  async snapshotAsync(
    cwd: string,
    options: { commitLimit?: number } = {},
  ): Promise<GitRepositorySnapshot> {
    if (this.activeAsyncSnapshots >= this.maxConcurrentAsyncSnapshots) {
      throw new GitBusyError("Git snapshot capacity is busy; retry shortly");
    }
    this.activeAsyncSnapshots += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.asyncSnapshotTimeoutMs);
    timeout.unref();
    try {
      const status = parseStatus(await this.executor.runTextAsync(
        cwd,
        ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"],
        controller.signal,
      ));
      const repoRoot = await this.executor.canonicalPathAsync(
        (await this.executor.runTextAsync(
          cwd,
          ["rev-parse", "--show-toplevel"],
          controller.signal,
        )).trim(),
        controller.signal,
      );
      const diff = await this.textDiffAsync(cwd, controller.signal);
      const branches = parseBranches(await this.executor.runTextAsync(
        cwd,
        [
          "for-each-ref", "--count=500", "--sort=-committerdate",
          "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00", "refs/heads/",
        ],
        controller.signal,
      ));
      const limit = Math.max(1, Math.min(100, Math.trunc(options.commitLimit ?? 25)));
      const commits = parseCommits(await this.executor.runTextAsync(
        cwd,
        ["log", "--no-show-signature", `-n${limit}`, "--format=%H%x00%h%x00%at%x00%an%x00%ae%x00%s%x00"],
        controller.signal,
      ));
      return snapshotFrom(status, repoRoot, diff, branches, commits);
    } catch (error) {
      // The aggregate controller can expire between child processes (for example
      // during realpath resolution). Normalize that boundary to the route's typed
      // timeout even when no individual execFile callback produced the error.
      if (controller.signal.aborted && !(error instanceof GitTimeoutError)) {
        throw new GitTimeoutError("Git snapshot timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeAsyncSnapshots -= 1;
    }
  }

  snapshot(cwd: string, options: { commitLimit?: number } = {}): GitRepositorySnapshot {
    const status = this.status(cwd);
    const repoRoot = fs.realpathSync.native(this.repositoryRoot(cwd));
    const diff = this.textDiff(cwd);
    return snapshotFrom(status, repoRoot, diff, this.localBranches(cwd), this.recentCommits(cwd, options.commitLimit));
  }

  repositorySummary(cwd: string): GitRepositorySummary {
    const root = fs.realpathSync.native(this.repositoryRoot(cwd));
    const status = this.status(cwd);
    const head = this.resolveHead(cwd);
    return {
      root,
      branch: status.branch,
      head,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      dirty: status.files.length > 0,
      staged: status.files.filter((file) => ![".", " ", "?"].includes(file.index)).length,
      unstaged: status.files.filter((file) => ![".", " ", "?"].includes(file.worktree)).length,
      untracked: status.files.filter((file) => file.kind === "untracked").length,
      conflicted: status.files.filter((file) => file.kind === "unmerged").length,
    };
  }

  status(cwd: string): GitStatus {
    const raw = this.executor.runText(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
    return parseStatus(raw);
  }

  currentBranch(cwd: string): string | null {
    const status = this.status(cwd);
    return status.branch;
  }

  localBranches(cwd: string): GitLocalBranch[] {
    const raw = this.executor.runText(cwd, [
      "for-each-ref", "--count=500", "--sort=-committerdate",
      "--format=%(refname:short)%00%(objectname)%00%(HEAD)%00", "refs/heads/",
    ]);
    return parseBranches(raw);
  }

  recentCommits(cwd: string, limit = 25): GitRecentCommit[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const raw = this.executor.runText(cwd, [
      "log", "--no-show-signature", `-n${bounded}`, "--format=%H%x00%h%x00%at%x00%an%x00%ae%x00%s%x00",
    ]);
    return parseCommits(raw);
  }

  textDiff(cwd: string, options: { staged?: boolean; contextLines?: number } = {}): GitTextDiff {
    const context = Math.max(0, Math.min(20, Math.trunc(options.contextLines ?? 3)));
    const args = [
      "diff", "--no-ext-diff", "--no-textconv", `--unified=${context}`,
      ...(options.staged ? ["--cached"] : ["HEAD"]), "--", ".",
    ];
    try {
      const output = this.executor.run(cwd, args);
      return { text: output.toString("utf8"), truncated: false, byteLength: output.byteLength };
    } catch (error) {
      if (error instanceof GitExecutionError && error.partialOutput) {
        const partial = error.partialOutput.subarray(0, GIT_READ_MAX_BYTES);
        return { text: partial.toString("utf8"), truncated: true, byteLength: partial.byteLength };
      }
      throw error;
    }
  }

  githubRemote(cwd: string): GitHubRemoteStatus {
    const remotes = new Set(this.executor.runText(cwd, ["remote"]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    if (!remotes.has("origin")) return { configured: false, name: "origin" };
    const rawUrl = this.executor.runText(cwd, ["remote", "get-url", "--", "origin"]).trim();
    const parsed = parseGitHubRemote(rawUrl);
    return {
      configured: true,
      name: "origin",
      url: parsed?.canonicalUrl ?? "[non-GitHub origin configured]",
      ...(parsed ? { repository: parsed.repository, githubUrl: `https://github.com/${parsed.repository}` } : {}),
    };
  }

  async githubRemoteAsync(cwd: string): Promise<GitHubRemoteStatus> {
    if (this.activeAsyncSnapshots >= this.maxConcurrentAsyncSnapshots) {
      throw new GitBusyError("Git inspection capacity is busy; retry shortly");
    }
    this.activeAsyncSnapshots += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.asyncSnapshotTimeoutMs);
    timeout.unref();
    try {
      const remotes = new Set((await this.executor.runTextAsync(cwd, ["remote"], controller.signal))
        .split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
      if (!remotes.has("origin")) return { configured: false, name: "origin" };
      const rawUrl = (await this.executor.runTextAsync(
        cwd,
        ["remote", "get-url", "--", "origin"],
        controller.signal,
      )).trim();
      const parsed = parseGitHubRemote(rawUrl);
      return {
        configured: true,
        name: "origin",
        url: parsed?.canonicalUrl ?? "[non-GitHub origin configured]",
        ...(parsed ? { repository: parsed.repository, githubUrl: `https://github.com/${parsed.repository}` } : {}),
      };
    } finally {
      clearTimeout(timeout);
      this.activeAsyncSnapshots -= 1;
    }
  }

  configureGitHubRemote(cwd: string, repository: string): GitHubRemoteStatus {
    assertGitHubSlug(repository);
    this.assertOwnedRootRepository(cwd);
    const canonicalUrl = `https://github.com/${repository}.git`;
    const remotes = new Set(this.executor.runText(cwd, ["remote"]).split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
    this.executor.run(
      cwd,
      remotes.has("origin")
        ? ["remote", "set-url", "--", "origin", canonicalUrl]
        : ["remote", "add", "--", "origin", canonicalUrl],
    );
    return this.githubRemote(cwd);
  }

  private assertOwnedRootRepository(cwd: string): void {
    const realCwd = fs.realpathSync.native(cwd);
    const repositoryRoot = fs.realpathSync.native(this.repositoryRoot(cwd));
    if (realCwd !== repositoryRoot) {
      throw new GitSecurityError("GitHub origin can be configured only on the selected repository root");
    }
    const marker = path.join(realCwd, ".git");
    const markerStat = fs.lstatSync(marker);
    if (markerStat.isSymbolicLink() || !markerStat.isDirectory()) {
      throw new GitSecurityError("GitHub origin requires a repository-owned .git directory");
    }
    const markerRoot = fs.realpathSync.native(marker);
    const commonRoot = fs.realpathSync.native(this.commonGitDirectory(cwd));
    if (markerRoot !== commonRoot) {
      throw new GitSecurityError("Git repository metadata is outside the selected project root");
    }
    const config = path.join(markerRoot, "config");
    const configStat = fs.lstatSync(config);
    if (configStat.isSymbolicLink() || !configStat.isFile() || fs.realpathSync.native(config) !== config) {
      throw new GitSecurityError("Git repository config is not a repository-owned regular file");
    }
  }

  private async textDiffAsync(cwd: string, signal: AbortSignal): Promise<GitTextDiff> {
    try {
      const output = await this.executor.runAsync(
        cwd,
        ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "HEAD", "--", "."],
        "read",
        signal,
      );
      return { text: output.toString("utf8"), truncated: false, byteLength: output.byteLength };
    } catch (error) {
      if (error instanceof GitExecutionError && error.partialOutput) {
        const partial = error.partialOutput.subarray(0, GIT_READ_MAX_BYTES);
        return { text: partial.toString("utf8"), truncated: true, byteLength: partial.byteLength };
      }
      throw error;
    }
  }

  // ---- fixed internal operations used by durable worktree execution ----

  repositoryRoot(cwd: string): string {
    return this.executor.runText(cwd, ["rev-parse", "--show-toplevel"]).trim();
  }

  commonGitDirectory(cwd: string): string {
    return this.executor.runText(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  }

  resolveHead(cwd: string): string {
    const head = this.executor.runText(cwd, ["rev-parse", "--verify", "HEAD"]).trim();
    if (!GIT_OBJECT_ID.test(head)) throw new GitExecutionError("Git HEAD is not a supported object id");
    return head;
  }

  isDirty(cwd: string): boolean {
    return this.executor.run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).byteLength > 0;
  }

  addWorkerWorktree(cwd: string, worktreePath: string, branch: string, baseHead: string): void {
    assertObjectId(baseHead);
    assertManagedBranch(branch);
    this.executor.run(cwd, ["worktree", "add", "--no-checkout", "-b", branch, worktreePath, baseHead], "evidence");
  }

  addDetachedWorktree(cwd: string, worktreePath: string, baseHead: string): void {
    assertObjectId(baseHead);
    this.executor.run(cwd, ["worktree", "add", "--detach", worktreePath, baseHead], "evidence");
  }

  checkout(cwd: string, baseHead: string): void {
    assertObjectId(baseHead);
    this.executor.run(cwd, ["checkout", "--force", baseHead], "evidence");
  }

  stageAll(cwd: string): void {
    this.executor.run(cwd, ["add", "-A", "--", "."], "evidence");
  }

  rawStagedDiff(cwd: string, baseHead: string): Buffer {
    assertObjectId(baseHead);
    return this.executor.run(cwd, ["diff", "--cached", "--raw", "-z", "--no-ext-diff", "--no-textconv", baseHead], "evidence");
  }

  binaryStagedDiff(cwd: string, baseHead: string): Buffer {
    assertObjectId(baseHead);
    return this.executor.run(cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", baseHead], "evidence");
  }

  statusEvidence(cwd: string): Buffer {
    return this.executor.run(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], "evidence");
  }

  objectPathExists(cwd: string, baseHead: string, relative: string): boolean {
    assertObjectId(baseHead);
    assertRelativePath(relative);
    try {
      this.executor.run(cwd, ["cat-file", "-e", `${baseHead}:${relative}`]);
      return true;
    } catch (error) {
      if (error instanceof GitExecutionError) return false;
      throw error;
    }
  }

  restorePath(cwd: string, baseHead: string, relative: string): void {
    assertObjectId(baseHead);
    assertRelativePath(relative);
    this.executor.run(cwd, ["checkout", "--force", baseHead, "--", relative], "evidence");
  }

  checkPatch(cwd: string, patch: Buffer): void {
    this.executor.runWithInput(cwd, ["apply", "--check", "--binary", "--whitespace=error-all", "-"], patch);
  }

  applyPatch(cwd: string, patch: Buffer): void {
    this.executor.runWithInput(cwd, ["apply", "--binary", "--whitespace=error-all", "-"], patch);
  }

  checkReversePatch(cwd: string, patch: Buffer): void {
    this.executor.runWithInput(cwd, ["apply", "--reverse", "--check", "--binary", "--whitespace=error-all", "-"], patch);
  }

  reversePatch(cwd: string, patch: Buffer): void {
    this.executor.runWithInput(cwd, ["apply", "--reverse", "--binary", "--whitespace=error-all", "-"], patch);
  }

  workingTreeDiffAgainstHead(cwd: string): Buffer {
    return this.executor.withTemporaryIndex((indexFile) => {
      this.executor.runWithIndex(cwd, ["read-tree", "HEAD"], indexFile);
      this.executor.runWithIndex(cwd, ["add", "-A", "--", "."], indexFile);
      return this.executor.runWithIndex(cwd, [
        "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD",
      ], indexFile);
    });
  }

  removeWorktree(cwd: string, worktreePath: string): void {
    this.executor.run(cwd, ["worktree", "remove", "--force", worktreePath], "evidence");
  }

  pruneWorktrees(cwd: string): void {
    this.executor.run(cwd, ["worktree", "prune", "--expire", "now"], "evidence");
  }

  deleteManagedBranch(cwd: string, branch: string): void {
    assertManagedBranch(branch);
    this.executor.run(cwd, ["branch", "-D", "--", branch], "evidence");
  }
}

function assertGitHubSlug(repository: string): void {
  if (
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) ||
    repository.includes("..") ||
    repository.split("/").some((segment) => segment.startsWith(".") || segment.endsWith("."))
  ) {
    throw new GitExecutionError("invalid github.com repository slug");
  }
}

function parseGitHubRemote(raw: string): { repository: string; canonicalUrl: string } | undefined {
  const value = raw.trim();
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(value) ??
    /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(value) ??
    /^ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/i.exec(value);
  if (!match?.[1]) return undefined;
  const repository = match[1];
  return { repository, canonicalUrl: `https://github.com/${repository}.git` };
}

function snapshotFrom(
  status: GitStatus,
  repoRoot: string,
  diff: GitTextDiff,
  branches: GitLocalBranch[],
  commits: GitRecentCommit[],
): GitRepositorySnapshot {
  return {
    repoRoot,
    currentBranch: status.branch,
    detached: status.branch === null,
    dirty: status.files.length > 0,
    ahead: status.ahead,
    behind: status.behind,
    files: status.files.map((file) => ({
      path: file.path,
      ...(file.originalPath ? { originalPath: file.originalPath } : {}),
      status: `${file.index}${file.worktree}`,
      staged: file.index !== "." && file.index !== " " && file.index !== "?",
    })),
    branches,
    commits,
    diff: diff.text,
    truncated: diff.truncated,
  };
}

function parseBranches(raw: string): GitLocalBranch[] {
  const fields = raw.split("\0");
  const branches: GitLocalBranch[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const name = fields[index]!.replace(/^\n+/, "");
    const head = fields[index + 1]!;
    const marker = fields[index + 2]!;
    if (!name || !GIT_OBJECT_ID.test(head)) continue;
    branches.push({ name, head, current: marker.trim() === "*" });
  }
  return branches;
}

function parseCommits(raw: string): GitRecentCommit[] {
  const fields = raw.split("\0");
  const commits: GitRecentCommit[] = [];
  for (let index = 0; index + 5 < fields.length; index += 6) {
    const hash = fields[index]!.replace(/^\n+/, "");
    const seconds = Number(fields[index + 2]);
    if (!GIT_OBJECT_ID.test(hash) || !Number.isFinite(seconds)) continue;
    commits.push({
      hash,
      shortHash: fields[index + 1]!,
      authoredAt: new Date(seconds * 1000).toISOString(),
      authorName: fields[index + 3]!,
      authorEmail: fields[index + 4]!,
      subject: fields[index + 5]!,
    });
  }
  return commits;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function parseStatus(raw: string): GitStatus {
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];
  const records = raw.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    if (record.startsWith("# branch.head ")) branch = record.slice(14) === "(detached)" ? null : record.slice(14);
    else if (record.startsWith("# branch.oid ")) head = record.slice(13) === "(initial)" ? null : record.slice(13);
    else if (record.startsWith("# branch.upstream ")) upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (record.startsWith("? ")) {
      files.push({ path: record.slice(2), index: "?", worktree: "?", kind: "untracked" });
    } else if (/^[12u] /.test(record)) {
      const kindCode = record[0]!;
      const fieldsBeforePath = kindCode === "1" ? 8 : kindCode === "2" ? 9 : 10;
      const parts = record.split(" ");
      const pathValue = parts.slice(fieldsBeforePath).join(" ");
      const xy = parts[1] ?? "..";
      const file: GitFileStatus = {
        path: pathValue,
        index: xy[0] ?? ".",
        worktree: xy[1] ?? ".",
        kind: kindCode === "2" ? "renamed" : kindCode === "u" ? "unmerged" : "tracked",
      };
      if (kindCode === "2") file.originalPath = records[++index] ?? "";
      files.push(file);
    }
  }
  return { branch, head, upstream, ahead, behind, files };
}

function assertObjectId(value: string): void {
  if (!GIT_OBJECT_ID.test(value)) throw new GitExecutionError("unsupported Git object id");
}

function assertManagedBranch(value: string): void {
  if (!/^daimon\/run-[a-f0-9]{24}$/.test(value)) throw new GitExecutionError("unmanaged Git branch name");
}

function assertRelativePath(value: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]+/).some((part) => part === "..")) {
    throw new GitExecutionError("unsafe Git path");
  }
}
