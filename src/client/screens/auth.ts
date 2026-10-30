/** Start-up, sign-up e-mail verification, authenticator code, enrolment, password reset and lost-authenticator recovery. */
import type { App, Screen } from "../app.js";
import { api, errorText } from "../net.js";
import { announce, ApiError, h, labelled, saveBlob } from "../kit.js";
import type { AccountPublic, PlanInfo } from "../types.js";
import { statusDots, themeToggle } from "../shell.js";
import { button, checkbox, errorLine, notice, run, textField } from "../widgets.js";
import { countdown } from "../widgets.js";

/* ------------------------------------------------------------------------------------------ segmented code input */
export interface CodeInput { el: HTMLElement; value(): string; clear(): void; focus(): void; onComplete(fn: (code: string) => void): void }

/** One cell per character. Typing moves on, Backspace moves back, arrows move, and pasting spreads the text over the cells. */
export function codeInput(length: number, label: string, digitsOnly: boolean): CodeInput {
  const cells: HTMLInputElement[] = [];
  let complete: ((code: string) => void) | null = null;
  const group = h("div", { class: `code-cells${length > 10 ? " long" : ""}`, attrs: { role: "group", "aria-label": label } });
  const read = (): string => cells.map((c) => c.value).join("");
  const settle = (): void => { if (read().length === length) complete?.(read()); };
  const clean = (text: string): string => (digitsOnly ? text.replace(/\D/g, "") : text.replace(/\s/g, ""));
  const spread = (from: number, text: string): void => {
    const chars = [...clean(text)];
    let i = from;
    for (const ch of chars) { const cell = cells[i]; if (!cell) break; cell.value = ch; i += 1; }
    cells[Math.min(i, length - 1)]?.focus();
    settle();
  };
  for (let i = 0; i < length; i += 1) {
    const cell = h("input", {
      type: "text", maxLength: 2, class: "code-cell",
      attrs: { "aria-label": `${label}, character ${i + 1} of ${length}`, autocomplete: i === 0 ? "one-time-code" : "off", inputmode: digitsOnly ? "numeric" : "text", spellcheck: "false", autocapitalize: "off" },
    });
    cell.addEventListener("input", () => {
      const v = clean(cell.value);
      if (v.length > 1) { cell.value = ""; spread(i, v); return; }
      cell.value = v;
      if (v && i < length - 1) cells[i + 1]?.focus();
      settle();
    });
    cell.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !cell.value && i > 0) { cells[i - 1]?.focus(); }
      else if (e.key === "ArrowLeft" && i > 0) { e.preventDefault(); cells[i - 1]?.focus(); }
      else if (e.key === "ArrowRight" && i < length - 1) { e.preventDefault(); cells[i + 1]?.focus(); }
      else if (e.key === "Enter") settle();
    });
    cell.addEventListener("paste", (e) => { e.preventDefault(); spread(i, e.clipboardData?.getData("text") ?? ""); });
    cell.addEventListener("focus", () => cell.select());
    cells.push(cell);
    group.appendChild(cell);
  }
  return {
    el: group, value: read, focus: () => cells[0]?.focus(),
    clear: () => { for (const c of cells) c.value = ""; cells[0]?.focus(); },
    onComplete: (fn) => { complete = fn; },
  };
}

function card(...children: Array<Node | null>): HTMLElement {
  return h("main", { class: "auth", id: "main", attrs: { tabindex: "-1" } }, h("div", { class: "auth-card" }, h("img", { class: "auth-logo", attrs: { src: "/assets/slai_writer.png", alt: "SLAI Writer" } }), ...children));
}

function titleBar(app: App): HTMLElement {
  return h("header", { class: "titlebar bare" }, h("span", { class: "title", text: "SLAI Writer" }), h("span", { class: "grow" }), themeToggle(app));
}
function frame(app: App, body: HTMLElement, footer?: HTMLElement): Screen {
  return { el: h("div", { class: "shell bare-shell auth-shell" }, titleBar(app), body, h("footer", { class: "statusbar" }, footer ?? statusDots(app, {}, true))), focus: () => { body.focus(); } };
}

