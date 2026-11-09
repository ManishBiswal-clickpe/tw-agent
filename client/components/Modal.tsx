import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export function Modal({
  title,
  onClose,
  children,
  wide,
  id,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  id?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
    const cancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", cancel);
    return () => dialog.removeEventListener("cancel", cancel);
  }, [onClose]);
  return (
    <dialog
      id={id}
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <header>
        <h2>{title}</h2>
        <button
          type="button"
          id={id ? `close-${id.replace(/-dialog$/, "")}` : undefined}
          className="icon-button"
          onClick={onClose}
          aria-label="Close"
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function ArtifactModal({
  artifact,
  onClose,
}: {
  artifact: { source: string; title: string };
  onClose: () => void;
}) {
  // No scripts, origin access, forms, navigation, popups or network. Static previews only.
  const srcDoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:16px system-ui;margin:24px;overflow-wrap:anywhere}svg{max-width:100%;height:auto}</style>${artifact.source}`;
  return (
    <Modal title={artifact.title} onClose={onClose} wide id="artifact-dialog">
      <p className="muted">Static, isolated preview. Scripts and network are disabled.</p>
      <iframe
        id="artifact-frame"
        className="artifact-frame"
        title="Sandboxed artifact preview"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
      />
    </Modal>
  );
}
