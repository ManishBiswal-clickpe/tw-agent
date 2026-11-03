import {
  Theme,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { ConnectorUI } from "./types.ts";

// The browser host only implements OAuth input/notifications. TUI-only operations
// stay explicit no-ops rather than hiding missing members behind a cast.
export function browserExtensionUI(ui: ConnectorUI): ExtensionUIContext {
  const noop = () => {};
  return {
    ...ui,
    select: async () => undefined,
    confirm: async () => false,
    editor: async () => undefined,
    custom: async () => undefined as never,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => "",
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    theme: new Proxy({} as Theme, {
      get() {
        throw new Error("Terminal themes are unavailable in the browser host");
      },
    }),
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({
      success: false,
      error: "Terminal themes are unavailable in the browser host",
    }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
}
