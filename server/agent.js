import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function createLocalAgent(config) {
  // Isolate credentials and discovery from the user's global Pi configuration.
  const agentDir = await mkdtemp(path.join(tmpdir(), "tw-agent-"));
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerProvider("tw-local", {
      name: "Local model",
      baseUrl: config.baseUrl,
      api: "openai-completions",
      apiKey: config.apiKey,
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
    });
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
      compaction: { enabled: false },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: config.workspace,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () =>
        `You are TW, a local programming assistant. Work in the configured workspace. Explain your approach clearly, inspect files before suggesting changes, and never claim you ran something unless a tool confirms it. ${config.allowWrites ? "Write and shell tools are enabled by the operator. Avoid destructive commands." : "You are in read-only mode. Inspect files and propose changes, but do not claim to edit or run commands."}`,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: config.workspace,
      agentDir,
      modelRuntime,
      model: modelRuntime.getModel("tw-local", config.modelId),
      thinkingLevel: "off",
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      tools: config.allowWrites
        ? ["read", "ls", "find", "grep", "bash", "write", "edit"]
        : ["read", "ls", "find", "grep"],
    });
    return {
      session,
      async dispose() {
        session.dispose();
        await rm(agentDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(agentDir, { recursive: true, force: true });
    throw error;
  }
}
