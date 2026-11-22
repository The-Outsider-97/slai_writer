/** Browser tests for the table of contents: style gallery, settings, update page numbers / entire table, change style, remove, auto-update on headings and column changes, undo and reopen. Real Chromium, real server. Run after `npm run build`:
 *  NODE_PATH=<dir with playwright> node tests_e2e/toc_features.mjs */
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
const temp = mkdtempSync(join(tmpdir(), "writer-toc-"));
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

const LONG = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";
async function fresh(chapters = 6, perChapter = 8) {
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
  const ops = [];
  let after = s.blocks[s.blocks.length - 1].id;
  for (let c = 1; c <= chapters; c++) {
    ops.push({ op: "block_insert", after, block: { id: `h${c}`, type: "heading", text: `Chapter ${c}`, attributes: { level: 1 } } }); after = `h${c}`;
    ops.push({ op: "block_insert", after, block: { id: `s${c}`, type: "heading", text: `Section ${c}.1`, attributes: { level: 2 } } }); after = `s${c}`;
    for (let n = 0; n < perChapter; n++) { const id = `p${c}_${n}`; ops.push({ op: "block_insert", after, block: { id, type: "paragraph", text: LONG } }); after = id; }
  }
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



const refsTab = async () => { await page.getByRole("tab", { name: "References" }).click(); await delay(100); };
const tocBlocks = async () => (await state()).blocks.filter((b) => b.extensions?.["slai.sldc.toc"]);
const tocEntries = async () => (await tocBlocks()).filter((b) => b.extensions["slai.sldc.toc"].role === "entry");
const tocTitle = async () => (await tocBlocks()).find((b) => b.extensions["slai.sldc.toc"].role === "title");
const styles = async () => (await state()).document.styles?.paragraph ?? {};
const pick = async (name) => { await page.getByRole("dialog").getByRole("radio", { name: new RegExp(`^${name}`) }).click(); };
async function insertWith(name) {
  await refsTab();
  await page.getByRole("button", { name: /^Table of contents/i }).click();
  await pick(name);
  await page.getByRole("dialog").getByRole("button", { name: "Insert" }).click();
  await until(async () => (await tocEntries()).length > 0, "entries inserted");
}

try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base); if (r.status < 500) break; } catch { /* not yet */ } await delay(100); }
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("the gallery offers the twelve styles; Modern inserts a linked table of contents", async () => {
    await fresh();
    await refsTab();
    await page.getByRole("button", { name: /^Table of contents/i }).click();
    eq(await page.getByRole("dialog").getByRole("radio").count(), 12, "twelve styles");
    const names = await page.getByRole("dialog").getByRole("radio").locator("strong").allTextContents();
    eq(names, ["Classic", "Modern", "Minimalist", "Academic", "Professional Report", "Formal", "Compact", "Elegant", "Technical Documentation", "Book / Manuscript", "Numbered Outline", "Custom"], "names in order");
    await pick("Modern");
    await page.getByRole("dialog").getByRole("button", { name: "Insert" }).click();
    await until(async () => (await tocEntries()).length === 12, "twelve entries (six chapters, six sections)");
    const entries = await tocEntries();
    ok(entries.every((e) => e.spans?.some((s) => s.type === "xref")), "every entry links to its heading");
    eq((await styles())["TOC Level 1"].font_family, "Arial", "level 1 look");
    eq((await tocTitle()).extensions["slai.writer.toc_style"].preset, "modern", "look remembered");
    ok(await page.locator("#main .blk[data-toc-entry]").count() >= 12, "entries drawn");
  });

  await scenario("page numbers are drawn from the layout and 'Update Page Numbers' changes nothing in the document", async () => {
    await fresh();
    await insertWith("Classic");
    await until(async () => (await page.locator("#main .blk[data-toc-page]").count()) > 0, "page numbers drawn", 15000);
    const pages = await page.locator("#main .blk[data-toc-entry][data-toc-page]").evaluateAll((els) => els.map((e) => Number(e.dataset.tocPage)));
    ok(Math.max(...pages) > Math.min(...pages), `later headings are on later pages (${pages})`);
    const version = (await state()).version;
    await refsTab();
    await page.getByRole("button", { name: /^Update page numbers/i }).click();
    await delay(600);
    eq((await state()).version, version, "the document is untouched");
  });

  await scenario("changing the style restyles the same entries (stable ids) and one undo goes back", async () => {
    await fresh();
    await insertWith("Classic");
    const ids = (await tocBlocks()).map((b) => b.id);
    await page.locator("#main .blk[data-toc-entry] [data-edit=text]").first().click();
    await refsTab();
    await page.getByRole("button", { name: /^Change the style/i }).click();
    await pick("Formal");
    await page.getByRole("dialog").getByRole("button", { name: "Apply style" }).click();
    await until(async () => (await tocTitle()).extensions["slai.writer.toc_style"].preset === "formal", "formal applied");
    eq((await tocBlocks()).map((b) => b.id), ids, "same block ids");
    eq((await styles())["TOC Title"].align, "center", "title centred");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.locator("#main .blk[data-id=p1_0] [data-edit=text]").click();
    await page.keyboard.press("Control+z");
    await until(async () => (await tocTitle()).extensions["slai.writer.toc_style"].preset === "classic", "undo");
  });

  await scenario("settings: leader, page-number placement, numbering, links, level formatting", async () => {
    await fresh();
    await insertWith("Classic");
    await page.locator("#main .blk[data-toc-entry] [data-edit=text]").first().click();
    await refsTab();
    await page.getByRole("button", { name: /^Edit settings/i }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Leader", { exact: true }).selectOption("dashes");
    await dlg.getByLabel("Page numbers", { exact: true }).selectOption("inline");
    await dlg.getByLabel("Number the entries like an outline (1, 1.1, 1.1.1)").check();
    await dlg.getByLabel("Level 1 size in points").fill("15");
    await dlg.getByLabel("Level 1 italic").check();
    await dlg.getByRole("button", { name: "Apply" }).click();
    await until(async () => (await tocTitle()).extensions["slai.writer.toc_style"].numbered === true, "settings stored");
    const look = (await tocTitle()).extensions["slai.writer.toc_style"];
    eq([look.leader, look.page_align, look.preset], ["dashes", "inline", "custom"], "options and custom preset");
    eq((await tocEntries())[0].text, "1 Chapter 1", "numbered");
    eq((await tocEntries())[1].text, "1.1 Section 1.1", "numbered below");
    eq((await styles())["TOC Level 1"].font_size_pt, 15, "level formatting is the style");
    await until(async () => (await page.locator('#main .blk[data-toc-entry][data-toc-painted][data-toc-leader-kind=none]').count()) > 0, "numbers right after the title have no leader");
    await dlg.waitFor({ state: "detached" });
  });

  await scenario("headings added later are picked up automatically; Update Table also works by hand", async () => {
    await fresh(3, 2);
    await insertWith("Compact");
    const before = (await tocEntries()).length;
    await page.getByRole("tab", { name: "Home" }).click();
    await page.locator("#main .blk[data-id=p3_1] [data-edit=text]").click();         // turn an ordinary paragraph into a heading, in the editor
    await page.getByLabel("Paragraph style").selectOption("h1");
    await until(async () => (await tocEntries()).length === before + 1, "automatic update", 12000);
    await page.getByRole("tab", { name: "Home" }).click();
    await page.locator("#main .blk[data-id=p3_0] [data-edit=text]").click();
    await page.getByLabel("Paragraph style").selectOption("h2");
    await until(async () => (await tocEntries()).length === before + 2, "second automatic update", 12000);
    // manual mode: the table waits until it is asked
    await page.locator("#main .blk[data-toc-entry] [data-edit=text]").first().click();
    await refsTab();
    await page.getByRole("button", { name: /^Edit settings/i }).click();
    await page.getByRole("dialog").getByLabel("Update", { exact: true }).selectOption("manual");
    await page.getByRole("dialog").getByRole("button", { name: "Apply" }).click();
    await until(async () => (await tocTitle()).extensions["slai.sldc.toc"].refresh_mode === "manual", "manual mode stored");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.getByRole("tab", { name: "Home" }).click();
    await page.locator("#main .blk[data-id=p2_1] [data-edit=text]").click();
    await page.getByLabel("Paragraph style").selectOption("h1");
    await delay(2500);
    eq((await tocEntries()).length, before + 2, "a manual table does not change by itself");
    await page.locator("#main .blk[data-toc-entry] [data-edit=text]").first().click();
    await refsTab();
    await page.getByRole("button", { name: /^Update the entire table/i }).click();
    await until(async () => (await tocEntries()).length === before + 3, "update by hand");
  });

  await scenario("page numbers follow a change of columns and a page break", async () => {
    await fresh(5, 10);
    await insertWith("Classic");
    const shown = () => page.locator("#main .blk[data-toc-entry][data-toc-page]").evaluateAll((els) => els.map((e) => Number(e.dataset.tocPage)));
    const measured = async () => page.evaluate(async (id) => {
      const j = await (await fetch(`/api/docs/${id}/layout`, { headers: { "X-SLAI-Writer": "1" } })).json();
      return { version: j.data.version, labels: j.data.blockLabels };
    }, sid);
    await until(async () => (await shown()).length > 0, "page numbers drawn", 15000);
    await page.locator("#main .blk[data-id=p1_0] [data-edit=text]").click();
    await page.getByRole("tab", { name: "Layout" }).click();
    await page.getByRole("button", { name: /^Columns/ }).first().click();
    await page.getByRole("menuitem", { name: "Two" }).click();
    await until(async () => (await state()).document.sections?.some((x) => x.columns === 2), "two columns stored");
    const sameAsLayout = async () => {
      const m = await measured();
      if (m.version !== (await state()).version) return false;
      const entries = (await tocEntries()).map((e) => String(m.labels[e.extensions["slai.sldc.toc"].heading]));
      return JSON.stringify((await shown()).map(String)) === JSON.stringify(entries);
    };
    await until(sameAsLayout, "the numbers are the ones the exact layout reports", 20000);
    const before = await shown();
    await page.locator("#main .blk[data-id=h2] [data-edit=text]").click();
    await page.getByRole("button", { name: /^Breaks/ }).click();
    await page.getByRole("menuitem", { name: "Page break" }).click();
    await until(async () => (await state()).blocks.find((b) => b.id === "h2").attributes?.page_break_before === true, "page break stored");
    await until(async () => (await sameAsLayout()) && (await shown()).some((n, i) => n !== before[i]), "numbers follow the page break", 20000);
  });

  await scenario("remove leaves the headings; save and reopen keeps a table of contents", async () => {
    await fresh(3, 2);
    await insertWith("Elegant");
    await page.keyboard.press("Control+s"); await delay(800);
    await page.reload(); await page.locator("#main").waitFor(); await delay(600);
    ok((await tocEntries()).length > 0, "still there after reopening");
    eq((await tocTitle()).extensions["slai.writer.toc_style"].preset, "elegant", "style kept");
    await page.locator("#main .blk[data-toc-entry] [data-edit=text]").first().click();
    await refsTab();
    await page.getByRole("button", { name: /^Remove the table/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await until(async () => (await tocBlocks()).length === 0, "table removed");
    eq((await state()).blocks.filter((b) => b.type === "heading").length, 6, "headings kept");
  });
} finally {
  await browser?.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} table-of-contents scenarios passed.`);
  if (problems.length) console.log("Browser console problems:", [...new Set(problems)].slice(0, 5));
  if (failed.length) { console.log(serverLog.split("\n").filter((l) => /Traceback|Error/.test(l)).slice(0, 8).join("\n")); process.exitCode = 1; }
  else rmSync(temp, { recursive: true, force: true });
}
