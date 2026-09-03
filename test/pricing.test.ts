import { describe, expect, it } from "vitest";
import {
  costUSD,
  median,
  reasoningRegimeMismatch,
  withinCostParity,
  withinTokenTolerance,
} from "../src/pricing.js";
import { billedFromUsage, normalizeOpenAIUsage } from "../src/providers.js";
import type { ModelPrice } from "../src/types.js";

const price: ModelPrice = { provider: "openai", input: 1.75, cachedInput: 0.175, output: 14.0 };

describe("costUSD", () => {
  it("bills fresh input, cached input, and output at their own rates", () => {
    const cost = costUSD(price, {
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 500,
      reasoningTokens: 0,
    });
    // 600×1.75 + 400×0.175 + 500×14, per million
    expect(cost).toBeCloseTo((600 * 1.75 + 400 * 0.175 + 500 * 14) / 1e6, 12);
  });

  it("does NOT double-count reasoning tokens (they are inside outputTokens)", () => {
    const withoutReasoning = costUSD(price, {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 950,
      reasoningTokens: 0,
    });
    const withReasoning = costUSD(price, {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 950,
      reasoningTokens: 350,
    });
    expect(withReasoning).toBe(withoutReasoning);
  });

  it("never bills negative fresh input if cached exceeds prompt (defensive)", () => {
    const cost = costUSD(price, {
      inputTokens: 100,
      cachedInputTokens: 150,
      outputTokens: 0,
      reasoningTokens: 0,
    });
    expect(cost).toBeCloseTo((150 * 0.175) / 1e6, 12);
  });
});

describe("usage normalization", () => {
  it("maps OpenAI native usage (reasoning folded into completion_tokens)", () => {
    // Native shape: reasoning folded into completion (prompt 23 + completion 78 incl. 64 reasoning = total 101).
    const u = normalizeOpenAIUsage({
      prompt_tokens: 23,
      completion_tokens: 78,
      total_tokens: 101,
      completion_tokens_details: { reasoning_tokens: 64 },
    });
    expect(u).toEqual({
      inputTokens: 23,
      cachedInputTokens: 0,
      outputTokens: 78,
      reasoningTokens: 64,
    });
  });

  it("maps gateway usage (completion_tokens visible-only, reasoning separate) to the SAME billable output", () => {
    // Separated shape for the same request: completion 16 is visible-only,
    // reasoning 64 reported separately, total 103 = 23 + 16 + 64.
    const u = normalizeOpenAIUsage({
      prompt_tokens: 23,
      completion_tokens: 16,
      total_tokens: 103,
      reasoning_tokens: 64,
      completion_tokens_details: { reasoning_tokens: 64 },
    });
    // 103 − 23 = 80 billable output (16 visible + 64 reasoning), NOT 16.
    expect(u.outputTokens).toBe(80);
    expect(u.reasoningTokens).toBe(64);
  });

  it("falls back to completion+reasoning when total_tokens is absent and completion excludes reasoning", () => {
    const u = normalizeOpenAIUsage({
      prompt_tokens: 23,
      completion_tokens: 16,
      reasoning_tokens: 64,
    });
    expect(u.outputTokens).toBe(80);
  });

  it("sums gateway cost_usd_* fields, null when absent", () => {
    expect(billedFromUsage({})).toBeNull();
    expect(
      billedFromUsage({ cost_usd_input: 0.001, cost_usd_output: 0.002, cost_usd_cached_input: 0.0005 }),
    ).toBeCloseTo(0.0035, 12);
  });
});

describe("tolerances", () => {
  it("token-drift detection allows small jitter but flags large divergence", () => {
    expect(withinTokenTolerance(1000, 1015)).toBe(true);
    expect(withinTokenTolerance(10, 30)).toBe(true); // tiny counts: 25-token floor
    expect(withinTokenTolerance(600, 950)).toBe(false); // ~350 hidden reasoning tokens
  });

  it("cost parity is one-directional: gateway cheaper passes, materially pricier fails", () => {
    expect(withinCostParity(-15)).toBe(true); // gateway cheaper is a pass
    expect(withinCostParity(0)).toBe(true);
    expect(withinCostParity(8)).toBe(true); // within reasoning-jitter tolerance
    expect(withinCostParity(23)).toBe(false); // gateway meaningfully pricier
    expect(withinCostParity(100)).toBe(false); // far outside the band → fails
  });
});

describe("reasoningRegimeMismatch", () => {
  it("flags a reasoning on/off mismatch: one side off, the other on", () => {
    expect(reasoningRegimeMismatch(0, 350)).toBe(true);
    expect(reasoningRegimeMismatch(350, 0)).toBe(true);
  });

  it("does NOT flag within-regime variance (both sides reasoning on)", () => {
    expect(reasoningRegimeMismatch(128, 192)).toBe(false);
    expect(reasoningRegimeMismatch(192, 128)).toBe(false);
  });

  it("does NOT flag when both sides have reasoning off", () => {
    expect(reasoningRegimeMismatch(0, 0)).toBe(false);
    expect(reasoningRegimeMismatch(10, 20)).toBe(false); // both under the floor
  });
});

describe("median", () => {
  it("handles odd, even, and empty inputs", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
