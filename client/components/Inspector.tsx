import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage, queries, type FileEntry } from "../api.ts";
import { Icon } from "./Icon.tsx";

function Tree({
  folderId,
  path,
  depth,
  onOpen,
}: {
  folderId: string;
  path: string;
  depth: number;
  onOpen: (path: string) => void;
}) {
  const files = useQuery(queries.files(folderId, path));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (files.error)
    return <div className="form-error">{errorMessage(files.error)}</div>;
  return (
    <ul className="tree">
      {files.data?.map((entry: FileEntry) => (
        <li key={entry.path}>
          <button
            type="button"
            className="tree-row"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() =>
              entry.directory
                ? setExpanded((e) => ({ ...e, [entry.path]: !e[entry.path] }))
                : onOpen(entry.path)
            }
          >
            {entry.directory ? (
              <Icon
                name={expanded[entry.path] ? "chevron-down" : "chevron-right"}
                size={13}
              />
            ) : (
              <span className="tree-spacer" />
            )}
            <Icon name={entry.directory ? "folder" : "file"} size={14} />
            <span>{entry.name}</span>
          </button>
          {entry.directory && expanded[entry.path] && (
            <Tree
              folderId={folderId}
              path={entry.path}
              depth={depth + 1}
              onOpen={onOpen}
            />
          )}
        </li>
      ))}
      {files.isSuccess && !files.data.length && depth === 0 && (
        <li className="empty">This folder is empty</li>
      )}
    </ul>
  );
}

function Preview({
  folderId,
  path,
  onBack,
}: {
  folderId: string;
  path: string;
  onBack: () => void;
}) {
  const file = useQuery(queries.file(folderId, path));
  return (
    <div className="preview">
      <button type="button" className="link-button" onClick={onBack}>
        <Icon name="back" size={14} /> Files
      </button>
      <div className="preview-name">{path}</div>
      {file.error ? (
        <div className="form-error">{errorMessage(file.error)}</div>
      ) : (
        <pre className="code-view">{file.data?.content ?? "Loading…"}</pre>
      )}
    </div>
  );
}

function Diff({ folderId }: { folderId: string }) {
  const diff = useQuery(queries.diff(folderId));
  const content = diff.data?.content || "";
  const files = (content.match(/^diff --git/gm) || []).length;
  return (
    <div className="diff">
      <div className="diff-head">
        Working tree <span>{files ? `${files} file${files > 1 ? "s" : ""}` : ""}</span>
      </div>
      <p className="muted small">{diff.data?.note}</p>
      {content ? (
        <pre className="code-view">
          {content.split("\n").map((line, i) => (
            <div
              key={i}
              className={
                line.startsWith("+") && !line.startsWith("+++")
                  ? "add"
                  : line.startsWith("-") && !line.startsWith("---")
                    ? "del"
                    : line.startsWith("@@")
                      ? "hunk"
                      : line.startsWith("diff --git")
                        ? "file"
                        : ""
              }
            >
              {line || " "}
            </div>
          ))}
        </pre>
      ) : (
        diff.isSuccess && <div className="empty">No changes yet</div>
      )}
    </div>
  );
}

export function Inspector({ folderId }: { folderId: string }) {
  const client = useQueryClient();
  const config = useQuery(queries.config());
  const [tab, setTab] = useState<"files" | "changes">("files");
  const [open, setOpen] = useState<string | null>(null);
  return (
    <aside className="inspector">
      <header>
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "files"}
            onClick={() => setTab("files")}
          >
            Files
          </button>
          <button
            role="tab"
            aria-selected={tab === "changes"}
            onClick={() => setTab("changes")}
          >
            Changes
          </button>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Refresh"
          onClick={() => {
            for (const key of ["files", "file", "diff"])
              void client.invalidateQueries({ queryKey: [key, folderId] });
          }}
        >
          <Icon name="refresh" />
        </button>
      </header>
      <div className="inspector-body">
        {tab === "files" ? (
          open ? (
            <Preview folderId={folderId} path={open} onBack={() => setOpen(null)} />
          ) : (
            <Tree folderId={folderId} path="" depth={0} onOpen={setOpen} />
          )
        ) : (
          <Diff folderId={folderId} />
        )}
      </div>
      <footer className="inspector-foot">
        <div className="eyebrow">
          <span className="status-dot ok" /> Model endpoint
        </div>
        <code>{config.data?.endpoint}</code>
        <p className="muted small">
          Model and keys stay on the server, never in your browser.
        </p>
      </footer>
    </aside>
  );
}
