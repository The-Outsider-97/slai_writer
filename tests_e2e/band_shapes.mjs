/** Browser test for the shapes of headers and footers: insert (through the Insert ribbon, with a header being edited), select, move, resize, format, order, lock,
 *  duplicate, delete, on the pages that use the header or footer and only on them (first page, odd and even pages), what the margins do to them, that the body is
 *  untouched, that they are saved and reopened, and that the exported PDF and the Rendered View show the same. Real Chromium, real server, real PDF.
 *    NODE_PATH=<dir with playwright> node tests_e2e/band_shapes.mjs */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, runner, chromium, until, ok, eq, delay, root } from "./harness.mjs";

const server = await startServer("bands");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];
const work = mkdtempSync(join(tmpdir(), "bands-"));
const PAGES = 4;
const PINK = "#ff00aa";

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const op = async (o) => { const r = await api("POST", `/docs/${sid}/ops`, { op: o }); ok(r.status < 300, `op ${o.op} failed: ${JSON.stringify(r.body).slice(0, 300)}`); return r; };
const ext = async () => ((await doc()).document?.extensions ?? (await doc()).meta?.extensions ?? {})["slai.writer"] ?? {};
const store = async () => (await ext()).band_shapes ?? {};
const sectionId = async () => ((await doc()).document?.sections ?? (await doc()).meta?.sections ?? [])[0]?.id;
const items = async (edge = "header", variant = "default") => { const s = await store(); const e = Object.values(s)[0] ?? {}; return e[edge]?.[variant] ?? []; };

async function fresh() {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 });
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
  const ops = [];
  for (let n = 0; n < PAGES; n++) {
    ops.push({ op: "block_insert", after, block: { id: `p${n}`, type: "paragraph", text: `Body text of page ${n + 1}.`, attributes: n ? { page_break_before: true } : {} } });
    after = `p${n}`;
  }
  await op({ op: "batch", ops });
  await page.reload(); await page.locator("#main").waitFor();
  await until(async () => (await page.locator(".sheet").count()) >= PAGES, "pages");
  await delay(300);
}

/** The screen position of a point on a sheet, from millimetres on the page. */
async function at(sheet, xMm, yMm) {
  await page.locator(".sheet").nth(sheet).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await delay(150);
  const box = await page.locator(".sheet").nth(sheet).boundingBox();
  const k = box.width / 210;
  return { x: box.x + xMm * k, y: box.y + yMm * k, k };
}
/** An edit made through the API is not pushed to the open page: the page is opened again. */
const reopen = async () => { await page.reload(); await page.locator("#main").waitFor(); await until(async () => (await page.locator(".sheet").count()) >= PAGES, "pages"); await delay(400); };
const tab = (name) => page.getByRole("tab", { name, exact: true });
const bandShapes = (sheet) => page.locator(".sheet").nth(sheet).locator(".band-shape");
const counts = () => page.evaluate(() => [...document.querySelectorAll(".sheet")].map((s) => s.querySelectorAll(".band-shape").length));
const frameLeft = async (sheet) => page.evaluate((n) => { const s = document.querySelectorAll(".sheet")[n]; const b = s.querySelector(".band-shape"); return b ? parseFloat(b.style.left) : null; }, sheet);

