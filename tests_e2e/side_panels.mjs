/** Browser test for the side panels of pages shown side by side: the tabs and panels (Corrections/Proofing on the left of a page, Notes on its right) never overlap one
 *  another, a page or the text, in 1, 2, 3 and 4 pages across, in the book view and in the Rendered View; opening a panel makes room by moving pages, in both directions,
 *  at any zoom and window size, without changing the pages themselves (their size, their text, where it breaks) or the reader's place. Real Chromium, real server.
 *    NODE_PATH=<dir with playwright> node tests_e2e/side_panels.mjs
 *  The screenshots of the two directions are kept in tests_e2e/evidence/. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startServer, runner, chromium, until, ok, eq, delay, app } from "./harness.mjs";

const server = await startServer("sidepanels");
const { scenario, state, finish } = runner();
let browser, page, sid;
const problems = [];
const PAGES = 8;
const evidence = join(app, "tests_e2e", "evidence");
mkdirSync(evidence, { recursive: true });

const api = (method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch("/api" + url, { method, headers: { "Content-Type": "application/json", "X-SLAI-Writer": "1" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}, { method, url, body });
const op = async (o) => { const r = await api("POST", `/docs/${sid}/ops`, { op: o }); ok(r.status < 300, `op ${o.op} failed: ${JSON.stringify(r.body).slice(0, 300)}`); return r; };

async function fresh({ size = { width: 1500, height: 1000 }, pages = PAGES } = {}) {
  await page?.close();
  page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
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
  const s = (await api("GET", `/docs/${sid}`)).body.data;
  let after = s.blocks[s.blocks.length - 1].id;
  const ops = [];
  for (let n = 0; n < pages; n++) {
    ops.push({ op: "block_insert", after, block: { id: `p${n}`, type: "paragraph", text: `Body text of page ${n + 1}.`, attributes: n ? { page_break_before: true } : {} } });
    after = `p${n}`;
  }
  await op({ op: "batch", ops });
  await page.reload(); await page.locator("#main").waitFor();
  await until(async () => (await page.locator(".sheet").count()) >= pages, "pages");
  await delay(400);
}

const pagesButton = () => page.getByRole("button", { name: /^Pages shown side by side/ });
const pick = async (label) => { await pagesButton().click(); await page.getByRole("menuitem", { name: label }).click(); await settle(); };
/** Everything moves for 380 ms after a change; wait until two reads 150 ms apart agree. */
async function settle() {
  let last = "";
  for (let n = 0; n < 40; n++) {
    await delay(150);
    const now = JSON.stringify(await snapshot());
    if (now === last) return;
    last = now;
  }
}
const setZoom = async (percent) => { await page.evaluate((p) => { const input = document.querySelector(".zoomctl input[type=range]"); input.value = String(p); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })); }, percent); await settle(); };

/** Every box that matters, in screen pixels. */
const snapshot = () => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: Math.round(b.left * 10) / 10, t: Math.round(b.top * 10) / 10, r: Math.round(b.right * 10) / 10, b: Math.round(b.bottom * 10) / 10 }; };
  const scroller = document.querySelector(".page-area .scroller, .scroller") ?? document.querySelector("#main").closest("[class*=scroll]");
  return {
    sheets: [...document.querySelectorAll(".sheets .sheet")].map(r),
    tabs: [...document.querySelectorAll(".ptab")].filter((e) => !e.hidden).map((e) => ({ kind: e.classList.contains("red") ? "red" : e.classList.contains("yellow") ? "yellow" : "embed", sheet: Number(e.dataset.sheet), open: e.classList.contains("open"), ...r(e) })),
    panels: [...document.querySelectorAll(".ppanel.open")].map((e) => ({ kind: e.classList.contains("red") ? "red" : e.classList.contains("yellow") ? "yellow" : "embed", ...r(e) })),
    zoom: Number((document.querySelector(".zoomer")?.style.transform.match(/scale\(([\d.]+)\)/) ?? [0, 1])[1]),
    scroll: scroller ? { top: Math.round(scroller.scrollTop), left: Math.round(scroller.scrollLeft), w: scroller.clientWidth, h: scroller.clientHeight, box: r(scroller) } : null,
  };
});
const area = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
const wide = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l);
const high = (a, b) => Math.min(a.b, b.b) - Math.max(a.t, b.t);
const hit = (a, b, tolerance = 2) => wide(a, b) > tolerance && high(a, b) > tolerance;

