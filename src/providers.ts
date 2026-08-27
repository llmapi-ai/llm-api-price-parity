import type { Task, Usage } from "./types.js";

export interface CallOutcome {
  usage: Usage;
  /** Sum of the response's own cost_usd_* fields — the price the API itself reported. null when absent (direct OpenAI). */
  apiReportedCostUSD: number | null;
  latencyMs: number;
  finishReason: string;
  text: string;
  requestBody: Record<string, unknown>;
}

export interface CallOptions {
  /** Explicit reasoning effort for OpenAI-family models. Never left to defaults. */
  reasoningEffort: string;
  seed: number;
  timeoutMs: number;
}

const TIMEOUT_DEFAULT = 190_000;

/** Transient statuses worth retrying: rate limits, request timeout, 5xx. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A single call is retried on transient failures so one rate-limit or blip
 * can't abort a whole multi-repeat run. Backoff is deterministic exponential
 * (no random jitter — we only ever have two concurrent requests), and honors a
 * Retry-After header when the server sends one. Non-retryable errors (4xx other
 * than 408/429) throw immediately.
 */
async function post(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ json: Record<string, unknown>; latencyMs: number }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const latencyMs = performance.now() - started;
      const raw = await response.text();
      if (response.ok) {
        return { json: JSON.parse(raw) as Record<string, unknown>, latencyMs };
      }
      const err = new Error(`${url} → HTTP ${response.status}: ${raw.slice(0, 400)}`);
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
      await sleep(retryAfterMs(response) ?? BACKOFF_BASE_MS * 2 ** (attempt - 1));
    } catch (error) {
      // fetch() throws on network failure / AbortSignal timeout — both transient.
      if (error instanceof Error && error.message.startsWith(url)) throw error;
      if (attempt === MAX_ATTEMPTS) throw error;
      lastError = error;
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** Newer reasoning-first models reject `temperature` outright rather than ignoring it. */
const TEMPERATURE_UNSUPPORTED =
  /temperature[^.]{0,50}(deprecated|unsupported|not supported|does not support|cannot)|(unsupported|invalid|unexpected)[^.]{0,20}temperature/i;

/**
 * Sends a request, and if the provider rejects `temperature` as
 * deprecated/unsupported (as the newest reasoning-first models do), transparently
 * retries once without it. Detection is by the error message, so it adapts to
 * any current or future model without a hardcoded per-model flag.
 */
async function postWithParamFallback(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ json: Record<string, unknown>; latencyMs: number }> {
  try {
    return await post(url, headers, body, timeoutMs);
  } catch (error) {
    if (error instanceof Error && "temperature" in body && TEMPERATURE_UNSUPPORTED.test(error.message)) {
      const { temperature: _temperature, ...rest } = body;
      return post(url, headers, rest, timeoutMs);
    }
    throw error;
  }
}

/**
 * Builds the OpenAI-family chat.completions body. The SAME body goes to the
 * direct API and to the gateway — only the model id differs.
 *
 * Sampling params (temperature/top_p/seed) are sent only with
 * reasoning_effort "none": OpenAI rejects or ignores them once reasoning is
 * on, and a controlled benchmark sends nothing one side could interpret differently.
 */
export function buildOpenAIBody(model: string, task: Task, opts: CallOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: task.messages,
    max_completion_tokens: task.maxOutputTokens,
    reasoning_effort: opts.reasoningEffort,
  };
  if (opts.reasoningEffort === "none") {
    body.temperature = 0;
    body.top_p = 1;
    body.seed = opts.seed;
  }
  if (task.responseSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: task.name.replace(/[^a-zA-Z0-9_]/g, "_"), strict: true, schema: task.responseSchema },
    };
  }
  return body;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  reasoning_tokens?: number;
  cost_usd_input?: number;
  cost_usd_output?: number;
  cost_usd_cached_input?: number;
  cost_usd_reasoning?: number;
  cost_usd_request?: number;
  cost_usd_web_search?: number;
}

/**
 * OpenAI-family responses disagree on whether `completion_tokens` includes
 * reasoning tokens: OpenAI's native API folds reasoning INTO completion_tokens,
 * while the gateway reports completion_tokens as visible-only and bills
 * reasoning separately. Comparing raw completion_tokens across the two would be
 * apples-to-oranges (and would falsely flag the gateway as cheaper).
 *
 * Both surfaces agree that total_tokens = prompt + visible + reasoning, so
 * `outputTokens` is derived as total − prompt — the total billable output
 * (reasoning included) regardless of convention. `reasoningTokens` is kept as
 * the (already-included) subset, for display only.
 */
export function normalizeOpenAIUsage(usage: OpenAIUsage): Usage {
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens ?? 0;
  const total = usage.total_tokens ?? 0;

  let output: number;
  if (total > prompt) {
    output = total - prompt; // convention-independent, preferred
  } else if (completion < reasoning) {
    output = completion + reasoning; // completion clearly excludes reasoning
  } else {
    output = completion; // reasoning already folded in (OpenAI native), or none
  }

  return {
    inputTokens: prompt,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: output,
    reasoningTokens: reasoning,
  };
}

const COST_USD_FIELDS = [
  "cost_usd_input",
  "cost_usd_output",
  "cost_usd_cached_input",
  "cost_usd_reasoning",
  "cost_usd_request",
  "cost_usd_web_search",
] as const;

/**
 * Sum of the gateway's self-reported cost_usd_* components, or null when absent.
 * The gateway includes these fields in its usage block; direct OpenAI omits them.
 */
export function billedFromUsage(usage: Record<string, unknown>): number | null {
  const parts = COST_USD_FIELDS.map((k) => usage[k]).filter((v): v is number => typeof v === "number");
  if (parts.length === 0) return null;
  return parts.reduce((a, b) => a + b, 0);
}

/** OpenAI direct, or any OpenAI-compatible gateway (chat.completions). */
export async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs = TIMEOUT_DEFAULT,
): Promise<CallOutcome> {
  const { json, latencyMs } = await postWithParamFallback(
    `${baseUrl}/chat/completions`,
    { Authorization: `Bearer ${apiKey}` },
    body,
    timeoutMs,
  );
  const usage = (json.usage ?? {}) as OpenAIUsage;
  const choice = (json.choices as { message?: { content?: string }; finish_reason?: string }[] | undefined)?.[0];
  return {
    usage: normalizeOpenAIUsage(usage),
    apiReportedCostUSD: billedFromUsage(usage as Record<string, unknown>),
    latencyMs,
    finishReason: choice?.finish_reason ?? "unknown",
    text: choice?.message?.content ?? "",
    requestBody: body,
  };
}
