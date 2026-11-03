import { streamSimple as completions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

export function providerConfig(config: any): ProviderConfig {
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
      const stream = api === "openai-responses" ? responses : completions;
      return stream(model as any, context, { ...options, fetch: transport });
    },
    models: [
      {
        type: "chat",
        id: config.modelId,
        name: config.modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: config.contextWindow,
        maxTokens: config.maxTokens,
      },
    ],
  };
}
