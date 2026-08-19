import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer, ProviderKind, SpawnRequest } from "@daimon-os/shared";
import { materializeMcpConfig } from "./mcpMaterialize";
import {
  ensureManagedDirectory,
  managedPathExists,
  removeManagedPath,
  writeManagedFileAtomic,
} from "../security/runtimeFiles";

/** Server-internal spawn extension. It is deliberately absent from the public
 * WebSocket schema, so a renderer or scoped agent cannot nominate a config. */
export type TrustedMcpSpawnRequest = SpawnRequest & {
  trustedMcpServers?: McpServer[];
};

export interface TrustedMcpRuntime {
  /** Provider-native app-owned config, useful for argv-based adapters/diagnostics. */
  readonly configPath: string;
  /** Non-secret selector variables. Scoped credentials remain inside configPath. */
  readonly env: Readonly<Record<string, string>>;
  readonly serverNames: readonly string[];
}

export interface TrustedMcpRuntimeOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Local inference must not inherit/link a paid-provider credential. */
  linkProviderCredentials?: boolean;
}

/**
 * Render only app-selected MCP definitions into a private per-run directory.
 * Repository-authored `.mcp.json` is never read or merged into this file.
 */
export function createTrustedClaudeMcpConfig(
  runtimeRoot: string,
  channel: string,
  servers: McpServer[],
): string {
  return createTrustedMcpRuntime(runtimeRoot, channel, servers, "claude").configPath;
}

/**
 * Build a provider-native, per-run MCP home from app-selected definitions only.
 * Codex/Gemini still need their existing subscription credential, so the 0700
 * runtime home contains a link to the provider's credential file. The secret is
 * never copied into argv/environment or merged with repository configuration.
 */
export function createTrustedMcpRuntime(
  runtimeRoot: string,
  channel: string,
  servers: McpServer[],
  providerKind: ProviderKind,
  options: TrustedMcpRuntimeOptions = {},
): TrustedMcpRuntime {
  if (!/^[0-9a-f-]{36}$/i.test(channel)) throw new Error("invalid MCP runtime channel");
  if (providerKind !== "claude" && providerKind !== "codex" && providerKind !== "gemini") {
    throw new Error(`provider kind "${providerKind}" has no trusted MCP runtime adapter`);
  }
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  // Channel ids are unique, but fail closed against stale/planted content rather
  // than allowing the merge helper to preserve an unknown server definition.
  if (managedPathExists(runtimeRoot, channel)) removeManagedPath(runtimeRoot, channel);
  const sessionDir = ensureManagedDirectory(runtimeRoot, channel);
  try {
    const environment = options.environment ?? process.env;
    const homeDir = options.homeDir ?? os.homedir();
    let env: Record<string, string> = {};

    if (providerKind === "claude") {
      // An explicit empty strict config is security-significant: without it,
      // Claude would fall back to repository/user MCP discovery.
      writeManagedFileAtomic(
        sessionDir,
        ".mcp.json",
        JSON.stringify({ mcpServers: {} }, null, 2) + "\n",
      );
    } else if (providerKind === "codex") {
      if (!options.cwd) throw new Error("Codex trusted MCP launch requires an authoritative cwd");
      const realCwd = fs.realpathSync.native(options.cwd);
      writeManagedFileAtomic(
        sessionDir,
        ".codex/config.toml",
        `[projects.${JSON.stringify(realCwd)}]\ntrust_level = "untrusted"\n`,
      );
      if (options.linkProviderCredentials !== false) {
        const sourceHome = environment.CODEX_HOME?.trim() || path.join(homeDir, ".codex");
        linkOptionalCredential(sourceHome, "auth.json", sessionDir, ".codex/auth.json");
      }
      env = { CODEX_HOME: path.join(sessionDir, ".codex") };
    } else if (providerKind === "gemini") {
      const sourceHome = environment.GEMINI_CLI_HOME?.trim() || homeDir;
      const sourceGeminiDir = path.join(sourceHome, ".gemini");
      const selectedType = readGeminiAuthType(path.join(sourceGeminiDir, "settings.json"));
      writeManagedFileAtomic(
        sessionDir,
        ".gemini/settings.json",
        JSON.stringify({
          security: {
            auth: selectedType ? { selectedType } : {},
            // With no trustedFolders.json in this private home, repository
            // .gemini/settings.json (hooks/MCP) is excluded from the merge.
            folderTrust: { enabled: true },
            disableYoloMode: true,
            disableAlwaysAllow: true,
          },
          advanced: { ignoreLocalEnv: true },
        }, null, 2) + "\n",
      );
      linkOptionalCredential(sourceGeminiDir, "oauth_creds.json", sessionDir, ".gemini/oauth_creds.json");
      linkOptionalCredential(sourceGeminiDir, "google_accounts.json", sessionDir, ".gemini/google_accounts.json");
      const defaultSystemDir = process.platform === "darwin"
        ? "/Library/Application Support/GeminiCli"
        : process.platform === "win32"
          ? "C:\\ProgramData\\gemini-cli"
          : "/etc/gemini-cli";
      const systemSettingsPath = environment.GEMINI_CLI_SYSTEM_SETTINGS_PATH?.trim() ||
        path.join(defaultSystemDir, "settings.json");
      env = {
        GEMINI_CLI_HOME: sessionDir,
        // Never let an agent definition turn the repository back into a trusted
        // settings source. The Gemini CLI checks for the exact string "true".
        GEMINI_CLI_TRUST_WORKSPACE: "false",
        GEMINI_CLI_TRUSTED_FOLDERS_PATH: path.join(sessionDir, ".gemini", "trustedFolders.json"),
        // Preserve genuine administrator policy paths while preventing an agent
        // env override from nominating repository-controlled settings as System.
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH:
          environment.GEMINI_CLI_SYSTEM_DEFAULTS_PATH?.trim() ||
          path.join(path.dirname(systemSettingsPath), "system-defaults.json"),
      };
    }

    const { added } = materializeMcpConfig(sessionDir, servers, providerKind);
    if (added.length !== servers.length) throw new Error("trusted MCP config was not rendered exactly");
    if (providerKind === "gemini") {
      markGeminiServersTrusted(
        path.join(sessionDir, ".gemini", "settings.json"),
        servers.map((server) => server.name),
        sessionDir,
      );
    }
    const configPath = providerKind === "claude"
      ? path.join(sessionDir, ".mcp.json")
      : providerKind === "codex"
        ? path.join(sessionDir, ".codex", "config.toml")
        : path.join(sessionDir, ".gemini", "settings.json");
    return { configPath, env, serverNames: servers.map((server) => server.name) };
  } catch (error) {
    removeManagedPath(runtimeRoot, channel);
    throw error;
  }
}

