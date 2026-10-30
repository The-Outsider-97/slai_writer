/** The EMBED panel: the dark panel that hangs below a page (design pages 13 and 14) for approved, declarative components.
 *
 *  A component is a small JSON declaration of one of the kinds Writer knows how to run (count words, quote an excerpt, total a table
 *  column). Nothing here is code, and nothing can reach the network or the person's files. Applying is bound to the document version and
 *  to the content of every input that was previewed, and lands as one undoable edit. An AI request is never authorization to change one. */
import { announce, clear, h, labelled, openDialog, promptDialog, toast } from "../kit.js";
import * as A from "../actions.js";
import type { DocCtx, Panel } from "../docctx.js";
import { api, errorText } from "../net.js";
import type { Patch } from "../types.js";
import { button, fill, notice } from "../widgets.js";

interface Catalogue { level: string; kinds: Array<{ kind: string; label: string; describes: string; inputs: number[]; params: Record<string, { type: string; required?: boolean; enum?: string[]; min?: number; max?: number }>; version: number }>; guarantees: Record<string, string>; note: string }
interface View {
  id: string; kind: string; version: number; locked: boolean; role: string; access: "granted" | "denied"; guarantees: Record<string, string>; known: boolean; block: string | null; output: string;
  lock?: { label: string; requires: string; summary: string }; params?: Record<string, unknown>; inputs?: Array<{ ref: string; sha256?: string }>; message?: string;
}
interface Check { valid: boolean; errors: Array<{ path: string; message: string }>; output: string | null; inputs?: Array<{ ref: string; sha256: string }>; lastValidOutput?: string | null; preview?: string | null }

/** Where the panel is shown: the page's attachments (attach.ts) open and close it; the panel only fills it. */
export interface EmbedHost { show(): void; hide(): void; isOpen(): boolean }

export interface EmbedDrawer extends Panel { open(target: string): Promise<void>; /** The panel was opened from its tab: show the component at the cursor, or an explanation when there is none. */ openFromTab(): Promise<void>; close(): void; readonly isOpen: boolean }

