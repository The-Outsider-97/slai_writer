/** AutoCorrect and AutoFormat in a real browser: keys are typed one at a time into the page, and the document the server holds is compared afterwards, so what is on screen
 *  and what is saved cannot disagree. Covers capitals, the em dash, the caret, Undo (a correction is its own step and is not made again), the `___` rule with Enter, text after
 *  an emoji, and the settings screen.
 *    NODE_PATH=<dir with playwright> node tests_e2e/autocorrect.mjs
 *  NOT RUN in the environment this file was written in (no Playwright or Chromium there); it needs a first run on a machine that has them. */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("acx");
const { scenario, state, finish } = runner();
let browser, context, page, sid;
const problems = [];
const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;

async function fresh() {
  context?.close().catch(() => {});
  context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  page = await context.newPage();
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
  const first = (await doc()).blocks[0];
  await api("POST", `/docs/${sid}/ops`, { op: { op: "text", block: first.id, start: 0, end: first.text.length, insert: "" } });
  await page.reload(); await page.locator("#main").waitFor(); await delay(500);
  await page.locator("[data-edit='text']").first().click();
  return first.id;
}
const typeKeys = async (text) => { await page.keyboard.type(text, { delay: 25 }); await delay(700); };
const lastText = async () => { const d = await doc(); return d.blocks.map((b) => b.text).filter((t) => t !== undefined).join("\n").replace(/^\n+|\n+$/g, ""); };
const domText = () => page.evaluate(() => document.querySelector("[data-edit='text']").textContent);

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("sentences are capitalised as the words are finished, and the page and the server agree", async () => {
    await fresh();
    await typeKeys("hello world. dr. smith arrived. the value is 3.14. visit example.com now ");
    const text = await domText();
    eq(text.trim(), "Hello world. Dr. Smith arrived. The value is 3.14. Visit example.com now", "what is on the page");
    eq((await lastText()).trim(), text.trim(), "what the server holds");
  });

  await scenario("two hyphens become an em dash at once and the caret stays after it", async () => {
    await fresh();
    await typeKeys("Hello--world and--so on");
    eq(await domText(), "Hello—world and—so on", "page");
    eq((await lastText()), "Hello—world and—so on", "server");
    await typeKeys("!");
    eq(await domText(), "Hello—world and—so on!", "typing continues at the caret");
  });

  await scenario("Undo takes the correction back, keeps what was typed, and it is not made again", async () => {
    await fresh();
    await typeKeys("a--");
    eq(await domText(), "a—", "corrected (the capital waits until the word is finished)");
    await page.keyboard.press("Control+z");
    await delay(700);
    eq((await lastText()), "a--", "one Undo takes back the dash only");
    await typeKeys("b");
    eq(await domText(), "a--b", "typing on does not re-apply the dash");
  });

  await scenario("code blocks and addresses are left alone", async () => {
    await fresh();
    await typeKeys("see http://example.com/a--b and C:\\dir\\a--b ");
    eq(await domText(), "See http://example.com/a--b and C:\\dir\\a--b ", "addresses and paths");
  });

  await scenario("three underscores and Enter make a real rule; typing continues below it; one Undo brings the underscores back", async () => {
    await fresh();
    await typeKeys("Above");
    await page.keyboard.press("Enter");
    await typeKeys("___");
    await page.keyboard.press("Enter");
    await delay(900);
    const d = await doc();
    const rule = d.blocks.find((b) => b.extensions?.["slai.writer.rule"]);
    ok(rule, "a block carries the rule");
    eq(rule.text, "", "no underscore characters");
    ok(await page.locator(".b-rule .rule-line[role='separator']").count() === 1, "one drawn line on the page");
    const box = await page.locator(".b-rule .rule-line").boundingBox();
    const text = await page.locator("[data-edit='text']").first().boundingBox();
    ok(box.width >= text.width - 2, "the line spans the whole text width");
    await typeKeys("Below");
    const after = (await doc()).blocks;
    eq(after.map((b) => b.text).filter((t, i) => t || after[i].extensions?.["slai.writer.rule"]), ["Above", "", "Below"], "the order");
    await page.keyboard.press("Control+z");   // the typing below
    await page.keyboard.press("Control+z");   // the rule
    await delay(900);
    ok(!(await doc()).blocks.some((b) => b.extensions?.["slai.writer.rule"]), "the rule is gone");
  });

  await scenario("typing after an emoji lands where it was typed (code points, not UTF-16 units)", async () => {
    await fresh();
    await typeKeys("😀 abc. def ghi ");
    eq((await domText()).trim(), "😀 abc. Def ghi", "page");
    eq((await lastText()).trim(), "😀 abc. Def ghi", "server");
  });

  await scenario("the settings turn each rule off, and the change applies at the next keystroke", async () => {
    await fresh();
    await page.goto(`${server.base}/settings`);
    await page.getByLabel("Capitalize the first letter of sentences").uncheck();
    await page.getByLabel("Replace two hyphens (--) with an em dash (—)").uncheck();
    await delay(500);
    await page.goBack(); await page.locator("#main").waitFor(); await delay(500);
    await page.locator("[data-edit='text']").first().click();
    await typeKeys("hello. a--b ");
    eq((await domText()).trim(), "hello. a--b", "nothing is corrected");
  });

  await scenario("no uncaught errors", async () => { eq(problems, [], "page errors"); });
} finally {
  await context?.close(); await browser?.close(); server.stop();
}
finish();