/* ------------------------------------------------------------------------------------------------- start-up */
export function startupScreen(app: App): Screen {
  const username = textField("Username", { autocomplete: "username", maxLength: 64, placeholder: "Username" });
  const password = textField("Password", { type: "password", autocomplete: "current-password", maxLength: 300, placeholder: "Password" });
  const email = textField("Email (needed for Signup only)", { type: "email", autocomplete: "email", maxLength: 320, placeholder: "Email" });
  const remember = checkbox("Remember me", false);
  const error = errorLine();
  const email_ok = app.boot.capabilities.email;

  const login = async (): Promise<void> => {
    error.show(null);
    const identifier = username.input.value.trim() || email.input.value.trim();
    if (!identifier || !password.input.value) { error.show("Enter your username (or email) and your password."); return; }
    try {
      const out = await api.post<{ needs?: string; challenge?: string; expiresIn?: number; reason?: string; account?: AccountPublic; notice?: string | null; next?: string }>(
        "/account/login", { identifier, password: password.input.value, remember: remember.input.checked });
      password.input.value = "";
      if (out.needs === "totp" && out.challenge) {
        Object.assign(app.auth, { challenge: out.challenge, reason: out.reason ?? "", challengeExpires: Date.now() + (out.expiresIn ?? 600) * 1000, restart: false });
        app.go({ name: "twofa" });
        return;
      }
      if (out.account) { if (out.notice) window.setTimeout(() => announce(out.notice ?? ""), 800); await app.signedInAs(out.account, "home"); }
    } catch (e) { error.show(errorText(e)); }
  };
  const signup = async (): Promise<void> => {
    error.show(null);
    if (!username.input.value.trim() || !email.input.value.trim() || !password.input.value) { error.show("Signup needs a username, an email address and a password."); return; }
    try {
      const out = await api.post<{ email: string; expiresIn: number; resendIn: number; codeLength: number }>("/account/signup", { username: username.input.value.trim(), email: email.input.value.trim(), password: password.input.value });
      Object.assign(app.auth, { email: email.input.value.trim(), maskedEmail: out.email, expiresAt: Date.now() + out.expiresIn * 1000, resendAt: Date.now() + out.resendIn * 1000, codeLength: out.codeLength, fromSignup: true });
      password.input.value = "";
      app.go({ name: "verify" });
    } catch (e) { error.show(errorText(e)); }
  };

  const form = h("form", { class: "auth-form startup", attrs: { novalidate: true } },
    field("user", username.root), field("key", password.root), field("mail", email.root),
    h("div", { class: "auth-row" }, remember.root, h("button", { class: "linkbtn", type: "button", text: "Forgot password?", on: { click: () => app.go({ name: "reset" }) } })),
    h("div", { class: "auth-buttons" }, button("Login", login, "primary"), button("Signup", signup, "primary")),
    error.el,
    h("p", { class: "fine", text: "Password + authenticator code when verification is required" }),
  );
  form.addEventListener("submit", (e) => { e.preventDefault(); });
  form.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT" && !(e.target as HTMLInputElement).matches("[type=checkbox]")) { e.preventDefault(); void run(form, login); } });

  const signatureBox = h("div", { class: "signature-box" },
    h("strong", { text: "Signature" }),
    h("p", { class: "fine", text: "Optional. A signature graphic is a visible mark, not a credential: you never need one to log in or sign up." }),
    h("button", { class: "linkbtn upload-sig", type: "button", on: { click: () => app.go({ name: "signatures" }) } }, h("span", { class: "clip", attrs: { "aria-hidden": "true" } }), "Upload signature(s)"));
  const guest = h("button", { class: "linkbtn guest", type: "button", text: "Continue as a guest", on: { click: () => app.continueAsGuest() } });
  const notes = h("div", { class: "auth-notes" },
    h("p", { class: "fine", text: "A guest can create, edit, save, reopen and export documents on this computer without an account. Some features are limited. Logging in does not unlock everything: paid features need a plan." }),
    !email_ok.configured ? notice(`${email_ok.reason ?? "E-mail delivery is not set up."} Signup and password reset send you an e-mail, so they are unavailable until it is. Login and guest use are not affected.`, "warn", "E-mail is not configured.") : null);
  return frame(app, card(form, signatureBox, guest, notes));
}

