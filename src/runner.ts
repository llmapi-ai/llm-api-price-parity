import type { Env } from "./config.js";
import {
  buildOpenAIBody,
  callOpenAICompatible,
  type CallOptions,
  type CallOutcome,
} from "./providers.js";
import {
  costUSD,
  median,
  reasoningRegimeMismatch,
  withinCostParity,
  withinTokenTolerance,
} from "./pricing.js";
import type { Matchup, PairSummary, PriceTable, RunResult, SideStats, Task, TargetKind } from "./types.js";

export interface RunPlan {
  matchups: Matchup[];
  tasks: Task[];
  repeats: number;
  options: CallOptions;
  env: Env;
  prices: PriceTable;
  log: (line: string) => void;
}

const TRUNCATED_REASONS = new Set(["length", "max_tokens", "max_output_tokens"]);

function toResult(
  outcome: CallOutcome,
  target: TargetKind,
  matchup: Matchup,
  task: Task,
  repeat: number,
  prices: PriceTable,
): RunResult {
  const price = prices.models[matchup.name];
  if (!price) throw new Error(`No price pinned for model "${matchup.name}" in prices.json`);
  return {
    target,
    matchup: matchup.name,
    task: task.name,
    repeat,
    latencyMs: Math.round(outcome.latencyMs),
    usage: outcome.usage,
    // direct: the test's own list-price math (tokens × prices.json) — the reference.
    // gateway: the response's self-reported cost_usd_* sum — the actual price the
    // API showed. A gateway response with no cost fields yields null, surfaced
    // as a cost-parity failure rather than papered over.
    computedCostUSD: target === "gateway" ? outcome.apiReportedCostUSD : costUSD(price, outcome.usage),
    finishReason: outcome.finishReason,
    truncated: TRUNCATED_REASONS.has(outcome.finishReason),
    requestBody: outcome.requestBody,
    responsePreview: outcome.text.slice(0, 200),
  };
}

async function callSide(
  target: TargetKind,
  matchup: Matchup,
  task: Task,
  plan: RunPlan,
): Promise<CallOutcome> {
  const { env, options } = plan;
  // The gateway speaks the SAME OpenAI-compatible chat.completions API as the
  // direct provider, so the two requests in a comparison differ only by base
  // URL, key, and model id.
  if (target === "gateway") {
    if (!env.gatewayKey) throw new Error("LLMAPI_API_KEY is not set");
    const body = buildOpenAIBody(matchup.gatewayModel, task, options);
    return callOpenAICompatible(env.gatewayBaseUrl, env.gatewayKey, body, options.timeoutMs);
  }
  if (!env.openaiKey) throw new Error("OPENAI_API_KEY is not set");
  const body = buildOpenAIBody(matchup.directModel, task, options);
  return callOpenAICompatible("https://api.openai.com/v1", env.openaiKey, body, options.timeoutMs);
}

export async function runBenchmark(plan: RunPlan): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const matchup of plan.matchups) {
    for (const task of plan.tasks) {
      for (let repeat = 1; repeat <= plan.repeats; repeat++) {
        plan.log(`  ${matchup.name} × ${task.name} — run ${repeat}/${plan.repeats}`);
        // Both sides fire concurrently so time-of-day effects hit them equally.
        const [direct, gateway] = await Promise.all([
          callSide("direct", matchup, task, plan),
          callSide("gateway", matchup, task, plan),
        ]);
        results.push(toResult(direct, "direct", matchup, task, repeat, plan.prices));
        results.push(toResult(gateway, "gateway", matchup, task, repeat, plan.prices));
      }
    }
  }
  return results;
}

function sideStats(runs: RunResult[]): SideStats {
  const computed = runs.map((r) => r.computedCostUSD).filter((v): v is number => v !== null);
  return {
    runs,
    medInput: median(runs.map((r) => r.usage.inputTokens)),
    medCached: median(runs.map((r) => r.usage.cachedInputTokens)),
    medOutput: median(runs.map((r) => r.usage.outputTokens)),
    medReasoning: median(runs.map((r) => r.usage.reasoningTokens)),
    medCost: computed.length > 0 ? median(computed) : null,
    medLatencyMs: median(runs.map((r) => r.latencyMs)),
  };
}

export function summarize(results: RunResult[]): PairSummary[] {
  const summaries: PairSummary[] = [];
  const keys = [...new Set(results.map((r) => `${r.matchup}\t${r.task}`))];
  for (const key of keys) {
    const [matchup, task] = key.split("\t") as [string, string];
    const runs = results.filter((r) => r.matchup === matchup && r.task === task);
    const direct = sideStats(runs.filter((r) => r.target === "direct"));
    const gateway = sideStats(runs.filter((r) => r.target === "gateway"));
    // direct.medCost is never null (the test always computes it); gateway.medCost
    // is null when the gateway omitted cost_usd_* — surfaced as a costParity fail
    // below, since "no price shown" must not read as parity.
    const costDeltaPct =
      direct.medCost !== null && direct.medCost > 0 && gateway.medCost !== null
        ? ((gateway.medCost - direct.medCost) / direct.medCost) * 100
        : 0;
    const directTokens = direct.medInput + direct.medOutput;
    const gatewayTokens = gateway.medInput + gateway.medOutput;
    const tokenDeltaPct = directTokens > 0 ? ((gatewayTokens - directTokens) / directTokens) * 100 : 0;
    summaries.push({
      matchup,
      task,
      direct,
      gateway,
      costDeltaPct,
      tokenDeltaPct,
      costParity: gateway.medCost === null ? false : withinCostParity(costDeltaPct),
      reasoningParity: !reasoningRegimeMismatch(direct.medReasoning, gateway.medReasoning),
      tokenDrift:
        !withinTokenTolerance(direct.medInput, gateway.medInput) ||
        !withinTokenTolerance(direct.medOutput, gateway.medOutput),
      truncated: runs.some((r) => r.truncated),
    });
  }
  return summaries;
}
