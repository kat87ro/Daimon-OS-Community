import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelInfo } from "@daimon-os/shared";
import { agentRuntimeEnvironment } from "../runners/environment";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,255}$/;
const CODEX_CATALOG_LIMIT = 4 * 1024 * 1024;

export type ModelCatalogSource = "provider-cli-live" | "provider-cli-bundled" | "provider-api" | "provider-default";

export interface ModelDiscoveryResult {
  ok: boolean;
  detail: string;
  models: ModelInfo[];
  source: ModelCatalogSource;
}

interface CodexCatalogEntry {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
  context_window?: unknown;
  max_output_tokens?: unknown;
}

/** Parse only provider-reported fields from `codex debug models`; no guessed metadata. */
export function parseCodexModelCatalog(raw: string): ModelInfo[] {
  const parsed = JSON.parse(raw) as { models?: CodexCatalogEntry[] };
  if (!Array.isArray(parsed.models)) throw new Error("Codex returned an invalid model catalog");
  const visible = parsed.models
    .filter((entry) => entry.visibility === "list")
    .filter((entry): entry is CodexCatalogEntry & { slug: string } =>
      typeof entry.slug === "string" && MODEL_ID.test(entry.slug))
    .sort((a, b) => {
      const left = typeof a.priority === "number" ? a.priority : Number.MAX_SAFE_INTEGER;
      const right = typeof b.priority === "number" ? b.priority : Number.MAX_SAFE_INTEGER;
      return left - right || a.slug.localeCompare(b.slug);
    });
  const unique = new Map<string, ModelInfo>();
  for (const entry of visible) {
    const contextWindow = positiveInteger(entry.context_window);
    const maxOutputTokens = positiveInteger(entry.max_output_tokens);
    unique.set(entry.slug, {
      id: entry.slug,
      label: typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim().slice(0, 256)
        : entry.slug,
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    });
  }
  return [...unique.values()];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function runCatalogCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Never let repository-local Codex configuration influence the trusted
    // catalog query. The empty 0700 cwd has no project instructions/settings.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "daimon-model-catalog-"));
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      fs.rmSync(cwd, { recursive: true, force: true });
      callback();
    };
    execFile(command, args, {
      timeout: 8_000,
      maxBuffer: CODEX_CATALOG_LIMIT,
      env: agentRuntimeEnvironment(),
      encoding: "utf8",
      cwd,
    }, (error, stdout, stderr) => {
      if (error) {
        finish(() => reject(new Error((stderr || error.message).trim().slice(0, 300))));
        return;
      }
      finish(() => resolve(stdout));
    });
  });
}

/**
 * Codex exposes its catalog through the installed provider CLI. Prefer the live
 * account-aware catalog and fall back to the catalog shipped by that same CLI.
 */
export async function discoverCodexModels(command: string): Promise<ModelDiscoveryResult> {
  let liveFailure = "";
  try {
    const models = parseCodexModelCatalog(await runCatalogCommand(command, ["debug", "models"]));
    if (models.length > 0) {
      return {
        ok: true,
        detail: `Codex reported ${models.length} available models for this installation/account.`,
        models,
        source: "provider-cli-live",
      };
    }
    liveFailure = "live catalog was empty";
  } catch (error) {
    liveFailure = error instanceof Error ? error.message : "live catalog failed";
  }
  try {
    const models = parseCodexModelCatalog(await runCatalogCommand(command, ["debug", "models", "--bundled"]));
    if (models.length === 0) throw new Error("bundled catalog was empty");
    return {
      ok: true,
      detail: `Codex reported ${models.length} models from its installed catalog (live catalog unavailable).`,
      models,
      source: "provider-cli-bundled",
    };
  } catch (error) {
    const fallbackFailure = error instanceof Error ? error.message : "bundled catalog failed";
    return {
      ok: false,
      detail: `Codex model discovery failed: ${liveFailure}; ${fallbackFailure}`.slice(0, 500),
      models: [],
      source: "provider-cli-bundled",
    };
  }
}

/** Claude Code and Gemini CLI currently expose selection but no machine-readable list command. */
export function providerDefaultCatalog(kind: "claude" | "gemini"): ModelDiscoveryResult {
  return {
    ok: true,
    detail: `${kind === "claude" ? "Claude Code" : "Gemini CLI"} does not expose a machine-readable model catalog; using its current provider default. You may enter an exact model id manually.`,
    models: [],
    source: "provider-default",
  };
}
