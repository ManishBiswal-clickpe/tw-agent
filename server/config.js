import path from "node:path";
import { realpathSync, statSync } from "node:fs";

export function readConfig(env = process.env) {
  const number = (key, fallback, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const baseUrl = new URL(env.TW_MODEL_BASE_URL || "http://127.0.0.1:8080/v1");
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  )
    throw new Error("Invalid model endpoint");
  const workspace = realpathSync(path.resolve(env.TW_WORKSPACE || "."));
  if (!statSync(workspace).isDirectory())
    throw new Error("TW_WORKSPACE must be a directory");
  const contextWindow = number("TW_CONTEXT_WINDOW", 32768, 2000000);
  const maxTokens = number("TW_MAX_TOKENS", 4096, contextWindow);
  return {
    port: number("PORT", 3210, 65535),
    workspace,
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    modelId: env.TW_MODEL_ID || "local-model",
    apiKey: env.TW_MODEL_API_KEY || "local",
    contextWindow,
    maxTokens,
    allowWrites: env.TW_ALLOW_WRITES === "true",
  };
}
