import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const GIT_TIMEOUT_MS = 30_000;
export const GIT_READ_MAX_BYTES = 1024 * 1024;
export const GIT_EVIDENCE_MAX_BYTES = 32 * 1024 * 1024;

type OutputProfile = "read" | "evidence";

export class GitSecurityError extends Error {}

export class GitExecutionError extends Error {
  constructor(message: string, readonly partialOutput?: Buffer) {
    super(message);
  }
}

export class GitTimeoutError extends GitExecutionError {}

/**
 * The only process-execution boundary for Git.
 *
 * It never invokes a shell, never inherits the gateway's credential-rich
 * environment, and audits repository-local command-bearing config before each
 * operational command. Callers cannot supply environment variables or Git
 * configuration overrides.
 */
export class HardenedGitExecutor {
  private readonly root: string;
  private readonly home: string;
  private readonly hooks: string;
  private readonly temp: string;
  private readonly globalConfig: string;

  constructor(runtimeRoot: string) {
    const lexicalRoot = path.resolve(runtimeRoot);
    fs.mkdirSync(lexicalRoot, { recursive: true, mode: 0o700 });
    const lexicalStat = fs.lstatSync(lexicalRoot);
    if (lexicalStat.isSymbolicLink() || !lexicalStat.isDirectory()) {
      throw new GitSecurityError("Git runtime root is unsafe");
    }
    // macOS commonly aliases /var to /private/var. Canonicalize that trusted
    // parent alias once, while still rejecting a symlink at the runtime leaf.
    this.root = fs.realpathSync.native(lexicalRoot);
    this.home = path.join(this.root, "home");
    this.hooks = path.join(this.root, "hooks-empty");
    this.temp = path.join(this.root, "tmp");
    this.globalConfig = path.join(this.root, "global.gitconfig");
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.hooks, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.temp, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.globalConfig)) fs.writeFileSync(this.globalConfig, "", { mode: 0o600 });
    this.assertRuntimeSafe();
  }

  runText(cwd: string, args: readonly string[], profile: OutputProfile = "read"): string {
    return this.run(cwd, args, profile).toString("utf8");
  }

  run(cwd: string, args: readonly string[], profile: OutputProfile = "read"): Buffer {
    this.assertRepositoryConfigSafe(cwd);
    return this.execute(cwd, args, profile);
  }

  async runTextAsync(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.runAsync(cwd, args, "read", signal)).toString("utf8");
  }

  /** Route-safe read execution. This is intentionally separate from the
   * synchronous evidence/worktree methods used by internal terminalization. */
  async runAsync(
    cwd: string,
    args: readonly string[],
    profile: OutputProfile = "read",
    signal?: AbortSignal,
  ): Promise<Buffer> {
    await this.assertRepositoryConfigSafeAsync(cwd, signal);
    return this.executeAsync(cwd, args, profile, signal);
  }

  canonicalPathAsync(input: string, signal?: AbortSignal): Promise<string> {
    return withAbort(fs.promises.realpath(input), signal);
  }

  runWithInput(cwd: string, args: readonly string[], input: Buffer): Buffer {
    this.assertRepositoryConfigSafe(cwd);
    if (input.byteLength > GIT_EVIDENCE_MAX_BYTES) {
      throw new GitExecutionError("Git input exceeds the evidence size limit");
    }
    return this.execute(cwd, args, "evidence", input);
  }

  /** A promotion comparison needs an alternate index. Keep that capability
   * encapsulated so arbitrary callers cannot inject Git environment variables. */
  withTemporaryIndex<T>(fn: (indexFile: string) => T): T {
    this.assertRuntimeSafe();
    const directory = fs.mkdtempSync(path.join(this.temp, "index-"));
    try {
      return fn(path.join(directory, "index"));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  runWithIndex(cwd: string, args: readonly string[], indexFile: string): Buffer {
    this.assertRepositoryConfigSafe(cwd);
    const resolved = path.resolve(indexFile);
    const realTemp = fs.realpathSync.native(this.temp);
    const parent = fs.realpathSync.native(path.dirname(resolved));
    if (!parent.startsWith(realTemp + path.sep)) {
      throw new GitSecurityError("alternate Git index is outside the app-owned runtime");
    }
    return this.execute(cwd, args, "evidence", undefined, { GIT_INDEX_FILE: resolved });
  }

  private assertRepositoryConfigSafe(cwd: string): void {
    this.assertRuntimeSafe();
    const raw = this.execute(
      cwd,
      // Audit the complete effective config. Global is our empty file and system
      // config is disabled, so this covers repository + worktree config and any
      // includes reachable from them (not merely `.git/config`).
      ["config", "--includes", "--null", "--list"],
      "read",
      undefined,
      undefined,
      true,
    );
    assertConfigOutputSafe(raw);
  }

  private async assertRepositoryConfigSafeAsync(cwd: string, signal?: AbortSignal): Promise<void> {
    await this.assertRuntimeSafeAsync(signal);
    const raw = await this.executeAsync(
      cwd,
      ["config", "--includes", "--null", "--list"],
      "read",
      signal,
      true,
    );
    assertConfigOutputSafe(raw);
  }

  private execute(
    cwd: string,
    args: readonly string[],
    profile: OutputProfile,
    input?: Buffer,
    extraEnv?: Readonly<Record<string, string>>,
    configAudit = false,
  ): Buffer {
    const realCwd = fs.realpathSync.native(cwd);
    if (!fs.statSync(realCwd).isDirectory()) throw new GitExecutionError("Git working directory is not a directory");
    const maxBuffer = profile === "evidence" ? GIT_EVIDENCE_MAX_BYTES : GIT_READ_MAX_BYTES;
    const fixedConfig = this.fixedConfig(configAudit);
    try {
      return execFileSync("git", ["--no-pager", ...fixedConfig, ...args], {
        cwd: realCwd,
        env: this.environment(extraEnv),
        input,
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer,
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: Buffer; stderr?: Buffer };
      const partial = Buffer.isBuffer(failure.stdout) ? failure.stdout.subarray(0, maxBuffer) : undefined;
      const limited = failure.code === "ENOBUFS" || (failure.stderr?.toString("utf8") ?? "").includes("maxBuffer");
      if (limited) throw new GitExecutionError("Git output exceeds the configured size limit", partial);
      const command = args[0] ?? "operation";
      throw new GitExecutionError(`Git ${command} failed`);
    }
  }

  private async executeAsync(
    cwd: string,
    args: readonly string[],
    profile: OutputProfile,
    signal?: AbortSignal,
    configAudit = false,
  ): Promise<Buffer> {
    const realCwd = await withAbort(fs.promises.realpath(cwd), signal);
    if (!(await withAbort(fs.promises.stat(realCwd), signal)).isDirectory()) {
      throw new GitExecutionError("Git working directory is not a directory");
    }
    const maxBuffer = profile === "evidence" ? GIT_EVIDENCE_MAX_BYTES : GIT_READ_MAX_BYTES;
    const fixedConfig = this.fixedConfig(configAudit);
    return new Promise<Buffer>((resolve, reject) => {
      execFile(
        "git",
        ["--no-pager", ...fixedConfig, ...args],
        {
          cwd: realCwd,
          env: this.environment(),
          encoding: "buffer",
          timeout: GIT_TIMEOUT_MS,
          maxBuffer,
          signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const output = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
          const errorOutput = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");
          if (!error) {
            resolve(output);
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
          if (
            signal?.aborted ||
            failure.code === "ABORT_ERR" ||
            failure.code === "ETIMEDOUT" ||
            failure.killed
          ) {
            reject(new GitTimeoutError(`Git ${args[0] ?? "operation"} timed out`));
            return;
          }
          const stderrText = errorOutput.toString("utf8");
          const limited =
            failure.code === "ENOBUFS" ||
            failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
            stderrText.includes("maxBuffer");
          if (limited) {
            reject(new GitExecutionError("Git output exceeds the configured size limit", output.subarray(0, maxBuffer)));
            return;
          }
          reject(new GitExecutionError(`Git ${args[0] ?? "operation"} failed`));
        },
      );
    });
  }

  private fixedConfig(configAudit: boolean): string[] {
    return configAudit ? [] : [
      "-c", `core.hooksPath=${this.hooks}`,
      "-c", "core.fsmonitor=false",
      "-c", "core.pager=",
      "-c", "pager.status=false",
      "-c", "pager.diff=false",
      "-c", "pager.log=false",
      "-c", "interactive.diffFilter=",
      "-c", "credential.helper=",
      "-c", "credential.interactive=never",
      "-c", "core.askPass=/usr/bin/false",
      "-c", "core.editor=/usr/bin/false",
      "-c", "sequence.editor=/usr/bin/false",
      "-c", "gpg.program=/usr/bin/false",
      "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false",
      "-c", "log.showSignature=false",
      "-c", "core.sshCommand=/usr/bin/false",
      "-c", "protocol.ext.allow=never",
      "-c", "submodule.recurse=false",
      "-c", "fetch.recurseSubmodules=false",
      "-c", "color.ui=false",
    ];
  }

  private environment(extraEnv?: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin",
      HOME: this.home,
      XDG_CONFIG_HOME: this.home,
      TMPDIR: this.temp,
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_ATTR_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS: "/usr/bin/false",
      GIT_PAGER: "",
      PAGER: "",
      GIT_EDITOR: "/usr/bin/false",
      GIT_SEQUENCE_EDITOR: "/usr/bin/false",
      GIT_EXTERNAL_DIFF: "",
      GIT_LITERAL_PATHSPECS: "1",
      ...extraEnv,
    };
  }

  private assertRuntimeSafe(): void {
    const rootStat = fs.lstatSync(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || fs.realpathSync.native(this.root) !== this.root) {
      throw new GitSecurityError("Git runtime root is unsafe");
    }
    for (const directory of [this.home, this.hooks, this.temp]) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new GitSecurityError("Git runtime directory is unsafe");
    }
    const globalStat = fs.lstatSync(this.globalConfig);
    if (globalStat.isSymbolicLink() || !globalStat.isFile() || globalStat.size !== 0) {
      throw new GitSecurityError("Git runtime config is unsafe");
    }
    if (fs.readdirSync(this.hooks).length !== 0) throw new GitSecurityError("Git runtime hooks directory is not empty");
  }

  private async assertRuntimeSafeAsync(signal?: AbortSignal): Promise<void> {
    const rootStat = await withAbort(fs.promises.lstat(this.root), signal);
    if (
      rootStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      (await withAbort(fs.promises.realpath(this.root), signal)) !== this.root
    ) {
      throw new GitSecurityError("Git runtime root is unsafe");
    }
    for (const directory of [this.home, this.hooks, this.temp]) {
      const stat = await withAbort(fs.promises.lstat(directory), signal);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new GitSecurityError("Git runtime directory is unsafe");
      }
    }
    const globalStat = await withAbort(fs.promises.lstat(this.globalConfig), signal);
    if (globalStat.isSymbolicLink() || !globalStat.isFile() || globalStat.size !== 0) {
      throw new GitSecurityError("Git runtime config is unsafe");
    }
    if ((await withAbort(fs.promises.readdir(this.hooks), signal)).length !== 0) {
      throw new GitSecurityError("Git runtime hooks directory is not empty");
    }
  }
}

