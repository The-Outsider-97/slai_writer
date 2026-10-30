/** Start-up: register the screens, ask the server who we are, and show the first page. */
import { App } from "./app.js";
import { registerWriterGlyphs } from "./icons.js";
import { errorText } from "./net.js";
import { enrollScreen, recoverScreen, resetScreen, startupScreen, twofaScreen, verifyScreen } from "./screens/auth.js";
import { docScreen } from "./screens/doc.js";
import { helpScreen } from "./screens/help.js";
import { homeScreen } from "./screens/home.js";
import { newDocScreen } from "./screens/newdoc.js";
import { plansScreen } from "./screens/plans.js";
import { profileScreen } from "./screens/profile.js";
import { settingsScreen } from "./screens/settings.js";
import { signaturesScreen } from "./screens/signatures.js";
import { signScreen, verifyScreen as verifySignatureScreen } from "./screens/signing.js";
import { versionsScreen } from "./screens/versions.js";
import { h } from "./kit.js";

registerWriterGlyphs();

const root = document.getElementById("app");
if (!root) throw new Error("The page has no #app element.");
const app = new App(root);

app.register("startup", (a) => startupScreen(a), "bare");
app.register("verify", (a) => verifyScreen(a), "bare");
app.register("twofa", (a) => twofaScreen(a), "bare");
app.register("enroll", (a) => enrollScreen(a), "bare");
app.register("reset", (a) => resetScreen(a), "bare");
app.register("recover", (a) => recoverScreen(a), "bare");
app.register("home", (a) => homeScreen(a), "shell");
app.register("new", (a) => newDocScreen(a), "shell");
app.register("settings", (a) => settingsScreen(a), "shell");
app.register("plans", (a) => plansScreen(a), "shell");
app.register("signatures", (a) => signaturesScreen(a), "shell");
app.register("profile", (a) => profileScreen(a), "shell");
app.register("help", (a) => helpScreen(a), "shell");
app.register("versions", (a, r) => versionsScreen(a, r), "shell");
app.register("verify-signature", (a, r) => verifySignatureScreen(a, r), "shell");
app.register("sign", (a, r) => signScreen(a, r), "shell");
app.register("doc", (a, r) => docScreen(a, r), "own");

window.addEventListener("beforeunload", (event) => {
  if ([...app.docs.values()].some((d) => d.dirty)) { event.preventDefault(); }
});

app.start().catch((error: unknown) => {
  root.replaceChildren(h("main", { class: "auth", id: "main" }, h("div", { class: "auth-card" }, h("h1", { text: "SLAI Writer could not start" }),
    h("p", { text: errorText(error) }), h("p", { class: "muted", text: "Check that the SLAI Writer server is running on this computer, then reload this page." }),
    h("button", { class: "btn primary", type: "button", text: "Reload", on: { click: () => window.location.reload() } }))));
});
