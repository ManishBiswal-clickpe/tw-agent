import { realpath, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const excluded = new Set([
  ".git",
  "node_modules",
  ".flashlet",
  ".ssh",
  ".vault",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".venv",
]);
export function visible(name: string) {
  return (
    !excluded.has(name) &&
    !/^\.env(?:\.|$)/.test(name) &&
    !/\.(pem|key|p12|pfx)$/i.test(name)
  );
}
export async function resolveFile(root: string, relative = "") {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((p) => p === ".." || !visible(p))
  )
    throw new Error("Path not allowed");
  const target = await realpath(path.resolve(root, relative));
  if (target !== root && !target.startsWith(root + path.sep))
    throw new Error("Path outside workspace");
  return target;
}
export async function listFiles(root: string, relative = "") {
  const target = await resolveFile(root, relative);
  const items = await readdir(target, { withFileTypes: true });
  return items
    .filter((d) => visible(d.name) && !d.isSymbolicLink())
    .map((d) => ({
      name: d.name,
      path: path.posix.join(relative, d.name),
      directory: d.isDirectory(),
    }))
    .sort(
      (a, b) =>
        Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name),
    );
}
export async function previewFile(root: string, relative: string) {
  const target = await resolveFile(root, relative);
  const info = await stat(target);
  if (!info.isFile() || info.size > 200000)
    throw new Error("Preview supports text files up to 200 KB");
  const content = await readFile(target, "utf8");
  if (content.includes("\0"))
    throw new Error("Binary file preview unavailable");
  return { path: relative, content };
}
export async function workspaceDiff(root: string) {
  const git = (args: string[]) =>
    exec("git", args, { cwd: root, maxBuffer: 300000, timeout: 5000 });
  try {
    const { stdout } = await git([
      "diff",
      "HEAD",
      "--",
      ".",
      ":!package-lock.json",
      ":!.env",
      ":!.env.*",
      ":!*.pem",
      ":!*.key",
    ]);
    // New files the agent created are untracked; show them as additions too.
    let untracked = "";
    const { stdout: others } = await git([
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const files = others
      .split("\n")
      .filter((f) => f && f.split("/").every(visible))
      .slice(0, 25);
    for (const file of files) {
      try {
        const info = await stat(path.join(root, file));
        if (info.size > 100000) continue;
        await git(["diff", "--no-index", "--", "/dev/null", file]);
      } catch (error) {
        // git diff --no-index exits 1 when files differ; stdout holds the diff.
        const out = (error as { stdout?: string }).stdout;
        if (out) untracked += out;
      }
    }
    return {
      content: stdout + untracked,
      note: files.length
        ? `Tracked changes against HEAD, plus ${files.length} new untracked file${files.length === 1 ? "" : "s"}.`
        : "Tracked changes against HEAD.",
    };
  } catch {
    return {
      content: "",
      note: "Git diff unavailable. The folder needs a Git repository with an initial commit.",
    };
  }
}
