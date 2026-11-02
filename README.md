# Flashlet

A local-first coding workbench: browser UI → Node + Pi SDK → your OpenAI-compatible model server. No hosted model is configured by default.

## Quick start

Requires **Node.js 22.19+** and a running model server that supports **streaming Chat Completions and tool calls**.

```sh
npm ci
cp .env.example .env
# Set FLASHLET_WORKSPACE, FLASHLET_MODEL_BASE_URL and FLASHLET_MODEL_ID in .env
npm run dev
```

Open **http://127.0.0.1:3210**. Start your model server separately; Flashlet does not download weights or launch inference.

Example configuration for a compatible local server:

```dotenv
FLASHLET_WORKSPACE=/absolute/path/to/your/project
FLASHLET_MODEL_BASE_URL=http://127.0.0.1:8080/v1
FLASHLET_MODEL_ID=local-model
FLASHLET_CONTEXT_WINDOW=32768
FLASHLET_MAX_TOKENS=4096
FLASHLET_ALLOW_WRITES=false
```

Use the model ID actually exposed by your server (`/v1/models` is often useful). FreeToken and llama.cpp are intended targets, but their model-specific tool-call templates and compatibility still need testing. There is no claim that every OpenAI-compatible endpoint supports agent tool calls. Match the context/output limits to the loaded model. If your server requires authentication, set `FLASHLET_MODEL_API_KEY` in `.env`. For a server on another machine, the configured endpoint can send code and prompts there, so choose it deliberately.

## What it does

- Stream chat responses over SSE and show Pi tool calls/results.
- Keep separate tasks in memory, with task switching and cancellation.
- Explore workspace files and preview text files up to 200 KB.
- View tracked working-tree changes against `HEAD`, with added/removed lines.
- Run Pi's actual agent loop in Node, not a browser-side imitation or CLI subprocess.
- Start read-only (`read`, `ls`, `find`, `grep`). Set `FLASHLET_ALLOW_WRITES=true` and restart to enable `bash`, `write`, and `edit`.
- Use a responsive three-panel desktop layout and compact mobile chat/task switcher.

**Tasks are ephemeral:** browser refresh loses the task UI; restarting the server loses all conversations. Disconnected idle sessions are cleaned up after an hour. There are at most eight server sessions; use New task to replace the oldest idle task when the UI reaches that limit. This is a single-operator development tool, not a multi-user service.

## Safety boundaries

The HTTP server binds to `127.0.0.1`, validates Host/Origin, rejects cross-origin writes, and never sends the model API key to the browser. Do not expose it through a public proxy or tunnel. It has no login or remote-access security model.

**Pi tools are not sandboxed.** Read-only mode prevents tool-driven writes, not access to every sensitive file. Tools run with your OS permissions and may read paths outside the configured workspace. Write/shell mode can modify or execute anything your user can. Use a disposable checkout, container or restricted OS user for untrusted code/model output. Global Pi credentials, extensions, skills and project instruction discovery are not loaded; the app uses an isolated temporary agent directory and in-memory history. This does not make model-generated tool calls safe.

The file browser rejects traversal/outside symlinks and hides `.env`, `.git`, common private-key files and dependency directories. Those are convenience protections, not a complete secret detector. Git diff omits `.env` and common private-key files; other tracked secrets could still appear. Do not select a workspace containing secrets. Model output is rendered as text, never raw HTML.

## Architecture

```text
public/           Plain JavaScript + CSS browser workbench (no build step)
server/index.js   Express, session lifecycle, SSE, same-origin checks
server/agent.js   Pi SDK setup, local model provider, explicit tool allowlist
server/files.js   File preview and tracked Git diff
server/config.js Environment validation
```

The SDK is pinned to `@earendil-works/pi-coding-agent@1.4.0`. The `minimatch` and `undici` overrides select patched transitive versions; the real SDK integration tests run against those versions. Configuration stays server-side. Model adapters/endpoint tuning can be added without changing the UI transport.

## Verification

```sh
npm run check
npm test
npm audit --omit=dev
# Optional browser smoke test (system Chrome, or CHROME_PATH)
npm run test:ui
```

Backend tests exercise the **real SDK** against a deterministic, local OpenAI-compatible fixture: streamed text, a read-tool round trip, concurrent-prompt rejection, cancellation, session deletion, configuration validation, host/origin checks, and file-path protections. The optional browser smoke test checks desktop/mobile layout, real chat/tool rendering, task switching, file preview, diff, and Stop. Screenshots go to `test-results/` (not committed). The fixture is only test infrastructure; normal app startup never uses a fake model. No actual LFM2.5 weights or GPU inference are exercised by these tests.

Pi SDK references: https://pi.dev/docs/latest/sdk and https://pi.dev/docs/latest/models

## Next steps

- Test the intended model/server combination on the target laptop.
- Add session persistence and resumable task history.
- Add explicit tool approvals and OS-level execution isolation before broader use.
- Improve the diff pane with file selection and untracked-file support.
