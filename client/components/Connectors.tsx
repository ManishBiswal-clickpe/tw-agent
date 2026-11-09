import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConnectorPanelResponse,
  McpConfigView,
  MutationResult,
} from "../../shared/api.ts";
import { api, errorMessage, post } from "../api.ts";
import { Modal } from "./Modal.tsx";

const PRESET_URLS: Record<string, string> = {
  notion: "https://mcp.notion.com/mcp",
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  custom: "",
};

function McpEditor({ onSaved }: { onSaved: () => void }) {
  const [scope, setScope] = useState<"global" | "project">("global");
  const [json, setJson] = useState("");
  const [note, setNote] = useState("");
  const config = useQuery({
    queryKey: ["mcp-config", scope],
    queryFn: () => api<McpConfigView>(`/api/mcp-config?scope=${scope}`),
  });
  // Load JSON whenever the server copy changes; show the default hint only
  // when a scope is first loaded so save/trust messages are not overwritten.
  const hinted = useRef<string | null>(null);
  useEffect(() => {
    if (config.data) {
      setJson(config.data.json);
      if (hinted.current === scope) return;
      hinted.current = scope;
      setNote(
        scope === "project" && !config.data.trusted
          ? "Project config is not loaded until you trust this workspace."
          : "Saved secrets/arguments are masked; keep placeholders to preserve them.",
      );
    }
  }, [config.data, scope]);
  const save = useMutation({
    mutationFn: () => {
      JSON.parse(json);
      return api<MutationResult>("/api/mcp-config", {
        method: "PUT",
        body: JSON.stringify({ scope, json, revision: config.data?.revision }),
      });
    },
    onSuccess: async (r) => {
      await config.refetch();
      setNote(r.note || "Saved");
      onSaved();
    },
    onError: (e) => setNote(errorMessage(e)),
  });
  const trust = useMutation({
    mutationFn: (trusted: boolean) =>
      post<MutationResult>("/api/mcp-trust", { trusted }),
    onSuccess: async (r) => {
      await config.refetch();
      setNote(r.note || "Updated");
      onSaved();
    },
    onError: (e) => setNote(errorMessage(e)),
  });
  return (
    <details className="card" id="mcp-editor">
      <summary>Edit mcp.json (global / project)</summary>
      <div className="form">
        <label>
          Scope
          <select
            id="mcp-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "global")}
          >
            <option value="global">Global (default)</option>
            <option value="project">This project (.pi/mcp.json)</option>
          </select>
        </label>
        <code className="muted small">{config.data?.path}</code>
        <textarea
          id="mcp-json"
          rows={12}
          spellCheck={false}
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className="mono"
        />
        <div id="mcp-editor-notice" className="muted small">
          {note}
        </div>
        <div className="form-actions">
          <button
            id="mcp-trust"
            type="button"
            className="button ghost"
            onClick={() => {
              const next = !config.data?.trusted;
              if (
                next &&
                !confirm(
                  "Trust this workspace? Project MCP configuration can start local executables and contact external services.",
                )
              )
                return;
              trust.mutate(next);
            }}
          >
            {config.data?.trusted ? "Revoke project trust" : "Trust this project"}
          </button>
          <button type="button" className="button ghost" onClick={() => config.refetch()}>
            Reload
          </button>
          <button
            id="mcp-save"
            type="button"
            className="button primary"
            onClick={() => save.mutate()}
          >
            Validate and save
          </button>
        </div>
      </div>
    </details>
  );
}

