/** Private notes (this computer only, never part of the file) and comment threads (stored in the document, so they travel with it). */
import { announce, clear, confirmDialog, h, toast } from "../kit.js";
import { addNoteAtSelection } from "../notesapi.js";
import { api, errorText } from "../net.js";
import { ago, emptyState, fill, notice, statusBadge } from "../widgets.js";
import { commentDialog } from "../dialogs.js";
/** Where a note's words are now. Offsets saved with the note are only trusted while the same words are still there; otherwise the words are searched for. */
export function resolveNote(ctx, note) {
    if (!note.block_id || note.start === null || note.end === null)
        return null;
    const block = ctx.ed.model.block(note.block_id);
    if (!block)
        return null;
    if (!note.anchor_text)
        return block.text.length >= note.end ? { start: note.start, end: note.end } : null;
    if (block.text.slice(note.start, note.end) === note.anchor_text)
        return { start: note.start, end: note.end };
    const at = block.text.indexOf(note.anchor_text);
    return at >= 0 ? { start: at, end: at + note.anchor_text.length } : null;
}
export async function loadNotes(ctx) { return (await api.get(`/docs/${encodeURIComponent(ctx.sid)}/notes`)).notes; }
export function paintNoteMarks(ctx, notes) {
    ctx.ed.decor.set("note", notes.flatMap((n) => { const at = resolveNote(ctx, n); return at && n.block_id ? [{ block: n.block_id, start: at.start, end: at.end, id: n.id }] : []; }));
}
export function paintCommentMarks(ctx) {
    ctx.ed.decor.set("comment", ctx.ed.model.comments.flatMap((t) => {
        const a = t.anchor;
        if (t.status !== "open" || a.start === undefined || a.end === undefined || a.end <= a.start || (t.anchorStatus && t.anchorStatus !== "ok"))
            return [];
        return [{ block: a.block, start: a.start, end: a.end, id: t.id }];
    }));
}
export function createNotesPanel(ctx, onChange) {
    const root = h("div", { class: "stack" });
    const list = h("div", { attrs: { "aria-live": "polite" } });
    let focusNext = null;
    const paint = async () => {
        let notes;
        try {
            notes = await loadNotes(ctx);
        }
        catch (e) {
            clear(list);
            fill(list, notice(errorText(e), "danger"));
            return;
        }
        onChange(notes);
        clear(list);
        if (!notes.length) {
            list.appendChild(emptyState("No notes yet.", "Select some text and choose Private note, or double-click a search result, to attach a note to it."));
            return;
        }
        const ul = h("ul", { class: "panel-list" });
        for (const n of notes) {
            const at = resolveNote(ctx, n);
            const body = h("textarea", { rows: 3, maxLength: 8000, value: n.body, attrs: { "aria-label": `Note${n.anchor_text ? ` on “${n.anchor_text.slice(0, 40)}”` : ""}` } });
            let saved = n.body;
            const save = async () => {
                if (body.value === saved)
                    return;
                try {
                    await api.post(`/docs/${encodeURIComponent(ctx.sid)}/notes`, { id: n.id, body: body.value });
                    saved = body.value;
                }
                catch (e) {
                    toast(errorText(e), { kind: "error" });
                }
            };
            body.addEventListener("blur", () => { void save(); });
            const go = h("button", { class: "linkbtn", type: "button", text: n.anchor_text ? `“${n.anchor_text.slice(0, 80)}”` : "Whole paragraph", disabled: !n.block_id || !ctx.ed.model.block(n.block_id) });
            go.addEventListener("click", () => { if (n.block_id)
                ctx.ed.scrollToBlock(n.block_id, at?.start); });
            const del = h("button", { class: "btn small danger", type: "button", text: "Delete note" });
            del.addEventListener("click", () => {
                void (async () => {
                    if (!await confirmDialog({ title: "Delete this note?", message: "Notes are kept only on this computer. A deleted note cannot be brought back.", confirmLabel: "Delete note", danger: true }))
                        return;
                    try {
                        await api.del(`/docs/${encodeURIComponent(ctx.sid)}/notes/${encodeURIComponent(n.id)}`);
                        await paint();
                    }
                    catch (e) {
                        toast(errorText(e), { kind: "error" });
                    }
                })();
            });
            ul.appendChild(h("li", { data: { note: n.id } }, go, n.block_id && !at && n.anchor_text ? h("div", { class: "fine", text: "The words this note was attached to have changed or been removed." }) : null, body, h("div", { class: "actions" }, del)));
            if (focusNext === n.id)
                window.setTimeout(() => body.focus(), 0);
        }
        focusNext = null;
        list.appendChild(ul);
    };
    fill(root, h("h2", { text: "Notes" }), h("p", { class: "fine", text: "Notes stay on this computer. They are not part of the document file and are not shared when you send it." }), h("div", { class: "actions" }, (() => { const b = h("button", { class: "btn", type: "button", text: "Add note at the cursor" }); b.addEventListener("click", () => { void addNoteAtSelection(ctx).then(async (id) => { focusNext = id; await paint(); }); }); return b; })()), list);
    return { el: root, refresh: paint };
}
/** Make a note from a search match (double-click on a green result). */
export async function noteFromMatch(ctx, block, start, end) {
    const b = ctx.ed.model.block(block);
    if (!b)
        return null;
    const row = await api.post(`/docs/${encodeURIComponent(ctx.sid)}/notes`, { block, start, end, anchorText: b.text.slice(start, end), body: "" });
    announce("Note created from the search result. Type it in the Notes panel.");
    return row.id;
}
export function createCommentsPanel(ctx) {
    const root = h("div", { class: "stack" });
    const list = h("div", { attrs: { "aria-live": "polite" } });
    const url = (tail) => `/docs/${encodeURIComponent(ctx.sid)}/comments${tail}`;
    const send = async (tail, body) => {
        const reply = await ctx.ed.call(() => api.post(url(tail), body));
        ctx.ed.applyComments(reply);
    };
    const quote = (t) => {
        const b = ctx.ed.model.block(t.anchor.block);
        if (!b)
            return "";
        if (t.anchor.start !== undefined && t.anchor.end !== undefined)
            return b.text.slice(t.anchor.start, t.anchor.end).slice(0, 120);
        return b.text.slice(0, 80);
    };
    const paint = () => {
        clear(list);
        const threads = ctx.ed.model.comments;
        if (!threads.length) {
            list.appendChild(emptyState("No comments yet.", "Select text and choose Comment to start a conversation about it."));
            return;
        }
        const ul = h("ul", { class: "panel-list" });
        for (const t of threads) {
            const open = t.status === "open";
            const moved = t.anchorStatus !== undefined && t.anchorStatus !== "ok";
            const go = h("button", { class: "linkbtn", type: "button", text: quote(t) ? `“${quote(t)}”` : "Go to the comment", disabled: !ctx.ed.model.block(t.anchor.block) });
            go.addEventListener("click", () => ctx.ed.scrollToBlock(t.anchor.block, t.anchor.start));
            const reply = h("textarea", { rows: 2, maxLength: 4000, attrs: { "aria-label": "Reply", placeholder: "Reply…" } });
            const send1 = h("button", { class: "btn small", type: "button", text: "Reply", disabled: ctx.ed.readOnly });
            send1.addEventListener("click", () => {
                void (async () => {
                    if (!reply.value.trim())
                        return;
                    send1.disabled = true;
                    try {
                        await send(`/${encodeURIComponent(t.id)}/reply`, { text: reply.value.trim() });
                    }
                    catch (e) {
                        toast(errorText(e), { kind: "error" });
                        send1.disabled = false;
                    }
                })();
            });
            const toggle = h("button", { class: "btn small", type: "button", text: open ? "Resolve" : "Reopen", disabled: ctx.ed.readOnly });
            toggle.addEventListener("click", () => { void send(`/${encodeURIComponent(t.id)}/status`, { status: open ? "resolved" : "open" }).catch((e) => toast(errorText(e), { kind: "error" })); });
            ul.appendChild(h("li", { class: `thread${open ? "" : " resolved"}`, data: { thread: t.id } }, h("div", {}, statusBadge(open ? "Open" : "Resolved", open ? "warn" : "ok"), moved ? statusBadge("Text changed", "idle") : null), go, t.messages.map((m) => h("div", { class: "msg" }, h("strong", { text: m.author }), h("span", { class: "fine", text: ` · ${ago(Date.parse(m.created) / 1000)}` }), h("p", { text: m.text }))), open ? reply : null, h("div", { class: "actions" }, open ? send1 : null, toggle)));
        }
        list.appendChild(ul);
    };
    const add = h("button", { class: "btn", type: "button", text: "Add comment…", disabled: ctx.ed.readOnly });
    add.addEventListener("click", () => {
        void (async () => {
            const input = await commentDialog(ctx);
            if (input) {
                try {
                    await send("", input);
                }
                catch (e) {
                    toast(errorText(e), { kind: "error" });
                }
            }
        })();
    });
    fill(root, h("h2", { text: "Comments" }), h("p", { class: "fine", text: "Comments are stored in the document, so they travel with the file. Anyone who opens it can read them." }), h("div", { class: "actions" }, add), list);
    const off = ctx.ed.events.on((e) => { if (e.type === "comments" || e.type === "reloaded") {
        paint();
        paintCommentMarks(ctx);
    } });
    paintCommentMarks(ctx);
    return { el: root, refresh: async () => { await ctx.ed.refreshComments().catch(() => undefined); paint(); paintCommentMarks(ctx); }, destroy: off };
}
