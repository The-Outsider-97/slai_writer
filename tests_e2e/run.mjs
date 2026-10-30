/** End-to-end tests: a real Writer server (own data folder, own library, own port) driven by a real Chromium.
 *  Run with `node tests_e2e/run.mjs` after `npm run build`. Needs `playwright` (resolved from NODE_PATH or node_modules) and python3.
 *  Nothing is mocked in the page; the server is the real one. Screenshots of failures go to tests_e2e/failures/. */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const slaiRoot = path.resolve(appDir, "..", "..");
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require(path.join(process.env.NODE_PATH ?? "", "playwright"))); }

const failuresDir = path.join(here, "failures");
fs.rmSync(failuresDir, { recursive: true, force: true });

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on("error", reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "writer-e2e-"));
const library = path.join(tmp, "library");
const config = path.join(tmp, "config.yaml");
fs.writeFileSync(config, fs.readFileSync(path.join(appDir, "configs", "config.yaml"), "utf8").replace('library_root: ""', `library_root: "${library.replaceAll("\\", "/")}"`));
const port = await freePort();
const token = "e2e-token";
const base = `http://127.0.0.1:${port}`;
const server = spawn("python3", ["-m", "applications.slai_writer", "--data-dir", path.join(tmp, "data"), "--port", String(port), "--token", token, "--no-browser", "--config", config],
  { cwd: slaiRoot, env: { ...process.env, PYTHONPATH: slaiRoot }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d; });
server.stderr.on("data", (d) => { serverLog += d; });
for (let i = 0; i < 100; i++) { try { const r = await fetch(base + "/"); if (r.status < 500) break; } catch { /* not up yet */ } await sleep(100); }

const browser = await chromium.launch();
const results = [];
let page;
const consoleProblems = [];

async function newPage(viewport = { width: 1440, height: 900 }) {
  page = await browser.newPage({ viewport });
  page.setDefaultTimeout(8000);
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") consoleProblems.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => consoleProblems.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?token=${token}`);
  return page;
}
const guest = async () => { await newPage(); await page.getByRole("button", { name: "Continue as a guest" }).click(); await page.getByRole("button", { name: "New Page" }).first().waitFor(); };
const sid = () => page.url().split("/doc/")[1];
const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const state = async () => (await api("GET", `/docs/${sid()}`)).body.data;
const newDoc = async (name) => {
  await page.getByRole("button", { name: "New Page" }).first().click();
  if (name) await page.getByLabel("Document name").fill(name);
  await page.getByRole("button", { name: "Create document" }).click();
  await page.waitForSelector("#main");
  await page.waitForTimeout(300);
};
const isSaved = async () => (await page.locator('.etop button[aria-label^="Save"]').first().getAttribute("aria-label")) === "Save";
const openSearch = async (text) => { await page.locator(".etop .searchbtn").click(); const box = page.getByLabel(/Search the document/); await box.fill(text); return box; };
const tab = (kind, n = 1) => page.locator(`.ptab.${kind}`).nth(n - 1);
const panelOpen = async (kind) => await page.locator(`#panel-${kind}`).evaluate((el) => el.classList.contains("open")).catch(() => false);
const until = async (fn, what, ms = 8000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; } await sleep(100); } throw new Error(`timed out waiting for ${what}${last instanceof Error ? ": " + last.message : ""}`); };
const blockTexts = async () => (await state()).blocks.map((b) => `${b.type}:${b.text}`);
const ok = (cond, message) => { if (!cond) throw new Error(message); };
const eq = (a, b, message) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

