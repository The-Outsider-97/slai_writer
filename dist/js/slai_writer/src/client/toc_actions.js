import { toast } from "./kit.js";
import { api, errorText } from "./net.js";
import { tocCoverAnchor } from "./toc_position.js";
export const TOC_KEY = "slai.sldc.toc";
export const TOC_STYLE_KEY = "slai.writer.toc_style";
/** The managed tables of contents of the document. */
export function allTocs(ed) {
    const found = new Map();
    for (const block of ed.model.list()) {
        const core = block.extensions?.[TOC_KEY];
        if (!core?.id)
            continue;
        let info = found.get(core.id);
        if (core.role === "title") {
            const stored = (block.extensions?.[TOC_STYLE_KEY] ?? {});
            const look = {
                preset: stored.preset ?? "custom", leader: stored.leader ?? (core.leader_dots === false ? "none" : "dots"), page_align: stored.page_align ?? "right",
                hyperlinks: stored.hyperlinks ?? true, numbered: stored.numbered ?? false,
                page_position: stored.page_position ?? stored.page_align ?? "right",
                ...(stored.number_align ? { number_align: stored.number_align } : {}), ...(stored.custom_tab_mm !== undefined ? { custom_tab_mm: stored.custom_tab_mm } : {}),
                ...(stored.number_column_mm !== undefined ? { number_column_mm: stored.number_column_mm } : {}), ...(stored.leader_char ? { leader_char: stored.leader_char } : {}),
                ...(stored.leader_gap_pt !== undefined ? { leader_gap_pt: stored.leader_gap_pt } : {}), ...(stored.text_align ? { text_align: stored.text_align } : {}),
            };
            info = { id: core.id, title: block, entries: info?.entries ?? [], core, look };
            found.set(core.id, info);
        }
        else if (info)
            info.entries.push(block);
        else
            found.set(core.id, { id: core.id, title: block, entries: [block], core, look: { preset: "custom", leader: "dots", page_align: "right", page_position: "right", hyperlinks: true, numbered: false } });
    }
    return [...found.values()].filter((t) => t.core.role === "title");
}
/** The table the caret is in, or the only table of the document. */
export function tocTarget(ed) {
    const tocs = allTocs(ed);
    const caret = ed.recallSelection()?.start.block;
    const inside = caret ? ed.model.block(caret)?.extensions?.[TOC_KEY] : undefined;
    return (inside ? tocs.find((t) => t.id === inside.id) : undefined) ?? (tocs.length === 1 ? tocs[0] ?? null : null);
}
async function call(ed, work, done) {
    if (ed.readOnly) {
        toast("This document is read-only.", { kind: "info" });
        return null;
    }
    try {
        const result = await ed.call(work, (r) => r.patch);
        toast(done, { kind: "ok" });
        return result;
    }
    catch (error) {
        if (error.details?.kind !== "stale_version")
            toast(errorText(error), { kind: "error" });
        return null;
    }
}
const base = (ed) => `/docs/${encodeURIComponent(ed.sid)}/contents`;
export async function insertToc(ed, look, options = {}) {
    const caret = ed.recallSelection()?.end.block ?? null;
    const after = caret ?? tocCoverAnchor(ed.model.list(), ed.model.meta.sections ?? []);
    const result = await call(ed, () => api.post(base(ed), { after, title: options.title ?? "Contents", depth: options.depth ?? 3, look }), "Table of contents inserted.");
    if (result?.heading)
        ed.focusBlock(result.heading, 0);
    return result !== null;
}
/** Bring one table up to date; `look` changes how it looks (style, options, formatting) in the same step. */
export async function updateToc(ed, id, body = {}, done = "Table of contents updated.") {
    return (await call(ed, () => api.post(`${base(ed)}/${encodeURIComponent(id)}/refresh`, body), done)) !== null;
}
/** Page numbers are measured from the exact layout, never stored: measuring again (and redrawing them) is all it takes. */
export function updatePageNumbers(ed) {
    ed.schedulePrintLayout();
    toast("Page numbers are being measured again.", { kind: "info" });
}
export async function removeToc(ed, id) {
    if (ed.readOnly) {
        toast("This document is read-only.", { kind: "info" });
        return false;
    }
    try {
        const result = await ed.call(() => api.post(`${base(ed)}/${encodeURIComponent(id)}/remove`, {}));
        await ed.resync(result.state);
        toast("Table of contents removed. Your headings are unchanged.", { kind: "ok" });
        return true;
    }
    catch (error) {
        if (error.details?.kind !== "stale_version")
            toast(errorText(error), { kind: "error" });
        return false;
    }
}
