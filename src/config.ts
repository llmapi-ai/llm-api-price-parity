import { readFileSync } from "node:fs";
import type { Matchup } from "./types.js";

/**
 * Each matchup pins the exact model id sent to each side. The only allowed
 * differences between the two requests are: base URL, auth header, model id.
 */
export const MATCHUPS: Matchup[] = [
  { name: "gpt-5.5", provider: "openai", directModel: "gpt-5.5", gatewayModel: "openai/gpt-5.5" },
  { name: "gpt-5.4", provider: "openai", directModel: "gpt-5.4", gatewayModel: "openai/gpt-5.4" },
  { name: "gpt-5.4-mini", provider: "openai", directModel: "gpt-5.4-mini", gatewayModel: "openai/gpt-5.4-mini" },
  { name: "gpt-5.4-nano", provider: "openai", directModel: "gpt-5.4-nano", gatewayModel: "openai/gpt-5.4-nano" },
  { name: "gpt-5.2", provider: "openai", directModel: "gpt-5.2", gatewayModel: "openai/gpt-5.2" },
  { name: "gpt-5.1", provider: "openai", directModel: "gpt-5.1", gatewayModel: "openai/gpt-5.1" },
];

export interface Env {
  openaiKey: string | undefined;
  gatewayKey: string | undefined;
  gatewayBaseUrl: string;
}

/** Minimal .env loader — real env vars always win. No dependency needed. */
export function loadDotEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key! in process.env) continue;
    process.env[key!] = rawValue!.replace(/^(["'])(.*)\1$/, "$2");
  }
}

export function readEnv(): Env {
  return {
    openaiKey: process.env.OPENAI_API_KEY,
    gatewayKey: process.env.LLMAPI_API_KEY,
    gatewayBaseUrl: process.env.LLMAPI_BASE_URL ?? "https://api.llmapi.ai/v1",
  };
}
