/** Profile / account security: two-factor, recovery codes, password, sessions and trusted devices. */
import type { App, Screen } from "../app.js";
import { api, errorText } from "../net.js";
import { buildShell } from "../shell.js";
import { clear, confirmDialog, h, openDialog, toast } from "../kit.js";
import type { AccountPublic } from "../types.js";
import { button, errorLine, notice, run, section, statusBadge, textField, when } from "../widgets.js";
import { recoveryCodesBlock } from "./auth.js";

interface SessionRow { id: string; created: number; lastSeen: number; expires: number; remember: boolean; label: string; current: boolean }
interface DeviceRow { id: string; label: string; created: number; expires: number; lastUsed: number }

/** Ask for the password (and a code where the account has two-factor) and run the sensitive step. */
function reauth(title: string, intro: string, needCode: boolean, confirmLabel: string, work: (password: string, code: string) => Promise<void>): void {
  const pw = textField("Password", { type: "password", autocomplete: "current-password", maxLength: 300 });
  const code = textField("Authenticator or recovery code", { maxLength: 40 });
  code.root.hidden = !needCode;
  const err = errorLine();
  const handle = openDialog<boolean>({
    title, size: "narrow", body: h("div", {}, h("p", { text: intro }), pw.root, code.root, err.el), focus: () => pw.input,
    actions: [{ label: confirmLabel, kind: "primary", run: async () => {
      err.show(null);
      try { await work(pw.input.value, code.input.value.trim()); return true; } catch (e) { err.show(errorText(e)); return undefined; }
    } }],
  });
  void handle.result;
}

