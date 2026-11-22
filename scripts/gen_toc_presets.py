"""Compile toc_presets.py into src/client/toc_presets_data.ts (``--check`` only verifies that the file is current)."""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT.parent.parent))
TARGET = ROOT / "src" / "client" / "toc_presets_data.ts"


def render() -> str:
    from applications.slai_writer import toc_presets
    data = {"order": toc_presets.ORDER, "presets": {k: toc_presets.PRESETS[k] for k in toc_presets.ORDER}}
    body = json.dumps(data, indent=1, ensure_ascii=False)
    return ("/* Generated from toc_presets.py by scripts/gen_toc_presets.py: do not edit by hand. */\n"
            "export interface TocLevelLook { font_family?: string; font_size_pt?: number; bold?: boolean; italic?: boolean; small_caps?: boolean; color?: string; indent_mm?: number; space_before_pt?: number; space_after_pt?: number; line_height?: number; align?: string }\n"
            "export interface TocTitleLook { font_family?: string; font_size_pt?: number; bold?: boolean; italic?: boolean; small_caps?: boolean; color?: string; align?: string; space_after_pt?: number; space_before_pt?: number }\n"
            "export interface TocPreset { name: string; description: string; core: string; leader: \"dots\" | \"dashes\" | \"solid\" | \"none\"; page_align: \"right\" | \"inline\" | \"left\"; numbered: boolean; title: TocTitleLook | null; levels: TocLevelLook[] | null }\n"
            f"export const TOC_PRESETS: {{ order: string[]; presets: Record<string, TocPreset> }} = {body};\n")


if __name__ == "__main__":
    text = render()
    if "--check" in sys.argv:
        sys.exit(0 if TARGET.exists() and TARGET.read_text(encoding="utf-8") == text else 1)
    TARGET.write_text(text, encoding="utf-8", newline="\n")
    print("wrote", TARGET)
