/** Browser test for table fidelity: the same table looks the same in the editing view (what Chromium draws), in the Rendered View (the pictures of the
 *  exported PDF) and in the PDF the server exports. Real Chromium, real server, real PDF.
 *
 *  Every table is judged against Writer's own resolution of its style (`table_styles.export_look`), by looking at pixels: the editor's by a screenshot of the
 *  table, the others by what poppler draws or by a screenshot of the Rendered View. `tests/pixel_cli.py` does the looking; it uses the probe that also checks
 *  the Word, OpenDocument and RTF files drawn by LibreOffice.
 *    NODE_PATH=<dir with playwright> node tests_e2e/table_fidelity.mjs */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, runner, chromium, until, ok, eq, delay, root } from "./harness.mjs";

const server = await startServer("tblfid");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];
const work = mkdtempSync(join(tmpdir(), "tblfid-"));
const ROWS = 5, COLS = 4;

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const op = async (o) => { const r = await api("POST", `/docs/${sid}/ops`, { op: o }); ok(r.status < 300, `op ${o.op} failed: ${JSON.stringify(r.body).slice(0, 300)}`); return r; };
const renderedButton = () => page.locator(".sbtn.rendered-toggle");

const grid = () => ({ columns: COLS, header_rows: 1, rows: Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => ({ text: `r${r}c${c}` }))) });
const STYLE = "slai.writer.table_style", CELLS = "slai.writer.table_cells", BORDERS = "slai.writer.table_borders";
const TABLES = [
  ["dark header", { [STYLE]: { preset: "dark_header" } }],
  ["alternating rows", { [STYLE]: { preset: "alternating_rows" } }],
  ["professional report", { [STYLE]: { preset: "professional_report" } }],
  ["by hand", { [STYLE]: { preset: "simple_grid", accent: "#C0392B" }, [CELLS]: { "1,0": { background: "#FFEE00" } },
    [BORDERS]: { h: { "1,1": { color: "#FF0000", width_pt: 2, style: "solid" }, "3,2": null }, v: { "2,2": { color: "#00AA00", width_pt: 1.5, style: "solid" } } } }],
];

async function fresh() {
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  state.page = page;
  page.setDefaultTimeout(10000);
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
  let after = s.blocks[s.blocks.length - 1].id;
  const ops = TABLES.map(([, extensions], n) => {
    const o = { op: "block_insert", after, block: { id: `t${n}`, type: "table", text: "", table: grid(), extensions, attributes: { page_break_before: n > 0 } } };
    after = `t${n}`;
    return o;
  });
  await op({ op: "batch", ops });
  await page.reload(); await page.locator("#main").waitFor(); await delay(800);
}

