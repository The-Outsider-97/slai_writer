/** Where the side panels of the pages go when several pages are side by side. Nothing here touches the DOM.
 *
 *  Every page has a Corrections tab (red) on its left and a Notes tab (gold) on its right, and the panels they open grow out of the same edges. Between two pages that are
 *  side by side the Notes tab of the left page and the Corrections tab of the right page therefore share one *seam*, and so would their panels. The seam is given the room it
 *  needs by moving the pages apart (the right page of the seam gets a left margin), never by painting one thing over another:
 *
 *  * both tabs closed: the two tabs side by side, whatever the zoom (the tabs keep a size on screen, so the seam grows when the page is zoomed out);
 *  * the left page's Notes open: its panel and tab fill the seam and the right page moves right;
 *  * the right page's Corrections open: the same room, taken the same way, so the left page moves left (the pages are held by the one that owns the panel, see
 *    ``PageView.refit``);
 *  * a seam holds one panel: opening Notes on a page closes the Corrections panel of the page after it, and opening Corrections closes the Notes of the page before it.
 *
 *  In the book view the two pages of a spread touch, so their tabs at the spine are not drawn while their panels are closed; opening one pushes the spread apart.
 *  The EMBED panel hangs below its page, so it never shares a seam.
 *
 *  The rows are those of the arrangement (pages 0-based); the unit is the page unit (CSS pixels at 100 %). */

export type PanelKind = "red" | "yellow" | "embed";
export type OpenPanels = Record<PanelKind, number | null>;

/** The visual gap kept between the two tabs of a seam, and between a tab and the page it belongs to. */
export const SEAM_PAD = 6;

export interface SeamOptions {
  /** The width of a tab, in page units. */
  tab: number;
  /** The width of a panel, in page units. */
  panel: number;
  /** The gap the page grid already leaves between two pages (28 in the ordinary views, 0 in the book view). */
  gap: number;
  /** Book view: the pages of a spread touch. */
  facing: boolean;
}

export interface SeamLayout {
  /** The left margin to give each page (by index), in page units: 0 for a page that needs none. */
  margins: number[];
  /** The room needed beyond the first and the last page of a row, in page units (the tab, and the panel when one is open there). */
  room: { left: number; right: number };
  /** The tabs that are not drawn: ``"red:<page>"`` and ``"yellow:<page>"`` at the spine of a book. */
  hidden: Set<string>;
}

/** The panels that must close when ``kind`` opens on page ``sheet``: the one that would share its seam. */
export function conflicts(rows: number[][], open: OpenPanels, kind: PanelKind, sheet: number): PanelKind[] {
  const out: PanelKind[] = [];
  for (const row of rows) {
    const at = row.indexOf(sheet);
    if (at < 0) continue;
    if (kind === "yellow" && at + 1 < row.length && open.red === row[at + 1]) out.push("red");           // the Notes of the page before it
    if (kind === "red" && at > 0 && open.yellow === row[at - 1]) out.push("yellow");                  // the Corrections of the page after it
  }
  return out;
}

/** The width a seam between ``left`` and ``right`` needs, tabs and an open panel included. */
export function seamWidth(open: OpenPanels, left: number, right: number, o: SeamOptions): number {
  const panelHere = open.yellow === left || open.red === right;
  if (o.facing) return panelHere ? o.panel + o.tab + SEAM_PAD : 0;
  return 2 * o.tab + SEAM_PAD + (panelHere ? o.panel : 0);
}

export function layoutSeams(rows: number[][], count: number, open: OpenPanels, o: SeamOptions): SeamLayout {
  const margins = Array.from({ length: Math.max(0, count) }, () => 0);
  const hidden = new Set<string>();
  let roomLeft = o.tab + SEAM_PAD, roomRight = o.tab + SEAM_PAD;
  for (const row of rows) {
    row.forEach((page, k) => {
      if (k === 0) {
        if (open.red === page) roomLeft = Math.max(roomLeft, o.tab + SEAM_PAD + o.panel);
      } else {
        const left = row[k - 1] as number;
        margins[page] = Math.max(0, seamWidth(open, left, page, o) - o.gap);
        if (o.facing) {
          if (open.yellow !== left) hidden.add(`yellow:${left}`);
          if (open.red !== page) hidden.add(`red:${page}`);
        }
      }
      if (k === row.length - 1 && open.yellow === page) roomRight = Math.max(roomRight, o.tab + SEAM_PAD + o.panel);
    });
  }
  return { margins, room: { left: roomLeft, right: roomRight }, hidden };
}
