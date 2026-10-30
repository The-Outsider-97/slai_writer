/** Version history: named versions, opening an old one read-only, comparing and restoring (always as a new revision). */
import type { App, Screen } from "../app.js";
import { api } from "../net.js";
import { buildShell } from "../shell.js";
import { clear, confirmDialog, formatBytes, glyph, h, promptDialog, toast } from "../kit.js";
import type { DocState, VersionRow } from "../types.js";
import { button, emptyState, notice, run, statusBadge, when, fill } from "../widgets.js";
import { showCompare } from "./signing.js";

interface VersionsData { versions: VersionRow[]; current: { number: number; id: string; history: number } }

const KIND: Record<string, string> = { manual: "Named version", auto: "Automatic (before a risky change)", signed: "Signed revision", save: "Saved", import: "Imported" };

export async function versionsScreen(app: App, route: { sid?: string }): Promise<Screen> {
  const sid = route.sid ?? "";
  const doc = await api.get<DocState>(`/docs/${encodeURIComponent(sid)}`);
  app.remember(doc);
  const shell = buildShell(app, "versions");
  const list = h("div", { class: "table-wrap", attrs: { "aria-live": "polite" } });
  let data = await api.get<VersionsData>(`/docs/${encodeURIComponent(sid)}/versions`);
  const readOnly = doc.readOnly || !doc.access.canEdit;

  const reload = async (): Promise<void> => { data = await api.get<VersionsData>(`/docs/${encodeURIComponent(sid)}/versions`); paint(); };

  const paint = (): void => {
    clear(list);
    if (!data.versions.length) { list.appendChild(emptyState("No saved versions yet.", "Versions are made when you create one, before a restore, and when a revision is signed. Your document is not at risk: it is saved as a file as usual.")); return; }
    const body = h("tbody");
    for (const v of data.versions) {
      const open = h("button", { class: "btn small", type: "button", text: "Open (read-only)" });
      open.addEventListener("click", () => { void run(open, async () => { const s = await api.post<DocState>(`/docs/${encodeURIComponent(sid)}/versions/${v.id}/open`, {}); app.remember(s); app.go({ name: "doc", sid: s.sid }); }); });
      const compare = h("button", { class: "btn small", type: "button", text: "Compare with current" });
      compare.addEventListener("click", () => { void run(compare, () => showCompare(sid, v.id)); });
      const restore = h("button", { class: "btn small", type: "button", text: "Restore as new revision", disabled: readOnly });
      restore.addEventListener("click", () => { void run(restore, async () => {
        if (!await confirmDialog({ title: `Restore revision ${v.revision}?`, message: "The restored text becomes a new revision. Nothing is overwritten: the current state is kept in version history first.", confirmLabel: "Restore" })) return;
        await api.post<DocState>(`/docs/${encodeURIComponent(sid)}/versions/${v.id}/restore`, {});
        toast(`Restored as a new revision. The previous state is in version history.`, { kind: "ok" });
        app.go({ name: "doc", sid });
      }); });
      body.appendChild(h("tr", {},
        h("th", { scope: "row", text: v.label || `Revision ${v.revision}` }),
        h("td", { text: `Revision ${v.revision}` }), h("td", { text: when(v.created) }), h("td", { text: KIND[v.kind] ?? v.kind }),
        h("td", { text: `${v.words.toLocaleString()} words · ${formatBytes(v.bytes)}` }),
        h("td", {}, v.signed ? statusBadge("Signed", "ok") : null, v.encrypted ? statusBadge("Protected", "idle") : null),
        h("td", { class: "row-actions" }, open, compare, restore)));
    }
    list.appendChild(h("table", { class: "docs" }, h("thead", {}, h("tr", {}, ["Version", "Revision", "Created", "Kind", "Size", "Flags", "Actions"].map((t) => h("th", { scope: "col", text: t })))), body));
  };

  const create = async (): Promise<void> => {
    const label = await promptDialog({ title: "Create a named version", label: "Name", value: `Version ${data.current.number}`, maxLength: 120, confirmLabel: "Create version" });
    if (label === null) return;
    await api.post(`/docs/${encodeURIComponent(sid)}/versions`, { label });
    toast("Version saved.", { kind: "ok" });
    await reload();
  };

  fill(shell.main,
    h("h2", { class: "page-title", text: "Version history" }),
    h("p", { class: "muted", text: `${doc.title} · current revision ${data.current.number}` }),
    readOnly ? notice(doc.access.readOnlyReason ?? "This document is read-only, so versions cannot be created or restored here.", "info") : null,
    h("div", { class: "actions" },
      button("Create named version", create, "primary", "plus"),
      button("Verify signature", () => { app.go({ name: "verify-signature", sid }); }, "", "shield"),
      button("Back to the document", () => { app.go({ name: "doc", sid }); }, "", "chevron-left")),
    list);
  paint();
  void glyph;
  return { el: shell.el, destroy: shell.dispose };
}
