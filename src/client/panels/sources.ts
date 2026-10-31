/** Sources, citations, footnotes, bibliography, contents and cross-references.
 *
 *  Writer never makes a source up. Every field here was typed by the person, imported, or returned by the DOI registry when they asked;
 *  each source shows who provided it and whether it was checked, and "verified" is only ever shown for a registry match. */
import { announce, clear, confirmDialog, h, labelled, openDialog, toast } from "../kit.js";
import * as A from "../actions.js";
import type { DocCtx, Panel } from "../docctx.js";
import { api, errorText } from "../net.js";
import type { DocState, Patch, SourceRow } from "../types.js";
import { tocCoverAnchor } from "../toc_position.js";
import { button, checkbox, emptyState, notice, selectField, statusBadge, fill } from "../widgets.js";

interface SourcesData { sources: SourceRow[]; statuses: Record<string, string>; unverified: string[] }
type Reply = Patch | { state: DocState } | { version?: number };

const url = (ctx: DocCtx, tail: string): string => `/docs/${encodeURIComponent(ctx.sid)}/${tail}`;

export function badgeClass(status: string): string { return status === "registry" ? "verified" : status === "ai" ? "ai" : "user"; }

async function mutate<T extends Reply>(ctx: DocCtx, work: () => Promise<T>): Promise<T> {
  return ctx.ed.call(work, (r) => ("blocks" in r && "version" in r ? (r as unknown as Patch) : undefined)).then(async (r) => { if ("state" in r && r.state) await ctx.ed.resync(r.state); return r; });
}

export async function loadSources(ctx: DocCtx): Promise<SourcesData> { return api.get<SourcesData>(url(ctx, "sources")); }

/* -------------------------------------------------------------------------------------------------- add / edit */
export async function sourceDialog(ctx: DocCtx, existing?: SourceRow): Promise<string | null> {
  const d = (existing?.data ?? {}) as Record<string, unknown>;
  const text = (key: string, label: string, hint?: string, max = 300): HTMLElement => labelled(label, h("input", { type: "text", name: key, value: String(d[key] ?? ""), maxLength: max, attrs: { autocomplete: "off" } }), hint ? { hint } : {});
  const authors = h("textarea", { rows: 3, name: "authors", maxLength: 2000, value: Array.isArray(d["authors"]) ? (d["authors"] as string[]).join("\n") : "" });
  const status = selectField("Where does this source come from?", [["user", "I am entering it myself"], ["imported", "It came with an imported document"], ["ai", "An AI assistant suggested it (not verified)"]], "user");
  const error = h("p", { class: "form-error", attrs: { role: "alert" }, hidden: true });
  const body = h("form", { class: "stack", attrs: { novalidate: true } },
    notice("Enter only what you can see on the real work. Writer will not fill in or correct missing details: anything left empty stays empty, and shows as “n.d.” or is listed as a problem.", "info"),
    text("title", "Title (required)", undefined, 1000), labelled("Authors (one per line)", authors),
    h("div", { class: "grid-3" }, text("year", "Year", "Four digits", 4), text("volume", "Volume", undefined, 40), text("issue", "Issue", undefined, 40)),
    text("container", "Journal, book or website", undefined, 500), h("div", { class: "grid-2" }, text("publisher", "Publisher", undefined, 300), text("pages", "Pages", "For example 12–34", 40)),
    h("div", { class: "grid-2" }, text("doi", "DOI", "For example 10.1000/xyz123", 200), text("url", "Link", undefined, 2000)),
    h("div", { class: "grid-2" }, text("accessed", "Date accessed", "YYYY-MM-DD", 10), text("note", "Note", undefined, 2000)),
    existing ? null : status.root, error);
  const read = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const el of Array.from(body.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[name], textarea[name]"))) out[el.name] = el.value;
    return out;
  };
  const handle = openDialog<string>({
    title: existing ? "Edit source" : "Add a source", size: "wide", body,
    actions: [{ label: existing ? "Save source" : "Add source", kind: "primary", run: async () => {
      error.hidden = true;
      try {
        const payload: Record<string, unknown> = { data: read(), status: existing ? "user" : status.select.value };
        if (existing) payload["id"] = existing.id;
        const reply = await mutate(ctx, () => api.post<{ id: string; state: DocState }>(url(ctx, "sources"), payload));
        return reply.id;
      } catch (e) { error.textContent = errorText(e); error.hidden = false; return undefined; }
    } }],
  });
  return handle.result;
}

