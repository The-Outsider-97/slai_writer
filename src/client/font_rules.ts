/** SLDC-compatible paragraph font values; kept independent of UI and runtime dependencies. */
export const FONT_FAMILIES = ["Arial", "Calibri", "Cambria", "Georgia", "Helvetica", "Times New Roman", "Verdana", "Courier New"] as const;

export function paragraphFontProps(styles: Record<string, unknown>, family: string, size: number): Record<string, unknown> {
  if (!FONT_FAMILIES.some((f) => f === family) || !Number.isFinite(size) || size < 4 || size > 400) {
    throw new RangeError("Unsupported font family or size (4–400 pt).");
  }
  const resolved = { ...styles };
  delete resolved["based_on"];
  return { ...resolved, font_family: family, font_size_pt: size };
}
