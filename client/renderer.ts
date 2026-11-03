import { Marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import markedKatex from "marked-katex-extension";
const markdown = new Marked({ breaks: true, gfm: true });
markdown.use({
  renderer: {
    html: ({ text }) =>
      text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;"),
  },
});
markdown.use(markedKatex({ throwOnError: false }));
function safeHTML(value: string) {
  return DOMPurify.sanitize(value, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "iframe", "form", "input", "button"],
  });
}
export function renderMarkdown(body: HTMLElement, text: string) {
  body.innerHTML = safeHTML(markdown.parse(text, { async: false }) as string);
  for (const link of body.querySelectorAll("a")) {
    link.rel = "noreferrer noopener";
    link.target = "_blank";
  }
  for (const code of body.querySelectorAll<HTMLElement>("pre code")) {
    const language = [...code.classList]
      .find((c) => c.startsWith("language-"))
      ?.slice(9);
    const source = code.textContent || "";
    if (language && hljs.getLanguage(language))
      code.innerHTML = DOMPurify.sanitize(
        hljs.highlight(source, { language }).value,
      );
    if (language === "html" || language === "svg") {
      const preview = document.createElement("button");
      preview.textContent = "Preview artifact";
      preview.className = "artifact-button";
      preview.onclick = () => showArtifact(source, "HTML artifact");
      code.parentElement!.after(preview);
    }
    if (language === "mermaid") {
      const preview = document.createElement("button");
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
          showArtifact(
            DOMPurify.sanitize(svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
            }),
            "Diagram",
          );
        } catch {
          preview.textContent = "Diagram could not be rendered";
        } finally {
          preview.disabled = false;
        }
      };
      code.parentElement!.after(preview);
    }
  }
}
export function showArtifact(source: string, title: string) {
  const panel = document.getElementById("artifact-dialog") as HTMLDialogElement;
  const frame = document.getElementById("artifact-frame") as HTMLIFrameElement;
  document.getElementById("artifact-title")!.textContent = title;
  // No scripts, origin access, forms, navigation, popups or network. Static previews only.
  frame.setAttribute("sandbox", "");
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:16px system-ui;margin:24px;overflow-wrap:anywhere}svg{max-width:100%;height:auto}</style>${source}`;
  panel.showModal();
}