function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new GitTimeoutError("Git snapshot timed out"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new GitTimeoutError("Git snapshot timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function assertConfigOutputSafe(raw: Buffer): void {
  for (const record of raw.toString("utf8").split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\n");
    const key = (separator < 0 ? record : record.slice(0, separator)).toLowerCase();
    const value = separator < 0 ? "" : record.slice(separator + 1);
    if (isCommandBearingConfig(key, value)) {
      throw new GitSecurityError(
        `repository Git config '${key}' can execute or redirect commands; remove it before Daimon operates on this repository`,
      );
    }
  }
}

function isCommandBearingConfig(key: string, value: string): boolean {
  if (key.startsWith("alias.")) return value.trimStart().startsWith("!");
  return [
    /^core\.(askpass|attributesfile|editor|fsmonitor|gitproxy|hookspath|pager|sshcommand|worktree)$/,
    /^sequence\.editor$/,
    /^credential(?:\..+)?\.helper$/,
    /^diff\.external$/,
    /^diff\..+\.(command|textconv)$/,
    /^difftool\..+\.cmd$/,
    /^filter\..+\.(clean|smudge|process)$/,
    /^merge\..+\.driver$/,
    /^mergetool\..+\.cmd$/,
    /^gpg(?:\..+)?\.program$/,
    /^log\.showsignature$/,
    /^pager\..+$/,
    /^interactive\.difffilter$/,
    /^remote\..+\.(receivepack|uploadpack)$/,
    /^submodule\..+\.update$/,
    /^protocol\.ext\.allow$/,
    /^tar\..+\.command$/,
    /^browser\..+\.cmd$/,
    /^web\.browser$/,
    /^help\.browser$/,
    /^man\..+\.cmd$/,
  ].some((pattern) => pattern.test(key));
}
