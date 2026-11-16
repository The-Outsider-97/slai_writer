/** The red panel: spelling and grammar marks, and the AI Assistant.
 *
 *  Enabled checks run on changed text. Grammar still needs the existing
 *  Language Agent privacy gate; no suggestion changes text until accepted. */
import { ApiError, announce, clear, h, labelled, toast } from "../kit.js";
import { api, errorText } from "../net.js";
import { button, checkbox, fill, notice, selectField, statusBadge } from "../widgets.js";
import { ProofStatus } from "../proof_status.js";
const CATEGORY = {
    spelling: { label: "Spelling", tone: "danger" }, grammar: { label: "Grammar", tone: "warn" }, agreement: { label: "Agreement", tone: "warn" }, usage: { label: "Word choice", tone: "warn" },
    punctuation: { label: "Punctuation", tone: "warn" }, capitalization: { label: "Capital letters", tone: "warn" }, style: { label: "Style", tone: "idle" },
};
const LANGUAGES = [["en", "English (either spelling)"], ["en-US", "English (US)"], ["en-GB", "English (UK)"], ["nl", "Nederlands"]];
function unavailable(error) {
    if (error instanceof ApiError && (error.code === "dependency_missing" || error.status === 503 || error.status === 403))
        return error.friendly;
    return null;
}
export function createProofPanel(ctx) {
    const { ed, app } = ctx;
    const root = h("div", { class: "stack" });
    const issuesBox = h("div", { attrs: { "aria-live": "polite" } });
    const aiBox = h("div", { attrs: { "aria-live": "polite" } });
    let issues = [];
    let checkedVersion = -1;
    let ours = false; // true while a patch is our own accepted suggestion, so its marks are kept
    let autoTimer;
    let current = -1; // the issue Next / Previous last went to
    const pendingBlocks = new Set();
    const status = new ProofStatus(); // checks that said they cannot run, and why
    const notes = new Map(); // reasons a check ran only in part (an optional provider is missing, a paragraph was in another language)
    const ignoredOnce = new Set(); // ids of findings the person dismissed; kept for this session so a recheck does not bring them back
    const sequence = { spell: 0, grammar: 0 };
    const KINDS = { spell: ["spelling"], grammar: ["grammar", "style"] };
    const marks = () => {
        for (const kind of ["spelling", "grammar", "style"]) {
            ed.decor.set(kind === "spelling" ? "typo" : kind, issues.filter((i) => i.kind === kind).map((i) => ({ block: i.block, start: i.start, end: i.end, id: i.id })));
        }
    };
    /** Blocks to check: the paragraphs the selection touches, or the whole document when nothing is selected. */
    const targets = () => {
        const sel = ed.recallSelection();
        if (!sel || sel.collapsed)
            return undefined;
        const from = ed.model.indexOf(sel.start.block), to = ed.model.indexOf(sel.end.block);
        return ed.model.order.slice(Math.min(from, to), Math.max(from, to) + 1);
    };
    const shiftAfter = (done, delta) => {
        for (const i of issues)
            if (i !== done && i.block === done.block && i.start >= done.end) {
                i.start += delta;
                i.end += delta;
            }
    };
    const ordered = () => [...issues].sort((x, y) => ed.model.indexOf(x.block) - ed.model.indexOf(y.block) || x.start - y.start);
    const accept = async (issue, replacement) => {
        try {
            ours = true;
            await ed.op({ op: "text", block: issue.block, start: issue.start, end: issue.end, insert: replacement, expect: issue.text, label: issue.kind === "spelling" ? "spelling correction" : issue.kind === "style" ? "style suggestion" : "grammar correction" });
            shiftAfter(issue, replacement.length - (issue.end - issue.start));
            issues = issues.filter((i) => i !== issue);
            marks();
            paintIssues();
            announce(`Changed “${issue.text}” to “${replacement}”.`);
        }
        catch (e) {
            toast(`${errorText(e)} Check again to refresh the marks.`, { kind: "error" });
        }
        finally {
            ours = false;
        }
    };
    const ext = () => (ed.model.meta.extensions?.["slai.writer"] ?? {});
    const ignoreAll = async (issue) => {
        try {
            if (issue.kind === "spelling") {
                const ignored = [...new Set([...(ext().spell_ignore ?? []), issue.text.toLowerCase()])].sort();
                await ed.op({ op: "ext_set", values: { spell_ignore: ignored }, label: "ignore spelling in this document" });
            }
            else {
                const rules = [...new Set([...(ext().proof_ignore ?? []), `${issue.rule ?? issue.kind}|${issue.text.toLowerCase()}`])].sort();
                await ed.op({ op: "ext_set", values: { proof_ignore: rules }, label: "ignore this suggestion in this document" });
            }
            issues = issues.filter((i) => !(i.kind === issue.kind && i.text.toLowerCase() === issue.text.toLowerCase() && (i.rule ?? "") === (issue.rule ?? "")));
            marks();
            paintIssues();
        }
        catch (error) {
            toast(errorText(error), { kind: "error" });
        }
    };
    const addToDictionary = async (issue, scope) => {
        try {
            if (scope === "user")
                await api.post(`/docs/${encodeURIComponent(ctx.sid)}/dictionary`, { word: issue.text, scope }); // kept on this computer; the document is not changed
            else
                await ed.call(() => api.post(`/docs/${encodeURIComponent(ctx.sid)}/dictionary`, { word: issue.text, scope }), (patch) => patch);
            issues = issues.filter((i) => !(i.kind === "spelling" && i.text.toLowerCase() === issue.text.toLowerCase()));
            marks();
            paintIssues();
            announce(scope === "user" ? `“${issue.text}” added to your dictionary.` : `“${issue.text}” added to this document's dictionary.`);
        }
        catch (e) {
            toast(errorText(e), { kind: "error" });
        }
    };
    const go = (delta) => {
        const list = ordered();
        if (!list.length)
            return;
        const sel = ed.recallSelection();
        let index;
        if (current >= 0 && current < list.length && !(sel && !sel.collapsed))
            index = (current + delta + list.length) % list.length;
        else if (sel) {
            const here = ed.model.indexOf(sel.start.block);
            const after = list.findIndex((i) => ed.model.indexOf(i.block) > here || (ed.model.indexOf(i.block) === here && i.start > sel.start.offset));
            index = delta > 0 ? (after < 0 ? 0 : after) : ((after < 0 ? list.length : after) - 1 + list.length) % list.length;
        }
        else
            index = delta > 0 ? 0 : list.length - 1;
        current = index;
        const issue = list[index];
        ed.scrollToBlock(issue.block, issue.start);
        paintIssues();
        announce(`${CATEGORY[issue.category]?.label ?? "Suggestion"}: “${issue.text}”. ${index + 1} of ${list.length}.`);
    };
    const paintIssues = () => {
        clear(issuesBox);
        for (const n of status.notices({ spell: app.prefs.spell, grammar: app.prefs.grammar }))
            issuesBox.appendChild(notice(n.reason, "warn", n.title));
        for (const [, reason] of notes)
            issuesBox.appendChild(notice(reason, "info"));
        if (checkedVersion < 0) {
            issuesBox.appendChild(h("p", { class: "fine", text: "Proofreading checks nearby text automatically when available. You can also check the selection or entire document using the buttons above." }));
            return;
        }
        if (checkedVersion !== ed.model.version && !ours)
            issuesBox.appendChild(notice("The text has changed since this check. Each suggestion is still verified against the current text before it is applied, but check again for a fresh list.", "info"));
        if (!issues.length) {
            issuesBox.appendChild(notice("No problems found in what was checked.", "ok"));
            return;
        }
        const list = ordered();
        const nav = h("div", { class: "actions" }, button("Previous", () => go(-1)), button("Next", () => go(1)), h("span", { class: "fine", text: `${list.length} suggestion${list.length === 1 ? "" : "s"}` }));
        issuesBox.appendChild(nav);
        const ul = h("ul", { class: "panel-list" });
        list.forEach((issue, position) => {
            const replacements = issue.suggestions.length ? issue.suggestions : issue.replacement ? [issue.replacement] : [];
            const cat = CATEGORY[issue.category] ?? CATEGORY["grammar"];
            const jump = h("button", { class: "linkbtn", type: "button", text: `“${issue.text.trim() || issue.text}”` });
            jump.addEventListener("click", () => { current = position; ed.scrollToBlock(issue.block, issue.start); paintIssues(); });
            const make = (label, run, title) => { const b = h("button", { class: "btn small", type: "button", text: label, attrs: title ? { title } : {} }); b.addEventListener("click", run); return b; };
            const accepts = replacements.slice(0, 5).map((r, n) => { const b = h("button", { class: n === 0 ? "btn small primary" : "btn small", type: "button", text: `Accept: ${r.trim() === "" ? "(space)" : r}`, disabled: ed.readOnly }); b.addEventListener("click", () => { void accept(issue, r); }); return b; });
            const li = h("li", { attrs: position === current ? { "aria-current": "true" } : {} }, h("div", {}, statusBadge(cat.label, cat.tone), " ", jump, issue.confidence !== undefined && issue.confidence < 0.75 ? h("span", { class: "fine", text: " (less certain)" }) : null), issue.message ? h("p", { text: issue.message }) : null, h("p", { class: "fine", text: `Source: ${issue.provider ?? "Writer"}, on this computer.${issue.kind === "spelling" ? " Suggestions are ranked guesses, not facts." : ""}` }), h("div", { class: "actions" }, accepts, make("Ignore once", () => { ignoredOnce.add(issue.id); issues = issues.filter((i) => i !== issue); marks(); paintIssues(); }), make("Ignore all", () => { void ignoreAll(issue); }, "Ignore this in the whole document"), issue.kind === "spelling" ? make("Add to dictionary", () => { void addToDictionary(issue, "document"); }, "Remember this word in this document") : null, issue.kind === "spelling" ? make("Add to my dictionary", () => { void addToDictionary(issue, "user"); }, "Remember this word for every document on this computer") : null));
            ul.appendChild(li);
        });
        issuesBox.appendChild(ul);
    };
    /** One request per kind of check; a response is used only for the blocks whose text is still what was sent. */
    const check = async (what, btn, changed, whole = false) => {
        if (!app.prefs[what === "spell" ? "spell" : "grammar"])
            return;
        if (btn)
            btn.disabled = true;
        const mine = ++sequence[what];
        try {
            await ed.whenIdle();
            const blocks = changed ?? (whole ? undefined : targets());
            const sent = new Map();
            for (const id of blocks ?? ed.model.order)
                sent.set(id, ed.model.block(id)?.text ?? "");
            const kinds = [...KINDS[what]].filter((k) => k !== "style" || app.prefs.style);
            const out = await api.post(`/docs/${encodeURIComponent(ctx.sid)}/proof`, { ...(blocks ? { blocks } : {}), kinds });
            if (mine !== sequence[what]) {
                for (const id of blocks ?? [])
                    pendingBlocks.add(id);
                return;
            } // a newer check superseded this one
            if (!out.available) {
                status.report(what, out.reason ?? "This check is not available.");
                issues = issues.filter((i) => !kinds.includes(i.kind)); // marks from before the checker became unavailable would be stale
                marks();
                paintIssues();
                if (btn)
                    toast(out.reason ?? "This check is not available.", { kind: "info", timeoutMs: 9000 });
                return;
            }
            status.report(what, null);
            if (out.reason)
                notes.set(what, out.reason);
            else
                notes.delete(what);
            // Never attach old offsets to text changed during the check: keep the result for the blocks that are unchanged, queue the rest again.
            const fresh = (id) => (ed.model.block(id)?.text ?? "") === sent.get(id);
            const stale = [...sent.keys()].filter((id) => !fresh(id));
            for (const id of stale)
                pendingBlocks.add(id);
            const covered = new Set([...sent.keys()].filter(fresh));
            issues = [...issues.filter((i) => !kinds.includes(i.kind) || !covered.has(i.block)),
                ...out.issues.filter((i) => covered.has(i.block) && !ignoredOnce.has(i.id))];
            checkedVersion = ed.model.version;
            marks();
            paintIssues();
            if (stale.length)
                scheduleAutomatic([]);
            if (btn)
                announce(`${out.issues.length} ${what === "spell" ? "spelling" : "grammar and style"} suggestion${out.issues.length === 1 ? "" : "s"}.`);
            if (btn && out.truncated)
                toast("Only the first suggestions are shown. Fix these, then check again.", { kind: "info" });
        }
        catch (e) {
            const why = unavailable(e);
            if (why) {
                status.report(what, why);
                issues = issues.filter((i) => !KINDS[what].includes(i.kind));
                marks();
                paintIssues();
            }
            else if (btn) {
                clear(issuesBox);
                issuesBox.appendChild(notice(errorText(e), "danger", what === "spell" ? "Spelling is not available here." : "Grammar is not available here."));
            }
            if (btn)
                checkedVersion = -1;
        }
        finally {
            if (btn)
                btn.disabled = false;
        }
    };
    const clearMarks = () => { issues = []; checkedVersion = -1; current = -1; notes.clear(); status.reset(); marks(); paintIssues(); };
    const scheduleAutomatic = (blocks) => {
        for (const id of blocks) {
            const b = ed.model.block(id);
            if (b && ["paragraph", "heading", "quote", "list_item"].includes(b.type))
                pendingBlocks.add(id);
        }
        window.clearTimeout(autoTimer);
        if (!pendingBlocks.size || (!app.prefs.spell && !app.prefs.grammar))
            return;
        autoTimer = window.setTimeout(() => {
            const changed = [...pendingBlocks];
            pendingBlocks.clear();
            // Run these checks independently: an unavailable grammar model must not
            // disable deterministic spelling, and neither path may block editing.
            if (app.prefs.spell && status.shouldAutoCheck("spell"))
                void check("spell", undefined, changed);
            // Deterministic local grammar analysis is available independently of
            // optional AI rewriting and its separate privacy permission setting.
            if (app.prefs.grammar && status.shouldAutoCheck("grammar"))
                void check("grammar", undefined, changed);
        }, 500);
    };
    /* -------------------------------------------------------------------------------------------- AI assistant */
    let job = null;
    let poll;
    const stop = () => { window.clearInterval(poll); poll = undefined; };
    const sectionHeading = () => {
        const sel = ed.recallSelection();
        let i = sel ? ed.model.indexOf(sel.start.block) : -1;
        if (i < 0)
            i = 0;
        for (; i >= 0; i -= 1) {
            const b = ed.model.block(ed.model.order[i]);
            if (b?.type === "heading")
                return b.id;
        }
        return null;
    };
    const paintAi = () => {
        clear(aiBox);
        const prefs = app.prefs;
        const status = app.boot.capabilities.ai;
        if (!prefs.ai_enabled) {
            aiBox.appendChild(notice("The AI Assistant is off. Local spelling and grammar checking remain available from the Proofreading panel. Enable assistance in Settings only for generative rewrites.", "info", "AI is off."));
            aiBox.appendChild(h("div", { class: "actions" }, button("Open Settings", () => { app.go({ name: "settings" }); }, "", "settings")));
            return;
        }
        const scope = selectField("What may it read?", [["selection", "Selected text only"], ["section", "Selected section only"], ["document", "The whole document"]], "section");
        const task = selectField("Task", status.tasks.map((t) => [t.id, t.label]), "proofread");
        const provider = selectField("Provider", [["local", "Local model (runs on this computer)"]], "local");
        const instruction = h("textarea", { rows: 3, maxLength: 600, attrs: { placeholder: "Describe the edit you want" } });
        const instructionField = labelled("Your instruction", instruction);
        const syncTask = () => { instructionField.hidden = task.select.value !== "custom"; };
        task.select.addEventListener("change", syncTask);
        syncTask();
        const note = h("p", { class: "fine", text: "Only the text in the scope you choose is read, only when you press the button. Private notes and comments are never included. The assistant cannot add or change sources." });
        const cloud = notice("Cloud processing is not available: no cloud provider is configured.", "info");
        const start = button("Review proposed edit", async () => {
            const sel = ed.recallSelection();
            let body;
            if (scope.select.value === "selection") {
                if (!sel || sel.collapsed || sel.start.block !== sel.end.block || sel.start.field !== "text") {
                    toast("Select some text inside one paragraph, or choose a section.", { kind: "info" });
                    return;
                }
                body = { scope: { kind: "selection", block: sel.start.block, start: sel.start.offset, end: sel.end.offset } };
            }
            else if (scope.select.value === "section") {
                const heading = sectionHeading();
                if (!heading) {
                    toast("This document has no headings, so there is no section. Choose the selection or the whole document.", { kind: "info" });
                    return;
                }
                body = { scope: { kind: "section", block: heading } };
            }
            else
                body = { scope: { kind: "document" } };
            await ed.whenIdle();
            body["task"] = task.select.value;
            body["provider"] = provider.select.value;
            if (task.select.value === "custom")
                body["instruction"] = instruction.value;
            job = await api.post(`/docs/${encodeURIComponent(ctx.sid)}/assist`, body);
            track();
        }, "primary", "sparkle");
        fill(aiBox, scope.root, task.root, instructionField, provider.root, cloud, note, h("div", { class: "actions" }, start), h("div", { class: "ai-job", attrs: { "aria-live": "polite" } }));
        if (job)
            paintJob();
    };
    const track = () => {
        stop();
        paintJob();
        poll = window.setInterval(() => {
            void (async () => {
                if (!job || job.state !== "running") {
                    stop();
                    return;
                }
                try {
                    job = await api.get(`/assist/jobs/${encodeURIComponent(job.id)}`);
                }
                catch (e) {
                    stop();
                    toast(errorText(e), { kind: "error" });
                    job = null;
                }
                paintJob();
                if (job && job.state !== "running")
                    stop();
            })();
        }, 700);
    };
    const paintJob = () => {
        const box = aiBox.querySelector(".ai-job");
        if (!box)
            return;
        clear(box);
        if (!job)
            return;
        if (job.state === "running") {
            const cancel = button("Cancel request", async () => { if (job)
                job = await api.post(`/assist/jobs/${encodeURIComponent(job.id)}/cancel`, {}); stop(); paintJob(); }, "", "stop");
            box.append(h("p", { text: `Working… ${job.progress} of ${job.total} paragraph${job.total === 1 ? "" : "s"}.` }), cancel);
        }
        else if (job.state === "cancelled")
            box.append(notice("The request was cancelled. Nothing was changed.", "info"));
        else if (job.state === "failed")
            box.append(notice(job.error ?? "The request failed.", "warn", "The assistant could not finish."), h("p", { class: "fine", text: "Nothing was changed. Writing is not affected." }));
        else if (job.proposal)
            box.append(proposalView(job.proposal));
    };
    const proposalView = (p) => {
        const wrap = h("div", { class: "stack" }, h("h3", { text: "Review proposed edit" }), h("p", { class: "fine", text: p.label }), p.notes.map((n) => notice(n, "info")));
        if (!p.hunks.length) {
            wrap.append(notice("The assistant proposed no changes.", "ok"));
            return wrap;
        }
        const boxes = [];
        const ul = h("ul", { class: "panel-list" });
        for (const hunk of p.hunks) {
            const pick = h("input", { type: "checkbox", id: `hk-${hunk.id}` });
            const confirm = hunk.unverified.length ? h("input", { type: "checkbox", id: `hc-${hunk.id}` }) : null;
            boxes.push({ hunk, pick, confirm });
            ul.appendChild(h("li", {}, h("div", {}, h("span", { class: "badge ai", text: hunk.label }), " ", h("label", { attrs: { for: pick.id }, text: "Accept this change" }), " ", pick), h("div", { class: "diff-box" }, h("div", {}, h("strong", { text: "Your text" }), h("p", {}, h("del", { text: hunk.original }))), h("div", {}, h("strong", { text: "Suggested" }), h("p", {}, h("ins", { text: hunk.replacement })))), confirm ? h("div", { class: "notice warn" }, h("div", {}, h("strong", { text: "Adds details that were not in your text: " }), hunk.unverified.join(", "), h("p", { class: "fine", text: "Check these against your sources. Writer cannot verify them." }), confirm, " ", h("label", { attrs: { for: confirm.id }, text: "I checked these additions" }))) : null, h("div", { class: "actions" }, (() => { const b = h("button", { class: "btn small", type: "button", text: "Jump to text" }); b.addEventListener("click", () => ed.scrollToBlock(hunk.block, hunk.start)); return b; })())));
        }
        wrap.append(ul);
        const applyBtn = button("Apply the accepted changes", async () => {
            const chosen = boxes.filter((b) => b.pick.checked);
            if (!chosen.length) {
                toast("Tick the changes you want to accept.", { kind: "info" });
                return;
            }
            const missing = chosen.find((b) => b.confirm && !b.confirm.checked);
            if (missing) {
                toast("Confirm the additions you checked, or untick that change.", { kind: "info" });
                return;
            }
            const out = await ed.call(() => api.post(`/docs/${encodeURIComponent(ctx.sid)}/assist/apply`, { proposal: p.id, accept: chosen.map((b) => b.hunk.id), confirmAdditions: chosen.filter((b) => b.confirm?.checked).map((b) => b.hunk.id) }));
            await ed.resync(out.state);
            toast(`${out.applied} change${out.applied === 1 ? "" : "s"} applied as one edit. Undo reverses them.`, { kind: "ok" });
            const left = boxes.filter((b) => !b.pick.checked).map((b) => b.hunk.id);
            if (left.length)
                await api.post(`/assist/proposals/${encodeURIComponent(p.id)}/reject`, { hunks: left }).catch(() => undefined);
            job = null;
            paintJob();
        }, "primary", "check");
        const rejectBtn = button("Reject all", async () => { await api.post(`/assist/proposals/${encodeURIComponent(p.id)}/reject`, { hunks: p.hunks.map((x) => x.id) }); job = null; paintJob(); announce("Suggestions rejected. Nothing was changed."); }, "", "close");
        wrap.append(h("div", { class: "actions" }, applyBtn, rejectBtn));
        return wrap;
    };
    /* -------------------------------------------------------------------------------------------------- layout */
    const spellBtn = button("Check spelling", () => check("spell", spellBtn), "", "spell");
    const grammarBtn = button("Check grammar", () => check("grammar", grammarBtn), "", "check");
    const recheckBtn = button("Recheck document", async () => { recheckBtn.disabled = true; ignoredOnce.clear(); try {
        status.reset();
        await Promise.all([check("spell", undefined, undefined, true), check("grammar", undefined, undefined, true)]);
    }
    finally {
        recheckBtn.disabled = false;
    } }, "", "refresh");
    const clearBtn = button("Clear marks", () => { clearMarks(); }, "", "close");
    const setPref = (patch) => { void app.setPrefs(patch).catch((e) => toast(errorText(e), { kind: "error" })); };
    const spellToggle = checkbox("Spelling (red wavy line)", app.prefs.spell, (v) => setPref({ spell: v }));
    const grammarToggle = checkbox("Grammar (orange wavy line)", app.prefs.grammar, (v) => setPref({ grammar: v }));
    const styleToggle = checkbox("Style suggestions (blue dotted line)", app.prefs.style, (v) => setPref({ style: v }));
    const docLanguage = (() => { const l = ed.model.meta.language || "en"; return LANGUAGES.some(([v]) => v === l) ? l : LANGUAGES.some(([v]) => v === l.split("-")[0]) ? l.split("-")[0] : l; })();
    const languageOptions = LANGUAGES.some(([v]) => v === docLanguage) ? LANGUAGES : [...LANGUAGES, [docLanguage, `${docLanguage} (no proofing tools)`]];
    const language = selectField("Document language", languageOptions, docLanguage, (v) => { void ed.op({ op: "meta", set: { language: v }, label: "document language" }).catch((e) => toast(errorText(e), { kind: "error" })); });
    fill(root, h("h2", { text: "Proofing" }), h("p", { class: "fine", text: "Spelling is marked in red, grammar in orange and optional style suggestions in blue. A mark is a suggestion: you decide. Checking runs on this computer; the text of your document is not sent anywhere." }), h("div", { class: "actions" }, spellBtn, grammarBtn, recheckBtn, clearBtn), h("div", { class: "stack" }, spellToggle.root, grammarToggle.root, styleToggle.root, language.root, h("p", { class: "fine", text: "The language applies to the whole document: a selection cannot carry its own language yet." })), issuesBox, h("h3", { text: "Synonyms" }), h("p", { class: "fine", text: "Not available: no thesaurus is installed, so Writer does not offer synonyms. Spelling suggestions appear for misspelled words." }), h("h2", { text: "AI Assistant" }), aiBox);
    paintIssues();
    paintAi();
    const off = [
        ed.events.on((e) => {
            if (e.type === "patch") {
                const changed = Object.keys(e.patch.blocks);
                if (issues.length && !ours) {
                    issues = issues.filter((i) => !changed.includes(i.block));
                    marks();
                    paintIssues();
                }
                if (e.patch.document && "language" in e.patch.document) {
                    status.reset();
                    scheduleAutomatic(ed.model.order.slice(0, 100));
                } // a new language may be covered
                scheduleAutomatic(changed);
            }
            if (e.type === "reloaded") {
                clearMarks();
                scheduleAutomatic(ed.model.order.slice(0, 100));
            }
        }),
        app.events.on((e) => {
            if (e.type === "prefs") {
                status.reset();
                paintAi();
                issues = issues.filter((i) => i.kind === "spelling" ? app.prefs.spell : i.kind === "style" ? app.prefs.style && app.prefs.grammar : app.prefs.grammar);
                spellToggle.input.checked = app.prefs.spell;
                grammarToggle.input.checked = app.prefs.grammar;
                styleToggle.input.checked = app.prefs.style;
                marks();
                paintIssues();
                scheduleAutomatic(ed.model.order.slice(0, 100));
            }
        }),
    ];
    // Check a bounded initial window; subsequent document edits are incremental.
    scheduleAutomatic(ed.model.order.slice(0, 100));
    return { el: root, refresh: () => { paintAi(); }, destroy: () => { window.clearTimeout(autoTimer); stop(); off.forEach((f) => f()); ed.decor.clear("typo"); ed.decor.clear("grammar"); ed.decor.clear("style"); } };
}