/** One row of the start-up form as drawn on page 1: the design's dark icon tile, then the light field with its name inside it. */
function field(icon: string, control: HTMLElement): HTMLElement {
  const tile = icon === "mail" ? "auth-mail" : icon === "key" ? "auth-key" : "auth-user";
  return h("div", { class: "auth-field" }, h("img", { class: "auth-tile", attrs: { src: `/assets/${tile}.png`, alt: "", "aria-hidden": "true" } }), control);
}

/* ------------------------------------------------------------------------------------------ e-mail verification */
export function verifyScreen(app: App): Screen {
  const flow = app.auth;
  if (!flow.email) { queueMicrotask(() => app.go({ name: "startup" }, true)); return { el: h("div") }; }
  const length = flow.codeLength ?? 25;
  const input = codeInput(length, "Verification code", false);
  const error = errorLine();
  const clock = h("strong", { class: "clock" });
  const resend = h("button", { class: "btn", type: "button", text: "Resend code" });
  let stop = (): void => undefined;
  const expired = h("p", { class: "form-error", hidden: true, text: "The code has expired. Ask for a new one." });
  stop = countdown(clock, flow.expiresAt ?? Date.now(), () => { expired.hidden = false; });
  const gate = (): void => { if (resend.getAttribute("aria-busy") === "true") return; const left = (flow.resendAt ?? 0) - Date.now(); resend.disabled = left > 0; resend.textContent = left > 0 ? `Resend code (${Math.ceil(left / 1000)}s)` : "Resend code"; };
  const gateTimer = window.setInterval(gate, 1000); gate();
  const submit = async (): Promise<void> => {
    error.show(null);
    const code = input.value();
    if (code.length !== length) { error.show(`Enter all ${length} characters of the code.`); return; }
    try {
      const out = await api.post<{ account: AccountPublic }>("/account/signup/verify", { email: flow.email, code });
      flow.fromSignup = true;
      await app.signedInAs(out.account, "enroll");
    } catch (e) { error.show(errorText(e)); input.clear(); }
  };
  input.onComplete(() => { void submit(); });
  resend.addEventListener("click", () => {
    void run(resend, async () => {
      error.show(null);
      try {
        const out = await api.post<{ email: string; expiresIn: number; resendIn: number }>("/account/signup/resend", { email: flow.email });
        flow.expiresAt = Date.now() + out.expiresIn * 1000; flow.resendAt = Date.now() + out.resendIn * 1000;
        stop(); expired.hidden = true; stop = countdown(clock, flow.expiresAt, () => { expired.hidden = false; });
        input.clear(); gate();
        announce("A new code was sent. The earlier code no longer works.");
      } catch (e) { error.show(errorText(e)); }
    });
  });
  const changeEmail = h("button", { class: "linkbtn", type: "button", text: "Change email address / start again", on: { click: () => { void api.post("/account/signup/cancel", { email: flow.email }).catch(() => undefined).finally(() => { app.auth.email = undefined; app.go({ name: "startup" }); }); } } });
  const body = card(
    h("h2", { text: "Verify your email address" }),
    h("p", { text: `Enter the ${length}-character code sent to ${flow.maskedEmail ?? "your email address"}. This confirms that the address is yours. The code works once.` }),
    input.el,
    h("p", { class: "fine" }, "Code expires in ", clock),
    expired, error.el,
    h("div", { class: "auth-buttons" }, button("Verify email", submit, "primary")),
    h("div", { class: "auth-buttons" }, resend),
    h("p", { class: "fine", text: "A new code makes the earlier one stop working." }),
    changeEmail);
  const screen = frame(app, body);
  screen.destroy = () => { stop(); window.clearInterval(gateTimer); };
  screen.focus = () => input.focus();
  return screen;
}

