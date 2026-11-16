/** Browser regression for the table defect: real Chromium, live Writer server and DOM events.
 * Run after build with NODE_PATH pointing to Playwright: node tests_e2e/table_editor.mjs */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(app, "../..");
const require = createRequire(import.meta.url);
const { chromium } = process.env.NODE_PATH ? require(join(process.env.NODE_PATH, "playwright")) : require("playwright");
const temp = mkdtempSync(join(tmpdir(), "writer-table-"));
const config = join(temp, "config.yaml");
writeFileSync(config, readFileSync(join(app, "configs/config.yaml"), "utf8")
  .replace('library_root: ""', `library_root: "${join(temp, "library")}"`));
const port = await new Promise((yes, no) => {
  const socket = net.createServer();
  socket.on("error", no);
  socket.listen(0, "127.0.0.1", () => { const address = socket.address(); socket.close(() => yes(address.port)); });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["-m", "applications.slai_writer", "--data-dir", join(temp, "data"),
  "--port", String(port), "--token", "table-e2e-token", "--no-browser", "--config", config],
{ cwd: root, env: { ...process.env, PYTHONPATH: root }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (bytes) => { serverLog += bytes.toString(); });
server.stderr.on("data", (bytes) => { serverLog += bytes.toString(); });
let browser;
let page;
const delay = (ms) => new Promise((yes) => setTimeout(yes, ms));
const until = async (fn, label) => {
  for (let n = 0; n < 70; n++) { const result = await fn().catch(() => null); if (result) return result; await delay(100); }
  throw new Error(`Timed out: ${label}`);
};
const assert = (ok, label) => { if (!ok) throw new Error(label); };
try {
  await until(async () => { const r = await fetch(base); return r.status < 500; }, "server startup");
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(`${base}/?token=table-e2e-token`);
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await page.getByRole("button", { name: "New Page" }).first().click();
  await page.getByRole("button", { name: "Create document" }).click();
  await page.locator("#main").waitFor();
  await page.waitForFunction(() => document.activeElement?.closest?.(".sheets"));   // the page takes the focus a frame after it appears
  await page.keyboard.type("Timeline");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await page.locator(".slash").waitFor();
  await page.keyboard.type("table");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: /insert|create/i }).first().click();
  const cell = page.locator("#main table.tbl .cell").first();
  await cell.waitFor();
  const docId = page.url().split("/doc/")[1];
  const state = async () => page.evaluate(async (id) => {
    const response = await fetch(`/api/docs/${id}`, { headers: { "X-SLAI-Writer": "1" } });
    return (await response.json()).data;
  }, docId);
  const table = async () => (await state()).blocks.find((b) => b.type === "table");
  await cell.click();
  await page.keyboard.type("Dedicated development timeline for SLAI Writer", { delay: 4 });
  await until(async () => (await table())?.table.rows[0][0].text === "Dedicated development timeline for SLAI Writer", "continuous typing inside the first cell");
  assert(!(await state()).blocks.some((b) => b.type === "paragraph" && b.text.includes("development timeline")), "text escaped to paragraph");
  console.log("PASS continuous typing stays in a cell");

  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second line");
  await until(async () => (await table())?.table.rows[0][0].text.includes("\nSecond line"), "Enter within a cell");
  console.log("PASS Enter inserts a line inside the cell");

  await cell.click();
  await cell.evaluate((el) => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "First\nSecond");
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await until(async () => (await table())?.table.rows[0][0].text.includes("First\nSecond"), "multiline clipboard paste");
  console.log("PASS multiline paste stays in a cell");

  const other = page.locator("#main table.tbl .cell").nth(1);
  await other.click();
  await other.evaluate((el) => {
    const transfer = new DataTransfer(); transfer.setData("text/plain", "A\tB\nC\tD");
    el.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await until(async () => {
    const t = (await table())?.table;
    return t?.rows[0][1].text === "A" && t?.rows[0][2].text === "B" && t?.rows[1][1].text === "C" && t?.rows[1][2].text === "D";
  }, "spreadsheet TSV paste");
  console.log("PASS TSV paste populates cells");

  const current = page.locator("#main table.tbl .cell").first();
  const bounds = await current.boundingBox();
  await page.mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width + 25, bounds.y + bounds.height / 2, { steps: 6 }); await page.mouse.up();
  await until(async () => (await table())?.extensions?.["slai.writer.table_layout"]?.column_widths_mm, "column border resizing");
  console.log("PASS column gridline resizing persisted");

  const b2 = await page.locator("#main table.tbl .cell").first().boundingBox();
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height - 3);
  await page.mouse.down(); await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height + 25, { steps: 6 }); await page.mouse.up();
  await until(async () => (await table())?.extensions?.["slai.writer.table_layout"]?.row_heights_mm, "row border resizing");
  console.log("PASS row gridline resizing persisted");
} catch (error) {
  console.error(error);
  if (page) { try { await page.screenshot({ path: join(temp, "table_failure.png") }); console.error(`Failure screenshot: ${join(temp, "table_failure.png")}`); } catch {} }
  if (serverLog) console.error("Server error tail:", serverLog.slice(-900));
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
  if (!process.exitCode) rmSync(temp, { recursive: true, force: true });
}
