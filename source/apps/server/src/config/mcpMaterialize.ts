import type { McpServer, ProviderKind } from "@daimon-os/shared";
import { readManagedText, writeManagedFileAtomic } from "../security/runtimeFiles";

interface McpJsonEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  httpUrl?: string;
}

/**
 * Write/merge the linked MCP servers into the config file the spawning CLI
 * actually reads, scoped to its project folder:
 *   claude              → <cwd>/.mcp.json
 *   gemini              → <cwd>/.gemini/settings.json   (mcpServers key)
 *   codex               → <cwd>/.codex/config.toml      ([mcp_servers.NAME])
 *   anything else/shell → <cwd>/.mcp.json               (de-facto standard)
 *
 * Each CLI gets ONLY the servers the caller already filtered for its kind
 * (see ConfigStore.mcpServersForSpawn), so a Claude pane never receives a
 * Gemini-specific server.
 *
 * Merge-only by default: user entries already present are NEVER overwritten and
 * an unparseable existing file is left untouched. Names in `overwriteNames` are
 * the exception — they are Daimon-managed entries (e.g. the Lead's "daimon-os"
 * server, whose env carries the live gateway port + project/team ids) that MUST
 * be rewritten fresh on every spawn, so they are replaced rather than skipped.
 *
 * Returns the names written this call (newly added OR overwritten).
 */
export function materializeMcpConfig(
  cwd: string,
  servers: McpServer[],
  providerKind?: ProviderKind,
  overwriteNames: ReadonlySet<string> = new Set(),
): { added: string[] } {
  if (servers.length === 0) return { added: [] };
  if (providerKind === "codex") return mergeCodexToml(cwd, servers, overwriteNames);
  if (providerKind === "gemini") {
    return mergeMcpJson(
      cwd,
      ".gemini/settings.json",
      servers,
      geminiEntry,
      overwriteNames,
    );
  }
  // claude + everything else read the project-scope .mcp.json
  return mergeMcpJson(cwd, ".mcp.json", servers, claudeEntry, overwriteNames);
}

function claudeEntry(server: McpServer): McpJsonEntry {
  return server.transport === "http"
    ? { type: "http", url: server.url ?? "" }
    : { command: server.command ?? "", args: server.args ?? [], env: server.env };
}

function geminiEntry(server: McpServer): McpJsonEntry {
  // Gemini CLI uses `httpUrl` for remote transports
  return server.transport === "http"
    ? { httpUrl: server.url ?? "" }
    : { command: server.command ?? "", args: server.args ?? [], env: server.env };
}

/** Merge servers into a `{ mcpServers: { name: entry } }` JSON file. */
function mergeMcpJson(
  cwd: string,
  relative: string,
  servers: McpServer[],
  shape: (s: McpServer) => McpJsonEntry,
  overwriteNames: ReadonlySet<string> = new Set(),
): { added: string[] } {
  let existing: { mcpServers?: Record<string, McpJsonEntry> } = {};
  const current = readManagedText(cwd, relative);
  if (current !== undefined) {
    try {
      existing = JSON.parse(current) as typeof existing;
    } catch {
      return { added: [] }; // user file is malformed — do not touch it
    }
  }

  const mcpServers = { ...(existing.mcpServers ?? {}) };
  const added: string[] = [];
  for (const server of servers) {
    // never overwrite user entries, EXCEPT our own managed names (fresh each spawn)
    if (mcpServers[server.name] && !overwriteNames.has(server.name)) continue;
    mcpServers[server.name] = shape(server);
    added.push(server.name);
  }
  if (added.length === 0) return { added };

  writeManagedFileAtomic(
    cwd,
    relative,
    JSON.stringify({ ...existing, mcpServers }, null, 2) + "\n",
  );
  return { added };
}

/**
 * Merge servers into Codex's `<cwd>/.codex/config.toml` as `[mcp_servers.NAME]`
 * blocks. Append-only: a section whose name already exists is left untouched —
 * EXCEPT names in `overwriteNames` (Daimon-managed), whose existing block is
 * stripped first so it's rewritten fresh.
 */
function mergeCodexToml(
  cwd: string,
  servers: McpServer[],
  overwriteNames: ReadonlySet<string> = new Set(),
): { added: string[] } {
  const relative = ".codex/config.toml";
  let text = "";
  const current = readManagedText(cwd, relative);
  if (current !== undefined) {
    try {
      text = current;
    } catch {
      return { added: [] };
    }
  }
  // strip our managed blocks so they get re-appended fresh (live port/ids)
  for (const name of overwriteNames) text = stripCodexBlock(text, name);

  const present = new Set(
    [...text.matchAll(/^\[mcp_servers\.("?)([^\]"]+)\1\]\s*$/gm)].map((m) => m[2]!),
  );

  const blocks: string[] = [];
  const added: string[] = [];
  for (const server of servers) {
    if (present.has(server.name)) continue; // never overwrite user entries
    blocks.push(codexBlock(server));
    added.push(server.name);
  }
  if (added.length === 0) return { added };

  const sep = text && !text.endsWith("\n") ? "\n\n" : text ? "\n" : "";
  writeManagedFileAtomic(cwd, relative, text + sep + blocks.join("\n") + "\n");
  return { added };
}

/** Remove a `[mcp_servers.NAME]` block (header + its keys, up to the next
 *  section header or EOF) so the caller can re-append it fresh. */
function stripCodexBlock(text: string, name: string): string {
  if (!text) return text;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|\\n)\\[mcp_servers\\.(?:")?${esc}(?:")?\\][^]*?(?=\\n\\[|$)`,
    "g",
  );
  return text.replace(re, "").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

function codexBlock(server: McpServer): string {
  const name = /^[A-Za-z0-9_-]+$/.test(server.name)
    ? server.name
    : JSON.stringify(server.name);
  const lines = [`[mcp_servers.${name}]`];
  if (server.transport === "http") {
    lines.push(`url = ${JSON.stringify(server.url ?? "")}`);
  } else {
    lines.push(`command = ${JSON.stringify(server.command ?? "")}`);
    if (server.args?.length) {
      lines.push(`args = [${server.args.map((a) => JSON.stringify(a)).join(", ")}]`);
    }
    if (server.env && Object.keys(server.env).length) {
      const env = Object.entries(server.env)
        .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
        .join(", ");
      lines.push(`env = { ${env} }`);
    }
  }
  return lines.join("\n");
}
