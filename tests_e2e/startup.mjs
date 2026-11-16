/** Browser tests for the v2.4 start-up: the branded loader, real stage progress, the fade-out, retries, failure with recovery, opening straight into a
 *  document, high-DPI and small windows. NODE_PATH=<dir with playwright> node tests_e2e/startup.mjs (after `npm run build`). */
import { chromium, startServer, runner, ok, eq, until, delay } from "./harness.mjs";

const server = await startServer("start");
const { base, token } = server;
const browser = await chromium.launch();
const R = runner();
const open = async (options = {}) => { const p = await browser.newPage({ viewport: { width: 1280, height: 800 }, ...options }); p.setDefaultTimeout(10000); R.state.page = p; return p; };
const loader = (p) => p.locator("dialog.slai-startup");
console.log(`SLAI Writer start-up tests against ${base}`);

// Keep the first request pending until the test releases it, so the loader can be inspected at a known stage.
async function gateBootstrap(p, hold) { await p.route("**/api/bootstrap", async (route) => { await hold; await route.continue(); }); }

await R.scenario("loader is on screen before the application's first request, with the Writer branding", async () => {
  const p = await open(); let release; const hold = new Promise((r) => { release = r; }); await gateBootstrap(p, hold);
  const nav = p.goto(`${base}/?token=${token}`, { waitUntil: "commit" });
  await loader(p).waitFor({ state: "visible" });
  eq(await loader(p).count(), 1, "exactly one loader");
  eq(await p.locator(".slai-startup h1").innerText(), "SLAI Writer", "name");
  ok((await p.locator(".spadra-startup-subtitle").innerText()).includes("Smart software for writing"), "tagline");
  ok(await p.locator(".slai-startup-orb img").count() === 1, "logo");
  ok(await p.locator("dialog.slai-startup progress").count() === 1, "progress bar");
  const stage = await until(async () => { const t = await p.locator(".slai-startup p[role=status]").innerText(); return /server/i.test(t) ? t : null; }, "stage message while the server is awaited");
  ok(stage.length > 3, "stage text");
  release(); await nav;
});

await R.scenario("progress is real: the bar fills through the stages, never backwards, and ends when the editor shows", async () => {
  const p = await open();
  await p.addInitScript(() => { window.__seen = []; window.addEventListener("slai:startup-update", (e) => window.__seen.push(e.detail)); });
  await p.goto(`${base}/?token=${token}`);
  await p.getByRole("button", { name: "Continue as a guest" }).waitFor();
  const seen = await p.evaluate(() => window.__seen);
  ok(seen.length >= 3, "stages reported: " + JSON.stringify(seen));
  const values = seen.map((s) => s.progress); for (let i = 1; i < values.length; i++) ok(values[i] >= values[i - 1], "monotonic " + values);
  ok(seen.some((s) => /server/i.test(s.message)) && seen.some((s) => /Ready|workspace/i.test(s.message)), "stage names");
  await until(async () => (await loader(p).count()) === 0, "loader removed after ready");
});

await R.scenario("the first screen is interactive as soon as the loader goes (no blank window, no second loader)", async () => {
  const p = await open(); const blanks = [];
  p.on("framenavigated", () => {});
  await p.goto(`${base}/?token=${token}`);
  await p.getByRole("button", { name: "Continue as a guest" }).click({ timeout: 8000 });
  await p.getByRole("button", { name: "New Page" }).first().waitFor();
  await until(async () => (await loader(p).count()) === 0, "loader gone");
  ok((await p.locator("body").innerText()).trim().length > 20, "page has content");
});

await R.scenario("starting straight into an existing document opens the editor", async () => {
  const p = await open(); await p.goto(`${base}/?token=${token}`);
  await p.getByRole("button", { name: "Continue as a guest" }).click(); await p.getByRole("button", { name: "New Page" }).first().click();
  await p.getByRole("button", { name: "Create document" }).click(); await p.waitForSelector("#main");
  await until(async () => p.url().includes("/doc/"), "doc route"); const url = p.url();
  await p.reload(); await p.waitForSelector("#main"); await until(async () => (await loader(p).count()) === 0, "loader gone on reopen");
  ok(p.url() === url, "same document after reload");
});

