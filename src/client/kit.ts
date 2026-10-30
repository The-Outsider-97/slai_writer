/** The one place the shared SLAI UI kit (applications/tools/web) is imported from, so the relative path appears once. */
export { h, s, $, $$, clear, replace, labelled, announce, focusable, nextId } from "../../../tools/web/src/dom.js";
export type { Child, Props } from "../../../tools/web/src/dom.js";
export { ApiError, markerHeader, queryString, createClient } from "../../../tools/web/src/api.js";
export type { Client, Query } from "../../../tools/web/src/api.js";
export { glyph, registerGlyph, assetIcon, hasGlyph } from "../../../tools/web/src/icons.js";
export { appearanceControls, applyAppearance, normaliseAppearance, DEFAULT_APPEARANCE } from "../../../tools/web/src/theme.js";
export type { Appearance, Theme } from "../../../tools/web/src/theme.js";
export { toast, openDialog, confirmDialog, promptDialog, openMenu, copyText, saveBlob } from "../../../tools/web/src/ui.js";
export type { DialogHandle, MenuEntry } from "../../../tools/web/src/ui.js";
export { clamp, debounce, Emitter, formatBytes, plural, uid, compareText } from "../../../tools/web/src/util.js";