async function openHeader(sheet = 0) {
  const p = await at(sheet, 105, 8);
  await page.mouse.dblclick(p.x, p.y);
  await page.locator(".band-edit-layer").first().waitFor();
}
/** Draw a shape by dragging on a sheet (the placement tool must be armed). */
async function drag(sheet, x0, y0, x1, y1) {
  const a = await at(sheet, x0, y0), b = await at(sheet, x1, y1);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 }); await page.mouse.move(b.x, b.y, { steps: 4 }); await page.mouse.up();
}
async function addRect(sheet = 0, rect = [30, 6, 90, 16]) {
  await page.getByRole("button", { name: "Rectangle", exact: true }).click();
  await drag(sheet, ...rect);
  await until(async () => (await items()).length > 0, "stored");
}
const pdfFile = async (tag) => {
  const base64 = await page.evaluate(async (id) => {
    const r = await fetch(`/api/docs/${id}/download`, { method: "POST", headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: JSON.stringify({ format: "pdf" }) });
    const bytes = new Uint8Array(await r.arrayBuffer());
    let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, sid);
  const path = join(work, `${tag}.pdf`);
  writeFileSync(path, Buffer.from(base64, "base64"));
  return path;
};
/** For each page of a PDF: how many drawn shapes have this fill colour, and the top-most / left-most of them (points). */
const pdfFills = (path, colour) => JSON.parse(execFileSync("python3", ["-I", "-c", `
import json, sys, pdfplumber
want = sys.argv[2].lower()
out = []
with pdfplumber.open(sys.argv[1]) as pdf:
    for page in pdf.pages:
        hits = []
        for o in page.rects + page.curves:
            c = o.get("non_stroking_color")
            if not o.get("fill") or c is None: continue
            if len(c) == 1: c = (c[0],) * 3
            h = "#%02x%02x%02x" % tuple(int(round(v * 255)) for v in c[:3])
            if h == want: hits.append(o)
        out.append({"n": len(hits), "x0": min([h["x0"] for h in hits], default=None), "top": min([h["top"] for h in hits], default=None), "x1": max([h["x1"] for h in hits], default=None), "bottom": max([h["bottom"] for h in hits], default=None)})
print(json.dumps(out))
`, path, colour], { encoding: "utf8" }).trim().split("\n").pop());
const setColour = async (label, value) => { const input = page.getByLabel(label, { exact: true }); await input.evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, value); };

