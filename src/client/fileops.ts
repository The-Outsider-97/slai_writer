/** Everything about getting documents in and out: Open, Upload, Import, Export, Print, Favorite, Close. Used by the sidebar, Home and the editor. */
import type { App } from "./app.js";
import { api, errorText, postDownload, rawPost } from "./net.js";
import { ApiError, clear, confirmDialog, formatBytes, glyph, h, labelled, openDialog, plural, promptDialog, saveBlob, toast } from "./kit.js";
import type { DocState, ExportFormat, ImportFormat, Problem } from "./types.js";
import { checkbox, notice, pickFile, selectField, textField } from "./widgets.js";

export function needsPassword(error: unknown): boolean {
  const d = error instanceof ApiError ? (error.details as { needsPassword?: boolean; passwordRequired?: boolean } | undefined) : undefined;
  return Boolean(d?.needsPassword || d?.passwordRequired);
}
export function wrongPassword(error: unknown): boolean {
  const d = error instanceof ApiError ? (error.details as { wrongPassword?: boolean } | undefined) : undefined;
  return Boolean(d?.wrongPassword);
}

export async function askPassword(title: string, message: string): Promise<string | null> {
  const input = h("input", { type: "password", attrs: { autocomplete: "off", spellcheck: "false" }, maxLength: 500 });
  const handle = openDialog<string>({
    title, size: "narrow", body: h("div", {}, h("p", { text: message }), labelled("Password", input)), focus: () => input,
    actions: [{ label: "Continue", kind: "primary", run: () => (input.value ? input.value : undefined) }],
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.value) handle.close(input.value); });
  return handle.result;
}

/** Run `work`; if the file needs a password, ask for it and run it again (as often as the person keeps trying). */
export async function withPassword<T>(title: string, work: (password?: string) => Promise<T>): Promise<T | null> {
  let password: string | undefined;
  for (;;) {
    try { return await work(password); }
    catch (error) {
      if (!needsPassword(error)) throw error;
      const message = password ? (error instanceof ApiError ? error.friendly : "That password did not work.") : "This file is protected. Enter its password.";
      const next = await askPassword(title, message);
      if (next === null) return null;
      password = next;
    }
  }
}

/* ------------------------------------------------------------------------------------------------ file chooser */
interface Listing { path: string; parent: string | null; entries: Array<{ name: string; dir: boolean; size: number | null; path: string }>; roots: Array<{ name: string; path: string }> }

export interface ChooseOptions { kind: "open" | "folder" | "save"; types?: Array<[string, string]>; name?: string; start?: string; extensions?: string[]; title?: string }

/** The operating system's own file dialog when the server can show one; otherwise a chooser inside the page. */
export async function chooseFile(app: App, options: ChooseOptions): Promise<string | null> {
  if (app.boot.capabilities.nativePicker) {
    try {
      const { path } = await api.post<{ path: string | null }>("/fs/pick", { kind: options.kind, types: options.types ?? [], name: options.name ?? "", start: options.start ?? "" });
      return path;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "dependency_missing") throw error;
    }
  }
  return browseDialog(options);
}