/* ----------------------------------------------------------------------------------------- authenticator code */
export function twofaScreen(app: App): Screen {
  const flow = app.auth;
  if (!flow.challenge) { queueMicrotask(() => app.go({ name: "startup" }, true)); return { el: h("div") }; }
  const input = codeInput(6, "Authenticator code", true);
  const trust = checkbox("Remember this device for 30 days", false);
  const error = errorLine();
  const recovery = textField("Recovery code", { maxLength: 40, hint: "Each recovery code works once." });
  recovery.root.hidden = true;
  let useRecovery = false;
  const reasonText = flow.reason === "suspicious activity" ? "We saw unusual sign-in activity, so we need a second check." : "This looks like a new device, or its trust has expired.";
  const fail = (e: unknown): void => {
    error.show(errorText(e));
    if (e instanceof ApiError && (e.details as { restart?: boolean } | undefined)?.restart) { flow.challenge = undefined; window.setTimeout(() => app.go({ name: "startup" }), 1800); }
  };
  const submit = async (): Promise<void> => {
    error.show(null);
    try {
      const out = useRecovery
        ? await api.post<{ account: AccountPublic }>("/account/login/recovery-code", { challenge: flow.challenge, code: recovery.input.value.trim() })
        : await api.post<{ account: AccountPublic }>("/account/login/code", { challenge: flow.challenge, code: input.value(), trustDevice: trust.input.checked });
      flow.challenge = undefined;
      await app.signedInAs(out.account, "home");
    } catch (e) { fail(e); input.clear(); }
  };
  input.onComplete(() => { if (!useRecovery) void submit(); });
  const toggle = h("button", { class: "linkbtn", type: "button", text: "Use a recovery code" });
  toggle.addEventListener("click", () => {
    useRecovery = !useRecovery;
    input.el.hidden = useRecovery; trust.root.hidden = useRecovery; recovery.root.hidden = !useRecovery;
    toggle.textContent = useRecovery ? "Use the authenticator code instead" : "Use a recovery code";
    (useRecovery ? recovery.input : { focus: () => input.focus() }).focus();
  });
  const body = card(
    h("h2", { text: "Two-factor verification" }),
    h("p", { text: "Enter the current six-digit code from your authenticator app. The code comes from the app, not from an email. It changes about every 30 seconds." }),
    h("p", { class: "fine", text: reasonText }),
    input.el, recovery.root, trust.root, error.el,
    h("div", { class: "auth-buttons" }, button("Verify and continue", submit, "primary")),
    toggle,
    h("button", { class: "linkbtn", type: "button", text: "Lost authenticator? Start secure recovery", on: { click: () => app.go({ name: "recover" }) } }),
    h("button", { class: "linkbtn", type: "button", text: "Back to login", on: { click: () => { flow.challenge = undefined; app.go({ name: "startup" }); } } }));
  const screen = frame(app, body);
  screen.focus = () => input.focus();
  return screen;
}

/* ------------------------------------------------------------------------------------------------- enrolment */
export function recoveryCodesBlock(codes: string[], name: string): HTMLElement {
  const list = h("ul", { class: "recovery-codes" }, codes.map((c) => h("li", {}, h("code", { text: c }))));
  const text = `SLAI Writer recovery codes\nEach code works once. Keep them somewhere other than this computer.\n\n${codes.join("\n")}\n`;
  return h("div", { class: "recovery-block" },
    notice("These codes are shown only now. Save or print them and keep them away from your devices. Each one works once.", "warn", "Save these codes."),
    list,
    h("div", { class: "auth-buttons" },
      button("Save recovery codes", () => { saveBlob(new Blob([text], { type: "text/plain" }), `${name}-recovery-codes.txt`); }, "primary", "download"),
      button("Print", () => { window.print(); }, "", "print")));
}

