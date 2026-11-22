export const BAND_KEY = "band_shapes";
export const BAND_EDGES = ["header", "footer"];
export const BAND_VARIANTS = ["default", "even", "first"];
export const MAX_BAND_ITEMS = 40;
const ext = (doc) => (((doc.extensions ?? {})["slai.writer"]) ?? {});
export const storeOf = (doc) => ext(doc).band_shapes ?? {};
const bookOf = (doc, section) => ext(doc).book_layouts?.[section] ?? {};
/** The section whose definition of ``edge`` this section shows: itself, or, while it is linked to the previous one, whoever that one shows. */
export function ownerOf(doc, section, edge) {
    const ids = (doc.sections ?? []).map((s) => s.id);
    const store = storeOf(doc);
    let at = ids.includes(section) ? ids.indexOf(section) : 0;
    while (at > 0 && store[ids[at]]?.link?.[edge])
        at -= 1;
    return ids[at] ?? section;
}
export function itemsOf(doc, section, edge, variant) {
    return [...(storeOf(doc)[ownerOf(doc, section, edge)]?.[edge]?.[variant] ?? [])];
}
/** Which list a page shows: the section's first page its own (when asked for), a left-hand page its own when the section has odd and even pages. */
export function variantFor(doc, section, physical, firstOfSection) {
    if (storeOf(doc)[section]?.first_page && firstOfSection)
        return "first";
    if (physical % 2 === 0 && bookOf(doc, section).odd_even === true)
        return "even";
    return "default";
}
/** The shapes a page shows in its header or footer, the variant they come from and whether the page draws them from the other side (a left-hand page of a book
 *  whose edges are swapped shows the ordinary list mirrored). */
export function shapesForPage(doc, section, edge, physical, firstOfSection) {
    let variant = variantFor(doc, section, physical, firstOfSection);
    let items = itemsOf(doc, section, edge, variant);
    const book = bookOf(doc, section);
    let mirrored = false;
    if (variant === "even" && !items.length) {
        variant = "default";
        items = itemsOf(doc, section, edge, "default");
    }
    if (physical % 2 === 0 && variant === "default" && book.mirror === true && book.mirror_edges !== false)
        mirrored = true;
    return { items, variant, mirrored };
}
/** Where a shape's box is on its page, in millimetres from the top-left corner (the box before it is turned; the shape turns about its centre). */
export function placeBand(item, edge, pageW, pageH, left, right, mirrored = false) {
    const frame = pageW - left - right;
    const h = Number(item.shape.height_mm);
    let w;
    let x;
    if (item.span) {
        w = frame;
        x = left;
    }
    else {
        w = Number(item.shape.width_mm);
        x = mirrored ? left + frame - Number(item.x_mm) - w : left + Number(item.x_mm);
    }
    const y = edge === "header" ? Number(item.y_mm) : pageH - Number(item.y_mm) - h;
    return { x, y, w, h };
}
/** The inverse of ``placeBand`` for one shape: the stored ``x_mm`` and ``y_mm`` that put the shape's box at (``x``, ``y``) of the page. */
export function storedFromBox(item, edge, x, y, pageW, pageH, left, right, mirrored = false) {
    const frame = pageW - left - right;
    const w = item.span ? frame : Number(item.shape.width_mm);
    const h = Number(item.shape.height_mm);
    const x_mm = mirrored ? left + frame - x - w : x - left;
    const y_mm = edge === "header" ? y : pageH - y - h;
    return { x_mm: Math.round(x_mm * 100) / 100, y_mm: Math.round(y_mm * 100) / 100 };
}
/** The ``section`` and ``variant`` the editor must send in an operation to change what a page shows (the op layer resolves linked sections to their owner). */
export function targetOf(doc, section, edge, physical, firstOfSection) {
    const { variant } = shapesForPage(doc, section, edge, physical, firstOfSection);
    return { section, edge, variant };
}
/** A new id for a shape of a header or footer: unique across the whole document. */
export function newBandId(doc) {
    const used = new Set();
    for (const entry of Object.values(storeOf(doc)))
        for (const edge of BAND_EDGES)
            for (const list of Object.values(entry[edge] ?? {}))
                for (const item of list ?? [])
                    used.add(item.id);
    for (;;) {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        const id = "bs_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
        if (!used.has(id))
            return id;
    }
}