export function browseDialog(options: ChooseOptions): Promise<string | null> {
  const list = h("ul", { class: "browse-list", attrs: { role: "listbox", "aria-label": "Files and folders" } });
  const where = h("code", { class: "browse-path" });
  const roots = h("div", { class: "chips" });
  const name = options.kind === "save" ? h("input", { type: "text", value: options.name ?? "", maxLength: 200 }) : null;
  let current = "";
  let picked: string | null = null;
  const exts = (options.extensions ?? []).map((e) => e.toLowerCase());
  const accept = (file: string): boolean => exts.length === 0 || exts.some((e) => file.toLowerCase().endsWith(e));
  const error = h("p", { class: "form-error", attrs: { role: "alert" }, hidden: true });
  const handle = openDialog<string>({
    title: options.title ?? (options.kind === "folder" ? "Choose a folder" : options.kind === "save" ? "Choose where to save" : "Open a file"), size: "wide",
    body: h("div", { class: "browse" }, roots, h("div", { class: "browse-bar" }, where), list, name ? labelled("File name", name) : null, error),
    actions: [{
      label: options.kind === "folder" ? "Use this folder" : options.kind === "save" ? "Save here" : "Open",
      kind: "primary",
      run: () => {
        if (options.kind === "folder") return current;
        if (options.kind === "save") { const n = name?.value.trim(); if (!n) { error.hidden = false; error.textContent = "Enter a file name."; return undefined; } return `${current.replace(/[\\/]$/, "")}${current.includes("\\") ? "\\" : "/"}${n}`; }
        if (!picked) { error.hidden = false; error.textContent = "Choose a file first."; return undefined; }
        return picked;
      },
    }],
  });
  const load = async (path?: string): Promise<void> => {
    error.hidden = true;
    try {
      const data = await api.get<Listing>("/fs/browse", { path: path ?? "", files: options.kind === "folder" ? 0 : 1 });
      current = data.path; picked = null; where.textContent = data.path;
      clear(roots);
      for (const r of data.roots) roots.appendChild(h("button", { class: "chip", type: "button", text: r.name, on: { click: () => { void load(r.path); } } }));
      clear(list);
      if (data.parent) list.appendChild(h("li", {}, h("button", { class: "browse-item", type: "button", on: { click: () => { void load(data.parent ?? undefined); } } }, glyph("chevron-up"), "Up one level")));
      for (const e of data.entries) {
        if (!e.dir && !accept(e.name)) continue;
        const item = h("button", { class: "browse-item", type: "button", attrs: { role: "option", "aria-selected": "false" } }, glyph(e.dir ? "folder" : "page"), h("span", { class: "grow", text: e.name }), e.size !== null ? h("span", { class: "muted", text: formatBytes(e.size) }) : null);
        item.addEventListener("click", () => {
          if (e.dir) { void load(e.path); return; }
          picked = e.path;
          for (const other of list.querySelectorAll("[aria-selected=true]")) other.setAttribute("aria-selected", "false");
          item.setAttribute("aria-selected", "true");
          if (name) name.value = e.name;
        });
        item.addEventListener("dblclick", () => { if (!e.dir && options.kind === "open") handle.close(e.path); });
        list.appendChild(h("li", {}, item));
      }
    } catch (failure) { error.hidden = false; error.textContent = errorText(failure); }
  };
  void load(options.start || undefined);
  return handle.result;
}

/* ------------------------------------------------------------------------------------------------ open and import */
const OPEN_TYPES: Array<[string, string]> = [["SLAI Writer documents", "*.sldc"], ["Older SLDC file names", "*.sdoc"]];

export async function openPath(app: App, path: string): Promise<DocState | null> {
  const state = await withPassword("Open protected document", (password) => api.post<DocState>("/docs/open", { path, password: password ?? "" }));
  if (!state) return null;
  app.remember(state);
  if (state.alreadyOpen) toast(`${state.title} is already open.`);
  app.go({ name: "doc", sid: state.sid });
  return state;
}

export async function openFile(app: App): Promise<void> {
  const path = await chooseFile(app, { kind: "open", types: OPEN_TYPES, extensions: [".sldc", ".sdoc"], start: app.prefs.last_folder || app.boot.storage.library, title: "Open a document" });
  if (path) await openPath(app, path);
}

export async function openFolder(app: App): Promise<boolean> {
  const path = await chooseFile(app, { kind: "folder", start: app.prefs.last_folder || app.boot.storage.library, title: "Add a folder to Home" });
  if (!path) return false;
  await api.post("/library/folders", { path });
  toast("Folder added to Home.", { kind: "ok" });
  return true;
}

async function openImported(app: App, state: DocState): Promise<void> {
  app.remember(state);
  const origin = state.import as { kind?: string; lost?: string[]; warnings?: string[] } | undefined;
  app.go({ name: "doc", sid: state.sid });
  const lost = [...(origin?.lost ?? []), ...(origin?.warnings ?? [])];
  if (lost.length) {
    openDialog({
      title: "Imported with some loss", size: "normal", noCancel: true,
      body: h("div", {}, h("p", { text: "This is a Writer copy of the file you chose. It was not saved yet. What did not carry over:" }), h("ul", {}, lost.map((l) => h("li", { text: l })))),
      actions: [{ label: "Understood", kind: "primary", run: () => true }],
    });
  }
}

/** Upload: pick a file in the browser and open it as a new document (SLDC opens as itself; other formats are imported as a copy). */
export async function uploadFile(app: App): Promise<void> {
  const files = await pickFile(".sldc,.sdoc,.docx,.doc,.odt,.rtf,.html,.htm,.md,.txt,.xml,.csv,.pdf");
  const file = files[0];
  if (!file) return;
  const state = await withPassword("Open protected file", (password) =>
    rawPost<DocState>("/import", file, "application/octet-stream", { name: file.name, password: password ?? "" }));
  if (state) await openImported(app, state);
}

