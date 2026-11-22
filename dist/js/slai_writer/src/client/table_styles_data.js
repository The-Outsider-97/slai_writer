export const TABLE_STYLES = {
    "version": 1,
    "accent": "#2F5597",
    "order": [
        "plain",
        "simple_grid",
        "minimal_borders",
        "horizontal_rules",
        "header_emphasis",
        "alternating_rows",
        "alternating_columns",
        "professional_report",
        "academic",
        "financial",
        "modern_accent",
        "dark_header"
    ],
    "presets": {
        "plain": {
            "label": "Plain Table",
            "description": "No borders or shading.",
            "defaults": {
                "header_row": false,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {},
            "header": {},
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "simple_grid": {
            "label": "Simple Grid",
            "description": "Thin black lines around every cell.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                },
                "left": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                },
                "right": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                },
                "inside_v": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                }
            },
            "header": {
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "minimal_borders": {
            "label": "Minimal Borders",
            "description": "Light rules between rows, nothing else.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#D0D0D0"
                },
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "#7F7F7F"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#D0D0D0"
                }
            },
            "header": {
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "horizontal_rules": {
            "label": "Horizontal Rules",
            "description": "Rules above, below and between rows; no vertical lines.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 1.5,
                    "color": "#000000"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 1.5,
                    "color": "#000000"
                },
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "#000000"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                }
            },
            "header": {
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "header_emphasis": {
            "label": "Header Emphasis",
            "description": "A strong header row over a light grid.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "left": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "right": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "inside_v": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                }
            },
            "header": {
                "fill": "accent",
                "color": "#FFFFFF",
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "alternating_rows": {
            "label": "Alternating Row Colors",
            "description": "Every other row shaded.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": true,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent"
                },
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent"
                }
            },
            "header": {
                "bold": true,
                "color": "accent_dark"
            },
            "first_column": {},
            "band_rows": {
                "fill": "accent_light"
            },
            "band_columns": {}
        },
        "alternating_columns": {
            "label": "Alternating Column Colors",
            "description": "Every other column shaded.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": true
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent"
                },
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent"
                }
            },
            "header": {
                "bold": true,
                "color": "accent_dark"
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {
                "fill": "accent_light"
            }
        },
        "professional_report": {
            "label": "Professional Report",
            "description": "Dark header, banded rows and a firm outline.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": true,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent_dark"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent_dark"
                },
                "left": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent_dark"
                },
                "right": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "accent_dark"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#D9D9D9"
                }
            },
            "header": {
                "fill": "accent_dark",
                "color": "#FFFFFF",
                "bold": true
            },
            "first_column": {},
            "band_rows": {
                "fill": "#F2F2F2"
            },
            "band_columns": {}
        },
        "academic": {
            "label": "Academic Table",
            "description": "Three horizontal rules, no shading.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 1.5,
                    "color": "#000000"
                },
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 0.75,
                    "color": "#000000"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 1.5,
                    "color": "#000000"
                }
            },
            "header": {
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "financial": {
            "label": "Financial Table",
            "description": "Bold header, dotted row rules and a double closing rule.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "#000000"
                },
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 1,
                    "color": "#000000"
                },
                "inside_h": {
                    "style": "dotted",
                    "width_pt": 0.5,
                    "color": "#7F7F7F"
                },
                "bottom": {
                    "style": "double",
                    "width_pt": 1.5,
                    "color": "#000000"
                }
            },
            "header": {
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        },
        "modern_accent": {
            "label": "Modern Accent",
            "description": "Accent header text, a heavy accent rule and a tinted first column.",
            "defaults": {
                "header_row": true,
                "first_column": true,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "header_bottom": {
                    "style": "solid",
                    "width_pt": 2,
                    "color": "accent"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#E0E0E0"
                }
            },
            "header": {
                "bold": true,
                "color": "accent"
            },
            "first_column": {
                "bold": true,
                "color": "accent_dark",
                "fill": "accent_light"
            },
            "band_rows": {},
            "band_columns": {}
        },
        "dark_header": {
            "label": "Dark Header",
            "description": "Near-black header, light banding.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": true,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "left": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "right": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                },
                "inside_v": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#BFBFBF"
                }
            },
            "header": {
                "fill": "#1F1F1F",
                "color": "#FFFFFF",
                "bold": true
            },
            "first_column": {},
            "band_rows": {
                "fill": "#F2F2F2"
            },
            "band_columns": {}
        },
        "default": {
            "label": "Default",
            "description": "How tables looked before styles: a thin grey grid and a shaded header.",
            "defaults": {
                "header_row": true,
                "first_column": false,
                "banded_rows": false,
                "banded_columns": false
            },
            "borders": {
                "top": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#888888"
                },
                "bottom": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#888888"
                },
                "left": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#888888"
                },
                "right": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#888888"
                },
                "inside_h": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#888888"
                },
                "inside_v": {
                    "style": "solid",
                    "width_pt": 0.5,
                    "color": "#888888"
                }
            },
            "header": {
                "fill": "#EDEDED",
                "bold": true
            },
            "first_column": {},
            "band_rows": {},
            "band_columns": {}
        }
    }
};
