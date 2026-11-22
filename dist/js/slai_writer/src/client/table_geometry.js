export function gridOf(table) {
    const columns = table.columns;
    const cells = [];
    let carry = new Array(columns).fill(0);
    table.rows.forEach((row, r) => {
        const occupied = carry.map((v) => v > 0);
        let column = 0;
        const starts = [];
        row.forEach((cell, idx) => {
            while (column < columns && occupied[column])
                column += 1;
            const cs = Math.max(1, cell.colspan ?? 1), rs = Math.max(1, cell.rowspan ?? 1);
            const item = { r, c: column, rs, cs, row: r, idx, cell };
            starts.push(item);
            cells.push(item);
            column += cs;
        });
        carry = carry.map((v) => Math.max(v - 1, 0));
        for (const item of starts)
            for (let c = item.c; c < Math.min(columns, item.c + item.cs); c += 1)
                carry[c] = item.rs - 1;
    });
    const grid = new Map();
    for (const item of cells)
        for (let r = item.r; r < item.r + item.rs; r += 1)
            for (let c = item.c; c < item.c + item.cs; c += 1)
                grid.set(r * (columns + 1) + c, item);
    return {
        rows: table.rows.length, columns, cells,
        at: (r, c) => grid.get(r * (columns + 1) + c),
        byAddress: (row, idx) => cells.find((x) => x.row === row && x.idx === idx),
    };
}
/** The smallest rectangle holding both cells, grown until it holds only whole cells (the same rule the server applies to a merge or a border). */
export function rectOf(model, a, b) {
    let r0 = Math.min(a.r, b.r), c0 = Math.min(a.c, b.c), r1 = Math.max(a.r + a.rs, b.r + b.rs), c1 = Math.max(a.c + a.cs, b.c + b.cs);
    for (let changed = true; changed;) {
        changed = false;
        for (const cell of model.cells) {
            const bottom = cell.r + cell.rs, right = cell.c + cell.cs;
            const touches = cell.r < r1 && bottom > r0 && cell.c < c1 && right > c0;
            const inside = cell.r >= r0 && bottom <= r1 && cell.c >= c0 && right <= c1;
            if (touches && !inside) {
                r0 = Math.min(r0, cell.r);
                c0 = Math.min(c0, cell.c);
                r1 = Math.max(r1, bottom);
                c1 = Math.max(c1, right);
                changed = true;
            }
        }
    }
    return { r0, c0, r1, c1 };
}
/** What a caret or selection inside a table covers, as a rectangle of whole cells (a caret is the one cell it is in). */
export function selectedRect(table, start, end = start) {
    const model = gridOf(table);
    const a = model.byAddress(start.row, start.col), b = model.byAddress(end.row, end.col);
    if (!a || !b)
        return null;
    return rectOf(model, a, b);
}
/** The operation address of the cell that starts at (or covers) a grid position. */
export function addressAt(model, r, c) {
    const cell = model.at(r, c);
    return cell ? { row: cell.row, col: cell.idx } : null;
}
/** Corner cells (as operation addresses) of a rectangle: for merging and for borders. */
export function cornersOf(model, rect) {
    const from = addressAt(model, rect.r0, rect.c0), to = addressAt(model, rect.r1 - 1, rect.c1 - 1);
    return from && to ? { from, to } : null;
}
export const wholeRows = (rect, columns) => rect.c0 === 0 && rect.c1 === columns;
export const wholeColumns = (rect, rows) => rect.r0 === 0 && rect.r1 === rows;
