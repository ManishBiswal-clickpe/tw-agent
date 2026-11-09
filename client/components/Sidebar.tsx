import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FolderView } from "../../shared/api.ts";
import { api, errorMessage, post, queries, relativeTime } from "../api.ts";
import { Icon } from "./Icon.tsx";
import { Modal } from "./Modal.tsx";

function FolderSection({
  folder,
  activeFolder,
  activeChat,
  onNavigate,
}: {
  folder: FolderView;
  activeFolder: string;
  activeChat?: string;
  onNavigate: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);
  const [menu, setMenu] = useState(false);
  const chats = useQuery({ ...queries.chats(folder.id), enabled: open });
  const deleteChat = useMutation({
    mutationFn: (id: string) =>
      api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (_d, id) => {
      void client.invalidateQueries({ queryKey: ["chats", folder.id] });
      if (id === activeChat)
        void navigate({ to: "/f/$folderId", params: { folderId: folder.id } });
    },
  });
  const removeFolder = useMutation({
    mutationFn: () =>
      api(`/api/folders/${encodeURIComponent(folder.id)}`, { method: "DELETE" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["folders"] });
      if (activeFolder === folder.id)
        void navigate({ to: "/f/$folderId", params: { folderId: "default" } });
    },
    onError: (e) => alert(errorMessage(e)),
  });
  const renameFolder = useMutation({
    mutationFn: (name: string) =>
      api(`/api/folders/${encodeURIComponent(folder.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["folders"] }),
    onError: (e) => alert(errorMessage(e)),
  });
  const list = chats.data || [];
  return (
    <section className={`folder ${activeFolder === folder.id ? "active" : ""}`}>
      <div className="folder-row">
        <button
          type="button"
          className="folder-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          title={folder.path}
        >
          <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
          <Icon name="folder" size={15} />
          <span className="folder-name">{folder.name}</span>
        </button>
        <div className="folder-actions">
          <Link
            to="/f/$folderId"
            params={{ folderId: folder.id }}
            className="icon-button small"
            title={`New chat in ${folder.name}`}
            onClick={onNavigate}
          >
            <Icon name="plus" size={14} />
          </Link>
          <button
            type="button"
            className="icon-button small"
            title="Folder options"
            onClick={() => setMenu(!menu)}
          >
            <Icon name="more" size={14} />
          </button>
        </div>
        {menu && (
          <div className="menu" onMouseLeave={() => setMenu(false)}>
            <div className="menu-path">{folder.path}</div>
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                const name = prompt("Folder name", folder.name);
                if (name) renameFolder.mutate(name);
              }}
            >
              <Icon name="pencil" size={14} /> Rename
            </button>
            {!folder.builtin && (
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setMenu(false);
                  if (
                    confirm(
                      `Remove "${folder.name}" from the sidebar? Files on disk are not touched.`,
                    )
                  )
                    removeFolder.mutate();
                }}
              >
                <Icon name="trash" size={14} /> Remove folder
              </button>
            )}
          </div>
        )}
      </div>
      {open && (
        <ul className="chat-list">
          {list.map((chat) => (
            <li key={chat.id}>
              <Link
                to="/f/$folderId/c/$chatId"
                params={{ folderId: folder.id, chatId: chat.id }}
                className={`chat-row ${chat.id === activeChat ? "active" : ""}`}
                onClick={onNavigate}
              >
                {chat.busy ? (
                  <span className="spinner" />
                ) : (
                  <Icon name="chat" size={14} />
                )}
                <span className="chat-title">{chat.title}</span>
                <time>{relativeTime(chat.modified)}</time>
              </Link>
              <button
                type="button"
                className="icon-button small chat-delete"
                title="Delete chat"
                onClick={() => {
                  if (confirm(`Delete "${chat.title}"? This cannot be undone.`))
                    deleteChat.mutate(chat.id);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
          {chats.isSuccess && !list.length && (
            <li className="empty">No chats yet</li>
          )}
        </ul>
      )}
    </section>
  );
}

function AddFolderModal({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => post<FolderView>("/api/folders", { path, name }),
    onSuccess: (folder) => {
      void client.invalidateQueries({ queryKey: ["folders"] });
      void navigate({ to: "/f/$folderId", params: { folderId: folder.id } });
      onClose();
    },
  });
  return (
    <Modal title="Add a folder" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <p className="muted">
          A folder is a project directory on this machine. Chats in it run with
          that directory as the agent's workspace. Removing a folder later only
          hides it; files are never deleted.
        </p>
        <label>
          Absolute path
          <input
            autoFocus
            required
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/you/projects/assignment-3"
            spellCheck={false}
          />
        </label>
        <label>
          Display name (optional)
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Defaults to the folder name"
          />
        </label>
        {add.error && <div className="form-error">{errorMessage(add.error)}</div>}
        <div className="form-actions">
          <button type="button" className="button ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={add.isPending}>
            Add folder
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Sidebar({
  folderId,
  chatId,
  onNavigate,
}: {
  folderId: string;
  chatId?: string;
  onNavigate: () => void;
}) {
  const folders = useQuery(queries.folders());
  const config = useQuery(queries.config());
  const [adding, setAdding] = useState(false);
  return (
    <aside className="sidebar">
      <Link to="/" className="brand" onClick={onNavigate}>
        <span className="logo">
          f<span>·</span>
        </span>
        <span>
          flashlet<small>Local coding assistant</small>
        </span>
      </Link>
      <Link
        to="/f/$folderId"
        params={{ folderId }}
        className="new-chat"
        onClick={onNavigate}
      >
        <Icon name="plus" /> New chat
      </Link>
      <div className="section-head">
        <span>Folders</span>
        <button
          type="button"
          className="icon-button small"
          title="Add folder"
          onClick={() => setAdding(true)}
        >
          <Icon name="folder-plus" size={15} />
        </button>
      </div>
      <nav className="folders" aria-label="Folders and chats">
        {folders.data?.map((folder) => (
          <FolderSection
            key={folder.id}
            folder={folder}
            activeFolder={folderId}
            activeChat={chatId}
            onNavigate={onNavigate}
          />
        ))}
        {folders.error && (
          <div className="form-error">{errorMessage(folders.error)}</div>
        )}
      </nav>
      <div className="sidebar-foot">
        <span className={`status-dot ${config.data ? "ok" : ""}`} />
        <div>
          <strong>{config.data?.modelId || "Connecting…"}</strong>
          <small>
            {config.data?.persistent ? "Chats saved on this machine" : "Chats in memory"}
          </small>
        </div>
      </div>
      {adding && <AddFolderModal onClose={() => setAdding(false)} />}
    </aside>
  );
}
