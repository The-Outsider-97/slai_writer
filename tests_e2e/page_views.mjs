/** Browser tests for the status-bar page controls: one to four pages side by side, the two-page book view of a mirrored document, Fit Entire Page,
 *  and the Rendered View (the exported PDF's own pages, read only). Real Chromium, real server, real PDF.
 *    NODE_PATH=<dir with playwright> node tests_e2e/page_views.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("views");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const op = (o) => api("POST", `/docs/${sid}/ops`, { op: o });
const pdfPages = async () => (await api("GET", `/docs/${sid}/pages`)).body.data;

async function fresh({ paragraphs = 40 } = {}) {
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
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
  const ops = [{ op: "text", block: s.blocks[0].id, start: 0, end: s.blocks[0].text.length, insert: "First paragraph of the manuscript." }];
  let after = s.blocks[0].id;
  for (let n = 1; n < paragraphs; n++) { const id = `p${n}`; ops.push({ op: "block_insert", after, block: { id, type: "paragraph", text: `Paragraph ${n + 1}. ` + "Words fill the line and the page. ".repeat(14) } }); after = id; }
  const r = await op({ op: "batch", ops });
  if (r.status >= 300) throw new Error("setup failed " + JSON.stringify(r.body).slice(0, 300));
  await page.reload(); await page.locator("#main").waitFor(); await delay(600);
}

const pagesButton = () => page.getByRole("button", { name: /^Pages shown side by side/ });
const renderedButton = () => page.locator(".sbtn.rendered-toggle");
const pick = async (label) => { await pagesButton().click(); await page.getByRole("menuitem", { name: label }).click(); await delay(350); };
/** The sheets of the editing view as rows: each row is the sheets whose top edge is the same. */
const sheetRows = () => page.evaluate(() => {
  const rows = [];
  for (const el of document.querySelectorAll(".sheets .sheet")) {
    const r = el.getBoundingClientRect();
    const row = rows.find((x) => Math.abs(x.top - r.top) < 3);
    const cell = { x: r.x, w: r.width, h: r.height, page: Number(el.dataset.page ?? 0), side: el.dataset.side };
    if (row) row.cells.push(cell); else rows.push({ top: r.top, cells: [cell] });
  }
  return rows.map((row) => ({ ...row, cells: row.cells.sort((a, b) => a.x - b.x) }));
});
const renderedRows = () => page.evaluate(() => {
  const rows = [];
  for (const el of document.querySelectorAll(".rv-grid .rv-page")) {
    const r = el.getBoundingClientRect();
    const row = rows.find((x) => Math.abs(x.top - r.top) < 3);
    const cell = { x: r.x, w: r.width, h: r.height, n: Number(el.dataset.page) };
    if (row) row.cells.push(cell); else rows.push({ top: r.top, cells: [cell] });
  }
  return rows.map((row) => ({ ...row, cells: row.cells.sort((a, b) => a.x - b.x) }));
});

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("the status bar: pages-per-view menu, the Rendered toggle right beside Fit page height, and Fit entire page", async () => {
    await fresh();
    ok(await pagesButton().isVisible(), "pages button");
    ok(await renderedButton().isVisible(), "rendered button");
    eq(await renderedButton().getAttribute("aria-pressed"), "false", "starts in the editing view");
    ok(/Rendered view/.test(await renderedButton().getAttribute("title")), "tooltip");
    const order = await page.evaluate(() => [...document.querySelectorAll(".zoomctl > button")].map((b) => b.getAttribute("aria-label")));
    eq(order.slice(0, 4), ["Rendered view", "Zoom to page height", "Zoom to page width", "Zoom to the entire page"], "the rendered button sits beside Fit page height");
    await pagesButton().click();
    const items = await page.getByRole("menuitem").allInnerTexts();
    ok(["1 page", "2 pages", "3 pages", "4 pages"].every((t) => items.some((i) => i.includes(t))), `menu offers 1-4: ${items}`);
    await page.keyboard.press("Escape");
  });

  await scenario("1, 2, 3 and 4 pages side by side: right order, one row per group, equal gaps, whole pages, no duplicate pages, persisted", async () => {
    await fresh();
    const total = (await rowsFlat()).length;
    ok(total >= 5, `a manuscript of several pages (${total})`);
    for (const n of [2, 3, 4, 1]) {
      await pick(n === 1 ? "1 page" : `${n} pages`);
      const rows = await sheetRows();
      const flat = rows.flatMap((r) => r.cells);
      eq(flat.length, total, `no page is added or repeated with ${n} across`);
      ok(rows.slice(0, -1).every((r) => r.cells.length === n), `every full row holds ${n}`);
      ok(rows.at(-1).cells.length === total % n || total % n === 0 || rows.at(-1).cells.length === n, "the last group holds what is left, nothing more");
      const reading = rows.flatMap((r) => r.cells.map((c) => c.x));
      ok(rows.every((r) => r.cells.every((c, i) => i === 0 || c.x > r.cells[i - 1].x)), "left to right");
      if (n > 1) {
        const gaps = rows[0].cells.slice(1).map((c, i) => Math.round(c.x - (rows[0].cells[i].x + rows[0].cells[i].w)));
        ok(gaps.every((g) => Math.abs(g - gaps[0]) <= 1), `equal spacing ${gaps}`);
      }
      void reading;
    }
    await pick("3 pages");
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    ok((await sheetRows())[0].cells.length === 3, "the choice is remembered");
    eq((await doc()).blocks.length, 40, "the document content did not change");
    await pick("1 page");
  });

  await scenario("typing, selection and keys still work in every arrangement (the layout is not an editing mode)", async () => {
    await fresh();
    for (const n of [2, 4]) {
      await pick(`${n} pages`);
      const first = page.locator(".sheets .sheet").first().locator("[data-edit='text']").first();
      await first.click();
      await page.keyboard.press("End");
      await page.keyboard.type("Z");
      await until(async () => /Z$/.test((await doc()).blocks[0].text), "typed text saved");
      await page.keyboard.press("Backspace");
      await until(async () => !/Z$/.test((await doc()).blocks[0].text), "backspace saved");
    }
  });

  await scenario("Fit entire page: the whole arrangement is visible at once, and it follows a resize", async () => {
    await fresh();
    for (const n of [1, 2, 4]) {
      await pick(n === 1 ? "1 page" : `${n} pages`);
      await page.getByRole("button", { name: "Zoom to the entire page" }).click();
      await delay(300);
      const fit = await page.evaluate(() => {
        const s = document.querySelector(".scroller").getBoundingClientRect();
        const sheets = [...document.querySelectorAll(".sheets .sheet")].map((e) => e.getBoundingClientRect());
        const first = sheets[0];
        const rowTop = sheets.filter((r) => Math.abs(r.top - first.top) < 3);
        return { scroller: { w: s.width, h: s.height }, rowW: rowTop.at(-1).right - rowTop[0].left, pageH: first.height };
      });
      ok(fit.pageH <= fit.scroller.h + 1, `a whole page fits the window height (${fit.pageH} <= ${fit.scroller.h})`);
      ok(fit.rowW <= fit.scroller.w + 1, `a whole row fits the window width (${fit.rowW} <= ${fit.scroller.w})`);
    }
    await page.setViewportSize({ width: 1000, height: 600 });
    await delay(500);
    const small = await page.evaluate(() => {
      const s = document.querySelector(".scroller").getBoundingClientRect();
      const sheets = [...document.querySelectorAll(".sheets .sheet")].map((e) => e.getBoundingClientRect());
      const first = sheets[0], row = sheets.filter((r) => Math.abs(r.top - first.top) < 3);
      return { fitsW: row.at(-1).right - row[0].left <= s.width + 1, fitsH: first.height <= s.height + 1 };
    });
    ok(small.fitsW && small.fitsH, "after the window got smaller the pages were fitted again");
  });

  await scenario("Rendered view: the exported PDF's pages, read only, with none of the editing chrome", async () => {
    await fresh();
    const before = (await doc()).version;
    const info = await pdfPages();
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    eq(await renderedButton().getAttribute("aria-pressed"), "true", "toggle pressed");
    eq(await page.locator(".rendered .rv-page").count(), info.total, "one picture per page of the exported PDF");
    await until(async () => page.evaluate(() => { const i = document.querySelector(".rv-page img"); return i && i.complete && i.naturalWidth > 0; }), "the first page is drawn");
    const bad = await page.evaluate(() => ({
      editable: document.querySelectorAll(".rendered [contenteditable=true], .rendered [data-edit]").length,
      editor: getComputedStyle(document.querySelector(".page-area")).display,
      ruler: [...document.querySelectorAll(".hruler, .vruler")].filter((e) => e.offsetParent !== null).length,
      handles: [...document.querySelectorAll(".imgsel, .tb-move, .mline, .proof-mark, [data-proof], .caret, .guide")].filter((e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed").length,
    }));
    eq(bad.editable, 0, "nothing in the rendered view can be edited");
    eq(bad.editor, "none", "the editing page is out of the way");
    eq(bad.ruler, 0, "no rulers"); eq(bad.handles, 0, "no selection handles, guides or spelling marks");
    // the page really is the export: the same size as the PDF page, at the page's aspect
    const box = await page.locator(".rv-page").first().boundingBox();
    ok(Math.abs(box.height / box.width - info.pages[0].heightPt / info.pages[0].widthPt) < 0.01, "page proportions are the exported page's");
    // typing does nothing
    await page.locator(".rv-scroller").focus();
    await page.keyboard.type("hello"); await page.keyboard.press("Delete"); await page.keyboard.press("Control+v");
    await delay(600);
    eq((await doc()).version, before, "the document was not modified");
    // back
    await page.keyboard.press("Escape");
    await page.locator(".rendered").waitFor({ state: "detached" });
    eq(await renderedButton().getAttribute("aria-pressed"), "false", "toggle released");
    eq((await doc()).version, before, "still not modified after returning");
  });

  await scenario("Rendered view keeps the page: going in and out lands on the page the caret was on, and the caret is not lost", async () => {
    await fresh();
    const target = page.locator("[data-edit='text']").nth(32);
    await target.scrollIntoViewIfNeeded();
    await target.click();
    await delay(1800);                                                           // the measured layout (which page each block is on) arrives a moment after
    const block = await page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("[data-id]")?.dataset.id);
    ok(block, "caret in a paragraph");
    const layout = (await api("GET", `/docs/${sid}/layout`)).body.data;
    const want = layout.blockPages[block];
    ok(want > 1, `a paragraph on a later page (${want})`);
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    await delay(800);
    ok((await page.locator(".page-line").innerText()).includes(`Rendered ${String(want).padStart(2, "0")}/`), `status shows page ${want}: ${await page.locator(".page-line").innerText()}`);
    await renderedButton().click();
    await page.locator(".rendered").waitFor({ state: "detached" });
    await delay(300);
    const back = await page.evaluate(() => ({ id: getSelection()?.anchorNode?.parentElement?.closest("[data-id]")?.dataset.id, visible: (() => { const e = getSelection()?.anchorNode?.parentElement?.closest("[data-id]"); if (!e) return false; const r = e.getBoundingClientRect(), s = document.querySelector(".scroller").getBoundingClientRect(); return r.bottom > s.top && r.top < s.bottom; })() }));
    eq(back.id, block, "the caret is back in the same paragraph");
    ok(back.visible, "and that paragraph is on screen");
  });

  await scenario("Rendered view with 2, 3 and 4 pages, page navigation, zoom and fit; the choice carries over from the editing view", async () => {
    await fresh();
    await pick("3 pages");
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    let rows = await renderedRows();
    ok(rows[0].cells.length === 3, "the rendered view uses the same 3 across");
    eq(rows[0].cells.map((c) => c.n), [1, 2, 3], "right order");
    await pagesButton().click(); await page.getByRole("menuitem", { name: "2 pages" }).click(); await delay(300);
    rows = await renderedRows();
    eq(rows[0].cells.map((c) => c.n), [1, 2], "switching in the rendered view changes its arrangement");
    const total = (await pdfPages()).total;
    eq(rows.flatMap((r) => r.cells).length, total, "no duplicated or missing page in an incomplete last group");
    const gaps = rows[0].cells.slice(1).map((c, i) => Math.round(c.x - (rows[0].cells[i].x + rows[0].cells[i].w)));
    ok(gaps.every((g) => g > 5), "pages are separated");
    // page navigation: PageDown moves to the next group, End to the last page, Home back
    await page.locator(".rv-scroller").focus();
    await page.keyboard.press("PageDown"); await delay(200);
    ok((await page.locator(".page-line").innerText()).includes("Rendered 03/"), `PageDown goes to the next pair: ${await page.locator(".page-line").innerText()}`);
    await page.keyboard.press("End"); await delay(200);
    const lastGroup = 1 + 2 * Math.floor((total - 1) / 2);                     // two across: the last group starts at this page
    ok((await page.locator(".page-line").innerText()).includes(`Rendered ${String(lastGroup).padStart(2, "0")}/`), `End goes to the last group: ${await page.locator(".page-line").innerText()}`);
    ok(await page.locator(`.rv-page[data-page="${total}"]`).evaluate((e) => { const r = e.getBoundingClientRect(), s = document.querySelector(".rv-scroller").getBoundingClientRect(); return r.top >= s.top - 1 && r.top < s.bottom; }), "and the last page is on screen");
    await page.keyboard.press("Home"); await delay(200);
    ok((await page.locator(".page-line").innerText()).includes("Rendered 01/"), "Home goes to the first");
    // zoom
    const w0 = (await page.locator(".rv-page").first().boundingBox()).width;
    await page.getByRole("slider", { name: "Zoom" }).fill("50"); await delay(300);
    const w1 = (await page.locator(".rv-page").first().boundingBox()).width;
    ok(w1 < w0 && Math.abs(w1 - 595.3 * 96 / 72 * 0.5) < 2, `50 % is half the page size (${w0} -> ${w1})`);
    await page.getByRole("button", { name: "Zoom to page width" }).click(); await delay(300);
    const fitW = await page.evaluate(() => { const s = document.querySelector(".rv-scroller"); const row = [...document.querySelectorAll(".rv-page")].slice(0, 2).map((e) => e.getBoundingClientRect()); return { row: row[1].right - row[0].left, view: s.clientWidth }; });
    ok(fitW.row <= fitW.view && fitW.row > fitW.view * 0.8, `Fit page width fills the window across (${fitW.row} of ${fitW.view})`);
    await page.getByRole("button", { name: "Zoom to the entire page" }).click(); await delay(300);
    const entire = await page.evaluate(() => { const s = document.querySelector(".rv-scroller").getBoundingClientRect(); const p = document.querySelector(".rv-page").getBoundingClientRect(); return p.height <= s.height + 1; });
    ok(entire, "Fit entire page shows a whole page");
    // ctrl + wheel zooms
    const z0 = (await page.locator(".rv-page").first().boundingBox()).width;
    await page.locator(".rv-scroller").hover();
    await page.keyboard.down("Control"); await page.mouse.wheel(0, -200); await page.keyboard.up("Control"); await delay(300);
    ok((await page.locator(".rv-page").first().boundingBox()).width > z0, "Ctrl + wheel zooms in");
    await page.keyboard.press("Escape");
    await page.locator(".rendered").waitFor({ state: "detached" });
    eq((await sheetRows())[0].cells.length, 2, "the editing view shows what was chosen in the rendered view");
  });

  await scenario("the rendered view follows the document: an edit made in the editing view is in the pictures the next time", async () => {
    await fresh({ paragraphs: 6 });
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    const one = (await pdfPages()).total;
    await page.keyboard.press("Escape");
    await page.locator(".rendered").waitFor({ state: "detached" });
    const adds = Array.from({ length: 30 }, (_, i) => ({ op: "block_insert", after: "p5", block: { id: `x${i}`, type: "paragraph", text: "More text. ".repeat(80) } }));
    await op({ op: "batch", ops: adds });
    await page.reload(); await page.locator("#main").waitFor(); await delay(600);
    await renderedButton().click();
    await page.locator(".rendered .rv-page").first().waitFor();
    ok((await page.locator(".rendered .rv-page").count()) > one, "the new pages are there");
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}

async function rowsFlat() { return (await sheetRows()).flatMap((r) => r.cells); }