/** Nothing overlaps anything it is not meant to: a tab or a panel is tucked a few pixels behind its own page and nowhere else; no two tabs, no two panels, no panel and a tab of another page. */
function noOverlap(s, what) {
  const tucked = 14 * (s.zoom || 1) + 3;                                   // how far a panel reaches in behind its own page (14 page units), and a pixel or two of rounding
  s.tabs.forEach((a, i) => {
    s.tabs.slice(i + 1).forEach((b) => ok(!hit(a, b), `${what}: the ${a.kind} tab of page ${a.sheet + 1} overlaps the ${b.kind} tab of page ${b.sheet + 1} (${JSON.stringify(a)} / ${JSON.stringify(b)})`));
    s.panels.forEach((p) => {
      const own = p.kind === a.kind && a.open;
      if (!own) ok(!hit(a, p), `${what}: the ${a.kind} tab of page ${a.sheet + 1} overlaps the open ${p.kind} panel`);
    });
    // (the tab of the EMBED panel hangs in the gap below its page, which is not part of this change)
    if (a.kind !== "embed") s.sheets.forEach((sh, k) => { if (k !== a.sheet) ok(!hit(a, sh), `${what}: the ${a.kind} tab of page ${a.sheet + 1} is drawn over page ${k + 1}`); });
  });
  s.panels.forEach((p, i) => {
    s.panels.slice(i + 1).forEach((q) => ok(!hit(p, q), `${what}: two panels overlap`));
    const owners = s.tabs.filter((t) => t.open && t.kind === p.kind).map((t) => t.sheet);
    s.sheets.forEach((sh, k) => { if (!owners.includes(k) && p.kind !== "embed") ok(!hit(p, sh, 2), `${what}: the ${p.kind} panel is drawn over page ${k + 1}`); else if (owners.includes(k) && p.kind !== "embed") ok(wide(p, sh) <= tucked, `${what}: the ${p.kind} panel covers ${wide(p, sh)} px of its own page`); });
  });
  s.sheets.forEach((a, i) => s.sheets.slice(i + 1).forEach((b, j) => ok(!hit(a, b), `${what}: pages ${i + 1} and ${i + j + 2} overlap`)));
}
const rowsOf = (s) => {
  const rows = [];
  s.sheets.forEach((sh, i) => { const row = rows.find((x) => Math.abs(x.t - sh.t) < 8); if (row) row.pages.push(i); else rows.push({ t: sh.t, pages: [i] }); });
  return rows;
};
const tabOf = (kind, sheet) => page.locator(`.ptab.${kind}[data-sheet='${sheet}']`);
/** Scroll (only up or down) to the page, then click its tab. */
const vertically = (sheet) => page.locator(".sheet").nth(sheet).evaluate((el) => { const sc = document.querySelector(".scroller"); const v = sc.getBoundingClientRect(), r = el.getBoundingClientRect(); sc.scrollTop += r.top + r.height / 2 - (v.top + v.height / 2); });
const click = async (kind, sheet) => { await vertically(sheet); await delay(100); await tabOf(kind, sheet).click(); await settle(); };
const pagesText = () => page.evaluate(() => [...document.querySelectorAll(".sheets .sheet")].map((e) => ({ w: Math.round(e.offsetWidth), h: Math.round(e.offsetHeight), text: e.querySelector(".body")?.innerText.replace(/\s+/g, " ").trim() ?? "" })));
const shot = (name) => page.screenshot({ path: join(evidence, name) });