/** Screenshot of table ``n`` in the editing view, with where the text of every cell is (in points from the screenshot's corner). */
async function editorShot(n) {
  const table = page.locator("#main table").nth(n);
  await table.scrollIntoViewIfNeeded();
  await page.mouse.move(2, 2);                                        // keep the pointer (and its hover colours) out of the table
  await delay(150);
  const info = await table.evaluate((el) => {
    const pad = 12, box = el.getBoundingClientRect();
    const words = {};
    for (const cell of el.querySelectorAll("[data-edit=cell]")) {
      const range = document.createRange();
      range.selectNodeContents(cell);
      const r = range.getBoundingClientRect();
      words[`r${cell.dataset.row}c${cell.dataset.col}`] = { x0: (r.left - box.left + pad) * 0.75, x1: (r.right - box.left + pad) * 0.75, top: (r.top - box.top + pad) * 0.75, bottom: (r.bottom - box.top + pad) * 0.75 };
    }
    return { clip: { x: Math.max(0, box.left - pad), y: Math.max(0, box.top - pad), width: box.width + 2 * pad, height: box.height + 2 * pad }, words, offsetX: box.left - Math.max(0, box.left - pad), offsetY: box.top - Math.max(0, box.top - pad) };
  });
  ok(info.offsetX === 12 && info.offsetY === 12, `the table is not clear of the viewport edge (${info.offsetX}, ${info.offsetY})`);
  const png = join(work, `editor-${n}-${Date.now()}.png`);
  await page.screenshot({ path: png, clip: info.clip });
  return { png, words: info.words };
}
async function pdfFile(tag) {
  const base64 = await page.evaluate(async (id) => {
    const r = await fetch(`/api/docs/${id}/download`, { method: "POST", headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: JSON.stringify({ format: "pdf" }) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, sid);
  const path = join(work, `${tag}.pdf`);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
}
async function renderedShot(n) {
  const img = page.locator(`.rendered .rv-page[data-page="${n + 1}"] img`);
  await img.scrollIntoViewIfNeeded();
  await until(() => img.evaluate((el) => el.complete && el.naturalWidth > 0), `rendered page ${n + 1} loaded`);
  await delay(300);
  const png = join(work, `rendered-${n}-${Date.now()}.png`);
  await img.screenshot({ path: png });
  return png;
}
async function judge(items) {
  const d = await doc();
  const custom = ((d.extensions ?? {})["slai.writer"] ?? {}).table_styles ?? {};
  const input = join(work, `items-${Date.now()}.json`);
  writeFileSync(input, JSON.stringify(items.map((i) => ({ rows: ROWS, columns: COLS, custom, block: d.blocks.find((b) => b.id === i.id), ...i }))));
  const out = execFileSync("python3", ["-m", "applications.slai_writer.tests.pixel_cli", input], { cwd: root, env: { ...process.env, PYTHONPATH: root }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
const none = (found, what) => eq(found, [], `${what}: the drawn tables differ from the resolved style`);

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });
  await fresh();

  await scenario("the editing view draws every table as its style resolves (Chromium's own pixels)", async () => {
    const items = [];
    for (let n = 0; n < TABLES.length; n++) { const shot = await editorShot(n); items.push({ label: `editor: ${TABLES[n][0]}`, id: `t${n}`, png: shot.png, scale: 2 / 0.75, words: shot.words }); }
    none(await judge(items), "editing view");
  });

  await scenario("the exported PDF (from the running server) and the Rendered View show the same look", async () => {
    const pdf = await pdfFile("a");
    none(await judge(TABLES.map(([label], n) => ({ label: `pdf: ${label}`, id: `t${n}`, pdf, pdf_page: n + 1 }))), "PDF");
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    const items = [];
    for (let n = 0; n < TABLES.length; n++) items.push({ label: `rendered: ${TABLES[n][0]}`, id: `t${n}`, pdf, pdf_page: n + 1, png: await renderedShot(n), tolerance: 50 });
    none(await judge(items), "Rendered View");
    await page.keyboard.press("Escape");
    await page.locator(".rendered").waitFor({ state: "detached" });
  });

  await scenario("a style chosen after the table was inserted reaches the editor, the PDF and the Rendered View; undo brings the old look back", async () => {
    const before = (await doc()).blocks.find((b) => b.id === "t1").extensions[STYLE];
    const cell = page.locator('#main [data-edit=cell][data-row="1"][data-col="1"]').nth(1);          // the second table, picked in the editor like a person would
    await cell.scrollIntoViewIfNeeded();
    await cell.click();
    await page.locator(".ribbon-tab", { hasText: "Table Design" }).click();
    await page.locator(".format-ribbon:visible .gallery-current").click();
    await page.locator(".table-gallery .gallery-tile", { hasText: "Financial" }).click();
    await until(async () => (await doc()).blocks.find((b) => b.id === "t1").extensions[STYLE].preset === "financial", "the style is saved");
    await delay(500);
    const shot = await editorShot(1);
    none(await judge([{ label: "editor after the change", id: "t1", png: shot.png, scale: 2 / 0.75, words: shot.words }]), "editor after the change");
    const pdf = await pdfFile("b");
    none(await judge([{ label: "pdf after the change", id: "t1", pdf, pdf_page: 2 }]), "PDF after the change");
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    none(await judge([{ label: "rendered after the change", id: "t1", pdf, pdf_page: 2, png: await renderedShot(1), tolerance: 50 }]), "Rendered View after the change");
    await page.keyboard.press("Escape");
    await page.locator(".rendered").waitFor({ state: "detached" });
    await page.locator("#main [data-edit=cell]").nth(0).click();
    await page.keyboard.press("Control+z");
    await until(async () => JSON.stringify((await doc()).blocks.find((b) => b.id === "t1").extensions[STYLE]) === JSON.stringify(before), "undo restores the style");
    await delay(500);
    const again = await editorShot(1);
    none(await judge([{ label: "editor after undo", id: "t1", png: again.png, scale: 2 / 0.75, words: again.words }]), "editor after undo");
  });

  await scenario("the look survives saving and opening the document again", async () => {
    const saved = await api("POST", `/docs/${sid}/save`, {});
    ok(saved.status < 300, "save " + JSON.stringify(saved.body).slice(0, 200));
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    const items = [];
    for (let n = 0; n < TABLES.length; n++) { const shot = await editorShot(n); items.push({ label: `reopened: ${TABLES[n][0]}`, id: `t${n}`, png: shot.png, scale: 2 / 0.75, words: shot.words }); }
    none(await judge(items), "reopened editing view");
    const pdf = await pdfFile("c");
    none(await judge(TABLES.map(([label], n) => ({ label: `reopened pdf: ${label}`, id: `t${n}`, pdf, pdf_page: n + 1 }))), "reopened PDF");
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}
