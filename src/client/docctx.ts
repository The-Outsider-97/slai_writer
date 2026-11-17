/** What the editor screen's parts (commands, dialogs, panels) are given: the app, the live editor, and a handful of screen-level actions. */
import type { App } from "./app.js";
import type { Editor } from "./editor.js";

import type { PanelKind } from "./attach.js";

export type Dock = PanelKind;
export type ZoomRequest = number | "height" | "width" | "entire";

export interface DocUi {
  /** Open (or, with no tab, toggle) one of the three panels attached to the current page; `tab` picks the tab inside it. */
  openPanel(kind: Dock, tab?: string): void;
  focusFind(): void;
  save(): Promise<boolean>;
  saveAs(): Promise<boolean>;
  refreshStatus(): void;
  showEmbed(block: string | null): void;
  toggleRight(): void;
  /** Open the right panel on its Layers section. */
  showLayers(): void;
  toggleLeft(): void;
  toggleFormatBar(): void;
  palette(x: number, y: number): void;
  setZoom(request: ZoomRequest): void;
  /** Reload this screen from the server (after a restore, a reload from disk, a merge). */
  reload(state?: import("./types.js").DocState): Promise<void>;
  toggleHidden(): void;
  /** Editing view or the clean, read-only Rendered View. Resolves when the switch is done (or refused, with the reason shown). */
  setRendered(on: boolean): Promise<void>;
  /** One to four pages side by side (and, for a document with mirrored margins, the two-page book view). */
  setPages(count: 1 | 2 | 3 | 4, options?: { book?: boolean }): void;
  /** The view state the status bar and the commands show. */
  viewState(): ViewState;
}

export interface ViewState {
  rendered: boolean;
  perRow: 1 | 2 | 3 | 4;
  /** Two pages as a book: page 1 alone on the right, then 2-3, 4-5. */
  facing: boolean;
  /** The document has mirrored margins in some section, so a book view means something. */
  book: boolean;
  /** Why the Rendered View cannot be shown right now (no PDF capability, ...), or null. */
  renderedUnavailable: string | null;
  /** The page, the page count and the printed label of the Rendered View, for the status bar. */
  renderedPage: { page: number; total: number; label: string | null } | null;
}

export interface DocCtx { app: App; ed: Editor; sid: string; ui: DocUi }

export interface Panel { el: HTMLElement; refresh(): void | Promise<void>; destroy?(): void }