export function enrollScreen(app: App): Screen {
  if (!app.account) { queueMicrotask(() => app.go({ name: "startup" }, true)); return { el: h("div") }; }
  const account = app.account;
  const stage = h("div", {});
  const password = textField("Confirm your password to continue", { type: "password", autocomplete: "current-password", maxLength: 300 });
  const error = errorLine();
  const done = (): void => { void app.refresh().then(() => app.go({ name: "home" })); };
  const start = async (): Promise<void> => {
    error.show(null);
    try {
      const setup = await api.post<{ setupKey: string; uri: string; qr: string | null; qrAvailable: boolean }>("/account/2fa/begin", { password: password.input.value });
      password.input.value = "";
      showSetup(setup);
    } catch (e) { error.show(errorText(e)); }
  };
  const showSetup = (setup: { setupKey: string; uri: string; qr: string | null; qrAvailable: boolean }): void => {
    const code = codeInput(6, "Authenticator code", true);
    const err = errorLine();
    const confirm = async (): Promise<void> => {
      err.show(null);
      try {
        const out = await api.post<{ recoveryCodes: string[] }>("/account/2fa/confirm", { code: code.value() });
        stage.replaceChildren(h("h3", { text: "Two-factor authentication is on" }), recoveryCodesBlock(out.recoveryCodes, account.username), h("div", { class: "auth-buttons" }, button("I saved them — continue", () => { done(); }, "primary")));
      } catch (e) { err.show(errorText(e)); code.clear(); }
    };
    code.onComplete(() => { void confirm(); });
    stage.replaceChildren(
      h("ol", { class: "steps" }, h("li", { text: "Open your authenticator app and choose to add an account." }), h("li", { text: "Scan the QR code, or enter the setup key by hand." }), h("li", { text: "Type the six-digit code the app shows, to confirm." })),
      setup.qr ? h("img", { class: "qr", attrs: { src: setup.qr, alt: "QR code for your authenticator app" } }) : notice("The QR code could not be drawn here. Use the setup key below.", "warn"),
      h("p", { class: "fine" }, "Setup key: ", h("code", { class: "setup-key", text: setup.setupKey })),
      h("p", { class: "fine", text: "The key and QR code are shown only in this setup session. Do not share or photograph them." }),
      code.el, err.el, h("div", { class: "auth-buttons" }, button("Enable 2FA", confirm, "primary")));
    code.focus();
  };
  stage.append(
    h("p", { text: "Enrol an authenticator app, and keep your recovery codes separately from your devices. You can also do this later in Profile." }),
    password.root, error.el,
    h("div", { class: "auth-buttons" }, button("Start setup", start, "primary"), button("Do this later", () => { done(); })));
  const body = card(h("h2", { text: "Set up account security" }), stage);
  const screen = frame(app, body);
  screen.focus = () => password.input.focus();
  return screen;
}

