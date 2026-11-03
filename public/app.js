const $ = (id) => document.getElementById(id);
const tasks = [];
let current = null;
let config;
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Flashlet-Client": "workbench",
      ...options.headers,
    },
  });
  if (response.status === 204) return;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
function notice(text = "") {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
function textNode(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderText(body, text) {
  // Never inject model output as HTML. Only fenced code blocks receive formatting.
  body.replaceChildren();
  text.split("```").forEach((part, index) => {
    if (index % 2) {
      const pre = document.createElement("pre");
      pre.append(textNode("code", part.replace(/^[\w+-]*\n/, "")));
      body.append(pre);
    } else body.append(document.createTextNode(part));
  });
}
function message(role, content) {
  return { role, content, tools: [] };
}
function addMessage(container, item) {
  const el = textNode("article", "", `message ${item.role}`);
  el.append(
    textNode(
      "div",
      item.role === "user" ? "You" : "Flashlet · local agent",
      "message-label",
    ),
  );
  const body = textNode("div", "", "message-body");
  renderText(body, item.content);
  el.append(body);
  for (const tool of item.tools) {
    const details = document.createElement("details");
    details.className = "tool";
    details.append(
      textNode(
        "summary",
        `${tool.done ? (tool.error ? "✕" : "✓") : "◌"} ${tool.name}${tool.done ? "" : " · running"}`,
      ),
    );
    details.append(
      textNode("pre", JSON.stringify(tool.result ?? tool.args, null, 2)),
    );
    el.append(details);
  }
  container.append(el);
}
function render() {
  $("tasks").replaceChildren();
  $("task-count").textContent = tasks.length;
  if (!tasks.length)
    $("tasks").append(
      textNode("p", "Your tasks will appear here.", "muted empty-tasks"),
    );
  for (const task of tasks) {
    const row = textNode(
      "button",
      "",
      `task-row ${task === current ? "active" : ""}`,
    );
    row.append(
      textNode("span", task.busy ? "◌" : "◦"),
      textNode("span", task.title),
    );
    row.onclick = () => {
      current = task;
      notice();
      render();
    };
    $("tasks").append(row);
  }
  $("mobile-tasks").replaceChildren();
  if (!tasks.length) $("mobile-tasks").append(new Option("New task", ""));
  for (const task of tasks)
    $("mobile-tasks").append(
      new Option(task.title, task.id, false, task === current),
    );
  $("task-title").textContent = current?.title || "New task";
  $("welcome").hidden = !!current?.messages.length;
  $("messages").replaceChildren();
  for (const item of current?.messages || []) addMessage($("messages"), item);
  $("send").hidden = !!current?.busy;
  $("stop").hidden = !current?.busy;
  $("prompt").disabled = !!current?.busy;
}
function scroll() {
  const area = document.querySelector(".chat-area");
  area.scrollTop = area.scrollHeight;
}
function ensureAssistant(task) {
  let item = task.messages.at(-1);
  if (!item || item.role !== "assistant") {
    item = message("assistant", "");
    task.messages.push(item);
  }
  return item;
}
async function newTask() {
  $("new-task").disabled = true;
  try {
    const { id } = await api("/api/sessions", { method: "POST", body: "{}" });
    const task = { id, title: "New task", messages: [], busy: false };
    const stream = new EventSource(`/api/sessions/${id}/events`);
    task.stream = stream;
    const listen = (name, handler) =>
      stream.addEventListener(name, (event) => {
        handler(JSON.parse(event.data));
        if (current === task) {
          render();
          scroll();
        }
      });
    listen("run_start", () => {
      task.busy = true;
    });
    listen("delta", (data) => {
      ensureAssistant(task).content += data.text;
    });
    listen("tool_start", (data) => {
      ensureAssistant(task).tools.push({ ...data, done: false });
    });
    listen("tool_end", (data) => {
      const tool = task.messages
        .flatMap((m) => m.tools)
        .find((t) => t.id === data.id);
      if (tool) Object.assign(tool, data, { done: true });
    });
    listen("run_error", (data) => {
      task.failed = true;
      ensureAssistant(task).content += `\nRun failed: ${data.message}`;
    });
    listen("run_end", () => {
      task.busy = false;
      if (!task.messages.at(-1)?.content && !task.failed)
        ensureAssistant(task).content = "Run ended without a text response.";
      if (current === task) void loadFiles();
    });
    stream.onerror = () => {
      if (current === task)
        notice(
          "Connection interrupted. Reconnecting to this task. If the server restarted, start a new task.",
        );
    };
    stream.onopen = () => {
      if (current === task) notice();
    };
    tasks.unshift(task);
    current = task;
    notice();
    render();
    return task;
  } catch (error) {
    notice(error.message);
    throw error;
  } finally {
    $("new-task").disabled = false;
  }
}
$("new-task").onclick = async () => {
  if (tasks.length >= 8) {
    const oldest = [...tasks].reverse().find((task) => !task.busy);
    if (!oldest)
      return notice(
        "All eight tasks are running. Stop one before starting another.",
      );
    if (
      !confirm(
        "Close the oldest idle task to start a new one? Its conversation will be lost.",
      )
    )
      return;
    try {
      await api(`/api/sessions/${oldest.id}`, { method: "DELETE" });
      oldest.stream.close();
      tasks.splice(tasks.indexOf(oldest), 1);
    } catch (error) {
      return notice(error.message);
    }
  }
  try {
    await newTask();
    $("prompt").focus();
  } catch {
    /* notice already shown */
  }
};
let submitting = false;
$("prompt-form").onsubmit = async (event) => {
  event.preventDefault();
  const text = $("prompt").value.trim();
  if (!text || submitting || current?.busy) return;
  submitting = true;
  $("send").disabled = true;
  try {
    const task = current || (await newTask());
    task.failed = false;
    const userMessage = message("user", text);
    task.messages.push(userMessage);
    task.busy = true;
    try {
      await api(`/api/sessions/${task.id}/prompt`, {
        method: "POST",
        body: JSON.stringify({ text }),
      });
    } catch (error) {
      task.messages.splice(task.messages.indexOf(userMessage), 1);
      task.busy = false;
      render();
      throw error;
    }
    if (task.title === "New task") task.title = text.slice(0, 42);
    $("prompt").value = "";
    notice();
    render();
    scroll();
  } catch (error) {
    notice(error.message);
  } finally {
    submitting = false;
    $("send").disabled = false;
  }
};
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("prompt-form").requestSubmit();
  }
};
$("stop").onclick = async () => {
  if (!current) return;
  try {
    await api(`/api/sessions/${current.id}/abort`, {
      method: "POST",
      body: "{}",
    });
  } catch (error) {
    notice(error.message);
  }
};
for (const button of document.querySelectorAll("[data-prompt]"))
  button.onclick = () => {
    $("prompt").value = button.dataset.prompt;
    $("prompt").focus();
  };
