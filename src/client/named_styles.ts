/** Default appearance for semantic front-matter styles; documents can override these definitions. */
export const FRONT_MATTER_STYLES: Record<string, Record<string, string | number | boolean>> = {
  Title: { font_family: "EB Garamond", font_size_pt: 30, bold: true, align: "center", line_height: 1.15, space_after_pt: 14 },
  Subtitle: { font_family: "Charis SIL", font_size_pt: 18, align: "center", line_height: 1.3, space_after_pt: 10 },
  Slogan: { font_family: "Cormorant Garamond", font_size_pt: 15, italic: true, align: "center", letter_spacing_pt: 0.4, space_after_pt: 8 },
  Author: { font_family: "Cantarell", font_size_pt: 12, align: "center", space_after_pt: 6 },
  "Document Date": { font_family: "Cantarell", font_size_pt: 11, align: "center", space_after_pt: 6 },
  "TOC Title": { font_family: "EB Garamond", font_size_pt: 20, bold: true, space_after_pt: 12 },
};
