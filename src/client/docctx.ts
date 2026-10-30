/** What the editor screen's parts (commands, dialogs, panels) are given: the app, the live editor, and a handful of screen-level actions. */
import type { App } from "./app.js";
import type { Editor } from "./editor.js";

import type { PanelKind } from "./attach.js";

export type Dock = PanelKind;
export type ZoomRequest = number | "height" | "width";

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
}

export interface DocCtx { app: App; ed: Editor; sid: string; ui: DocUi }

export interface Panel { el: HTMLElement; refresh(): void | Promise<void>; destroy?(): void }
