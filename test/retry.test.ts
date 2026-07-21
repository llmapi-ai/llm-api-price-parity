import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenAICompatible } from "../src/providers.js";

const okBody = JSON.stringify({
  usage: { prompt_tokens: 10, completion_tokens: 5 },
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
});

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

afterEach(() => vi.restoreAllMocks());

describe("transient-failure retry", () => {
  it("retries a 429 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, "rate limited", { "retry-after": "0" }))
      .mockResolvedValueOnce(response(200, okBody));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await callOpenAICompatible("https://x/v1", "k", { model: "m" }, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.usage.inputTokens).toBe(10);
  });

  it("retries a network error then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(response(200, okBody));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await callOpenAICompatible("https://x/v1", "k", { model: "m" }, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.finishReason).toBe("stop");
  });

  it("does NOT retry a 400 (client error) — fails immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(400, "bad request"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callOpenAICompatible("https://x/v1", "k", { model: "m" }, 1000)).rejects.toThrow(
      /HTTP 400/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("strips temperature and retries when the model rejects it as deprecated", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      if (bodies.length === 1) {
        return response(400, JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } }));
      }
      return response(200, okBody);
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await callOpenAICompatible("https://x/v1", "k", { model: "m", temperature: 0 }, 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect("temperature" in bodies[0]!).toBe(true); // first attempt sent it
    expect("temperature" in bodies[1]!).toBe(false); // retry dropped it
    expect(outcome.usage.inputTokens).toBe(10);
  });

  it("does NOT strip temperature for an unrelated 400", async () => {
    const fetchMock = vi.fn(async () => response(400, JSON.stringify({ error: { message: "invalid model" } })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      callOpenAICompatible("https://x/v1", "k", { model: "m", temperature: 0 }, 1000),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_ATTEMPTS on persistent 503", async () => {
    // Fresh Response per call: a Response body can only be read once.
    const fetchMock = vi.fn(async () => response(503, "unavailable", { "retry-after": "0" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callOpenAICompatible("https://x/v1", "k", { model: "m" }, 1000)).rejects.toThrow(
      /HTTP 503/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
