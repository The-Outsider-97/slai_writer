/** Columns as the page view needs them: read from the document (sections and Writer's column layouts), nothing about the DOM. */
import type { ColumnLayout, DocMeta, Section, WriterExt } from "./types.js";

export interface ColumnSpec {
  /** The id of the section the columns belong to (blocks of one section share one column region). */
  key: string; count: number; gapMm: number; widthsMm?: number[] | undefined;
  rule?: { color: string; width_pt: number; style: string } | undefined; balance: boolean; rtl: boolean;
}

export const MAX_COLUMNS = 4;
export const DEFAULT_GAP_MM = 10;

export function layoutOf(meta: DocMeta, sectionId: string | undefined): ColumnLayout {
  const ext = ((meta.extensions ?? {})["slai.writer"] ?? {}) as WriterExt;
  return (sectionId && ext.column_layouts?.[sectionId]) || {};
}

export function sectionOf(meta: DocMeta, sectionId: string | undefined): Section | undefined {
  const sections = meta.sections ?? [];
  return sections.find((s) => s.id === sectionId) ?? (sectionId === undefined ? sections[0] : undefined);
}

/** The columns of a section, or null for a section of one column. */
export function columnSpec(meta: DocMeta, sectionId: string | undefined): ColumnSpec | null {
  const section = sectionOf(meta, sectionId);
  const count = Math.max(1, Math.min(8, Math.round(section?.columns ?? 1)));
  if (!section || count < 2) return null;
  const layout = layoutOf(meta, section.id);
  const widths = layout.widths_mm && layout.widths_mm.length === count ? layout.widths_mm : undefined;
  return {
    key: section.id, count, gapMm: section.column_gap_mm ?? DEFAULT_GAP_MM, widthsMm: widths,
    rule: layout.rule ? { color: layout.rule.color ?? "#000000", width_pt: layout.rule.width_pt ?? 0.75, style: layout.rule.style ?? "solid" } : undefined,
    balance: layout.balance === true, rtl: layout.flow === "rtl",
  };
}

const canon = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : v)) ?? "";

/** Sections that continue on the page of the one before them (and have the same page) form one page group, named by its first section.
 *  The sheets, headers, footers and page numbers belong to the group. */
export function pageGroups(meta: DocMeta): Map<string, string> {
  const out = new Map<string, string>();
  let previous: Section | undefined;
  for (const section of meta.sections ?? []) {
    const continues = previous !== undefined && layoutOf(meta, section.id).continuous === true && canon(previous.page ?? {}) === canon(section.page ?? {});
    out.set(section.id, continues && previous ? (out.get(previous.id) ?? previous.id) : section.id);
    previous = section;
  }
  return out;
}

/** Every section of the page group a section belongs to (what a page setup, header or footer change has to reach). */
export function groupMembers(meta: DocMeta, sectionId: string | undefined): string[] {
  const groups = pageGroups(meta);
  const id = sectionId ?? meta.sections?.[0]?.id;
  if (!id) return [];
  const group = groups.get(id) ?? id;
  return (meta.sections ?? []).filter((s) => (groups.get(s.id) ?? s.id) === group).map((s) => s.id);
}

/** CSS for a region: columns of equal width, the gap, and the line between them. Unequal widths are not something CSS columns can flow text through:
 *  the preview keeps equal columns, the stored widths are used by the export. */
export function regionCss(spec: ColumnSpec, mmPx: number): Record<string, string> {
  const css: Record<string, string> = {
    "column-count": String(spec.count), "column-gap": `${spec.gapMm * mmPx}px`, "column-fill": spec.balance ? "balance" : "auto",
    direction: spec.rtl ? "rtl" : "ltr",
  };
  if (spec.rule) css["column-rule"] = `${Math.max(1, spec.rule.width_pt * 96 / 72)}px ${spec.rule.style} ${spec.rule.color}`;
  return css;
}
