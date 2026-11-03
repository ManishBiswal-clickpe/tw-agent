import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
await mkdir("public/assets", { recursive: true });
await build({
  entryPoints: ["client/connectors.ts", "client/renderer.ts"],
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