export function createEmbedDrawer(ctx: DocCtx, host: EmbedHost): EmbedDrawer {
  const { ed, app } = ctx;
  const root = h("section", { class: "embed-drawer", attrs: { "aria-label": "EMBED component" } });
  const body = h("div", { class: "embed-panel" });
  root.append(body);

  let catalogue: Catalogue | null = null;
  const loadCatalogue = async (): Promise<Catalogue> => (catalogue ??= await api.get<Catalogue>("/embeds/catalogue"));
  const base = `/docs/${encodeURIComponent(ctx.sid)}`;

  const show = (on: boolean): void => { if (on) host.show(); else host.hide(); };

  /* ---------------------------------------------------------------------------------------------- locked view */
  const locked = (view: View): void => {
    clear(body);
    const deny = h("p", { class: "embed-denied", attrs: { role: "alert" }, text: view.message ?? `Access denied: the role “${view.role}” cannot open the source. The public summary remains available.` });
    const request = button("Request access", async () => {
      try { await api.post(`${base}/embeds/${encodeURIComponent(view.id)}/request-access`, {}); } catch (e) { toast(errorText(e), { kind: "info", timeoutMs: 10000 }); }
    });
    const verify = button("Verify identity", async () => {
      await openDialog<true>({ title: "Verify identity", size: "narrow", cancelLabel: "Close",
        body: h("div", { class: "stack" }, notice(app.signedIn ? `You are signed in as ${app.account?.username}. This installation has no workspace that assigns roles, so your role here is “${view.role}”. Only the owner of a document can open a locked component's source.` : "Sign in to prove who you are. Even then, this installation has no workspace that assigns roles, so only the document's owner can open a locked component's source.", "info")) }).result;
    });
    const validate = button("Validate", async () => { toast("The source is locked, so it cannot be validated by this role. The public summary below is what readers see.", { kind: "info", timeoutMs: 8000 }); });
    fill(body, h("div", { class: "embed-head" }, h("strong", { text: "EMBED" }), h("span", { class: "chip", text: "Locked" })),
      h("dl", { class: "kv" }, h("dt", { text: "Purpose" }), h("dd", { text: view.lock?.label || "Locked component" }), h("dt", { text: "Access" }), h("dd", { text: `Requires ${view.lock?.requires ?? "owner"}` }), h("dt", { text: "Current role" }), h("dd", { text: view.role })),
      view.lock?.summary ? h("p", { class: "muted", text: view.lock.summary }) : null,
      h("p", { class: "muted", text: "Public summary:" }), h("pre", { class: "embed-output", text: view.output || "(no output)" }),
      h("div", { class: "actions" }, validate, request, verify), deny);
  };

  /* ---------------------------------------------------------------------------------------------- editor view */
  const template = (cat: Catalogue, kind: string, input: string | null): Record<string, unknown> => {
    const spec = cat.kinds.find((k) => k.kind === kind);
    const params: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(spec?.params ?? {})) {
      if (!p.required) continue;
      params[name] = p.enum ? p.enum[0] : p.type === "int" ? (p.min ?? 0) : p.type === "bool" ? true : "";
    }
    return { kind, schema_version: spec?.version ?? 1, params, inputs: input ? [{ ref: input }] : [] };
  };

  const editor = async (view: View | null, newKind?: string): Promise<void> => {
    const cat = await loadCatalogue();
    clear(body);
    const sel = ed.recallSelection();
    const cursorBlock = sel && ed.model.block(sel.start.block)?.type !== "embed" ? sel.start.block : null;
    const after = A.anchorBlock(ed);
    let embedId = view?.id ?? null;
    let kind = view?.kind ?? newKind ?? cat.kinds[0]?.kind ?? "writer.stats";
    const code = h("textarea", { class: "embed-code", rows: 12, attrs: { spellcheck: "false", "aria-label": "Component declaration (JSON)" } });
    const writeDecl = (d: Record<string, unknown>): void => { code.value = JSON.stringify(d, null, 2); };
    writeDecl(view ? { kind: view.kind, schema_version: view.version, params: view.params ?? {}, inputs: (view.inputs ?? []).map((i) => ({ ref: i.ref })) } : template(cat, kind, cursorBlock));
    const message = h("div", { attrs: { "aria-live": "polite" } });
    const previewBox = h("pre", { class: "embed-output", text: view?.output || "(nothing yet)" });
    const previewLabel = h("p", { class: "muted", text: view ? "Last valid output:" : "Safe preview:" });
    let checked: { check: Check; text: string; version: number } | null = null;
    const applyBtn = button("Apply", () => doApply(), "primary");
    applyBtn.disabled = true;
    applyBtn.title = "Apply is available after a valid preview.";

    const parse = (): Record<string, unknown> | null => {
      try { const v = JSON.parse(code.value) as unknown; if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* reported below */ }
      message.replaceChildren(h("p", { class: "embed-bad", attrs: { role: "alert" }, text: "The declaration is not valid JSON. Check the commas and quotes." }));
      return null;
    };
    const report = (c: Check): void => {
      message.replaceChildren(c.valid ? h("p", { class: "embed-ok", text: "Valid. This component only reads the blocks it names and cannot reach the network or your files." })
        : h("div", { class: "embed-bad", attrs: { role: "alert" } }, h("strong", { text: "Not valid yet:" }), h("ul", {}, c.errors.map((e) => h("li", { text: `${e.path}: ${e.message}` })))));
    };
    const withBody = (decl: Record<string, unknown>): Record<string, unknown> => ({ declaration: { ...decl, ...(embedId ? { id: embedId } : {}) }, ...(embedId ? { embed: embedId } : {}) });
    const run = async (kindOfCall: "validate" | "preview"): Promise<void> => {
      const decl = parse();
      if (!decl) return;
      await ed.whenIdle();
      const text = code.value;
      const out = await api.post<Check>(`${base}/embeds/${kindOfCall}`, withBody(decl));
      report(out);
      if (kindOfCall === "preview" || out.valid) { previewLabel.textContent = out.valid ? "Safe preview:" : "Last valid output:"; previewBox.textContent = (out.valid ? out.output : out.lastValidOutput ?? view?.output) ?? "(nothing yet)"; }
      checked = out.valid ? { check: out, text, version: ed.model.version } : null;
      applyBtn.disabled = !(out.valid && kindOfCall === "preview");
      if (kindOfCall === "validate" && out.valid) { applyBtn.disabled = true; applyBtn.title = "Press Preview first; Apply is bound to what you previewed."; }
    };
    const doApply = async (): Promise<void> => {
      const decl = parse();
      if (!decl || !checked || checked.text !== code.value) { toast("The declaration changed. Preview it again first.", { kind: "info" }); applyBtn.disabled = true; return; }
      const preview = checked;
      try {
        const out = await ed.call(() => api.post<{ embed: string; patch: Patch; output: string }>(`${base}/embeds/apply`, { ...withBody({ ...decl, inputs: preview.check.inputs ?? decl["inputs"] }), after: embedId ? undefined : after, base: preview.version }), (r) => r.patch);
        embedId = out.embed;
        announce("Component applied as one edit. Undo reverses it.");
        toast("Component applied. Undo reverses it.", { kind: "ok" });
        const block = ed.model.list().find((b) => b.embed === out.embed);
        if (block) await open(block.id);
      } catch (e) {
        const stale = (e as { details?: { kind?: string } }).details?.kind;
        toast(stale === "stale_version" || stale === "stale_input" ? "The document changed since you previewed this component. Preview it again." : errorText(e), { kind: "error", timeoutMs: 9000 });
        applyBtn.disabled = true;
      }
    };
    code.addEventListener("input", () => { applyBtn.disabled = true; checked = null; });

    const kindSelect = h("select", { attrs: { "aria-label": "Component" }, disabled: view !== null }, cat.kinds.map((k) => h("option", { value: k.kind, text: `${k.label}`, selected: k.kind === kind })));
    kindSelect.value = kind;
    kindSelect.addEventListener("change", () => { kind = kindSelect.value; writeDecl(template(cat, kind, cursorBlock)); applyBtn.disabled = true; checked = null; message.replaceChildren(); });
    const useCursor = button("Use the paragraph at the cursor as input", () => {
      const decl = parse();
      const id = ed.recallSelection()?.start.block;
      if (!decl || !id || ed.model.block(id)?.type === "embed") { toast("Click in a paragraph or table first.", { kind: "info" }); return; }
      const inputs = Array.isArray(decl["inputs"]) ? [...(decl["inputs"] as unknown[]), { ref: id }] : [{ ref: id }];
      writeDecl({ ...decl, inputs }); applyBtn.disabled = true; checked = null;
    });
    const spec = cat.kinds.find((k) => k.kind === kind);
    const lockBtn = view && view.role === "owner" ? button(view.locked ? "Remove lock" : "Lock this component…", async () => {
      if (view.locked) { try { ed.applyExternalPatch(await ed.call(() => api.del<Patch>(`${base}/embeds/${encodeURIComponent(view.id)}/lock`))); } catch (e) { toast(errorText(e), { kind: "error" }); } await open(view.block ?? "new"); return; }
      const label = await promptDialog({ title: "Lock this component", label: "Purpose shown to readers who cannot open it", value: "Approved calculation", maxLength: 80, confirmLabel: "Lock" });
      if (label === null) return;
      try { ed.applyExternalPatch(await ed.call(() => api.post<Patch>(`${base}/embeds/${encodeURIComponent(view.id)}/lock`, { label, summary: "" }))); } catch (e) { toast(errorText(e), { kind: "error" }); }
      await open(view.block ?? "new");
    }) : null;

    fill(body,
      h("div", { class: "embed-head" }, h("strong", { text: "EMBED" }), h("span", { class: "chip", text: view ? "Approved transformation" : "New component" }), cat.level === "none" ? h("span", { class: "chip warn", text: "Not in your plan" }) : null),
      h("div", { class: "grid-2" }, labelled("Component", kindSelect), h("dl", { class: "kv" }, h("dt", { text: "Version" }), h("dd", { text: String(view?.version ?? spec?.version ?? 1) }))),
      spec ? h("p", { class: "muted", text: spec.describes }) : null,
      labelled("Declaration", code, { hint: "A declaration, not code. Name the blocks it reads under “inputs” by their ids; the button below adds the paragraph at your cursor." }),
      h("div", { class: "actions" }, useCursor), message, previewLabel, previewBox,
      h("div", { class: "actions" }, button("Validate", () => run("validate")), button("Preview", () => run("preview")), applyBtn, lockBtn),
      h("p", { class: "muted", text: cat.note }));
    if (cat.level === "none") { fill(body, notice("Your plan does not include EMBED components, so Apply will be refused. Validate and Preview still work.", "warn")); }
  };

  const open = async (target: string): Promise<void> => {
    show(true);
    try {
      if (target === "new") { await editor(null); }
      else {
        const block = ed.model.block(target);
        const eid = block?.embed;
        if (!eid) { toast("That block is not an EMBED component.", { kind: "info" }); return; }
        const view = await api.get<View>(`${base}/embeds/${encodeURIComponent(eid)}`);
        if (view.access === "denied") locked(view);
        else await editor(view);
      }
    } catch (e) { clear(body); fill(body, notice(errorText(e), "danger")); }
  };

  /* ------------------------------------------------------------------------------------------------ nothing selected */
  const idle = (): void => {
    clear(body);
    fill(body,
      h("div", { class: "embed-head" }, h("strong", { text: "EMBED" }), h("span", { class: "chip", text: "No component selected" })),
      h("p", { class: "muted", text: "EMBED components are small declarations that read parts of this document and show a safe result, for example a word count or a total. Opening this panel does not run anything and does not unlock any protected component." }),
      h("p", { class: "muted", text: "Click a component in the page to see it here, or create one." }),
      h("div", { class: "actions" }, button("New component", () => open("new"), "primary")));
  };
  const openFromTab = async (): Promise<void> => {
    const sel = ed.recallSelection();
    const block = sel ? ed.model.block(sel.start.block) : undefined;
    if (block?.embed) await open(block.id); else idle();
  };

  return { el: root, refresh: () => undefined, open, openFromTab, close: () => show(false), get isOpen() { return host.isOpen(); } };
}
