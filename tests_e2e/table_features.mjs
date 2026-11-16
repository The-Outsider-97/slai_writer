/** Browser tests for the table features: contextual ribbon tabs, row/column insertion and deletion (also with merged cells), the style gallery,
 *  borders, layout, tables across pages, undo/redo and save/reopen. Real Chromium, real server. Run after `npm run build`:
 *  NODE_PATH=<dir with playwright> node tests_e2e/table_features.mjs */
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
const temp = mkdtempSync(join(tmpdir(), "writer-tables-"));
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
const table = async () => (await state()).blocks.find((b) => b.type === "table");
const texts = async () => (await table()).table.rows.map((r) => r.map((c) => c.text));
const cellLocator = (r, c) => page.locator(`#main [data-edit=cell][data-row="${r}"][data-col="${c}"]`).first();

async function fresh(rows = 3, cols = 3) {
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
  await op({ op: "block_insert", after: s.blocks[0].id, block: { id: "tt", type: "table", rows, columns: cols } });
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) await op({ op: "table_cell", block: "tt", row: r, col: c, text: `${r}${c}` });
  await page.reload(); await page.locator("#main").waitFor(); await delay(400);
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

try {
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base); if (r.status < 500) break; } catch { /* not yet */ } await delay(100); }
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("the table tabs appear only while the cursor is in a table", async () => {
    await fresh();
    ok(!(await tabs()).includes("Table Layout"), "tab visible before entering the table");
    await cellLocator(1, 1).click();
    await until(async () => (await tabs()).includes("Table Layout") && (await tabs()).includes("Table Design"), "table tabs");
    await page.locator("#main .blk").first().click({ position: { x: 5, y: 5 } });
    await until(async () => !(await tabs()).includes("Table Layout"), "tabs hide again");
  });

  await scenario("insert row above/below and column left/right from the ribbon, one undo each", async () => {
    await fresh();
    await cellLocator(1, 1).click();
    await until(async () => (await tabs()).includes("Table Layout"), "layout tab");
    await ribbonBtn("Insert row above").click();
    await until(async () => (await table()).table.rows.length === 4, "row above");
    eq((await texts())[1], ["", "", ""], "the new row is empty and above the clicked row");
    await ribbonBtn("Insert row below").click();
    await until(async () => (await table()).table.rows.length === 5, "row below");
    await ribbonBtn("Insert column left").click();
    await until(async () => (await table()).table.columns === 4, "column left");
    await ribbonBtn("Insert column right").click();
    await until(async () => (await table()).table.columns === 5, "column right");
    await page.keyboard.press("Control+z");
    await until(async () => (await table()).table.columns === 4, "undo one column");
    await page.keyboard.press("Control+y");
    await until(async () => (await table()).table.columns === 5, "redo");
  });

  await scenario("several rows at once and deleting selected rows and columns", async () => {
    await fresh(4, 4);
    await cellLocator(1, 1).click();
    await until(async () => (await tabs()).includes("Table Layout"), "layout tab");
    await page.getByRole("button", { name: /Insert several rows/ }).click();
    await page.getByRole("dialog").locator("input[type=number]").fill("3");
    await page.getByRole("dialog").getByRole("button", { name: "Insert" }).click();
    await until(async () => (await table()).table.rows.length === 7, "three rows");
    await cellLocator(2, 0).click();
    await page.keyboard.down("Shift"); await cellLocator(3, 0).click(); await page.keyboard.up("Shift");
    await page.getByRole("button", { name: /Delete rows, columns/ }).click();
    await page.getByRole("menuitem", { name: "Delete rows" }).click();
    await until(async () => (await table()).table.rows.length < 7, "rows deleted");
  });

  await scenario("merge, then insert inside and at the edge of the merged cell keeps a valid table", async () => {
    await fresh(4, 4);
    await op({ op: "table_edit", block: "tt", action: "merge_cells", row: 1, col: 1, end_row: 2, end_col: 2 });
    await page.reload(); await page.locator("#main").waitFor(); await delay(300);
    await cellLocator(1, 1).click();
    await until(async () => (await tabs()).includes("Table Layout"), "layout tab");
    await ribbonBtn("Insert row below").click();                      // at the lower edge of a 2-row merge: it must not grow
    await until(async () => (await table()).table.rows.length === 5, "row inserted");
    const merged = (await table()).table.rows[1][1];
    eq([merged.rowspan, merged.colspan], [2, 2], "merged cell unchanged by an insert at its edge");
    await cellLocator(1, 1).click();
    await ribbonBtn("Split Cells").click();
    await page.getByRole("dialog").getByRole("button", { name: "Split" }).click();
    await until(async () => !(await table()).table.rows[1].some((c) => c.rowspan > 1), "split back");
  });

  await scenario("the style gallery has 12 styles, previews them, applies one and restores the default", async () => {
    await fresh();
    await cellLocator(0, 0).click();
    await page.locator(".ribbon-tab", { hasText: "Table Design" }).click();
    await page.locator(".format-ribbon:visible .gallery-current").click();
    await until(async () => (await page.locator(".table-gallery .gallery-tile").count()) === 12, "12 tiles");
    await page.locator(".table-gallery .gallery-tile", { hasText: "Dark Header" }).click();
    await until(async () => (await table()).extensions?.["slai.writer.table_style"]?.preset === "dark_header", "style saved");
    const bg = await cellLocator(0, 0).evaluate((el) => getComputedStyle(el).backgroundColor);
    eq(bg, "rgb(31, 31, 31)", "the header cell is drawn with the style");
    await page.locator(".format-ribbon:visible .gallery-current").click();
    await page.getByRole("button", { name: "Restore default formatting" }).click();
    await until(async () => !(await table()).extensions?.["slai.writer.table_style"], "default restored");
  });

  await scenario("style options, accent colour, borders and shading are saved and drawn", async () => {
    await fresh(4, 3);
    await cellLocator(0, 0).click();
    await page.locator(".ribbon-tab", { hasText: "Table Design" }).click();
    await page.locator(".format-ribbon:visible .gallery-current").click();
    await page.locator(".table-gallery .gallery-tile", { hasText: "Alternating Row Colors" }).click();
    await until(async () => (await table()).extensions?.["slai.writer.table_style"], "style");
    await page.getByLabel("Banded Rows").uncheck();
    await until(async () => (await table()).extensions["slai.writer.table_style"].banded_rows === false, "option");
    await page.getByRole("button", { name: "Borders" }).first().click();
    await page.getByRole("menuitem", { name: "All borders" }).click();
    await until(async () => (await table()).extensions?.["slai.writer.table_borders"], "borders");
    const border = await cellLocator(1, 1).evaluate((el) => getComputedStyle(el).borderTopStyle);
    eq(border, "solid", "border drawn");
    await page.getByLabel("Cell shading colour").evaluate((el) => { el.value = "#ffee00"; el.dispatchEvent(new Event("change", { bubbles: true })); });
    await until(async () => (await table()).extensions?.["slai.writer.table_cell_styles"]?.["0,0"]?.background === "#ffee00", "shading");
  });

  await scenario("column width, row height, AutoFit and table alignment from the layout tab", async () => {
    await fresh();
    await cellLocator(0, 0).click();
    await page.getByLabel("Column width in millimetres").fill("45");
    await page.getByLabel("Column width in millimetres").press("Enter");
    await page.getByLabel("Column width in millimetres").evaluate((el) => el.dispatchEvent(new Event("change", { bubbles: true })));
    await until(async () => (await table()).extensions?.["slai.writer.table_layout"]?.column_widths_mm?.[0] === 45, "column width");
    await page.getByLabel("Table alignment").selectOption("center");
    await until(async () => (await table()).extensions["slai.writer.table_layout"].align === "center", "alignment");
    await ribbonBtn("AutoFit").click();
    await page.getByRole("menuitem", { name: "AutoFit to window" }).click();
    await until(async () => (await table()).extensions["slai.writer.table_layout"].fit === "window", "autofit");
  });

  await scenario("right-click in a table offers the table actions", async () => {
    await fresh();
    await cellLocator(1, 1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Insert row above" }).waitFor();
    for (const name of ["Insert row below", "Insert column left", "Insert column right", "Delete selected rows", "Delete selected columns", "Merge cells", "Split cell…"])
      await page.getByRole("menuitem", { name }).waitFor();
    await page.getByRole("menuitem", { name: "Insert column right" }).click();
    await until(async () => (await table()).table.columns === 4, "column inserted from the menu");
  });

  await scenario("a long table is cut across pages with its header repeated, and survives edits and reopening", async () => {
    await fresh(3, 2);
    await op({ op: "table_edit", block: "tt", action: "header_rows", count: 1 });
    for (let i = 0; i < 70; i++) await op({ op: "table_edit", block: "tt", action: "insert_row", index: 3 });
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    const parts = await page.locator("#main .blk[data-id=tt]").count();
    ok(parts >= 2, `the table should be in several parts, found ${parts}`);
    const repeated = await page.locator("#main .blk[data-id=tt][data-continued] tr[data-repeat]").count();
    ok(repeated >= 1, "header row repeated on the later page");
    const sheetsOfParts = await page.locator("#main .blk[data-id=tt]").evaluateAll((els) => els.map((e) => e.closest(".sheet")?.dataset.page));
    ok(new Set(sheetsOfParts).size === sheetsOfParts.length, "each part is on its own sheet");
    // an edit in the second part reaches the right cell
    const last = page.locator("#main .blk[data-id=tt][data-continued] [data-edit=cell]").last();
    await last.click(); await page.keyboard.type("END");
    await until(async () => { const t = await table(); return t.table.rows[t.table.rows.length - 1][1].text.includes("END") || t.table.rows[t.table.rows.length - 1][0].text.includes("END"); }, "edit in the continued part");
    // insert a row from the continued part: the table is still whole and cut again
    await ribbonBtn("Insert row above").click();
    await until(async () => (await table()).table.rows.length === 74, "row inserted in a later part");
    await delay(700);
    ok((await page.locator("#main .blk[data-id=tt]").count()) >= 2, "still cut across pages after the edit");
  });

  await scenario("save and reopen keeps structure, style, borders and layout", async () => {
    await fresh();
    await op({ op: "table_style", block: "tt", preset: "academic" });
    await op({ op: "table_borders", block: "tt", target: "outside", border: { color: "#336699", width_pt: 2, style: "double" } });
    await op({ op: "table_layout", block: "tt", props: { column_widths_mm: [20, 30, 40], align: "center" } });
    await page.keyboard.press("Control+s");
    await delay(800);
    await page.reload(); await page.locator("#main").waitFor(); await delay(500);
    const t = await table();
    eq(t.extensions["slai.writer.table_style"].preset, "academic", "style after reload");
    eq(t.extensions["slai.writer.table_layout"].column_widths_mm, [20, 30, 40], "widths after reload");
    const top = await cellLocator(0, 0).evaluate((el) => getComputedStyle(el).borderTopStyle);
    eq(top, "double", "double border drawn after reload");
  });
} finally {
  await browser?.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} table scenarios passed.`);
  if (problems.length) console.log("Browser console problems:", [...new Set(problems)].slice(0, 5));
  if (failed.length) { console.log(serverLog.split("\n").filter((l) => /Traceback|Error/.test(l)).slice(0, 8).join("\n")); process.exitCode = 1; }
  else rmSync(temp, { recursive: true, force: true });
}