try {
  browser = await chromium.launch();

  await scenario("a header opens for editing from the margin and from Insert; the body is untouched", async () => {
    await fresh();
    await page.locator(".sheet").first().locator(".blk[data-id]").first().click();           // a caret in the body
    const before = await page.evaluate(() => getSelection()?.anchorNode?.textContent ?? "");
    await openHeader(0);
    ok(await tab("Header & Footer").isVisible(), "the Header & Footer tab appears");
    eq(await page.locator(".band-edit-layer").count(), PAGES, "every page that uses the header shows its zone");
    eq(await page.locator("#main").getAttribute("contenteditable"), "false", "the body takes no typing");
    const pe = await page.evaluate(() => getComputedStyle(document.querySelector(".sheet .body")).pointerEvents);
    eq(pe, "none", "the body takes no clicks");
    await page.keyboard.press("Escape");
    await until(async () => (await page.locator(".band-edit-layer").count()) === 0, "closed");
    ok((await page.locator("#main").getAttribute("contenteditable")) !== "false", "the body is editable again");
    ok(!(await tab("Header & Footer").isVisible()), "the tab goes away");
    const after = await page.evaluate(() => getSelection()?.anchorNode?.textContent ?? "");
    eq(after, before, "the caret is where it was");
    // and from Insert → Header
    await tab("Insert").click();
    await page.getByRole("button", { name: "Footer", exact: true }).click();
    await page.locator(".band-edit-layer").first().waitFor();
    eq(await page.locator(".band-zone.footer").count(), PAGES, "the footer of every page");
    await page.getByRole("button", { name: "Close Header & Footer" }).click();
    await until(async () => (await page.locator(".band-edit-layer").count()) === 0, "closed by the button");
  });

  await scenario("a shape inserted through Insert → Insert Shape repeats on every page that uses the header, and nowhere else", async () => {
    await fresh();
    await openHeader(1);
    await tab("Insert").click();
    await page.getByRole("button", { name: "Insert Shape", exact: true }).click();
    await page.getByRole("button", { name: "Insert rectangle" }).click();
    await until(async () => (await page.locator("dialog[open]").count()) === 0, "the gallery is closed");
    await drag(1, 30, 6, 90, 16);
    await until(async () => (await items()).length === 1, "stored in the header");
    const it = (await items())[0];
    ok(Math.abs(it.x_mm - 5) < 1.5 && it.shape.kind === "rectangle", `frame-relative position ${JSON.stringify([it.x_mm, it.y_mm])}`);
    await until(async () => (await counts()).every((n) => n === 1), "one on every page");
    const lefts = await Promise.all([0, 1, 2, 3].map(frameLeft));
    ok(lefts.every((l) => Math.abs(l - lefts[0]) < 0.01), `the same place on every page ${lefts}`);
    eq((await items("footer")).length, 0, "nothing in the footer");
    eq(await page.locator("#main .blk[data-id] .band-shape").count(), 0, "not in the body");
    eq(await page.locator("#main .body .band-shape").count(), 0, "none of them is inside the body");
  });

  await scenario("move, resize, format, order, lock, duplicate and delete are one undo step each and are shown on all pages", async () => {
    await fresh();
    await openHeader(0);
    await addRect(0);
    const id = (await items())[0].id;
    const hit = page.locator(".sheet").first().locator(`.band-hit[data-band-id="${id}"]`);
    ok(await hit.getAttribute("data-selected") === "true", "the new shape is selected");
    // move by mouse: 20 mm right, 4 mm down
    const b0 = await hit.boundingBox();
    const k = b0.width / 60;
    await page.mouse.move(b0.x + b0.width / 2, b0.y + b0.height / 2); await page.mouse.down();
    await page.mouse.move(b0.x + b0.width / 2 + 10 * k, b0.y + b0.height / 2 + 2 * k, { steps: 3 });
    await page.mouse.move(b0.x + b0.width / 2 + 20 * k, b0.y + b0.height / 2 + 4 * k, { steps: 3 });
    await page.mouse.up();
    await until(async () => Math.abs((await items())[0].x_mm - ((await items())[0].x_mm)) < 1 && (await items())[0].x_mm > 20, "moved");
    const moved = (await items())[0];
    ok(Math.abs(moved.x_mm - (5 + 20)) < 1.2 && Math.abs(moved.y_mm - (6 + 4)) < 1.2, `moved to ${moved.x_mm}, ${moved.y_mm}`);
    // resize with the south-east handle: 10 mm wider, 4 mm taller
    const h1 = await page.locator(".sheet").first().locator(`.band-hit[data-band-id="${id}"]`).boundingBox();
    await page.mouse.move(h1.x + h1.width - 1, h1.y + h1.height - 1); await page.mouse.down();
    await page.mouse.move(h1.x + h1.width + 5 * k, h1.y + h1.height + 2 * k, { steps: 3 });
    await page.mouse.move(h1.x + h1.width + 10 * k, h1.y + h1.height + 4 * k, { steps: 3 });
    await page.mouse.up();
    await until(async () => (await items())[0].shape.width_mm > 65, "resized");
    const sized = (await items())[0];
    ok(Math.abs(sized.shape.width_mm - 70) < 1.5 && Math.abs(sized.shape.height_mm - 14) < 1.5, `size ${sized.shape.width_mm} x ${sized.shape.height_mm}`);
    ok(Math.abs(sized.x_mm - moved.x_mm) < 0.1 && Math.abs(sized.y_mm - moved.y_mm) < 0.1, "the top-left corner stayed");
    // every page shows the new size
    const widths = await page.evaluate(() => [...document.querySelectorAll(".band-shape")].map((n) => parseFloat(n.style.width)));
    ok(widths.length === PAGES && widths.every((w) => Math.abs(w - sized.shape.width_mm) < 0.01), `all pages ${widths}`);
    // format through the ribbon
    await setColour("Fill colour", PINK);
    await until(async () => (await items())[0].shape.fill.color === PINK, "fill");
    await page.getByLabel("Transparency: opacity %").fill("50"); await page.getByLabel("Transparency: opacity %").press("Tab");
    await until(async () => Math.abs((await items())[0].shape.opacity - 0.5) < 0.01, "opacity");
    await page.getByLabel("Corner radius (mm)").fill("3"); await page.getByLabel("Corner radius (mm)").press("Tab");
    await until(async () => (await items())[0].shape.corners_mm[0] === 3, "corners");
    await until(async () => (await page.locator(".sheet").nth(2).locator(".band-shape svg path").first().getAttribute("fill")) === PINK, "the colour is on page 3: " + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".sheet")].map((s) => s.querySelector(".band-shape svg path")?.getAttribute("fill") + " " + s.querySelector(".band-shape svg path")?.getAttribute("d").slice(0, 30)))) + JSON.stringify((await items())[0].shape.corners_mm));
    // behind the text
    await page.getByLabel("Behind or in front of the text").selectOption("behind");
    await until(async () => (await items())[0].layer === "behind", "layer");
    await until(async () => (await page.locator(".sheet").first().locator(".band-layer.behind .band-shape").count()) === 1, "drawn in the layer behind the text");
    const stack = await page.evaluate(() => { const s = document.querySelector(".sheet"); const z = (e) => Number(getComputedStyle(e).zIndex) || 0; return { layer: z(s.querySelector(".band-layer.behind")), block: z(s.querySelector(".body .blk")) }; });
    ok(stack.layer < stack.block, `the layer is under the text ${JSON.stringify(stack)}`);
    // duplicate, order, delete
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await until(async () => (await items()).length === 2, "duplicated");
    const [a, b] = await items();
    ok(a.id !== b.id && b.x_mm === a.x_mm + 5, "the copy is offset and has its own id");
    await page.getByRole("button", { name: "Send to back", exact: true }).click();
    await until(async () => (await items())[0].id === b.id, "sent to back");
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await until(async () => (await items()).length === 1, "deleted");
    // lock (nothing is selected after a delete: select the shape that is left)
    await page.locator(".sheet").first().locator(".band-hit").first().click();
    await until(async () => (await page.getByRole("button", { name: "Lock", exact: true }).isEnabled()), "selected again");
    await page.getByRole("button", { name: "Lock", exact: true }).click();
    await until(async () => (await items())[0].locked === true, "locked");
    const r = await api("POST", `/docs/${sid}/ops`, { op: { op: "band_shape_delete", section: await sectionId(), edge: "header", variant: "default", ids: [(await items())[0].id] } });
    ok(r.status >= 400, "the server refuses to delete a locked shape");
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await until(async () => (await items())[0].locked === false, "unlocked");
    // undo walks back one step at a time
    const history = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press("Control+z"); await delay(500); history.push(JSON.stringify((await items()).map((x) => [x.locked, x.layer]))); }
    ok(new Set(history).size >= 3, `undo undoes single steps ${history.join(" | ")}`);
  });

  await scenario("a different first page and odd and even pages have shapes of their own, shown on those pages only", async () => {
    await fresh();
    await openHeader(0);
    await addRect(0);
    await until(async () => (await counts()).every((n) => n === 1), "default on all pages");
    await page.getByLabel("Different first page").click();
    await until(async () => JSON.stringify(await counts()) === "[0,1,1,1]", "the first page now shows its own (empty) list");
    await until(async () => (await page.locator(".band-zone").count()) === 1, "only the first page is being edited");
    await page.getByRole("button", { name: "Rectangle", exact: true }).click();
    await drag(0, 100, 6, 150, 14);
    await until(async () => (await items("header", "first")).length === 1, "stored for the first page; messages: " + await page.locator(".toast, [role=alert], [role=status]").allTextContents());
    await until(async () => JSON.stringify(await counts()) === "[1,1,1,1]", "first page has its own shape");
    eq((await items("header", "default")).length, 1, "the default list is unchanged");
    await page.getByLabel("Different first page").click();
    await until(async () => (await page.locator(".band-zone").count()) === PAGES, "back to the default");
    // odd and even
    await page.getByLabel("Different odd & even pages").click();
    await until(async () => (await ext()).book_layouts && Object.values((await ext()).book_layouts)[0]?.odd_even === true, "odd and even on");
    await page.keyboard.press("Escape");
    await openHeader(1);
    eq(await page.locator(".band-zone").count(), 2, "only the even pages are being edited");
    await addRect(1, [20, 20, 40, 30]);
    await until(async () => (await items("header", "even")).length === 1, "stored for even pages");
    await until(async () => JSON.stringify(await counts()) === "[1,1,1,1]", "even pages show their own, odd the default");
    const places = await page.evaluate(() => [...document.querySelectorAll(".sheet")].map((s) => s.querySelector(".band-shape")?.dataset.bandVariant));
    eq(places, ["default", "even", "default", "even"], "which list each page draws");
  });

  await scenario("the shapes follow the margins and the page size, and a mirrored book swaps them on left-hand pages", async () => {
    await fresh();
    await openHeader(0);
    await addRect(0, [30, 6, 90, 16]);
    await page.keyboard.press("Escape");
    const left0 = await until(async () => (await frameLeft(0)) ?? false, "the shape is drawn on the page");     // the page is redrawn from the server's answer
    const section = await sectionId();
    await op({ op: "page_layout", scope: "document", margins_mm: { left: 40, right: 25, top: 25, bottom: 25 } });
    await reopen();
    await until(async () => Math.abs((await frameLeft(0)) - (left0 + 15)) < 0.2, "the shape moved with the frame");
    await op({ op: "page_setup", section, page: { width_mm: 148, height_mm: 210 } });
    await reopen();
    await until(async () => page.evaluate(() => Math.abs(document.querySelector(".sheet").getBoundingClientRect().width / document.querySelector(".sheet").getBoundingClientRect().height - 148 / 210) < 0.01), "A5");
    const small = await page.evaluate(() => [...document.querySelectorAll(".sheet")].map((s) => { const r = s.getBoundingClientRect(), b = s.querySelector(".band-shape").getBoundingClientRect(); return (b.left - r.left) / r.width; }));
    ok(small.every((f) => f > 0 && f < 1) && Math.abs(small[0] - small[3]) < 0.001, `still inside the page ${small}`);
    // a book: left-hand pages draw it from the other side
    await op({ op: "page_setup", section, page: { width_mm: 210, height_mm: 297 } });
    await op({ op: "page_layout", scope: "document", mirror: true, gutter_mm: 8 });
    await reopen();
    await until(async () => page.evaluate(() => document.querySelectorAll(".band-shape[data-band-mirrored=true]").length === 2), "left-hand pages mirror it");
    const sides = await page.evaluate(() => [...document.querySelectorAll(".sheet")].map((s) => { const r = s.getBoundingClientRect(), b = s.querySelector(".band-shape").getBoundingClientRect(); return (b.left - r.left + b.width / 2) / r.width; }));
    ok(sides[0] < 0.5 && sides[1] > 0.5 && sides[2] < 0.5 && sides[3] > 0.5, `right-hand pages left, left-hand pages right ${sides}`);
  });

  await scenario("saved with the document, in the exported PDF and in the Rendered View, on the same pages", async () => {
    await fresh();
    await openHeader(0);
    await addRect(0);
    await setColour("Fill colour", PINK);
    await until(async () => (await items())[0].shape.fill.color === PINK, "colour");
    await page.getByLabel("Different first page").click();
    await until(async () => JSON.stringify(await counts()) === "[0,1,1,1]", "first page has none");
    await page.keyboard.press("Escape");
    await page.reload(); await page.locator("#main").waitFor();
    await until(async () => JSON.stringify(await counts()) === "[0,1,1,1]", "after a reopen");
    const pdf = pdfFills(await pdfFile("a"), PINK);
    eq(pdf.map((p) => p.n > 0), [false, true, true, true], `the PDF: ${JSON.stringify(pdf)}`);
    const it = (await items())[0];
    const sheetTop = await page.evaluate(() => 0);
    void sheetTop;
    ok(Math.abs(pdf[1].top - it.y_mm * 72 / 25.4) < 1.5, `the PDF has it ${it.y_mm} mm from the top: ${pdf[1].top} pt`);
    ok(Math.abs(pdf[1].x0 - (25 + it.x_mm) * 72 / 25.4) < 1.5, `and ${25 + it.x_mm} mm from the left: ${pdf[1].x0} pt`);
    // the Rendered View is those pages' pictures
    await page.locator(".sbtn.rendered-toggle").click();
    await page.locator(".rendered .rv-page").first().waitFor();
    for (let i = 0; i < 4; i++) {
      await page.locator(".rendered .rv-page").nth(i).scrollIntoViewIfNeeded();
      await until(async () => page.evaluate((n) => { const img = document.querySelectorAll(".rv-img")[n]; return img && img.complete && img.naturalWidth > 0; }, i), `picture ${i + 1}`);
    }
    const seen = await page.evaluate(async () => [...document.querySelectorAll(".rv-img")].slice(0, 4).map((img) => {
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, Math.round(c.height * 0.12)).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] < 40 && d[i + 2] > 140 && d[i + 2] < 200) n++;
      return n;
    }));
    eq(seen.map((n) => n > 200), [false, true, true, true], `the Rendered View: ${seen}`);
    await page.locator(".sbtn.rendered-toggle").click();
  });

  await scenario("a shape of the header does not exist in the editor's body or selection, and typing still works afterwards", async () => {
    await fresh();
    await openHeader(0);
    await addRect(0);
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await until(async () => (await page.locator(".band-edit-layer").count()) === 0, "closed");
    await page.locator('.sheet .blk[data-id="p0"]').click();
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed.");
    await until(async () => ((await doc()).blocks.find((b) => b.id === "p0")).text.endsWith("Typed."), "typed text is saved");
    const picked = await page.evaluate(() => document.querySelectorAll(".blk[data-selected]").length);
    eq(picked, 0, "the shape is not a selectable object of the body");
  });

  await scenario("sections: a new section has shapes of its own, and linking and unlinking follow the previous section", async () => {
    await fresh();
    await op({ op: "section_break", block: "p2" });
    await reopen();
    await openHeader(0);
    await addRect(0);
    await until(async () => JSON.stringify(await counts()) === "[1,1,0,0]", "the first section has it, the second has not");
    await page.keyboard.press("Escape");
    await openHeader(2);
    await page.getByLabel("Link to previous section").click();
    await until(async () => JSON.stringify(await counts()) === "[1,1,1,1]", "linked: the second section shows the first one's shapes");
    const owner = Object.keys(await store())[0];
    // editing a linked header edits the shared list: page 1 changes too
    await setColour("Fill colour", PINK).catch(() => undefined);
    await page.locator(".sheet").nth(2).locator(".band-hit").first().click();
    await setColour("Fill colour", PINK);
    await until(async () => (await page.evaluate(() => [...document.querySelectorAll(".sheet")].map((s) => s.querySelector(".band-shape svg path")?.getAttribute("fill")))).every((f) => f === "#ff00aa"), "one list for both sections");
    // unlinked: a copy that is the section's own
    await page.getByLabel("Link to previous section").click();
    await until(async () => Object.keys(await store()).length === 2, "the second section has its own list");
    const own = await store();
    const ids = Object.values(own).map((e) => e.header.default[0].id);
    ok(ids[0] !== ids[1], "the copy has its own id");
    await page.locator(".sheet").nth(2).locator(".band-hit").first().click();
    await page.getByLabel("Corner radius (mm)").fill("4"); await page.getByLabel("Corner radius (mm)").press("Tab");
    await until(async () => JSON.stringify(Object.values(await store()).map((e) => e.header.default[0].shape.corners_mm[0]).sort()) === "[0,4]", "only the second section changed");
    void owner;
  });

  await scenario("a footer: a text box with its text, the keyboard (arrows, Delete, Ctrl+D), the footer's own distance from the bottom", async () => {
    await fresh();
    const p = await at(0, 105, 290);
    await page.mouse.dblclick(p.x, p.y);
    await page.locator(".band-zone.footer").first().waitFor();
    await page.getByRole("button", { name: "Text Box", exact: true }).click();
    await drag(0, 40, 276, 140, 286);
    await until(async () => (await items("footer")).length === 1, "a text box in the footer");
    const box = (await items("footer"))[0];
    ok(box.shape.textbox && box.y_mm > 5 && box.y_mm < 25, `measured from the bottom: ${box.y_mm}`);
    await page.getByLabel("Text in the shape").fill("Confidential\nSecond line"); await page.getByLabel("Text in the shape").press("Tab");
    await until(async () => (await items("footer"))[0].shape.textbox.paragraphs.map((q) => q.text).join("|") === "Confidential|Second line", "text stored");
    await until(async () => (await page.locator(".sheet").nth(3).locator(".band-shape").first().innerText()).includes("Confidential"), "the text is on page 4");
    const hit = page.locator(".sheet").first().locator(".band-hit").first();
    await hit.focus();
    await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
    await until(async () => Math.abs((await items("footer"))[0].x_mm - (box.x_mm + 2)) < 0.01, "two nudges of 1 mm");
    await page.keyboard.press("ArrowUp");
    await until(async () => Math.abs((await items("footer"))[0].y_mm - (box.y_mm + 1)) < 0.01, "up is away from the bottom edge in a footer");
    await page.keyboard.press("Control+d");
    await until(async () => (await items("footer")).length === 2, "duplicated from the keyboard");
    // the page is redrawn from the answer; a key is only meant for the shape once it is there and has the focus again
    await until(async () => (await page.locator(".sheet").first().locator(".band-hit").count()) === 2 && await page.evaluate(() => document.activeElement?.classList.contains("band-hit")), "the copy is drawn and has the focus");
    await page.keyboard.press("Delete");
    await until(async () => (await items("footer")).length === 1, "deleted from the keyboard");
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await until(async () => (await page.locator(".band-edit-layer").count()) === 0, "closed with Escape");
  });

  await scenario("two pages side by side: a shape is moved on the right-hand page and moves on both", async () => {
    await fresh();
    await page.locator(".sbtn.pages").click(); await page.getByRole("menuitem", { name: "2 pages" }).click(); await delay(500);
    const row = await page.evaluate(() => { const a = document.querySelectorAll(".sheet")[0].getBoundingClientRect(), b = document.querySelectorAll(".sheet")[1].getBoundingClientRect(); return Math.abs(a.top - b.top) < 3 && b.left > a.right - 2; });
    ok(row, "pages 1 and 2 are side by side");
    await openHeader(0);
    await addRect(0);
    await until(async () => (await counts()).every((n) => n === 1), "on every page");
    const before = (await items())[0];
    const hit = page.locator(".sheet").nth(1).locator(".band-hit").first();
    // the overlay is drawn again when the server's answer arrives: take the box once it has stopped changing
    let b = null;
    await until(async () => { const one = await hit.boundingBox(); await delay(200); const two = await hit.boundingBox(); if (one && two && Math.abs(one.x - two.x) < 0.5 && Math.abs(one.y - two.y) < 0.5) { b = two; return true; } return false; }, "the shape settled on the second page");
    const k = b.width / 60;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 5 * k, b.y + b.height / 2, { steps: 3 }); await page.mouse.move(b.x + b.width / 2 + 10 * k, b.y + b.height / 2, { steps: 3 });
    await page.mouse.up();
    await until(async () => Math.abs((await items())[0].x_mm - (before.x_mm + 10)) < 1.2, "moved by 10 mm from the second page");
    const lefts = await Promise.all([0, 1, 2, 3].map(frameLeft));
    ok(lefts.every((l) => Math.abs(l - lefts[0]) < 0.01), `the same on every page ${lefts}`);
  });

  await scenario("no errors in the page's console", async () => { eq(problems, [], "console errors"); });
} finally {
  await browser?.close();
  server.stop();
  finish();
}
