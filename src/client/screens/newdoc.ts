/** New document: name, template cards, page size / orientation, destination, accessible headings, language. */
import type { App, Screen } from "../app.js";
import { api, errorText } from "../net.js";
import { chooseFile } from "../fileops.js";
import { buildShell } from "../shell.js";
import { clear, glyph, h, labelled, toast } from "../kit.js";
import type { DocState, TemplateData, TemplateInfo } from "../types.js";
import { button, checkbox, errorLine, notice, fill } from "../widgets.js";

const LANGUAGES: Array<[string, string]> = [["en", "English"], ["en-GB", "English (UK)"], ["en-US", "English (US)"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"], ["nl", "Nederlands"], ["pt", "Português"], ["pl", "Polski"], ["sv", "Svenska"], ["da", "Dansk"], ["nb", "Norsk bokmål"], ["fi", "Suomi"], ["cs", "Čeština"], ["tr", "Türkçe"], ["ja", "日本語"], ["zh", "中文"], ["ko", "한국어"], ["ar", "العربية"]];
const SPEC_ORDER = ["blank", "report", "illustrated"];
const PLAN_NAME: Record<string, string> = { guest: "Guest", essential: "Essential", creator: "Creator", professional: "Professional", workspace: "Workspace" };

const DEFAULT_NAME = "Untitled document";
function recent(): string | null { try { return window.localStorage.getItem("writer.lastTemplate"); } catch { return null; } }
function remember(id: string): void { try { window.localStorage.setItem("writer.lastTemplate", id); } catch { /* a per-viewer convenience only */ } }

export async function newDocScreen(app: App): Promise<Screen> {
  const data = await api.get<TemplateData>("/templates");
  const shell = buildShell(app, "new");
  const ordered = [...data.templates].sort((a, b) => { const ai = SPEC_ORDER.indexOf(a.id); const bi = SPEC_ORDER.indexOf(b.id); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
  const last = recent();
  let chosen: TemplateInfo = ordered.find((t) => t.id === last && t.available) ?? ordered.find((t) => t.id === "blank") ?? ordered[0] as TemplateInfo;

  const name = h("input", { type: "text", value: DEFAULT_NAME, maxLength: 120, attrs: { autocomplete: "off", spellcheck: "false" } });
  const nameField = labelled("Document name", name, { hint: "The .sldc extension is added for you." });
  const cards = h("div", { class: "template-cards", attrs: { role: "radiogroup", "aria-label": "Template" } });
  const disclosure = h("div", { attrs: { "aria-live": "polite" } });
  const error = errorLine();

  const sizeOptions: Array<[string, string]> = data.pageSizes.flatMap((s) => data.orientations.map((o) => [`${s}|${o}`, `${s} / ${o}`] as [string, string]));
  const size = h("select", {}, sizeOptions.map(([v, t]) => h("option", { value: v, text: t })));
  size.value = `${data.defaults.page_size}|${data.defaults.orientation}`;
  const destinations: Array<[string, string]> = [["library", `Local / ${data.library.split(/[\\/]/).filter(Boolean).pop() ?? "Writer library"}`], ...data.folders.map((f) => [`folder:${f.id}`, `Local / ${f.name}`] as [string, string]), ["other", "Choose another folder…"]];
  const dest = h("select", {}, destinations.map(([v, t]) => h("option", { value: v, text: t })));
  let otherPath: string | null = null;
  let previousDest = "library";
  dest.addEventListener("change", () => {
    if (dest.value !== "other") { previousDest = dest.value; return; }
    void (async () => {
      const path = await chooseFile(app, { kind: "folder", start: app.prefs.last_folder || data.library, title: "Choose a folder for the document" });
      if (path) { otherPath = path; const opt = dest.querySelector<HTMLOptionElement>("option[value=other]"); if (opt) opt.textContent = `Local / ${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`; previousDest = "other"; }
      else dest.value = previousDest;
    })();
  });
  const language = h("select", {}, LANGUAGES.map(([v, t]) => h("option", { value: v, text: t })));
  language.value = LANGUAGES.some(([v]) => v === data.defaults.language) ? data.defaults.language : "en";
  const headings = checkbox("Include accessible heading styles", true);

  const paintCards = (): void => {
    clear(cards);
    for (const t of ordered) {
      const selected = t.id === chosen.id;
      const card = h("button", { class: `template-card${selected ? " selected" : ""}${t.available ? "" : " locked"}`, type: "button", attrs: { role: "radio", "aria-checked": String(selected), "aria-describedby": `tpl-${t.id}` } },
        h("span", { class: "page-thumb", attrs: { "aria-hidden": "true" } }, h("img", { attrs: { src: "/assets/slai_writer.png", alt: "" } })),
        h("strong", { text: t.name }),
        h("span", { class: "muted", id: `tpl-${t.id}`, text: t.available ? t.description : `${t.description} Needs the ${PLAN_NAME[t.minPlan] ?? t.minPlan} plan.` }),
        t.available ? null : h("span", { class: "badge", text: `${PLAN_NAME[t.minPlan] ?? t.minPlan} plan` }));
      card.addEventListener("click", () => { chosen = t; paintCards(); paintDisclosure(); });
      cards.appendChild(card);
    }
  };
  const paintDisclosure = (): void => {
    clear(disclosure);
    if (!chosen.available) {
      const needed = PLAN_NAME[chosen.minPlan] ?? chosen.minPlan;
      disclosure.appendChild(notice(h("span", {}, `${chosen.name} is part of the ${needed} plan; you are on ${PLAN_NAME[data.plan] ?? data.plan}. `, h("button", { class: "linkbtn", type: "button", text: "See Plans & Pricing", on: { click: () => app.go({ name: "plans" }) } }), " Blank, Letter and Meeting notes are always available."), "warn", "A paid template."));
    } else if (chosen.id !== "blank") disclosure.appendChild(notice("Paid-template requirements are disclosed before creation: this template is included in your plan.", "info"));
  };

  const create = async (): Promise<void> => {
    error.show(null);
    if (!chosen.available) { error.show(`${chosen.name} needs the ${PLAN_NAME[chosen.minPlan] ?? chosen.minPlan} plan. Choose another template or see Plans & Pricing.`); return; }
    const [pageSize, orientation] = size.value.split("|");
    const body: Record<string, unknown> = { name: name.value, template: chosen.id, pageSize, orientation, language: language.value, accessibleHeadings: headings.input.checked, suggestedName: name.value === DEFAULT_NAME };
    if (dest.value.startsWith("folder:")) body["directory"] = data.folders.find((f) => `folder:${f.id}` === dest.value)?.path;
    else if (dest.value === "other" && otherPath) body["directory"] = otherPath;
    try {
      const state = await api.post<DocState>("/docs/new", body);
      remember(chosen.id);
      app.remember(state);
      app.go({ name: "doc", sid: state.sid });
    } catch (e) {
      error.show(errorText(e));
      toast("The document was not created.", { kind: "error" });
      name.focus();
    }
  };

  const recentLine = last && ordered.find((t) => t.id === last) ? h("p", { class: "fine", text: `Recently used: ${ordered.find((t) => t.id === last)?.name}` }) : null;
  fill(shell.main,
    h("h2", { class: "page-title", text: "New document" }),
    h("p", { class: "muted", text: "Start with a blank document or a reusable publishing template." }),
    nameField, cards, recentLine,
    h("div", { class: "grid-2" }, labelled("Page size / orientation", size), labelled("Storage destination", dest, { hint: "Local is the default. Shared destinations need a connection and permission; none is available here." })),
    h("div", { class: "grid-2" }, h("div", {}, headings.root), labelled("Document language", language)),
    disclosure, error.el,
    h("div", { class: "actions" }, button("Create document", create, "primary"), button("Cancel", () => { app.go({ name: "home" }); })));
  paintCards();
  paintDisclosure();
  void glyph;
  return { el: shell.el, destroy: shell.dispose, focus: () => { name.focus(); name.select(); } };
}