export async function importFlow(app: App): Promise<void> {
  const formats = app.boot.capabilities.exportFormats.import;
  const note = h("div", { class: "import-note" });
  const ocr = checkbox("Run OCR on scanned PDF pages (slower; may misread)", false);
  const asText = checkbox("Treat as plain text (ignore the file's structure)", false);
  const list = h("ul", { class: "formats" }, formats.map((f: ImportFormat) => h("li", {}, h("strong", { text: f.label }), " ", f.available ? h("span", { class: "muted", text: f.note || "Reads natively." }) : h("span", { class: "muted", text: `Unavailable: ${f.reason ?? "dependency missing"}` }))));
  note.appendChild(notice("Importing creates a new Writer copy and leaves the original file untouched. Layout, fonts and anything Writer cannot model may not carry over; what was lost is shown after the import.", "info"));
  const handle = openDialog<boolean>({
    title: "Import a file", size: "wide",
    body: h("div", {}, note, h("h3", { text: "Supported formats" }), list, ocr.root, asText.root),
    actions: [
      { label: "Choose a file on this computer…", kind: "primary", run: async () => {
        const path = await chooseFile(app, { kind: "open", start: app.prefs.last_folder || app.boot.storage.library, title: "Import a file" });
        if (!path) return undefined;
        const state = await withPassword("Open protected file", (password) => api.post<DocState>("/import/path", { path, password: password ?? "", ocr: ocr.input.checked, asText: asText.input.checked }));
        if (state) { await openImported(app, state); return true; }
        return undefined;
      } },
      { label: "Upload from the browser…", run: async () => {
        const files = await pickFile(".docx,.doc,.odt,.rtf,.html,.htm,.md,.txt,.xml,.csv,.pdf,.sldc");
        const file = files[0];
        if (!file) return undefined;
        const state = await withPassword("Open protected file", (password) => rawPost<DocState>("/import", file, "application/octet-stream", { name: file.name, password: password ?? "", ocr: ocr.input.checked ? 1 : 0, asText: asText.input.checked ? 1 : 0 }));
        if (state) { await openImported(app, state); return true; }
        return undefined;
      } },
    ],
  });
  await handle.result;
}

/* ----------------------------------------------------------------------------------------------------- picking */
/** The sidebar's document actions need a document; when none is open the person chooses one. */
export async function needDoc(app: App, what: string): Promise<string | null> {
  if (app.activeSid) return app.activeSid;
  const docs = await app.openDocs();
  const first = docs[0];
  if (!first) { toast(`Open or create a document first, then use ${what}.`); return null; }
  if (docs.length === 1) return first.sid;
  const choice = selectField("Document", docs.map((d) => [d.sid, d.title]), first.sid);
  const sid = await new Promise<string | null>((resolve) => {
    const handle = openDialog<string>({ title: what, size: "narrow", body: choice.root, actions: [{ label: "Continue", kind: "primary", run: () => choice.select.value }] });
    void handle.result.then(resolve);
  });
  return sid;
}

/* ---------------------------------------------------------------------------------------------------- export */
interface Preflight { issues: Problem[]; counts: Record<string, number>; target: string | null; lossy: string[] }
interface ExportReport { format: string; bytes: number; path: string; pages?: number; lost?: string[]; warnings?: string[]; sha256?: string }

export function problemList(issues: Problem[]): HTMLElement {
  if (!issues.length) return notice("No problems found.", "ok");
  return h("ul", { class: "problems" }, issues.map((i) => h("li", { class: i.severity }, h("strong", { text: i.severity === "error" ? "Error: " : i.severity === "warn" ? "Check: " : "Note: " }), i.message)));
}

