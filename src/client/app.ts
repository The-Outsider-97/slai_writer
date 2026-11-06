/** Application state shared by every screen: what the server said at start-up, who is signed in, which documents are open, and where we are. */
import { announce, ApiError, applyAppearance, Emitter, normaliseAppearance, toast } from "./kit.js";
import { api, errorText, onFailure } from "./net.js";
import type { AccountPublic, Bootstrap, DocState, DocSummary, Prefs } from "./types.js";

export type RouteName =
  | "startup" | "verify" | "twofa" | "enroll" | "reset" | "recover"
  | "home" | "new" | "settings" | "plans" | "signatures" | "profile" | "help" | "versions" | "verify-signature" | "sign" | "doc";

export interface Route { name: RouteName; sid?: string }

export interface Screen { el: HTMLElement; destroy?(): void; focus?(): void }
export type Chrome = "bare" | "shell" | "own";
export type ScreenFactory = (app: App, route: Route) => Screen | Promise<Screen>;

/** What the sign-in screens remember while the person moves between them. Held in memory only: nothing secret goes in the address bar or storage. */
export interface AuthFlow {
  email?: string; maskedEmail?: string; expiresAt?: number; resendAt?: number; codeLength?: number;
  challenge?: string; reason?: string; challengeExpires?: number; restart?: boolean;
  recoveryCodes?: string[]; setup?: { setupKey: string; uri: string; qr: string; qrAvailable: boolean } | null; fromSignup?: boolean;
  after?: Route;
}

export type AppEvent =
  | { type: "route"; route: Route }
  | { type: "account" }
  | { type: "prefs" }
  | { type: "docs" }
  | { type: "doc-state"; sid: string }
  | { type: "offline"; offline: boolean };

const ROUTES: ReadonlySet<string> = new Set<RouteName>(["startup", "verify", "twofa", "enroll", "reset", "recover", "home", "new", "settings", "plans", "signatures", "profile", "help", "versions", "verify-signature", "sign", "doc"]);
const NEEDS_DOC: ReadonlySet<string> = new Set(["doc", "versions", "verify-signature", "sign"]);

function readGuest(): boolean { try { return window.sessionStorage.getItem("writer.guest") === "1"; } catch { return false; } }
function writeGuest(on: boolean): void { try { if (on) window.sessionStorage.setItem("writer.guest", "1"); else window.sessionStorage.removeItem("writer.guest"); } catch { /* storage may be blocked: the choice then just lasts until the next start */ } }

export class App {
  boot!: Bootstrap;
  readonly events = new Emitter<AppEvent>();
  readonly factories = new Map<RouteName, { make: ScreenFactory; chrome: Chrome }>();
  readonly auth: AuthFlow = {};
  readonly docs = new Map<string, DocSummary>();
  /** Documents whose editors are alive. Closed documents are dropped when their tab is closed. */
  readonly editors = new Map<string, unknown>();
  route: Route = { name: "startup" };
  lastDoc: string | null = null;
  guest = readGuest();
  offline = false;
  private screen: Screen | null = null;
  private mount: HTMLElement;
  private routing = 0;

  constructor(readonly root: HTMLElement) {
    this.mount = root;
    onFailure((error) => {
      const down = error.code === "offline";
      if (down !== this.offline) { this.offline = down; this.events.emit({ type: "offline", offline: down }); }
      if (error.status === 401 && error.code === "unauthorized" && this.boot?.account) { void this.refresh().then(() => this.events.emit({ type: "account" })); }
    });
    window.addEventListener("hashchange", () => { void this.render(this.parse(window.location.hash)); });
    window.addEventListener("online", () => { this.offline = false; this.events.emit({ type: "offline", offline: false }); });
  }

  register(name: RouteName, make: ScreenFactory, chrome: Chrome): void { this.factories.set(name, { make, chrome }); }

  /* --------------------------------------------------------------------------------------------- start-up */
  async start(): Promise<void> {
    await this.refresh();
    const wanted = this.parse(window.location.hash);
    const first = this.signedIn || this.guest ? wanted : { name: "startup" as RouteName };
    const open = this.boot.open;
    for (const d of open) this.docs.set(d.sid, d);
    if (!this.signedIn && !this.guest && wanted.name !== "startup" && wanted.name !== "signatures") { this.go({ name: "startup" }, true); return; }
    if (first.name === "startup" && (this.signedIn || this.guest)) { this.go({ name: "home" }, true); return; }
    await this.render(first);
  }

  async refresh(): Promise<Bootstrap> {
    this.boot = await api.get<Bootstrap>("/bootstrap");
    this.applyPrefs();
    return this.boot;
  }

  get signedIn(): boolean { return this.boot?.account != null; }
  get account(): AccountPublic | null { return this.boot?.account ?? null; }
  get prefs(): Prefs { return this.boot.prefs; }
  get plan(): string { return this.boot.plan; }

