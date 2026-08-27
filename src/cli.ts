#!/usr/bin/env node
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { MATCHUPS, loadDotEnv, readEnv } from "./config.js";
import { attachLedgerCosts } from "./ledger.js";
import { loadPriceTable } from "./pricing.js";
import { bold, dim, red, renderConsole, renderMarkdown, yellow } from "./report.js";
import { runBenchmark, summarize } from "./runner.js";
import type { Task } from "./types.js";

const HELP = `llm-price-parity — price-parity benchmark: direct provider APIs vs an LLM gateway

Usage:
  npm run bench -- [options]

Options:
  --models <a,b>            Matchups to run (default: all)
  --tasks <a,b>             Tasks to run (default: all in tasks/)
  --repeats <n>             Runs per model×task pair (default: 5)
  --reasoning-effort <e>    OpenAI-family reasoning effort, sent EXPLICITLY to
                            both sides (default: none)
  --seed <n>                Seed for OpenAI-family requests (default: 42)
  --show-requests           Print the exact request bodies sent to each side
  --json                    Print raw results as JSON instead of the table
  --list                    List available matchups and tasks, then exit
  --help                    This help
`;

/** Below this many repeats, reasoning-token jitter makes the median unreliable. */
const REASONING_MIN_REPEATS = 9;

function loadTasks(): Task[] {
  const dir = new URL("../tasks/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as Task);
}

function pick<T extends { name: string }>(all: T[], csv: string | undefined, what: string): T[] {
  if (!csv) return all;
  const wanted = csv.split(",").map((s) => s.trim());
  const byName = new Map(all.map((t) => [t.name, t]));
  return wanted.map((name) => {
    const found = byName.get(name);
    if (!found) {
      throw new Error(`Unknown ${what} "${name}". Available: ${all.map((t) => t.name).join(", ")}`);
    }
    return found;
  });
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      tasks: { type: "string" },
      repeats: { type: "string", default: "5" },
      "reasoning-effort": { type: "string", default: "none" },
      seed: { type: "string", default: "42" },
      "show-requests": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  loadDotEnv();
  const env = readEnv();
  const prices = loadPriceTable();
  const allTasks = loadTasks();

  if (values.list) {
    console.log(bold("Matchups:"));
    for (const m of MATCHUPS) console.log(`  ${m.name}  (${m.directModel} vs ${m.gatewayModel})`);
    console.log(bold("Tasks:"));
    for (const t of allTasks) console.log(`  ${t.name}  — ${t.description}`);
    return 0;
  }

  const matchups = pick(MATCHUPS, values.models, "matchup");
  const tasks = pick(allTasks, values.tasks, "task");

  if (!env.gatewayKey) {
    console.error(red("LLMAPI_API_KEY is required — the gateway is one side of every comparison."));
    return 1;
  }
  if (!env.openaiKey) {
    console.error(red("OPENAI_API_KEY is required — it is the direct side of every comparison."));
    return 1;
  }

  const repeats = Number(values.repeats);
  const reasoningEffort = values["reasoning-effort"]!;
  console.log(dim(`gateway: ${env.gatewayBaseUrl} · reasoning_effort: ${reasoningEffort} · repeats: ${repeats}`));

  // Reasoning tokens have no seed, so their count jitters run-to-run. With few
  // repeats the median doesn't settle and cost parity can spuriously fail on
  // high-variance (often small) models — warn so it isn't mistaken for a real gap.
  if (reasoningEffort !== "none" && repeats < REASONING_MIN_REPEATS) {
    console.error(
      yellow(
        `warning: reasoning_effort "${reasoningEffort}" with --repeats ${repeats} — reasoning-token jitter can cause spurious cost-parity failures; use --repeats ${REASONING_MIN_REPEATS} or more for a stable median.`,
      ),
    );
  }

  const results = await runBenchmark({
    matchups,
    tasks,
    repeats,
    options: { reasoningEffort, seed: Number(values.seed), timeoutMs: 190_000 },
    env,
    prices,
    log: (line) => console.log(dim(line)),
  });

  // "$ billed" comes from the billing pipeline's ClickHouse, not from the
  // responses — resolve it now that all requests have been made.
  if (env.clickhouseUrl) {
    await attachLedgerCosts(results, env, (line) => console.log(dim(line)));
  } else {
    console.log(dim(`ledger: CLICKHOUSE_URL not set — "$ billed" stays empty and the billing-parity check is skipped`));
  }

  if (values["show-requests"]) {
    const seen = new Set<string>();
    for (const r of results) {
      const key = `${r.matchup}\t${r.task}\t${r.target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(bold(`\n# ${r.matchup} × ${r.task} → ${r.target}`));
      console.log(JSON.stringify(r.requestBody, null, 2));
    }
    console.log("");
  }

  const summaries = summarize(results);
  if (values.json) {
    console.log(JSON.stringify({ summaries, results }, null, 2));
  } else {
    console.log(renderConsole(summaries, prices, repeats));
  }

  mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = new URL(`../results/report-${stamp}.md`, import.meta.url);
  writeFileSync(reportPath, renderMarkdown(summaries, results, prices, repeats, reasoningEffort));
  console.log(dim(`report written to results/report-${stamp}.md`));

  const failed = summaries.some(
    (s) => !s.costParity || !s.reasoningParity || s.billingParity === false,
  );
  return failed ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(red(String(error instanceof Error ? error.message : error)));
    process.exit(1);
  });
