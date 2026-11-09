import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
// Clean build: hashed chunks from earlier builds would otherwise pile up.
await rm("public/assets", { recursive: true, force: true });
await mkdir("public/assets", { recursive: true });
await build({
  entryPoints: ["client/main.tsx"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  outdir: "public/assets",
  bundle: true,
  format: "esm",
  splitting: true,
  minify: true,
  target: "es2022",
});
await cp("node_modules/katex/dist/katex.min.css", "public/assets/katex.css");
await cp("node_modules/katex/dist/fonts", "public/assets/fonts", {
  recursive: true,
});