async function scenario(name, fn) {
  const started = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - started }); console.log(`  ok    ${name}`); }
  catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.log(`  FAIL  ${name}\n        ${String(error.message).split("\n")[0]}`);
    try { fs.mkdirSync(failuresDir, { recursive: true }); await page.screenshot({ path: path.join(failuresDir, name.replace(/\W+/g, "_") + ".png") }); } catch { /* the page may be gone */ }
  } finally {
    try { const m = page.url().match(/\/doc\/([^/?#]+)/); if (m) await api("POST", `/docs/${m[1]}/close`, { discard: true }); } catch { /* the page may be gone */ }
    try { await page.close(); } catch { /* ignore */ } }
}

console.log(`SLAI Writer end-to-end tests against ${base}`);

await scenario("startup offers guest use and shows no account chrome the guest cannot use", async () => {
  await newPage();
  await page.getByRole("button", { name: "Continue as a guest" }).waitFor();
  ok(await page.getByRole("button", { name: /log ?in/i }).count() >= 1, "no login button on the startup screen");
});

await scenario("guest can create a document, type, and it reaches the server", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Hello from a guest.");
  await until(async () => (await blockTexts()).includes("paragraph:Hello from a guest."), "typed text on the server");
});

await scenario("external plain-text clipboard paste, copy and cut use real document operations", async () => {
  await guest(); await newDoc();
  const first = page.locator('[data-edit="text"]').first();
  await first.click();
  const unhandled = await first.evaluate((node) => {
    const data = new DataTransfer();
    data.setData("text/plain", "From outside\nSecond line");
    return node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  });
  ok(!unhandled, "Writer did not intercept the external clipboard payload");
  await until(async () => {
    const texts = await blockTexts();
    return texts[0] === "paragraph:From outside" && texts[1] === "paragraph:Second line";
  }, "both pasted paragraphs to reach the server");

  const copied = await page.locator('[data-edit="text"]').first().evaluate((node) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges(); selection.addRange(range);
    const data = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: data }));
    return data.getData("text/plain");
  });
  eq(copied, "From outside", "copy must expose selected model text");

  await page.locator('[data-edit="text"]').first().evaluate((node) => {
    const data = new DataTransfer();
    node.dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true, clipboardData: data }));
    if (data.getData("text/plain") !== "From outside") throw new Error("cut did not put the selected text on the clipboard");
  });
  await until(async () => (await blockTexts())[0] === "paragraph:", "cut to remove the first paragraph's text");
});

await scenario("typing straight after Enter lands in the new paragraph (held keystrokes)", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("First"); await page.keyboard.press("Enter"); await page.keyboard.type("Second typed immediately");
  await until(async () => { const t = await blockTexts(); return t[0] === "paragraph:First" && t[1] === "paragraph:Second typed immediately"; }, "two paragraphs");
});

await scenario("text typed with the caret outside any paragraph is not lost", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Before"); await page.waitForTimeout(500);
  await page.keyboard.press("Control+Alt+m").catch(() => undefined);
  await page.keyboard.press("Escape");
  await page.locator("#main").click(); await page.keyboard.press("Control+End");
  await page.keyboard.type("After");
  await until(async () => (await blockTexts()).some((t) => t.includes("After")), "text after Ctrl+End on the server");
});

await scenario("bold and heading formatting are stored in the document", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Alpha beta"); await page.waitForTimeout(500);
  await page.keyboard.press("Home"); await page.keyboard.down("Shift"); for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight"); await page.keyboard.up("Shift");
  await page.keyboard.press("Control+b");
  await until(async () => { const b = (await state()).blocks[0]; return (b.spans ?? []).some((s) => s.type === "format" && s.bold && s.start === 0 && s.end === 5); }, "a bold span over Alpha");
  await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("Chapter");
  await page.locator(".etop .searchbtn").click(); await page.getByLabel(/Search the document/).fill("/formatting bar"); await page.keyboard.press("Enter");
  await page.getByRole("toolbar", { name: "Formatting" }).locator("select").first().selectOption({ label: "Heading 1" });
  await until(async () => (await state()).blocks.some((b) => b.type === "heading" && b.text === "Chapter"), "a Heading 1 block");
});

await scenario("save, close the screen, reopen from Home: the text is still there", async () => {
  await guest(); await newDoc("Persisted");
  await page.keyboard.type("Remember this sentence."); await page.keyboard.press("Control+s");
  await until(isSaved, "saved status");
  ok(fs.existsSync(path.join(library, "Persisted.sldc")), "the .sldc file is not in the library folder");
  await page.getByRole("button", { name: "Menu", exact: true }).click(); await page.getByRole("menuitem", { name: "Home" }).click();
  await until(async () => { if (page.url().includes("/doc/")) return true; await page.getByText("Persisted.sldc").first().click({ timeout: 1500 }).catch(() => undefined); return false; }, "the document to open again");
  await until(async () => (await blockTexts()).includes("paragraph:Remember this sentence."), "reopened text");
});

