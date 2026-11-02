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
]);
export function visible(name) {
  return (
    !excluded.has(name) &&
    !/^\.env(?:\.|$)/.test(name) &&
    !/\.(pem|key|p12|pfx)$/i.test(name)
  );
}
export async function resolveFile(root, relative = "") {
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
export async function listFiles(root, relative = "") {
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
export async function previewFile(root, relative) {
  const target = await resolveFile(root, relative);
  const info = await stat(target);
  if (!info.isFile() || info.size > 200000)
    throw new Error("Preview supports text files up to 200 KB");
  const content = await readFile(target, "utf8");
  if (content.includes("\0"))
    throw new Error("Binary file preview unavailable");
  return { path: relative, content };
}
export async function workspaceDiff(root) {
  try {
    const { stdout } = await exec(
      "git",
      [
        "diff",
        "HEAD",
        "--",
        ".",
        ":!package-lock.json",
        ":!.env",
        ":!.env.*",
        ":!*.pem",
        ":!*.key",
      ],
      { cwd: root, maxBuffer: 300000, timeout: 5000 },
    );
    return {
      content: stdout,
      note: "Tracked changes against HEAD. Untracked files are not included.",
    };
  } catch {
    return {
      content: "",
      note: "Git diff unavailable. The workspace needs a Git repository with an initial commit.",
    };
  }
}
