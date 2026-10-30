/** Saving: Save, Save as, the autosave menu, and what to do when the file changed on disk while there were unsaved edits. */
import { ApiError, announce, confirmDialog, h, labelled, openDialog, openMenu, promptDialog, toast } from "./kit.js";
import { chooseFile } from "./fileops.js";
import { api, errorText } from "./net.js";
import { checkbox, errorLine, notice } from "./widgets.js";
const base = (ctx) => `/docs/${encodeURIComponent(ctx.sid)}`;
function recordSave(ctx, result) {
    const { app, ed } = ctx;
    app.docs.set(ctx.sid, result.summary);
    ed.model.state = { ...ed.model.state, ...result.summary, dirty: result.dirty, savedAt: result.savedAt };
    app.events.emit({ type: "docs" });
    ctx.ui.refreshStatus();
}
function ofKind(error, kind) {
    return error instanceof ApiError && error.details?.kind === kind;
}
/** Save, or Save as when the document has no file yet. Returns true when the file was written. */
export async function saveDocument(ctx) {
    const { app, ed } = ctx;
    if (ed.readOnly) {
        toast("This document is read-only. Use Save as to keep an editable copy.", { kind: "info" });
        return false;
    }
    const summary = app.docs.get(ctx.sid);
    if (!summary?.path)
        return saveAsDialog(ctx);
    try {
        const result = await ed.call(() => api.post(`${base(ctx)}/save`, {}));
        recordSave(ctx, result);
        announce("Saved.");
        toast("Saved.", { kind: "ok", timeoutMs: 1800 });
        return true;
    }
    catch (error) {
        if (ofKind(error, "external_change"))
            return externalDialog(ctx);
        toast(errorText(error), { kind: "error", timeoutMs: 9000 });
        return false;
    }
}
/** Choose a name and a folder, then write the file. */
export async function saveAsDialog(ctx) {
    const { app } = ctx;
    const summary = app.docs.get(ctx.sid);
    const name = h("input", { type: "text", value: summary?.name ?? "Untitled document", maxLength: 120, attrs: { autocomplete: "off", spellcheck: "false" } });
    let folder = null;
    const where = h("span", { class: "grow", text: "The Writer library on this computer" });
    const choose = h("button", { class: "btn", type: "button", text: "Choose a folder…" });
    choose.addEventListener("click", () => {
        void (async () => {
            const picked = await chooseFile(app, { kind: "folder", start: folder ?? app.prefs.last_folder ?? app.boot.storage.library, title: "Choose a folder for the document" });
            if (picked) {
                folder = picked;
                where.textContent = picked;
            }
        })();
    });
    const copy = checkbox("Save as a separate document (it gets its own identity; signatures are not carried over)", false);
    const error = errorLine();
    const handle = openDialog({
        title: summary?.path ? "Save as" : "Save document", body: h("div", { class: "stack" }, labelled("File name", name, { hint: "The .sldc extension is added for you." }), h("div", { class: "row" }, h("strong", { text: "Folder: " }), where, choose), copy.root, error.el),
        actions: [{ label: "Save", kind: "primary", run: async () => {
                    error.show(null);
                    const post = (overwrite) => api.post(`${base(ctx)}/save-as`, { name: name.value, directory: folder ?? undefined, newCopy: copy.input.checked, overwrite });
                    try {
                        await ctx.ed.whenIdle();
                        let result;
                        try {
                            result = await ctx.ed.call(() => post(false));
                        }
                        catch (e) {
                            if (e instanceof ApiError && e.code === "conflict") {
                                if (!await confirmDialog({ title: "Replace the existing file?", message: e.friendly, confirmLabel: "Replace it", danger: true }))
                                    return undefined;
                                result = await ctx.ed.call(() => post(true));
                            }
                            else
                                throw e;
                        }
                        recordSave(ctx, result);
                        await app.openDocs();
                        ctx.ui.refreshStatus();
                        announce("Saved.");
                        toast(`Saved to ${result.path}`, { kind: "ok" });
                        return true;
                    }
                    catch (e) {
                        error.show(errorText(e));
                        return undefined;
                    }
                } }],
    });
    return (await handle.result) === true;
}
/** Right-click on Save: autosave on or off for this document, and how often. */
export function autosaveMenu(ctx, anchor) {
    const { app } = ctx;
    const on = app.prefs.autosave;
    const post = async (body) => {
        try {
            const out = await api.post(`${base(ctx)}/autosave`, body);
            await app.refresh();
            toast(`Autosave is ${out.enabled ? `on, every ${out.seconds} seconds` : "off"} for this document.`, { kind: "ok" });
            ctx.ui.refreshStatus();
        }
        catch (e) {
            toast(errorText(e), { kind: "error" });
        }
    };
    openMenu(anchor, [
        { label: on ? "Turn autosave off for this document" : "Turn autosave on for this document", icon: "save", run: () => { void post({ enabled: !on }); } },
        { label: `Autosave interval: ${app.prefs.autosave_seconds} seconds…`, icon: "clock", run: () => {
                void (async () => {
                    const v = await promptDialog({ title: "Autosave interval", label: "Seconds between automatic saves (10 to 3600)", value: String(app.prefs.autosave_seconds), maxLength: 4, confirmLabel: "Set interval", validate: (x) => (/^\d+$/.test(x) && Number(x) >= 10 && Number(x) <= 3600 ? null : "Enter a whole number from 10 to 3600.") });
                    if (v !== null)
                        await post({ seconds: Number(v) });
                })();
            } },
        "separator",
        { label: "Save as…", icon: "save", run: () => { void saveAsDialog(ctx); } },
    ], { label: "Save options" });
}
/** Show the places changed on both sides, and ask whether to merge anyway (keeping the person's text there). */
export async function confirmConflicts(out) {
    const conflicts = out.conflicts ?? [];
    const list = h("ul", { class: "panel-list" }, conflicts.slice(0, 20).map((c) => h("li", {}, h("div", { class: "diff-box" }, h("div", {}, h("strong", { text: "Yours" }), h("p", { text: c.ours ?? "(removed)" })), h("div", {}, h("strong", { text: "Theirs" }), h("p", { text: c.theirs ?? "(removed)" }))))));
    const keep = await openDialog({ title: `${conflicts.length} place${conflicts.length === 1 ? "" : "s"} changed on both sides`, size: "wide",
        body: h("div", { class: "stack" }, notice(out.message ?? "Nothing was merged yet.", "info"), list, h("p", { text: "You can merge anyway: your text is kept in these places, and their whole version is saved to Version history so nothing is lost." })),
        actions: [{ label: "Merge, keeping my text", kind: "primary", run: () => true }] }).result;
    return keep === true;
}
/* -------------------------------------------------------------------------------------------- changed on disk */
export async function externalDialog(ctx) {
    const { ed } = ctx;
    let done = false;
    const act = async (action, extra = {}) => ed.call(() => api.post(`${base(ctx)}/external`, { action, ...extra }));
    const choice = (title, text, run, danger = false) => {
        const b = h("button", { class: `btn block${danger ? " danger" : ""}`, type: "button" }, h("strong", { text: title }), h("span", { class: "muted", text }));
        b.addEventListener("click", () => { void (async () => { b.disabled = true; try {
            await run();
        }
        catch (e) {
            toast(errorText(e), { kind: "error" });
        }
        finally {
            b.disabled = false;
        } })(); });
        return b;
    };
    const handle = openDialog({
        title: "This file was changed by another program", size: "wide", cancelLabel: "Decide later",
        body: h("div", { class: "stack" }, notice("Someone or something else saved this file since you opened it, and you have changes that are not saved. Nothing has been overwritten. Choose what should happen:", "warn"), choice("Merge their changes with mine", "Combines both. Places changed on both sides are shown to you before anything is decided.", async () => {
            const out = await act("merge");
            if (out.applied && out.state) {
                await ed.resync(out.state);
                done = true;
                toast("Merged. Both sets of changes are in the document; save when you are happy with it.", { kind: "ok" });
                handle.close(true);
                return;
            }
            if (!await confirmConflicts(out))
                return;
            const merged = await act("merge", { acceptConflicts: true });
            if (merged.state) {
                await ed.resync(merged.state);
                done = true;
                toast("Merged. Their version is kept in Version history.", { kind: "ok" });
                handle.close(true);
            }
        }), choice("Keep both: save mine as a separate file", "Your version is saved next to the original under a new name. The other program's file is left exactly as it is.", async () => {
            const out = await act("keep_both");
            recordSave(ctx, out);
            await ctx.app.openDocs();
            done = true;
            toast(`Your version was saved as ${out.name ?? "a separate file"}.`, { kind: "ok" });
            handle.close(true);
        }), choice("Overwrite their changes with mine", "The other program's changes are lost from this file. A copy of your document is kept in Version history first.", async () => {
            if (!await confirmDialog({ title: "Overwrite the other program's changes?", message: "Their changes to this file will be replaced by your document.", confirmLabel: "Overwrite", danger: true }))
                return;
            const out = await act("overwrite");
            recordSave(ctx, out);
            done = true;
            handle.close(true);
        }, true), choice("Reload from disk and discard my unsaved changes", "Your unsaved edits are dropped. A copy is kept in Version history first.", async () => {
            if (!await confirmDialog({ title: "Discard your unsaved changes?", message: "Your document will be replaced by the file on disk.", confirmLabel: "Reload from disk", danger: true }))
                return;
            const state = await act("reload");
            await ed.resync(state);
            ctx.ui.refreshStatus();
            done = true;
            handle.close(true);
        }, true)),
    });
    await handle.result;
    return done;
}