export async function profileScreen(app: App): Promise<Screen> {
  const shell = buildShell(app, "profile");
  const account = app.account;
  if (!account) {
    shell.main.append(h("h2", { class: "page-title", text: "Profile" }), notice("You are using SLAI Writer as a guest. Guests can create, edit, save and export documents on this computer; logging in adds account features.", "info"),
      h("div", { class: "actions" }, button("Log in or sign up", () => { app.go({ name: "startup" }); }, "primary", "log-in")));
    return { el: shell.el, destroy: shell.dispose };
  }
  const host = h("div", { class: "profile" });
  const refresh = async (): Promise<void> => { await app.refresh(); paint(); };

  const paint = (): void => {
    const a: AccountPublic = app.account ?? account;
    clear(host);
    host.append(
      section("Account", h("dl", { class: "facts" }, h("dt", { text: "Username" }), h("dd", { text: a.username }), h("dt", { text: "Email" }), h("dd", { text: a.email }), h("dt", { text: "Created" }), h("dd", { text: when(a.created) }),
        h("dt", { text: "Plan" }), h("dd", { text: `${a.plan[0]?.toUpperCase()}${a.plan.slice(1)}${a.planSource === "none" ? " (no purchase)" : ""}` })),
        h("div", { class: "actions" }, button("Plans & Pricing", () => { app.go({ name: "plans" }); }, "", "tag"), button("Sign out", () => app.signOut(), "", "log-out"))));

    const mfa: HTMLElement[] = [h("p", {}, statusBadge(a.twoFactor ? "Two-factor is on" : "Two-factor is off", a.twoFactor ? "ok" : "warn"), a.twoFactor ? ` ${a.recoveryCodesLeft} recovery code${a.recoveryCodesLeft === 1 ? "" : "s"} left.` : " Turn it on to protect this account with an authenticator app.")];
    if (a.mfaResetAt) mfa.push(notice(h("span", {}, `A recovery of your authenticator is pending until ${when(a.mfaResetAt)}. If you did not start it, cancel it now. `, button("Cancel recovery", async () => { await api.post("/account/mfa-recovery/cancel", {}); toast("Recovery cancelled.", { kind: "ok" }); await refresh(); }, "danger")), "warn", "Recovery pending."));
    if (!a.twoFactor) mfa.push(h("div", { class: "actions" }, button("Set up an authenticator", () => { app.go({ name: "enroll" }); }, "primary", "shield")));
    else {
      mfa.push(h("div", { class: "actions" },
        button("Regenerate recovery codes", () => { reauth("Regenerate recovery codes", "The old codes stop working. Enter your password and a current authenticator code.", true, "Regenerate", async (password, code) => {
          const out = await api.post<{ recoveryCodes: string[] }>("/account/recovery-codes", { password, code });
          openDialog({ title: "New recovery codes", size: "narrow", noCancel: true, body: recoveryCodesBlock(out.recoveryCodes, a.username), actions: [{ label: "I saved them", kind: "primary", run: () => true }] });
          await refresh();
        }); }, "", "refresh"),
        button("Turn off two-factor", () => { reauth("Turn off two-factor", "This makes the account easier to break into. Enter your password and a current code.", true, "Turn off", async (password, code) => {
          await api.post("/account/2fa/disable", { password, code }); toast("Two-factor is off.", { kind: "ok" }); await refresh();
        }); }, "danger")));
    }
    host.append(section("Two-factor authentication", ...mfa));

    const cur = textField("Current password", { type: "password", autocomplete: "current-password", maxLength: 300 });
    const next = textField("New password", { type: "password", autocomplete: "new-password", maxLength: 300, hint: "At least 10 characters; not a common password." });
    const code = textField("Authenticator code", { maxLength: 40 });
    code.root.hidden = !a.twoFactor;
    const err = errorLine();
    host.append(section("Password", cur.root, next.root, code.root, err.el, h("div", { class: "actions" }, button("Change password", async () => {
      err.show(null);
      try { await api.post("/account/password", { current: cur.input.value, new: next.input.value, code: code.input.value.trim() }); cur.input.value = ""; next.input.value = ""; code.input.value = ""; toast("Password changed. Your other sessions were signed out.", { kind: "ok" }); await loadSessions(); }
      catch (e) { err.show(errorText(e)); }
    }, "primary"))));

    host.append(section("Sessions and trusted devices", sessionsHost));
    void loadSessions();
  };

  const sessionsHost = h("div", {});
  const loadSessions = async (): Promise<void> => {
    const data = await api.get<{ sessions: SessionRow[]; devices: DeviceRow[] }>("/account/sessions");
    clear(sessionsHost);
    sessionsHost.append(h("h3", { text: "Sessions" }), h("ul", { class: "formats" }, data.sessions.map((s) => {
      const revoke = h("button", { class: "btn small", type: "button", text: s.current ? "Sign out here" : "Sign out" });
      revoke.addEventListener("click", () => { void run(revoke, async () => { await api.del(`/account/sessions/${s.id}`); if (s.current) { await app.refresh(); app.go({ name: "startup" }); } else await loadSessions(); }); });
      return h("li", {}, h("span", { class: "grow" }, h("strong", { text: s.label || "Browser" }), s.current ? statusBadge("This session", "ok") : null, ` last active ${when(s.lastSeen)} · ${s.remember ? "remembered" : "until you close it"}`), revoke);
    })));
    sessionsHost.append(h("h3", { text: "Trusted devices" }));
    if (!data.devices.length) sessionsHost.append(h("p", { class: "muted", text: "No trusted devices. Trust lasts 30 days when you tick “Remember this device” at the second step; new devices, expired trust and unusual activity always ask again." }));
    else sessionsHost.append(h("ul", { class: "formats" }, data.devices.map((d) => {
      const revoke = h("button", { class: "btn small danger", type: "button", text: "Revoke trust" });
      revoke.addEventListener("click", () => { void run(revoke, async () => { if (!await confirmDialog({ title: "Revoke this device?", message: "It will ask for an authenticator code next time.", confirmLabel: "Revoke", danger: true })) return; await api.del(`/account/devices/${d.id}`); await loadSessions(); }); });
      return h("li", {}, h("span", { class: "grow" }, h("strong", { text: d.label || "Device" }), ` trusted until ${when(d.expires)} · last used ${when(d.lastUsed)}`), revoke);
    })));
  };

  shell.main.append(h("h2", { class: "page-title", text: "Profile" }), host);
  paint();
  return { el: shell.el, destroy: shell.dispose };
}
