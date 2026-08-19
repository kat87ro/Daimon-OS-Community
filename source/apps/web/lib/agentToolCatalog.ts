import type { McpServer, ProviderKind, ToolBinding } from "@daimon-os/shared";

const LAUNCH_PROVIDERS = ["claude", "codex", "gemini", "ollama", "lmstudio"] as const;

export interface AgentToolOption {
  value: string;
  label: string;
  description: string;
  group: "Provider tools" | "MCP connections" | "Existing custom tools";
  keywords: string[];
  disabled?: boolean;
  binding?: ToolBinding;
  mcpServerId?: string;
}

interface NativeToolDescriptor {
  name: string;
  label: string;
  description: string;
  kind: ToolBinding["kind"];
  providers: readonly ProviderKind[];
  keywords: string[];
}

/**
 * Daimon's portable capability vocabulary. These are not advertised as raw
 * provider protocol names: each CLI owns its actual implementation and policy.
 */
export const NATIVE_AGENT_TOOLS: readonly NativeToolDescriptor[] = [
  {
    name: "bash",
    label: "Shell / terminal",
    description: "Run project commands, tests, scripts, and package tooling.",
    kind: "shell",
    providers: LAUNCH_PROVIDERS,
    keywords: ["bash", "shell", "terminal", "command", "exec"],
  },
  {
    name: "read",
    label: "Read files",
    description: "Read source, configuration, logs, and documentation in the workspace.",
    kind: "builtin",
    providers: LAUNCH_PROVIDERS,
    keywords: ["read", "file", "source", "document"],
  },
  {
    name: "write",
    label: "Create files",
    description: "Create new source and deliverable files in the managed workspace.",
    kind: "builtin",
    providers: LAUNCH_PROVIDERS,
    keywords: ["write", "create", "file"],
  },
  {
    name: "edit",
    label: "Edit files",
    description: "Apply bounded changes to existing workspace files.",
    kind: "builtin",
    providers: LAUNCH_PROVIDERS,
    keywords: ["edit", "patch", "replace", "modify"],
  },
  {
    name: "glob",
    label: "Find files",
    description: "Locate files and folders by path or pattern.",
    kind: "builtin",
    providers: LAUNCH_PROVIDERS,
    keywords: ["glob", "find", "files", "pattern"],
  },
  {
    name: "grep",
    label: "Search file contents",
    description: "Search source and text content across the workspace.",
    kind: "builtin",
    providers: LAUNCH_PROVIDERS,
    keywords: ["grep", "search", "ripgrep", "content", "code"],
  },
  {
    name: "web-search",
    label: "Web search",
    description: "Use the provider's supported live web-search capability.",
    kind: "builtin",
    providers: ["claude", "gemini"],
    keywords: ["web", "internet", "search", "research"],
  },
  {
    name: "web-fetch",
    label: "Fetch web pages",
    description: "Retrieve and inspect a specific web page through the provider.",
    kind: "builtin",
    providers: ["claude", "gemini"],
    keywords: ["web", "fetch", "url", "http", "page"],
  },
  {
    name: "image-inspection",
    label: "Inspect images",
    description: "Read screenshots and image inputs supported by the selected provider model.",
    kind: "builtin",
    providers: ["claude", "codex", "gemini"],
    keywords: ["image", "screenshot", "vision", "visual"],
  },
  {
    name: "notebook-edit",
    label: "Edit notebooks",
    description: "Read and modify notebook cells using the provider's notebook tooling.",
    kind: "builtin",
    providers: ["claude"],
    keywords: ["notebook", "jupyter", "ipynb", "cell"],
  },
  {
    name: "subagents",
    label: "Delegate to subagents",
    description: "Use the provider's native bounded delegation capability when available.",
    kind: "builtin",
    providers: ["claude", "codex", "gemini"],
    keywords: ["agent", "subagent", "delegate", "parallel"],
  },
];

const toolValue = (name: string) => `tool:${name}`;
const mcpValue = (id: string) => `mcp:${id}`;

export function buildAgentToolOptions(
  providerKind: ProviderKind | undefined,
  currentTools: readonly ToolBinding[],
  mcpServers: readonly McpServer[],
): AgentToolOption[] {
  const native = NATIVE_AGENT_TOOLS
    .filter((tool) => !providerKind || tool.providers.includes(providerKind))
    .map((tool): AgentToolOption => ({
      value: toolValue(tool.name),
      label: tool.label,
      description: tool.description,
      group: "Provider tools",
      keywords: [...tool.keywords, tool.name],
      binding: currentTools.find((binding) => binding.name === tool.name) ?? {
        name: tool.name,
        kind: tool.kind,
        enabled: true,
      },
    }));

  const known = new Set(NATIVE_AGENT_TOOLS.map((tool) => tool.name));
  const existing = currentTools
    .filter((tool) => !known.has(tool.name))
    .map((tool): AgentToolOption => ({
      value: toolValue(tool.name),
      label: tool.name,
      description: "Existing custom capability retained from this agent's configuration.",
      group: "Existing custom tools",
      keywords: [tool.name, tool.kind, "custom", "existing"],
      binding: tool,
    }));

  const compatibleMcp = mcpServers
    .filter((server) => server.enabled && (!server.providerKind || server.providerKind === providerKind))
    .map((server): AgentToolOption => ({
      value: mcpValue(server.id),
      label: server.name,
      description: `${server.transport.toUpperCase()} MCP connection${server.isDefault ? " · default for compatible agents" : ""}`,
      group: "MCP connections",
      keywords: [server.name, server.transport, "mcp", server.providerKind ?? "universal"],
      disabled: server.isDefault,
      mcpServerId: server.id,
    }));

  return [...native, ...compatibleMcp, ...existing];
}

export function selectedAgentToolValues(
  tools: readonly ToolBinding[],
  mcpServerIds: readonly string[],
  options: readonly AgentToolOption[],
): string[] {
  const pickedMcp = new Set(mcpServerIds);
  const enabledTools = new Set(tools.filter((tool) => tool.enabled).map((tool) => tool.name));
  return options
    .filter((option) =>
      option.binding ? enabledTools.has(option.binding.name) :
        option.mcpServerId ? option.disabled || pickedMcp.has(option.mcpServerId) : false)
    .map((option) => option.value);
}

export function selectionToAgentTools(
  selectedValues: readonly string[],
  options: readonly AgentToolOption[],
): { tools: ToolBinding[]; mcpServerIds: string[] } {
  const selected = new Set(selectedValues);
  return {
    tools: options
      .filter((option) => option.binding && selected.has(option.value))
      .map((option) => ({ ...option.binding!, enabled: true })),
    mcpServerIds: options
      .filter((option) => option.mcpServerId && !option.disabled && selected.has(option.value))
      .map((option) => option.mcpServerId!),
  };
}