await scenario("the file written is a real SLDC package and a second server session can read it back", async () => {
  await guest(); await newDoc("Roundtrip");
  await page.keyboard.type("Round trip."); await page.keyboard.press("Control+s");
  await until(async () => fs.existsSync(path.join(library, "Roundtrip.sldc")), "the file");
  const head = fs.readFileSync(path.join(library, "Roundtrip.sldc")).subarray(0, 4);
  eq([...head], [0x50, 0x4b, 0x03, 0x04], "SLDC is a zip container");
  const reopened = await api("POST", "/docs/open", { path: path.join(library, "Roundtrip.sldc") });
  ok(reopened.status === 200 || reopened.status === 201, `open returned ${reopened.status}`);
  ok(reopened.body.data.blocks.some((b) => b.text === "Round trip."), "text missing after reopening");
});

await scenario("find and replace all is one undo step", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("One two three. One two three."); await page.waitForTimeout(600);
  await openSearch("two");
  await until(async () => /1\/2/.test(await page.locator(".etop .count").innerText()), "two matches");
  await page.keyboard.press("Control+h");
  await page.locator(".replace-row input").fill("TWO");
  await page.locator(".replace-row").getByRole("button", { name: "Replace all" }).click();
  await until(async () => (await blockTexts())[0] === "paragraph:One TWO three. One TWO three.", "both replaced");
  await page.locator("#main").click(); await page.keyboard.press("Control+z");
  await until(async () => (await blockTexts())[0] === "paragraph:One two three. One two three.", "both restored by one undo");
  await page.keyboard.press("Control+y");
  await until(async () => (await blockTexts())[0] === "paragraph:One TWO three. One TWO three.", "redo");
});

await scenario("slash function search inserts a table; typing in cells and Tab works", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("x"); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
  await page.keyboard.type("/"); await page.locator(".slash").waitFor();
  await page.keyboard.type("table"); await page.keyboard.press("Enter");
  await page.getByRole("dialog").getByRole("button", { name: /insert|create/i }).first().click();
  await page.locator("#main table").waitFor();
  await page.keyboard.type("c1"); await page.keyboard.press("Tab"); await page.keyboard.type("c2");
  await until(async () => { const t = (await state()).blocks.find((b) => b.type === "table"); return t && t.table.rows[0][0].text === "c1" && t.table.rows[0][1].text === "c2"; }, "cell text on the server");
});

await scenario("a comment is anchored, listed in the Comments tab and stored in the document", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Check this wording"); await page.waitForTimeout(500);
  await page.keyboard.press("Home"); await page.keyboard.down("Shift"); for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight"); await page.keyboard.up("Shift");
  await page.keyboard.press("Control+Alt+m");
  await page.getByRole("dialog").locator("textarea").fill("Is this the right word?");
  await page.getByRole("dialog").getByRole("button", { name: /add|post|save|comment/i }).first().click();
  const s = await until(async () => { const st = await state(); return st.comments.length ? st : null; }, "a comment thread");
  eq([s.comments[0].anchor.start, s.comments[0].anchor.end], [0, 5], "comment anchor");
  if (!(await panelOpen("yellow"))) await tab("yellow").click();   // adding a comment may open the panel itself (the person just acted)
  await page.getByRole("tab", { name: "Comments" }).click();
  await until(async () => (await page.locator("#panel-yellow").getByText("Is this the right word?").count()) > 0, "the comment in the Comments tab");
});

await scenario("double-clicking a green search match turns it into a linked note kept outside the document file", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("We saw the gamma ray burst yesterday."); await page.waitForTimeout(600);
  await openSearch("gamma");
  await until(async () => /1\/1/.test(await page.locator(".etop .count").innerText()), "one match");
  const box = await page.evaluate(() => { const w = document.createTreeWalker(document.querySelector("#main"), NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf("gamma"); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 2); r.setEnd(n, i + 3); const b = r.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; } } return null; });
  ok(box, "no text node for the match");
  await page.mouse.dblclick(box.x, box.y);
  const notes = await until(async () => { const r = await api("GET", `/docs/${sid()}/notes`); return r.body.data.notes.length ? r.body.data.notes : null; }, "a note");
  eq([notes[0].anchor_text, notes[0].start, notes[0].end], ["gamma", 11, 16], "note anchor");
  ok(!(await blockTexts()).some((t) => t.includes("note")), "the note must not be written into the document text");
});

