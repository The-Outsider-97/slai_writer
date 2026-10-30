/** Creating a private note from the current selection (shared by the command list and the Notes panel). */
import { announce, toast } from "./kit.js";
import type { DocCtx } from "./docctx.js";
import { api, errorText } from "./net.js";

export async function addNoteAtSelection(ctx: DocCtx): Promise<string | null> {
  const sel = ctx.ed.recallSelection();
  if (!sel || sel.start.field !== "text") { toast("Click in a paragraph (or select some text) first.", { kind: "info" }); return null; }
  const ranged = !sel.collapsed && sel.end.block === sel.start.block;
  try {
    const row = await api.post<{ id: string }>(`/docs/${encodeURIComponent(ctx.sid)}/notes`, {
      block: sel.start.block, start: ranged ? sel.start.offset : undefined, end: ranged ? sel.end.offset : undefined, anchorText: ranged ? ctx.ed.selectionText(sel).slice(0, 300) : "", body: "",
    });
    announce("Note added.");
    ctx.ui.openPanel("yellow", "notes");
    return row.id;
  } catch (e) { toast(errorText(e), { kind: "error" }); return null; }
}
