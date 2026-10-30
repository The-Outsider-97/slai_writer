/** The red panel: spelling and grammar marks, and the AI Assistant.
 *
 *  Everything here starts with a button press. Nothing is read or sent until then; every result is a suggestion with its source named, and
 *  nothing changes the text until the person accepts it (one undoable edit). When a checker or model is not installed the panel says so. */
import { ApiError, announce, clear, h, labelled, toast } from "../kit.js";
import type { DocCtx, Panel } from "../docctx.js";
import { api, errorText } from "../net.js";
import type { DocState, Patch } from "../types.js";
import { button, fill, notice, selectField, statusBadge } from "../widgets.js";

interface SpellIssue { kind: "spelling"; block: string; start: number; end: number; text: string; suggestions: string[]; source: string }
interface GrammarIssue { kind: "grammar"; block: string; start: number; end: number; text: string; message: string; suggestion?: string; replacement?: string; severity?: string; rule?: string }
type Issue = SpellIssue | GrammarIssue;
interface Hunk { id: string; block: string; start: number; end: number; original: string; replacement: string; status: string; unverified: string[]; label: string }
interface Proposal { id: string; hunks: Hunk[]; notes: string[]; label: string; task: string }
interface Job { id: string; state: "running" | "ready" | "failed" | "cancelled"; progress: number; total: number; error: string | null; proposal: Proposal | null; hint?: string }

function unavailable(error: unknown): string | null {
  if (error instanceof ApiError && (error.code === "dependency_missing" || error.status === 503 || error.status === 403)) return error.friendly;
  return null;
}

