/** Application state shared by every screen: what the server said at start-up, who is signed in, which documents are open, and where we are. */
import { announce, ApiError, applyAppearance, Emitter, normaliseAppearance, toast } from "./kit.js";
import { api, errorText, onFailure } from "./net.js";
const ROUTES = new Set(["startup", "verify", "twofa", "enroll", "reset", "recover", "home", "new", "settings", "plans", "signatures", "profile", "help", "versions", "verify-signature", "sign", "doc"]);
const NEEDS_DOC = new Set(["doc", "versions", "verify-signature", "sign"]);
function readGuest() { try {
    return window.sessionStorage.getItem("writer.guest") === "1";
}
catch {
    return false;
} }
function writeGuest(on) { try {
    if (on)
        window.sessionStorage.setItem("writer.guest", "1");
    else
        window.sessionStorage.removeItem("writer.guest");
}
catch { /* storage may be blocked: the choice then just lasts until the next start */ } }
export class App {
    root;
    boot;
    events = new Emitter();
    factories = new Map();
    auth = {};
    docs = new Map();
    /** Documents whose editors are alive. Closed documents are dropped when their tab is closed. */
    editors = new Map();
    route = { name: "startup" };
    lastDoc = null;
    guest = readGuest();
    offline = false;
    screen = null;
    mount;
    routing = 0;
    constructor(root) {
        this.root = root;
        this.mount = root;
        onFailure((error) => {
            const down = error.code === "offline";
            if (down !== this.offline) {
                this.offline = down;
                this.events.emit({ type: "offline", offline: down });
            }
            if (error.status === 401 && error.code === "unauthorized" && this.boot?.account) {
                void this.refresh().then(() => this.events.emit({ type: "account" }));
            }
        });
        window.addEventListener("hashchange", () => { void this.render(this.parse(window.location.hash)); });
        window.addEventListener("online", () => { this.offline = false; this.events.emit({ type: "offline", offline: false }); });
    }
    register(name, make, chrome) { this.factories.set(name, { make, chrome }); }
    /* --------------------------------------------------------------------------------------------- start-up */
    async start() {
        await this.refresh();
        const wanted = this.parse(window.location.hash);
        const first = this.signedIn || this.guest ? wanted : { name: "startup" };
        const open = this.boot.open;
        for (const d of open)
            this.docs.set(d.sid, d);
        if (!this.signedIn && !this.guest && wanted.name !== "startup" && wanted.name !== "signatures") {
            this.go({ name: "startup" }, true);
            return;
        }
        if (first.name === "startup" && (this.signedIn || this.guest)) {
            this.go({ name: "home" }, true);
            return;
        }
        await this.render(first);
    }
    async refresh() {
        this.boot = await api.get("/bootstrap");
        this.applyPrefs();
        return this.boot;
    }
    get signedIn() { return this.boot?.account != null; }
    get account() { return this.boot?.account ?? null; }
    get prefs() { return this.boot.prefs; }
    get plan() { return this.boot.plan; }
    continueAsGuest() { this.guest = true; writeGuest(true); this.go({ name: "home" }); }
    async signedInAs(account, next = "home") {
        this.guest = false;
        writeGuest(false);
        await this.refresh();
        this.events.emit({ type: "account" });
        this.go({ name: next });
        announce(`Signed in as ${account.username}.`);
    }
    async signOut() {
        try {
            await api.post("/account/logout");
        }
        catch (error) {
            toast(errorText(error), { kind: "error" });
            return;
        }
        this.guest = false;
        writeGuest(false);
        await this.refresh();
        this.events.emit({ type: "account" });
        this.go({ name: "startup" });
    }
    /* --------------------------------------------------------------------------------------------- preferences */
    applyPrefs() {
        const p = this.boot.prefs;
        applyAppearance(normaliseAppearance({ theme: p.theme, scale: p.scale, motion: p.motion }), "soft");
    }
    async setPrefs(patch) {
        const next = await api.put("/prefs", patch);
        this.boot = { ...this.boot, prefs: next };
        this.applyPrefs();
        this.events.emit({ type: "prefs" });
        return next;
    }
    /* --------------------------------------------------------------------------------------------- documents */
    summary(state) {
        const { sid, title, path, dirty, name, readOnly, signed, origin } = state;
        return { sid, title, path, dirty, name, readOnly, signed, origin };
    }
    remember(state) { this.docs.set(state.sid, this.summary(state)); this.lastDoc = state.sid; this.events.emit({ type: "docs" }); }
    async openDocs() {
        const { open } = await api.get("/docs");
        this.docs.clear();
        for (const d of open)
            this.docs.set(d.sid, d);
        this.events.emit({ type: "docs" });
        return open;
    }
    /** The document the sidebar's document actions (Export, Print, Favorite, Version history) apply to. */
    get activeSid() {
        if (this.route.name === "doc" && this.route.sid)
            return this.route.sid;
        if (this.route.sid && this.docs.has(this.route.sid))
            return this.route.sid;
        if (this.lastDoc && this.docs.has(this.lastDoc))
            return this.lastDoc;
        return null;
    }
    /* --------------------------------------------------------------------------------------------- routing */
    parse(hash) {
        const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
        const name = parts[0] ?? "";
        if (!ROUTES.has(name))
            return { name: this.signedIn || this.guest ? "home" : "startup" };
        const route = { name: name };
        if (NEEDS_DOC.has(name)) {
            const sid = parts[1];
            if (sid)
                route.sid = decodeURIComponent(sid);
            else
                return { name: "home" };
        }
        return route;
    }
    href(route) { return `#/${route.name}${route.sid ? `/${encodeURIComponent(route.sid)}` : ""}`; }
    go(route, replace = false) {
        const target = this.href(route);
        if (window.location.hash === target) {
            void this.render(route);
            return;
        }
        if (replace)
            window.history.replaceState(null, "", target);
        // setting the hash fires hashchange, which renders
        if (replace)
            void this.render(route);
        else
            window.location.hash = target;
    }
    chromeOf(name) { return this.factories.get(name)?.chrome ?? "bare"; }
    async render(route) {
        const ticket = ++this.routing;
        const entry = this.factories.get(route.name);
        if (!entry)
            return;
        // the sign-in screens are for people who are not in yet; guests and members go Home instead
        const authOnly = ["startup", "verify", "twofa", "reset", "recover"];
        if (authOnly.includes(route.name) && this.signedIn) {
            this.go({ name: "home" }, true);
            return;
        }
        if (!this.signedIn && !this.guest && route.name !== "startup" && !authOnly.includes(route.name) && route.name !== "signatures") {
            this.go({ name: "startup" }, true);
            return;
        }
        this.screen?.destroy?.();
        this.screen = null;
        this.route = route;
        document.body.dataset.route = route.name;
        let screen;
        try {
            screen = await entry.make(this, route);
        }
        catch (error) {
            if (ticket !== this.routing)
                return;
            const missing = error instanceof ApiError && error.status === 404;
            toast(errorText(error), { kind: "error" });
            this.screen = null;
            if (route.name === "doc" || route.sid) {
                this.docs.delete(route.sid ?? "");
                this.go({ name: "home" }, true);
                return;
            }
            if (!missing && route.name !== "home") {
                this.go({ name: "home" }, true);
                return;
            }
            throw error;
        }
        if (ticket !== this.routing) {
            screen.destroy?.();
            return;
        }
        this.screen = screen;
        while (this.mount.firstChild)
            this.mount.removeChild(this.mount.firstChild);
        this.mount.appendChild(screen.el);
        this.events.emit({ type: "route", route });
        window.scrollTo(0, 0);
        screen.focus?.();
    }
}
