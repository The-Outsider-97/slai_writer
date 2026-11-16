"""Compile table_styles.json into src/client/table_styles_data.ts (run from anywhere; ``--check`` only verifies that the file is current)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "src" / "client" / "table_styles_data.ts"


def render() -> str:
    data = json.loads((ROOT / "table_styles.json").read_text(encoding="utf-8"))
    body = json.dumps(data, indent=1, ensure_ascii=False)
    return ("/* Generated from table_styles.json by scripts/gen_table_styles.py: do not edit by hand. */\n"
            "export interface BorderRule { style: \"solid\" | \"dashed\" | \"dotted\" | \"double\"; width_pt: number; color: string }\n"
            "export interface Role { fill?: string | null; color?: string | null; bold?: boolean }\n"
            "export interface Preset {\n  label: string; description: string;\n  defaults: { header_row: boolean; first_column: boolean; banded_rows: boolean; banded_columns: boolean };\n"
            "  borders: Partial<Record<\"top\" | \"bottom\" | \"left\" | \"right\" | \"inside_h\" | \"inside_v\" | \"header_bottom\", BorderRule>>;\n"
            "  header: Role; first_column: Role; band_rows: Role; band_columns: Role;\n}\n"
            f"export const TABLE_STYLES: {{ version: number; accent: string; order: string[]; presets: Record<string, Preset> }} = {body};\n")


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv:
        sys.exit(0 if TARGET.exists() and TARGET.read_text(encoding="utf-8") == text else 1)
    TARGET.write_text(text, encoding="utf-8", newline="\n")
    print("wrote", TARGET)
