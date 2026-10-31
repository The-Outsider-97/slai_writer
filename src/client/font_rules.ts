/** SLDC-compatible paragraph font values; the catalogue augments these system-font suggestions at runtime. */
export const FONT_FAMILIES = ["Arial", "Calibri", "Cambria", "Georgia", "Helvetica", "Times New Roman", "Verdana", "Courier New"] as const;

/** Interpret a completed ribbon number edit: empty means inherit/reset, while
 *  invalid text is distinct from a valid zero (especially for tracking). */
export function parseRibbonNumber(raw: string, minimum: number, maximum: number): number | null | undefined {
  if (!raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

export function paragraphFontProps(styles: Record<string, unknown>, family: string, size: number): Record<string, unknown> {
  if (!family || family.length > 100 || /[\x00-\x1f\x7f{};<>\\"'`]/.test(family) || !Number.isFinite(size) || size < 4 || size > 400) {
    throw new RangeError("Font family must be a plain name and font size 4–400 pt.");
  }
  const resolved = { ...styles };
  delete resolved["based_on"];
  return { ...resolved, font_family: family, font_size_pt: size };
}
