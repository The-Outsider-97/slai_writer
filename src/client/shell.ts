/** The fixed chrome around Home, Settings and the other pages: title bar, the left navigation, the status line. The editor reuses the navigation inside its sandwich menu. */
import type { App, RouteName } from "./app.js";
import { exportFlow, importFlow, needDoc, openFile, printFlow, toggleFavorite, uploadFile } from "./fileops.js";
import { chevron, dico, toggleKnob, type DesignIcon } from "./dico.js";
import { glyph, h } from "./kit.js";
import { run } from "./widgets.js";

export interface SidebarItem { id: string; label: string; icon: string; design: DesignIcon; run: () => void | Promise<void>; route?: RouteName }

export function sidebarItems(app: App): { top: SidebarItem[]; bottom: SidebarItem[] } {
  const doc = async (what: string, fn: (sid: string) => Promise<void>): Promise<void> => { const sid = await needDoc(app, what); if (sid) await fn(sid); };
  const top: SidebarItem[] = [
    { id: "home", label: "Home", icon: "home", design: "n-home", route: "home", run: () => app.go({ name: "home" }) },
    { id: "new", label: "New Page", icon: "page-plus", design: "n-new", route: "new", run: () => app.go({ name: "new" }) },
    { id: "open", label: "Open", icon: "folder-open", design: "n-open", run: () => openFile(app) },
    { id: "upload", label: "Upload", icon: "upload", design: "n-upload", run: () => uploadFile(app) },
    { id: "export", label: "Export", icon: "download", design: "n-export", run: () => doc("Export", (sid) => exportFlow(app, sid)) },
    { id: "import", label: "Import", icon: "archive", design: "n-import", run: () => importFlow(app) },
    { id: "favorite", label: "Favorite", icon: "star", design: "n-favorite", run: () => doc("Favorite", (sid) => toggleFavorite(app, sid)) },
    { id: "versions", label: "Version history", icon: "history", design: "n-versions", run: () => doc("Version history", async (sid) => { app.go({ name: "versions", sid }); }) },
    { id: "print", label: "Print", icon: "print", design: "n-print", run: () => doc("Print", (sid) => printFlow(app, sid)) },
  ];
  const bottom: SidebarItem[] = [
    { id: "profile", label: "Profile / Login", icon: app.signedIn ? "user" : "log-in", design: "n-profile", route: "profile", run: () => { if (app.signedIn) app.go({ name: "profile" }); else app.go({ name: "startup" }); } },
    { id: "settings", label: "Settings", icon: "settings", design: "n-settings", route: "settings", run: () => app.go({ name: "settings" }) },
    { id: "plans", label: "Plans & Pricing", icon: "tag", design: "n-plans", route: "plans", run: () => app.go({ name: "plans" }) },
    { id: "help", label: "Support SLAI Writer", icon: "help", design: "n-support", route: "help", run: () => app.go({ name: "help" }) },
  ];
  return { top, bottom };
}

export function buildSidebar(app: App, active: RouteName | null, after?: () => void): HTMLElement {
  const { top, bottom } = sidebarItems(app);
  const make = (item: SidebarItem): HTMLElement => {
    const current = item.route !== undefined && item.route === active;
    const button = h("button", { class: `side-item${current ? " current" : ""}`, type: "button", attrs: { "aria-current": current ? "page" : null } }, dico(item.design), h("span", { text: item.label }));
    button.addEventListener("click", () => { void run(button, async () => { await item.run(); after?.(); }); });
    return button;
  };
  return h("nav", { class: "sidebar", attrs: { "aria-label": "Main" } }, h("div", { class: "side-group" }, top.map(make)), h("div", { class: "side-group bottom" }, bottom.map(make)));
}

/** The four separate statuses of the specification: local save, cloud sync, AI availability and signature verification. */
export interface StatusInput { saved?: "saved" | "unsaved" | "none"; autosave?: boolean; signatures?: number; signedState?: string }
export function statusDots(app: App, input: StatusInput = {}, compact = false): HTMLElement {
  const caps = app.boot.capabilities;
  const ai = caps.ai;
  const aiOn = ai.enabled;
  const aiAvailable = ai.providers.some((p) => p.available);
  const dot = (name: string, tone: string, text: string, title: string): HTMLElement =>
    h("span", { class: `status-dot ${tone}`, attrs: { title, "data-status": name } }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), h("span", { text }));
  const local = input.saved === "unsaved" ? dot("local", "warn", "Local: unsaved changes", "This document has changes that are not saved to its file.")
    : input.saved === "saved" ? dot("local", "ok", "Local: saved", `Saved to this computer${input.autosave ? " (autosave on)" : ""}.`)
    : dot("local", "idle", "Local: ready", "Documents are saved on this computer.");
  const cloud = dot("cloud", "idle", "Cloud: not connected", caps.workspace.reason || "No workspace server is connected, so nothing is synced.");
  const aiDot = !aiOn ? dot("ai", "idle", "AI: off", "AI is off. Writing works fully without it. Turn it on in Settings.")
    : aiAvailable ? dot("ai", "ok", "AI: available", "AI is on and a provider can answer.") : dot("ai", "warn", "AI: unavailable", "AI is on but no provider is available right now.");
  const sig = input.signatures
    ? dot("signature", input.signedState === "invalid" ? "danger" : "ok", `Signature: ${input.signatures} on file`, "Open Verify Signature to check it.")
    : dot("signature", "idle", "Signature: none", "This document has no cryptographic signature.");
  return h("div", { class: `status-dots${compact ? " compact" : ""}`, attrs: { role: "group", "aria-label": "Status" } }, local, cloud, aiDot, sig);
}