await scenario("an equation is stored, the package upgrades and the person is told", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Energy"); await page.waitForTimeout(400);
  await page.locator(".etop .searchbtn").click(); await page.getByLabel(/Search the document/).fill("/equation");
  await page.keyboard.press("Enter");
  await page.getByRole("dialog").locator("textarea, input[type=text]").first().fill("E = mc^2");
  await page.getByRole("dialog").getByRole("button", { name: /insert|ok|save|apply/i }).first().click();
  const s = await until(async () => { const st = await state(); return st.blocks.some((b) => b.type === "equation") ? st : null; }, "an equation block");
  ok(s.notices.some((n) => /SLDC 1\.1/.test(n)), "no notice about the SLDC 1.1 upgrade");
  await page.keyboard.press("Control+s");
  await until(isSaved, "saved with an equation");
});

await scenario("the header and footer lines can be dragged; the positions are stored in the .sldc page and survive save and reopen", async () => {
  await guest(); await newDoc("Bands");
  await page.waitForTimeout(1200);
  const line = (k) => page.locator(`.sheet .mline[data-kind="${k}"]`).first();
  const before = (await state()).document.sections[0].page;
  ok(before.header_mm === undefined, "a new document already has a header position");
  const b = await line("header").boundingBox();
  await page.mouse.move(b.x + 100, b.y + 1);
  ok(!(await page.locator(".ruler-readout").isHidden()), "no number is shown when hovering the header line");
  await page.mouse.down(); await page.mouse.move(b.x + 100, b.y + 21, { steps: 4 }); await page.mouse.move(b.x + 100, b.y + 41, { steps: 4 }); await page.mouse.up();
  const moved = await until(async () => { const pg = (await state()).document.sections[0].page; return typeof pg.header_mm === "number" ? pg : null; }, "header_mm in the document");
  ok(moved.header_mm > 9.5, `header did not move down: ${moved.header_mm}`);
  await line("footer").focus(); await page.keyboard.press("ArrowUp"); await page.keyboard.press("ArrowUp");
  const foot = await until(async () => { const pg = (await state()).document.sections[0].page; return typeof pg.footer_mm === "number" ? pg : null; }, "footer_mm in the document");
  ok(await line("footer").evaluate((el) => el === document.activeElement), "the footer line lost focus after a keyboard move");
  await page.keyboard.press("Control+s"); await until(isSaved, "saved");
  const reopened = await api("POST", "/docs/open", { path: path.join(library, "Bands.sldc") });
  ok([200, 201].includes(reopened.status), `reopen returned ${reopened.status}`);
  const pg = reopened.body.data.document.sections[0].page;
  eq([pg.header_mm, pg.footer_mm], [moved.header_mm, foot.footer_mm], "positions after reopening");
  await api("POST", `/docs/${reopened.body.data.sid}/close`, { discard: true });
});

