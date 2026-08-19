export interface GitFileStatus {
  path: string;
  originalPath?: string;
  index: string;
  worktree: string;
  kind: "tracked" | "renamed" | "unmerged" | "untracked";
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitRepositorySummary {
  root: string;
  branch: string | null;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

export interface GitLocalBranch {
  name: string;
  head: string;
  current: boolean;
}

export interface GitRecentCommit {
  hash: string;
  shortHash: string;
  authoredAt: string;
  authorName: string;
  authorEmail: string;
  subject: string;
}

export interface GitTextDiff {
  text: string;
  truncated: boolean;
  byteLength: number;
}

export interface GitSnapshotFile {
  path: string;
  originalPath?: string;
  /** Porcelain-v2 XY status preserved as data, never parsed from colored text. */
  status: string;
  staged: boolean;
}

export interface GitRepositorySnapshot {
  repoRoot: string;
  currentBranch: string | null;
  detached: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  files: GitSnapshotFile[];
  branches: GitLocalBranch[];
  commits: GitRecentCommit[];
  diff: string;
  truncated: boolean;
}

export interface GitHubRemoteStatus {
  configured: boolean;
  name: "origin";
  url?: string;
  repository?: string;
  githubUrl?: string;
}

/** Narrow mutation surface used only by native-confirmed GitHub linking. */
export interface GitHubRemoteAdmin {
  githubRemote(cwd: string): GitHubRemoteStatus;
  githubRemoteAsync(cwd: string): Promise<GitHubRemoteStatus>;
  configureGitHubRemote(cwd: string, repository: string): GitHubRemoteStatus;
}

/** Read-only surface safe to expose to routes/UI. It deliberately has no raw
 * command, stage, commit, branch mutation, remote, push, or credential methods. */
export interface GitReadService {
  /** Async route-safe snapshot. Implementations must bound child lifetime,
   * output, and concurrent requests without blocking the Node.js event loop. */
  snapshotAsync(cwd: string, options?: { commitLimit?: number }): Promise<GitRepositorySnapshot>;
  snapshot(cwd: string, options?: { commitLimit?: number }): GitRepositorySnapshot;
  repositorySummary(cwd: string): GitRepositorySummary;
  status(cwd: string): GitStatus;
  currentBranch(cwd: string): string | null;
  localBranches(cwd: string): GitLocalBranch[];
  recentCommits(cwd: string, limit?: number): GitRecentCommit[];
  textDiff(cwd: string, options?: { staged?: boolean; contextLines?: number }): GitTextDiff;
}
