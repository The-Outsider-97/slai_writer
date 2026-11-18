/** Browser test for the layout of table-of-contents entries: the page numbers, leaders and alignment the editing view draws against what the exported PDF has,
 *  for the combinations that matter, and the table following the document as it changes. Real Chromium, real server, real PDF.
 *    NODE_PATH=<dir with playwright> node tests_e2e/toc_layout.mjs */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, runner, chromium, until, ok, eq, delay, root } from "./harness.mjs";

const server = await startServer("toclay");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];
const work = mkdtempSync(join(tmpdir(), "toclay-"));
const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];
const PT = 0.75;                                            // points in a CSS pixel

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const doc = async () => (await api("GET", `/docs/${sid}`)).body.data;
const op = async (o) => { const r = await api("POST", `/docs/${sid}/ops`, { op: o }); ok(r.status < 300, `op ${o.op} failed: ${JSON.stringify(r.body).slice(0, 300)}`); return r; };

async function fresh(names = NAMES) {
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
  names.forEach((name, n) => {
    ops.push({ op: "block_insert", after, block: { id: `h${n}`, type: "heading", text: name, attributes: { level: n % 3 === 1 ? 2 : 1, page_break_before: true } } });
    ops.push({ op: "block_insert", after: `h${n}`, block: { id: `b${n}`, type: "paragraph", text: `Body of ${name}.` } });
    after = `b${n}`;
  });
  await op({ op: "batch", ops });
  const r = await api("POST", `/docs/${sid}/contents`, { after: null, title: "Contents", depth: 3, look: { preset: "classic" } });
  ok(r.status < 300, `contents: ${JSON.stringify(r.body).slice(0, 300)}`);
  await page.reload(); await page.locator("#main").waitFor();
  await waitPainted();
}
const tocId = async () => ((await doc()).blocks.find((b) => b.extensions?.["slai.sldc.toc"]?.role === "title")).extensions["slai.sldc.toc"].id;
const setLook = async (look, extra = {}) => {
  const r = await api("POST", `/docs/${sid}/contents/${await tocId()}/refresh`, { look, ...extra });
  ok(r.status < 300, `look ${JSON.stringify(look)}: ${JSON.stringify(r.body).slice(0, 300)}`);
  await page.reload(); await page.locator("#main").waitFor();
  await waitPainted();
};
const waitPainted = async () => { await until(async () => (await page.locator("#main .blk[data-toc-entry]").count()) > 0, "entries"); await delay(1500); };

