import { execFile, type ExecFileException } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const OUTPUT_LIMIT = 256 * 1024;
const TIMEOUT_MS = 8_000;

export interface GitHubAccountStatus {
  installed: boolean;
  authenticated: boolean;
  host: "github.com";
  executable?: string;
  version?: string;
  login?: string;
  gitProtocol?: "https" | "ssh";
  tokenSource?: string;
  scopes?: string[];
  error?: string;
}

export interface GitHubRepositoryInfo {
  nameWithOwner: string;
  url: string;
  defaultBranch: string | null;
  isPrivate: boolean;
  viewerPermission: string;
}

type GitHubRunner = (args: readonly string[]) => Promise<string>;

/**
 * Narrow GitHub CLI adapter. It never accepts arbitrary commands, repository
 * paths or environment overrides; account credentials remain in gh's keyring.
 */
export class GitHubService {
  private readonly executable?: string;
  private readonly runner?: GitHubRunner;
  private statusInFlight?: Promise<GitHubAccountStatus>;
  private statusCache?: { value: GitHubAccountStatus; expiresAt: number };

  constructor(options: { executable?: string; runner?: GitHubRunner } = {}) {
    this.executable = options.executable ?? findGitHubCli();
    this.runner = options.runner;
  }

  async status(): Promise<GitHubAccountStatus> {
    const now = Date.now();
    if (this.statusCache && this.statusCache.expiresAt >= now) return this.statusCache.value;
    if (this.statusInFlight) return this.statusInFlight;
    this.statusInFlight = this.loadStatus();
    try {
      const value = await this.statusInFlight;
      // Coalesce renderer refresh bursts without making account switches feel
      // stale. Admin repository verification remains separately capability-gated.
      this.statusCache = { value, expiresAt: Date.now() + 1_000 };
      return value;
    } finally {
      this.statusInFlight = undefined;
    }
  }

  private async loadStatus(): Promise<GitHubAccountStatus> {
    if (!this.executable && !this.runner) {
      return {
        installed: false,
        authenticated: false,
        host: "github.com",
        error: "GitHub CLI (gh) was not found on the desktop PATH",
      };
    }
    try {
      const [versionText, authText] = await Promise.all([
        this.run(["--version"]),
        this.run(["auth", "status", "--active", "--hostname", "github.com", "--json", "hosts"]),
      ]);
      const record = parseActiveAccount(authText);
      return {
        installed: true,
        authenticated: Boolean(record && record.state === "success" && record.active),
        host: "github.com",
        ...(this.executable ? { executable: this.executable } : {}),
        version: versionText.split(/\r?\n/, 1)[0]?.replace(/^gh version\s+/, "").trim(),
        ...(record?.login ? { login: record.login } : {}),
        ...(record?.gitProtocol === "https" || record?.gitProtocol === "ssh"
          ? { gitProtocol: record.gitProtocol }
          : {}),
        ...(record?.tokenSource ? { tokenSource: record.tokenSource } : {}),
        ...(record?.scopes ? { scopes: record.scopes.split(",").map((scope) => scope.trim()).filter(Boolean) } : {}),
      };
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        host: "github.com",
        ...(this.executable ? { executable: this.executable } : {}),
        error: error instanceof Error ? error.message : "GitHub authentication could not be verified",
      };
    }
  }

  async verifyRepository(repository: string): Promise<GitHubRepositoryInfo> {
    assertGitHubRepository(repository);
    const account = await this.status();
    if (!account.authenticated) {
      throw new Error("GitHub CLI is not authenticated; connect an account first");
    }
    const output = await this.run([
      "repo", "view", repository, "--json",
      "nameWithOwner,url,defaultBranchRef,isPrivate,viewerPermission",
    ]);
    const parsed = JSON.parse(output) as {
      nameWithOwner?: unknown;
      url?: unknown;
      defaultBranchRef?: { name?: unknown } | null;
      isPrivate?: unknown;
      viewerPermission?: unknown;
    };
    if (
      typeof parsed.nameWithOwner !== "string" ||
      typeof parsed.url !== "string" ||
      !parsed.url.startsWith("https://github.com/") ||
      typeof parsed.isPrivate !== "boolean" ||
      typeof parsed.viewerPermission !== "string"
    ) {
      throw new Error("GitHub returned an invalid repository description");
    }
    return {
      nameWithOwner: parsed.nameWithOwner,
      url: parsed.url,
      defaultBranch:
        parsed.defaultBranchRef && typeof parsed.defaultBranchRef.name === "string"
          ? parsed.defaultBranchRef.name
          : null,
      isPrivate: parsed.isPrivate,
      viewerPermission: parsed.viewerPermission,
    };
  }

  private async run(args: readonly string[]): Promise<string> {
    if (this.runner) return this.runner(args);
    if (!this.executable) throw new Error("GitHub CLI is not installed");
    const executable = this.executable;
    return new Promise<string>((resolve, reject) => {
      execFile(
        executable,
        [...args],
        {
          cwd: os.tmpdir(),
          env: githubCliEnvironment(),
          encoding: "utf8",
          timeout: TIMEOUT_MS,
          maxBuffer: OUTPUT_LIMIT,
          windowsHide: true,
        },
        (error: ExecFileException | null, stdout: string) => {
          if (error) {
            reject(new Error(`GitHub CLI ${args[0] ?? "request"} failed`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

export function assertGitHubRepository(repository: string): void {
  if (
    !GITHUB_REPOSITORY.test(repository) ||
    repository.includes("..") ||
    repository.split("/").some((segment) => segment.startsWith(".") || segment.endsWith("."))
  ) {
    throw new Error("repository must be an owner/name slug on github.com");
  }
}

function findGitHubCli(): string | undefined {
  const names = process.platform === "win32" ? ["gh.exe", "gh"] : ["gh"];
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  for (const directory of [...new Set(directories.filter((entry) => path.isAbsolute(entry)))]) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        const real = fs.realpathSync.native(candidate);
        const stat = fs.statSync(real);
        fs.accessSync(real, fs.constants.X_OK);
        if (stat.isFile()) return real;
      } catch {
        // Try the next fixed candidate.
      }
    }
  }
  return undefined;
}

function githubCliEnvironment(): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
  };
  return Object.fromEntries(Object.entries(selected).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function parseActiveAccount(output: string): {
  state?: string;
  active?: boolean;
  login?: string;
  tokenSource?: string;
  scopes?: string;
  gitProtocol?: string;
} | undefined {
  const parsed = JSON.parse(output) as { hosts?: Record<string, unknown> };
  const accounts = parsed.hosts?.["github.com"];
  if (!Array.isArray(accounts)) return undefined;
  return accounts.find((account) => account && typeof account === "object" && (account as { active?: unknown }).active === true) as ReturnType<typeof parseActiveAccount>;
}