/* ---------------------------------------------------------------------------------------------- password reset */
export function resetScreen(app: App): Screen {
  const email = textField("Email address", { type: "email", autocomplete: "email", maxLength: 320 });
  const error = errorLine();
  const stage = h("div", {});
  let needsFactor = false;
  const step2 = (address: string): void => {
    const code = textField("Code from the email", { maxLength: 100, hint: "25 characters; works once." });
    const pw = textField("New password", { type: "password", autocomplete: "new-password", maxLength: 300 });
    const factor = textField("Authenticator or recovery code", { maxLength: 40, hint: "Required when the account uses two-factor authentication." });
    factor.root.hidden = !needsFactor;
    const err = errorLine();
    const finish = async (): Promise<void> => {
      err.show(null);
      try {
        await api.post("/account/reset/complete", { email: address, code: code.input.value.trim(), password: pw.input.value, factor: factor.input.value.trim() });
        app.go({ name: "startup" });
        window.setTimeout(() => announce("Your password was reset. Log in with the new password."), 500);
      } catch (e) {
        if (e instanceof ApiError && (e.details as { needsFactor?: boolean } | undefined)?.needsFactor) { needsFactor = true; factor.root.hidden = false; }
        err.show(errorText(e));
      }
    };
    stage.replaceChildren(
      notice("If that address has an account, a code was sent to it. Nothing here confirms whether it does.", "info"),
      code.root, pw.root, factor.root, err.el,
      h("div", { class: "auth-buttons" }, button("Reset password", finish, "primary")));
    code.input.focus();
  };
  const send = async (): Promise<void> => {
    error.show(null);
    try { await api.post("/account/reset", { email: email.input.value.trim() }); step2(email.input.value.trim()); }
    catch (e) { error.show(errorText(e)); }
  };
  stage.append(h("p", { text: "Enter your account's email address. We will send a one-time code." }), email.root, error.el, h("div", { class: "auth-buttons" }, button("Send code", send, "primary")));
  const body = card(h("h2", { text: "Reset your password" }), stage, h("button", { class: "linkbtn", type: "button", text: "Back to login", on: { click: () => app.go({ name: "startup" }) } }));
  const screen = frame(app, body);
  screen.focus = () => email.input.focus();
  return screen;
}

/* ---------------------------------------------------------------------------------- lost authenticator recovery */
export function recoverScreen(app: App): Screen {
  const email = textField("Email address", { type: "email", autocomplete: "email", maxLength: 320 });
  const password = textField("Password", { type: "password", autocomplete: "current-password", maxLength: 300 });
  const error = errorLine();
  const stage = h("div", {});
  const confirmStep = (address: string): void => {
    const code = textField("Code from the email", { maxLength: 100 });
    const err = errorLine();
    stage.replaceChildren(
      notice("If those details match an account with two-factor authentication, a code was sent. Nothing here confirms that it did.", "info"),
      code.root, err.el,
      h("div", { class: "auth-buttons" }, button("Start the waiting period", async () => {
        err.show(null);
        try {
          const out = await api.post<{ message?: string; until?: string }>("/account/mfa-recovery/confirm", { email: address, code: code.input.value.trim() });
          stage.replaceChildren(notice(out.message ?? "Recovery started. Two-factor authentication will be removed after the waiting period, and we have e-mailed you. Log in again after that and set it up again. If this was not you, log in and cancel it in Profile.", "ok", "Recovery started."),
            h("div", { class: "auth-buttons" }, button("Back to login", () => { app.go({ name: "startup" }); }, "primary")));
        } catch (e) { err.show(errorText(e)); }
      }, "primary")));
  };
  stage.append(
    h("p", { text: "Lost your authenticator? Prove your password and your email. For your safety, two-factor authentication is then removed only after a waiting period, and you are notified. An email check alone never skips two-factor." }),
    email.root, password.root, error.el,
    h("div", { class: "auth-buttons" }, button("Send confirmation code", async () => {
      error.show(null);
      try { await api.post("/account/mfa-recovery", { email: email.input.value.trim(), password: password.input.value }); password.input.value = ""; confirmStep(email.input.value.trim()); }
      catch (e) { error.show(errorText(e)); }
    }, "primary")));
  const body = card(h("h2", { text: "Secure recovery" }), stage, h("button", { class: "linkbtn", type: "button", text: "Back to login", on: { click: () => app.go({ name: "startup" }) } }));
  const screen = frame(app, body);
  screen.focus = () => email.input.focus();
  return screen;
}

void labelled; void ({} as PlanInfo);
