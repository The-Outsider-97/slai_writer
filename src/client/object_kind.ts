/** Resolve the document block/DOM type into a supported object-editor event.
 * Shapes are paragraph blocks; the receiving editor checks their shape extension
 * first, so they intentionally use the existing figure event channel. */
import type { EditorEvent } from "./editor.js";

type ObjectKind = Extract<EditorEvent, { type: "open-object" }>["kind"];

export function objectKind(type: string | undefined, shape: boolean, includeTable = true): ObjectKind | null {
  if (shape) return "figure";
  if (type === "figure" || type === "equation" || type === "embed") return type;
  return includeTable && type === "table" ? "table" : null;
}