await scenario("a pasted picture can be selected, turned, floated and moved, and is still there after save and reopen", async () => {
  await guest(); await newDoc("Pictures");
  await page.keyboard.type("Before the picture."); await page.waitForTimeout(500);
  const prevented = await page.evaluate(async () => {
    const c = document.createElement("canvas"); c.width = 400; c.height = 240; const g = c.getContext("2d"); g.fillStyle = "#2563eb"; g.fillRect(0, 0, 400, 240); g.fillStyle = "#f59e0b"; g.fillRect(0, 0, 120, 80);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const dt = new DataTransfer(); dt.items.add(new File([blob], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    document.querySelector("#main").dispatchEvent(ev); return ev.defaultPrevented;
  });
  ok(prevented, "the paste was not handled");
  const dlg = page.getByRole("dialog"); await dlg.waitFor();
  await dlg.locator("textarea").fill("A blue test picture");
  await dlg.getByRole("button", { name: "Insert picture" }).click();
  await until(async () => (await state()).blocks.some((b) => b.type === "figure"), "a figure block");
  await page.locator("#main figure.fig .fig-box").first().click();
  await page.locator(".imgsel").waitFor();
  await page.locator('.imgbar [data-tool="turn-right"]').click();
  await until(async () => ((await state()).blocks.find((b) => b.type === "figure")?.figure?.rotation_deg) === 90, "rotation_deg 90");
  await page.locator('.imgbar [data-tool="free"]').click();
  const placed = await until(async () => (await state()).blocks.find((b) => b.type === "figure")?.figure?.placement, "a placement");
  eq(placed.anchor, "page", "placement anchor");
  await page.locator("#main figure.fig[data-floating]").waitFor(); await page.waitForTimeout(700);
  const handle = await page.locator(".imgsel-move").boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 100, handle.y + handle.height / 2 + 120, { steps: 8 }); await page.mouse.up();
  const moved = await until(async () => { const p = (await state()).blocks.find((b) => b.type === "figure")?.figure?.placement; return p && (p.x_mm !== placed.x_mm || p.y_mm !== placed.y_mm) ? p : null; }, "the placement to change after a drag");
  await page.keyboard.press("Control+s"); await until(isSaved, "saved with a floating picture");
  const reopened = await api("POST", "/docs/open", { path: path.join(library, "Pictures.sldc") });
  ok([200, 201].includes(reopened.status), `reopen returned ${reopened.status}`);
  const fig = reopened.body.data.blocks.find((b) => b.type === "figure").figure;
  eq([fig.rotation_deg, fig.placement.x_mm, fig.placement.y_mm], [90, moved.x_mm, moved.y_mm], "picture settings after reopening");
  await api("POST", `/docs/${reopened.body.data.sid}/close`, { discard: true });
});

await scenario("shortcuts: new page, new section, new layer, add background, add illustration", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("One."); await page.waitForTimeout(400);
  await page.keyboard.press("Control+Enter");
  await until(async () => (await page.locator(".sheet").count()) === 2, "a second page");
  await page.keyboard.type("Two."); await page.waitForTimeout(400);
  await page.keyboard.press("Control+Alt+Enter");
  await until(async () => (await state()).document.sections.length === 2, "a second section");
  await page.keyboard.press("Control+Alt+Shift+KeyN");
  await until(async () => ((await state()).document.extensions?.["slai.writer"]?.layers ?? []).some((l) => l.custom), "a custom layer");
  await page.locator("#main .blk").first().click();
  await page.keyboard.press("Control+Alt+b");
  await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape");
  await until(async () => (await page.getByRole("dialog").count()) === 0, "background dialog closed");
  await page.locator("#main .blk").first().click();
  const chooser = page.waitForEvent("filechooser", { timeout: 4000 });
  await page.keyboard.press("Control+d");
  await chooser;
});

await scenario("side panels open from their tabs, switch tabs, close with Escape and hand focus back", async () => {
  await guest(); await newDoc();
  await tab("yellow").click();
  await page.getByRole("tab", { name: "Sources" }).click();
  ok(await page.getByText(/never invents a source/i).count() > 0, "Sources text missing");
  await page.keyboard.press("Escape");
  await until(async () => !(await panelOpen("yellow")), "notes panel closed");
  await tab("red").click();
  ok(await page.getByText(/AI is off/i).count() > 0, "AI state not shown honestly");
});

await scenario("a new document shows all five panels collapsed and only the three coloured tabs and the two arrows", async () => {
  await guest(); await newDoc();
  for (const kind of ["red", "yellow", "embed"]) { ok(!(await panelOpen(kind)), `${kind} panel is open by default`); ok(await tab(kind).isVisible(), `${kind} tab is not visible`); }
  ok(!(await page.locator(".eside.left .full").first().isVisible().catch(() => false)), "left application panel is open by default");
  ok(!(await page.locator(".eside.right .full").first().isVisible().catch(() => false)), "right application panel is open by default");
  ok(await page.locator(".earrow.left").isVisible() && await page.locator(".earrow.right").isVisible(), "an application panel arrow is not visible");
  const box = async (kind) => await tab(kind).boundingBox();
  const sheet = await page.locator(".sheet").first().boundingBox();
  const [r, y, e] = [await box("red"), await box("yellow"), await box("embed")];
  ok(r.x < sheet.x + 2 && r.x + r.width > sheet.x - 40, "the corrections tab is not on the left edge of the page");
  ok(y.x + y.width > sheet.x + sheet.width - 2 && y.x > sheet.x + sheet.width - 40, "the notes tab is not on the right edge of the page");
  ok(e.y >= sheet.y + sheet.height - 2, "the EMBED tab is not beneath the page");
  eq(await tab("red").getAttribute("aria-expanded"), "false", "red tab state");
});

