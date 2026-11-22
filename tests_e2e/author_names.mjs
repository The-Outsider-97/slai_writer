/** Browser test for the author-name correction controls in the source editor: how each name is read, Confirm, Change by parts, Keep as one name, and what is saved.
 *    NODE_PATH=<dir with playwright> node tests_e2e/author_names.mjs */
import { startServer, runner, chromium, until, ok, eq, delay } from "./harness.mjs";

const server = await startServer("names");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];
const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const stored = async () => ((await api("GET", `/docs/${sid}`)).body.data.document.references ?? []).filter((r) => r.kind === "citation");

try {
  browser = await chromium.launch({ executablePath: process.env.WRITER_CHROMIUM || undefined, args: ["--no-sandbox"] });
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

  const openSource = async () => { await page.getByRole("tab", { name: "References" }).click(); await page.getByRole("button", { name: "Add source" }).click(); const d = page.getByRole("dialog"); await d.waitFor(); return d; };
  const rowFor = (dlg, typed) => dlg.locator(".name-row", { hasText: typed }).first();

  await scenario("typed names are shown as read: a guess is marked and explained, a name written Family, Given is the person's own wording", async () => {
    const dlg = await openSource();
    await dlg.getByLabel("Authors (one per line)").fill("Gabriel García Márquez\nSmith, Jane\nWorld Health Organization");
    await until(async () => (await dlg.locator(".name-row").count()) === 3, "three readings");
    const guess = rowFor(dlg, "Gabriel García Márquez");
    ok((await guess.textContent()).includes("Writer's reading") && (await guess.textContent()).includes("family name Márquez"), "reading shown as a guess");
    ok((await guess.textContent()).includes("García Márquez, Gabriel"), "the note says what to write");
    ok((await rowFor(dlg, "Smith, Jane").textContent()).includes("Your wording"), "stated reading");
    ok((await rowFor(dlg, "World Health Organization").textContent()).includes("one name"), "organisation kept whole");
    eq(await dlg.locator(".name-row.stated button", { hasText: "Confirm" }).count(), 0, "a stated name has nothing to confirm");
  });

  await scenario("Change… writes the corrected line, keeps the other lines, and the saved source has exactly that text", async () => {
    const dlg = page.getByRole("dialog");
    await rowFor(dlg, "Gabriel García Márquez").getByRole("button", { name: "Change…" }).click();
    await dlg.getByLabel("Family name", { exact: true }).fill("García Márquez");
    await dlg.getByLabel("Given names", { exact: true }).fill("Gabriel");
    await dlg.getByRole("button", { name: "Use this reading" }).click();
    eq(await dlg.getByLabel("Authors (one per line)").inputValue(), "García Márquez, Gabriel\nSmith, Jane\nWorld Health Organization", "only that line changed");
    await until(async () => (await rowFor(dlg, "García Márquez, Gabriel").textContent()).includes("Your wording"), "now stated");
    await dlg.getByLabel("Title (required)").fill("Cien años de soledad");
    await dlg.getByLabel("Year").fill("1967");
    await dlg.getByRole("button", { name: "Add source" }).click();
    await until(async () => (await stored()).length === 1, "saved");
    eq((await stored())[0].authors, ["García Márquez, Gabriel", "Smith, Jane", "World Health Organization"], "stored as corrected");
  });

  await scenario("Confirm this reading, Keep as one name and the organisation switch each write one exact line; an impossible entry is refused in place", async () => {
    const dlg = await openSource();
    await dlg.getByLabel("Authors (one per line)").fill("Ludwig van Beethoven\nJohnson and Johnson\nMartin Luther King Jr.\nSmith JA");
    await until(async () => (await dlg.locator(".name-row").count()) === 4, "readings");
    await rowFor(dlg, "Smith JA").getByRole("button", { name: "Keep as one name" }).click();
    await until(async () => (await dlg.getByLabel("Authors (one per line)").inputValue()).endsWith("\n{Smith JA}"), "kept whole");
    await rowFor(dlg, "Ludwig van Beethoven").getByRole("button", { name: "Confirm this reading" }).click();
    await until(async () => (await dlg.getByLabel("Authors (one per line)").inputValue()).startsWith("van Beethoven, Ludwig\n"), "confirmed as the particle reading");
    eq(await rowFor(dlg, "Johnson and Johnson").getByRole("button", { name: "Keep as one name" }).count(), 0, "an organisation reading is already one name: Confirm braces it");
    await rowFor(dlg, "Johnson and Johnson").getByRole("button", { name: "Confirm this reading" }).click();
    await until(async () => (await dlg.getByLabel("Authors (one per line)").inputValue()).includes("{Johnson and Johnson}"), "braced");
    await rowFor(dlg, "Martin Luther King Jr.").getByRole("button", { name: "Change…" }).click();
    await dlg.getByLabel("Family name", { exact: true }).fill("King, X");
    await dlg.getByRole("button", { name: "Use this reading" }).click();
    ok((await dlg.locator(".name-form .form-error").textContent()).includes("commas"), "refused with a reason");
    eq(await dlg.getByLabel("Authors (one per line)").inputValue(), "van Beethoven, Ludwig\n{Johnson and Johnson}\nMartin Luther King Jr.\n{Smith JA}", "nothing else changed");
    await dlg.getByLabel("Family name", { exact: true }).fill("King");
    await dlg.getByLabel("Given names", { exact: true }).fill("Martin Luther");
    await dlg.getByLabel("Suffix").selectOption("Jr.");
    await dlg.getByRole("button", { name: "Use this reading" }).click();
    eq(await dlg.getByLabel("Authors (one per line)").inputValue(), "van Beethoven, Ludwig\n{Johnson and Johnson}\nKing, Martin Luther, Jr.\n{Smith JA}", "suffix written");
    await dlg.getByRole("button", { name: "Cancel" }).last().click();
    eq((await stored()).length, 1, "cancelling saved nothing");
  });

  await scenario("an open correction is never repainted away, and a correction for a line that has since changed writes nothing", async () => {
    const dlg = await openSource();
    const field = dlg.getByLabel("Authors (one per line)");
    await field.fill("Anna Maria Schmidt\nBob Jones");
    await until(async () => (await dlg.locator(".name-row").count()) === 2, "readings");
    await rowFor(dlg, "Anna Maria Schmidt").getByRole("button", { name: "Change…" }).click();
    await delay(1200);                                                       // longer than the pause before the readings are refreshed
    ok(await dlg.locator(".name-form").isVisible(), "the form is still open");
    await dlg.getByLabel("Family name", { exact: true }).fill("Maria Schmidt");
    await field.fill("Anna Maria Schmidt-Berg\nBob Jones");                  // the line is edited while the form is open
    await dlg.getByRole("button", { name: "Use this reading" }).click();
    eq(await field.inputValue(), "Anna Maria Schmidt-Berg\nBob Jones", "nothing was overwritten");
    await until(async () => (await rowFor(dlg, "Anna Maria Schmidt-Berg").count()) === 1, "the readings follow the new text");
  });
} finally {
  await browser?.close();
  server.stop();
  finish(() => { if (problems.length) console.log("console problems:\n  " + [...new Set(problems)].slice(0, 8).join("\n  ")); });
}