export function createProofPanel(ctx: DocCtx): Panel {
  const { ed, app } = ctx;
  const root = h("div", { class: "stack" });
  const issuesBox = h("div", { attrs: { "aria-live": "polite" } });
  const aiBox = h("div", { attrs: { "aria-live": "polite" } });
  let issues: Issue[] = [];
  let checkedVersion = -1;
  let ours = false;                    // true while a patch is our own accepted suggestion, so its marks are kept

  const marks = (): void => {
    ed.decor.set("typo", issues.filter((i) => i.kind === "spelling").map((i) => ({ block: i.block, start: i.start, end: i.end })));
    ed.decor.set("grammar", issues.filter((i) => i.kind === "grammar").map((i) => ({ block: i.block, start: i.start, end: i.end })));
  };

  /** Blocks to check: the paragraphs the selection touches, or the whole document when nothing is selected. */
  const targets = (): string[] | undefined => {
    const sel = ed.recallSelection();
    if (!sel || sel.collapsed) return undefined;
    const from = ed.model.indexOf(sel.start.block), to = ed.model.indexOf(sel.end.block);
    return ed.model.order.slice(Math.min(from, to), Math.max(from, to) + 1);
  };

  const shiftAfter = (done: Issue, delta: number): void => {
    for (const i of issues) if (i !== done && i.block === done.block && i.start >= done.end) { i.start += delta; i.end += delta; }
  };

  const accept = async (issue: Issue, replacement: string): Promise<void> => {
    try {
      ours = true;
      await ed.op({ op: "text", block: issue.block, start: issue.start, end: issue.end, insert: replacement, expect: issue.text, label: issue.kind === "spelling" ? "spelling correction" : "grammar correction" });
      shiftAfter(issue, replacement.length - (issue.end - issue.start));
      issues = issues.filter((i) => i !== issue);
      marks(); paintIssues();
      announce(`Changed “${issue.text}” to “${replacement}”.`);
    } catch (e) { toast(`${errorText(e)} Check again to refresh the marks.`, { kind: "error" }); } finally { ours = false; }
  };

  const paintIssues = (): void => {
    clear(issuesBox);
    if (checkedVersion < 0) { issuesBox.appendChild(h("p", { class: "fine", text: "Nothing has been checked. Press a button above; only the selected paragraphs are checked, or the whole document when nothing is selected." })); return; }
    if (checkedVersion !== ed.model.version && !ours) issuesBox.appendChild(notice("The text has changed since this check. Each suggestion is still verified against the current text before it is applied, but check again for a fresh list.", "info"));
    if (!issues.length) { issuesBox.appendChild(notice("No problems found in what was checked.", "ok")); return; }
    const ul = h("ul", { class: "panel-list" });
    for (const issue of issues) {
      const replacements = issue.kind === "spelling" ? issue.suggestions : issue.replacement ? [issue.replacement] : [];
      const dict = issue.kind === "spelling" ? h("button", { class: "btn small", type: "button", text: "Add to dictionary" }) : null;
      dict?.addEventListener("click", () => { void (async () => {
        try { await ed.call(() => api.post<Patch>(`/docs/${encodeURIComponent(ctx.sid)}/dictionary`, { word: issue.text }), (patch) => patch); issues = issues.filter((i) => !(i.kind === "spelling" && i.text.toLowerCase() === issue.text.toLowerCase())); marks(); paintIssues(); } catch (e) { toast(errorText(e), { kind: "error" }); }
      })(); });
      const ignore = h("button", { class: "btn small", type: "button", text: "Ignore" });
      ignore.addEventListener("click", () => { issues = issues.filter((i) => i !== issue); marks(); paintIssues(); });
      const go = h("button", { class: "linkbtn", type: "button", text: `“${issue.text}”` });
      go.addEventListener("click", () => ed.scrollToBlock(issue.block, issue.start));
      ul.appendChild(h("li", {},
        h("div", {}, statusBadge(issue.kind === "spelling" ? "Spelling" : "Grammar", issue.kind === "spelling" ? "danger" : "warn"), " ", go),
        issue.kind === "grammar" ? h("p", { text: issue.message }) : null,
        issue.kind === "grammar" && issue.suggestion ? h("p", { class: "fine", text: `Suggestion: ${issue.suggestion}` }) : null,
        h("p", { class: "fine", text: issue.kind === "spelling" ? "Source: SLAI spell checker. Suggestions are ranked guesses, not facts." : "Source: SLAI grammar processor on this computer." }),
        h("div", { class: "actions" }, replacements.slice(0, 5).map((r) => { const b = h("button", { class: "btn small", type: "button", text: `Accept: ${r}`, disabled: ed.readOnly }); b.addEventListener("click", () => { void accept(issue, r); }); return b; }), dict, ignore)));
    }
    issuesBox.appendChild(ul);
  };

  const check = async (what: "spell" | "grammar", btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    try {
      await ed.whenIdle();
      const blocks = targets();
      const out = await api.post<{ available: boolean; reason?: string; issues: Issue[]; version: number; truncated?: boolean }>(`/docs/${encodeURIComponent(ctx.sid)}/${what === "spell" ? "spell" : "grammar"}`, blocks ? { blocks } : {});
      if (!out.available) { toast(out.reason ?? "This check is not available.", { kind: "info", timeoutMs: 9000 }); return; }
      issues = [...issues.filter((i) => i.kind !== (what === "spell" ? "spelling" : "grammar")), ...out.issues];
      checkedVersion = out.version;
      marks(); paintIssues();
      announce(`${out.issues.length} ${what === "spell" ? "spelling" : "grammar"} suggestion${out.issues.length === 1 ? "" : "s"}.`);
      if (out.truncated) toast("Only the first suggestions are shown. Fix these, then check again.", { kind: "info" });
    } catch (e) {
      const why = unavailable(e);
      clear(issuesBox);
      issuesBox.appendChild(notice(why ?? errorText(e), why ? "warn" : "danger", what === "spell" ? "Spelling is not available here." : "Grammar is not available here."));
      checkedVersion = -1;
    } finally { btn.disabled = false; }
  };

  const clearMarks = (): void => { issues = []; checkedVersion = -1; marks(); paintIssues(); };

  /* -------------------------------------------------------------------------------------------- AI assistant */
  let job: Job | null = null;
  let poll: number | undefined;
  const stop = (): void => { window.clearInterval(poll); poll = undefined; };

  const sectionHeading = (): string | null => {
    const sel = ed.recallSelection();
    let i = sel ? ed.model.indexOf(sel.start.block) : -1;
    if (i < 0) i = 0;
    for (; i >= 0; i -= 1) { const b = ed.model.block(ed.model.order[i] as string); if (b?.type === "heading") return b.id; }
    return null;
  };

  const paintAi = (): void => {
    clear(aiBox);
    const prefs = app.prefs;
    const status = app.boot.capabilities.ai;
    if (!prefs.ai_enabled) {
      aiBox.appendChild(notice("The AI Assistant is off. Writing, spelling and everything else work without it. If you want suggestions, switch it on in Settings; nothing is read until you ask.", "info", "AI is off."));
      aiBox.appendChild(h("div", { class: "actions" }, button("Open Settings", () => { app.go({ name: "settings" }); }, "", "settings")));
      return;
    }
    const scope = selectField("What may it read?", [["selection", "Selected text only"], ["section", "Selected section only"], ["document", "The whole document"]], "section");
    const task = selectField("Task", status.tasks.map((t) => [t.id, t.label] as [string, string]), "proofread");
    const provider = selectField("Provider", [["local", "Local model (runs on this computer)"]], "local");
    const instruction = h("textarea", { rows: 3, maxLength: 600, attrs: { placeholder: "Describe the edit you want" } });
    const instructionField = labelled("Your instruction", instruction);
    const syncTask = (): void => { instructionField.hidden = task.select.value !== "custom"; };
    task.select.addEventListener("change", syncTask);
    syncTask();
    const note = h("p", { class: "fine", text: "Only the text in the scope you choose is read, only when you press the button. Private notes and comments are never included. The assistant cannot add or change sources." });
    const cloud = notice("Cloud processing is not available: no cloud provider is configured.", "info");
    const start = button("Review proposed edit", async () => {
      const sel = ed.recallSelection();
      let body: Record<string, unknown>;
      if (scope.select.value === "selection") {
        if (!sel || sel.collapsed || sel.start.block !== sel.end.block || sel.start.field !== "text") { toast("Select some text inside one paragraph, or choose a section.", { kind: "info" }); return; }
        body = { scope: { kind: "selection", block: sel.start.block, start: sel.start.offset, end: sel.end.offset } };
      } else if (scope.select.value === "section") {
        const heading = sectionHeading();
        if (!heading) { toast("This document has no headings, so there is no section. Choose the selection or the whole document.", { kind: "info" }); return; }
        body = { scope: { kind: "section", block: heading } };
      } else body = { scope: { kind: "document" } };
      await ed.whenIdle();
      body["task"] = task.select.value; body["provider"] = provider.select.value;
      if (task.select.value === "custom") body["instruction"] = instruction.value;
      job = await api.post<Job>(`/docs/${encodeURIComponent(ctx.sid)}/assist`, body);
      track();
    }, "primary", "sparkle");
    fill(aiBox, scope.root, task.root, instructionField, provider.root, cloud, note, h("div", { class: "actions" }, start), h("div", { class: "ai-job", attrs: { "aria-live": "polite" } }));
    if (job) paintJob();
  };

  const track = (): void => {
    stop();
    paintJob();
    poll = window.setInterval(() => { void (async () => {
      if (!job || job.state !== "running") { stop(); return; }
      try { job = await api.get<Job>(`/assist/jobs/${encodeURIComponent(job.id)}`); } catch (e) { stop(); toast(errorText(e), { kind: "error" }); job = null; }
      paintJob();
      if (job && job.state !== "running") stop();
    })(); }, 700);
  };

  const paintJob = (): void => {
    const box = aiBox.querySelector<HTMLElement>(".ai-job");
    if (!box) return;
    clear(box);
    if (!job) return;
    if (job.state === "running") {
      const cancel = button("Cancel request", async () => { if (job) job = await api.post<Job>(`/assist/jobs/${encodeURIComponent(job.id)}/cancel`, {}); stop(); paintJob(); }, "", "stop");
      box.append(h("p", { text: `Working… ${job.progress} of ${job.total} paragraph${job.total === 1 ? "" : "s"}.` }), cancel);
    } else if (job.state === "cancelled") box.append(notice("The request was cancelled. Nothing was changed.", "info"));
    else if (job.state === "failed") box.append(notice(job.error ?? "The request failed.", "warn", "The assistant could not finish."), h("p", { class: "fine", text: "Nothing was changed. Writing is not affected." }));
    else if (job.proposal) box.append(proposalView(job.proposal));
  };

  const proposalView = (p: Proposal): HTMLElement => {
    const wrap = h("div", { class: "stack" }, h("h3", { text: "Review proposed edit" }), h("p", { class: "fine", text: p.label }), p.notes.map((n) => notice(n, "info")));
    if (!p.hunks.length) { wrap.append(notice("The assistant proposed no changes.", "ok")); return wrap; }
    const boxes: Array<{ hunk: Hunk; pick: HTMLInputElement; confirm: HTMLInputElement | null }> = [];
    const ul = h("ul", { class: "panel-list" });
    for (const hunk of p.hunks) {
      const pick = h("input", { type: "checkbox", id: `hk-${hunk.id}` });
      const confirm = hunk.unverified.length ? h("input", { type: "checkbox", id: `hc-${hunk.id}` }) : null;
      boxes.push({ hunk, pick, confirm });
      ul.appendChild(h("li", {},
        h("div", {}, h("span", { class: "badge ai", text: hunk.label }), " ", h("label", { attrs: { for: pick.id }, text: "Accept this change" }), " ", pick),
        h("div", { class: "diff-box" }, h("div", {}, h("strong", { text: "Your text" }), h("p", {}, h("del", { text: hunk.original }))), h("div", {}, h("strong", { text: "Suggested" }), h("p", {}, h("ins", { text: hunk.replacement })))),
        confirm ? h("div", { class: "notice warn" }, h("div", {}, h("strong", { text: "Adds details that were not in your text: " }), hunk.unverified.join(", "), h("p", { class: "fine", text: "Check these against your sources. Writer cannot verify them." }), confirm, " ", h("label", { attrs: { for: confirm.id }, text: "I checked these additions" }))) : null,
        h("div", { class: "actions" }, (() => { const b = h("button", { class: "btn small", type: "button", text: "Jump to text" }); b.addEventListener("click", () => ed.scrollToBlock(hunk.block, hunk.start)); return b; })())));
    }
    wrap.append(ul);
    const applyBtn = button("Apply the accepted changes", async () => {
      const chosen = boxes.filter((b) => b.pick.checked);
      if (!chosen.length) { toast("Tick the changes you want to accept.", { kind: "info" }); return; }
      const missing = chosen.find((b) => b.confirm && !b.confirm.checked);
      if (missing) { toast("Confirm the additions you checked, or untick that change.", { kind: "info" }); return; }
      const out = await ed.call(() => api.post<{ applied: number; state: DocState }>(`/docs/${encodeURIComponent(ctx.sid)}/assist/apply`, { proposal: p.id, accept: chosen.map((b) => b.hunk.id), confirmAdditions: chosen.filter((b) => b.confirm?.checked).map((b) => b.hunk.id) }));
      await ed.resync(out.state);
      toast(`${out.applied} change${out.applied === 1 ? "" : "s"} applied as one edit. Undo reverses them.`, { kind: "ok" });
      const left = boxes.filter((b) => !b.pick.checked).map((b) => b.hunk.id);
      if (left.length) await api.post(`/assist/proposals/${encodeURIComponent(p.id)}/reject`, { hunks: left }).catch(() => undefined);
      job = null; paintJob();
    }, "primary", "check");
    const rejectBtn = button("Reject all", async () => { await api.post(`/assist/proposals/${encodeURIComponent(p.id)}/reject`, { hunks: p.hunks.map((x) => x.id) }); job = null; paintJob(); announce("Suggestions rejected. Nothing was changed."); }, "", "close");
    wrap.append(h("div", { class: "actions" }, applyBtn, rejectBtn));
    return wrap;
  };

  /* -------------------------------------------------------------------------------------------------- layout */
  const spellBtn = button("Check spelling", () => check("spell", spellBtn), "", "spell");
  const grammarBtn = button("Check grammar", () => check("grammar", grammarBtn), "", "check");
  const clearBtn = button("Clear marks", () => { clearMarks(); }, "", "close");
  fill(root,
    h("h2", { text: "Proofing" }),
    h("p", { class: "fine", text: "Typos are marked in red and grammar in orange. A mark is a suggestion: you decide." }),
    h("div", { class: "actions" }, spellBtn, grammarBtn, clearBtn), issuesBox,
    h("h3", { text: "Synonyms" }), h("p", { class: "fine", text: "Not available: no thesaurus is installed, so Writer does not offer synonyms. Spelling suggestions appear for misspelled words." }),
    h("h2", { text: "AI Assistant" }), aiBox);
  paintIssues();
  paintAi();

  const off = [
    ed.events.on((e) => {
      if (e.type === "patch" && e.local && !ours && issues.length) { /* marks drift with edits: drop them instead of showing them on the wrong words */ clearMarks(); }
      if (e.type === "reloaded" && issues.length) clearMarks();
    }),
    app.events.on((e) => { if (e.type === "prefs") paintAi(); }),
  ];
  return { el: root, refresh: () => { paintAi(); }, destroy: () => { stop(); off.forEach((f) => f()); ed.decor.clear("typo"); ed.decor.clear("grammar"); } };
}