function markGeminiServersTrusted(
  settingsPath: string,
  serverNames: readonly string[],
  runtimeDir: string,
): void {
  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  for (const name of serverNames) {
    const entry = parsed.mcpServers?.[name];
    if (!entry) throw new Error(`Gemini trusted MCP server "${name}" was not rendered`);
    entry.trust = true;
  }
  writeManagedFileAtomic(
    runtimeDir,
    ".gemini/settings.json",
    JSON.stringify(parsed, null, 2) + "\n",
  );
}

function linkOptionalCredential(
  sourceDir: string,
  fileName: string,
  runtimeDir: string,
  runtimeRelative: string,
): void {
  const source = path.join(sourceDir, fileName);
  if (!fs.existsSync(source)) return;
  const realSource = fs.realpathSync.native(source);
  if (!fs.statSync(realSource).isFile()) throw new Error(`${fileName} is not a regular credential file`);
  const parts = runtimeRelative.split("/");
  const target = path.join(runtimeDir, ...parts);
  ensureManagedDirectory(runtimeDir, parts.slice(0, -1).join("/"));
  fs.symlinkSync(realSource, target, "file");
}

function readGeminiAuthType(settingsPath: string): string | undefined {
  if (!fs.existsSync(settingsPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      security?: { auth?: { selectedType?: unknown } };
    };
    return typeof parsed.security?.auth?.selectedType === "string"
      ? parsed.security.auth.selectedType
      : undefined;
  } catch {
    throw new Error("Gemini user settings are malformed; cannot preserve subscription authentication safely");
  }
}

export function removeTrustedMcpConfig(runtimeRoot: string, channel: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(channel)) return;
  removeManagedPath(runtimeRoot, channel);
}
