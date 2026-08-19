/**
 * Model pricing — USD per 1,000,000 tokens. Used to turn the token usage parsed
 * from a Claude Code session transcript into a dollar cost. Cache reads are
 * billed ~0.1× the input rate and 5-minute cache writes ~1.25×, the standard
 * Anthropic ratios. A provider's ModelInfo.inputCostPerMTok/outputCostPerMTok
 * override this table when present.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** Resolve a price by exact id, then by LONGEST matching prefix (handles
 *  date-suffixed ids; longest-first so the most-specific id wins). */
export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  return key ? MODEL_PRICES[key] : undefined;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Dollar cost of a token usage at the given model's price (0 if unknown). */
export function usageCostUsd(
  model: string | undefined,
  u: TokenUsage,
  override?: { input?: number; output?: number },
): number {
  const p = priceForModel(model);
  const inPerM = override?.input ?? p?.input;
  const outPerM = override?.output ?? p?.output;
  if (inPerM === undefined || outPerM === undefined) return 0;
  const inM = inPerM / 1e6;
  const outM = outPerM / 1e6;
  return (
    u.input * inM +
    u.output * outM +
    u.cacheRead * inM * 0.1 +
    u.cacheCreation * inM * 1.25
  );
}
