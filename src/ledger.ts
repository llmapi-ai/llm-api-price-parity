import type { Env } from "./config.js";
import type { RunResult } from "./types.js";

/**
 * The gateway's billing pipeline is asynchronous (gateway → Redpanda →
 * logconsumer → ClickHouse), so a row typically lands seconds after the
 * response. Rows for early runs are usually already there by the time the
 * benchmark finishes; the retry loop covers the tail.
 */
const ATTEMPTS = 8;
const RETRY_DELAY_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fills billedCostUSD on gateway rows from the ClickHouse `log` table (the
 * billing pipeline's ledger), matched by the response's request id. Rows that
 * never appear keep null — the report shows "—" and skips the parity check
 * rather than failing on pipeline lag.
 */
export async function attachLedgerCosts(
  results: RunResult[],
  env: Env,
  log: (line: string) => void,
): Promise<void> {
  if (!env.clickhouseUrl) return;
  const pending = new Map<string, RunResult[]>();
  for (const r of results) {
    if (r.target !== "gateway" || !r.requestID) continue;
    const rows = pending.get(r.requestID) ?? [];
    rows.push(r);
    pending.set(r.requestID, rows);
  }
  if (pending.size === 0) return;

  log(`ledger: resolving ${pending.size} request ids from ClickHouse...`);
  for (let attempt = 1; attempt <= ATTEMPTS && pending.size > 0; attempt++) {
    if (attempt > 1) await sleep(RETRY_DELAY_MS);
    let costs: Map<string, number>;
    try {
      costs = await queryLedgerCosts(env, [...pending.keys()]);
    } catch (error) {
      log(
        `ledger: ClickHouse query failed (attempt ${attempt}/${ATTEMPTS}): ${String(
          error instanceof Error ? error.message : error,
        )}`,
      );
      continue;
    }
    for (const [id, cost] of costs) {
      for (const row of pending.get(id) ?? []) row.billedCostUSD = cost;
      pending.delete(id);
    }
    if (pending.size > 0) {
      log(`ledger: ${pending.size} row(s) not in ClickHouse yet (attempt ${attempt}/${ATTEMPTS})`);
    }
  }
  if (pending.size > 0) {
    log(`ledger: ${pending.size} request id(s) never appeared in ClickHouse — their "$ billed" stays empty`);
  }
}

async function queryLedgerCosts(env: Env, ids: string[]): Promise<Map<string, number>> {
  // Request ids are gateway-generated (req_<ts>_<hex>); the strip is defensive.
  const quoted = ids.map((id) => `'${id.replace(/[\\']/g, "")}'`).join(",");
  const query =
    `SELECT request_id, toFloat64(cost) AS cost FROM log ` +
    `WHERE request_id IN (${quoted}) AND isNotNull(cost) FORMAT JSON`;
  const response = await fetch(`${env.clickhouseUrl}/?database=${encodeURIComponent(env.clickhouseDb)}`, {
    method: "POST",
    body: query,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`ClickHouse HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const payload = (await response.json()) as { data?: { request_id: string; cost: number | null }[] };
  const costs = new Map<string, number>();
  for (const row of payload.data ?? []) {
    if (typeof row.cost === "number") costs.set(row.request_id, row.cost);
  }
  return costs;
}
