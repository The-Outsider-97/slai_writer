"""Starting points for new documents. A template is a function that returns an ordinary SLDC package (styles, a section with page
setup and header/footer, and structure placeholders). Nothing in a template is invented content: the placeholders are empty
headings and prompts the author replaces. Which templates a person may use depends on the plan (``plans.yaml``); Blank is always free.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from ..tools.errors import BadRequest
from ..tools.validation import utc_now

PAGE_SIZES = ("A4", "A5", "A3", "B5", "Letter", "Legal")
ORIENTATIONS = ("portrait", "landscape")
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


@dataclass(frozen=True)
class Template:
    id: str
    name: str
    description: str
    min_plan: str                    # the lowest plan that includes it (guest, essential, creator, professional, workspace)
    headings: tuple[str, ...] = ()   # placeholder headings (used when accessible headings are on)
    footer: bool = True
    header: bool = False
    columns: int = 1
    title_block: bool = True
    cover: bool = False
    toc: bool = False


TEMPLATES: tuple[Template, ...] = (
    Template("blank", "Blank", "An empty page with the standard styles.", "guest", title_block=False, footer=False),
    Template("letter", "Letter", "A plain letter with a date line and sign-off.", "guest", headings=(), title_block=False, footer=False),
    Template("notes", "Meeting notes", "Agenda, notes and actions.", "guest", headings=("Agenda", "Notes", "Actions"), footer=True),
    Template("essay", "Essay", "Title, introduction, body and conclusion.", "essential",
             headings=("Introduction", "Argument", "Conclusion", "References"), header=True),
    Template("report", "Research report", "Abstract, method, results and references with running header and page numbers.", "creator",
             headings=("Abstract", "Introduction", "Method", "Results", "Discussion", "References"), header=True, toc=True),
    Template("illustrated", "Illustrated report", "A report with figure captions and a wider margin for illustrations.", "creator",
             headings=("Summary", "Background", "Findings", "Figures", "References"), header=True),
    Template("manuscript", "Manuscript", "A long-form manuscript: title page, chapters and a back matter section.", "creator",
             headings=("Chapter 1", "Chapter 2", "Chapter 3", "Acknowledgements"), header=True, cover=True),
    Template("thesis", "Thesis", "Front matter, chapters, bibliography and appendices with a table of contents.", "professional",
             headings=("Abstract", "Introduction", "Literature review", "Method", "Results", "Discussion", "Conclusion", "Bibliography", "Appendix"),
             header=True, toc=True, cover=True),
)
PLAN_ORDER = ("guest", "essential", "creator", "professional", "workspace")


def template(template_id: str) -> Template:
    for t in TEMPLATES:
        if t.id == template_id:
            return t
    raise BadRequest(f"There is no template '{template_id}'.")


def allowed_for(t: Template, plan: str, enforcement: bool) -> bool:
    if not enforcement:
        return True
    return PLAN_ORDER.index(plan if plan in PLAN_ORDER else "guest") >= PLAN_ORDER.index(t.min_plan)


def document_stem(name: str) -> str:
    """The file name without the maintained ``.sldc`` extension, or a message a person can act on."""
    stem = (name or "").strip()
    if stem.lower().endswith(".sldc"):
        stem = stem[:-5].rstrip()
    if not stem:
        raise BadRequest("Give the document a name.", hint="The .sldc extension is added for you.")
    if len(stem) > 120:
        raise BadRequest("That name is too long (at most 120 characters).")
    if _BAD_CHARS.search(stem):
        raise BadRequest('A name cannot contain any of < > : " / \\ | ? * or control characters.', hint="Use letters, digits, spaces, dashes or underscores.")
    if stem.endswith((".", " ")) or stem.split(".")[0].upper() in RESERVED:
        raise BadRequest("That name is reserved by Windows or ends with a dot. Choose another name.")
    return stem


def default_styles() -> dict[str, Any]:
    return {
        "paragraph": {
            "Body Text": {"font_family": "Times New Roman", "font_size_pt": 11, "line_height": 1.4, "space_after_pt": 6},
            "Title": {"based_on": "Body Text", "font_size_pt": 24, "bold": True, "align": "left", "space_after_pt": 12},
            "Subtitle": {"based_on": "Body Text", "font_size_pt": 14, "italic": True, "space_after_pt": 12},
            "Caption": {"based_on": "Body Text", "font_size_pt": 9, "italic": True, "space_before_pt": 3},
            "Block Quote": {"based_on": "Body Text", "italic": True, "indent_mm": 10},
        },
        "character": {"Emphasis": {"italic": True}, "Strong": {"bold": True}},
    }


def build(sldc: Any, template_id: str, *, title: str, page_size: str = "A4", orientation: str = "portrait", language: str = "en",
          accessible_headings: bool = True, author: str | None = None) -> Any:
    t = template(template_id)
    if page_size not in PAGE_SIZES:
        raise BadRequest(f"Page size must be one of {', '.join(PAGE_SIZES)}.")
    if orientation not in ORIENTATIONS:
        raise BadRequest("Orientation must be portrait or landscape.")
    margin = 25.0 if template_id != "illustrated" else 30.0
    section: dict[str, Any] = {"id": "s1", "page": {"size": page_size, "orientation": orientation,
                                                    "margins_mm": {"top": margin, "right": margin, "bottom": margin, "left": margin}}}
    if t.columns > 1:
        section["columns"] = t.columns
    if t.header:
        section["header"] = {"right": "{title}"}
    if t.footer:
        section["footer"] = {"left": "{title}", "right": "{page}"}
    blocks: list[dict[str, Any]] = []
    mk = sldc.make_block
    if t.title_block:
        blocks.append(mk("paragraph", title, style="Title", section="s1"))
        if t.cover:
            blocks.append(mk("paragraph", "", style="Subtitle", section="s1"))
    if template_id == "letter":
        blocks += [mk("paragraph", "", section="s1") for _ in range(3)]
    for heading in (t.headings if accessible_headings else ()):
        blocks.append(mk("heading", heading, attributes={"level": 1}, section="s1"))
        blocks.append(mk("paragraph", "", section="s1"))
    if not accessible_headings and t.headings:
        blocks.append(mk("paragraph", "", section="s1"))
    if not blocks:
        blocks.append(mk("paragraph", "", section="s1"))
    for b in blocks:
        b.setdefault("section", "s1")
    package = sldc.new_package(title, blocks, language=language, styles=default_styles(), sections=[section],
                               metadata={"template": template_id, "created_with": "SLAI Writer"})
    package.document["revision"] = {"number": 1, "parents": [], "created": utc_now().replace("+00:00", "Z") if "+" in utc_now() else utc_now(),
                                    **({"author": author} if author else {})}
    return package


def catalog(plan: str, enforcement: bool) -> list[dict[str, Any]]:
    return [{"id": t.id, "name": t.name, "description": t.description, "minPlan": t.min_plan, "available": allowed_for(t, plan, enforcement),
             "toc": t.toc} for t in TEMPLATES]
