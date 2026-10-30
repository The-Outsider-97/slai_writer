import { api, errorText } from "../net.js";
import { buildShell } from "../shell.js";
import { clear, confirmDialog, glyph, h, labelled, openDialog, promptDialog, toast } from "../kit.js";
import { button, errorLine, notice, selectField, statusBadge, textField, when } from "../widgets.js";
const PURPOSE_LABEL = { approval: "Approval", authorship: "Authorship", review: "Review", witness: "Witness" };
export async function signScreen(app, route) {
    const sid = route.sid ?? "";
    const shell = buildShell(app, "versions", { title: "SLAI Writer" });
    const doc = await api.get(`/docs/${encodeURIComponent(sid)}`);
    const stage = h("div", {});
    const error = errorLine();
    let preview = await api.get(`/docs/${encodeURIComponent(sid)}/sign`);
    const paint = () => {
        clear(stage);
        const rows = [
            ["Document", `${doc.name}.sldc`], ...preview.items.filter((i) => i.label !== "Document"),
            ["Signer", app.account ? `${app.account.username} (account verified)` : "Guest profile on this computer (no account identity)"],
            ["Key", preview.key.exists ? `Protected local signing key / fingerprint ${(preview.key.keyId ?? "").slice(0, 8)}…` : "No signing key yet"],
            ["Covered content", "Text, assets, styles, EMBED outputs and metadata"],
        ];
        stage.appendChild(h("table", { class: "docs evidence" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Signing item" }), h("th", { scope: "col", text: "Selected value" }))), h("tbody", {}, rows.map(([a, b]) => h("tr", {}, h("th", { scope: "row", text: a }), h("td", { text: b }))))));
        if (preview.unsaved)
            stage.appendChild(notice("This document has unsaved changes. Signing flushes them into the revision shown above and saves the file when it has a place on disk.", "info"));
        if (preview.alreadySigned)
            stage.appendChild(notice("This document already carries a signature. Signing adds another signer to the same revision when it has not changed.", "info"));
        if (!preview.key.exists) {
            const label = textField("Key label", { value: "My signing key", maxLength: 60 });
            const pass = textField("Signing passphrase", { type: "password", autocomplete: "new-password", maxLength: 500, hint: "It protects your private key on this computer and cannot be recovered. Keep it safe." });
            const pass2 = textField("Repeat the passphrase", { type: "password", autocomplete: "new-password", maxLength: 500 });
            stage.append(h("h3", { text: "Create your signing key" }), label.root, pass.root, pass2.root, h("div", { class: "actions" }, button("Create signing key", async () => {
                error.show(null);
                if (pass.input.value !== pass2.input.value) {
                    error.show("The two passphrases are different.");
                    return;
                }
                try {
                    await api.post("/signing/key", { label: label.input.value, passphrase: pass.input.value });
                    preview = await api.get(`/docs/${encodeURIComponent(sid)}/sign`);
                    paint();
                    toast("Signing key created.", { kind: "ok" });
                }
                catch (e) {
                    error.show(errorText(e));
                }
            }, "primary", "key")));
            return;
        }
        const purpose = selectField("Purpose", preview.purposes.map((p) => [p, PURPOSE_LABEL[p] ?? p]), "approval");
        const statement = textField("Statement (optional)", { maxLength: 500, hint: "Signed together with the revision, for example “Approved for publication”." });
        const pass = textField("Signing passphrase", { type: "password", autocomplete: "current-password", maxLength: 500 });
        stage.append(purpose.root, statement.root, pass.root, error.el, notice(preview.note + " Signing is not a claim that the content is true, and it does not meet any regulated trust-service profile.", "info"), h("div", { class: "actions" }, button(`Sign revision ${preview.revisionNumber}`, async () => {
            error.show(null);
            if (!pass.input.value) {
                error.show("Enter your signing passphrase.");
                return;
            }
            try {
                await api.post(`/docs/${encodeURIComponent(sid)}/sign`, { passphrase: pass.input.value, purpose: purpose.select.value, statement: statement.input.value, expectedRevision: preview.revisionId });
                pass.input.value = "";
                toast("The revision is signed. The draft is left unsigned from now on if you keep editing.", { kind: "ok" });
                app.go({ name: "verify-signature", sid });
            }
            catch (e) {
                error.show(errorText(e));
                pass.input.value = "";
            }
        }, "primary", "pen"), button("Cancel", () => { app.go({ name: "doc", sid }); })));
    };
    stage.setAttribute("aria-live", "polite");
    shell.main.append(h("h2", { class: "page-title", text: "Sign document revision" }), h("p", { class: "muted", text: "Only the selected revision is signed. Later changes are new work, not silent changes to the approved bytes. Review the exact frozen state before you approve." }), stage);
    paint();
    return { el: shell.el, destroy: shell.dispose };
}
function stateLabel(r) {
    switch (r.state) {
        case "valid_trusted": return { text: "Valid", tone: "ok" };
        case "valid_unknown_signer": return { text: "Valid (signer not known to you)", tone: "warn" };
        case "valid_revoked": return { text: "Valid, but the key was revoked", tone: "danger" };
        case "modified": return { text: "Document changed after signing", tone: "warn" };
        case "invalid": return { text: "Invalid: the signed bytes were altered", tone: "danger" };
        default: return { text: "Indeterminate: this cannot be checked here", tone: "idle" };
    }
}
export async function verifyScreen(app, route) {
    const sid = route.sid ?? "";
    const shell = buildShell(app, "versions");
    const stage = h("div", { attrs: { "aria-live": "polite" } });
    const load = async () => {
        const v = await api.get(`/docs/${encodeURIComponent(sid)}/verify`);
        clear(stage);
        const latest = v.current[0] ?? v.signedSnapshots.find((s) => s.results.length)?.results[0];
        const snap = v.signedSnapshots[0];
        const headline = { unsigned: "Unsigned", signed: "Signed", problem: "Problem found", modified_draft: "Modified draft" }[v.status];
        stage.appendChild(h("div", { class: "verify-head" }, h("span", { class: `pill ${v.status}`, text: headline }), h("span", { class: "muted", text: `Current: revision ${v.revision.number}` })));
        if (v.status === "modified_draft" && snap)
            stage.appendChild(notice(`Modified since signed revision ${snap.revisionNumber}. Revision ${v.revision.number} is unsigned. A valid signature covers revision ${snap.revisionNumber}; it does not sign the current draft.`, "warn"));
        else if (v.status === "unsigned")
            stage.appendChild(notice("This document and its saved versions carry no signature. Verification stays available without a paid plan.", "info"));
        else if (v.status === "problem")
            stage.appendChild(notice("A signature on this document does not verify. See the table for which part failed. Tampering is invalid; missing evidence is indeterminate.", "danger"));
        else
            stage.appendChild(notice(`Signed. The signature covers revision ${v.revision.number}.`, "ok"));
        if (latest) {
            const st = stateLabel(latest);
            const signedRev = v.status === "signed" ? v.revision.number : snap?.revisionNumber ?? v.revision.number;
            const total = v.current.length || snap?.results.length || 0;
            const rows = [
                ["Signed snapshot", `Revision ${signedRev} / ${v.status === "signed" ? "current draft" : "original bytes retained"}`],
                ["Covered bytes", h("span", {}, statusBadge(st.text, st.tone), latest.covers_current_content ? " no covered-content changes" : latest.signature_valid ? ` valid for revision ${signedRev}; the draft has changed` : "")],
                ["Signer identity", latest.signerLabel ? `Key recognised locally as “${latest.signerLabel}”; external trust not asserted` : `Unknown key (fingerprint ${latest.signerFingerprint?.slice(0, 16) ?? latest.key_id.slice(0, 16)}…). No identity is asserted.`],
                ["Trust", latest.trust === "trusted" ? "Trusted by you" : latest.trust === "revoked" ? "Revoked" : "Unknown: this is not a verified human identity"],
                ["Timestamp", `Signer's own claim${latest.signedAtClaimed ? `: ${when(latest.signedAtClaimed)}` : ""}. Trusted timestamp not attached.`],
                ["Additional signatures", total > 1 ? `${total - 1} more signer${total > 2 ? "s" : ""}` : "No additional signer yet"],
            ];
            stage.appendChild(h("table", { class: "docs evidence" }, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Evidence" }), h("th", { scope: "col", text: "Verification result" }))), h("tbody", {}, rows.map(([a, b]) => h("tr", {}, h("th", { scope: "row", text: a }), h("td", {}, b))))));
            if (!latest.signerLabel) {
                const trust = h("button", { class: "linkbtn", type: "button" }, glyph("check"), "Trust this key…");
                trust.addEventListener("click", () => {
                    void (async () => {
                        const label = await promptDialog({ title: "Trust this signing key?", label: "A name for this signer", value: "Trusted signer", maxLength: 80, confirmLabel: "Trust key" });
                        if (!label)
                            return;
                        await api.post(`/docs/${encodeURIComponent(sid)}/trust`, { signature: latest.id, label });
                        toast("Key trusted on this computer. This is your decision, not something the file can claim.", { kind: "ok" });
                        await load();
                    })().catch((e) => toast(errorText(e), { kind: "error" }));
                });
                stage.appendChild(h("p", {}, trust));
            }
        }
        const open = button("Open signed revision", async () => {
            const target = snap?.snapshot;
            if (!target) {
                toast("The signature is on the current draft; there is no separate saved revision to open.");
                return;
            }
            const state = await api.post(`/docs/${encodeURIComponent(sid)}/versions/${target}/open`, {});
            app.remember(state);
            app.go({ name: "doc", sid: state.sid });
        });
        const compare = button("Compare with draft", async () => { if (snap)
            await showCompare(sid, snap.snapshot);
        else
            toast("There is no earlier signed revision to compare with."); });
        stage.appendChild(h("div", { class: "actions" }, open, compare, button("Verify again", load)));
        stage.appendChild(h("p", { class: "fine", text: "If covered bytes are altered, verification fails for that snapshot. Unknown key trust or unavailable revocation data is reported separately. " + v.network }));
        stage.appendChild(notice(v.visualNote, "info", "Visible signature graphics:"));
    };
    shell.main.append(h("h2", { class: "page-title", text: "Verify Signature" }), h("p", { class: "muted", text: "Current draft and signed history are evaluated separately." }), stage);
    await load();
    return { el: shell.el, destroy: shell.dispose };
}
async function showCompare(sid, snapshot) {
    const c = await api.get(`/docs/${encodeURIComponent(sid)}/compare/${snapshot}`);
    const body = h("div", {});
    if (c.identical)
        body.appendChild(notice("The draft has no text or structure changes since that revision.", "ok"));
    else {
        body.appendChild(h("p", { text: `${c.counts.changed} changed, ${c.counts.added} added, ${c.counts.removed} removed since revision ${c.revisionNumber}.` }));
        const list = h("ul", { class: "diff" });
        for (const x of c.changed)
            list.appendChild(h("li", {}, h("del", { text: x.before }), " → ", h("ins", { text: x.after })));
        for (const x of c.added)
            list.appendChild(h("li", {}, h("strong", { text: "Added: " }), h("ins", { text: x.after })));
        for (const x of c.removed)
            list.appendChild(h("li", {}, h("strong", { text: "Removed: " }), h("del", { text: x.before })));
        body.appendChild(list);
    }
    openDialog({ title: `Draft compared with revision ${c.revisionNumber}`, size: "wide", noCancel: true, body, actions: [{ label: "Close", kind: "primary", run: () => true }] });
}
export { showCompare };
void labelled;
void confirmDialog;
