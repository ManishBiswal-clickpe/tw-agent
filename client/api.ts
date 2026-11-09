import type {
  ChatSummary,
  FolderView,
  PublicConfig,
  Transcript,
} from "../shared/api.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Flashlet-Client": "workbench",
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(`Request failed (${response.status})`, response.status);
  }
  if (!response.ok)
    throw new ApiError(
      (data as { error?: string })?.error || "Request failed",
      response.status,
    );
  return data as T;
}

export const post = <T>(url: string, body: unknown = {}) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
}

const q = encodeURIComponent;
export const queries = {
  config: () => ({
    queryKey: ["config"],
    queryFn: () => api<PublicConfig>("/api/config"),
    staleTime: Infinity,
  }),
  folders: () => ({
    queryKey: ["folders"],
    queryFn: () =>
      api<{ folders: FolderView[] }>("/api/folders").then((r) => r.folders),
  }),
  chats: (folderId: string) => ({
    queryKey: ["chats", folderId],
    queryFn: () =>
      api<{ chats: ChatSummary[] }>(`/api/folders/${q(folderId)}/chats`).then(
        (r) => r.chats,
      ),
  }),
  transcript: (chatId: string) => ({
    queryKey: ["transcript", chatId],
    queryFn: () => api<Transcript>(`/api/sessions/${q(chatId)}`),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  }),
  files: (folderId: string, path: string) => ({
    queryKey: ["files", folderId, path],
    queryFn: () =>
      api<{ files: FileEntry[] }>(
        `/api/files?folder=${q(folderId)}&path=${q(path)}`,
      ).then((r) => r.files),
  }),
  file: (folderId: string, path: string) => ({
    queryKey: ["file", folderId, path],
    queryFn: () =>
      api<{ path: string; content: string }>(
        `/api/file?folder=${q(folderId)}&path=${q(path)}`,
      ),
  }),
  diff: (folderId: string) => ({
    queryKey: ["diff", folderId],
    queryFn: () =>
      api<{ content: string; note: string }>(`/api/diff?folder=${q(folderId)}`),
  }),
};

export function relativeTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
