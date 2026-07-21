export type ProviderFamily = "openai";

export interface ModelPrice {
  provider: ProviderFamily;
  /** USD per 1M non-cached input tokens */
  input: number;
  /** USD per 1M cached input tokens */
  cachedInput: number;
  /** USD per 1M output tokens (reasoning tokens bill at this rate) */
  output: number;
}

export interface PriceTable {
  retrieved: string;
  unit: string;
  sources: Record<string, string>;
  models: Record<string, ModelPrice>;
}

/** Provider-agnostic view of a response's usage block. */
export interface Usage {
  /** Total input tokens, INCLUDING cached ones. */
  inputTokens: number;
  /** Subset of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Total output tokens, INCLUDING reasoning tokens. */
  outputTokens: number;
  /** Subset of outputTokens spent on hidden reasoning. */
  reasoningTokens: number;
}

/** Matchup: one logical model, addressed directly and through the gateway. */
export interface Matchup {
  /** Logical model id; must exist in prices.json */
  name: string;
  provider: ProviderFamily;
  directModel: string;
  gatewayModel: string;
}

export interface Task {
  name: string;
  description: string;
  messages: { role: "user" | "system" | "assistant"; content: string }[];
  maxOutputTokens: number;
  /**
   * Optional JSON Schema. When present, both sides request it via structured
   * outputs (`response_format: json_schema`, strict), so constrained decoding
   * pins the output structure — removing whitespace/formatting nondeterminism
   * that would otherwise make token counts (and cost) drift between runs.
   */
  responseSchema?: Record<string, unknown>;
}

export type TargetKind = "direct" | "gateway";

export interface RunResult {
  target: TargetKind;
  matchup: string;
  task: string;
  repeat: number;
  latencyMs: number;
  usage: Usage;
  /** Cost computed by US from usage × prices.json — same math for both sides. */
  computedCostUSD: number;
  /** Cost the gateway claims it billed (sum of usage.cost_usd_* fields), if present. */
  billedCostUSD: number | null;
  finishReason: string;
  truncated: boolean;
  requestBody: Record<string, unknown>;
  responsePreview: string;
}

export interface SideStats {
  runs: RunResult[];
  medInput: number;
  medCached: number;
  medOutput: number;
  medReasoning: number;
  medCost: number;
  medBilled: number | null;
  medLatencyMs: number;
}

export interface PairSummary {
  matchup: string;
  task: string;
  direct: SideStats;
  gateway: SideStats;
  /** (gateway computed cost − direct computed cost) / direct, in % */
  costDeltaPct: number;
  /** Gateway is not materially more expensive than direct (one-directional). */
  costParity: boolean;
  /** No categorical reasoning on/off mismatch between the two sides. */
  reasoningParity: boolean;
  /** null when the gateway did not report billed cost */
  billingParity: boolean | null;
  /**
   * Informational only: raw token counts drifted beyond noise between the two
   * sides. Both call the same chat.completions API, so small jitter is expected
   * at temperature 0; it does not by itself indicate a cost difference.
   */
  tokenDrift: boolean;
  truncated: boolean;
}
