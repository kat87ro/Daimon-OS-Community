import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { McpServer, ProviderKind } from "@daimon-os/shared";

export interface ScanResult {
  skills: Array<{
    name: string;
    path: string;
    description: string;
    /** personal = ~/.claude/skills (pulled by one-click sync); plugin =
     *  discovered from an installed plugin (selective import only) */
    source: "personal" | "plugin";
    plugin?: string;
  }>;
  agents: Array<{ name: string; path: string; description: string }>;
  mcpServers: Array<Omit<McpServer, "id" | "isDefault" | "enabled">>;
  /** claude.ai account connectors (Gmail, Higgsfield, …). Account-side OAuth,
   *  NOT local servers — names only, informational; the CLI gets them
   *  automatically from your logged-in account, nothing to import. */
  connectors: string[];
}

const empty = (): ScanResult => ({ skills: [], agents: [], mcpServers: [], connectors: [] });
const MAX_SCAN_ENTRIES = 256;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_MARKDOWN_BYTES = 256 * 1024;

interface ScanBudget { entries: number; bytes: number }
const newBudget = (): ScanBudget => ({ entries: MAX_SCAN_ENTRIES, bytes: MAX_SCAN_BYTES });

/**
 * Discover existing global config in the provider's standard CLI home —
 * claude: ~/.claude/skills, ~/.claude/agents, ~/.claude.json mcpServers
 * codex:  ~/.codex/config.toml [mcp_servers.*]
 * gemini: ~/.gemini/settings.json mcpServers
 * Read-only; the user picks what to import via /api/import/apply.
 */
export function scanProviderHome(kind: ProviderKind, home = os.homedir()): ScanResult {
  const budget = newBudget();
  switch (kind) {
    case "claude":
      return {
        skills: [
          ...scanSkillDirs(path.join(home, ".claude", "skills"), budget),
          ...scanPluginSkills(path.join(home, ".claude", "plugins"), budget),
        ],
        agents: scanMarkdownDir(path.join(home, ".claude", "agents"), budget),
        mcpServers: scanMcpJson(path.join(home, ".claude.json"), budget),
        connectors: scanClaudeConnectors(path.join(home, ".claude.json"), budget),
      };
    case "codex":
      return { ...empty(), mcpServers: scanCodexToml(path.join(home, ".codex", "config.toml"), budget) };
    case "gemini":
      return { ...empty(), mcpServers: scanMcpJson(path.join(home, ".gemini", "settings.json"), budget) };
    default:
      return empty();
  }
}

function scanSkillDirs(dir: string, budget: ScanBudget): ScanResult["skills"] {
  const out: ScanResult["skills"] = [];
  for (const entry of listDirectory(dir, budget)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillFile = path.join(dir, entry.name, "SKILL.md");
    const content = readRegularFile(skillFile, MAX_MARKDOWN_BYTES, budget);
    if (content === undefined) continue;
    out.push({
      name: entry.name,
      path: skillFile,
      description: extractDescription(content),
      source: "personal",
    });
  }
  return out;
}

/**
 * Discover skills bundled with USER-SCOPE installed plugins
 * (`<plugins>/installed_plugins.json` → each install's `<installPath>/skills/*`).
 * Project-scope installs are ignored — only globally-available skills are
 * surfaced. Names are namespaced `<plugin>:<skill>` to stay unique across
 * plugins. These are SELECTIVE-only (the wizard); the one-click sync skips them.
 */
function scanPluginSkills(pluginsDir: string, budget: ScanBudget): ScanResult["skills"] {
  const manifest = path.join(pluginsDir, "installed_plugins.json");
  let parsed: { plugins?: Record<string, Array<{ scope?: string; installPath?: string }>> };
  try {
    const raw = readRegularFile(manifest, MAX_CONFIG_BYTES, budget);
    if (raw === undefined) return [];
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const out: ScanResult["skills"] = [];
  const seenPaths = new Set<string>();
  for (const [fullName, installs] of Object.entries(parsed.plugins ?? {})) {
    const short = fullName.split("@")[0] || fullName;
    for (const inst of installs) {
      if (inst.scope !== "user" || !inst.installPath) continue;
      if (seenPaths.has(inst.installPath)) continue;
      seenPaths.add(inst.installPath);
      if (!realPathInside(pluginsDir, inst.installPath)) continue;
      const skillsDir = path.join(inst.installPath, "skills");
      for (const e of listDirectory(skillsDir, budget)) {
        if (!e.isDirectory() || e.isSymbolicLink()) continue;
        const skillFile = path.join(skillsDir, e.name, "SKILL.md");
        const content = readRegularFile(skillFile, MAX_MARKDOWN_BYTES, budget);
        if (content === undefined) continue;
        out.push({
          name: `${short}:${e.name}`,
          path: skillFile,
          description: extractDescription(content),
          source: "plugin",
          plugin: short,
        });
      }
    }
  }
  return out;
}

function scanMarkdownDir(dir: string, budget: ScanBudget): ScanResult["agents"] {
  const out: ScanResult["agents"] = [];
  for (const entry of listDirectory(dir, budget)) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md")) continue;
    const file = path.join(dir, entry.name);
    const content = readRegularFile(file, MAX_MARKDOWN_BYTES, budget);
    if (content === undefined) continue;
    out.push({
      name: entry.name.replace(/\.md$/, ""),
      path: file,
      description: extractDescription(content),
    });
  }
  return out;
}

