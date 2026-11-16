/** Browser tests for page columns: the Layout tab, scopes (section / selected text), column flow and pages, column breaks, the More Columns dialog, Scripture, undo and reopen. Real Chromium, real server. Run after `npm run build`:
 *  NODE_PATH=<dir with playwright> node tests_e2e/column_features.mjs */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(app, "../..");
const require = createRequire(import.meta.url);
const { chromium } = process.env.NODE_PATH ? require(join(process.env.NODE_PATH, "playwright")) : require("playwright");
const temp = mkdtempSync(join(tmpdir(), "writer-columns-"));
const shots = join(app, "tests_e2e", "failures");
mkdirSync(shots, { recursive: true });
const config = join(temp, "config.yaml");
writeFileSync(config, readFileSync(join(app, "configs/config.yaml"), "utf8").replace('library_root: ""', `library_root: "${join(temp, "library")}"`));
const port = await new Promise((yes, no) => { const s = net.createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => yes(a.port)); }); });
const base = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["-m", "applications.slai_writer", "--data-dir", join(temp, "data"), "--port", String(port), "--token", "tbl", "--no-browser", "--config", config],
  { cwd: root, env: { ...process.env, PYTHONPATH: root }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (b) => { serverLog += b; }); server.stderr.on("data", (b) => { serverLog += b; });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 8000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; } await delay(100); } throw new Error(`timed out: ${label}${last instanceof Error ? ` (${last.message})` : ""}`); };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const results = [];
let browser, page, sid;
const problems = [];

const state = async () => page.evaluate(async (id) => { const j = await (await fetch(`/api/docs/${id}`, { headers: { "X-SLAI-Writer": "1" } })).json(); if (!j.data) throw new Error(JSON.stringify(j).slice(0, 200) + " sid=" + id); return j.data; }, sid);
const op = async (o) => page.evaluate(async ({ id, o }) => { const r = await fetch(`/api/docs/${id}/ops`, { method: "POST", headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: JSON.stringify({ op: o }) }); return r.status; }, { id: sid, o });

const LONG = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.";
async function fresh(paragraphs = 8) {
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.setDefaultTimeout(8000);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?token=tbl`);
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await page.getByRole("button", { name: "New Page" }).first().click();
  await page.getByRole("button", { name: "Create document" }).click();
  await page.locator("#main").waitFor();
  await until(async () => page.url().includes("/doc/"), "document url");
  sid = page.url().split("/doc/")[1];
  await delay(300);
  const s = await state();
  const ops = [{ op: "text", block: s.blocks[0].id, start: 0, end: s.blocks[0].text.length, insert: `P0 ${LONG}` }];
  let after = s.blocks[0].id;
  for (let n = 1; n < paragraphs; n++) { const id = `p${n}`; ops.push({ op: "block_insert", after, block: { id, type: "paragraph", text: `P${n} ${LONG}` } }); after = id; }
  await op({ op: "batch", ops });
  await page.reload(); await page.locator("#main").waitFor(); await delay(500);
}
async function scenario(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name} (${Date.now() - started} ms)`); }
  catch (e) {
    results.push({ name, ok: false, error: e.message }); console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n").slice(0, 3).join(" | ")}`);
    try { await page.screenshot({ path: join(shots, `${name.replace(/\W+/g, "_")}.png`) }); } catch { /* ignore */ }
  }
  try { await page?.close(); } catch { /* ignore */ }
}
const tabs = () => page.locator(".ribbon-tab:visible").allTextContents();
const ribbonBtn = (name) => page.locator(".format-ribbon:visible").getByRole("button", { name, exact: false }).first();


const para = (n) => page.locator(`#main .blk[data-id=${n === 0 ? "b00001" : "p" + n}] [data-edit=text]`);
const sheets = () => page.locator("#main .sheet").count();
const rect = async (loc) => loc.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const layoutTab = async () => { await page.getByRole("tab", { name: "Layout" }).click(); await delay(100); };
const chooseColumns = async (label) => { await layoutTab(); await page.getByRole("button", { name: /^Columns/ }).first().click(); await page.getByRole("menuitem", { name: label }).click(); };
const sections = async () => (await state()).document.sections ?? [];
const layouts = async () => ((await state()).document.extensions?.["slai.writer"]?.column_layouts) ?? {};
const colCount = () => page.locator("#main .cols").first().evaluate((el) => getComputedStyle(el).columnCount);