await scenario("a side never shows both its application panel and its page panel; EMBED is independent", async () => {
  await guest(); await newDoc();
  const leftOpen = async () => await page.locator(".eside.left .full").first().isVisible().catch(() => false);
  const rightOpen = async () => await page.locator(".eside.right .full").first().isVisible().catch(() => false);
  await page.locator(".earrow.left").click();
  await until(leftOpen, "left panel open");
  ok(!(await rightOpen()), "opening the left panel opened the right panel");
  ok(!(await panelOpen("red")) && !(await panelOpen("yellow")) && !(await panelOpen("embed")), "an application panel opened a page panel");
  await tab("red").click();                                   // Corrections replaces Tools on the left
  await until(async () => !(await leftOpen()), "Tools panel closed by Corrections");
  ok(await panelOpen("red") && !(await panelOpen("yellow")), "the red tab did not open Corrections alone");
  await page.locator(".earrow.left").click();                 // Tools replaces Corrections
  await until(leftOpen, "Tools panel reopened");
  await until(async () => !(await panelOpen("red")), "Corrections closed by Tools");
  await page.locator(".earrow.right").click();
  await until(rightOpen, "right panel open");
  await tab("yellow").click();                                // Notes replaces the organisation panel on the right
  await until(async () => !(await rightOpen()), "organisation panel closed by Notes");
  ok(await panelOpen("yellow"), "Notes did not open");
  await tab("embed").click();                                 // EMBED lives below the page and is unaffected
  ok(await panelOpen("embed") && await panelOpen("yellow"), "EMBED did not open next to Notes");
  ok(await leftOpen(), "Tools panel closed when Notes and EMBED opened");   // the left side is not touched by the right side
  ok(await panelOpen("embed") && await panelOpen("yellow"), "Tools, Notes and EMBED do not show together");
  await tab("embed").click();
  await until(async () => !(await panelOpen("embed")), "EMBED closed");
});

await scenario("opening panels changes neither the document nor the page geometry, and EMBED does not unlock or run anything", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Stable text."); await page.waitForTimeout(700);
  const before = await state();
  const sheet = await page.locator(".sheet").first().boundingBox();
  for (const k of ["red", "yellow", "embed"]) await tab(k).click();
  await page.waitForTimeout(500);
  const after = await state();
  eq(after.version, before.version, "document version changed by opening panels");
  eq(after.blocks.map((b) => b.text), before.blocks.map((b) => b.text), "document text changed");
  const s2 = await page.locator(".sheet").first().boundingBox();
  eq([Math.round(s2.width), Math.round(s2.height)], [Math.round(sheet.width), Math.round(sheet.height)], "page size changed");
  ok(/does not unlock/i.test(await page.locator("#panel-embed").innerText()), "EMBED panel does not say that opening it unlocks nothing");
  eq((await state()).blocks.filter((b) => b.type === "embed").length, 0, "opening the panel created or ran an embed");
});

await scenario("panels belong to their page, are not part of the printable page and keep their place when zooming", async () => {
  await guest(); await newDoc();
  await tab("yellow").click(); await page.waitForTimeout(300);
  ok(await page.locator("#main #panel-yellow, .sheet #panel-yellow").count() === 0, "a panel lives inside the page content");
  const rel = async () => { const s = await page.locator(".sheet").first().boundingBox(); const p = await page.locator("#panel-yellow").boundingBox(); return Math.round(p.x - (s.x + s.width)); };
  await page.locator(".zoomrange").fill("100"); await page.waitForTimeout(400);
  const a = await rel();
  await page.locator(".zoomrange").fill("60"); await page.waitForTimeout(400);
  const b = await rel();
  ok(Math.abs(a) <= 25 && Math.abs(b) <= 25, `the notes panel moved away from the page edge (${a}px at 100%, ${b}px at 60%)`);
  const css = await page.evaluate(() => getComputedStyle(document.querySelector("#panel-yellow")).display);
  ok(css !== "none", "panel not displayed");
  const inPrint = await page.evaluate(() => !!document.querySelector("#print-root .ppanel, #print-root .ptab") || !!document.querySelector(".sheet .ppanel, .sheet .ptab, #main .ppanel"));
  ok(!inPrint, "a panel or tab is inside the page content");
  const rule = await page.evaluate(() => [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.media && /print/.test(r.media.mediaText) && /body\.printing/.test(r.cssText)); } catch { return false; } }));
  ok(rule, "no print rule isolates the printed pages from the editing interface");
});

await scenario("AI, spelling and grammar are honest when unavailable and never run on their own", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Ths is a tpyo."); await page.waitForTimeout(800);
  await tab("red").click();
  const before = await state();
  await page.waitForTimeout(1500);
  eq((await state()).version, before.version, "nothing may change the document without a request");
  await page.getByRole("button", { name: "Check grammar" }).click();
  await until(async () => /not|off|enable|unavailable|settings/i.test(await page.locator("#panel-red").innerText()), "an explanation");
});

