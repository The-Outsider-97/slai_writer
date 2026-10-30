/** The pen menu's "Signature graphics": place a saved visible mark into the open document. A visible mark is a picture, never proof of identity or integrity. */
import { announce, confirmDialog, h, openDialog, toast } from "./kit.js";
import { api, errorText } from "./net.js";
import { placeMark, VISUAL_WARNING } from "./screens/signatures.js";
import { notice } from "./widgets.js";
export async function signatureGraphicsDialog(ctx) {
    const { ed, app } = ctx;
    if (ed.readOnly) {
        toast("This document is read-only, so nothing can be placed in it.", { kind: "info" });
        return;
    }
    let data;
    try {
        data = await api.get("/signing/marks");
    }
    catch (error) {
        toast(errorText(error), { kind: "error" });
        return;
    }
    const sel = ed.recallSelection();
    const after = sel?.end.block ?? ed.model.order[ed.model.order.length - 1] ?? null;
    const width = h("input", { type: "number", min: 10, max: 200, value: "45", attrs: { "aria-label": "Width in millimetres" } });
    const list = h("ul", { class: "mark-list" });
    const handle = openDialog({
        title: "Signature graphics", size: "wide", noCancel: false, cancelLabel: "Close",
        body: h("div", { class: "stack" }, notice(VISUAL_WARNING + " To sign this document so that changes can be detected, use Sign revision.", "warn", "A picture is not a signature."), data.marks.length ? h("div", {}, h("label", { text: "Width (mm) " }), width) : h("p", { class: "muted", text: "You have no saved graphics yet. Draw or upload one in the Signature graphics library." }), list),
        actions: [{ label: "Open the library", run: () => { app.go({ name: "signatures" }); return true; } }],
    });
    for (const mark of data.marks) {
        const place = h("button", { class: "btn small", type: "button", text: "Place after the cursor" });
        place.addEventListener("click", () => {
            void (async () => {
                place.disabled = true;
                try {
                    const confirmed = await confirmDialog({ title: `Place “${mark.label}”?`, message: "It is added as a picture with a description, as one undoable edit. This does not sign the document.", confirmLabel: "Place graphic" });
                    if (!confirmed)
                        return;
                    const state = await ed.call(() => placeMark(ctx.sid, mark.id, after, Math.max(10, Math.min(200, Number(width.value) || 45))), undefined);
                    await ed.resync(state);
                    announce("Signature graphic placed.");
                    handle.close(true);
                }
                catch (error) {
                    toast(errorText(error), { kind: "error" });
                }
                finally {
                    place.disabled = false;
                }
            })();
        });
        list.appendChild(h("li", {}, mark.image ? h("img", { class: "mark-thumb", attrs: { src: mark.image, alt: "" } }) : null, h("span", { class: "grow", text: `${mark.label}` }), place));
    }
    await handle.result;
}
