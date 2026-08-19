import type { ProviderConfig, ProviderKind } from "@daimon-os/shared";

const CHAT_PROVIDER_KINDS: ReadonlySet<ProviderKind> = new Set([
  "claude",
  "codex",
  "gemini",
  "ollama",
  "lmstudio",
]);

export function providerSupportsAdHocChat(provider: ProviderConfig): boolean {
  return provider.enabled && provider.mode === "cli" && CHAT_PROVIDER_KINDS.has(provider.kind);
}

/** Select exclusively from the provider-reported catalog; never invent a model id. */
export function selectReportedChatModel(provider: ProviderConfig, current = ""): string {
  const reported = provider.models.map((model) => model.id);
  if (reported.includes(current)) return current;
  if (reported.includes(provider.defaultModel)) return provider.defaultModel;
  return reported[0] ?? "";
}
