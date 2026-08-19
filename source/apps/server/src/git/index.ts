export { GitService } from "./GitService";
export { GitBusyError } from "./GitService";
export { GitExecutionError, GitSecurityError, GitTimeoutError } from "./HardenedGitExecutor";
export type {
  GitFileStatus,
  GitHubRemoteAdmin,
  GitHubRemoteStatus,
  GitLocalBranch,
  GitReadService,
  GitRecentCommit,
  GitRepositorySummary,
  GitRepositorySnapshot,
  GitSnapshotFile,
  GitStatus,
  GitTextDiff,
} from "./types";

import path from "node:path";
import { GitService } from "./GitService";

/** Production factory. `dataDir` is the app's private data directory, never a
 * project checkout. The service creates its empty HOME/hooks/temp beneath it. */
export function createGitService(dataDir: string): GitService {
  return new GitService(path.join(dataDir, "runtime", "git"));
}
