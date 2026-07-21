# llm-price-parity

**A deterministic benchmark comparing [LLM API](https://llmapi.ai)'s per-token cost against the direct provider APIs.**

Same request, same pinned parameters, same published prices — so any cost difference reflects pricing, not test setup. Verify it in one command, with your own API keys.

[![CI](https://img.shields.io/badge/CI-typecheck%20%2B%20tests-brightgreen)](.github/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-339933)
![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-blueviolet)

```
┌──────────────┬──────────────┬─────────┬─────┬─────┬───────────┬────────────┬───────────┬────────┬─────────┐
│ model        │ task         │ via     │ in  │ out │ reasoning │ $ computed │ $ billed  │ Δ cost │ latency │
├──────────────┼──────────────┼─────────┼─────┼─────┼───────────┼────────────┼───────────┼────────┼─────────┤
│ gpt-5.2      │ translate-es │ direct  │ 511 │ 216 │ 0         │ $0.003918  │ —         │        │ 4764ms  │
│              │              │ gateway │ 511 │ 215 │ 0         │ $0.003904  │ $0.003904 │ -0.36% │ 4437ms  │
│ gpt-5.4-nano │ translate-es │ direct  │ 511 │ 217 │ 0         │ $0.000373  │ —         │        │ 2352ms  │
│              │              │ gateway │ 511 │ 215 │ 0         │ $0.000371  │ $0.000371 │ -0.67% │ 3398ms  │
└──────────────┴──────────────┴─────────┴─────┴─────┴───────────┴────────────┴───────────┴────────┴─────────┘

  ✓ gpt-5.2 × translate-es: cost parity
  ✓ gpt-5.2 × translate-es: reasoning parity
  ✓ gpt-5.2 × translate-es: billing parity
  ✓ gpt-5.4-nano × translate-es: cost parity
  ✓ gpt-5.4-nano × translate-es: reasoning parity
  ✓ gpt-5.4-nano × translate-es: billing parity

  ✓ PARITY — gateway is at or below direct-provider cost, billed at published rates
```

## Why this exists

[LLM API](https://llmapi.ai) is an OpenAI-compatible gateway that routes your requests to an underlying provider (this benchmark covers OpenAI today; the harness is provider-generic). For the same request, its per-token cost should be no more than calling that provider directly. But naive comparisons are easy to get wrong: an unpinned sampling parameter, a different reasoning default, or a token-accounting convention can make identical per-token prices look like a large cost gap — in either direction.

A like-for-like comparison therefore has to control *everything*: the request bodies, the sampling and reasoning parameters, the pricing table, and the cost math. This benchmark controls exactly those and nothing else. It's ~900 lines of TypeScript with zero runtime dependencies, so you can read the whole thing.

## Methodology

1. **Byte-identical requests.** The only differences between the two requests in a comparison are the base URL, the auth header, and the model id prefix (`gpt-5.2` vs `openai/gpt-5.2`). Everything else — messages, sampling params, and the structured-output schema below — is identical. `--show-requests` prints both bodies so you can diff them yourself.
2. **No provider defaults trusted.** Every parameter that affects token generation is pinned explicitly: `temperature 0`, `top_p 1`, a fixed `seed`, an output-token cap, and `reasoning_effort` sent explicitly to **both** sides.
3. **Structured outputs pin the response shape.** Each task sends a strict JSON schema via `response_format: json_schema`, identical on both sides. Constrained decoding fixes the output *structure and whitespace*, so the same request produces the same token count run-to-run. Without this, a model that pretty-prints its JSON on one call and minifies it on the next makes cost swing tens of percent for no real reason — pure formatting noise, not a pricing difference.
4. **One pricing table, both sides.** Costs are computed from each response's `usage` block using [prices.json](prices.json) — published provider rates, pinned with source links and a retrieval date, applied by the **same function** to both sides.
5. **Reasoning tokens counted once, across differing conventions.** Reasoning bills at the plain output rate. Some APIs fold reasoning *into* `completion_tokens`; others report it *separately*. Output is derived convention-independently as `total_tokens − prompt_tokens`, so reasoning is counted exactly once on both sides — counting it twice (or comparing raw `completion_tokens` across the two) is a common token-accounting error.
6. **Billed cost is cross-checked.** When the gateway self-reports what it billed (`usage.cost_usd_*` fields), that number is verified to **not exceed** published per-token rates. Billing at or below — list price, or any volume discount — passes; only a markup fails. This is a check matching token counts alone would not provide.
7. **Auditable.** Zero runtime dependencies, ~900 lines of TypeScript, raw per-run results dumped into every report.

## What it checks

| Check | Question it answers | What a failure indicates |
|---|---|---|
| **Cost parity** | For the same request, does the gateway cost more than going direct? (one-directional — cheaper is fine) | The gateway costs more than the provider for the same request — e.g. from a differing reasoning default |
| **Reasoning parity** | Is reasoning on for one side but off for the other? | A reasoning on/off mismatch — one side spends reasoning tokens the other doesn't |
| **Billing parity** | Does the gateway's self-reported billed cost stay at or below published per-token rates? | The billed rate exceeds the published per-token rates (a markup) |

All pass → the gateway costs at most what the provider would have for the same request. The process exits non-zero on any failure, so you can run it in CI.

Scope: this isolates **per-token price** for a given model — that the gateway bills at the providers' published rates. Routing, caching, and volume discounts are separate mechanisms and out of scope here.

**Why not require identical token counts?** Structured outputs make them nearly identical, but not exactly. Two sources of legitimate variance remain: free-text *content* inside the schema (e.g. how a translation is phrased varies by a few tokens), and — with reasoning on — the number of hidden reasoning tokens, which no seed controls. Cost parity absorbs that jitter (median + a 10% one-directional band) while still catching a real blow-up; reasoning parity catches the categorical on/off case. Any residual token drift is surfaced as an **informational** note, never a failure.

Token-count drift is surfaced for transparency; the pass/fail verdict rests on **cost** and **billing**, which are what you actually pay.

### Determinism & consistency

Everything the API allows is pinned: `temperature 0`, `top_p 1`, an explicit `seed`, an output-token cap, `reasoning_effort` sent explicitly to both sides, and a strict `response_format` schema per task so constrained decoding fixes the output shape. That last one matters most in practice: it removes the pretty-print-vs-minify formatting swings that otherwise dominate run-to-run token variance. Some noise is still inherent and not fixable: LLMs aren't bit-deterministic even at `temperature 0`. (The newest reasoning-first models reject `temperature` entirely; when a model does, the request is transparently retried without it — those models don't expose a determinism knob anyway.) We absorb the remaining noise rather than pretend it away:

- **Repeat and take the median.** `--repeats` (default 5) runs each pair N times; every reported figure is the median, so a couple of outliers can't decide a verdict (median-of-5 survives two bad runs). Prefer **odd** values — an even count medians the two middle runs and can report fractional tokens. Lower it (`--repeats 3`) when benchmarking expensive models or `web_search`, where each extra run has real cost.
- **Retry transient failures.** Each call retries up to 4 times with exponential backoff (honoring `Retry-After`) on 429/5xx/network errors, so one rate-limit can't abort a multi-run pass. Genuine client errors (4xx) fail fast.

## Quick start

```bash
git clone <this-repo> && cd llm-price-parity
npm install                     # dev tooling only; zero runtime deps
cp .env.example .env            # add your keys

npm run bench                   # all models & tasks, 5 runs each
```

Useful variations:

```bash
npm run bench -- --models gpt-5.2 --tasks translate-es      # one matchup, one task
npm run bench -- --repeats 3                                # fewer runs (cheaper for pricey models / web_search)
npm run bench -- --reasoning-effort medium                  # compare WITH reasoning on (pinned on both sides)
npm run bench -- --show-requests                            # print the exact bodies sent to each side
npm run bench -- --list                                     # available matchups & tasks
```

Every run also writes a markdown report with the raw per-run data to `results/`.

## Tasks

Three small, representative production workloads — all JSON-in/JSON-out, each with a strict `response_format` JSON schema (see `responseSchema` in the task files) so the output shape is pinned on both sides:

- **translate-es** — app localization: translate a fitness app's UI-strings JSON to Spanish, preserving structure.
- **extract-order** — structured extraction from a confirmation email.
- **classify-tickets** — category + sentiment labeling of support tickets.

## Adding a model or provider

1. Add its published rates to [prices.json](prices.json) with a source link.
2. Add a matchup to `MATCHUPS` in [src/config.ts](src/config.ts).
3. If it's a new provider family, add a body builder + usage normalizer in [src/providers.ts](src/providers.ts).

## FAQ

**Why medians and not means?** One retried or rate-limited outlier shouldn't decide the verdict.

**Why does the gateway show a `$ billed` column but the direct side doesn't?** Direct provider responses don't include cost; their bill *is* published rate × usage, which is the `$ computed` column. The gateway additionally self-reports what it billed, so we can verify it against the same rates.

**Prices changed — is the benchmark wrong now?** Update `prices.json` in a PR. Pinning prices in git is deliberate: every historical report states which price sheet it used.

## License

[MIT](LICENSE)
