import { readFileSync } from "node:fs";
import type { ModelPrice, PriceTable, Usage } from "./types.js";

const PER_MILLION = 1_000_000;

export function loadPriceTable(): PriceTable {
  const url = new URL("../prices.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as PriceTable;
}

/**
 * Cost from a response's usage block at published per-token rates.
 *
 * Billing rules this encodes (identical for both sides of a comparison):
 * - Cached input tokens bill at the cached rate; the remainder at the input rate.
 * - Output tokens already INCLUDE reasoning tokens (OpenAI reports them that
 *   way), and reasoning bills at the plain output rate. Counting reasoning
 *   tokens again on top of completion tokens is a double-count bug.
 */
export function costUSD(price: ModelPrice, usage: Usage): number {
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (freshInput * price.input +
      usage.cachedInputTokens * price.cachedInput +
      usage.outputTokens * price.output) /
    PER_MILLION
  );
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Token counts jitter slightly between runs even at temperature 0, so parity
 * allows max(2%, 25 tokens) of drift. A hidden-default bug (e.g. reasoning
 * silently enabled) shows up as hundreds of extra tokens — far outside this.
 */
export function withinTokenTolerance(direct: number, gateway: number): boolean {
  const tolerance = Math.max(direct * 0.02, 25);
  return Math.abs(gateway - direct) <= tolerance;
}

/**
 * Price parity is a "gateway ≤ provider" promise, so the cost check is
 * one-directional: the gateway may not cost materially MORE than direct for the
 * same request; costing less is a pass, not a failure. The tolerance absorbs
 * reasoning-token nondeterminism (which jitters output cost run-to-run) while
 * still catching a hidden-work regression — e.g. a silently enabled reasoning
 * default can roughly double cost (+100%), far outside this band.
 */
export const COST_PARITY_TOLERANCE_PCT = 10;

export function withinCostParity(costDeltaPct: number): boolean {
  return costDeltaPct <= COST_PARITY_TOLERANCE_PCT;
}

/** At or below this many median reasoning tokens, a side is treated as "reasoning off". */
export const REASONING_ONOFF_FLOOR = 25;

/**
 * A categorical reasoning mismatch: one side effectively has reasoning OFF while
 * the other has it ON — e.g. a hidden reasoning default on one side but not the
 * other. Within-regime differences (both sides reasoning, counts merely
 * jittering) are deliberately NOT flagged here — cost parity decides whether
 * they cost more.
 */
export function reasoningRegimeMismatch(directReasoning: number, gatewayReasoning: number): boolean {
  const off = (n: number) => n <= REASONING_ONOFF_FLOOR;
  return off(directReasoning) !== off(gatewayReasoning);
}