  continueAsGuest(): void { this.guest = true; writeGuest(true); this.go({ name: "home" }); }

  async signedInAs(account: AccountPublic, next: RouteName = "home"): Promise<void> {
    this.guest = false; writeGuest(false);
    await this.refresh();
    this.events.emit({ type: "account" });
    this.go({ name: next });
    announce(`Signed in as ${account.username}.`);
  }

  async signOut(): Promise<void> {
    try { await api.post("/account/logout"); } catch (error) { toast(errorText(error), { kind: "error" }); return; }
    this.guest = false; writeGuest(false);
    await this.refresh();
    this.events.emit({ type: "account" });
    this.go({ name: "startup" });
  }

  /* --------------------------------------------------------------------------------------------- preferences */
  applyPrefs(): void {
    const p = this.boot.prefs;
    applyAppearance(normaliseAppearance({ theme: p.theme, scale: p.scale, motion: p.motion }), "soft");
  }

  async setPrefs(patch: Partial<Prefs>): Promise<Prefs> {
    const next = await api.put<Prefs>("/prefs", patch);
    this.boot = { ...this.boot, prefs: next };
    this.applyPrefs();
    this.events.emit({ type: "prefs" });
    return next;
  }

  /* --------------------------------------------------------------------------------------------- documents */
  summary(state: DocState): DocSummary {
    const { sid, title, path, dirty, name, readOnly, signed, origin } = state;
    return { sid, title, path, dirty, name, readOnly, signed, origin };
  }

  remember(state: DocState): void { this.docs.set(state.sid, this.summary(state)); this.lastDoc = state.sid; this.events.emit({ type: "docs" }); }

  async openDocs(): Promise<DocSummary[]> {
    const { open } = await api.get<{ open: DocSummary[] }>("/docs");
    this.docs.clear();
    for (const d of open) this.docs.set(d.sid, d);
    this.events.emit({ type: "docs" });
    return open;
  }

  /** The document the sidebar's document actions (Export, Print, Favorite, Version history) apply to. */
  get activeSid(): string | null {
    if (this.route.name === "doc" && this.route.sid) return this.route.sid;
    if (this.route.sid && this.docs.has(this.route.sid)) return this.route.sid;
    if (this.lastDoc && this.docs.has(this.lastDoc)) return this.lastDoc;
    return null;
  }

  /* --------------------------------------------------------------------------------------------- routing */
  parse(hash: string): Route {
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    const name = parts[0] ?? "";
    if (!ROUTES.has(name)) return { name: this.signedIn || this.guest ? "home" : "startup" };
    const route: Route = { name: name as RouteName };
    if (NEEDS_DOC.has(name)) { const sid = parts[1]; if (sid) route.sid = decodeURIComponent(sid); else return { name: "home" }; }
    return route;
  }

  href(route: Route): string { return `#/${route.name}${route.sid ? `/${encodeURIComponent(route.sid)}` : ""}`; }

  go(route: Route, replace = false): void {
    const target = this.href(route);
    if (window.location.hash === target) { void this.render(route); return; }
    if (replace) window.history.replaceState(null, "", target);
    // setting the hash fires hashchange, which renders
    if (replace) void this.render(route); else window.location.hash = target;
  }

  chromeOf(name: RouteName): Chrome { return this.factories.get(name)?.chrome ?? "bare"; }

  async render(route: Route): Promise<void> {
    const ticket = ++this.routing;
    const entry = this.factories.get(route.name);
    if (!entry) return;
    // the sign-in screens are for people who are not in yet; guests and members go Home instead
    const authOnly: RouteName[] = ["startup", "verify", "twofa", "reset", "recover"];
    if (authOnly.includes(route.name) && this.signedIn) { this.go({ name: "home" }, true); return; }
    if (!this.signedIn && !this.guest && route.name !== "startup" && !authOnly.includes(route.name) && route.name !== "signatures") { this.go({ name: "startup" }, true); return; }
    this.screen?.destroy?.();
    this.screen = null;
    this.route = route;
    document.body.dataset.route = route.name;
    let screen: Screen;
    try { screen = await entry.make(this, route); }
    catch (error) {
      if (ticket !== this.routing) return;
      const missing = error instanceof ApiError && error.status === 404;
      toast(errorText(error), { kind: "error" });
      this.screen = null;
      if (route.name === "doc" || route.sid) { this.docs.delete(route.sid ?? ""); this.go({ name: "home" }, true); return; }
      if (!missing && route.name !== "home") { this.go({ name: "home" }, true); return; }
      throw error;
    }
    if (ticket !== this.routing) { screen.destroy?.(); return; }
    this.screen = screen;
    while (this.mount.firstChild) this.mount.removeChild(this.mount.firstChild);
    this.mount.appendChild(screen.el);
    this.events.emit({ type: "route", route });
    window.scrollTo(0, 0);
    screen.focus?.();
  }
}