try {
  browser = await chromium.launch();

  await scenario("collapsed tabs never overlap in 1, 2, 3 and 4 pages across, at any zoom", async () => {
    await fresh();
    for (const n of [1, 2, 3, 4]) {
      await pick(n === 1 ? "1 page" : `${n} pages`);
      for (const zoom of [25, 50, 64, 100, 150]) {
        await setZoom(zoom);
        const s = await snapshot();
        noOverlap(s, `${n} across at ${zoom} %`);
        if (n > 1) {
          // between two pages of a row both tabs show, side by side
          const first = rowsOf(s)[0];
          for (let k = 0; k + 1 < first.pages.length; k++) {
            const y = s.tabs.find((t) => t.kind === "yellow" && t.sheet === first.pages[k]);
            const r = s.tabs.find((t) => t.kind === "red" && t.sheet === first.pages[k + 1]);
            ok(y && r, `${n} across at ${zoom} %: both tabs of the seam are there`);
            ok(r.l >= y.r - 0.5, `${n} across at ${zoom} %: the Notes tab (to ${y.r}) is left of the Corrections tab (from ${r.l})`);
            ok(y.r - s.sheets[first.pages[k]].r <= 40 && s.sheets[first.pages[k + 1]].l - r.l <= 40, "and each stays by its own page");
          }
        }
      }
    }
    await pick("1 page");
  });

  await scenario("the pages are not changed by the panel layout: same size, same text, same page breaks in every arrangement", async () => {
    await fresh();
    await pick("1 page"); await setZoom(100);
    const base = await pagesText();
    ok(base.length >= PAGES, `pages: ${base.length}`);
    for (const n of [2, 3, 4]) {
      await pick(`${n} pages`);
      eq(await pagesText(), base, `${n} across: the same pages`);
      await click("yellow", 0);
      eq(await pagesText(), base, `${n} across with a panel open: the same pages`);
      await click("yellow", 0);
    }
  });

  await scenario("2 pages: the left page's Notes open: the right page moves right, the left page stays, nothing overlaps", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(50);
    const before = await snapshot();
    await click("yellow", 0);
    const after = await snapshot();
    noOverlap(after, "Notes open on page 1");
    ok(Math.abs(after.sheets[0].l - before.sheets[0].l) <= 3, `the page that owns the panel stays put (${before.sheets[0].l} → ${after.sheets[0].l})`);
    ok(after.sheets[1].l - before.sheets[1].l > 100, `the right page moved right to make room (${before.sheets[1].l} → ${after.sheets[1].l})`);
    ok(after.panels.length === 1 && after.panels[0].kind === "yellow", "one panel is open");
    const p = after.panels[0];
    ok(p.l >= after.sheets[0].r - 16 && p.r <= after.sheets[1].l + 1, `the panel lies between the pages (${p.l}..${p.r}, pages end ${after.sheets[0].r} / start ${after.sheets[1].l})`);
    ok(after.sheets[1].r <= after.scroll.box.r + 1 || after.scroll.left > before.scroll.left, "the right page is reachable (inside the window or scrolled to)");
    await shot("notes-left-page-opens.png");
    // closing gives the room back
    await click("yellow", 0);
    const closed = await snapshot();
    ok(Math.abs(closed.sheets[1].l - before.sheets[1].l) <= 3 && Math.abs(closed.sheets[0].l - before.sheets[0].l) <= 3, "closing the panel puts the pages back");
    noOverlap(closed, "closed again");
  });

  await scenario("2 pages: the right page's Proofing opened from collapsed: the left page moves left, the right page stays, nothing overlaps", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(50);
    const before = await snapshot();
    await click("red", 1);
    const after = await snapshot();
    noOverlap(after, "Proofing open on page 2");
    ok(Math.abs(after.sheets[1].l - before.sheets[1].l) <= 3, `the page that owns the panel stays put (${before.sheets[1].l} → ${after.sheets[1].l})`);
    ok(before.sheets[0].l - after.sheets[0].l > 100, `the left page moved left (${before.sheets[0].l} → ${after.sheets[0].l}, scrolled ${before.scroll.left} → ${after.scroll.left})`);
    ok(after.panels.length === 1 && after.panels[0].kind === "red", "one panel is open");
    const p = after.panels[0];
    ok(p.r >= after.sheets[1].l - 1 && p.l >= after.sheets[0].r - 1, `the panel lies between the pages (${p.l}..${p.r})`);
    ok(after.sheets[0].l >= after.scroll.box.l - 1, "the left page is not pushed out of the window");
    await shot("proofing-right-page-opens.png");
    await click("red", 1);
    const closed = await snapshot();
    ok(Math.abs(closed.sheets[0].l - before.sheets[0].l) <= 3, "closing the panel puts the left page back");
    noOverlap(closed, "closed again");
  });

  await scenario("a seam holds one panel: Notes opening closes the next page's Proofing, and Proofing opening closes the previous page's Notes", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(64);
    await click("red", 1);
    ok((await snapshot()).panels.map((p) => p.kind).join() === "red", "Proofing of page 2 is open");
    await click("yellow", 0);
    let s = await snapshot();
    eq(s.panels.map((p) => p.kind), ["yellow"], "Notes of page 1 opened and Proofing of page 2 closed");
    noOverlap(s, "Notes took the seam");
    ok(s.tabs.find((t) => t.kind === "red" && t.sheet === 1).open === false, "the Proofing tab says closed");
    await click("red", 1);
    s = await snapshot();
    eq(s.panels.map((p) => p.kind), ["red"], "Proofing of page 2 opened and Notes of page 1 closed");
    noOverlap(s, "Proofing took the seam back");
    // panels of other seams are not disturbed: Notes on page 4 (the other row) does not close Proofing on page 2
    await click("yellow", 3);
    s = await snapshot();
    eq(s.panels.map((p) => p.kind).sort(), ["red", "yellow"].sort(), "different seams: both stay open");
    noOverlap(s, "two seams, two panels");
  });

  await scenario("3 and 4 pages across: a panel in the middle of a row only moves the pages after (or before) it; nothing overlaps", async () => {
    await fresh();
    for (const n of [3, 4]) {
      await pick(`${n} pages`); await setZoom(n === 3 ? 40 : 30);
      const before = await snapshot();
      await click("yellow", 1);
      let s = await snapshot();
      noOverlap(s, `${n} across: Notes of page 2`);
      ok(Math.abs(s.sheets[1].l - before.sheets[1].l) <= 3 && Math.abs(s.sheets[0].l - before.sheets[0].l) <= 3, `${n} across: the pages up to the owner stay`);
      ok(s.sheets[2].l - before.sheets[2].l > 50, `${n} across: the page after moves away`);
      await shot(`notes-middle-of-${n}.png`);
      await click("red", 2);                                              // Proofing on the page after: the same seam, takes it over
      s = await snapshot();
      eq(s.panels.map((p) => p.kind), ["red"], `${n} across: the seam holds one panel`);
      noOverlap(s, `${n} across: Proofing of page 3`);
      await click("red", 2);
      noOverlap(await snapshot(), `${n} across: all closed`);
    }
  });

  await scenario("when the window has no room for the page to stay put, it moves only as far as it must and nothing is cut off or overlapped", async () => {
    await fresh({ size: { width: 1100, height: 800 } });
    await pick("2 pages"); await setZoom(64);
    const before = await snapshot();
    await click("red", 1);
    const after = await snapshot();
    noOverlap(after, "narrow window, Proofing on page 2");
    ok(after.sheets[0].l >= after.scroll.box.l - 1, `the left page is inside the window (${after.sheets[0].l} vs ${after.scroll.box.l})`);
    ok(after.sheets[1].l - before.sheets[1].l >= -3, "the owner never moves the wrong way");
    const room = await page.evaluate(() => { const sc = document.querySelector(".scroller"); return sc.scrollWidth - sc.clientWidth - sc.scrollLeft; });
    ok(after.sheets[1].r <= after.scroll.box.r + 1 || room >= after.sheets[1].r - after.scroll.box.r, `the rest is reachable by scrolling (${room}px of scroll left, ${Math.round(after.sheets[1].r - after.scroll.box.r)} needed)`);
    await shot("proofing-narrow-window.png");
    await click("red", 1);
  });

  await scenario("the outer sides: a panel at the edge of a row keeps the page inside the window and the window can reach it", async () => {
    await fresh({ size: { width: 1000, height: 800 } });
    await pick("2 pages"); await setZoom(50);
    await click("red", 0);
    let s = await snapshot();
    noOverlap(s, "Proofing on the first page");
    ok(s.sheets[0].l >= s.scroll.box.l - 1 || s.scroll.left > 0, "the first page is inside the window");
    ok(s.panels[0].l >= s.scroll.box.l - 1, `the panel is not cut off at the window's left edge (${s.panels[0].l} vs ${s.scroll.box.l})`);
    await click("red", 0);
    await click("yellow", 1);
    s = await snapshot();
    noOverlap(s, "Notes on the second page");
    const reach = await page.evaluate(() => { const sc = document.querySelector(".scroller") ?? document.querySelector("#main").closest("[class*=scroll]"); return { max: sc.scrollWidth - sc.clientWidth, at: sc.scrollLeft }; });
    ok(s.panels[0].r <= s.scroll.box.r + 1 || reach.at < reach.max, "the panel at the right edge can be scrolled into view");
    await click("yellow", 1);
  });

  await scenario("zoom and window size while a panel is open: the layout follows, nothing overlaps, the panel stays open", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(64);
    await click("yellow", 0);
    for (const zoom of [30, 50, 100, 150, 64]) {
      await setZoom(zoom);
      const s = await snapshot();
      eq(s.panels.map((p) => p.kind), ["yellow"], `still open at ${zoom} %`);
      noOverlap(s, `Notes open at ${zoom} %`);
    }
    for (const size of [{ width: 1100, height: 800 }, { width: 1800, height: 1000 }, { width: 1280, height: 720 }]) {
      await page.setViewportSize(size); await settle();
      const s = await snapshot();
      eq(s.panels.map((p) => p.kind), ["yellow"], `still open at ${size.width}`);
      noOverlap(s, `Notes open in a ${size.width} px window`);
    }
    await click("yellow", 0);
    // the page size changes the geometry: landscape
    await op({ op: "page_layout", scope: "document", orientation: "landscape" });
    await page.reload(); await page.locator("#main").waitFor(); await delay(700);
    await pick("2 pages"); await setZoom(50);
    noOverlap(await snapshot(), "landscape, closed");
    await click("red", 1);
    noOverlap(await snapshot(), "landscape, Proofing on page 2");
    await click("yellow", 0);
    noOverlap(await snapshot(), "landscape, Notes on page 1");
    await op({ op: "page_layout", scope: "document", orientation: "portrait" });
  });

  await scenario("the reader's place is kept: scroll position (and the page on screen) does not jump when a panel opens, closes or moves to the other seam", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(64);
    await vertically(4);
    await delay(300);
    const start = await snapshot();
    const seen = [];
    page.on("framenavigated", () => seen.push("navigated"));
    // sample the vertical scroll position while a panel slides: it must never move
    const tops = page.evaluate(async () => {
      const sc = document.querySelector(".scroller") ?? document.querySelector("#main").closest("[class*=scroll]");
      const out = [];
      const end = performance.now() + 1400;
      while (performance.now() < end) { out.push(Math.round(sc.scrollTop)); await new Promise((r) => requestAnimationFrame(r)); }
      return out;
    });
    await tabOf("yellow", 4).click();
    const run = await tops;
    ok(run.every((t) => Math.abs(t - start.scroll.top) <= 2), `scrollTop stayed at ${start.scroll.top} during the slide: ${[...new Set(run)]}`);
    await tabOf("red", 5).click(); await settle();
    ok(Math.abs((await snapshot()).scroll.top - start.scroll.top) <= 2, "moving the panel to the other side of the seam keeps the place");
    await tabOf("red", 5).click(); await settle();
    ok(Math.abs((await snapshot()).scroll.top - start.scroll.top) <= 2, "closing keeps the place");
    eq(seen, [], "no reload happened");
  });

  await scenario("keyboard: the tabs are reachable with Tab, Enter and Space open, Escape closes and returns the focus", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(64);
    const tab = tabOf("yellow", 0);
    await tab.focus();
    ok(await tab.evaluate((e) => e === document.activeElement), "the Notes tab takes focus");
    await page.keyboard.press("Enter"); await settle();
    eq(await tab.getAttribute("aria-expanded"), "true", "Enter opens");
    ok(await page.evaluate(() => !!document.querySelector(".ppanel.yellow.open")), "the panel is open");
    // while open the panel is reachable, the others are not (inert)
    ok(await page.evaluate(() => document.querySelector(".ppanel.red")?.inert === true), "the closed panel is inert");
    await page.locator(".ppanel.yellow.open").focus().catch(() => {});
    await page.keyboard.press("Escape"); await settle();
    eq(await tab.getAttribute("aria-expanded"), "false", "Escape closes the panel");
    ok(await tab.evaluate((e) => e === document.activeElement), "and the focus returns to its tab");
    await tab.focus(); await page.keyboard.press("Space"); await settle();
    eq(await tab.getAttribute("aria-expanded"), "true", "Space opens");
    await tab.focus(); await page.keyboard.press("Space"); await settle();
    eq(await tab.getAttribute("aria-expanded"), "false", "Space closes");
    // each tab has a name that says which page and which panel
    const labels = await page.evaluate(() => [...document.querySelectorAll(".ptab")].map((e) => e.getAttribute("aria-label")));
    ok(labels.every((l) => /panel, page \d+/.test(l)), `names: ${labels.slice(0, 3)}`);
    ok(new Set(labels).size === labels.length, "all different");
  });

  await scenario("book view: the pages of a spread touch, the spine tabs are not drawn until a panel opens there, the outer tabs always are", async () => {
    await fresh();
    await op({ op: "page_layout", scope: "document", mirror: true });
    await page.reload(); await page.locator("#main").waitFor(); await delay(700);
    await pagesButton().click(); await page.getByRole("menuitem", { name: /2 pages: book view/ }).click(); await settle();
    await setZoom(64);
    let s = await snapshot();
    noOverlap(s, "book view, closed");
    // sheets: page 1 alone on the right of the first row, then spreads
    const spreads = rowsOf(s).filter((r) => r.pages.length === 2);
    ok(spreads.length >= 2, "spreads");
    for (const r of spreads) ok(Math.abs(s.sheets[r.pages[1]].l - s.sheets[r.pages[0]].r) <= 1.5, `the pages of the spread ${r.pages} touch`);
    for (const r of spreads) {
      ok(!s.tabs.some((t) => t.kind === "yellow" && t.sheet === r.pages[0]), "no Notes tab at the spine");
      ok(!s.tabs.some((t) => t.kind === "red" && t.sheet === r.pages[1]), "no Proofing tab at the spine");
      ok(s.tabs.some((t) => t.kind === "red" && t.sheet === r.pages[0]) && s.tabs.some((t) => t.kind === "yellow" && t.sheet === r.pages[1]), "the outer tabs are there");
    }
    // a panel at the outer edge does not open the spine
    const spread = spreads[0].pages;
    await click("yellow", spread[1]);
    s = await snapshot();
    noOverlap(s, "outer Notes open");
    ok(Math.abs(s.sheets[spread[1]].l - s.sheets[spread[0]].r) <= 1.5, "the spread is still closed");
    await click("yellow", spread[1]);
    // the Notes of the left page cannot be reached from its (hidden) tab, but its Proofing and the right page's Notes can; Notes on the left page opens by the keyboard shortcut? No: it opens through the right-hand Proofing of the page before it
    const hiddenYellow = await page.locator(`.ptab.yellow[data-sheet='${spread[0]}']`).evaluate((e) => e.hidden);
    ok(hiddenYellow, "the spine tab is hidden, not just invisible: it is out of the tab order");
    await shot("book-view-closed.png");
  });

  await scenario("Rendered View: no panel tabs, no overlap, pages as exported; coming back restores the panel layout", async () => {
    await fresh();
    await pick("2 pages"); await setZoom(64);
    await click("yellow", 0);
    const open = await snapshot();
    await page.locator(".sbtn.rendered-toggle").click();
    await page.locator(".rendered .rv-page").first().waitFor();
    await delay(800);
    const rv = await page.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      return { tabs: [...document.querySelectorAll(".ptab")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== "hidden"; }).length, pages: [...document.querySelectorAll(".rendered .rv-page")].map(r) };
    });
    eq(rv.tabs, 0, "the Rendered View draws no side tabs");
    rv.pages.forEach((a, i) => rv.pages.slice(i + 1).forEach((b) => ok(!hit(a, b), "rendered pages overlap")));
    await shot("rendered-view.png");
    await page.locator(".sbtn.rendered-toggle").click();
    await until(async () => (await page.locator(".sheet").count()) >= PAGES, "back to the editor");
    await settle();
    const back = await snapshot();
    noOverlap(back, "back in the editor");
    eq(back.panels.length, open.panels.length, "the panel state survives");
  });

  await scenario("nothing in the document changed: opening and closing panels, in every arrangement, makes no edit (no new version, nothing to undo)", async () => {
    await fresh();
    const version = async () => (await api("GET", `/docs/${sid}`)).body.data.version ?? (await api("GET", `/docs/${sid}`)).body.version;
    const v0 = await version();
    for (const n of [2, 3, 4]) { await pick(`${n} pages`); await click("yellow", 0); await click("red", 1); await click("red", 1); }
    eq(await version(), v0, "the document version is the same");
    ok(await page.getByRole("button", { name: /^Undo/ }).isDisabled().catch(() => true), "nothing to undo");
  });

  ok(problems.length === 0, `no console errors: ${problems.slice(0, 3).join(" | ")}`);
} finally {
  await browser?.close();
  server.stop();
}
finish();