export interface ShellParts { el: HTMLElement; main: HTMLElement; title: HTMLElement; search: HTMLInputElement | null; dispose(): void }

export interface ShellOptions { title?: string; searchPlaceholder?: string; onSearch?: (query: string) => void; status?: HTMLElement | null }

/** The light/dark switch of the design: a pill whose round knob carries the 8-point star (light) or the crescent (dark). */
export function themeToggle(app: App): HTMLButtonElement {
  const isDark = (): boolean => document.documentElement.dataset.theme === "dark" || (document.documentElement.dataset.theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const disc = h("span", { class: "knob-disc" }, toggleKnob("light"), toggleKnob("dark"));
  const button = h("button", { class: "theme-toggle", type: "button", attrs: { role: "switch", "aria-label": "Dark appearance", title: "Light / dark" } }, disc);
  const paint = (): void => { const dark = isDark(); button.setAttribute("aria-checked", String(dark)); button.dataset["dark"] = String(dark); };
  paint();
  button.addEventListener("click", () => {
    // the knob slides at once; the page then fades between the two appearances instead of snapping
    const dark = !isDark();
    button.setAttribute("aria-checked", String(dark)); button.dataset["dark"] = String(dark);
    const root = document.documentElement;
    root.classList.add("theme-fade");
    window.setTimeout(() => root.classList.remove("theme-fade"), 600);
    void run(button, async () => { await app.setPrefs({ theme: dark ? "dark" : "light" }); paint(); });
  });
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const gone = (): boolean => { if (button.isConnected) return false; media.removeEventListener("change", paint); off(); return true; };
  const off = app.events.on((e) => { if (e.type === "prefs" && !gone()) paint(); });
  media.addEventListener("change", paint);
  return button;
}

export function buildShell(app: App, active: RouteName, options: ShellOptions = {}): ShellParts {
  const title = h("h1", { class: "title", text: options.title ?? "SLAI Writer" });
  let search: HTMLInputElement | null = null;
  const bar = h("header", { class: "titlebar" }, title);
  // From Profile, Settings, Plans, Support and the other pages opened from a document: a way straight back to that document.
  const sid = app.activeSid;
  if (sid && !["home", "new", "doc", "startup"].includes(active)) {
    const name = app.docs.get(sid)?.name;
    const back = h("button", { class: "btn return-doc", type: "button", attrs: { title: name ? `Return to ${name}` : "Return to the document", "aria-label": name ? `Return to document ${name}` : "Return to document" } }, chevron("left"), h("span", { text: "Return to document" }));
    back.addEventListener("click", () => app.go({ name: "doc", sid }));
    bar.appendChild(back);
  }
  if (options.onSearch) {
    search = h("input", { type: "search", class: "search", attrs: { placeholder: options.searchPlaceholder ?? "Search", "aria-label": options.searchPlaceholder ?? "Search" } });
    const callback = options.onSearch;
    let timer: number | undefined;
    search.addEventListener("input", () => { window.clearTimeout(timer); timer = window.setTimeout(() => callback(search?.value ?? ""), 200); });
    bar.appendChild(h("div", { class: "search-wrap" }, glyph("search"), search));
  } else bar.appendChild(h("div", { class: "grow" }));
  bar.appendChild(themeToggle(app));
  const main = h("main", { class: "page-main", id: "main", attrs: { tabindex: "-1" } });
  const offline = h("div", { class: "offline-banner", attrs: { role: "alert" }, hidden: !app.offline, text: "Can't reach the local SLAI Writer server. Your open documents are safe on the server; check that it is running." });
  const off = app.events.on((e) => { if (e.type === "offline") offline.hidden = !e.offline; });
  const body = h("div", { class: "shell-body" }, buildSidebar(app, active), h("div", { class: "shell-main" }, bar, offline, main));
  const status = h("footer", { class: "statusbar" }, h("span", { class: "pen-slot" }, glyph("pen")), options.status ?? statusDots(app));
  return { el: h("div", { class: "shell" }, body, status), main, title, search, dispose: off };
}
