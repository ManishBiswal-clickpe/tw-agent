import path from "node:path";
import { realpathSync, statSync } from "node:fs";

import { THINKING_LEVELS, type AppConfig, type ThinkingSetting } from "./types.ts";

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const number = (key: string, fallback: number, max: number) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`Invalid ${key}`);
    return value;
  };
  const baseUrl = new URL(
    env.FLASHLET_MODEL_BASE_URL || "http://127.0.0.1:8080/v1",
  );
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
  const thinking = (env.FLASHLET_THINKING || "off") as ThinkingSetting;
  if (!THINKING_LEVELS.includes(thinking))
    throw new Error("Invalid FLASHLET_THINKING");
  return {
    thinking,
    port: number("PORT", 3210, 65535),
    workspace,
    baseUrl: baseUrl.href.replace(/\/$/, ""),
    apiVersion: env.FLASHLET_MODEL_API_VERSION || undefined,
    modelApi:
      env.FLASHLET_MODEL_API === "responses"
        ? "openai-responses"
        : "openai-completions",
    authHeader:
      env.FLASHLET_MODEL_AUTH_HEADER === "api-key" ? "api-key" : "bearer",
    modelId: env.FLASHLET_MODEL_ID || "local-model",
    apiKey: env.FLASHLET_MODEL_API_KEY || "local",
    contextWindow,
    maxTokens,
    allowWrites: env.FLASHLET_ALLOW_WRITES === "true",
  };
}