let directory = "";
async function loadFiles(dir = directory) {
  try {
    const { files } = await api(`/api/files?path=${encodeURIComponent(dir)}`);
    directory = dir;
    $("file-list").replaceChildren();
    $("file-list").hidden = false;
    $("file-preview").hidden = true;
    if (dir) {
      const up = textNode("button", "← Parent directory", "file-row");
      up.onclick = () => loadFiles(dir.split("/").slice(0, -1).join("/"));
      $("file-list").append(up);
    }
    if (!files.length)
      $("file-list").append(
        textNode("p", "No visible files in this directory.", "muted"),
      );
    for (const file of files) {
      const row = textNode("button", "", "file-row");
      row.append(
        textNode("span", file.directory ? "▸" : "≡", "file-icon"),
        textNode("span", file.name),
      );
      row.onclick = () =>
        file.directory ? loadFiles(file.path) : openFile(file.path);
      $("file-list").append(row);
    }
  } catch (error) {
    $("file-list").replaceChildren(textNode("p", error.message, "muted"));
  }
}
async function openFile(path) {
  try {
    const data = await api(`/api/file?path=${encodeURIComponent(path)}`);
    $("file-name").textContent = data.path;
    $("file-content").textContent = data.content;
    $("file-list").hidden = true;
    $("file-preview").hidden = false;
  } catch (error) {
    notice(error.message);
  }
}
async function loadDiff() {
  try {
    const data = await api("/api/diff");
    $("diff-note").textContent = data.note;
    $("diff-content").replaceChildren();
    let added = 0,
      removed = 0;
    for (const line of data.content.split("\n")) {
      const plus = line.startsWith("+") && !line.startsWith("+++");
      const minus = line.startsWith("-") && !line.startsWith("---");
      if (plus) added++;
      if (minus) removed++;
      $("diff-content").append(
        textNode(
          "span",
          line + "\n",
          plus ? "diff-added" : minus ? "diff-removed" : "",
        ),
      );
    }
    $("diff-count").textContent = `+${added} −${removed}`;
    if (!data.content) $("diff-content").textContent = "No tracked changes.";
  } catch (error) {
    $("diff-note").textContent = error.message;
  }
}
$("back-files").onclick = () => loadFiles();
$("refresh").onclick = () => {
  void loadFiles();
  void loadDiff();
};
function tab(changes) {
  $("files-tab").setAttribute("aria-selected", !changes);
  $("changes-tab").setAttribute("aria-selected", changes);
  $("files-panel").hidden = changes;
  $("changes-panel").hidden = !changes;
  if (changes) void loadDiff();
}
$("files-tab").onclick = () => tab(false);
$("changes-tab").onclick = () => tab(true);
try {
  config = await api("/api/config");
  $("workspace-name").textContent = config.workspace;
  $("composer-workspace").textContent = config.workspace;
  $("model-name").textContent = config.modelId;
  $("endpoint").textContent = config.endpoint;
  $("mode-badge").textContent = config.allowWrites
    ? "WRITE + SHELL"
    : "READ ONLY";
  if (config.allowWrites)
    notice(
      "Write and shell tools are enabled with your OS permissions. This is not a sandbox.",
    );
  await loadFiles();
} catch (error) {
  notice(`Cannot connect to Flashlet: ${error.message}`);
}
render();

$("mobile-new").onclick = () => $("new-task").click();
$("mobile-tasks").onchange = () => {
  current = tasks.find((t) => t.id === $("mobile-tasks").value) || null;
  notice();
  render();
};