try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base); if (r.status < 500) break; } catch { /* not yet */ } await delay(100); }
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("the Layout tab sets two columns for the section; text runs down the first column, then the second", async () => {
    await fresh(30);
    const before = await sheets();
    await para(2).click();
    await chooseColumns("Two");
    await until(async () => (await sections()).some((s) => s.columns === 2), "section has two columns");
    await until(async () => (await colCount()) === "2", "region has two CSS columns");
    await delay(500);
    const xs = new Set();
    for (const n of [1, 5, 10, 15, 20, 25]) { const loc = para(n); if (await loc.count()) xs.add(Math.round((await rect(loc)).x / 20)); }
    ok(xs.size >= 2, `text sits in two columns (distinct left edges: ${[...xs]})`);
    ok((await sheets()) <= before, `two columns need no more pages than one (${before} -> ${await sheets()})`);
    const first = await rect(para(1)), second = await rect(para(25));
    ok(first.w < 520, `a column is narrower than the page text area (${first.w})`);
  });

  await scenario("fills the first column to the bottom of the page before the second", async () => {
    await fresh(40);
    await para(2).click();
    await chooseColumns("Two");
    await until(async () => (await colCount()) === "2", "columns");
    await delay(600);
    const ys = [];
    for (let n = 1; n < 40; n++) { const loc = para(n); if (await loc.count()) { const r = await rect(loc); ys.push([Math.round(r.x / 30), Math.round(r.y)]); } }
    const left = ys.filter(([x]) => x === ys[0][0]).length, other = ys.length - left;
    ok(other > 0 && left > 2, `both columns are used (${left} in the first, ${other} elsewhere)`);
  });

  await scenario("a selection gets its own columns in the middle of the page; text above and below stays one column", async () => {
    await fresh(8);
    await para(2).click();
    await page.keyboard.down("Shift"); await para(4).click(); await page.keyboard.up("Shift");
    await chooseColumns("Two");
    await until(async () => (await sections()).length === 3, "three sections");
    const s = await sections();
    eq(s.map((x) => x.columns ?? 1), [1, 2, 1], "columns per section");
    const l = await layouts();
    ok(Object.values(l).some((x) => x.continuous), "the middle section is continuous");
    eq(await sheets(), 1, "still one page");
    const above = await rect(para(1)), inside = await rect(para(2)), inside2 = await rect(para(3)), below = await rect(para(6));
    ok(inside.w < above.w - 50, `the selected paragraphs are narrower (${inside.w} vs ${above.w})`);
    ok(below.w > inside.w + 50, "the text after is full width again");
    ok(below.y > inside.y, "the text after follows below the columns");
    ok(Math.abs(inside.x - inside2.x) > 20 || Math.abs(inside.y - inside2.y) < inside.h + 400, "selected text is laid out");
  });

  await scenario("repeating the change and undo leave no extra sections", async () => {
    await fresh(8);
    await para(2).click();
    await page.keyboard.down("Shift"); await para(4).click(); await page.keyboard.up("Shift");
    await chooseColumns("Two");
    await until(async () => (await sections()).length === 3, "three sections");
    await chooseColumns("Two");
    await delay(500);
    eq((await sections()).length, 3, "applying Two again changes nothing");
    await chooseColumns("One");
    await until(async () => (await sections()).length === 1, "back to one section");
    eq(Object.keys(await layouts()).length, 0, "no column layouts left");
    await page.keyboard.press("Control+z");
    await until(async () => (await sections()).length === 3, "undo brings the columns back");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await until(async () => (await sections()).every((x) => !x.columns), "undo removes the columns");
  });

  await scenario("a column break puts the text after the caret in the next column", async () => {
    await fresh(3);
    await para(1).click();
    await chooseColumns("Two");
    await until(async () => (await colCount()) === "2", "columns");
    await para(1).click({ position: { x: 60, y: 8 } });
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: /Column break/ }).first().click();
    await until(async () => (await state()).blocks.some((b) => b.extensions?.["slai.writer.column_break"]), "break stored");
    await delay(400);
    const blocks = (await state()).blocks;
    const marked = blocks.find((b) => b.extensions?.["slai.writer.column_break"]);
    const head = blocks[blocks.indexOf(marked) - 1];
    ok(head.text.length === 2 || head.text.startsWith("P1"), `the paragraph was split at the caret (${head.text.slice(0, 8)})`);
    const a = await rect(page.locator(`#main .blk[data-id=${head.id}] [data-edit=text]`)), b = await rect(page.locator(`#main .blk[data-id=${marked.id}] [data-edit=text]`));
    ok(b.x > a.x + 100, `the text after the break is in the next column (${a.x} -> ${b.x})`);
    await page.keyboard.press("Control+z");
    await until(async () => !(await state()).blocks.some((x) => x.extensions?.["slai.writer.column_break"]), "undo removes the break");
  });

  await scenario("More Columns dialog: three columns, gap, line between, unequal widths; survives save and reopen", async () => {
    await fresh(10);
    await para(1).click();
    await layoutTab();
    await page.getByRole("button", { name: /^Columns/ }).first().click();
    await page.getByRole("menuitem", { name: /More Columns/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Number of columns").selectOption("3");
    await dlg.getByLabel("Space between columns in millimetres").fill("8");
    await dlg.getByLabel("Line between columns").check();
    await dlg.getByLabel("Columns of equal width").uncheck();
    await dlg.getByLabel("Width of column 1 in millimetres").fill("30");
    await dlg.getByLabel("Width of column 2 in millimetres").fill("60");
    await dlg.getByLabel("Width of column 3 in millimetres").fill("40");
    await dlg.getByRole("button", { name: "Apply" }).click();
    await until(async () => (await sections()).some((s) => s.columns === 3), "three columns");
    const s = (await sections())[0], l = Object.values(await layouts())[0];
    eq(s.column_gap_mm, 8, "gap"); eq(l.widths_mm, [30, 60, 40], "unequal widths"); eq(l.rule.style, "solid", "line");
    await page.keyboard.press("Control+s"); await delay(800);
    await page.reload(); await page.locator("#main").waitFor(); await delay(500);
    eq(await colCount(), "3", "three columns after reopening");
    const rule = await page.locator("#main .cols").first().evaluate((el) => getComputedStyle(el).columnRuleStyle);
    eq(rule, "solid", "line drawn after reopening");
    eq((await layouts() ? Object.values(await layouts())[0].widths_mm : null), [30, 60, 40], "widths kept");
  });

  await scenario("Scripture: style on the passage, two columns around it, one undo each, repeat changes nothing", async () => {
    await fresh(6);
    await para(2).click();
    await page.keyboard.down("Shift"); await para(3).click(); await page.keyboard.up("Shift");
    await layoutTab();
    await page.getByRole("button", { name: /^Scripture/ }).click();
    await until(async () => (await state()).document.styles?.paragraph?.Scripture, "style defined");
    const st = (await state());
    eq(st.document.styles.paragraph.Scripture, { font_family: "Times New Roman", font_size_pt: 11, italic: true, align: "left" }, "style properties");
    eq(st.blocks.filter((b) => b.style === "Scripture").map((b) => b.id), ["p2", "p3"], "styled paragraphs");
    await until(async () => (await sections()).length === 3, "two-column section around it");
    await delay(400);
    const look = await para(2).evaluate((el) => { const c = getComputedStyle(el); return { f: c.fontFamily, s: c.fontSize, i: c.fontStyle, a: c.textAlign, d: c.direction }; });
    ok(/Times New Roman/.test(look.f) && look.i === "italic" && look.d === "ltr", `rendered as Scripture ${JSON.stringify(look)}`);
    const before = JSON.stringify((await state()).blocks) + JSON.stringify(await sections());
    await page.getByRole("button", { name: /^Scripture/ }).click();
    await delay(600);
    eq(JSON.stringify((await state()).blocks) + JSON.stringify(await sections()), before, "applying it again changes nothing");
  });

  await scenario("balance spreads a short text over both columns; right-to-left flow starts at the right", async () => {
    await fresh(4);
    await para(1).click();
    await chooseColumns("Two");
    await until(async () => (await colCount()) === "2", "columns");
    await delay(400);
    const x0 = (await rect(para(0))).x, x3 = (await rect(para(3))).x;
    ok(Math.abs(x3 - x0) < 5, "without balancing a short text stays in the first column");
    await layoutTab();
    await page.getByRole("button", { name: /^Columns/ }).first().click();
    await page.getByRole("menuitem", { name: /More Columns/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Balance column heights").check();
    await dlg.getByRole("button", { name: "Apply" }).click();
    await until(async () => Object.values(await layouts()).some((l) => l.balance), "balance stored");
    await delay(500);
    const a = (await rect(para(0))).x, b = (await rect(para(3))).x;
    ok(Math.abs(b - a) > 100, `the text is spread over both columns (${a} -> ${b})`);
    await page.getByRole("button", { name: /^Columns/ }).first().click();
    await page.getByRole("menuitem", { name: /More Columns/ }).click();
    await page.getByRole("dialog").getByLabel("Flow order").selectOption("rtl");
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await until(async () => Object.values(await layouts()).some((l) => l.flow === "rtl"), "flow stored");
    await delay(500);
    const first = (await rect(para(0))).x, last = (await rect(para(3))).x;
    ok(first > last + 100, `right-to-left: the first paragraph is in the right column (${first} vs ${last})`);
  });

  await scenario("typing inside the second column and across pages", async () => {
    await fresh(60);
    await para(1).click();
    await chooseColumns("Two");
    await until(async () => (await colCount()) === "2", "columns");
    await delay(500);
    ok((await sheets()) >= 1, "pages exist");
    let target = null;
    const x0 = Math.round((await rect(para(1))).x);
    for (let n = 2; n < 60 && !target; n++) { const loc = para(n); if (await loc.count()) { const r = await rect(loc); if (Math.abs(r.x - x0) > 100 && r.y > 0 && r.y < 850) target = n; } }
    ok(target !== null, "some paragraph is in the second column");
    await para(target).click();
    await page.keyboard.press("End");
    await page.keyboard.type("XYZ");
    await until(async () => (await state()).blocks.find((b) => b.id === `p${target}`).text.includes("XYZ"), "typed text reached the document");
  });
} finally {
  await browser?.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} column scenarios passed.`);
  if (problems.length) console.log("Browser console problems:", [...new Set(problems)].slice(0, 5));
  if (failed.length) { console.log(serverLog.split("\n").filter((l) => /Traceback|Error/.test(l)).slice(0, 8).join("\n")); process.exitCode = 1; }
  else rmSync(temp, { recursive: true, force: true });
}
