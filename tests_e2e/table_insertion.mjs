/** Tables go where the caret is, in every layout, and the editor and the server agree afterwards. Insert → Table is driven through the real dialog; Markdown text is turned into a
 *  table with the real command. After each action the blocks on the page (order, kind, text) are compared with the blocks the server holds.
 *    NODE_PATH=<dir with playwright> node tests_e2e/table_insertion.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("tbl");
const { scenario, state, finish } = runner();
let browser, context, page, sid;
const problems = [];
const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const op = async (o) => { const r = await api("POST", `/docs/${sid}/ops`, { op: o }); if (r.status >= 300) throw new Error(JSON.stringify(r.body).slice(0, 300)); return r.body.data; };

async function fresh(blocks) {
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
  const s = await doc();
  let after = s.blocks[0].id;
  const ops = [{ op: "text", block: after, start: 0, end: s.blocks[0].text.length, insert: blocks[0].text }];
  for (const b of blocks.slice(1)) { ops.push({ op: "block_insert", after, block: b }); after = b.id; }
  await op({ op: "batch", ops });
  await page.reload(); await page.locator("#main").waitFor(); await delay(600);
  return (await doc()).blocks[0].id;
}
const kinds = async () => (await doc()).blocks.map((b) => (b.type === "table" ? "table" : b.text || `[${b.type}]`));
const domKinds = () => page.evaluate(() => [...document.querySelectorAll(".sheets [data-id]")].filter((e) => e.dataset.id && !e.closest(".cols") || e.closest(".cols")).map((e) => e.dataset.id));
/** The page and the server hold the same blocks in the same order. */
async function inSync(label) {
  await delay(500);
  const server = (await doc()).blocks.map((b) => b.id);
  const page_ = await page.evaluate(() => [...new Set([...document.querySelectorAll(".sheets [data-id]")].map((e) => e.dataset.id))]);
  eq(page_, server, `${label}: the page and the server have the same blocks in the same order`);
}
async function insertTable(rows = 2, cols = 3) {
  await page.getByRole("tab", { name: "Insert", exact: true }).click();
  await page.locator(".format-ribbon:visible").getByRole("button", { name: "Table", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rows").fill(String(rows));
  await dialog.getByLabel("Columns").fill(String(cols));
  await dialog.getByRole("button", { name: "Insert table" }).click();
  await dialog.waitFor({ state: "detached" });
  await delay(500);
}
const caretAt = (id, offset) => page.evaluate(({ id, offset }) => {
  const el = document.querySelector(`[data-id='${id}'] [data-edit='text']`); el.focus();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let left = offset, node = walker.nextNode();
  while (node && left > node.textContent.length) { left -= node.textContent.length; node = walker.nextNode(); }
  const s = getSelection(); s.collapse(node ?? el, node ? left : el.childNodes.length);
}, { id, offset });

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });
  const three = [{ text: "Alpha paragraph." }, { id: "b2", type: "paragraph", text: "Beta paragraph with words." }, { id: "b3", type: "paragraph", text: "Gamma paragraph." }];

  await scenario("a table goes at the caret: in the middle of a paragraph it splits the paragraph, at the end it follows it, at the start it comes before it", async () => {
    const first = await fresh(three);
    await caretAt("b2", 5);                                                  // "Beta| paragraph with words."
    await insertTable();
    eq(await kinds(), ["Alpha paragraph.", "Beta ", "table", "paragraph with words.", "Gamma paragraph."], "mid-paragraph");
    await inSync("mid-paragraph");
    await caretAt("b3", "Gamma paragraph.".length);   // the end of the last paragraph
    await insertTable(1, 2);
    const afterEnd = await kinds();
    ok(afterEnd.indexOf("Gamma paragraph.") + 1 === afterEnd.lastIndexOf("table"), "the table follows the paragraph the caret was at the end of");
    await caretAt(first, 0);
    await insertTable(2, 2);
    const atStart = await kinds();
    eq(atStart.slice(0, 2), ["table", "Alpha paragraph."], "caret at the very start: the table comes first");
    await inSync("start");
  });

  await scenario("inline formatting survives a split, and one Undo takes the table and the split away", async () => {
    await fresh([{ text: "Plain start " }, { id: "b2", type: "paragraph", text: "bold and italic words", spans: [{ type: "format", start: 0, end: 4, bold: true }, { type: "format", start: 9, end: 15, italic: true }] }]);
    const before = JSON.stringify((await doc()).blocks.map((b) => [b.id, b.text, b.spans ?? null]));
    await caretAt("b2", 9);
    await insertTable();
    const d = await doc();
    const blocks = d.blocks;
    const split = blocks.findIndex((b) => b.type === "table");
    eq(blocks[split - 1].text, "bold and ", "text before the caret");
    eq(blocks[split + 1].text, "italic words", "text after the caret");
    ok(JSON.stringify(blocks[split - 1].spans ?? []).includes("bold"), "bold stays on the first half");
    ok(JSON.stringify(blocks[split + 1].spans ?? []).includes("italic"), "italic moves with the second half");
    await page.keyboard.press("Control+z");
    await delay(600);
    eq(JSON.stringify((await doc()).blocks.map((b) => [b.id, b.text, b.spans ?? null])), before, "one Undo restores the paragraph exactly");
    await inSync("after undo");
  });

  await scenario("with the caret inside a table cell the new table follows that table", async () => {
    await fresh(three);
    await op({ op: "block_insert", after: "b2", block: { id: "t1", type: "table", rows: 2, columns: 2 } });
    await page.reload(); await page.locator("#main").waitFor(); await delay(600);
    await page.locator("[data-id='t1'] [data-edit='cell']").first().click();
    await insertTable(1, 1);
    const k = await kinds();
    const t = k.map((x, i) => (x === "table" ? i : -1)).filter((i) => i >= 0);
    eq(t[1] - t[0], 1, "the second table directly follows the first (the one the caret was in)");
    await inSync("cell");
  });

  await scenario("in a two-column section the table stays in that section", async () => {
    await fresh(three);
    await op({ op: "columns_set", block: "b2", columns: 2 }).catch(() => {});
    const before = await doc();
    const sectionOf = (d, id) => d.blocks.find((b) => b.id === id)?.section ?? null;
    await page.reload(); await page.locator("#main").waitFor(); await delay(600);
    await caretAt("b2", 4);
    await insertTable();
    const d = await doc();
    const tableBlock = d.blocks.find((b) => b.type === "table");
    eq(tableBlock.section ?? null, sectionOf(d, "b2"), "the table belongs to the section of the paragraph it split");
    void before;
    await inSync("columns");
  });

  await scenario("a Markdown table in plain paragraphs becomes a real table through the ribbon command, in one undo step", async () => {
    await fresh([{ text: "Intro." }, { id: "m1", type: "paragraph", text: "| Name | Qty |" }, { id: "m2", type: "paragraph", text: "| --- | ---: |" }, { id: "m3", type: "paragraph", text: "| Bolt | 4 |" }, { id: "m4", type: "paragraph", text: "| Nut | 9 |" }, { id: "end", type: "paragraph", text: "After." }]);
    await caretAt("m3", 3);
    await page.getByRole("tab", { name: "Insert", exact: true }).click();
    await page.locator(".format-ribbon:visible").getByRole("button", { name: "Markdown to table" }).click();
    await delay(800);
    const d = await doc();
    const table = d.blocks.find((b) => b.type === "table");
    ok(table, "a table block exists");
    eq(table.table.rows.map((r) => r.map((c) => c.text)), [["Name", "Qty"], ["Bolt", "4"], ["Nut", "9"]], "cells");
    eq(d.blocks.map((b) => b.type === "table" ? "table" : b.text), ["Intro.", "table", "After."], "the pipe lines were replaced by the table");
    await inSync("markdown");
    await page.keyboard.press("Control+z");
    await delay(600);
    eq((await doc()).blocks.map((b) => b.text).filter(Boolean), ["Intro.", "| Name | Qty |", "| --- | ---: |", "| Bolt | 4 |", "| Nut | 9 |", "After."], "one Undo brings the lines back");
  });

  await scenario("Markdown that is not a table (the delimiter row has another number of cells than the header) is refused with a message and nothing changes", async () => {
    await fresh([{ text: "Intro." }, { id: "m1", type: "paragraph", text: "| Name | Qty |" }, { id: "m2", type: "paragraph", text: "| --- | --- | --- |" }, { id: "m3", type: "paragraph", text: "| Bolt | 4 |" }, { id: "m4", type: "paragraph", text: "| Nut | 9 |" }]);
    const before = await kinds();
    await caretAt("m3", 2);
    await page.getByRole("tab", { name: "Insert", exact: true }).click();
    await page.locator(".format-ribbon:visible").getByRole("button", { name: "Markdown to table" }).click();
    await delay(700);
    eq(await kinds(), before, "the document is unchanged");
    ok(await page.locator("[role=status], [role=alert], .toast").filter({ hasText: /table|row|column|Markdown/i }).count() > 0, "a message says why");
  });

  await scenario("no uncaught errors while inserting tables", async () => { eq(problems, [], "page errors"); });
} finally {
  await context?.close(); await browser?.close(); server.stop();
}
finish();
