import { api, errorText } from "../net.js";
import { openFile, openFolder, openPath, withPassword, chooseFile } from "../fileops.js";
import { buildShell } from "../shell.js";
import { clear, confirmDialog, glyph, h, openMenu, plural, toast } from "../kit.js";
import { ago, button, emptyState, notice, run, statusBadge } from "../widgets.js";
function locationOf(d) {
    if (d.folder)
        return `Local / ${d.folder}`;
    const parts = d.location.split(/[\\/]/).filter(Boolean);
    return `Local / ${parts[parts.length - 1] ?? d.location}`;
}
function statusOf(d) {
    if (d.state === "missing")
        return statusBadge("Missing", "danger");
    if (d.state === "unsaved")
        return statusBadge("Unsaved changes", "warn");
    if (d.state === "recovered")
        return statusBadge("Recovery available", "warn");
    return statusBadge(d.open ? "Saved · open" : "Saved", "ok");
}
export async function homeScreen(app) {
    let query = "";
    let data = await api.get("/home");
    const shell = buildShell(app, "home", { searchPlaceholder: "Search by title or folder", onSearch: (q) => { query = q; void reload(); } });
    const tableHost = h("div", { class: "table-wrap" });
    const foldersHost = h("div", { class: "folders" });
    const folderDocs = h("div", { class: "folder-docs" });
    const recoveryHost = h("div", { class: "recovery" });
    let openFolderId = null;
    const reload = async () => { data = await api.get("/home", query ? { q: query } : undefined); paint(); };
    const rowMenu = (d, anchor) => {
        openMenu(anchor, [
            { label: "Open", icon: "folder-open", run: () => { void guard(() => openPath(app, d.path)); } },
            { label: d.favorite ? "Remove from favourites" : "Add to favourites", icon: "star", run: () => { void guard(async () => { await api.post("/library/favorite", { path: d.path, value: !d.favorite }); await reload(); }); } },
            ...(d.state === "missing" ? [{ label: "Locate…", icon: "search", run: () => { void guard(() => locate(d)); } }] : []),
            "separator",
            { label: "Remove from recent", icon: "close", run: () => { void guard(async () => { await api.post("/library/forget", { path: d.path }); toast("Removed from recent. The file itself was not touched."); await reload(); }); } },
        ], { label: `Actions for ${d.name}`, align: "end" });
    };
    const guard = async (work) => { try {
        await work();
    }
    catch (e) {
        toast(errorText(e), { kind: "error" });
    } };
    const locate = async (d) => {
        const path = await chooseFile(app, { kind: "open", extensions: [".sldc", ".sdoc"], title: `Where is ${d.name}?`, start: app.prefs.last_folder });
        if (!path)
            return;
        await api.post("/library/locate", { path: d.path, newPath: path });
        toast("The entry now points to the file you chose.", { kind: "ok" });
        await reload();
    };
    const paint = () => {
        clear(tableHost);
        if (!data.documents.length) {
            tableHost.appendChild(emptyState(query ? "No documents match." : "No recent documents yet.", query ? "Try a title or folder name." : "Create a new document or open a file on this computer. Guests can create, edit, save and export without an account."));
        }
        else {
            const body = h("tbody");
            for (const d of data.documents) {
                const open = h("button", { class: "linkbtn doc-open", type: "button", attrs: { title: d.path } }, d.favorite ? glyph("star", "Favourite") : null, `${d.name}${d.legacy ? ".sdoc" : ".sldc"}`);
                open.addEventListener("click", () => { void run(open, async () => { if (d.open && d.sid) {
                    app.go({ name: "doc", sid: d.sid });
                    return;
                } await openPath(app, d.path); }); });
                const more = h("button", { class: "iconbtn", type: "button", attrs: { "aria-label": `Actions for ${d.name}` } }, glyph("more"));
                more.addEventListener("click", () => rowMenu(d, more));
                body.appendChild(h("tr", { class: d.state === "missing" ? "missing" : "" }, h("th", { scope: "row" }, open, d.legacy ? h("span", { class: "badge", text: "older file name", title: ".sdoc files are read as SLDC when their content is SLDC" }) : null), h("td", { text: locationOf(d) }), h("td", {}, statusOf(d)), h("td", { class: "narrow" }, more)));
            }
            tableHost.appendChild(h("table", { class: "docs" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Document" }), h("th", { scope: "col", text: "Location" }), h("th", { scope: "col", text: "Status" }), h("th", { scope: "col" }, h("span", { class: "visually-hidden", text: "Actions" })))), body));
        }
        // folders
        clear(foldersHost);
        if (!data.folders.length)
            foldersHost.appendChild(h("p", { class: "muted", text: "No folders yet. Use Open folder to add one: Home lists the documents inside it." }));
        for (const f of data.folders) {
            const b = h("button", { class: `folder-chip${openFolderId === f.id ? " current" : ""}`, type: "button", attrs: { "aria-pressed": String(openFolderId === f.id), title: f.path } }, glyph("folder"), f.name);
            b.addEventListener("click", () => { void run(b, async () => { openFolderId = openFolderId === f.id ? null : f.id; await paintFolder(); paint(); }); });
            const remove = h("button", { class: "iconbtn tiny", type: "button", attrs: { "aria-label": `Remove folder ${f.name} from Home`, title: "Remove from Home (the folder itself is untouched)" } }, glyph("close"));
            remove.addEventListener("click", () => { void run(remove, async () => { if (!await confirmDialog({ title: `Remove ${f.name}?`, message: "It disappears from Home. The folder and its files stay where they are.", confirmLabel: "Remove" }))
                return; await api.del(`/library/folders/${f.id}`); if (openFolderId === f.id)
                openFolderId = null; await reload(); }); });
            foldersHost.appendChild(h("span", { class: "folder-item" }, b, remove));
        }
        // recovery
        clear(recoveryHost);
        if (data.recovery.length)
            recoveryHost.appendChild(recoveryBanner(data.recovery));
    };
    const paintFolder = async () => {
        clear(folderDocs);
        if (!openFolderId)
            return;
        try {
            const { documents } = await api.get(`/library/folders/${openFolderId}/documents`);
            if (!documents.length) {
                folderDocs.appendChild(h("p", { class: "muted", text: "No SLDC documents in this folder." }));
                return;
            }
            folderDocs.appendChild(h("ul", { class: "folder-list" }, documents.map((d) => {
                const b = h("button", { class: "linkbtn", type: "button" }, d.name + (d.legacy ? ".sdoc" : ".sldc"));
                b.addEventListener("click", () => { void run(b, async () => { if (d.damaged) {
                    toast("This file looks damaged. Try Open to see what Writer can recover.", { kind: "error" });
                } await openPath(app, d.path); }); });
                return h("li", {}, b, d.damaged ? statusBadge("Damaged", "danger") : null, d.encrypted ? statusBadge("Protected", "idle") : null, h("span", { class: "muted", text: ` ${ago(d.modified)}` }));
            })));
        }
        catch (e) {
            folderDocs.appendChild(notice(errorText(e), "warn"));
        }
    };
    const recoveryBanner = (items) => {
        const list = h("ul", { class: "recovery-list" }, items.map((r) => {
            const b = h("button", { class: "btn", type: "button" }, "Open recovery copy");
            b.addEventListener("click", () => {
                void run(b, async () => {
                    const state = await withPassword("Open protected recovery copy", (password) => api.post(`/recovery/${r.id}/open`, { password: password ?? "" }));
                    if (state) {
                        app.remember(state);
                        app.go({ name: "doc", sid: state.sid });
                    }
                });
            });
            const drop = h("button", { class: "btn", type: "button" }, "Discard");
            drop.addEventListener("click", () => {
                void run(drop, async () => {
                    if (!await confirmDialog({ title: "Discard this recovery copy?", message: `The unsaved work of ${r.name} cannot be brought back afterwards.`, confirmLabel: "Discard", danger: true }))
                        return;
                    await api.del(`/recovery/${r.id}`);
                    await reload();
                });
            });
            return h("li", {}, h("span", { class: "grow" }, h("strong", { text: r.name }), ` · saved ${ago(r.saved)}`, r.encrypted ? " · protected" : "", r.path ? "" : " · was never saved"), b, drop);
        }));
        return h("section", { class: "notice warn", attrs: { role: "region", "aria-label": "Recovery" } }, glyph("alert"), h("div", {}, h("strong", { text: `Recovery available: inspect a snapshot before restoring. ` }), plural(items.length, "copy", "copies"), " from an earlier session. Opening one shows a separate copy; your saved file is not changed.", list));
    };
    shell.main.append(h("h2", { class: "page-title", text: "Home" }), h("p", { class: "muted", text: "Recent documents, local folders and shared work" }), h("div", { class: "actions" }, button("New document", () => { app.go({ name: "new" }); }, "primary", "plus"), button("Open local file", () => openFile(app), "", "folder-open"), button("Open folder", async () => { if (await openFolder(app))
        await reload(); }, "", "folder")), tableHost, h("h3", { text: "Folders" }), foldersHost, folderDocs, recoveryHost);
    paint();
    return { el: shell.el, destroy: shell.dispose, focus: () => shell.search?.focus() };
}