/* ----------------------------------------------------------------------------------------------------- citing */
export async function citeDialog(ctx: DocCtx): Promise<void> {
  const sel = ctx.ed.recallSelection();
  if (!sel || sel.start.field !== "text") { toast("Place the cursor in a paragraph first.", { kind: "info" }); return; }
  let data = await loadSources(ctx);
  let cites = data.sources.filter((s) => s.kind === "citation");
  if (!cites.length) {
    const made = await sourceDialog(ctx);
    if (!made) return;
    data = await loadSources(ctx);
    cites = data.sources.filter((s) => s.kind === "citation");
  }
  const choose = selectField("Source", cites.map((s) => [s.id, `${s.inText} ${String((s.data as { title?: string }).title ?? "")}`.slice(0, 120)] as [string, string]), cites[0]?.id ?? "");
  const detail = h("div", { class: "muted", attrs: { "aria-live": "polite" } });
  const paint = (): void => { const s = cites.find((c) => c.id === choose.select.value); if (s) fill(detail, s.statusLabel + (s.problems.length ? ` · ${s.problems[0]}` : "")); };
  choose.select.addEventListener("change", () => { clear(detail); paint(); });
  paint();
  const handle = openDialog<true>({
    title: "Insert a citation", size: "narrow", body: h("div", { class: "stack" }, choose.root, detail, h("p", { class: "fine", text: "The in-text mark is built only from the source's own fields." })),
    actions: [{ label: "Add a new source…", run: async () => { await sourceDialog(ctx); return null; } },
      { label: "Insert citation", kind: "primary", run: async () => {
        try {
          ctx.ed.refocus(sel);
          await mutate(ctx, () => api.post<Patch>(url(ctx, "cite"), { block: sel.start.block, at: sel.start.offset, source: choose.select.value, base: ctx.ed.model.version }));
          announce("Citation inserted.");
          return true;
        } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; }
      } }],
  });
  await handle.result;
}

export async function footnoteDialog(ctx: DocCtx): Promise<void> {
  const sel = ctx.ed.recallSelection();
  if (!sel || sel.start.field !== "text") { toast("Place the cursor in a paragraph first.", { kind: "info" }); return; }
  const text = h("textarea", { rows: 5, maxLength: 20000 });
  const handle = openDialog<true>({
    title: "Insert a footnote", body: h("div", { class: "stack" }, labelled("Footnote text", text, { hint: "Footnotes are numbered automatically and appear at the bottom of the page." })),
    actions: [{ label: "Insert footnote", kind: "primary", run: async () => {
      if (!text.value.trim()) { toast("Write the footnote first.", { kind: "info" }); return undefined; }
      try {
        ctx.ed.refocus(sel);
        await mutate(ctx, () => api.post<Patch>(url(ctx, "footnote"), { block: sel.start.block, at: sel.start.offset, text: text.value, base: ctx.ed.model.version }));
        announce("Footnote inserted.");
        return true;
      } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; }
    } }],
  });
  await handle.result;
}

/** Turn the selected words into a link to a heading. */
export async function xrefDialog(ctx: DocCtx): Promise<void> {
  const sel = ctx.ed.recallSelection();
  if (!sel || sel.collapsed || sel.start.block !== sel.end.block || sel.start.field !== "text") { toast("Select some words inside one paragraph first; they become the cross-reference.", { kind: "info" }); return; }
  const heads = ctx.ed.model.headings();
  if (!heads.length) { toast("There are no headings to refer to yet.", { kind: "info" }); return; }
  const target = selectField("Refer to", heads.map((x) => [x.id, `${"  ".repeat(Math.max(0, x.level - 1))}${x.text || "(empty heading)"}`] as [string, string]), heads[0]?.id ?? "");
  const handle = openDialog<true>({
    title: "Cross-reference", size: "narrow", body: h("div", { class: "stack" }, h("p", { text: `“${ctx.ed.selectionText(sel).slice(0, 80)}” will link to the heading you choose. Ctrl+click it to jump there.` }), target.root),
    actions: [{ label: "Create cross-reference", kind: "primary", run: async () => {
      try {
        ctx.ed.refocus(sel);
        await mutate(ctx, () => api.post<Patch>(url(ctx, "xref"), { block: sel.start.block, start: sel.start.offset, end: sel.end.offset, target: target.select.value }));
        return true;
      } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; }
    } }],
  });
  await handle.result;
}