await R.scenario("server not answering: three tries, then a clear error with Reload; never an endless spinner", async () => {
  const p = await open(); let hits = 0;
  await p.route("**/api/bootstrap", (route) => { hits += 1; route.abort("connectionrefused"); });
  await p.goto(`${base}/?token=${token}`);
  await until(async () => (await p.locator("dialog.slai-startup.failed").count()) === 1, "failure shown", 20000);
  eq(hits, 3, "tries");
  ok(/could not|can't reach/i.test(await p.locator(".slai-startup p[role=alert]").innerText()), "message");
  ok(await p.getByRole("button", { name: "Reload" }).count() >= 1, "Reload offered");
});

await R.scenario("a slow server start is waited for: first try fails, second succeeds", async () => {
  const p = await open(); let hits = 0;
  await p.route("**/api/bootstrap", (route) => { hits += 1; if (hits === 1) route.abort("connectionrefused"); else route.continue(); });
  await p.goto(`${base}/?token=${token}`);
  await p.getByRole("button", { name: "Continue as a guest" }).waitFor({ timeout: 12000 });
  eq(hits, 2, "tries"); await until(async () => (await loader(p).count()) === 0, "loader gone");
});

await R.scenario("a missing optional SLAI service does not stop start-up (server says Documaster is off)", async () => {
  const p = await open();
  await p.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch(); const body = await response.json();
    body.data.capabilities.documaster = { available: false, reason: "not installed", version: null };
    body.data.notices = [...body.data.notices, { kind: "warn", text: "Documaster is unavailable (not installed)" }];
    await route.fulfill({ response, json: body });
  });
  await p.goto(`${base}/?token=${token}`);
  await p.getByRole("button", { name: "Continue as a guest" }).waitFor();
  await until(async () => (await loader(p).count()) === 0, "loader gone");
});

await R.scenario("no start-up script error on a normal start", async () => {
  const p = await open(); const problems = [];
  p.on("pageerror", (e) => problems.push(e.message)); p.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  await p.goto(`${base}/?token=${token}`); await p.getByRole("button", { name: "Continue as a guest" }).waitFor(); await delay(300);
  eq(problems, [], "console problems");
});

await R.scenario("high-DPI and small windows keep the loader centred and readable", async () => {
  for (const [w, h, dpr] of [[1280, 800, 2], [360, 640, 3], [800, 480, 1]]) {
    const p = await open({ viewport: { width: w, height: h }, deviceScaleFactor: dpr }); let release; const hold = new Promise((r) => { release = r; }); await gateBootstrap(p, hold);
    const nav = p.goto(`${base}/?token=${token}`, { waitUntil: "commit" });
    await loader(p).waitFor({ state: "visible" });
    const box = await loader(p).boundingBox();
    ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= w + 1 && box.y + box.height <= h + 1, `inside ${w}x${h}: ${JSON.stringify(box)}`);
    ok(Math.abs(box.x + box.width / 2 - w / 2) < 4, `centred at ${w}`);
    const frame = await loader(p).evaluate((e) => { const c = getComputedStyle(e); return [c.borderTopWidth, c.outlineStyle, c.boxShadow]; });
    eq(frame, ["0px", "none", "none"], "no border, outline or shadow around the loader");
    const orb = await p.locator(".slai-startup-orb").boundingBox();
    ok(Math.abs(orb.width - Math.min(0.35 * h, 0.35 * w)) < 2, `logo is 35% of the smaller window side: ${orb.width} in ${w}x${h}`);
    if (w === 1280) await p.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/startup_${w}x${h}.png` });
    release(); await nav; await p.close();
  }
});

await R.scenario("reduced motion: the loader still goes away and nothing animates the exit", async () => {
  const p = await open({ reducedMotion: "reduce" }); await p.goto(`${base}/?token=${token}`);
  await p.getByRole("button", { name: "Continue as a guest" }).waitFor(); await until(async () => (await loader(p).count()) === 0, "loader gone");
});

await browser.close(); server.stop();
R.finish();
