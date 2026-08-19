import fs from "node:fs";
import path from "node:path";
import { usageCostUsd } from "@daimon-os/shared";

/**
 * Claude Code writes a JSONL transcript per session at
 *   <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl
 * where <configDir> is the CLI's config dir (CLAUDE_CONFIG_DIR, else ~/.claude)
 * and <encoded-cwd> replaces every non-alphanumeric char in the absolute cwd with
 * "-". We spawn `claude --session-id <channel>`, so the file is named by our
 * channel id and the match is deterministic.
 *
 * configDir is REQUIRED (not silently defaulted) on purpose: the cost tracker
 * MUST read transcripts from the SAME dir the CLI wrote them to (today ~/.claude,
 * threaded in via ProcessManager). A silent fallback would risk every worker's
 * cost reading $0 if that dir ever changes.
 */
export function claudeTranscriptPath(cwd: string, sessionId: string, configDir: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(configDir, "projects", enc, `${sessionId}.jsonl`);
}

export interface TranscriptTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

interface TranscriptLine {
  type?: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/**
 * Sum token usage and dollar cost across every assistant line of a transcript.
 * Each assistant line carries the usage for that one API response and its own
 * model, so the sum is the session's cumulative cost (costed per-line by model).
 * Returns undefined if the file isn't readable yet (worker just started).
 */
export function readTranscriptTotals(file: string): TranscriptTotals | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined; // not created yet, or unreadable
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(line) as TranscriptLine;
    } catch {
      continue; // a partially-flushed final line — skip, picked up next poll
    }
    const u = obj.message?.usage;
    if (!u || obj.type !== "assistant") continue;
    const usage = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
    };
    inputTokens += usage.input;
    outputTokens += usage.output;
    cacheReadTokens += usage.cacheRead;
    costUsd += usageCostUsd(obj.message?.model, usage);
  }
  return { inputTokens, outputTokens, cacheReadTokens, costUsd: +costUsd.toFixed(4) };
}
