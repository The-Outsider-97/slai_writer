/** Which object editor a block opens: the kind `open-object` carries, or null when the block is ordinary text.
 *  A vector shape opens like a picture (the document screen sends shapes to the shape editor first). Tables open their tools on Enter, but a
 *  double-click on a table belongs to the cell under the pointer, so callers on that path pass `withTable = false`. */
export type ObjectKind = "embed" | "equation" | "figure" | "table";

export function objectKind(type: string | undefined, isShape: boolean, withTable = true): ObjectKind | null {
  if (isShape) return "figure";
  if (type === "figure" || type === "equation" || type === "embed") return type;
  if (type === "table" && withTable) return "table";
  return null;
}