export function ConnectorsModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const [note, setNote] = useState("");
  const [preset, setPreset] = useState("custom");
  const [redirect, setRedirect] = useState("");
  const panel = useQuery({
    queryKey: ["connectors"],
    queryFn: () => api<ConnectorPanelResponse>("/api/connectors"),
    refetchInterval: 1500,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["connectors"] });
  const act = useMutation({
    mutationFn: ({ name, action }: { name: string; action: string }) =>
      api<MutationResult>(
        `/api/connectors/${encodeURIComponent(name)}${action === "remove" ? "" : "/" + action}`,
        {
          method: action === "remove" ? "DELETE" : "POST",
          body: action === "remove" ? undefined : "{}",
        },
      ),
    onSuccess: (r) => {
      setNote(r.note || "Working…");
      void refresh();
    },
    onError: (e) => setNote(errorMessage(e)),
  });
  const save = useMutation({
    mutationFn: (form: HTMLFormElement) => {
      const value = Object.fromEntries(new FormData(form));
      return api<MutationResult>("/api/connectors", {
        method: "PUT",
        body: JSON.stringify({
          ...value,
          callbackPort: Number(value.callbackPort) || undefined,
          args: JSON.parse(String(value.args || "[]")),
          env: JSON.parse(String(value.env || "{}")),
          headers: JSON.parse(String(value.headers || "{}")),
          readOnly: value.readOnly === "on",
          enabled: true,
        }),
      });
    },
    onSuccess: (r) => {
      setNote(r.note || "Saved");
      void refresh();
    },
    onError: (e) => setNote(errorMessage(e)),
  });
  const data = panel.data;
  let authUrl: URL | undefined;
  try {
    authUrl = data?.url ? new URL(data.url) : undefined;
  } catch {
    /* ignore */
  }
  return (
    <Modal title="Connectors" onClose={onClose} wide id="connectors-dialog">
      <p className="muted">
        Connect MCP tools to your workspace. Credentials stay on this machine.
        Changes apply to new chats.
      </p>
      <div id="connector-notice" role="status" className={note ? "notice" : ""}>
        {note}
      </div>
      <McpEditor onSaved={refresh} />
      <div className="connector-list">
        {data?.connectors.map((c) => (
          <section key={c.name} className="card connector connector-card">
            <div>
              <strong>{c.name}</strong>
              <p className="muted small">
                {c.target} · {c.enabled ? "enabled" : "disabled"} ·{" "}
                {c.readOnly ? "read-only" : "write access requested"}
              </p>
            </div>
            <div className="chip-row">
              {(
                [
                  [c.readOnly ? "Allow writes" : "Read-only", "permission"],
                  [c.enabled ? "Disable" : "Enable", "toggle"],
                  ["Sign in", "login"],
                  ["Status", "status"],
                  ["Reconnect", "reconnect"],
                  ["Sign out", "logout"],
                  ["Remove", "remove"],
                ] as const
              ).map(([label, action]) => (
                <button
                  key={action}
                  type="button"
                  className={`chip ${action === "remove" ? "danger" : ""}`}
                  disabled={data.busy}
                  onClick={() => {
                    if (
                      action === "remove" &&
                      !confirm("Remove connector and sign out?")
                    )
                      return;
                    if (
                      action === "permission" &&
                      c.readOnly &&
                      !confirm(
                        "Allow this connector to modify data? Retrieved content may contain malicious instructions. Only proceed with a trusted server.",
                      )
                    )
                      return;
                    act.mutate({ name: c.name, action });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        ))}
        {data && !data.connectors.length && (
          <div className="empty">No connectors yet.</div>
        )}
      </div>
      {(data?.notifications.length || data?.tools?.length || data?.busy) && (
        <pre className="code-view small">
          {data.notifications.join("\n")}
          {data.tools?.length
            ? `\nTools: ${data.tools.map((t) => t.name).join(", ")}`
            : ""}
          {data.busy ? "\nWorking…" : ""}
        </pre>
      )}
      {authUrl?.protocol === "https:" && (
        <a className="button primary" href={authUrl.href} target="_blank" rel="noopener noreferrer">
          Continue sign-in in your browser
        </a>
      )}
      {data?.pendingInput && (
        <form
          className="form card"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await post("/api/connectors/redirect", { url: redirect });
              setRedirect("");
              void refresh();
            } catch (err) {
              setNote(errorMessage(err));
            }
          }}
        >
          <label>
            Callback URL (only if automatic sign-in cannot reach this machine)
            <input value={redirect} onChange={(e) => setRedirect(e.target.value)} />
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="button ghost"
              onClick={() => post("/api/connectors/cancel").then(refresh)}
            >
              Cancel sign-in
            </button>
            <button className="button primary">Complete sign-in</button>
          </div>
        </form>
      )}
      <form
        className="form card"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(e.currentTarget);
        }}
      >
        <h3>Add or replace connector</h3>
        <div className="grid-2">
          <label>
            Preset
            <select
              id="connector-preset"
              name="preset"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value);
                setNote(
                  e.target.value === "gmail"
                    ? "This official Google Gmail MCP may require Developer Preview access and your own OAuth client. Already use a Gmail MCP in pi? Add that server URL or stdio command via Custom MCP. Gmail send/draft tools are enabled by default; use the permission switch to restrict them."
                    : "Custom stdio commands run on your machine. Only connect trusted servers.",
                );
              }}
            >
              <option value="custom">Custom MCP</option>
              <option value="gmail">Gmail</option>
              <option value="notion">Notion</option>
            </select>
          </label>
          <label>
            Name
            <input
              id="connector-name"
              key={`name-${preset}`}
              name="name"
              required
              pattern="[a-zA-Z0-9_-]+"
              maxLength={64}
              defaultValue={preset === "custom" ? "" : preset}
              placeholder="my-notion"
            />
          </label>
        </div>
        <label>
          Streamable HTTP URL
          <input
            id="connector-url"
            key={`url-${preset}`}
            name="url"
            defaultValue={PRESET_URLS[preset]}
            placeholder="https://example.com/mcp"
          />
        </label>
        <label>
          Bearer token (optional)
          <input name="token" type="password" />
        </label>
        <details>
          <summary>OAuth client or custom headers</summary>
          <div className="grid-2">
            <label>
              Client ID
              <input name="clientId" />
            </label>
            <label>
              Client secret
              <input name="clientSecret" type="password" />
            </label>
            <label>
              Callback port
              <input name="callbackPort" type="number" min={1024} max={65535} placeholder="8765" />
            </label>
            <label>
              Scope
              <input name="scope" />
            </label>
          </div>
          <label>
            Headers JSON
            <textarea name="headers" className="mono" placeholder='{"X-API-Key":"..."}' />
          </label>
        </details>
        <details>
          <summary>Local stdio server (runs a trusted executable)</summary>
          <label>
            Command
            <input name="command" placeholder="npx" />
          </label>
          <label>
            Arguments JSON
            <textarea name="args" className="mono" placeholder='["-y", "your-mcp-package"]' />
          </label>
          <label>
            Environment JSON
            <textarea name="env" className="mono" placeholder='{"API_KEY":"${MY_API_KEY}"}' />
          </label>
        </details>
        <label className="checkbox">
          <input
            key={`ro-${preset}`}
            name="readOnly"
            type="checkbox"
            defaultChecked={preset !== "gmail"}
          />
          Read-only tools only
        </label>
        <div className="form-actions">
          <button type="submit" className="button primary" disabled={save.isPending}>
            Save connector
          </button>
        </div>
      </form>
    </Modal>
  );
}
