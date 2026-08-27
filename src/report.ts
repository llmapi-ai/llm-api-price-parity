import type { PairSummary, PriceTable, RunResult } from "./types.js";

const useColor = process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

const money = (v: number) => `$${v.toFixed(6)}`;
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
// eslint-disable-next-line no-control-regex
const visibleWidth = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ""))),
  );
  const pad = (s: string, w: number) => s + " ".repeat(w - visibleWidth(s));
  const line = (l: string, m: string, r: string) =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (cells: string[]) =>
    "│ " + cells.map((c, i) => pad(c, widths[i] ?? 0)).join(" │ ") + " │";
  return [
    line("┌", "┬", "┐"),
    row(headers.map(bold)),
    line("├", "┼", "┤"),
    ...rows.map(row),
    line("└", "┴", "┘"),
  ].join("\n");
}

export function renderConsole(summaries: PairSummary[], prices: PriceTable, repeats: number): string {
  const out: string[] = [];
  out.push("");
  out.push(bold("  llm-price-parity") + dim(`  ·  medians over ${repeats} run(s)  ·  prices pinned ${prices.retrieved}`));
  out.push("");

  const rows: string[][] = [];
  for (const s of summaries) {
    for (const [label, side] of [["direct", s.direct], ["gateway", s.gateway]] as const) {
      const first = label === "direct";
      rows.push([
        first ? cyan(s.matchup) : "",
        first ? s.task : "",
        label,
        String(side.medInput),
        String(side.medOutput),
        side.medReasoning > 0 ? yellow(String(side.medReasoning)) : dim("0"),
        side.medCost === null ? dim("—") : money(side.medCost),
        first ? "" : colorDelta(s.costDeltaPct),
        first ? "" : colorDelta(s.tokenDeltaPct),
        `${Math.round(side.medLatencyMs)}ms`,
      ]);
    }
  }
  out.push(
    renderTable(
      ["model", "task", "via", "in", "out", "reasoning", "$ computed", "Δ cost", "Δ tokens", "latency"],
      rows,
    ),
  );
  out.push("");

  for (const s of summaries) {
    const name = `${s.matchup} × ${s.task}`;
    out.push(verdictLine(s.costParity, `${name}: cost parity`, s.gateway.medCost === null ? "gateway response carried no cost_usd_* fields (unpriced request)" : `gateway response cost is ${pct(s.costDeltaPct)} vs direct list price`));
    out.push(verdictLine(s.reasoningParity, `${name}: reasoning parity`, "reasoning is on for one side and off for the other (a hidden-default mismatch)"));
    if (s.tokenDrift) {
      out.push(dim(`  · ${name}: token counts drift between the two API surfaces (informational; gateway is ${pct(s.costDeltaPct)} on cost)`));
    }
    if (s.truncated) {
      out.push(yellow(`  ⚠ ${name}: at least one run hit the output-token cap — comparison unreliable, raise maxOutputTokens`));
    }
  }
  out.push("");

  const allPass = summaries.every((s) => s.costParity && s.reasoningParity && !s.truncated);
  out.push(
    allPass
      ? green(bold("  ✓ PARITY — the cost the gateway reports is at or below the direct provider's list price"))
      : red(bold("  ✗ DIVERGENCE — see failing checks above")),
  );
  out.push("");
  return out.join("\n");
}

function colorDelta(deltaPct: number): string {
  const text = pct(deltaPct);
  if (Math.abs(deltaPct) <= 2) return green(text);
  if (deltaPct > 0) return red(text);
  return green(text);
}

function verdictLine(ok: boolean, label: string, failHint: string): string {
  return ok ? green(`  ✓ ${label}`) : red(`  ✗ ${label} — ${failHint}`);
}

export function renderMarkdown(
  summaries: PairSummary[],
  results: RunResult[],
  prices: PriceTable,
  repeats: number,
  reasoningEffort: string,
): string {
  const lines: string[] = [];
  lines.push("# llm-price-parity report");
  lines.push("");
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Runs per pair: ${repeats} (values below are medians)`);
  lines.push(`- reasoning_effort (OpenAI-family): \`${reasoningEffort}\``);
  lines.push(`- Prices pinned: ${prices.retrieved} (${Object.values(prices.sources).join(", ")})`);
  lines.push("");
  lines.push("| model | task | via | input | output | reasoning | $ computed | Δ cost | Δ tokens |");
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|");
  for (const s of summaries) {
    for (const [label, side] of [["direct", s.direct], ["gateway", s.gateway]] as const) {
      lines.push(
        `| ${s.matchup} | ${s.task} | ${label} | ${side.medInput} | ${side.medOutput} | ${side.medReasoning} | ${side.medCost === null ? "—" : money(side.medCost)} | ${label === "gateway" ? pct(s.costDeltaPct) : ""} | ${label === "gateway" ? pct(s.tokenDeltaPct) : ""} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Checks");
  lines.push("");
  for (const s of summaries) {
    const name = `${s.matchup} × ${s.task}`;
    lines.push(`- ${s.costParity ? "✅" : "❌"} \`${name}\` cost parity (gateway response cost ${pct(s.costDeltaPct)} vs direct list)`);
    lines.push(`- ${s.reasoningParity ? "✅" : "❌"} \`${name}\` reasoning parity (no on/off mismatch)`);
    if (s.tokenDrift) lines.push(`- ℹ️ \`${name}\` token counts drift between API surfaces (informational)`);
    if (s.truncated) lines.push(`- ⚠️ \`${name}\` had truncated runs`);
  }
  lines.push("");
  lines.push("<details><summary>Raw runs</summary>");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(results, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("</details>");
  lines.push("");
  return lines.join("\n");
}
