import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import markedKatex from "marked-katex-extension";

const markdown = new Marked({ breaks: true, gfm: true });
markdown.use({
  renderer: {
    // Raw HTML from the model is shown as text, never rendered.
    html: ({ text }) =>
      text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
  },
});
markdown.use(markedKatex({ throwOnError: false }));

export function markdownToHtml(text: string): string {
  return DOMPurify.sanitize(markdown.parse(text, { async: false }) as string, {
    USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ["style", "iframe", "form", "input", "button"],
  });
}

export type ArtifactHandler = (source: string, title: string) => void;

/** Post-process rendered markdown: links, highlighting, copy and preview buttons. */
export function enhance(body: HTMLElement, onArtifact: ArtifactHandler) {
  for (const link of body.querySelectorAll("a")) {
    link.rel = "noreferrer noopener";
    link.target = "_blank";
  }
  for (const code of body.querySelectorAll<HTMLElement>("pre code")) {
    const pre = code.parentElement!;
    if (pre.dataset.enhanced) continue;
    pre.dataset.enhanced = "1";
    const language = [...code.classList]
      .find((c) => c.startsWith("language-"))
      ?.slice(9);
    const source = code.textContent || "";
    if (language && hljs.getLanguage(language))
      code.innerHTML = DOMPurify.sanitize(
        hljs.highlight(source, { language }).value,
      );
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const label = document.createElement("span");
    label.textContent = language || "text";
    bar.append(label);
    const actions = document.createElement("span");
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.onclick = async () => {
      await navigator.clipboard.writeText(source);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
    };
    if (language === "html" || language === "svg") {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = "Preview";
      preview.className = "artifact-button";
      preview.onclick = () => onArtifact(source, "HTML artifact");
      actions.append(preview);
    }
    if (language === "mermaid") {
      const preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = "Render diagram";
      preview.className = "artifact-button";
      preview.onclick = async () => {
        preview.disabled = true;
        try {
          const { default: mermaid } = await import("mermaid");
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: "strict",
            maxTextSize: 20000,
            htmlLabels: false,
            flowchart: { htmlLabels: false },
          });
          const { svg } = await mermaid.render(
            `diagram-${crypto.randomUUID()}`,
            source,
          );
          onArtifact(
            DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
            }),
            "Diagram",
          );
        } catch {
          preview.textContent = "Diagram failed";
        } finally {
          preview.disabled = false;
        }
      };
      actions.append(preview);
    }
    actions.append(copy);
    bar.append(actions);
    pre.prepend(bar);
  }
}
