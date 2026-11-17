/** How pages are arranged on the desk: one page, or two, three or four side by side, and the two-page book view.
 *
 *  This is arrangement only. It never changes the document, never changes how a page is laid out (that stays the page engine's job), and it is
 *  not a column section: a "page" here is always a whole physical page. The editing view and the rendered view share these functions, so the
 *  order, the empty slot of a book view and the fit-to-window scaling are identical in both. All of it is plain data, so it is tested without a browser. */
/** The most pages a row can hold. A row of the book view is a spread. */
export const MAX_PER_ROW = 4;
export function clampPerRow(value) {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 1;
    return (n < 1 ? 1 : n > MAX_PER_ROW ? MAX_PER_ROW : n);
}
/** Group `count` pages into rows. In the book view the first row holds an empty slot and page 1, which is how a book starts: on the right. */
export function arrange(count, perRow, facing) {
    const n = Math.max(0, Math.floor(count));
    const per = facing ? 2 : clampPerRow(perRow);
    const flat = [];
    if (facing && n > 0)
        flat.push(null);
    for (let i = 0; i < n; i += 1)
        flat.push(i);
    const rows = [];
    for (let at = 0; at < flat.length; at += per) {
        const row = rows.length;
        rows.push(flat.slice(at, at + per).map((page, col) => ({ page, row, col })));
    }
    return { perRow: per, facing: facing && n > 0, rows };
}
/** The row that holds a page (0-based), or 0 when there is no such page. */
export function rowOf(arrangement, page) {
    const at = arrangement.rows.findIndex((row) => row.some((slot) => slot.page === page));
    return at < 0 ? 0 : at;
}
/** The pages in a row, in reading order (the empty slot is not a page). */
export function pagesInRow(arrangement, row) {
    return (arrangement.rows[row] ?? []).flatMap((slot) => (slot.page === null ? [] : [slot.page]));
}
/** Previous or next group of pages: returns the first page of the row that is `by` rows away (clamped to the document). */
export function groupTarget(arrangement, from, by) {
    if (!arrangement.rows.length)
        return 0;
    const target = Math.max(0, Math.min(arrangement.rows.length - 1, rowOf(arrangement, from) + by));
    return pagesInRow(arrangement, target)[0] ?? 0;
}
/** Physical position of a page in a book: the first page (and every odd one) is a right-hand page, the second (and every even one) a left-hand page.
 *  It depends on the position in the document only, never on the printed page number. `physical` is 1-based. */
export function sideOf(physical) { return physical % 2 === 1 ? "right" : "left"; }
/** The size of the whole arrangement in the same unit as the page sizes: the widest row (pages and the gaps between them) by every row and
 *  the gaps between rows. Pages keep their own sizes; a row is as tall as its tallest page. */
export function extent(arrangement, boxes, gapX, gapY) {
    let width = 0;
    let height = 0;
    let tallest = 0;
    arrangement.rows.forEach((row, at) => {
        const pages = row.flatMap((slot) => (slot.page === null ? [] : [boxes[slot.page] ?? { widthMm: 0, heightMm: 0 }]));
        // an empty slot is as wide as a page (the page next to it), so a lone first page of a book stays on the right
        const slots = row.map((slot) => (slot.page === null ? (pages[0] ?? { widthMm: 0, heightMm: 0 }) : (boxes[slot.page] ?? { widthMm: 0, heightMm: 0 })));
        const rowWidth = slots.reduce((sum, box) => sum + box.widthMm, 0) + Math.max(0, slots.length - 1) * (arrangement.facing ? 0 : gapX);
        const rowHeight = slots.reduce((tall, box) => Math.max(tall, box.heightMm), 0);
        width = Math.max(width, rowWidth);
        height += rowHeight + (at > 0 ? gapY : 0);
        tallest = Math.max(tallest, rowHeight);
    });
    return { width, height, widest: width, tallest };
}
/** The zoom (a fraction, 1 = 100 %) at which the arrangement fits the window: its widest row across, its tallest row down, or both.
 *  `pxPerUnit` converts the page unit to CSS pixels. The result is clamped to the zoom range of the status bar (10 % to 400 %). */
export function fitFraction(mode, arrangement, boxes, view, pxPerUnit, gapPx = 0) {
    const size = extent(arrangement, boxes, gapPx / pxPerUnit, 0);
    if (size.widest <= 0 || size.tallest <= 0)
        return 1;
    const byWidth = view.width / (size.widest * pxPerUnit);
    const byHeight = view.height / (size.tallest * pxPerUnit);
    const raw = mode === "width" ? byWidth : mode === "height" ? byHeight : Math.min(byWidth, byHeight);
    return Math.max(0.1, Math.min(4, raw));
}