/* ------------------------------------------------------------------------------------------------------ panel */
export function createSourcesPanel(ctx: DocCtx): Panel {
  const root = h("div", { class: "stack" });
  const list = h("div", { attrs: { "aria-live": "polite" } });

  const place = (where: string): string | null => {
    const order = ctx.ed.model.order;
    if (where === "cover") return tocCoverAnchor(ctx.ed.model.list(), ctx.ed.model.meta.sections ?? []);
    if (where === "start") return null;
    if (where === "end") return order[order.length - 1] ?? null;
    return A.anchorBlock(ctx.ed);
  };

  const insertDialog = async (kind: "bibliography" | "contents"): Promise<void> => {
    if (kind === "contents" && ctx.ed.model.list().some((block) => (block.extensions?.["slai.sldc.toc"] as { role?: string } | undefined)?.role === "title")) {
      toast("A table of contents already exists. Use Update table of contents to edit it.", { kind: "info" });
      return;
    }
    const hasCover = (ctx.ed.model.meta.sections ?? []).some((s) => s.role === "cover") && tocCoverAnchor(ctx.ed.model.list(), ctx.ed.model.meta.sections ?? []) !== null;
    const where = selectField("Insert it", [...(kind === "contents" && hasCover ? [["cover", "Immediately after cover"] as [string, string]] : []), ["cursor", "After the cursor"], ["end", "At the end of the document"], ["start", "At the start of the document"]], kind === "bibliography" ? "end" : hasCover ? "cover" : "start");
    const only = checkbox("Only sources I have cited", true);
    const depth = selectField("Headings to include", [["1", "Level 1"], ["2", "Levels 1–2"], ["3", "Levels 1–3"], ["4", "Levels 1–4"], ["5", "Levels 1–5"], ["6", "Levels 1–6"]], "3");
    const titleField = h("input", { type: "text", value: "Contents", maxLength: 80, attrs: { "aria-label": "Contents title" } });
    const preset = selectField("Contents appearance", [["standard", "Standard"], ["compact", "Compact"], ["academic", "Academic"]], "standard");
    const pageNumbers = checkbox("Right-aligned printed page references", true);
    const leaderDots = checkbox("Leader dots between entries and page references", true);
    const automatic = checkbox("Automatically refresh when headings change", true);
    const handle = openDialog<true>({
      title: kind === "bibliography" ? "Insert a reference list" : "Insert a table of contents", size: "narrow",
      body: h("div", { class: "stack" }, where.root, kind === "bibliography" ? only.root : h("div", { class: "stack" }, labelled("Title", titleField), depth.root, preset.root, pageNumbers.root, leaderDots.root, automatic.root),
        h("p", { class: "fine", text: kind === "bibliography" ? "The list is built from each source's own fields. Check it against the real works before you publish." : "Contents entries use stable heading references. Printed page numbers are measured by the PDF layout engine; custom entry labels and formatting survive refresh." })),
      actions: [{ label: "Insert", kind: "primary", run: async () => {
        try {
          const after = place(where.select.value);
          const reply = await mutate(ctx, () => kind === "bibliography"
            ? api.post<{ state: DocState; warnings?: string[]; note?: string }>(url(ctx, "bibliography"), { onlyCited: only.input.checked, after, heading: "References" })
            : api.post<{ state: DocState; warnings?: string[]; note?: string }>(url(ctx, "contents"), { after, title: titleField.value, depth: Number(depth.select.value), preset: preset.select.value,
              showPageNumbers: pageNumbers.input.checked, leaderDots: leaderDots.input.checked, refreshMode: automatic.input.checked ? "automatic" : "manual" }));
          const warnings = (reply as { warnings?: string[] }).warnings ?? [];
          if (warnings.length) toast(warnings.slice(0, 3).join(" "), { kind: "info", timeoutMs: 9000 });
          else toast(kind === "bibliography" ? "Reference list inserted." : "Table of contents inserted.", { kind: "ok" });
          return true;
        } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; }
      } }],
    });
    await handle.result;
    await paint();
  };

  const updateContentsDialog = async (): Promise<void> => {
    const entries = ctx.ed.model.list().filter((b) => {
      const meta = (b.extensions?.["slai.sldc.toc"] ?? {}) as { role?: string };
      return meta.role === "title";
    });
    if (!entries.length) { toast("Insert a table of contents first.", { kind: "info" }); return; }
    const choice = selectField("Table of contents", entries.map((b) => {
      const meta = b.extensions?.["slai.sldc.toc"] as { id: string };
      return [meta.id, b.text] as [string, string];
    }), (entries[0]?.extensions?.["slai.sldc.toc"] as { id: string }).id);
    const titleField = h("input", { type: "text", maxLength: 80, attrs: { "aria-label": "Contents title" } });
    const depth = selectField("Heading depth", [["1", "Level 1"], ["2", "Levels 1–2"], ["3", "Levels 1–3"], ["4", "Levels 1–4"], ["5", "Levels 1–5"], ["6", "Levels 1–6"]], "3");
    const preset = selectField("Appearance", [["standard", "Standard"], ["compact", "Compact"], ["academic", "Academic"]], "standard");
    const pageNumbers = checkbox("Right-aligned printed page references", true);
    const leaderDots = checkbox("Leader dots between entries and page references", true);
    const automatic = checkbox("Automatically refresh when headings change", true);
    const headings = ctx.ed.model.list().filter((b) => b.type === "heading" && !b.extensions?.["slai.sldc.toc"]);
    const individual = selectField("Individual entry", [["", "No individual change"], ...headings.map((b) => [b.id, b.text || "(Untitled heading)"] as [string, string])], "");
    const custom = checkbox("Use a custom entry label (leave the heading unchanged)", false);
    const label = h("input", { type: "text", maxLength: 500, attrs: { "aria-label": "Custom TOC entry label" } });
    const hidden = checkbox("Hide this heading in this TOC", false);
    const entryControls = h("div", { class: "stack" }, individual.root, custom.root, labelled("Entry label", label), hidden.root);
    const updateEntryState = (): void => {
      const enabled = !!individual.select.value;
      custom.input.disabled = !enabled;
      hidden.input.disabled = !enabled;
      label.disabled = !enabled || !custom.input.checked;
    };
    const fillEntry = (): void => {
      const title = entries.find((b) => (b.extensions?.["slai.sldc.toc"] as { id: string }).id === choice.select.value);
      const heading = individual.select.value;
      const meta = title?.extensions?.["slai.sldc.toc"] as { overrides?: Record<string, { label?: string; hidden?: boolean }> } | undefined;
      const override = meta?.overrides?.[heading];
      const actual = ctx.ed.model.list().find((b) => {
        const m = b.extensions?.["slai.sldc.toc"] as { role?: string; id?: string; heading?: string; source_text?: string } | undefined;
        return m?.role === "entry" && m.id === choice.select.value && m.heading === heading;
      });
      const m = actual?.extensions?.["slai.sldc.toc"] as { source_text?: string } | undefined;
      const manuallyEdited = !!actual && m?.source_text !== undefined && actual.text !== m.source_text;
      custom.input.checked = !!override?.label || manuallyEdited;
      label.value = override?.label ?? (manuallyEdited ? actual?.text ?? "" : "");
      hidden.input.checked = override?.hidden === true;
      updateEntryState();
    };
    const fillSettings = (): void => {
      const current = entries.find((b) => (b.extensions?.["slai.sldc.toc"] as { id: string }).id === choice.select.value);
      if (!current) return;
      const meta = current.extensions?.["slai.sldc.toc"] as { depth: number; preset?: string; show_page_numbers?: boolean; leader_dots?: boolean; refresh_mode?: string };
      titleField.value = current.text;
      depth.select.value = String(meta.depth);
      preset.select.value = meta.preset ?? "standard";
      pageNumbers.input.checked = meta.show_page_numbers !== false;
      leaderDots.input.checked = meta.leader_dots !== false;
      automatic.input.checked = meta.refresh_mode !== "manual";
      fillEntry();
    };
    choice.select.addEventListener("change", fillSettings);
    individual.select.addEventListener("change", fillEntry);
    custom.input.addEventListener("change", updateEntryState);
    fillSettings();
    const handle = openDialog<true>({ title: "Update table of contents", size: "narrow",
      body: h("div", { class: "stack" }, choice.root, labelled("Title", titleField), depth.root, preset.root,
        pageNumbers.root, leaderDots.root, automatic.root, entryControls,
        notice("Refresh follows heading IDs, not heading text. Custom labels and level-specific paragraph typography survive refresh. Printed page references come from the PDF layout engine.", "info")),
      actions: [{ label: "Remove TOC", run: async () => {
        const confirmed = await confirmDialog({ title: "Remove this table of contents?", message: "All generated TOC entries will be removed. Original headings and other document content will remain.", confirmLabel: "Remove TOC", danger: true });
        if (!confirmed) return undefined;
        try {
          await mutate(ctx, () => api.post<{ state: DocState }>(url(ctx, `contents/${encodeURIComponent(choice.select.value)}/remove`), {}));
          toast("Table of contents removed.", { kind: "ok" });
          return true;
        } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; }
      } }, { label: "Update", kind: "primary", run: async () => {
        try {
          const entry = individual.select.value ? { heading: individual.select.value,
            label: custom.input.checked ? label.value : null, hidden: hidden.input.checked } : undefined;
          await mutate(ctx, () => api.post<{ state: DocState }>(url(ctx, `contents/${encodeURIComponent(choice.select.value)}/refresh`),
            { title: titleField.value, depth: Number(depth.select.value), preset: preset.select.value, entry,
              showPageNumbers: pageNumbers.input.checked, leaderDots: leaderDots.input.checked,
              refreshMode: automatic.input.checked ? "automatic" : "manual" }));
          toast("Table of contents updated.", { kind: "ok" });
          return true;
        } catch (e) { toast(errorText(e), { kind: "error" }); return undefined; }
      } }],
    });
    await handle.result;
    await paint();
  };

  const paint = async (): Promise<void> => {
    let data: SourcesData;
    try { data = await loadSources(ctx); } catch (e) { clear(list); fill(list, notice(errorText(e), "danger")); return; }
    clear(list);
    const cites = data.sources.filter((s) => s.kind === "citation");
    const notes = data.sources.filter((s) => s.kind === "footnote");
    if (data.unverified.length) list.appendChild(notice(`${data.unverified.length} AI-suggested source(s) have not been verified. They block export until you verify or remove them.`, "warn"));
    if (!cites.length) list.appendChild(emptyState("No sources yet.", "Add a source you have read, then cite it. Writer never invents authors, dates, DOIs, page numbers or quotations."));
    const ul = h("ul", { class: "panel-list" });
    for (const s of cites) {
      const data2 = s.data as { title?: string; doi?: string };
      const edit = h("button", { class: "btn small", type: "button", text: "Edit" });
      edit.addEventListener("click", () => { void sourceDialog(ctx, s).then(() => paint()); });
      const cite = h("button", { class: "btn small", type: "button", text: "Cite at cursor", disabled: ctx.ed.readOnly });
      cite.addEventListener("click", () => { void citeOne(s); });
      const checked = h("button", { class: "btn small", type: "button", text: "I checked it", disabled: ctx.ed.readOnly, title: "Record that you compared this entry with the real work. Writer cannot check that for you." });
      checked.addEventListener("click", () => { void markChecked(s); });
      const doi = data2.doi ? h("button", { class: "btn small", type: "button", text: "Verify DOI online", title: "Sends only the DOI to the Crossref registry, when you allow online lookups in Settings." }) : null;
      doi?.addEventListener("click", () => { void verifyDoi(s, doi); });
      const del = h("button", { class: "btn small danger", type: "button", text: "Delete", disabled: ctx.ed.readOnly });
      del.addEventListener("click", () => { void remove(s); });
      ul.appendChild(h("li", {}, h("strong", { text: data2.title ?? "(untitled)" }), h("div", { class: "muted", text: s.line }),
        h("div", {}, h("span", { class: `badge ${badgeClass(s.status)}`, text: s.statusLabel }), ` · cited ${s.uses} time${s.uses === 1 ? "" : "s"} · in text: ${s.inText}`),
        s.problems.length ? h("ul", { class: "fine" }, s.problems.map((p) => h("li", { text: p }))) : null,
        h("div", { class: "actions" }, cite, edit, checked, doi, del)));
    }
    list.appendChild(ul);
    if (notes.length) {
      list.appendChild(h("h3", { text: "Footnotes" }));
      list.appendChild(h("ul", { class: "panel-list" }, notes.map((n) => h("li", {}, h("span", { text: String((n as { text?: string }).text ?? "") }), h("div", { class: "fine", text: `used ${n.uses} time${n.uses === 1 ? "" : "s"}` })))));
    }
  };

  const citeOne = async (s: SourceRow): Promise<void> => {
    const sel = ctx.ed.recallSelection();
    if (!sel || sel.start.field !== "text") { toast("Click in the text where the citation should go, then press Cite at cursor.", { kind: "info" }); return; }
    try { await mutate(ctx, () => api.post<Patch>(url(ctx, "cite"), { block: sel.start.block, at: sel.start.offset, source: s.id, base: ctx.ed.model.version })); await paint(); } catch (e) { toast(errorText(e), { kind: "error" }); }
  };
  const markChecked = async (s: SourceRow): Promise<void> => {
    const ok = await confirmDialog({ title: "Mark this source as checked by you?", message: "This records that you compared the entry with the real work, with today's date. Writer cannot check it for you, so it is shown as “Checked by you”, not “Verified”.", confirmLabel: "I checked it" });
    if (!ok) return;
    try { await mutate(ctx, () => api.post<Patch>(url(ctx, `sources/${encodeURIComponent(s.id)}/checked`), { note: "" })); await paint(); } catch (e) { toast(errorText(e), { kind: "error" }); }
  };
  const verifyDoi = async (s: SourceRow, btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    try {
      const out = await ctx.ed.call(() => api.post<{ match: boolean; found: boolean; message: string; registryTitle?: string; registryYear?: number }>(url(ctx, `sources/${encodeURIComponent(s.id)}/verify-doi`), {}));
      if (out.match) await ctx.ed.resync();
      toast(`${out.message}${!out.match && out.registryTitle ? ` Registry title: “${out.registryTitle}”${out.registryYear ? ` (${out.registryYear})` : ""}.` : ""}`, { kind: out.match ? "ok" : "info", timeoutMs: 10000 });
      await paint();
    } catch (e) { toast(errorText(e), { kind: "error", timeoutMs: 9000 }); } finally { btn.disabled = false; }
  };
  const remove = async (s: SourceRow): Promise<void> => {
    const ok = await confirmDialog({ title: "Delete this source?", message: s.uses ? `It is cited ${s.uses} time(s). The citation text stays in the document, but it will no longer link to a source.` : "It is not cited anywhere.", confirmLabel: "Delete source", danger: true });
    if (!ok) return;
    try { await ctx.ed.call(() => api.del<Patch>(url(ctx, `sources/${encodeURIComponent(s.id)}`)), (p) => p); await paint(); } catch (e) { toast(errorText(e), { kind: "error" }); }
  };

  fill(root,
    h("h2", { text: "Sources" }),
    h("p", { class: "fine", text: "Writer never invents a source. Each one shows who provided it and whether it was checked; only a DOI-registry match is shown as verified." }),
    h("div", { class: "actions" }, button("Add a source…", async () => { const id = await sourceDialog(ctx); if (id) await paint(); }, "primary", "plus"), button("Cross-reference…", () => xrefDialog(ctx), "", "link")),
    h("div", { class: "actions" }, button("Insert reference list…", () => insertDialog("bibliography"), "", "book"), button("Insert contents…", () => insertDialog("contents"), "", "list"), button("Update contents…", () => updateContentsDialog(), "", "list")),
    list);
  void statusBadge;
  return { el: root, refresh: paint };
}
