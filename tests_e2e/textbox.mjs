/** Browser tests for text boxes: Insert (gallery, draw, default), typing at once, rich text and paragraph styles inside, the move handle, the resize
 *  handle, numeric size, auto-expand, pin and lock, wrapping, cross-page drag, undo/redo, copy/paste, persistence, and that no selection chrome is
 *  ever part of the document. Real Chromium, real server.
 *    NODE_PATH=<dir with playwright> node tests_e2e/textbox.mjs */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("tbox");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const boxes = async () => (await doc()).blocks.filter((b) => b.extensions?.["slai.writer.shape"]?.textbox);
const box = async (n = 0) => (await boxes())[n];
const shapeOf = async (n = 0) => (await box(n))?.extensions?.["slai.writer.shape"];
const op = (o) => api("POST", `/docs/${sid}/ops`, { op: o });

async function fresh({ paragraphs = 3 } = {}) {
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
  const ops = [{ op: "text", block: s.blocks[0].id, start: 0, end: s.blocks[0].text.length, insert: "First paragraph of the page." }];
  let after = s.blocks[0].id;
  for (let n = 1; n < paragraphs; n++) { const id = `p${n}`; ops.push({ op: "block_insert", after, block: { id, type: "paragraph", text: `Paragraph number ${n + 1}. ` + "Words fill the line. ".repeat(12) } }); after = id; }
  const r = await op({ op: "batch", ops });
  if (r.status >= 300) throw new Error("setup failed " + JSON.stringify(r.body).slice(0, 300));
  await page.reload(); await page.locator("#main").waitFor(); await delay(400);
}
const tab = (name) => page.getByRole("tab", { name, exact: true });
/** A real mouse click on the box's border band (the selection chrome may sit on top of it, which is the point). */
const edgeClick = async () => { await host().waitFor(); await delay(250); const r = await host().boundingBox(); await page.mouse.click(r.x + 3, r.y + 3); await page.locator(".imgsel[data-textbox='true'] .tb-move").waitFor(); };
const host = () => page.locator(".writer-shape[data-textbox]").first();
const rect = async (sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; }, sel);
async function insertDefault() {
  await tab("Insert").click();
  await page.getByRole("button", { name: "Text Box", exact: true }).click();
  await page.locator(".tb-gallery-item[data-preset='default']").click();
  await until(async () => (await boxes()).length >= 1, "box inserted");
  await until(async () => page.evaluate(() => document.activeElement?.classList.contains("tb-body")), "cursor in the new box");
}
const drag = async (from, to, steps = 8) => {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps);
  await page.mouse.up();
};
const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("Insert → Text Box → default drops a box on the page, selected, with the cursor in it: typing works at once and is saved as one undoable edit", async () => {
    await fresh();
    await insertDefault();
    const b = await box();
    ok(/^[A-Za-z0-9_-]+$/.test(b.id), "stable id");
    eq(b.text, "", "the carrier holds no document text");
    const s = b.extensions["slai.writer.shape"];
    eq(s.kind, "rectangle", "kind"); eq(s.layout.mode, "floating", "floating"); ok(s.width_mm >= 20 && s.height_mm >= 10, "sensible size");
    await page.keyboard.type("Hello text box");
    await page.keyboard.press("Escape");
    await until(async () => (await shapeOf()).textbox.paragraphs[0].text === "Hello text box", "text saved");
    eq((await shapeOf()).text.content, "Hello text box", "plain-text mirror kept for readers that do not know text boxes");
    const version = (await doc()).version;
    await page.locator(".sheets").click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press("Control+z");
    await until(async () => (await shapeOf()).textbox.paragraphs[0].text === "", "one Undo removes the whole typing session");
    await page.keyboard.press("Control+y");
    await until(async () => (await shapeOf()).textbox.paragraphs[0].text === "Hello text box", "Redo restores it");
    ok((await doc()).version >= version, "version moves forward");
  });

  await scenario("the gallery offers the predefined styles and drawing: a drag sets the size, Escape cancels", async () => {
    await fresh();
    await tab("Insert").click();
    await page.getByRole("button", { name: "Text Box", exact: true }).click();
    const names = await page.locator(".tb-gallery-name").allInnerTexts();
    for (const n of ["Text Box", "Callout", "Sidebar", "Pull Quote", "Dark Note", "Title Banner"]) ok(names.includes(n), `gallery has ${n}`);
    await page.getByLabel("Draw the box on the page (drag to size it)").check();
    await page.locator(".tb-gallery-item[data-preset='callout']").click();
    const body = await rect(".sheet .body");
    await drag({ x: body.x + 40, y: body.y + 60 }, { x: body.x + 340, y: body.y + 200 });
    await until(async () => (await boxes()).length === 1, "drawn box inserted");
    const s = await shapeOf();
    ok(Math.abs(s.width_mm - 300 / (await rect(".writer-shape[data-textbox]")).w * s.width_mm) < 1, "rendered width matches the drawn width");
    eq(s.fill.color, "#fff4c2", "the Callout style was used"); ok(s.corners_mm[0] > 0, "rounded corners");
    ok(s.height_mm > 20 && s.width_mm > 50, `size from the drag: ${s.width_mm} x ${s.height_mm}`);
    // Escape cancels drawing
    await page.keyboard.press("Escape");
    await tab("Insert").click();
    await page.getByRole("button", { name: "Draw Text Box" }).click();
    await page.keyboard.press("Escape");
    await drag({ x: body.x + 40, y: body.y + 400 }, { x: body.x + 200, y: body.y + 460 });
    await delay(300);
    eq((await boxes()).length, 1, "a cancelled draw adds nothing");
  });

  await scenario("selection chrome: dashed outline, a four-arrow move handle at the top-left, circular corner handles, a resize grip bottom-right; none of it is in the document", async () => {
    await fresh();
    await insertDefault();
    await page.keyboard.type("Chrome test"); await page.keyboard.press("Escape");
    await edgeClick();
    const overlay = page.locator(".imgsel[data-textbox='true']");
    await overlay.waitFor();
    const style = await overlay.evaluate((n) => { const c = getComputedStyle(n); return { outline: c.outlineStyle }; });
    eq(style.outline, "dashed", "dashed outline");
    ok(await page.locator(".imgsel .tb-move").isVisible(), "move handle visible");
    for (const c of ["nw", "ne", "sw", "se"]) ok(await page.locator(`.imgsel .ih.${c}`).isVisible(), `${c} handle visible`);
    const m = await rect(".imgsel .tb-move"), o = await rect(".imgsel");
    ok(m.x < o.x && m.y < o.y, "move handle sits at the top-left, outside the box");
    ok(await page.locator(".writer-shape[data-textbox] .imgsel, .writer-shape[data-textbox] .tb-move").count() === 0, "chrome is not inside the text box");
    const json = JSON.stringify(await doc());
    ok(!/imgsel|tb-move|tb-edge/.test(json), "no chrome in the saved document");
  });

  await scenario("the move handle drags smoothly: the grab offset is kept, the content is untouched, and the saved position matches what was seen", async () => {
    await fresh();
    await insertDefault();
    await page.keyboard.type("Move me"); await page.keyboard.press("Escape");
    await edgeClick();
    const before = await shapeOf(), r0 = await rect(".writer-shape[data-textbox]");
    const grab = centre(await rect(".imgsel .tb-move"));
    await drag(grab, { x: grab.x + 90, y: grab.y + 70 }, 12);
    await until(async () => (await shapeOf()).layout.x_mm !== before.layout.x_mm, "moved");
    const after = await shapeOf(), r1 = await rect(".writer-shape[data-textbox]");
    ok(Math.abs((r1.x - r0.x) - 90) < 4 && Math.abs((r1.y - r0.y) - 70) < 4, `moved by the pointer distance (${r1.x - r0.x}, ${r1.y - r0.y})`);
    const pxPerMm = r0.w / before.width_mm;
    ok(Math.abs((after.layout.x_mm - before.layout.x_mm) * pxPerMm - 90) < 6, "saved millimetres agree with the screen");
    eq(after.textbox.paragraphs, before.textbox.paragraphs, "content preserved");
    eq([after.width_mm, after.height_mm], [before.width_mm, before.height_mm], "size preserved");
    eq(await page.evaluate(() => String(getSelection())), "", "no accidental text selection");
    await page.keyboard.press("Control+z");
    await until(async () => (await shapeOf()).layout.x_mm === before.layout.x_mm, "Undo puts it back");
  });

  await scenario("the move handle stays accurate when the page is zoomed", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.type("Zoom"); await page.keyboard.press("Escape");
    await edgeClick();
    await page.keyboard.press("Control+-").catch(() => {});
    await page.getByRole("button", { name: /zoom out/i }).first().click().catch(() => {});
    await delay(400);
    await edgeClick();
    const before = await shapeOf(), r0 = await rect(".writer-shape[data-textbox]");
    const grab = centre(await rect(".imgsel .tb-move"));
    await drag(grab, { x: grab.x + 50, y: grab.y + 30 }, 10);
    await until(async () => (await shapeOf()).layout.x_mm !== before.layout.x_mm, "moved");
    const after = await shapeOf(), r1 = await rect(".writer-shape[data-textbox]");
    const pxPerMm = r0.w / before.width_mm;
    ok(Math.abs((r1.x - r0.x) - 50) < 4, `screen move ${r1.x - r0.x}`);
    ok(Math.abs((after.layout.x_mm - before.layout.x_mm) * pxPerMm - 50) < 6, `saved move agrees at this zoom (${pxPerMm.toFixed(2)} px/mm)`);
  });

  await scenario("the bottom-right handle resizes continuously, the text reflows, it stops at the minimum size, and Auto-expand grows the box to fit", async () => {
    await fresh();
    await insertDefault();
    await page.keyboard.type("A long sentence that must wrap when the box becomes narrower than the text. ".repeat(2)); await page.keyboard.press("Escape");
    await edgeClick();
    const before = await shapeOf();
    let grip = centre(await rect(".imgsel .ih.se"));
    await page.mouse.move(grip.x, grip.y); await page.mouse.down();
    await page.mouse.move(grip.x - 60, grip.y + 20, { steps: 6 });
    const live = await rect(".writer-shape[data-textbox]");
    ok(live.w < (await rect(".imgsel")).w + 2, "the box follows the pointer while dragging");
    await page.mouse.up();
    await until(async () => (await shapeOf()).width_mm < before.width_mm - 5, "narrower");
    let s = await shapeOf();
    ok(s.textbox.auto_expand && s.height_mm > before.height_mm, `auto-expand grew the box so the wrapped text fits (${before.height_mm} → ${s.height_mm} mm)`);
    // minimum size
    grip = centre(await rect(".imgsel .ih.se"));
    await drag(grip, { x: grip.x - 2000, y: grip.y - 2000 });
    await until(async () => (await shapeOf()).width_mm <= 10.1, "stopped at the minimum");
    s = await shapeOf();
    ok(s.width_mm >= 10 && s.height_mm >= 6, `minimum size respected (${s.width_mm} x ${s.height_mm})`);
    // a west/north corner keeps the opposite corner fixed
    await op({ op: "shape_set", block: (await box()).id, shape: { ...s, width_mm: 80, height_mm: 40 } });
    await until(async () => (await shapeOf()).width_mm === 80, "reset size");
    await page.reload(); await page.locator("#main").waitFor(); await delay(1500); await edgeClick(); await delay(600);     // a change made through the API reaches the page on reload
    const fixed = await rect(".writer-shape[data-textbox]");
    const nw = centre(await rect(".imgsel .ih.nw"));
    await drag(nw, { x: nw.x + 40, y: nw.y + 25 });
    await until(async () => (await shapeOf()).width_mm < 80, "resized from nw");
    const moved = await rect(".writer-shape[data-textbox]");
    ok(Math.abs((moved.x + moved.w) - (fixed.x + fixed.w)) < 3 && Math.abs((moved.y + moved.h) - (fixed.y + fixed.h)) < 6, "the opposite (bottom-right) corner stayed put");
  });

  await scenario("numeric width and height in the Text Box ribbon, with minimum size and Auto-expand off", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.press("Escape");
    await edgeClick();
    await tab("Text Box").waitFor();
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    const w = ribbon.getByLabel("Width (mm)"), h = ribbon.getByLabel("Height (mm)");
    await w.fill("95"); await w.press("Enter"); await w.blur();
    await until(async () => (await shapeOf()).width_mm === 95, "width set");
    await h.fill("33,5"); await h.press("Enter"); await h.blur();
    await until(async () => (await shapeOf()).height_mm === 33.5, "height set (decimal comma accepted)");
    await w.fill("3"); await w.press("Enter"); await w.blur();
    await page.getByText("Enter a value between 10 and 1000.").waitFor();          // below the minimum is refused with a message, not silently changed
    eq((await shapeOf()).width_mm, 95, "a refused width leaves the box as it was");
    eq(await w.inputValue(), "95", "the field shows the real width again");
    await w.fill("10"); await w.press("Enter"); await w.blur();
    await until(async () => (await shapeOf()).width_mm === 10, "the minimum itself is accepted");
    await ribbon.getByLabel("Auto-expand: the box grows to fit its text").uncheck();
    await until(async () => (await shapeOf()).textbox.auto_expand === false, "auto-expand off");
  });

  await scenario("rich text inside: bold, size, colour, headings, lists, alignment and a named style — saved as paragraphs and spans, shown identically after a reload", async () => {
    await fresh();
    await insertDefault();
    await page.keyboard.type("Title line"); await page.keyboard.press("Enter");
    await page.keyboard.type("Body with bold words"); await page.keyboard.press("Enter");
    await page.keyboard.type("First item"); await page.keyboard.press("Enter"); await page.keyboard.type("Second item");
    // list on the last two paragraphs
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    await page.keyboard.down("Shift"); await page.keyboard.press("ArrowUp"); await page.keyboard.up("Shift");
    await ribbon.getByRole("button", { name: "Bulleted list" }).click();
    // bold on "bold words" in paragraph 2
    await page.evaluate(() => {
      const p = document.querySelectorAll(".tb-body .tb-para")[1];
      const t = p.firstChild; const range = document.createRange(); range.setStart(t, 10); range.setEnd(t, 20);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    });
    await ribbon.getByRole("button", { name: "Bold" }).click();
    await ribbon.getByLabel("Text box font size (pt)").fill("20"); await ribbon.getByLabel("Text box font size (pt)").press("Enter");
    // heading on paragraph 1
    await page.evaluate(() => { const t = document.querySelectorAll(".tb-body .tb-para")[0].firstChild; const r = document.createRange(); r.setStart(t, 2); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); });
    await ribbon.getByLabel("Paragraph style in the text box").selectOption("role:heading1");
    await ribbon.getByRole("button", { name: "Align center" }).click();
    await page.keyboard.press("Escape");
    await until(async () => (await shapeOf()).textbox.paragraphs.length === 4, "saved");
    const s = await shapeOf(), p = s.textbox.paragraphs;
    eq(p.map((x) => x.text), ["Title line", "Body with bold words", "First item", "Second item"], "paragraph texts");
    eq([p[0].role, p[0].align], ["heading1", "center"], "heading and centre on paragraph 1");
    eq([p[2].list, p[3].list], ["bullet", "bullet"], "bullets on the last two");
    const span = p[1].spans.find((x) => x.bold);
    eq([span.start, span.end, span.font_size_pt], [10, 20, 20], "bold and size on exactly the selected text");
    eq(s.text.content, p.map((x) => x.text).join("\n"), "mirror in step");
    const html1 = await page.locator(".writer-shape[data-textbox] .tb-body").evaluate((n) => n.innerHTML);
    await page.reload(); await page.locator("#main").waitFor(); await delay(500);
    const html2 = await page.locator(".writer-shape[data-textbox] .tb-body").evaluate((n) => n.innerHTML);
    eq(html2, html1, "the box looks the same after a reload");
    const heading = await page.locator(".tb-para[data-role='heading1']").evaluate((n) => ({ w: getComputedStyle(n).fontWeight, s: parseFloat(getComputedStyle(n).fontSize) }));
    ok(heading.w === "700" && heading.s > 16, "heading is bold and bigger");
  });

  await scenario("the Home paragraph-style list works inside a box: Scripture is typography only (the same definition as the page's Scripture style), no columns are added", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.type("In the beginning was the Word");
    const sectionsBefore = (await doc()).document.sections?.length ?? 0;
    await tab("Home").click();
    await page.getByLabel("Paragraph style", { exact: true }).selectOption("scripture");
    await page.keyboard.press("Escape");
    await until(async () => (await shapeOf()).textbox.paragraphs[0].style === "Scripture", "Scripture style on the paragraph");
    eq(((await doc()).document.sections ?? []).length, sectionsBefore, "no column section was created");
    const css = await page.locator(".tb-para[data-style='Scripture']").evaluate((n) => ({ f: getComputedStyle(n).fontStyle, family: getComputedStyle(n).fontFamily }));
    eq(css.f, "italic", "Scripture is italic"); ok(/Times New Roman/.test(css.family), `Scripture font: ${css.family}`);
  });

  await scenario("appearance: border style (including double and none), colour and thickness, fill, opacity, corner radius — all through the same shape operation", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.press("Escape");
    await edgeClick();
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    for (const style of ["dashed", "dotted", "double", "solid"]) {
      await ribbon.getByLabel("Border style").selectOption(style);
      await until(async () => (await shapeOf()).outline.style === style, `border ${style}`);
    }
    await ribbon.getByLabel("Border style").selectOption("none");
    await until(async () => (await shapeOf()).outline.enabled === false, "border off");
    await ribbon.getByLabel("Border style").selectOption("double");
    await ribbon.getByLabel("Border thickness (pt)").fill("2"); await ribbon.getByLabel("Border thickness (pt)").press("Enter");
    await ribbon.getByLabel("Text box fill color").fill("#336699");
    await ribbon.getByLabel("Corner radius (mm)").fill("6"); await ribbon.getByLabel("Corner radius (mm)").press("Enter");
    await ribbon.getByLabel("Text box opacity (%)").fill("60"); await ribbon.getByLabel("Text box opacity (%)").press("Enter");
    await until(async () => { const s = await shapeOf(); return s.fill.color === "#336699" && s.corners_mm[2] === 6 && s.opacity === 0.6 && s.outline.width_pt === 2; }, "fill, corners, opacity, thickness saved");
    const paths = await page.locator(".writer-shape[data-textbox] svg path").count();
    ok(paths >= 2, `a double border draws two outlines (${paths} paths)`);
    await ribbon.getByRole("button", { name: "No Fill" }).click();
    await until(async () => (await shapeOf()).fill.enabled === false, "no fill");
  });

  await scenario("pin keeps the position but the box stays editable and resizable; the server refuses a move while pinned; unpinning restores movement", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.type("Pinned"); await page.keyboard.press("Escape");
    await edgeClick();
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    await ribbon.getByRole("button", { name: "Pin Position" }).click();
    await until(async () => (await shapeOf()).textbox.pinned === true, "pinned saved");
    const pinned = await shapeOf();
    const grab = centre(await rect(".imgsel .tb-move"));
    await drag(grab, { x: grab.x + 80, y: grab.y + 80 });
    await delay(300);
    eq((await shapeOf()).layout, pinned.layout, "dragging a pinned box does nothing");
    const refused = await op({ op: "shape_set", block: (await box()).id, shape: { ...pinned, layout: { ...pinned.layout, x_mm: pinned.layout.x_mm + 10 } } });
    ok(refused.status >= 400 && /pinned/i.test(JSON.stringify(refused.body)), "the server refuses to move a pinned box");
    const moveOp = await op({ op: "move", blocks: [(await box()).id], after: null });
    ok(moveOp.status >= 400, "and refuses to reorder it");
    await host().click({ position: { x: 40, y: 20 } });
    await page.keyboard.type(" and still editable"); await page.keyboard.press("Escape");
    await until(async () => /still editable/.test((await shapeOf()).textbox.paragraphs[0].text), "text editable while pinned");
    const grip = centre(await rect(".imgsel .ih.se"));
    await drag(grip, { x: grip.x + 40, y: grip.y + 10 });
    await until(async () => (await shapeOf()).width_mm > pinned.width_mm, "resizable while pinned");
    ok(await ribbon.getByLabel("Horizontal position (mm)").isDisabled(), "position fields are disabled while pinned");
    await ribbon.getByRole("button", { name: "Unpin Position" }).click();
    await until(async () => (await shapeOf()).textbox.pinned === false, "unpinned");
    await page.locator(".imgsel[data-pinned='false']").waitFor(); await delay(200);
    const grab2 = centre(await rect(".imgsel .tb-move"));
    await drag(grab2, { x: grab2.x + 60, y: grab2.y + 20 });
    await until(async () => (await shapeOf()).layout.x_mm !== pinned.layout.x_mm, "movable again");
  });

  await scenario("lock freezes the whole object: no editing, no changes, no delete; unlock frees it", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.type("Locked"); await page.keyboard.press("Escape");
    await edgeClick();
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    await ribbon.getByRole("button", { name: "Lock Object" }).click();
    await until(async () => (await shapeOf()).textbox.locked === true, "locked");
    const s = await shapeOf();
    const edit = await op({ op: "shape_set", block: (await box()).id, shape: { ...s, textbox: { ...s.textbox, paragraphs: [{ text: "x" }] }, text: { ...s.text, content: "x" } } });
    ok(edit.status >= 400 && /locked/i.test(JSON.stringify(edit.body)), "the server refuses changes");
    const del = await op({ op: "block_delete", blocks: [(await box()).id] });
    ok(del.status >= 400, "and refuses to delete it");
    await host().click({ position: { x: 60, y: 25 } });
    await delay(200);
    ok(!(await page.locator(".tb-body[data-editing]").count()), "a locked box cannot be edited");
    ok(await ribbon.getByLabel("Width (mm)").isDisabled(), "ribbon controls are disabled");
    await ribbon.getByRole("button", { name: "Unlock Object" }).click();
    await until(async () => (await shapeOf()).textbox.locked === false, "unlocked");
    await host().click({ position: { x: 60, y: 25 } });
    await until(async () => (await page.locator(".tb-body[data-editing]").count()) === 1, "editable again");
  });

  await scenario("wrapping: In Front, Behind, Top and Bottom, In Line each persist and render without breaking the layout; Square is offered only as unavailable", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.press("Escape");
    await edgeClick();
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    const wrap = ribbon.getByLabel("Text wrapping");
    ok(await wrap.locator("option[value='square']").isDisabled(), "Square is disabled with a reason");
    const paragraphsBefore = (await doc()).blocks.filter((b) => !b.extensions?.["slai.writer.shape"]).map((b) => b.text);
    for (const [value, check] of [["behind", (s) => s.layout.layer === "behind_text"], ["top_bottom", (s) => s.layout.wrap === "top_bottom"],
      ["front", (s) => s.layout.layer === "in_front_of_text" && s.layout.wrap === "none"], ["inline", (s) => s.layout.mode === "inline"]]) {
      await wrap.selectOption(value);
      await until(async () => check(await shapeOf()), `wrapping ${value}`);
      await delay(250);
      eq((await doc()).blocks.filter((b) => !b.extensions?.["slai.writer.shape"]).map((b) => b.text), paragraphsBefore, `body text untouched by ${value}`);
      ok(await host().isVisible(), `box still rendered with ${value}`);
    }
  });

  await scenario("cross-page drag: dragging the move handle onto the next page re-anchors the box to that page; size, content and formatting are preserved; Undo returns it", async () => {
    await fresh({ paragraphs: 14 });
    await insertDefault(); await page.keyboard.type("Travelling box"); await page.keyboard.press("Escape");
    const sheets = await page.locator(".sheet").count();
    ok(sheets >= 2, `the document has several pages (${sheets})`);
    await edgeClick();
    const before = await shapeOf();
    const target = (await box()).id;
    const second = await rect(".sheet:nth-of-type(2) .body");
    ok(second, "second page present");
    await page.evaluate(() => document.querySelector(".scroller").scrollTo(0, 0));
    const grab = centre(await rect(".imgsel .tb-move"));
    // scroll so that both pages are reachable, then drag to the middle of page 2's body
    const body2 = await page.evaluate(() => { const b = document.querySelectorAll(".sheet")[1].querySelector(".body").getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, vh: innerHeight }; });
    const to = { x: body2.x + 120, y: Math.min(body2.y + 80, body2.vh - 60) };
    await drag(grab, to, 25);
    await until(async () => (await shapeOf()).layout.target !== before.layout.target, "re-anchored to a block on another page");
    const after = await shapeOf();
    const page2 = await page.evaluate(() => [...document.querySelectorAll(".sheet")].findIndex((s) => s.querySelector(".writer-shape[data-textbox]")));
    ok(page2 >= 1, `the box is rendered on page ${page2 + 1}`);
    eq(await page.locator(".writer-shape[data-textbox]").count(), 1, "not duplicated, not lost");
    eq(after.textbox.paragraphs, before.textbox.paragraphs, "content preserved");
    eq([after.width_mm, after.height_mm], [before.width_mm, before.height_mm], "size preserved");
    ok(after.layout.y_mm > -after.height_mm && after.layout.x_mm >= 0, `page-local position (relative to the page the box landed on, not the first page) (${after.layout.x_mm}, ${after.layout.y_mm})`);
    await page.keyboard.press("Control+z");
    await until(async () => (await shapeOf()).layout.target === before.layout.target, "Undo returns it to the first page");
    void target;
  });

  await scenario("drag near the viewport edge auto-scrolls toward the next page", async () => {
    await fresh({ paragraphs: 14 });
    await insertDefault(); await page.keyboard.press("Escape");
    await edgeClick();
    await page.evaluate(() => document.querySelector(".scroller").scrollTo(0, 0));
    const grab = centre(await rect(".imgsel .tb-move"));
    const top0 = await page.evaluate(() => document.querySelector(".scroller").scrollTop);
    await page.mouse.move(grab.x, grab.y); await page.mouse.down();
    await page.mouse.move(grab.x + 5, grab.y + 40, { steps: 3 });
    await page.mouse.move(grab.x + 5, 940, { steps: 4 });
    await delay(900);
    const top1 = await page.evaluate(() => document.querySelector(".scroller").scrollTop);
    await page.mouse.up();
    ok(top1 > top0 + 40, `the view scrolled while dragging (${top0} → ${top1})`);
  });

  await scenario("a text box next to a table and a heading: clicking the table or heading never selects or edits the box; Delete removes only the selected box", async () => {
    await fresh();
    await op({ op: "block_insert", after: "p1", block: { id: "tbl", type: "table", text: "", table: { columns: 2, header_rows: 0, rows: [[{ text: "a" }, { text: "b" }], [{ text: "c" }, { text: "d" }]] } } });
    await op({ op: "block_insert", after: "tbl", block: { id: "hd", type: "heading", text: "A heading", attributes: { level: 1 } } });
    await page.reload(); await page.locator("#main").waitFor(); await delay(400);
    await insertDefault(); await page.keyboard.type("Beside a table"); await page.keyboard.press("Escape");
    await page.locator("#main .blk[data-id='hd'] [data-edit=text]").click();
    await delay(200);
    ok(!(await page.locator(".tb-body[data-editing]").count()), "the box is not in editing mode");
    ok(!(await page.locator(".imgsel[data-textbox='true']").count()), "the box is no longer selected");
    await page.locator("#main .blk[data-id='tbl'] td").first().click();
    ok(!(await page.locator(".tb-body[data-editing]").count()), "table click does not edit the box");
    await edgeClick();
    await page.keyboard.press("Delete");
    await until(async () => (await boxes()).length === 0, "the selected box is deleted");
    const left = (await doc()).blocks.map((b) => b.id);
    ok(left.includes("tbl") && left.includes("hd"), "table and heading remain");
  });

  await scenario("copy and paste of a selected box makes a new, free box (not pinned or locked), offset from the original; duplicate does the same", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.type("Copy me"); await page.keyboard.press("Escape");
    await edgeClick();
    const ribbon = page.getByRole("toolbar", { name: "Text Box ribbon" });
    await ribbon.getByRole("button", { name: "Pin Position" }).click();
    await until(async () => (await shapeOf()).textbox.pinned, "pinned");
    await ribbon.getByRole("button", { name: "Duplicate" }).click();
    await until(async () => (await boxes()).length === 2, "duplicate made");
    const [a, b] = [await shapeOf(0), await shapeOf(1)];
    eq(b.textbox.paragraphs, a.textbox.paragraphs, "same content");
    eq([b.textbox.pinned, b.textbox.locked], [false, false], "the copy is free");
    ok(b.layout.x_mm !== a.layout.x_mm, "offset from the original");
    ok((await boxes())[0].id !== (await boxes())[1].id, "new stable id");
  });

  await scenario("export: the editor's selection chrome never reaches an export, and a text box exports as a picture of its real text (PDF)", async () => {
    await fresh();
    await insertDefault(); await page.keyboard.type("Exported words"); await page.keyboard.press("Escape");
    await edgeClick();
    const pre = await api("GET", `/docs/${sid}/preflight?target=pdf`);
    ok(pre.status < 300, `preflight ${pre.status}`);
    ok(/Text boxes are exported as pictures/.test(JSON.stringify(pre.body)), "preflight tells the truth about the format");
    const r = await api("POST", `/docs/${sid}/export`, { format: "pdf" });
    ok(r.status < 300 || r.status === 503, `export answered ${r.status}`);
    if (r.status < 300) {
      // Look at the real exported page: the box's words are there as a picture, and none of the editor's blue selection chrome is.
      const out = join(tmpdir(), `tb-export-${process.pid}`);
      execFileSync("pdftoppm", ["-r", "110", "-png", "-singlefile", r.body.data.path, out]);
      const png = readFileSync(out + ".png").toString("base64");
      const px = await page.evaluate(async (b64) => {
        const img = new Image(); img.src = "data:image/png;base64," + b64; await img.decode();
        const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
        const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let blue = 0, dark = 0;
        for (let k = 0; k < d.length; k += 4) {
          const [R, G, B] = [d[k], d[k + 1], d[k + 2]];
          if (B > 150 && R < 90 && G > 90 && G < 160) blue++;           // the selection blue (#296bc4 / #3b82f6)
          if (R < 80 && G < 80 && B < 80) dark++;
        }
        return { w: img.width, h: img.height, blue, dark };
      }, png);
      eq(px.blue, 0, `no selection chrome in the exported page (${px.w}x${px.h})`);
      ok(px.dark > 150, `the box's text is on the page as dark pixels (${px.dark})`);
    }
  });

  await scenario("legacy and plain shapes are untouched: an ordinary rectangle still renders as a shape and has no text-box chrome", async () => {
    await fresh();
    await tab("Insert").click();
    await op({ op: "block_insert", after: "p1", block: { id: "plain", type: "paragraph", text: "", extensions: { "slai.writer.shape": {
      version: 1, kind: "rectangle", width_mm: 40, height_mm: 20, rotation_deg: 0, opacity: 1, fill: { enabled: true, color: "#f1d24b", opacity: 1 },
      outline: { enabled: true, color: "#202020", opacity: 1, width_pt: 1.5, style: "solid" }, corners_mm: [0, 0, 0, 0],
      text: { content: "Plain", color: "#171717", font_size_pt: 12, bold: false, italic: false, align: "center", padding_mm: 2, spans: [], fit: "keep" },
      shadows: [], layout: { mode: "inline" }, z_index: 0 } } } });
    await page.reload(); await page.locator("#main").waitFor(); await delay(400);
    ok((await page.locator(".writer-shape:not([data-textbox])").count()) === 1, "plain shape rendered");
    await page.locator(".writer-shape").first().click();
    await delay(200);
    ok((await page.locator(".imgsel[data-textbox='true']").count()) === 0, "no text-box chrome on a plain shape");
    ok(!(await page.getByRole("tab", { name: "Text Box", exact: true }).isVisible().catch(() => false)), "no Text Box tab for a plain shape");
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}
