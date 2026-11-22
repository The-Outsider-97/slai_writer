/** Writing-experience measurements: how long the editor takes to answer a keystroke, Enter, Backspace, paste, undo, a style change, find and a scroll, in
 *  documents of 2, 12 and 50 pages. Real Chromium, real server, fixed viewport, fixed content (nothing random), so two runs are comparable.
 *    NODE_PATH=<dir with playwright> node tests_e2e/writing_perf.mjs [--out file.json] [--sizes 20,150,600]
 *  The figures are milliseconds from the key being pressed to the next painted frame (keystrokes) or to the DOM showing the result (structural edits). */
import { writeFileSync } from "node:fs";
import { startServer, chromium, until, delay } from "./harness.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const out = flag("--out", "");
const sizes = flag("--sizes", "20,150,600").split(",").map(Number);

const server = await startServer("perf");
const browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });
const results = { chromium: browser.version(), viewport: "1500x950", at: new Date().toISOString().slice(0, 10), sizes: {} };

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +s.at(-1).toFixed(1) };
};

async function open(paragraphs) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.setDefaultTimeout(30000);
  await page.goto(`${server.base}/?token=${server.token}`);
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await page.getByRole("button", { name: "New Page" }).first().click();
  await page.getByRole("button", { name: "Create document" }).click();
  await page.locator("#main").waitFor();
  await until(async () => page.url().includes("/doc/"), "doc url");
  const sid = page.url().split("/doc/")[1];
  const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
    const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, { method, url, body });
  const s = (await api("GET", `/docs/${sid}`)).body.data;
  let after = s.blocks[0].id;
  for (let from = 1; from < paragraphs; from += 200) {
    const ops = [];
    for (let n = from; n < Math.min(paragraphs, from + 200); n++) {
      const id = `p${n}`;
      const kind = n % 25 === 0 ? { type: "heading", attributes: { level: 1 }, text: `Chapter ${n / 25}` } : { type: "paragraph", text: `Paragraph ${n + 1}. ` + "The quick brown fox jumps over the lazy dog and keeps writing. ".repeat(3 + (n % 5)) };
      ops.push({ op: "block_insert", after, block: { id, ...kind } });
      after = id;
    }
    const r = await api("POST", `/docs/${sid}/ops`, { op: { op: "batch", ops } });
    if (r.status >= 300) throw new Error("setup failed " + JSON.stringify(r.body).slice(0, 200));
  }
  const t0 = Date.now();
  await page.reload();
  await page.locator(".sheets .sheet").first().waitFor();
  await until(async () => page.evaluate(() => document.querySelectorAll(".sheets .sheet").length > 0), "sheets", 60000);
  const openMs = Date.now() - t0;
  await delay(1500);
  const sheets = await page.evaluate(() => document.querySelectorAll(".sheets .sheet").length);
  return { page, sid, api, openMs, sheets };
}

/** Install the in-page probes: keydown time, then the first frame painted after the matching input. */
async function probes(page) {
  await page.evaluate(() => {
    window.__lat = [];
    let down = 0;
    document.addEventListener("keydown", () => { down = performance.now(); }, true);
    document.addEventListener("input", () => { const t = down; requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - t))); }, true);
  });
}
const take = (page) => page.evaluate(() => { const v = window.__lat; window.__lat = []; return v; });

for (const paragraphs of sizes) {
  const { page, sid, api, openMs, sheets } = await open(paragraphs);
  const row = { paragraphs, sheets, openMs };
  await probes(page);
  const middle = page.locator(`[data-id='p${Math.floor(paragraphs / 2)}'] [data-edit='text']`).first();
  await middle.scrollIntoViewIfNeeded();
  await middle.click();
  await page.keyboard.press("End");
  await delay(300);

  // typing: 80 characters at full speed
  await take(page);
  await page.keyboard.type("Typing into a long document is measured here, one key at a time.", { delay: 0 });
  await delay(400);
  row.typing = stats(await take(page));

  // Enter, Backspace (merge), at the same place
  const timed = async (label, fn, ready) => {
    const start = Date.now();
    await fn();
    await until(ready, label, 20000);
    return Date.now() - start;
  };
  const count = () => page.evaluate(() => document.querySelectorAll(".sheets [data-edit='text']").length);
  const before = await count();
  row.enterMs = await timed("enter", () => page.keyboard.press("Enter"), async () => (await count()) === before + 1);
  row.backspaceMergeMs = await timed("merge", async () => { await page.keyboard.press("Backspace"); }, async () => (await count()) === before);
  await delay(300);

  // undo and redo of the last typing
  row.undoMs = await timed("undo", () => page.keyboard.press("Control+z"), async () => true);
  await delay(300);
  row.redoMs = await timed("redo", () => page.keyboard.press("Control+y"), async () => true);
  await delay(300);

  // paste five paragraphs
  row.pasteMs = await page.evaluate(async () => {
    const t0 = performance.now();
    const data = new DataTransfer();
    data.setData("text/plain", Array.from({ length: 5 }, (_, i) => `Pasted paragraph ${i + 1}. ` + "More words to paste. ".repeat(6)).join("\n\n"));
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t0;
  });
  await delay(600);

  // scrolling: frame times while the wheel runs the length of the document
  row.scroll = await page.evaluate(async () => {
    const sc = document.querySelector(".scroller");
    const frames = [];
    let last = performance.now(), run = true;
    const tick = (t) => { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const total = sc.scrollHeight - sc.clientHeight, steps = 60;
    for (let i = 0; i <= steps; i++) { sc.scrollTop = (total * i) / steps; await new Promise((r) => setTimeout(r, 16)); }
    run = false;
    const s = frames.slice(2).sort((a, b) => a - b);
    return { frames: s.length, p50: +s[Math.floor(s.length / 2)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), over50ms: s.filter((x) => x > 50).length };
  });

  // a paragraph style change on the paragraph with the caret: through the ribbon
  await middle.scrollIntoViewIfNeeded(); await middle.click();
  const style = page.getByLabel("Paragraph style").first();
  if (await style.count()) {
    const t0 = Date.now();
    await style.selectOption({ label: "Heading 2" }).catch(() => {});
    await until(async () => page.evaluate(() => !!document.querySelector(".sheets .t-heading")), "style applied", 20000).catch(() => {});
    row.styleMs = Date.now() - t0;
  }

  // find: type a word that occurs often and wait for the count
  const search = page.getByRole("searchbox").first();
  if (await search.count()) {
    const t0 = Date.now();
    await search.fill("quick brown");
    await until(async () => page.evaluate(() => /\d/.test(document.querySelector(".find-count, [data-find-count]")?.textContent ?? "")), "find count", 20000).catch(() => {});
    row.findMs = Date.now() - t0;
  }
  results.sizes[paragraphs] = row;
  console.log(JSON.stringify(row));
  await page.close();
}

await browser.close();
server.stop();
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
console.log("done");
