/** Browser tests for proofreading: the false positives of the 16 November screenshot, categories, Accept / Ignore once / Ignore all / dictionaries,
 *  Next and Previous, toggles, language, stale-result safety and non-blocking typing. Real Chromium, real server; nothing in the page is mocked except
 *  that one test delays the /proof response to prove that text typed meanwhile is never marked at old offsets.
 *    NODE_PATH=<dir with playwright> node tests_e2e/proofing.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("proof");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const marks = (name) => page.evaluate((n) => { const h = CSS.highlights.get(n); return h ? [...h].map((r) => r.toString()) : []; }, name);

async function fresh(texts, { open = true } = {}) {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  state.page = page;
  page.setDefaultTimeout(8000);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${server.base}/?token=${server.token}`);
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await page.getByRole("button", { name: "New Page" }).first().click();
  await page.getByRole("button", { name: "Create document" }).click();
  await page.locator("#main").waitFor();
  await until(async () => page.url().includes("/doc/"), "document url");
  sid = page.url().split("/doc/")[1];
  const s = await doc();
  const ops = [{ op: "text", block: s.blocks[0].id, start: 0, end: s.blocks[0].text.length, insert: texts[0][1] }];
  let after = s.blocks[0].id;
  texts.slice(1).forEach(([type, text], n) => { const id = `q${n}`; ops.push({ op: "block_insert", after, block: { id, type, text, ...(type === "heading" ? { attributes: { level: 2 } } : {}) } }); after = id; });
  const first = texts[0][0];
  if (first !== "paragraph") ops.push({ op: "block_set", block: s.blocks[0].id, type: first, attributes: { level: 1 } });
  const r = await api("POST", `/docs/${sid}/ops`, { op: { op: "batch", ops } });
  if (r.status >= 300) throw new Error("setup failed " + JSON.stringify(r.body).slice(0, 300));
  await page.reload(); await page.locator("#main").waitFor(); await delay(300);
  if (open) { await page.locator(".ptab.red").first().click(); await page.locator("#panel-red.open").waitFor(); }
}
const panel = () => page.locator("#panel-red");
const panelText = () => panel().innerText();
const cards = () => panel().locator("ul.panel-list > li");
const recheck = async () => { await panel().getByRole("button", { name: "Recheck document" }).click(); await delay(150); };
const settle = async (ms = 15000) => { await delay(900); await until(async () => !(await panel().getByRole("button", { name: "Recheck document" }).isDisabled()), "recheck idle", ms); await delay(300); };
const text = async (id) => (await doc()).blocks.find((b) => b.id === id).text;

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("the page from the screenshot has no marks: Timeline, Convinced, names, headings and a lone 'a'", async () => {
    await fresh([["heading", "Premise"], ["heading", "Timeline"], ["heading", "Vol I"], ["heading", "Vol II"], ["heading", "Vol III"],
      ["paragraph", "Timeline of the Yarla Accord, as told by Abiarra to the WTPA."], ["paragraph", "Convinced that the WTPA would act, Abiarra waited. Yarla said nothing."],
      ["paragraph", "Plan a is cheaper than plan b, and section a comes first."]]);
    await recheck(); await settle();
    const txt = await panelText();
    ok(/No problems found/.test(txt), `expected a clean page, panel says: ${txt.slice(0, 300)}`);
    eq(await marks("w-typo"), [], "spelling marks"); eq(await marks("w-grammar"), [], "grammar marks");
    ok(!/Timeliine|Convinceds|Incorrect article/.test(txt), "an old false-positive text is in the panel");
  });

  await scenario("real mistakes are marked with a category, a reason and ranked suggestions; Accept changes exactly that text and Undo restores it", async () => {
    await fresh([["paragraph", "Teh report is ready. He go home. This is an unique plan, and it is the the end."]]);
    await recheck(); await settle();
    const typo = await marks("w-typo"), grammar = await marks("w-grammar");
    ok(typo.includes("Teh"), `typo marks: ${typo}`);
    ok(grammar.some((g) => g === "go") && grammar.some((g) => g === "an") && grammar.some((g) => /the/.test(g)), `grammar marks: ${grammar}`);
    const txt = await panelText();
    ok(/Spelling/.test(txt) && /Agreement/.test(txt) && /Grammar/.test(txt), "categories shown");
    ok(/takes “goes”/.test(txt), "explanation shown");
    const teh = cards().filter({ hasText: "“Teh”" }).first();
    ok(/Accept: The/.test(await teh.innerText()), "ranked suggestion: The first");
    await teh.getByRole("button", { name: "Accept: The" }).click();
    await until(async () => (await text("b00001")).startsWith("The report"), "text replaced");
    eq((await text("b00001")).slice(0, 14), "The report is ", "only the typo changed");
    await page.locator("#main .blk [data-edit=text]").first().click();
    await page.keyboard.press("Control+z");
    await until(async () => (await text("b00001")).startsWith("Teh report"), "undo restored the typo");
  });

  await scenario("Ignore once hides one finding; Ignore all keeps a rule/text out of this document; both survive a recheck as designed", async () => {
    await fresh([["paragraph", "He go home. She have a car. He go again."]]);
    await recheck(); await settle();
    eq(await cards().count(), 3, "three findings");
    await cards().first().getByRole("button", { name: "Ignore once" }).click();
    eq(await cards().count(), 2, "one dismissed");
    await cards().first().getByRole("button", { name: "Ignore all" }).click();
    await until(async () => (await doc()).document.extensions?.["slai.writer"]?.proof_ignore?.length === 1, "proof_ignore saved in the document");
    await recheck(); await settle();
    const left = await panelText();
    ok(/“go”/.test(left) && !/“have”/.test(left), `after Ignore all (on 'have') the finding left is the second 'go': ${left.slice(0, 200)}`);
  });

  await scenario("Add to dictionary (this document) and Add to my dictionary (every document) remove the mark; the second follows the person to a new document", async () => {
    await fresh([["paragraph", "The zorbleflax met a frumbleton."]]);
    await recheck(); await settle();
    eq((await marks("w-typo")).length, 2, "two unknown words");
    await cards().filter({ hasText: "“zorbleflax”" }).getByRole("button", { name: "Add to dictionary" }).click();
    await until(async () => (await marks("w-typo")).length === 1, "first word accepted");
    ok((await doc()).document.extensions?.["slai.writer"]?.dictionary?.includes("zorbleflax"), "stored in the document");
    await cards().filter({ hasText: "“frumbleton”" }).getByRole("button", { name: "Add to my dictionary" }).click();
    await until(async () => (await marks("w-typo")).length === 0, "second word accepted");
    ok(!((await doc()).document.extensions?.["slai.writer"]?.dictionary ?? []).includes("frumbleton"), "the user's word is not stored in the document");
    await page.close();
    await fresh([["paragraph", "A frumbleton again."]]);
    await recheck(); await settle();
    eq(await marks("w-typo"), [], "the user's dictionary applies in another document");
  });

  await scenario("Next and Previous walk through the findings in document order and wrap", async () => {
    await fresh([["paragraph", "Teh first."], ["paragraph", "Fine text here."], ["paragraph", "The the second."], ["paragraph", "He go there."]]);
    await recheck(); await settle();
    const n = await cards().count(); ok(n === 3, `three findings, got ${n}`);
    const at = async () => page.evaluate(() => { const n = getSelection()?.anchorNode; const el = n && (n.nodeType === 1 ? n : n.parentElement); return el?.closest?.("[data-id]")?.getAttribute("data-id") ?? `none:${n?.nodeName}`; });
    await panel().getByRole("button", { name: "Next" }).click(); await delay(150);
    eq(await at(), "b00001", "first");
    await panel().getByRole("button", { name: "Next" }).click(); await delay(150);
    eq(await at(), "q1", "second");
    await panel().getByRole("button", { name: "Next" }).click(); await delay(150);
    eq(await at(), "q2", "third");
    await panel().getByRole("button", { name: "Next" }).click(); await delay(150);
    eq(await at(), "b00001", "wrapped to the first");
    await panel().getByRole("button", { name: "Previous" }).click(); await delay(150);
    eq(await at(), "q2", "previous wrapped to the last");
  });

  await scenario("the Spelling / Grammar / Style switches turn marks on and off; Style is blue dotted and off by default", async () => {
    await fresh([["paragraph", "Teh text. He go. We did it in order to win."]]);
    await recheck(); await settle();
    ok((await marks("w-typo")).length === 1 && (await marks("w-grammar")).length === 1, "spelling and grammar on");
    eq(await marks("w-style"), [], "style is off by default");
    await panel().getByLabel(/Style suggestions/).check(); await delay(1200); await recheck(); await settle();
    ok((await marks("w-style")).some((m) => /in order to/.test(m)), "style mark appears");
    await panel().getByLabel(/^Spelling/).uncheck();
    await until(async () => (await marks("w-typo")).length === 0, "spelling marks removed", 10000);
    await panel().getByLabel(/^Grammar/).uncheck();
    await until(async () => (await marks("w-grammar")).length === 0, "grammar marks removed", 10000);
    await panel().getByLabel(/^Spelling/).check(); await panel().getByLabel(/^Grammar/).check();
    await panel().getByLabel(/Style suggestions/).uncheck();
  });

  await scenario("document language: Dutch rules apply to Dutch, English rules do not; an unsupported language says so and marks nothing", async () => {
    await fresh([["paragraph", "Hij word morgen gebeld. Dit is groter als dat. Het is een mooie dag."]]);
    await panel().getByLabel("Document language").selectOption("nl");
    await until(async () => (await doc()).document.language === "nl", "language saved");
    await recheck(); await settle();
    const txt = await panelText();
    ok(/Na “Hij” hoort “wordt”/.test(txt), `Dutch agreement: ${txt.slice(0, 300)}`);
    ok(/No word list is installed for NL/.test(txt), "says why Dutch spelling is not checked");
    eq(await marks("w-typo"), [], "no spelling marks for Dutch without a word list");
    await panel().getByLabel("Document language").selectOption("en-GB");
    await until(async () => (await doc()).document.language === "en-GB", "language saved again");
    await recheck(); await settle();
    ok(!/hoort/.test(await panelText()), "Dutch rules no longer run");
  });

  await scenario("stale results are never painted at old offsets: text typed while a check is running is re-checked, not mis-marked", async () => {
    await fresh([["paragraph", "Teh text is here."], ["paragraph", "Another paragraph."]]);
    await settle();
    let held = 0;
    await page.route("**/api/docs/*/proof", async (route) => { held += 1; await delay(1200); try { await route.continue(); } catch { /* the route was removed meanwhile */ } });
    await recheck();
    await until(async () => held >= 1, "request held", 10000);
    // while the check is in flight, type new text in front of the typo (through the editor, like a person)
    await page.locator("#main .blk [data-edit=text]").first().click(); await page.keyboard.press("Control+Home");
    await page.keyboard.type("Zzz qqq. ", { delay: 10 });
    await until(async () => (await text("b00001")).startsWith("Zzz qqq. Teh"), "typed text saved");
    await until(async () => held >= 1, "request held");
    await page.unroute("**/api/docs/*/proof");
    await delay(3500);
    const typo = await marks("w-typo");
    ok(typo.includes("Teh"), `the typo is marked in the new text, not at its old offsets: ${typo}`);
    ok(typo.every((t) => ["Teh", "qqq", "Zzz"].includes(t)), `a mark landed on the wrong text: ${typo}`);
  });

  await scenario("typing stays responsive while a slow check is running (nothing blocks the editor)", async () => {
    await fresh([["paragraph", "Short text."]]);
    await page.route("**/api/docs/*/proof", async (route) => { await delay(2500); try { await route.continue(); } catch { /* removed */ } });
    await recheck();
    const p = page.locator("#main .blk [data-edit=text]").first();
    await p.click(); await page.keyboard.press("End");
    const t0 = Date.now();
    await page.keyboard.type(" And more typing while the check runs.", { delay: 5 });
    const took = Date.now() - t0;
    ok(took < 2000, `typing took ${took} ms while a check was pending`);
    await until(async () => (await text("b00001")).includes("while the check runs."), "text saved");
    await page.unroute("**/api/docs/*/proof");
  });

  await scenario("the check is local: no request leaves this computer", async () => {
    await fresh([["paragraph", "Teh text."]]);
    const external = [];
    page.on("request", (r) => { const u = new URL(r.url()); if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") external.push(r.url()); });
    await recheck(); await settle();
    eq(external, [], "external requests");
  });

  await scenario("checking never changes the document: version and text stay the same until a suggestion is accepted", async () => {
    await fresh([["paragraph", "Teh text. He go."]]);
    const before = await doc();
    await recheck(); await settle(); await recheck(); await settle();
    const after = await doc();
    eq(after.version, before.version, "version");
    eq(after.blocks.map((b) => b.text), before.blocks.map((b) => b.text), "text");
    ok(!JSON.stringify(after).includes("w-typo"), "no highlight name in the document");
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 5).join("\n  ")); });
}
