/** Paragraph font settings use SLDC's existing named-style operation and validator. */
import { h, openDialog, toast } from "./kit.js";
import type { DocCtx } from "./docctx.js";
import type { Block, Op } from "./types.js";
import { resolveStyle } from "./render.js";
import { errorText } from "./net.js";
import { FONT_FAMILIES, paragraphFontProps } from "./font_rules.js";

function selectedBlocks(ctx: DocCtx): Block[] {
  const sel = ctx.ed.recallSelection();
  if (!sel) return [];
  const first = ctx.ed.model.indexOf(sel.start.block);
  const last = ctx.ed.model.indexOf(sel.end.block);
  if (first < 0 || last < first) return [];
  return ctx.ed.model.order.slice(first, last + 1)
    .map((id) => ctx.ed.model.block(id))
    .filter((b): b is Block => !!b && ["heading", "paragraph", "list_item", "quote", "code"].includes(b.type));
}

/** Font settings for complete paragraphs. Inline mixed-font runs require a separate SLDC schema extension. */
export async function paragraphFontDialog(ctx: DocCtx): Promise<void> {
  if (ctx.ed.readOnly) return;
  const blocks = selectedBlocks(ctx);
  if (!blocks.length) { toast("Place the cursor in a paragraph first.", { kind: "info" }); return; }
  const firstStyle = resolveStyle(ctx.ed.model.meta, "paragraph", blocks[0]?.style);
  const family = h("select", { attrs: { "aria-label": "Font family" } }, FONT_FAMILIES.map((f) => h("option", { value: f, text: f })));
  family.value = FONT_FAMILIES.find((f) => f === firstStyle["font_family"]) ?? "Arial";
  const size = h("input", { type: "number", value: String(firstStyle["font_size_pt"] ?? 12), min: 4, max: 400, step: 0.5, attrs: { "aria-label": "Font size in points" } });
  await openDialog<true>({
    title: "Paragraph font settings", size: "narrow",
    body: h("div", { class: "stack" },
      h("label", {}, "Font family", family),
      h("label", {}, "Size (pt)", size),
      h("p", { class: "fine", text: "Applies to whole selected paragraphs. Existing character formatting and paragraph spacing are preserved." })),
    actions: [{ label: "Apply font", kind: "primary", run: async () => {
      try {
        const pt = Number(size.value);
        if (!size.value.trim() || !Number.isFinite(pt)) throw new RangeError("Enter a valid font size.");
        const ops: Op[] = [];
        const styleNames = new Map<string, string>();
        for (const block of blocks) {
          const props = paragraphFontProps(resolveStyle(ctx.ed.model.meta, "paragraph", block.style), family.value, pt);
          const key = JSON.stringify(props);
          let name = styleNames.get(key);
          if (!name) {
            name = `WriterFont_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
            styleNames.set(key, name);
            ops.push({ op: "style_define", kind: "paragraph", name, props });
          }
          ops.push({ op: "block_set", block: block.id, style: name });
        }
        await ctx.ed.op({ op: "batch", ops, label: "paragraph font" });
        return true;
      } catch (error) { toast(errorText(error), { kind: "error" }); return undefined; }
    } }],
  }).result;
}
