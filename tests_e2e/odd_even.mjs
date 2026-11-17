/** Browser test for separate header and footer text on odd and even pages: the Header and footer dialog, the sheets on screen, undo, and the Rendered view.
 *    NODE_PATH=<dir with playwright> node tests_e2e/odd_even.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("oddeven");
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

async function fresh() {
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
  const ops = [{ op: "text", block: s.blocks[0].id, start: 0, end: s.blocks[0].text.length, insert: "First paragraph." }];
  let after = s.blocks[0].id;
  for (let n = 1; n < 30; n++) { const id = `p${n}`; ops.push({ op: "block_insert", after, block: { id, type: "paragraph", text: `Paragraph ${n + 1}. ` + "Words fill the line and the page. ".repeat(14) } }); after = id; }
  ops.push({ op: "page_setup", header: { left: "ODDHEAD" }, footer: { center: "{page}" } });
  const r = await op({ op: "batch", ops });
  if (r.status >= 300) throw new Error("setup failed " + JSON.stringify(r.body).slice(0, 300));
  await page.reload(); await page.locator("#main").waitFor(); await delay(700);
}

const openDialog = async () => {
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Header", exact: true }).click();
  const dlg = page.getByRole("dialog");
  await dlg.waitFor();
  return dlg;
};
const bands = (edge) => page.evaluate((edge) => [...document.querySelectorAll(".sheets .sheet")].map((s) => s.querySelector(`.hf.${edge}`)?.textContent ?? ""), edge);

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });

  await scenario("the odd/even controls are hidden until the box is ticked, and Apply gives even sheets their own header and footer", async () => {
    await fresh();
    let dlg = await openDialog();
    const evenHead = dlg.getByLabel("Even-page header, left");
    ok(!(await evenHead.isVisible()), "even fields hidden while the box is off");
    await dlg.getByLabel("Different header and footer on odd and even pages").check();
    ok(await evenHead.isVisible(), "shown once it is on");
    await evenHead.fill("EVENHEAD");
    await dlg.getByLabel("Even-page footer, left").fill("{page} EVENFOOT");
    await dlg.getByRole("button", { name: "Apply", exact: true }).click();
    await until(async () => (await bands("header")).some((t) => t.includes("EVENHEAD")), "even header drawn");
    const heads = await bands("header"), foots = await bands("footer");
    ok(heads.length >= 4, "several sheets");
    heads.forEach((t, i) => { if (i % 2 === 0) { ok(t.includes("ODDHEAD") && !t.includes("EVENHEAD"), `sheet ${i + 1} is odd: ${t}`); } else { ok(t.includes("EVENHEAD") && !t.includes("ODDHEAD"), `sheet ${i + 1} is even: ${t}`); } });
    foots.forEach((t, i) => { if (i % 2 === 1) ok(t.includes("EVENFOOT"), `sheet ${i + 1} has the even footer: ${t}`); else ok(!t.includes("EVENFOOT"), `sheet ${i + 1} has not: ${t}`); });
    const stored = Object.values(await book());
    eq(stored.length, 1, "one section stores it");
    eq([stored[0].odd_even, stored[0].header_even, stored[0].footer_even, Object.keys(stored[0]).sort()], [true, { left: "EVENHEAD" }, { left: "{page} EVENFOOT" }, ["footer_even", "header_even", "odd_even"]], "stored with the book layout");
    const core = (await doc()).document.sections[0];
    eq(core.header, { left: "ODDHEAD" }, "the core header is unchanged");
  });

  await scenario("it survives a reload, the dialog shows what is stored, and one Undo takes the whole change back", async () => {
    await page.reload(); await page.locator("#main").waitFor(); await delay(700);
    ok((await bands("header"))[1].includes("EVENHEAD"), "still there after reopening");
    const dlg = await openDialog();
    ok(await dlg.getByLabel("Different header and footer on odd and even pages").isChecked(), "box is ticked");
    eq(await dlg.getByLabel("Even-page header, left").inputValue(), "EVENHEAD", "text is shown");
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await until(async () => !(await bands("header")).some((t) => t.includes("EVENHEAD")), "undone");
    eq(await book(), {}, "nothing stored after undo");
    eq((await doc()).document.sections[0].header, { left: "ODDHEAD" }, "the ordinary header is back as it was");
  });

  await scenario("a mirrored book with no even text swaps the ordinary header's edges on left-hand pages; with even text it uses that", async () => {
    await op({ op: "page_setup", header: { left: "ODDHEAD", right: "RIGHTHEAD" } });
    await op({ op: "page_layout", scope: "document", mirror: true });
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    const sides = await page.evaluate(() => [...document.querySelectorAll(".sheets .sheet")].slice(0, 2).map((s) => { const h = s.querySelector(".hf.header"); return [h.querySelector(".l").textContent, h.querySelector(".r").textContent]; }));
    eq(sides[0], ["ODDHEAD", "RIGHTHEAD"], "right-hand page");
    eq(sides[1], ["RIGHTHEAD", "ODDHEAD"], "left-hand page: swapped");
    await op({ op: "page_layout", scope: "document", odd_even: true, header_even: { center: "EVENMID" } });
    await page.reload(); await page.locator("#main").waitFor(); await delay(800);
    const even = await page.evaluate(() => { const h = document.querySelectorAll(".sheets .sheet")[1].querySelector(".hf.header"); return [h.querySelector(".l").textContent, h.querySelector(".c").textContent, h.querySelector(".r").textContent]; });
    eq(even, ["", "EVENMID", ""], "left-hand page shows only its own header");
  });

  await scenario("the server refuses even text while the setting is off, and the page does not change", async () => {
    await op({ op: "page_layout", scope: "document", odd_even: null, header_even: null, footer_even: null });
    const before = (await doc()).version;
    const r = await op({ op: "page_layout", scope: "document", header_even: { left: "x" } });
    ok(r.status >= 400, "refused: " + r.status);
    eq((await doc()).version, before, "no new version");
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}
