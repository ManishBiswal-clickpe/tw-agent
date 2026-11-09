import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

import type { AppConfig } from "./types.ts";

export function providerConfig(config: AppConfig): ProviderConfig {
  const api = config.modelApi || "openai-completions";
  // Pi supplies its full hooks/options. Only transport URL/query/auth are adapted here.
  const transport: typeof fetch = (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url || String(input));
    if (config.apiVersion)
      url.searchParams.set("api-version", config.apiVersion);
    const headers = new Headers(init?.headers || request?.headers);
    if (config.authHeader === "api-key") {
      headers.delete("Authorization");
      headers.set("api-key", config.apiKey);
    }
    return fetch(request ? new Request(url, request) : url, {
      ...init,
      headers,
    });
  };
  return {
    name: "OpenAI-compatible endpoint",
    baseUrl: config.baseUrl,
    api,
    apiKey: config.apiKey,
    streamSimple: (model, context, options) => {
      return api === "openai-responses"
        ? responses(model as Model<"openai-responses">, context, {
            ...options,
            fetch: transport,
          })
        : completions(model as Model<"openai-completions">, context, {
            ...options,
            fetch: transport,
          });
    },
    models: [
      {
        type: "chat",
        id: config.modelId,
        name: config.modelId,
        reasoning: config.thinking !== "off",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
        // Send reasoning_effort only when thinking is requested; llama.cpp/vLLM
        // stream reasoning_content, which Pi surfaces as thinking deltas.
        compat: { supportsReasoningEffort: config.thinking !== "off" },
      },
    ],
  };
}