/** What the editing view drew for each entry, in points from the left edge of the text frame. */
const editorEntries = () => page.evaluate(() => {
  const out = { entries: {} };
  const canvas = document.createElement("canvas").getContext("2d");
  for (const el of document.querySelectorAll("#main .blk[data-toc-entry]")) {
    const text = el.querySelector("[data-edit=text]");
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    const k = rect.width / el.offsetWidth || 1;
    const padLeft = parseFloat(style.paddingLeft) || 0, padRight = parseFloat(style.paddingRight) || 0;
    const left0 = rect.left + (parseFloat(style.borderLeftWidth) + padLeft) * k;
    const frame = el.clientWidth - padLeft - padRight;
    const range = document.createRange(); range.selectNodeContents(text);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
    const tops = rects.map((r) => r.top), first = Math.min(...tops), last = Math.max(...tops);
    const on = (t) => rects.filter((r) => Math.abs(r.top - t) < 2 * k);
    const span = (rs) => [(Math.min(...rs.map((r) => r.left)) - left0) / k, (Math.max(...rs.map((r) => r.right)) - left0) / k];
    const cs = getComputedStyle(text);
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${parseFloat(cs.fontSize)}px ${cs.fontFamily}`;
    const label = el.dataset.tocPage ?? null;
    const prop = (n) => { const v = el.style.getPropertyValue(n); return v === "" ? null : v; };
    const px = (n) => { const v = prop(n); return v === null ? null : parseFloat(v); };
    let number = null;
    if (label !== null && px("--toc-nx") !== null) { const w = canvas.measureText(label).width; number = [px("--toc-nx") - padLeft, px("--toc-nx") - padLeft + w]; }
    let leader = null;
    if (px("--toc-lx") !== null && px("--toc-lw") !== null) leader = [px("--toc-lx") - padLeft, px("--toc-lx") - padLeft + px("--toc-lw") - (px("--toc-ls") ?? 0)];
    const lines = new Set(rects.map((r) => Math.round(r.top / (2 * k)))).size;
    out.entries[text.textContent.trim().split(/\s+/)[0]] = {
      text: span(on(first)), text_last: span(on(last)), number, leader, lines, kind: el.dataset.tocLeaderKind ?? null, label, ny: px("--toc-ny"), nh: px("--toc-nh"),
      firstTop: (first - rect.top) / k, lastTop: (last - rect.top) / k, frame, rightEnd: Math.max(...rects.map((r) => (r.right - left0) / k)), leftEnd: Math.min(...rects.map((r) => (r.left - left0) / k)),
    };
  }
  return out;
});

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
async function pdfEntries(tag, leaderChar) {
  const path = await pdfFile(tag);
  const d = await doc();
  const margins = (d.sections?.[0]?.page ?? {}).margins_mm ?? { left: 25, right: 25 };
  const out = execFileSync("python3", ["-m", "applications.slai_writer.tests.toc_pdf_cli", path, leaderChar, String(margins.left ?? 25), String(margins.right ?? 25)], { cwd: root, env: { ...process.env, PYTHONPATH: root }, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

const PAD = 3;
const near = (a, b, tol, what) => ok(Math.abs(a - b) <= tol, `${what}: editor ${a.toFixed(1)} pt, PDF ${b.toFixed(1)} pt (more than ${tol} pt apart)`);
const CASES = [
  ["numbers right, heading left, dot leaders (the default)", { page_position: "right", number_align: "right", text_align: "left", leader: "dots" }],
  ["numbers left, heading right-aligned, dot leaders between", { page_position: "left", number_align: "left", text_align: "right", leader: "dots" }],
  ["numbers left, heading left", { page_position: "left", number_align: "left", text_align: "left", leader: "dots" }],
  ["numbers at a tab stop of 120 mm, right-aligned, dashes", { page_position: "custom", custom_tab_mm: 120, number_align: "right", text_align: "left", leader: "dashes" }],
  ["numbers at a tab stop of 100 mm, centred, dots", { page_position: "custom", custom_tab_mm: 100, number_align: "center", text_align: "left", leader: "dots" }],
  ["numbers right, centred heading, dots", { page_position: "right", number_align: "right", text_align: "center", leader: "dots" }],
  ["numbers right, own leader character", { page_position: "right", number_align: "right", text_align: "left", leader: "custom", leader_char: "*" }],
  ["numbers right, solid leader", { page_position: "right", number_align: "right", text_align: "left", leader: "solid" }],
];

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });
  await fresh();

  for (const [name, look] of CASES) {
    await scenario(`the editing view and the PDF agree: ${name}`, async () => {
      await setLook(look);
      const editor = (await editorEntries()).entries;
      const leaderChar = look.leader === "dots" ? "." : look.leader === "dashes" ? "-" : look.leader === "custom" ? look.leader_char : "§";
      const pdf = await pdfEntries("case", leaderChar);
      const frame = pdf.frame[1] - pdf.frame[0];
      for (const n of NAMES) {
        const e = editor[n], p = pdf.entries[n];
        ok(e && p, `${n}: an entry in both (editor ${!!e}, PDF ${!!p})`);
        ok(e.number && p.number, `${n}: a page number in both`);
        const rel = (pair) => [pair[0] - pdf.frame[0], pair[1] - pdf.frame[0]];
        const pn = rel(p.number), pt = rel(p.text);
        const en = [e.number[0] * PT, e.number[1] * PT], et = [e.text[0] * PT, e.text[1] * PT];
        near(en[0], pn[0], 2.5, `${n}: left edge of the number`);
        near(en[1], pn[1], 2.5, `${n}: right edge of the number`);
        if (look.text_align === "left") near(et[0], pt[0], 2.5, `${n}: left edge of the text`);
        if (look.text_align === "right") near(et[1], pt[1], 2.5, `${n}: right edge of the text`);
        // the editor's own invariants, whatever the fonts: the leader starts right after the text, ends right before the number, never under either
        const roomForLeader = !(look.page_position === "left" && look.text_align === "left");           // the number column and the text touch: nothing to fill
        if (look.leader !== "none" && roomForLeader) {
          ok(e.leader && e.kind === look.leader, `${n}: the editor draws a ${look.leader} leader (${e.kind})`);
          const [l0, l1] = [e.leader[0] * PT, e.leader[1] * PT];
          if (look.page_position === "left") {
            ok(l0 >= en[1] + PAD - 0.8 && l0 < en[1] + PAD + 12, `${n}: the leader starts right after the number (${l0.toFixed(1)} vs ${en[1].toFixed(1)})`);
            ok(l1 <= et[0] - PAD + 0.8 && l1 > et[0] - PAD - 12, `${n}: the leader ends right before the text (${l1.toFixed(1)} vs ${et[0].toFixed(1)})`);
          } else {
            const last = e.text_last[1] * PT;
            ok(l0 >= last + PAD - 0.8 && l0 < last + PAD + 12, `${n}: the leader starts right after the text (${l0.toFixed(1)} vs ${last.toFixed(1)})`);
            ok(l1 <= en[0] - PAD + 0.8 && l1 > en[0] - PAD - 12, `${n}: the leader ends right before the number (${l1.toFixed(1)} vs ${en[0].toFixed(1)})`);
          }
          ok(p.leader || look.leader === "solid", `${n}: the PDF draws a leader too`);
        } else if (look.leader === "none") ok(!e.leader && !p.leader, `${n}: no leader in either`);
        else ok(!!e.leader === !!p.leader, `${n}: where the number and the text touch there is nothing to fill, and the editor and the PDF agree (editor ${!!e.leader}, PDF ${!!p.leader})`);
      }
      // the numbers line up: one left edge for the left-aligned column, one right edge for the right-aligned
      const column = look.number_align === "left" ? 0 : look.number_align === "center" ? null : 1;
      if (column !== null) {
        const edges = NAMES.map((n) => editor[n].number[column]);
        ok(Math.max(...edges) - Math.min(...edges) < 0.6, `the numbers line up in the editor (${edges.join(", ")})`);
      }
      ok(frame > 300, "a sane frame");
    });
  }

  await scenario("hidden page numbers: none in the editor, none in the PDF, none in the DOM text", async () => {
    await setLook({ page_position: "hidden" });
    const editor = (await editorEntries()).entries;
    for (const n of NAMES) ok(editor[n].label === null && editor[n].number === null && editor[n].leader === null, `${n}: nothing drawn`);
    const pdf = await pdfEntries("hidden", ".");
    for (const n of NAMES) ok(!pdf.entries[n].number && !pdf.entries[n].leader, `${n}: nothing in the PDF`);
    await setLook({ page_position: "right" });
    const back = (await editorEntries()).entries;
    ok(back.Alpha.number !== null, "the numbers come back");
  });

  await scenario("the page number is a decoration: never in the entry's text, never selectable, never saved", async () => {
    await setLook({ page_position: "right", number_align: "right", leader: "dots" });
    const d = await doc();
    for (const b of d.blocks.filter((x) => x.extensions?.["slai.sldc.toc"]?.role === "entry")) ok(!/\d\s*$/.test(b.text) && !/\.{3}/.test(b.text), `the text of ${b.id} is only the heading: "${b.text}"`);
    const tx = await page.locator("#main .blk[data-toc-entry]").first().evaluate((el) => el.querySelector("[data-edit=text]").textContent);
    ok(!/\d$/.test(tx.trim()), `the editable text holds no page number: "${tx}"`);
  });

  await scenario("a long heading wraps inside the room the number column leaves it, in the editor and in the PDF", async () => {
    const long = "Mike heading that is long enough to wrap onto a second and a third line of the contents page because it goes on and on about nothing in particular for far too long";
    await fresh([long, ...NAMES.slice(1)]);
    for (const look of [{ page_position: "right", number_align: "right", text_align: "left", leader: "dots" }, { page_position: "left", number_align: "left", text_align: "left", leader: "dots" }]) {
      await setLook(look);
      const e = (await editorEntries()).entries["Mike"];
      const p = (await pdfEntries("wrap", ".")).entries["Mike"];
      ok(e.lines >= 2 && p.lines >= 2, `it wraps in both (editor ${e.lines} lines, PDF ${p.lines})`);
      const numberEdge = look.page_position === "right" ? e.number[0] * PT : null;
      if (numberEdge !== null) ok(e.rightEnd * PT <= numberEdge - PAD + 0.8, `no line reaches into the number column (${(e.rightEnd * PT).toFixed(1)} vs ${numberEdge.toFixed(1)})`);
      else ok(e.leftEnd * PT >= e.number[1] * PT + PAD - 0.8, `no line starts under the number (${(e.leftEnd * PT).toFixed(1)} vs ${(e.number[1] * PT).toFixed(1)})`);
      // the number and the leader stand on the last line (numbers right) or the first (numbers left)
      const row = look.page_position === "right" ? e.lastTop : e.firstTop;
      ok(Math.abs(e.ny - row) < 1.5, `the number stands on the ${look.page_position === "right" ? "last" : "first"} line (${e.ny} vs ${row})`);
    }
  });

  await scenario("the table follows the document: a new heading, a rename and a change of level are in the table without asking", async () => {
    await fresh();
    await setLook({ page_position: "left", number_align: "left", text_align: "right", leader: "dots" });
    const before = Object.keys((await editorEntries()).entries).length;
    await page.getByRole("tab", { name: "Home" }).click();
    await page.locator("#main .blk[data-id=b2] [data-edit=text]").click();
    await page.getByLabel("Paragraph style").selectOption("h1");                       // an ordinary paragraph becomes a heading
    await until(async () => Object.keys((await editorEntries()).entries).length === before + 1, "a new entry", 12000);
    await page.locator("#main .blk[data-id=h3] [data-edit=text]").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" renamed");
    await until(async () => (await doc()).blocks.some((b) => b.extensions?.["slai.sldc.toc"]?.role === "entry" && b.text === "Delta renamed"), "the rename reaches the entry", 12000);
    await page.locator("#main .blk[data-id=h3] [data-edit=text]").click();
    await page.getByLabel("Paragraph style").selectOption("h2");
    await until(async () => (await doc()).blocks.some((b) => b.extensions?.["slai.sldc.toc"]?.role === "entry" && b.text === "Delta renamed" && b.style === "TOC Level 2"), "the level change reaches the entry", 12000);
    await until(async () => Object.values((await editorEntries()).entries).every((x) => x.number !== null && x.leader !== null), "every entry, new and old, has its number and leader drawn", 15000);
    const e = (await editorEntries()).entries;
    ok(Object.values(e).every((x) => x.number !== null), `every entry, new and old, has its number drawn: ${JSON.stringify(Object.entries(e).map(([k, x]) => [k, x.label, x.number]))}`);
    ok(Object.values(e).every((x) => x.leader !== null), "and its leader");
    // and the look survived every update
    const look = ((await doc()).blocks.find((b) => b.extensions?.["slai.sldc.toc"]?.role === "title")).extensions["slai.writer.toc_style"];
    eq([look.page_position, look.number_align, look.text_align, look.leader], ["left", "left", "right", "dots"], "the look is unchanged by the updates");
  });

  await scenario("the settings dialog sets position, alignment, tab stop, leader and spacing, and they survive save and reopen", async () => {
    await fresh();
    await page.locator("#main .blk[data-toc-entry] [data-edit=text]").first().click();
    await page.getByRole("tab", { name: "References" }).click();
    await page.getByRole("button", { name: /^Edit settings/i }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("Page numbers", { exact: true }).selectOption("custom");
    await dlg.getByLabel(/^Tab stop of the page numbers/).fill("115");
    await dlg.getByLabel("Page number alignment").selectOption("center");
    await dlg.getByLabel("Entry text alignment").selectOption("left");
    await dlg.getByLabel("Leader", { exact: true }).selectOption("custom");
    await dlg.getByLabel("Leader character").fill("~");
    await dlg.getByLabel(/^Space between the leader marks/).fill("1.5");
    await dlg.getByLabel("Level 2 text alignment").selectOption("center");
    await dlg.getByRole("button", { name: "Apply" }).click();
    await until(async () => ((await doc()).blocks.find((b) => b.extensions?.["slai.sldc.toc"]?.role === "title")).extensions["slai.writer.toc_style"].page_position === "custom", "stored");
    const look = ((await doc()).blocks.find((b) => b.extensions?.["slai.sldc.toc"]?.role === "title")).extensions["slai.writer.toc_style"];
    eq([look.page_position, look.custom_tab_mm, look.number_align, look.leader, look.leader_char, look.leader_gap_pt], ["custom", 115, "center", "custom", "~", 1.5], "stored look");
    await dlg.waitFor({ state: "detached" });
    await waitPainted();
    const e = (await editorEntries()).entries;
    ok(e.Alpha.kind === "custom" && e.Alpha.leader, "the editor draws the character leader");
    const styles = (await doc()).document?.styles?.paragraph ?? {};
    eq(styles["TOC Level 2"].align, "center", "a level has its own alignment");
    // save and reopen
    await page.reload(); await page.locator("#main").waitFor(); await waitPainted();
    const again = (await editorEntries()).entries;
    near(again.Alpha.number[0] * PT, e.Alpha.number[0] * PT, 0.6, "the number is where it was after a reopen");
  });

  await scenario("no errors in the page's console", async () => { eq(problems, [], "console errors"); });
} finally {
  await browser?.close();
  server.stop();
  finish();
}