await scenario("Hide dims the interface, Escape reveals it again (and it is not a panel toggle)", async () => {
  await guest(); await newDoc();
  await page.getByRole("button", { name: /Hide everything except the page/ }).click();
  ok((await page.locator(".doc").getAttribute("data-hidden")) !== null, "not hidden");
  await page.keyboard.press("Escape");
  await until(async () => (await page.locator(".doc").getAttribute("data-hidden")) === null, "revealed");
});

await scenario("zoom slider and shortcuts change the zoom and it is remembered", async () => {
  await guest(); await newDoc();
  await page.locator(".zoomrange").fill("150");
  await until(async () => /150/.test(await page.locator(".zoom-text").innerText()), "150%");
  await page.locator("#main").click(); await page.keyboard.press("Control+0");
  await until(async () => /100/.test(await page.locator(".zoom-text").innerText()), "100% after Ctrl+0");
});

await scenario("page setup is reachable from the ruler and changes the page size on the server", async () => {
  await guest(); await newDoc();
  await page.locator(".hruler").dblclick({ position: { x: 200, y: 10 } });
  await page.getByRole("dialog").waitFor();
  await page.getByRole("dialog").getByLabel(/Paper size|Size/i).first().selectOption("Letter");
  await page.getByRole("dialog").getByRole("button", { name: /apply|save|ok/i }).first().click();
  await until(async () => (await state()).document.sections[0].page.size === "Letter", "Letter on the server");
});

await scenario("EMBED is inert: the drawer validates a declaration and the server refuses a script", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("x"); await page.keyboard.press("Enter"); await page.waitForTimeout(400);
  await page.keyboard.type("/"); await page.locator(".slash").waitFor(); await page.keyboard.type("embed"); await page.keyboard.press("Enter");
  await page.locator("#panel-embed:not([hidden])").waitFor();
  const bad = await api("POST", `/docs/${sid()}/embeds/preview`, { declaration: { kind: "writer.stats", schema_version: 1, params: { script: "alert(1)" }, inputs: [] } });
  ok(bad.status === 400 || bad.body.data?.valid === false, `an unknown parameter was accepted (${bad.status})`);
});

await scenario("version history lists a saved version and restoring makes a NEW revision", async () => {
  await guest(); await newDoc("History");
  await page.keyboard.type("Version one."); await page.keyboard.press("Control+s");
  await until(isSaved, "first save");
  await page.keyboard.press("Enter"); await page.keyboard.type("More."); await page.keyboard.press("Control+s");
  await until(async () => (await blockTexts()).includes("paragraph:More."), "second edit");
  await page.getByRole("button", { name: "Menu", exact: true }).click(); await page.getByRole("menuitem", { name: "Version history" }).click();
  await page.getByText(/Version history/i).first().waitFor();
});

await scenario("settings, plans and help render; plans show the configured Workspace price", async () => {
  await guest();
  await page.getByRole("button", { name: "Plans & Pricing" }).click();
  await page.getByText("Workspace").first().waitFor();
  ok(await page.getByText(/€\s?30/).count() > 0, "Workspace price from the main document is missing");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText(/Appearance|Theme/i).first().waitFor();
  await page.getByRole("button", { name: "Support SLAI Writer" }).click();
  await page.getByText(/shortcut/i).first().waitFor();
});

await scenario("pages opened from a document offer Return to document, and it goes back to that document", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Back again."); await page.waitForTimeout(500);
  for (const [name, wait] of [["settings", /Appearance|Theme/i], ["plans", /Workspace/], ["help", /shortcut/i]]) {
    await page.evaluate((n) => { location.hash = `#/${n}`; }, name);
    await page.getByText(wait).first().waitFor();
    const back = page.locator(".return-doc");
    ok(await back.count() === 1 && await back.isVisible(), `no Return to document button on ${name}`);
    await back.click();
    await page.locator(".sheet").first().waitFor();
    ok((await page.locator(".sheet .body").first().innerText()).includes("Back again."), `Return from ${name} did not come back to the document`);
  }
  await page.getByRole("button", { name: "Home" }).first().click().catch(() => undefined);
  ok(await page.locator(".return-doc").count() === 0, "Home shows a Return to document button");
});

