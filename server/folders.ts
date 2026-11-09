import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export interface Folder {
  id: string;
  name: string;
  path: string;
  /** The FLASHLET_WORKSPACE folder. Always present, cannot be removed. */
  builtin?: boolean;
}

/**
 * Folders group chats. Each folder is a real directory on disk that becomes the
 * agent's working directory. Persisted in <dataDir>/folders.json when a data
 * directory is configured; in-memory otherwise (tests).
 */
export class FolderStore {
  private folders: Folder[] = [];
  constructor(
    private workspace: string,
    private dataDir?: string,
  ) {}

  private get file() {
    return this.dataDir && path.join(this.dataDir, "folders.json");
  }

  async load() {
    const builtin: Folder = {
      id: "default",
      name: path.basename(this.workspace) || this.workspace,
      path: this.workspace,
      builtin: true,
    };
    let saved: Folder[] = [];
    if (this.file)
      try {
        const parsed = JSON.parse(await readFile(this.file, "utf8"));
        if (Array.isArray(parsed))
          saved = parsed.filter(
            (f): f is Folder =>
              typeof f?.id === "string" &&
              /^[a-f0-9-]{36}$/.test(f.id) &&
              typeof f.name === "string" &&
              typeof f.path === "string",
          );
      } catch {
        /* first run or unreadable: start with the workspace only */
      }
    this.folders = [builtin, ...saved.filter((f) => f.path !== this.workspace)];
  }

  private async save() {
    if (!this.file) return;
    await mkdir(this.dataDir!, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify(
        this.folders.filter((f) => !f.builtin),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(tmp, this.file);
  }

  list(): Folder[] {
    return this.folders.map((f) => ({ ...f }));
  }

  get(id: string): Folder | undefined {
    return this.folders.find((f) => f.id === id);
  }

  /** Chat files for a folder live under <dataDir>/chats/<folderId>. */
  sessionDir(folder: Folder): string | undefined {
    return this.dataDir && path.join(this.dataDir, "chats", folder.id);
  }

  async add(rawPath: unknown, rawName?: unknown): Promise<Folder> {
    if (typeof rawPath !== "string" || !rawPath.trim() || rawPath.length > 4096)
      throw new Error("Enter an absolute folder path");
    const expanded = rawPath
      .trim()
      .replace(/^~(?=$|\/)/, process.env.HOME || "~");
    if (!path.isAbsolute(expanded))
      throw new Error("Enter an absolute folder path, e.g. /home/you/project");
    let resolved: string;
    try {
      resolved = await realpath(expanded);
      if (!(await stat(resolved)).isDirectory()) throw new Error();
    } catch {
      throw new Error("That folder does not exist or is not a directory");
    }
    if (resolved === "/") throw new Error("Choose a project folder, not /");
    const existing = this.folders.find((f) => f.path === resolved);
    if (existing) return { ...existing };
    const name =
      typeof rawName === "string" && rawName.trim()
        ? rawName.trim().slice(0, 80)
        : path.basename(resolved);
    const folder: Folder = { id: randomUUID(), name, path: resolved };
    this.folders.push(folder);
    await this.save();
    return { ...folder };
  }

  async rename(id: string, rawName: unknown): Promise<Folder> {
    const folder = this.get(id);
    if (!folder) throw new Error("Folder not found");
    if (typeof rawName !== "string" || !rawName.trim())
      throw new Error("Enter a name");
    folder.name = rawName.trim().slice(0, 80);
    await this.save();
    return { ...folder };
  }

  /** Removes the folder from the sidebar. Files on disk are never touched. */
  async remove(id: string) {
    const folder = this.get(id);
    if (!folder) throw new Error("Folder not found");
    if (folder.builtin) throw new Error("The workspace folder cannot be removed");
    this.folders = this.folders.filter((f) => f.id !== id);
    await this.save();
  }
}
