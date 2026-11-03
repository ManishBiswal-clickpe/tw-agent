import path from "node:path";
import { realpathSync, statSync } from "node:fs";

export function readConfig(env = process.env) {
  const number = (key, fallback, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const baseUrl = new URL(env.FLASHLET_MODEL_BASE_URL || "http://127.0.0.1:8080/v1");
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  )
    throw new Error("Invalid model endpoint");
  const workspace = realpathSync(path.resolve(env.FLASHLET_WORKSPACE || "."));
  if (!statSync(workspace).isDirectory())
    throw new Error("FLASHLET_WORKSPACE must be a directory");
  const contextWindow = number("FLASHLET_CONTEXT_WINDOW", 32768, 2000000);
  const maxTokens = number("FLASHLET_MAX_TOKENS", 4096, contextWindow);
  return {
    port: number("PORT", 3210, 65535),
    workspace,
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    modelId: env.FLASHLET_MODEL_ID || "local-model",
    apiKey: env.FLASHLET_MODEL_API_KEY || "local",
    contextWindow,
    maxTokens,
    allowWrites: env.FLASHLET_ALLOW_WRITES === "true",
  };
}
