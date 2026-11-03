const $ = (id: string) => document.getElementById(id)!;
async function api(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Flashlet-Client": "workbench",
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function note(text: string) {
  $("connector-notice").textContent = text;
}
let timer: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api("/api/connectors");
    const list = $("connector-list");
    list.replaceChildren();
    for (const entry of data.connectors) {
      const row = document.createElement("section");
      row.className = "connector-card";
      const heading = document.createElement("strong");
      heading.textContent = entry.name;
      const desc = document.createElement("p");
      desc.textContent = `${entry.target} · ${entry.enabled ? "enabled" : "disabled"} · ${entry.readOnly ? "read-only" : "write access requested"}`;
      row.append(heading, desc);
      for (const [label, action] of [
        [entry.readOnly ? "Allow writes" : "Read-only", "permission"],
        [entry.enabled ? "Disable" : "Enable", "toggle"],
        ["Sign in", "login"],
        ["Status / tools", "status"],
        ["Reconnect", "reconnect"],
        ["Sign out", "logout"],
        ["Remove", "remove"],
      ]) {
        const button = document.createElement("button");
        button.textContent = label;
        button.disabled = data.busy;
        button.onclick = async () => {
          if (
            action === "remove" &&
            !confirm(
              "Remove connector and sign out? Close existing tasks to drop their in-memory access.",
            )
          )
            return;
          if (
            action === "permission" &&
            entry.readOnly &&
            !confirm(
              "Allow this connector to modify data? For Gmail this includes send/draft tools. Retrieved messages may contain malicious instructions. Only proceed with a trusted server.",
            )
          )
            return;
          try {
            const result = await api(
              `/api/connectors/${encodeURIComponent(entry.name)}${action === "remove" ? "" : "/" + action}`,
              {
                method: action === "remove" ? "DELETE" : "POST",
                body: action === "remove" ? undefined : "{}",
              },
            );
            note(result.note || "Working…");
            await refresh();
          } catch (error: any) {
            note(error.message);
          }
        };
        row.append(button);
      }
      list.append(row);
    }
    $("connector-status").textContent =
      data.notifications.join("\n") +
      (data.tools?.length
        ? "\nTools: " + data.tools.map((t: any) => t.name).join(", ")
        : "") +
      (data.busy ? "\nWorking…" : "");
    const link = $("oauth-link") as HTMLAnchorElement;
    let safeUrl: URL | undefined;
    try {
      safeUrl = new URL(data.url);
    } catch {
      /* no auth URL */
    }
    link.hidden = !safeUrl || safeUrl.protocol !== "https:";
    if (!link.hidden) link.href = safeUrl!.href;
    $("redirect-form").hidden = !data.pendingInput;
  } catch (error: any) {
    note(error.message);
  } finally {
    refreshing = false;
  }
}
const dialog = $("connectors-dialog") as HTMLDialogElement;
$("open-connectors").onclick = () => {
  dialog.showModal();
  void refresh();
  timer = setInterval(() => void refresh(), 1500);
};
dialog.addEventListener("close", () => {
  clearInterval(timer);
  timer = undefined;
});
$("close-connectors").onclick = () => dialog.close();
$("connector-preset").onchange = () => {
  const preset = ($("connector-preset") as HTMLSelectElement).value;
  ($("connector-name") as HTMLInputElement).value =
    preset === "custom" ? "" : preset;
  ($("connector-url") as HTMLInputElement).value =
    preset === "notion"
      ? "https://mcp.notion.com/mcp"
      : preset === "gmail"
        ? "https://gmailmcp.googleapis.com/mcp/v1"
        : "";
  ($("connector-readonly") as HTMLInputElement).checked = preset !== "gmail";
  note(
    preset === "gmail"
      ? "This official Google Gmail MCP may require Developer Preview access and your own OAuth client. Already use a Gmail MCP in pi? Add that server URL or stdio command via Custom MCP. Gmail send/draft tools are enabled by default; use the permission switch to restrict them."
      : "Custom stdio commands run on your machine. Only connect trusted servers.",
  );
};
$("connector-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.target as HTMLFormElement);
  try {
    const value = Object.fromEntries(form);
    const body = {
      ...value,
      callbackPort: Number(value.callbackPort) || undefined,
      args: JSON.parse(String(value.args || "[]")),
      env: JSON.parse(String(value.env || "{}")),
      headers: JSON.parse(String(value.headers || "{}")),
      readOnly: value.readOnly === "on",
      enabled: true,
    };
    const result = await api("/api/connectors", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    for (const id of ["connector-token", "connector-secret"])
      ($(id) as HTMLInputElement).value = "";
    note(result.note);
    await refresh();
  } catch (error: any) {
    note(error.message);
  }
};
$("cancel-oauth").onclick = async () => {
  try {
    await api("/api/connectors/cancel", { method: "POST", body: "{}" });
    await refresh();
  } catch (error: any) {
    note(error.message);
  }
};
$("redirect-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("/api/connectors/redirect", {
      method: "POST",
      body: JSON.stringify({
        url: ($("redirect-url") as HTMLInputElement).value,
      }),
    });
    ($("redirect-url") as HTMLInputElement).value = "";
    await refresh();
  } catch (error: any) {
    note(error.message);
  }
};
$("close-artifact").onclick = () =>
  ($("artifact-dialog") as HTMLDialogElement).close();
$("artifact-dialog").addEventListener("close", () => {
  ($("artifact-frame") as HTMLIFrameElement).srcdoc = "";
});
