/* Generated from toc_presets.py by scripts/gen_toc_presets.py: do not edit by hand. */
export interface TocLevelLook { font_family?: string; font_size_pt?: number; bold?: boolean; italic?: boolean; small_caps?: boolean; color?: string; indent_mm?: number; space_before_pt?: number; space_after_pt?: number; line_height?: number }
export interface TocTitleLook { font_family?: string; font_size_pt?: number; bold?: boolean; italic?: boolean; small_caps?: boolean; color?: string; align?: string; space_after_pt?: number; space_before_pt?: number }
export interface TocPreset { name: string; description: string; core: string; leader: "dots" | "dashes" | "solid" | "none"; page_align: "right" | "inline" | "left"; numbered: boolean; title: TocTitleLook | null; levels: TocLevelLook[] | null }
export const TOC_PRESETS: { order: string[]; presets: Record<string, TocPreset> } = {
 "order": [
  "classic",
  "modern",
  "minimalist",
  "academic",
  "professional",
  "formal",
  "compact",
  "elegant",
  "technical",
  "book",
  "outline",
  "custom"
 ],
 "presets": {
  "classic": {
   "name": "Classic",
   "description": "Serif type, bold chapters, dotted leaders to the page number.",
   "core": "standard",
   "leader": "dots",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Times New Roman",
    "font_size_pt": 18,
    "align": "left",
    "space_after_pt": 12,
    "bold": true
   },
   "levels": [
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 0,
     "space_before_pt": 4,
     "space_after_pt": 3,
     "bold": true
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 11.5,
     "indent_mm": 6,
     "space_before_pt": 0,
     "space_after_pt": 3
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 11,
     "indent_mm": 12,
     "space_before_pt": 0,
     "space_after_pt": 3,
     "italic": true
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 11,
     "indent_mm": 18,
     "space_before_pt": 0,
     "space_after_pt": 3,
     "italic": true
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 11,
     "indent_mm": 24,
     "space_before_pt": 0,
     "space_after_pt": 3,
     "italic": true
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 11,
     "indent_mm": 30,
     "space_before_pt": 0,
     "space_after_pt": 3,
     "italic": true
    }
   ]
  },
  "modern": {
   "name": "Modern",
   "description": "Sans-serif with an accent colour for chapters; no leaders, page numbers on the right.",
   "core": "standard",
   "leader": "none",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Arial",
    "font_size_pt": 22,
    "align": "left",
    "space_after_pt": 14,
    "bold": true,
    "color": "#1f4e79"
   },
   "levels": [
    {
     "font_family": "Arial",
     "font_size_pt": 11,
     "indent_mm": 0,
     "space_before_pt": 8,
     "space_after_pt": 3,
     "bold": true,
     "color": "#1f4e79"
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10.5,
     "indent_mm": 6,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 12,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 18,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 24,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 30,
     "space_before_pt": 2,
     "space_after_pt": 3
    }
   ]
  },
  "minimalist": {
   "name": "Minimalist",
   "description": "Small, quiet type in grey; nothing but the entries and their pages.",
   "core": "compact",
   "leader": "none",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Arial",
    "font_size_pt": 14,
    "align": "left",
    "space_after_pt": 10,
    "color": "#444444"
   },
   "levels": [
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 0,
     "space_before_pt": 3,
     "space_after_pt": 2,
     "color": "#222222"
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 4,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "color": "#555555"
    },
    {
     "font_family": "Arial",
     "font_size_pt": 9.5,
     "indent_mm": 8,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "color": "#555555"
    },
    {
     "font_family": "Arial",
     "font_size_pt": 9.5,
     "indent_mm": 12,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "color": "#555555"
    },
    {
     "font_family": "Arial",
     "font_size_pt": 9.5,
     "indent_mm": 16,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "color": "#555555"
    },
    {
     "font_family": "Arial",
     "font_size_pt": 9.5,
     "indent_mm": 20,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "color": "#555555"
    }
   ]
  },
  "academic": {
   "name": "Academic",
   "description": "Centred title, 12 pt serif, dotted leaders: for theses and papers.",
   "core": "academic",
   "leader": "dots",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Times New Roman",
    "font_size_pt": 16,
    "align": "center",
    "space_after_pt": 14,
    "bold": true
   },
   "levels": [
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 0,
     "space_before_pt": 5,
     "space_after_pt": 4,
     "bold": true,
     "line_height": 1.3
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 7,
     "space_before_pt": 0,
     "space_after_pt": 4,
     "line_height": 1.3
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 14,
     "space_before_pt": 0,
     "space_after_pt": 4,
     "italic": true,
     "line_height": 1.3
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 21,
     "space_before_pt": 0,
     "space_after_pt": 4,
     "italic": true,
     "line_height": 1.3
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 28,
     "space_before_pt": 0,
     "space_after_pt": 4,
     "italic": true,
     "line_height": 1.3
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 35,
     "space_before_pt": 0,
     "space_after_pt": 4,
     "italic": true,
     "line_height": 1.3
    }
   ]
  },
  "professional": {
   "name": "Professional Report",
   "description": "Georgia with small-capital chapters and a bold title: for business reports.",
   "core": "standard",
   "leader": "dots",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Georgia",
    "font_size_pt": 20,
    "align": "left",
    "space_after_pt": 14,
    "bold": true,
    "color": "#222222"
   },
   "levels": [
    {
     "font_family": "Georgia",
     "font_size_pt": 11.5,
     "indent_mm": 0,
     "space_before_pt": 8,
     "space_after_pt": 3,
     "bold": true,
     "small_caps": true
    },
    {
     "font_family": "Georgia",
     "font_size_pt": 11,
     "indent_mm": 6,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Georgia",
     "font_size_pt": 10.5,
     "indent_mm": 12,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Georgia",
     "font_size_pt": 10.5,
     "indent_mm": 18,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Georgia",
     "font_size_pt": 10.5,
     "indent_mm": 24,
     "space_before_pt": 2,
     "space_after_pt": 3
    },
    {
     "font_family": "Georgia",
     "font_size_pt": 10.5,
     "indent_mm": 30,
     "space_before_pt": 2,
     "space_after_pt": 3
    }
   ]
  },
  "formal": {
   "name": "Formal",
   "description": "Centred small-capital title, ruled leaders, generous spacing: for official documents.",
   "core": "academic",
   "leader": "solid",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Times New Roman",
    "font_size_pt": 16,
    "align": "center",
    "space_after_pt": 16,
    "bold": true,
    "small_caps": true
   },
   "levels": [
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 0,
     "space_before_pt": 8,
     "space_after_pt": 5,
     "bold": true,
     "small_caps": true
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 8,
     "space_before_pt": 3,
     "space_after_pt": 5
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 16,
     "space_before_pt": 3,
     "space_after_pt": 5
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 24,
     "space_before_pt": 3,
     "space_after_pt": 5
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 32,
     "space_before_pt": 3,
     "space_after_pt": 5
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 40,
     "space_before_pt": 3,
     "space_after_pt": 5
    }
   ]
  },
  "compact": {
   "name": "Compact",
   "description": "Small type with no space between entries: the most entries per page.",
   "core": "compact",
   "leader": "dots",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Arial",
    "font_size_pt": 12,
    "align": "left",
    "space_after_pt": 6,
    "bold": true
   },
   "levels": [
    {
     "font_family": "Arial",
     "font_size_pt": 9,
     "indent_mm": 0,
     "space_before_pt": 0,
     "space_after_pt": 0,
     "bold": true
    },
    {
     "font_family": "Arial",
     "font_size_pt": 9,
     "indent_mm": 3,
     "space_before_pt": 0,
     "space_after_pt": 0
    },
    {
     "font_family": "Arial",
     "font_size_pt": 8.5,
     "indent_mm": 6,
     "space_before_pt": 0,
     "space_after_pt": 0
    },
    {
     "font_family": "Arial",
     "font_size_pt": 8.5,
     "indent_mm": 9,
     "space_before_pt": 0,
     "space_after_pt": 0
    },
    {
     "font_family": "Arial",
     "font_size_pt": 8.5,
     "indent_mm": 12,
     "space_before_pt": 0,
     "space_after_pt": 0
    },
    {
     "font_family": "Arial",
     "font_size_pt": 8.5,
     "indent_mm": 15,
     "space_before_pt": 0,
     "space_after_pt": 0
    }
   ]
  },
  "elegant": {
   "name": "Elegant",
   "description": "EB Garamond italic title, dashed leaders, airy spacing.",
   "core": "standard",
   "leader": "dashes",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "EB Garamond",
    "font_size_pt": 24,
    "align": "center",
    "space_after_pt": 18,
    "italic": true
   },
   "levels": [
    {
     "font_family": "EB Garamond",
     "font_size_pt": 13,
     "indent_mm": 0,
     "space_before_pt": 8,
     "space_after_pt": 3,
     "italic": true
    },
    {
     "font_family": "EB Garamond",
     "font_size_pt": 12,
     "indent_mm": 7,
     "space_before_pt": 3,
     "space_after_pt": 3
    },
    {
     "font_family": "EB Garamond",
     "font_size_pt": 12,
     "indent_mm": 14,
     "space_before_pt": 3,
     "space_after_pt": 3
    },
    {
     "font_family": "EB Garamond",
     "font_size_pt": 12,
     "indent_mm": 21,
     "space_before_pt": 3,
     "space_after_pt": 3
    },
    {
     "font_family": "EB Garamond",
     "font_size_pt": 12,
     "indent_mm": 28,
     "space_before_pt": 3,
     "space_after_pt": 3
    },
    {
     "font_family": "EB Garamond",
     "font_size_pt": 12,
     "indent_mm": 35,
     "space_before_pt": 3,
     "space_after_pt": 3
    }
   ]
  },
  "technical": {
   "name": "Technical Documentation",
   "description": "Numbered sections (1, 1.1, 1.1.1), dashed leaders, tight spacing.",
   "core": "compact",
   "leader": "dashes",
   "page_align": "right",
   "numbered": true,
   "title": {
    "font_family": "Arial",
    "font_size_pt": 16,
    "align": "left",
    "space_after_pt": 10,
    "bold": true
   },
   "levels": [
    {
     "font_family": "Arial",
     "font_size_pt": 10.5,
     "indent_mm": 0,
     "space_before_pt": 4,
     "space_after_pt": 1,
     "bold": true
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 6,
     "space_before_pt": 0,
     "space_after_pt": 1
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 12,
     "space_before_pt": 0,
     "space_after_pt": 1
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 18,
     "space_before_pt": 0,
     "space_after_pt": 1
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 24,
     "space_before_pt": 0,
     "space_after_pt": 1
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 30,
     "space_before_pt": 0,
     "space_after_pt": 1
    }
   ]
  },
  "book": {
   "name": "Book / Manuscript",
   "description": "Chapters set plain, sections indented, page numbers on the right.",
   "core": "academic",
   "leader": "dots",
   "page_align": "right",
   "numbered": false,
   "title": {
    "font_family": "Times New Roman",
    "font_size_pt": 20,
    "align": "center",
    "space_after_pt": 20
   },
   "levels": [
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 0,
     "space_before_pt": 8,
     "space_after_pt": 2,
     "line_height": 1.35
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 10,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "line_height": 1.35
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 20,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "italic": true,
     "line_height": 1.35
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 30,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "italic": true,
     "line_height": 1.35
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 40,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "italic": true,
     "line_height": 1.35
    },
    {
     "font_family": "Times New Roman",
     "font_size_pt": 12,
     "indent_mm": 50,
     "space_before_pt": 0,
     "space_after_pt": 2,
     "italic": true,
     "line_height": 1.35
    }
   ]
  },
  "outline": {
   "name": "Numbered Outline",
   "description": "Every entry numbered like an outline; the page number follows the title.",
   "core": "standard",
   "leader": "none",
   "page_align": "inline",
   "numbered": true,
   "title": {
    "font_family": "Arial",
    "font_size_pt": 16,
    "align": "left",
    "space_after_pt": 10,
    "bold": true
   },
   "levels": [
    {
     "font_family": "Arial",
     "font_size_pt": 11,
     "indent_mm": 0,
     "space_before_pt": 5,
     "space_after_pt": 2,
     "bold": true
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10.5,
     "indent_mm": 8,
     "space_before_pt": 1,
     "space_after_pt": 2
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 16,
     "space_before_pt": 1,
     "space_after_pt": 2
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 24,
     "space_before_pt": 1,
     "space_after_pt": 2
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 32,
     "space_before_pt": 1,
     "space_after_pt": 2
    },
    {
     "font_family": "Arial",
     "font_size_pt": 10,
     "indent_mm": 40,
     "space_before_pt": 1,
     "space_after_pt": 2
    }
   ]
  },
  "custom": {
   "name": "Custom",
   "description": "Your own settings: change the options and the formatting of each level.",
   "core": "standard",
   "leader": "dots",
   "page_align": "right",
   "numbered": false,
   "title": null,
   "levels": null
  }
 }
};
