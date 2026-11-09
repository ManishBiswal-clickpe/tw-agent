import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { enhance, markdownToHtml, type ArtifactHandler } from "../markdown.ts";

export const ArtifactContext = createContext<ArtifactHandler>(() => {});

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const onArtifact = useContext(ArtifactContext);
  const html = useMemo(() => markdownToHtml(text), [text]);
  useLayoutEffect(() => {
    if (ref.current) enhance(ref.current, onArtifact);
  }, [html, onArtifact]);
  return (
    <div
      ref={ref}
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
