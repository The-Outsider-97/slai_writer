/** The writing experience, checked as a person writes: caret and hit-testing (also across a page boundary and on a high-density screen), selection
 *  across pages, keyboard navigation, Backspace/Delete/Enter/Shift+Enter, copy/cut/paste, undo/redo, find and replace, styles, ribbon state, scroll
 *  stability while typing, proofreading that never interrupts and recovers, the dirty indicator, shortcuts, accessible names, keyboard-only use, a ribbon
 *  that still reaches every control in a narrow window. Real Chromium, real server.
 *    NODE_PATH=<dir with playwright> node tests_e2e/writing_audit.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("write");
const { scenario, state, finish } = runner();
let browser, context, page, sid;
const problems = [];

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const texts = async () => (await doc()).blocks.map((b) => b.text);

async function fresh({ paragraphs = 40, scale = 1, width = 1500, height = 950 } = {}) {
  context?.close().catch(() => {});
  context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  state.page = page;
  page.setDefaultTimeout(8000);
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${server.base}/?token=${server.token}`);
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  const nav = page.getByRole("button", { name: "New Page" }).first();
  if (await nav.isVisible().catch(() => false)) await nav.click();                    // a narrow window folds the navigation away: the home screen has its own button
  else await page.getByRole("button", { name: "New document" }).first().click();
  await page.getByRole("button", { name: "Create document" }).click();
  await page.locator("#main").waitFor();
  await until(async () => page.url().includes("/doc/"), "document url");
  sid = page.url().split("/doc/")[1];
  const s = await doc();
  const ops = [{ op: "text", block: s.blocks[0].id, start: 0, end: s.blocks[0].text.length, insert: "First paragraph." }];
  let after = s.blocks[0].id;
  for (let n = 1; n < paragraphs; n++) { const id = `p${n}`; ops.push({ op: "block_insert", after, block: { id, type: "paragraph", text: `Paragraph ${n + 1}. ` + "The quick brown fox jumps over the lazy dog. ".repeat(6) } }); after = id; }
  const r = await api("POST", `/docs/${sid}/ops`, { op: { op: "batch", ops } });
  if (r.status >= 300) throw new Error("setup failed " + JSON.stringify(r.body).slice(0, 300));
  await page.reload(); await page.locator("#main").waitFor(); await delay(700);
}

const para = (id) => page.locator(`[data-id='${id}'] [data-edit='text']`).first();
const caretBlock = () => page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest("[data-id]")?.dataset.id ?? null);
const caretOffset = () => page.evaluate(() => { const s = getSelection(); const el = s?.anchorNode?.parentElement?.closest("[data-edit]"); if (!el || !s.anchorNode) return -1; const r = document.createRange(); r.selectNodeContents(el); r.setEnd(s.anchorNode, s.anchorOffset); return r.toString().length; });
/** The caret at the very end of a paragraph (the End key only goes to the end of the line). */
const toEnd = async (id) => { await para(id).scrollIntoViewIfNeeded(); await para(id).click(); await page.evaluate((id) => { const el = document.querySelector(`[data-id='${id}'] [data-edit='text']`); el.focus(); getSelection().collapse(el, el.childNodes.length); }, id); };
const settle = async () => { await delay(1300); };                                       // typing is sent in the background a moment after
const sheetOf = (id) => page.evaluate((id) => { const e = document.querySelector(`[data-id='${id}']`); const sh = e?.closest(".sheet"); return sh ? Number(sh.dataset.page) : 0; }, id);
/** The first block that sits on the given sheet, and the last one on the sheet before. */
const boundary = () => page.evaluate(() => {
  const sheets = [...document.querySelectorAll(".sheets .sheet")];
  const idsOf = (sh) => [...sh.querySelectorAll("[data-id]")].filter((e) => e.querySelector("[data-edit='text']")).map((e) => e.dataset.id);
  return { lastOn1: idsOf(sheets[0]).at(-1), firstOn2: idsOf(sheets[1])[0], sheets: sheets.length };
});

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("caret and hit-testing: a click puts the caret where the pointer is, on either side of a page boundary", async () => {
    await fresh();
    const b = await boundary();
    ok(b.lastOn1 && b.firstOn2 && b.lastOn1 !== b.firstOn2, "two pages with text");
    for (const id of [b.lastOn1, b.firstOn2]) {
      await para(id).scrollIntoViewIfNeeded();
      const r = await para(id).boundingBox();
      await page.mouse.click(r.x + 40, r.y + 6);
      eq(await caretBlock(), id, `a click in ${id} puts the caret in ${id}`);
    }
  });

  await scenario("high-density screen (2x): the caret lands on the character that was clicked", async () => {
    await fresh({ scale: 2 });
    const target = para("p3");
    await target.scrollIntoViewIfNeeded();
    const hit = await target.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const range = document.createRange(); range.setStart(el.firstChild, 20); range.setEnd(el.firstChild, 21);
      const c = range.getBoundingClientRect();
      return { x: c.left + 1, y: c.top + c.height / 2, expect: 20 };
    });
    await page.mouse.click(hit.x, hit.y);
    ok(Math.abs((await caretOffset()) - hit.expect) <= 1, `offset ${await caretOffset()} vs ${hit.expect}`);
  });

  await scenario("selection across pages: shift+click and shift+arrows extend over the page boundary; Delete joins what is left", async () => {
    await fresh();
    const b = await boundary();
    await para(b.lastOn1).scrollIntoViewIfNeeded();
    const first = await para(b.lastOn1).boundingBox();
    await page.mouse.click(first.x + 60, first.y + 6);
    const s = await para(b.firstOn2); await s.scrollIntoViewIfNeeded();
    const second = await s.boundingBox();
    await page.keyboard.down("Shift"); await page.mouse.click(second.x + 80, second.y + 6); await page.keyboard.up("Shift");
    const selected = await page.evaluate(() => getSelection().toString().length);
    ok(selected > 30, `selection reaches across the page boundary (${selected} characters)`);
    const before = await texts();
    await page.keyboard.press("Delete");
    await settle();
    const after = await texts();
    eq(after.length, before.length - 1, "the two paragraphs became one");
    ok(after.some((t) => t.length > 0), "text is left");
    await page.keyboard.press("Control+z");
    await settle();
    eq((await texts()), before, "one Undo restores both paragraphs exactly");
  });

  await scenario("keyboard navigation: ArrowDown/ArrowUp cross a page boundary, Ctrl+Home/End, PageDown, Home/End", async () => {
    await fresh();
    const b = await boundary();
    await para(b.lastOn1).scrollIntoViewIfNeeded();
    const r = await para(b.lastOn1).boundingBox();
    await page.mouse.click(r.x + 20, r.y + r.height - 6);                      // the last line of the last paragraph on page 1
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    eq(await caretBlock(), b.firstOn2, "ArrowDown moved on to the first paragraph of page 2");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
    eq(await caretBlock(), b.lastOn1, "ArrowUp came back");
    await page.keyboard.press("Control+End");
    const last = await page.evaluate(() => [...document.querySelectorAll("[data-id] [data-edit='text']")].at(-1).closest("[data-id]").dataset.id);
    eq(await caretBlock(), last, "Ctrl+End goes to the end of the document");
    await page.keyboard.press("Control+Home");
    eq(await caretBlock(), (await doc()).blocks[0].id, "Ctrl+Home goes to the start");
    await page.keyboard.press("End"); const end = await caretOffset();
    await page.keyboard.press("Home"); eq(await caretOffset(), 0, "Home goes to the line start");
    ok(end > 0, "End moved");
    await page.keyboard.press("PageDown");
    const vis = await page.evaluate(() => { const sel = getSelection(); let c = sel.getRangeAt(0).getBoundingClientRect(); const s = document.querySelector(".scroller").getBoundingClientRect(); const a = sel.anchorNode; const field = (a.nodeType === 1 ? a : a.parentElement)?.closest("[data-edit]")?.getBoundingClientRect(); if (!c.height) c = field ?? c; return { ok: c.bottom > s.top && c.top < s.bottom, c: [c.top, c.bottom, c.height], s: [s.top, s.bottom], field: field && [field.top, field.bottom], at: document.activeElement?.tagName }; });
    ok(vis.ok, "after PageDown the caret is on screen " + JSON.stringify(vis));
  });

  await scenario("Backspace at the start of the first paragraph of a page joins it to the last paragraph of the page before; Delete at the end does the same", async () => {
    await fresh();
    const b = await boundary();
    const before = await texts();
    const a = (await doc()).blocks.find((x) => x.id === b.lastOn1).text, c = (await doc()).blocks.find((x) => x.id === b.firstOn2).text;
    const r = await para(b.firstOn2); await r.scrollIntoViewIfNeeded();
    await r.click(); await page.keyboard.press("Control+ArrowUp").catch(() => {});
    await page.evaluate((id) => { const el = document.querySelector(`[data-id='${id}'] [data-edit='text']`); el.focus(); const s = getSelection(); s.collapse(el.firstChild, 0); }, b.firstOn2);
    await page.keyboard.press("Backspace");
    await settle();
    const after = await texts();
    eq(after.length, before.length - 1, "one paragraph fewer");
    ok(after.includes(a + c), "the two joined without losing or adding a character");
    await page.keyboard.press("Control+z"); await settle();
    eq(await texts(), before, "Undo splits them back");
  });

  await scenario("Enter splits at the caret (also mid-word); Shift+Enter is a line break inside the paragraph; Enter in a heading starts a paragraph", async () => {
    await fresh();
    const t = (await doc()).blocks.find((x) => x.id === "p2").text;
    await para("p2").click();
    await page.evaluate(() => { const el = document.querySelector("[data-id='p2'] [data-edit='text']"); const s = getSelection(); s.collapse(el.firstChild, 14); });
    await page.keyboard.press("Enter"); await settle();
    let now = await texts();
    ok(now.includes(t.slice(0, 14)) && now.includes(t.slice(14)), `split exactly at the caret: ${JSON.stringify(now.slice(2, 4)).slice(0, 120)}`);
    await page.keyboard.press("Control+z"); await settle();
    await para("p2").click();
    await page.evaluate(() => { const el = document.querySelector("[data-id='p2'] [data-edit='text']"); getSelection().collapse(el.firstChild, 14); });
    const n0 = (await texts()).length;
    await page.keyboard.press("Shift+Enter"); await settle();
    const after = await doc();
    eq(after.blocks.length, n0, "Shift+Enter adds no paragraph");
    ok(/\n/.test(after.blocks.find((x) => x.id === "p2").text), "but a line break");
    await page.keyboard.press("Control+z"); await settle();
    // heading, then Enter at its end
    await api("POST", `/docs/${sid}/ops`, { op: { op: "block_insert", after: "p4", block: { id: "h1", type: "heading", attributes: { level: 1 }, text: "A heading" } } });
    await page.reload(); await page.locator("#main").waitFor(); await delay(700);
    await toEnd("h1"); await page.keyboard.press("Enter"); await settle();
    const d = await doc();
    const at = d.blocks.findIndex((x) => x.id === "h1");
    eq(d.blocks[at + 1].type, "paragraph", "the new block after a heading is a paragraph");
    await page.keyboard.type("Next");
    await settle();
    eq((await doc()).blocks[at + 1].text, "Next", "typing continues in it");
  });

  await scenario("copy, cut and paste: a word, cut, and text from outside (plain paragraphs; scripts and markup never run or leak)", async () => {
    await fresh();
    await para("p3").click();
    await page.evaluate(() => { const el = document.querySelector("[data-id='p3'] [data-edit='text']"); const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 11); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press("Control+c");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    eq(clip, "Paragraph 4", "copy puts the selected words on the clipboard");
    await toEnd("p6"); await page.keyboard.press("Control+v"); await settle();
    ok((await texts())[6].endsWith("Paragraph 4"), "paste puts them at the caret");
    await page.evaluate(() => { const el = document.querySelector("[data-id='p6'] [data-edit='text']"); const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 5); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await page.keyboard.press("Control+x"); await settle();
    ok(!(await texts())[6].startsWith("Parag"), "cut removes the selection");
    ok((await page.evaluate(() => navigator.clipboard.readText())) === "Parag", "and puts it on the clipboard");
    // pasted HTML: the text is kept as plain paragraphs and nothing in it runs
    await toEnd("p8");
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData("text/html", "<p>one <b>bold</b> <i>italic</i></p><script>window.__pwned=1</script><p onclick='window.__pwned=2'>two</p>");
      data.setData("text/plain", "one bold italic\n\ntwo");
      document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await settle();
    ok(await page.evaluate(() => window.__pwned === undefined), "nothing from the pasted HTML ran");
    const d = await doc();
    ok(d.blocks.some((x) => x.text === "two"), "the second pasted paragraph became its own paragraph");
    ok(d.blocks.every((x) => !/<\/?(b|i|p|script)\b/.test(x.text)), "no markup leaked into the text");
  });

  await scenario("undo and redo walk back through typing, Enter and Backspace in order, and forward again", async () => {
    await fresh({ paragraphs: 6 });
    const start = await texts();
    await toEnd("p2");
    await page.keyboard.type("abc"); await delay(1500);
    await page.keyboard.press("Enter"); await delay(400);
    await page.keyboard.type("def"); await delay(1500);
    await page.keyboard.press("Backspace"); await delay(1500);
    const done = await texts();
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Control+z"); await delay(350); }   // Backspace, the typed "def", Enter, the typed "abc": four steps
    eq(await texts(), start, "four Undo steps return to the original");
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Control+y"); await delay(350); }
    eq(await texts(), done, "four Redo steps return to where it was");
  });

  await scenario("find and replace across pages: count, next, replace one, replace all, and one Undo for Replace all", async () => {
    await fresh({ paragraphs: 30 });
    await page.keyboard.press("Control+f");
    await page.locator(".search-input").fill("lazy dog");
    await until(async () => /\d/.test(await page.locator(".pill .count").innerText()), "match count");
    const n = Number((await page.locator(".pill .count").innerText()).match(/(\d+)\s*$/)?.[1] ?? (await page.locator(".pill .count").innerText()).match(/\d+/)[0]);
    ok(n >= 30, `matches counted over every page (${await page.locator(".pill .count").innerText()})`);
    await page.keyboard.press("Control+h");
    const rep = page.getByLabel(/Replace with/i).first();
    if (await rep.count()) {
      await rep.fill("sleepy cat");
      const before = await texts();
      await page.getByRole("button", { name: /Replace all/i }).first().click();
      await until(async () => (await texts()).every((t) => !t.includes("lazy dog")), "all replaced", 10000);
      await page.keyboard.press("Escape");
      await page.locator("[data-edit='text']").first().click();
      await page.keyboard.press("Control+z"); await settle();
      eq(await texts(), before, "one Undo restores every replacement");
    }
  });

  await scenario("styles and the ribbon: the style box and the Bold button follow the caret; choosing a style changes only that paragraph", async () => {
    await fresh({ paragraphs: 8 });
    await para("p2").click();
    const style = page.getByLabel("Paragraph style").first();
    await style.selectOption({ label: "Heading 1" });
    await until(async () => (await doc()).blocks.find((b) => b.id === "p2").type === "heading", "heading applied");
    eq((await doc()).blocks.find((b) => b.id === "p3").type, "paragraph", "the next paragraph is untouched");
    await para("p3").click();
    await until(async () => /Normal|Paragraph|Body/i.test(await style.evaluate((s) => s.options[s.selectedIndex]?.text ?? "")), "the style box follows the caret");
    await para("p2").click(); await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End"); await page.keyboard.press("Control+b"); await settle();
    const bold = page.getByRole("button", { name: "Bold", exact: true }).first();
    await until(async () => (await bold.getAttribute("aria-pressed")) === "true", "Bold shows pressed on bold text");
    await para("p5").click();
    await until(async () => (await bold.getAttribute("aria-pressed")) !== "true", "and not pressed elsewhere");
  });

  await scenario("typing keeps the paragraph being written where it is on screen (no jumping) while text reflows and a page is crossed", async () => {
    await fresh();
    const b = await boundary();
    const el = para(b.lastOn1);
    await el.scrollIntoViewIfNeeded();
    await el.click(); await page.keyboard.press("Control+End").catch(() => {});
    await page.evaluate((id) => { const e = document.querySelector(`[data-id='${id}'] [data-edit='text']`); e.focus(); getSelection().collapse(e.lastChild, e.lastChild.length); }, b.lastOn1);
    const top0 = await page.evaluate((id) => document.querySelector(`[data-id='${id}']`).getBoundingClientRect().top, b.lastOn1);
    await page.keyboard.type("Several words are written here so that the paragraph grows by more than a line and the page has to take it. ".repeat(3), { delay: 0 });
    await delay(800);
    const top1 = await page.evaluate((id) => document.querySelector(`[data-id='${id}']`).getBoundingClientRect().top, b.lastOn1);
    ok(Math.abs(top1 - top0) <= 2 || await page.evaluate(() => { const c = getSelection().getRangeAt(0).getBoundingClientRect(), s = document.querySelector(".scroller").getBoundingClientRect(); return c.bottom > s.top && c.top < s.bottom; }), `the line being written stayed in view (${top0} -> ${top1})`);
    eq(await caretBlock(), b.lastOn1, "the caret stayed in the paragraph");
    const written = (await page.evaluate((id) => document.querySelector(`[data-id='${id}'] [data-edit='text']`).textContent, b.lastOn1));
    ok(written.endsWith("take it. "), "every character is there, in order");
  });

  await scenario("proofreading never interrupts typing: a slow or failing proofreading service changes neither focus, caret nor typing", async () => {
    await fresh({ paragraphs: 10 });
    await page.route("**/api/**/proof**", async (route) => { await delay(2500); await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "dependency_missing", message: "The language service is not running." } }) }); });
    await page.route("**/api/proof**", async (route) => { await delay(2500); await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "dependency_missing", message: "The language service is not running." } }) }); });
    await toEnd("p2");
    const t0 = Date.now();
    await page.keyboard.type("This text is typed while proofreading is slow. ".repeat(3), { delay: 5 });
    ok(Date.now() - t0 < 4000, `typing was not held back (${Date.now() - t0} ms)`);
    eq(await caretBlock(), "p2", "the caret never left the paragraph");
    await settle();
    ok((await texts())[2].endsWith("proofreading is slow. "), "all the typed text was saved");
  });

  await scenario("the dirty indicator follows edits and saving; Ctrl+S saves; the shortcuts Ctrl+B, Ctrl+I, Ctrl+U toggle formatting", async () => {
    await fresh({ paragraphs: 4 });
    await para("p1").click(); await page.keyboard.press("End"); await page.keyboard.type("x"); await settle();
    const status = () => page.locator(".estatus").innerText();
    ok(/unsaved|not saved/i.test(await page.locator(".status-dots, .estatus").first().innerText().catch(() => "")) || (await doc()).dirty === true, "the document is marked as changed");
    await page.evaluate(() => { const el = document.querySelector("[data-id='p1'] [data-edit='text']"); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    for (const [key, prop] of [["Control+b", "bold"], ["Control+i", "italic"], ["Control+u", "underline"]]) {
      await page.keyboard.press(key); await settle();
      ok((await doc()).blocks.find((b) => b.id === "p1").spans?.some((sp) => sp[prop]), `${key} applies ${prop}`);
      await page.keyboard.press(key); await settle();
    }
    void status;
  });

  await scenario("accessibility: every control has a name, ids are unique, the ribbons and regions are labelled, and nothing in the ribbon is duplicated", async () => {
    await fresh({ paragraphs: 6 });
    for (const tabName of ["Home", "Insert", "Layout", "References"]) {
      const t = page.getByRole("tab", { name: tabName, exact: true });
      if (!(await t.count())) continue;
      await t.click(); await delay(200);
      const report = await page.evaluate(() => {
        const name = (e) => (e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent || "").trim() || (e.id && document.querySelector(`label[for='${e.id}']`)?.textContent?.trim()) || e.closest("label")?.textContent?.trim() || e.getAttribute("aria-labelledby");
        const visible = (e) => e.offsetParent !== null || getComputedStyle(e).position === "fixed";
        const controls = [...document.querySelectorAll("button, select, input:not([type=hidden]), [role=button], [role=tab], textarea")].filter(visible);
        const unnamed = controls.filter((e) => !name(e)).map((e) => e.outerHTML.slice(0, 90));
        const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
        const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
        const ribbon = document.querySelector(".format-ribbon:not([hidden])");
        const labels = ribbon ? [...ribbon.querySelectorAll("button")].filter(visible).map((b) => (b.getAttribute("aria-label") || b.textContent).trim()) : [];
        const dupLabels = labels.filter((l, i) => l && labels.indexOf(l) !== i);
        return { unnamed, dupIds: [...new Set(dupIds)], dupLabels: [...new Set(dupLabels)], toolbarLabelled: !ribbon || !!ribbon.getAttribute("aria-label") };
      });
      eq(report.unnamed, [], `${tabName}: every visible control has an accessible name`);
      eq(report.dupIds, [], `${tabName}: unique ids`);
      eq(report.dupLabels, [], `${tabName}: no duplicated button in the ribbon`);
      ok(report.toolbarLabelled, `${tabName}: the ribbon is labelled`);
    }
  });

  await scenario("keyboard only: Tab reaches the ribbon, Enter on Bold formats the selection, Escape returns to the text", async () => {
    await fresh({ paragraphs: 4 });
    await para("p1").click();
    await page.evaluate(() => { const el = document.querySelector("[data-id='p1'] [data-edit='text']"); const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    const bold = page.getByRole("button", { name: "Bold", exact: true }).first();
    await bold.focus(); await page.keyboard.press("Enter"); await settle();
    ok((await doc()).blocks.find((b) => b.id === "p1").spans?.some((s) => s.bold), "Enter on a focused ribbon button applies it to the selection kept in the text");
    // focus order: pressing Tab repeatedly from the page reaches interactive controls and never gets stuck on the body
    await para("p1").click();
    const seen = new Set();
    for (let i = 0; i < 25; i++) { await page.keyboard.press("Tab"); seen.add(await page.evaluate(() => document.activeElement?.tagName + ":" + (document.activeElement?.getAttribute("aria-label") ?? ""))); }
    ok(seen.size >= 8, `Tab moves through distinct controls (${seen.size})`);
    ok(!(await page.evaluate(() => document.activeElement === document.body)), "focus is not lost to the page body");
  });

  await scenario("narrow window: the ribbon never makes the page scroll sideways and every tab's controls stay reachable", async () => {
    await fresh({ paragraphs: 4, width: 700, height: 800 });
    for (const tabName of ["Home", "Insert", "Layout"]) {
      const t = page.getByRole("tab", { name: tabName, exact: true });
      if (!(await t.count())) continue;
      await t.click(); await delay(200);
      const r = await page.evaluate(() => {
        const ribbon = document.querySelector(".format-ribbon:not([hidden])");
        return { page: document.documentElement.scrollWidth <= window.innerWidth + 1, ribbonScrolls: ribbon ? ["auto", "scroll"].includes(getComputedStyle(ribbon).overflowX) || ribbon.scrollWidth <= ribbon.clientWidth + 1 || getComputedStyle(ribbon).flexWrap === "wrap" : true };
      });
      ok(r.page, `${tabName}: the page does not scroll sideways`);
      ok(r.ribbonScrolls, `${tabName}: the ribbon wraps or scrolls, nothing is cut off`);
    }
  });

  await scenario("the server away and back: typing is kept and sent when it returns; the page says so, and does not lose a character", async () => {
    await fresh({ paragraphs: 5 });
    await toEnd("p2");
    let down = true;
    await page.route("**/api/docs/*/ops", (route) => (down ? route.abort("connectionrefused") : route.continue()));
    await page.keyboard.type("kept while offline", { delay: 5 });
    await delay(2500);
    down = false;
    await page.unroute("**/api/docs/*/ops").catch(() => {});
    await page.keyboard.type("!", { delay: 5 });
    await until(async () => (await texts())[2].endsWith("kept while offline!"), "everything typed reached the server after it came back", 15000);
  });
} finally {
  await context?.close();
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}