export async function exportFlow(app: App, sid: string): Promise<void> {
  const formats = app.boot.capabilities.exportFormats.export;
  const pre = new Map<string, Preflight>();
  const info = h("div", { class: "export-info", attrs: { "aria-live": "polite" } });
  const format = selectField("Format", formats.map((f: ExportFormat) => [f.id, f.available ? f.label : `${f.label} (unavailable)`]), "pdf");
  const name = textField("File name (without extension)", { value: (app.docs.get(sid)?.title ?? "Document").replace(/[\\/:*?"<>|]+/g, " ").trim(), maxLength: 120 });
  const password = textField("Password to protect the SLDC copy (optional)", { type: "password", hint: "Leave empty for an unprotected copy. Writer cannot recover a forgotten password.", autocomplete: "new-password", maxLength: 500 });
  const where = selectField("Deliver", [["download", "Download in this browser"], ["folder", "Save in a folder on this computer"]], "download");
  const result = h("div", { class: "export-result", attrs: { "aria-live": "polite" } });
  const refresh = async (): Promise<void> => {
    clear(info);
    const f = formats.find((x) => x.id === format.select.value);
    password.root.hidden = format.select.value !== "sldc";
    if (!f) return;
    if (!f.available) { info.appendChild(notice(f.reason ?? "This format needs a component that is not available here.", "warn", "Unavailable.")); return; }
    let p = pre.get(f.id);
    if (!p) { try { p = await api.get<Preflight>(`/docs/${encodeURIComponent(sid)}/preflight`, { target: f.id }); pre.set(f.id, p); } catch (e) { info.appendChild(notice(errorText(e), "danger")); return; } }
    if (f.lossy.length) info.appendChild(notice(h("ul", {}, f.lossy.map((l) => h("li", { text: l }))), "warn", "What this format cannot keep:"));
    info.appendChild(h("h3", { text: "Preflight" }));
    info.appendChild(problemList(p.issues));
  };
  format.select.addEventListener("change", () => { void refresh(); });
  const finish = (r: ExportReport): void => {
    clear(result);
    const extra = [...(r.lost ?? []), ...(r.warnings ?? [])];
    result.appendChild(notice(h("span", {}, `${r.format.toUpperCase()} · ${formatBytes(r.bytes)}${r.pages ? ` · ${plural(r.pages, "page")}` : ""}`, extra.length ? h("ul", {}, extra.map((l) => h("li", { text: l }))) : null), "ok", "Exported."));
  };
  const handle = openDialog<boolean>({
    title: "Export", size: "wide",
    body: h("div", {}, format.root, name.root, password.root, where.root, info, result),
    actions: [{
      label: "Export", kind: "primary",
      run: async () => {
        const f = formats.find((x) => x.id === format.select.value);
        if (!f?.available) return undefined;
        const body = { format: f.id, name: name.input.value.trim(), password: password.input.value };
        if (where.select.value === "download") {
          const file = await postDownload(`/docs/${encodeURIComponent(sid)}/download`, body);
          saveBlob(file.blob, file.filename);
          finish({ format: f.id, bytes: file.blob.size, path: file.filename, ...(file.report ?? {}) } as ExportReport);
        } else {
          const doc = await api.get<DocState>(`/docs/${encodeURIComponent(sid)}`);
          const dir = await chooseFile(app, { kind: "folder", start: doc.path ? doc.path.replace(/[\\/][^\\/]*$/, "") : app.prefs.last_folder, title: "Choose a folder for the copy" });
          if (!dir) return undefined;
          finish(await api.post<ExportReport>(`/docs/${encodeURIComponent(sid)}/export`, { ...body, directory: dir }));
        }
        return undefined;
      },
    }],
    cancelLabel: "Close",
  });
  void refresh();
  await handle.result;
}

/* ----------------------------------------------------------------------------------------------------- print */
interface PreviewData { total: number; pages: Array<{ page: number; widthPt: number; heightPt: number; image: string }>; facts: Record<string, unknown>; note: string }

export async function printFlow(app: App, sid: string): Promise<void> {
  const grid = h("div", { class: "print-preview", attrs: { "aria-label": "Page previews" } });
  const note = h("div", {});
  const status = h("p", { class: "muted", attrs: { role: "status" }, text: "Preparing the preview…" });
  let preview: PreviewData | null = null;
  const pdf = app.boot.capabilities.exportFormats.export.find((f) => f.id === "pdf");
  const handle = openDialog<boolean>({
    title: "Print", size: "wide",
    body: h("div", {}, notice("Printing uses a picture of each page rendered on the server, the same layout as the PDF. The page count you see in the editor is an estimate; the count here comes from that rendering.", "info"), status, note, grid),
    actions: [
      { label: "Download PDF", run: async () => {
        const file = await postDownload(`/docs/${encodeURIComponent(sid)}/download`, { format: "pdf" });
        saveBlob(file.blob, file.filename);
        return undefined;
      } },
      { label: "Print…", kind: "primary", run: () => {
        if (!preview) return undefined;
        const root = h("div", { id: "print-root", attrs: { "aria-hidden": "true" } }, preview.pages.map((p) => {
          const img = h("img", { attrs: { alt: "", src: p.image } });
          img.style.setProperty("width", `${p.widthPt}pt`);
          img.style.setProperty("height", `${p.heightPt}pt`);
          return h("div", { class: "print-page" }, img);
        }));
        document.body.appendChild(root);
        document.body.classList.add("printing");
        const done = (): void => { root.remove(); document.body.classList.remove("printing"); window.removeEventListener("afterprint", done); };
        window.addEventListener("afterprint", done);
        window.setTimeout(() => { window.print(); }, 50);
        return undefined;
      } },
    ],
    cancelLabel: "Close",
  });
  if (pdf && !pdf.available) {
    status.textContent = "";
    note.appendChild(notice(pdf.reason ?? "Page rendering needs Documaster, which is not available.", "warn", "Printing is unavailable here."));
    await handle.result;
    return;
  }
  try {
    const first = await api.post<PreviewData>(`/docs/${encodeURIComponent(sid)}/preview`, { pages: [1], width: 720 });
    const pages = [...first.pages];
    for (let from = 2; from <= Math.min(first.total, 60); from += 12) {
      const more = await api.post<PreviewData>(`/docs/${encodeURIComponent(sid)}/preview`, { pages: Array.from({ length: Math.min(12, first.total - from + 1) }, (_, i) => from + i), width: 720 });
      pages.push(...more.pages);
    }
    preview = { ...first, pages };
    status.textContent = `${plural(first.total, "page")}${first.total > 60 ? " (the first 60 are shown and printed; export a PDF to print the rest)" : ""}.`;
    if (first.note) note.appendChild(notice(first.note, "info"));
    for (const p of pages) {
      const img = h("img", { attrs: { alt: `Page ${p.page} of ${first.total}`, src: p.image } });
      grid.appendChild(h("figure", {}, img, h("figcaption", { text: `Page ${p.page}` })));
    }
  } catch (error) { status.textContent = ""; note.appendChild(notice(errorText(error), "danger", "Could not prepare the preview.")); }
  await handle.result;
}

/* ------------------------------------------------------------------------------------------- favorite, close */
export async function toggleFavorite(app: App, sid: string): Promise<void> {
  const doc = await api.get<DocState>(`/docs/${encodeURIComponent(sid)}`);
  if (!doc.path) { toast("Save the document first; favourites are saved files.", {}); return; }
  const home = await api.get<{ documents: Array<{ path: string; favorite: boolean }> }>("/home");
  const current = home.documents.find((d) => d.path === doc.path)?.favorite ?? false;
  await api.post("/library/favorite", { path: doc.path, value: !current });
  toast(current ? `${doc.title} removed from favourites.` : `${doc.title} added to favourites.`, { kind: "ok" });
}

/** Close an open document, offering to save or discard unsaved changes. Returns true when it was closed. */
export async function closeDocument(app: App, sid: string): Promise<boolean> {
  const summary = app.docs.get(sid);
  try { await api.post(`/docs/${encodeURIComponent(sid)}/close`, {}); }
  catch (error) {
    const d = error instanceof ApiError ? (error.details as { kind?: string } | undefined) : undefined;
    if (d?.kind !== "unsaved") throw error;
    const save = await confirmDialog({ title: `Save changes to ${summary?.title ?? "this document"}?`, message: "It has changes that are not saved. Closing without saving discards them.", confirmLabel: "Save and close", detail: "Choose Cancel to keep working." });
    if (save) {
      try { await api.post(`/docs/${encodeURIComponent(sid)}/save`, {}); }
      catch (e) { if (!(e instanceof ApiError) || e.code !== "conflict") throw e; return false; }
      await api.post(`/docs/${encodeURIComponent(sid)}/close`, {});
    } else {
      const discard = await confirmDialog({ title: "Discard the changes?", message: "The unsaved changes will be lost. A recovery copy is kept until you discard it here.", confirmLabel: "Discard changes", danger: true });
      if (!discard) return false;
      await api.post(`/docs/${encodeURIComponent(sid)}/close`, { discard: true });
    }
  }
  app.docs.delete(sid);
  if (app.lastDoc === sid) app.lastDoc = null;
  await app.openDocs();
  return true;
}

export async function renameDialog(current: string): Promise<string | null> {
  return promptDialog({ title: "Rename document", label: "Document name", value: current, maxLength: 120, confirmLabel: "Rename" });
}