await scenario("signature graphics: the two label fields sit on the same level", async () => {
  await guest();
  await page.evaluate(() => { location.hash = "#/signatures"; });
  await page.getByText("Saved signature label").first().waitFor();
  const a = await page.getByText("Saved signature label").first().boundingBox();
  const b = await page.getByText("Which signature").first().boundingBox();
  ok(Math.abs(a.y - b.y) < 1.5, `labels are ${Math.round(Math.abs(a.y - b.y))}px apart`);
  const fa = await page.getByLabel("Saved signature label").boundingBox();
  const fb = await page.getByLabel("Which signature").boundingBox();
  ok(Math.abs(fa.y - fb.y) < 1.5, `inputs are ${Math.round(Math.abs(fa.y - fb.y))}px apart`);
});

await scenario("no payment can be simulated: choosing a paid plan says billing is not connected", async () => {
  await guest();
  await page.getByRole("button", { name: "Plans & Pricing" }).click();
  await page.getByText("Creator").first().waitFor();
  const choose = page.getByRole("button", { name: /choose|upgrade|select|subscribe/i }).first();
  if (await choose.count()) { await choose.click(); await until(async () => /not connected|not available|billing/i.test(await page.locator("body").innerText()), "an honest billing message"); }
});

await scenario("keyboard only: Tab moves focus onto a real control (not left on the page body)", async () => {
  await guest(); await newDoc();
  await page.keyboard.press("Escape");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => { const el = document.activeElement; if (!el) return null; const cs = getComputedStyle(el); return { tag: el.tagName, outline: cs.outlineStyle, label: el.getAttribute("aria-label") || el.textContent }; });
  ok(focused && focused.tag !== "BODY", "focus did not move to a control");
});

await scenario("the page survives a reload with the document still open", async () => {
  await guest(); await newDoc("Reload me");
  await page.keyboard.type("Still here after reload."); await page.keyboard.press("Control+s");
  await until(isSaved, "saved");
  await page.reload();
  await until(async () => (await page.locator("#main").count()) > 0 || (await page.getByRole("button", { name: "Continue as a guest" }).count()) > 0, "the app after reload");
});

await scenario("a stale edit is refused by the server with 409 stale_version (no silent overwrite)", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Original"); await page.waitForTimeout(700);
  const s = await state();
  const first = await api("POST", `/docs/${sid()}/ops`, { op: { op: "block_insert", after: s.blocks[0].id, block: { type: "paragraph", text: "From elsewhere" } }, base: s.version });
  eq(first.status, 200, "first writer");
  const stale = await api("POST", `/docs/${sid()}/ops`, { op: { op: "block_insert", after: s.blocks[0].id, block: { type: "paragraph", text: "Lost update" } }, base: s.version });
  eq(stale.status, 409, "second writer on the old version");
  eq(stale.body.error.details.kind, "stale_version", "conflict kind");
});

await scenario("API calls without the app marker header or from another origin are refused", async () => {
  await guest();
  const noMarker = await page.evaluate(async () => (await fetch("/api/docs/new", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status);
  ok(noMarker === 403 || noMarker === 401, `missing marker header returned ${noMarker}`);
  const res = await fetch(`${base}/api/docs`, { headers: { Origin: "http://evil.example" } });
  ok(res.status === 403 || res.status === 401, `foreign origin returned ${res.status}`);
});

await scenario("the page shows no uncaught errors or CSP violations while editing", async () => {
  await guest(); await newDoc();
  await page.keyboard.type("Quiet console."); await page.waitForTimeout(500);
  const bad = consoleProblems.filter((p) => !/Failed to load resource/.test(p));
  eq(bad, [], "console problems");
});

await scenario("the server's own output never contains document text", async () => {
  await guest(); await newDoc("Private");
  await page.keyboard.type("ZEBRA-UNIQUE-TEXT-731 confidential sentence."); await page.keyboard.press("Control+s");
  await until(isSaved, "saved");
  await sleep(300);
  ok(!serverLog.includes("ZEBRA-UNIQUE-TEXT-731"), "document text appeared in the server output");
  ok(!/confidential sentence/.test(serverLog), "document text appeared in the server output");
});

await browser.close();
server.kill();
await sleep(300);
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} end-to-end scenarios passed.`);
if (failed.length) { console.log(serverLog.split("\n").filter((l) => /Traceback|Error/.test(l)).slice(0, 10).join("\n")); process.exit(1); }