function scanMcpJson(file: string, budget: ScanBudget): ScanResult["mcpServers"] {
  try {
    const raw = readRegularFile(file, MAX_CONFIG_BYTES, budget);
    if (raw === undefined) return [];
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string>; type?: string }>;
    };
    return Object.entries(parsed.mcpServers ?? {}).slice(0, MAX_SCAN_ENTRIES).map(([name, cfg]) => ({
      name,
      transport: cfg.url ? ("http" as const) : ("stdio" as const),
      command: cfg.command,
      args: cfg.args,
      url: cfg.url,
      // Never serialize provider-home credentials to the renderer. Importing a
      // credential requires a separate native-confirmed Vault operation.
      env: undefined,
    }));
  } catch {
    return [];
  }
}

/** claude.ai account connectors that have been signed in to — names only.
 *  These are remote OAuth connectors managed by the Claude account, available
 *  to the CLI automatically; there is no local config to import. */
function scanClaudeConnectors(file: string, budget: ScanBudget): string[] {
  try {
    const raw = readRegularFile(file, MAX_CONFIG_BYTES, budget);
    if (raw === undefined) return [];
    const parsed = JSON.parse(raw) as {
      claudeAiMcpEverConnected?: string[];
    };
    return (parsed.claudeAiMcpEverConnected ?? []).slice(0, MAX_SCAN_ENTRIES).map((n) =>
      n.replace(/^claude\.ai\s+/i, ""),
    );
  } catch {
    return [];
  }
}

/** light TOML walk for [mcp_servers.NAME] blocks — no toml dep needed */
function scanCodexToml(file: string, budget: ScanBudget): ScanResult["mcpServers"] {
  const rawFile = readRegularFile(file, MAX_CONFIG_BYTES, budget);
  if (rawFile === undefined) return [];
  const out: ScanResult["mcpServers"] = [];
  let current: { name: string; command?: string; args?: string[]; url?: string } | null = null;
  for (const raw of rawFile.split("\n")) {
    if (out.length >= MAX_SCAN_ENTRIES) break;
    const line = raw.trim();
    const header = line.match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (header) {
      if (current) out.push(toEntry(current));
      current = { name: header[1]!.replace(/"/g, "") };
      continue;
    }
    if (line.startsWith("[") && current) {
      out.push(toEntry(current));
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^(\w+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === "command") current.command = stripQuotes(value!);
    if (key === "url") current.url = stripQuotes(value!);
    if (key === "args") {
      current.args = [...value!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    }
  }
  if (current) out.push(toEntry(current));
  return out;

  function toEntry(c: { name: string; command?: string; args?: string[]; url?: string }) {
    return {
      name: c.name,
      transport: c.url ? ("http" as const) : ("stdio" as const),
      command: c.command,
      args: c.args,
      url: c.url,
      env: undefined,
    };
  }
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^"|"$|^'|'$/g, "");
}

function extractDescription(md: string): string {
  // frontmatter `description:` wins; else first non-heading prose line
  const fm = md.match(/^description:\s*(.+)$/m);
  if (fm) return fm[1]!.trim().slice(0, 160);
  const line = md
    .split("\n")
    .find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"));
  return (line ?? "").trim().slice(0, 160);
}

/** read a scanned file's content for import (path must come from a scan) */
export function readImportFile(filePath: string): string {
  const resolved = fs.realpathSync.native(path.resolve(filePath));
  const home = os.homedir();
  // only allow reads under the known CLI homes — this endpoint must not be a
  // generic file-read primitive
  const allowed = [".claude", ".codex", ".gemini"].some((d) =>
    realPathInside(path.join(home, d), resolved),
  );
  if (!allowed) throw new Error("path outside the allowed CLI config homes");
  const content = readRegularFile(resolved, MAX_MARKDOWN_BYTES, newBudget());
  if (content === undefined) throw new Error("import file is not a bounded regular file");
  return content;
}

function listDirectory(dir: string, budget: ScanBudget): fs.Dirent[] {
  if (budget.entries <= 0) return [];
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    const handle = fs.opendirSync(dir);
    const out: fs.Dirent[] = [];
    try {
      while (budget.entries > 0) {
        const entry = handle.readSync();
        if (!entry) break;
        budget.entries -= 1;
        out.push(entry);
      }
    } finally {
      handle.closeSync();
    }
    return out;
  } catch {
    return [];
  }
}

function readRegularFile(file: string, maxBytes: number, budget: ScanBudget): string | undefined {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes || stat.size > budget.bytes) return undefined;
    budget.bytes -= stat.size;
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function realPathInside(root: string, candidate: string): boolean {
  try {
    const realRoot = fs.realpathSync.native(root);
    const realCandidate = fs.realpathSync.native(candidate);
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}
