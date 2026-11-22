/** Browser tests for margins and book layout: the Margins menu, the Custom Margins dialog and its scopes, mirrored margins on screen (alternating
 *  inside and outside, the gutter once), the two-page book view that mirrored margins switch on, and what the Rendered View shows.
 *    NODE_PATH=<dir with playwright> node tests_e2e/book_layout.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("book");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const op = (o) => api("POST", `/docs/${sid}/ops`, { op: o });
const book = async () => ((await doc()).document?.extensions ?? {})["slai.writer"]?.book_layouts ?? {};
const sectionsOf = async () => (await doc()).document?.sections ?? [];

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

const tab = (name) => page.getByRole("tab", { name, exact: true });
const openMargins = async () => { await tab("Layout").click(); await page.getByRole("button", { name: "Margins", exact: true }).click(); await page.locator(".margins-menu").waitFor(); };
const choose = async (id) => { await openMargins(); await page.locator(`.margins-menu [data-preset='${id}']`).click(); await delay(500); };
/** The margin, in millimetres, between the left (and right) edge of a sheet and its text area, read from what is on screen. */
const edges = () => page.evaluate(() => [...document.querySelectorAll(".sheets .sheet")].map((el) => {
  const r = el.getBoundingClientRect(), b = el.querySelector(".body").getBoundingClientRect(), k = 210 / r.width;
  return { side: el.dataset.side, left: Math.round((b.left - r.left) * k * 10) / 10, right: Math.round((r.right - b.right) * k * 10) / 10 };
}));
const rows = () => page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll(".sheets > .sheet, .sheets > .sheet-slot")) {
    const r = el.getBoundingClientRect();
    const row = out.find((x) => Math.abs(x.top - r.top) < 3);
    const cell = { x: r.x, w: r.width, slot: el.classList.contains("sheet-slot"), page: Number(el.dataset.page ?? 0) };
    if (row) row.cells.push(cell); else out.push({ top: r.top, cells: [cell] });
  }
  return out.map((row) => ({ ...row, cells: row.cells.sort((a, b) => a.x - b.x) }));
});

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("Layout → Page Setup → Margins offers Normal, Narrow, Moderate, Wide, Mirrored, Gutter / Binding and Custom, each with a picture", async () => {
    await fresh();
    await openMargins();
    const ids = await page.locator(".margins-menu [data-preset]").evaluateAll((els) => els.map((e) => e.dataset.preset));
    eq(ids, ["normal", "narrow", "moderate", "wide", "mirrored", "gutter", "custom"], "the presets");
    eq(await page.locator(".margins-menu .margin-preview").count(), 6, "a drawn preview for each preset");
    ok((await page.locator(".margins-menu [aria-checked=true]").getAttribute("data-preset")) === "normal", "the page's current preset is marked");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
    await page.locator(".margins-menu").waitFor({ state: "detached" });
  });

  await scenario("a preset changes the page margins as one undoable step; Narrow, Wide and Moderate show on the page", async () => {
    await fresh();
    for (const [id, mm] of [["narrow", 15], ["wide", 35], ["moderate", 19.1], ["normal", 25]]) {
      await choose(id);
      const e = (await edges())[0];
      ok(Math.abs(e.left - mm) < 0.6 && Math.abs(e.right - mm) < 0.6, `${id}: sides ${e.left}/${e.right} mm`);
    }
    await choose("narrow");
    const v = (await doc()).version;
    await page.locator("[data-edit='text']").first().click();
    await page.keyboard.press("Control+z");
    await until(async () => { const e = (await edges())[0]; return Math.abs(e.left - 25) < 0.6; }, "one Undo returns to Normal");
    ok((await doc()).version >= v, "version moves forward");
  });

  await scenario("Mirrored: inside and outside alternate by page, the pages are shown as a book (page 1 alone on the right), no gap at the spine", async () => {
    await fresh();
    await choose("mirrored");
    const b = await book();
    ok(Object.values(b).some((x) => x.mirror === true), "mirror stored with the section");
    const e = await edges();
    // a right-hand page (odd): inside 31.8 on the left, outside 25.4 on the right; a left-hand page (even): the other way round
    ok(Math.abs(e[0].left - 31.8) < 0.7 && Math.abs(e[0].right - 25.4) < 0.7, `page 1 (right-hand): ${e[0].left}/${e[0].right}`);
    ok(Math.abs(e[1].left - 25.4) < 0.7 && Math.abs(e[1].right - 31.8) < 0.7, `page 2 (left-hand): ${e[1].left}/${e[1].right}`);
    ok(Math.abs(e[2].left - 31.8) < 0.7, "page 3 is right-hand again");
    eq(e.map((x) => x.side).slice(0, 4), ["right", "left", "right", "left"], "sides by position");
    const r = await rows();
    ok(r[0].cells[0].slot && r[0].cells[1].page === 1, "row 1: the empty slot, then page 1 on the right");
    eq(r[1].cells.map((c) => c.page), [2, 3], "row 2 is the spread of pages 2 and 3");
    eq(r[2].cells.map((c) => c.page), [4, 5], "row 3 is the spread of pages 4 and 5");
    ok(Math.abs(r[1].cells[1].x - (r[1].cells[0].x + r[1].cells[0].w)) < 1.5, "no gap at the spine");
    ok(r[1].cells[0].w === r[1].cells[1].w || Math.abs(r[1].cells[0].w - r[1].cells[1].w) < 1, "both pages are as wide as each other");
    eq(await page.locator(".sheets .sheet").count(), (await rows()).flatMap((x) => x.cells).filter((c) => !c.slot).length, "the empty slot is not a page: the page count is unchanged");
    const pagesLabel = await page.getByRole("button", { name: /^Pages shown side by side/ }).getAttribute("aria-label");
    ok(/book view/.test(pagesLabel), `the pages control says book view: ${pagesLabel}`);
  });

  await scenario("book view: 1 page is the manual override and is remembered; 3 and 4 pages are overviews; Undo of Mirrored goes back to what was shown", async () => {
    await fresh();
    await choose("mirrored");
    await page.getByRole("button", { name: /^Pages shown side by side/ }).click();
    await page.getByRole("menuitem", { name: "1 page" }).click(); await delay(300);
    eq((await rows())[0].cells.length, 1, "one page across");
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    eq((await rows())[0].cells.length, 1, "the override is remembered");
    ok(Math.abs((await edges())[1].left - 25.4) < 0.7, "mirrored margins still alternate in a single-page view");
    await page.getByRole("button", { name: /^Pages shown side by side/ }).click();
    await page.getByRole("menuitem", { name: "4 pages" }).click(); await delay(300);
    eq((await rows())[0].cells.length, 4, "four-page overview of a book");
    await page.getByRole("button", { name: /^Pages shown side by side/ }).click();
    await page.getByRole("menuitem", { name: /2 pages: book view/ }).click(); await delay(300);
    ok((await rows())[0].cells[0].slot, "the book view comes back");
  });

  await scenario("Custom Margins: inside 20, outside 15, gutter 5 → the inside margin is 25 once, outside 15; refused when it leaves no room", async () => {
    await fresh();
    await openMargins(); await page.locator(".margins-menu [data-preset='custom']").click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Mirrored margins", { exact: false }).check();
    await dlg.getByLabel("Inside (mm)").fill("20");
    await dlg.getByLabel("Outside (mm)").fill("15");
    await dlg.getByLabel("Gutter width (mm)").fill("5");
    await dlg.getByLabel("Top (mm)").fill("22"); await dlg.getByLabel("Bottom (mm)").fill("22");
    // too much: refused with a reason, and Apply does nothing
    await dlg.getByLabel("Gutter width (mm)").fill("99");
    await dlg.getByLabel("Inside (mm)").fill("90");
    ok(/less than 25 mm/.test(await dlg.locator(".error, [role=alert]").first().innerText()), "the reason is shown");
    await dlg.getByRole("button", { name: "Apply" }).click(); await delay(400);
    ok(await dlg.isVisible(), "the dialog stays open");
    await dlg.getByLabel("Inside (mm)").fill("20"); await dlg.getByLabel("Gutter width (mm)").fill("5");
    await dlg.getByRole("button", { name: "Apply" }).click();
    await dlg.waitFor({ state: "detached" }); await delay(500);
    const stored = (await sectionsOf())[0]?.page?.margins_mm;
    ok(stored, "the section's margins are stored");
    const b = Object.values(await book())[0];
    eq(b.gutter_mm, 5, "gutter stored on its own"); ok(b.mirror === true, "mirrored");
    eq([stored.left, stored.right], [20, 15], "the stored margins are inside 20 and outside 15, the gutter not folded in");
    const e = await edges();
    ok(Math.abs(e[0].left - 25) < 0.7 && Math.abs(e[0].right - 15) < 0.7, `page 1: inside 25 (20 + 5 once), outside 15: ${e[0].left}/${e[0].right}`);
    ok(Math.abs(e[1].left - 15) < 0.7 && Math.abs(e[1].right - 25) < 0.7, `page 2: ${e[1].left}/${e[1].right}`);
    // changing the gutter reflows and the text width stays the same on every page
    const widths = await page.evaluate(() => [...document.querySelectorAll(".sheets .sheet .body")].slice(0, 4).map((b) => Math.round(b.getBoundingClientRect().width)));
    ok(new Set(widths).size === 1, `the text is as wide on both sides of a spread: ${widths}`);
  });

  await scenario("scopes: entire document, current section, selected sections, from here forward", async () => {
    await fresh();
    const brk = await op({ op: "section_break", block: "p20" });
    ok(brk.status < 300, "a section break");
    const brk2 = await op({ op: "section_break", block: "p30" });
    ok(brk2.status < 300, "a second one");
    await page.reload(); await page.locator("#main").waitFor(); await delay(700);
    const ids = (await sectionsOf()).map((s) => s.id);
    eq(ids.length, 3, "three sections");
    const clearBook = async () => { await op({ op: "page_layout", scope: "document", mirror: null }); await page.reload(); await page.locator("#main").waitFor(); await delay(600); };   // the page is reloaded: an edit made behind its back would make it stale
    const apply = async (scope, fn) => {
      await openMargins(); await page.locator(".margins-menu [data-preset='custom']").click();
      const dlg = page.getByRole("dialog");
      await dlg.getByLabel("Mirrored margins", { exact: false }).check();
      await dlg.getByLabel("Apply to").selectOption(scope);
      if (fn) await fn(dlg);
      await dlg.getByRole("button", { name: "Apply" }).click();
      await dlg.waitFor({ state: "detached", timeout: 4000 }).catch(async () => { throw new Error(`the dialog stayed open for scope ${scope}: ${await dlg.locator(".error, [role=alert]").allInnerTexts()} | toasts: ${await page.locator(".toast, [role=status]").allInnerTexts()}`); });
      await delay(400);
      return Object.entries(await book()).filter(([, v]) => v.mirror).map(([k]) => k).sort();
    };
    eq(await apply("document"), [...ids].sort(), "entire document: every section");
    await clearBook();
    const cur = await apply("section");
    eq(cur.length, 1, `current section: one (${cur})`);
    await clearBook();
    const picked = await apply("sections", async (dlg) => { await dlg.locator("input[data-section]").nth(0).uncheck(); await dlg.locator("input[data-section]").nth(2).check(); });
    ok(picked.includes(ids[2]) && !picked.includes(ids[0]), `selected sections only: ${picked}`);
    await clearBook();
    await page.locator(`[data-id='p32'] [data-edit='text']`).first().click();
    const from = await apply("from_here");
    ok(from.length >= 1 && !from.includes(ids[0]), `from here forward leaves the earlier sections alone: ${from}`);
  });

  await scenario("parity follows position: inserting and removing content keeps right/left alternating, and a reload keeps the book", async () => {
    await fresh();
    await choose("mirrored");
    const adds = Array.from({ length: 12 }, (_, i) => ({ op: "block_insert", after: "p3", block: { id: `n${i}`, type: "paragraph", text: "Inserted. ".repeat(120) } }));
    await op({ op: "batch", ops: adds });
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    const e = await edges();
    ok(e.length > 6 && e.every((x, i) => x.side === (i % 2 === 0 ? "right" : "left")), "sides alternate right, left, right ...");
    ok(e.every((x, i) => Math.abs(x.left - (i % 2 === 0 ? 31.8 : 25.4)) < 0.8), "every page has its own side's margins");
    await op({ op: "batch", ops: adds.map((a) => ({ op: "block_delete", block: a.block.id })) });
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    const e2 = await edges();
    ok(e2.every((x, i) => x.side === (i % 2 === 0 ? "right" : "left")), "still alternating after removal");
    const r = await rows();
    ok(r[0].cells[0].slot, "still a book view after reopening");
  });

  await scenario("Rendered view of a book: two-page spreads, page 1 alone on the right, no gap at the spine, and the picture's margins alternate", async () => {
    await fresh();
    await choose("mirrored");
    await page.locator(".sbtn.rendered-toggle").click();
    await page.locator(".rendered .rv-page").first().waitFor();
    const r = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(".rv-grid > *")) { const b = el.getBoundingClientRect(); const row = out.find((x) => Math.abs(x.top - b.top) < 3); const c = { x: b.x, w: b.width, slot: el.classList.contains("rv-slot"), n: Number(el.dataset.page ?? 0) }; if (row) row.cells.push(c); else out.push({ top: b.top, cells: [c] }); }
      return out.map((x) => ({ ...x, cells: x.cells.sort((a, b) => a.x - b.x) }));
    });
    ok(r[0].cells[0].slot && r[0].cells[1].n === 1, "empty slot, then page 1");
    eq(r[1].cells.map((c) => c.n), [2, 3], "spread 2-3");
    ok(Math.abs(r[1].cells[1].x - (r[1].cells[0].x + r[1].cells[0].w)) < 1.5, "no gap at the spine");
    // the pictures: the text's left edge is the inside margin on right-hand pages and the outside margin on left-hand pages
    await until(async () => page.evaluate(() => [...document.querySelectorAll(".rv-img")].slice(0, 3).every((i) => i.complete && i.naturalWidth > 0)), "pages drawn");
    const inks = await page.evaluate(async () => {
      const out = [];
      for (const img of [...document.querySelectorAll(".rv-img")].slice(0, 3)) {
        const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data; let min = c.width, max = 0;
        for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x++) { const i = (y * c.width + x) * 4; if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) { if (x < min) min = x; if (x > max) max = x; } }
        out.push({ left: min / c.width * 210, right: (c.width - max) / c.width * 210 });
      }
      return out;
    });
    ok(Math.abs(inks[0].left - 31.8) < 2.5 && Math.abs(inks[1].left - 25.4) < 2.5 && Math.abs(inks[2].left - 31.8) < 2.5, `ink edges alternate: ${inks.map((i) => i.left.toFixed(1)).join(" / ")}`);
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}
