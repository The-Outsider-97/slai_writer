# SLAI Writer v2.4 — Vector Shapes Integration and Verification Status

Updated: 2026-11-04

This document records source-backed implementation work and its limitations.
It deliberately distinguishes **committed source code** from features that
have been **executed and verified** in the full SLAI desktop runtime.

## Source of truth and associated changes

- Writer core: `The-Outsider-97/slai_writer`, branch
  `feature/writer-shapes-p1-completion`, draft pull request **#9**.
- DOCX/PDF native exporters: `The-Outsider-97/Documaster`, branch
  `feature/writer-native-vector-shapes`, draft pull request **#4**.
- Shared document serialization: SLAI `SLAI-v.2.4`,
  `src/utils/sldc.py`. No changes to this core SLDC module.

The earlier Writer proof of concept was merged in Writer PR #8.
Do not treat PR #9 or Documaster PR #4 as release-ready until build,
runtime and compatibility verification is green.

## Architecture

The existing SLDC 1.x block schema does not have a native vector-shape
block kind. Writer therefore uses a **dedicated empty paragraph block** with
a versioned, data-only `extensions["slai.writer.shape"]` object. This lets
other SLDC implementations retain the extension rather than silently deleting
the object; they must not claim to render it without support.

Each shape owns geometry, fill, outline, object opacity, rich text runs,
multiple shadows, layout, z-order and optional group identity.

- `shape_validation.py`: strict numeric, color, span, placement and group
  validation, including safe imported-document behavior.
- `ops.py`: shape creation and modification use existing
  `block_insert`, `shape_set`, `move` and `batch` transaction semantics.
- `session.py`: shape data and text contribute to session state/statistics;
  malformed shape-bearing documents become read-only without dropping data.
- `src/client/shape.ts`: fixed, extensible vector geometry registry, SVG
  drawing, editable text-run rendering, conservative internal text boxes and
  overflow indication.
- `src/client/shape_ui.ts`: gallery, contextual properties, selection-range
  character formatting, layer controls, grouping and duplication.
- `src/client/shape_placement.ts`: cancellable click/drag insertion.
- `src/client/shapetools.ts`: resize, rotation, movement, page auto-scroll,
  anchored floating movement, keyboard position nudging and group movement.
- `src/client/input.ts`: shape clipboard, Shift-click selection and contextual
  selection handling.
- `export.py`: export and print-preview integration with installed Documaster
  and correct source-preserving fallback logic.
- `shape_export.py`: resource-bounded visual conversion for unsupported
  foreign-format features; preserves source SLDC shape editability.
- Documaster `slai/docmodel/writers/vector_shapes.py`: ReportLab vector
  paths/text; WordprocessingShape DrawingML when representable.

## Current feature evidence

| Feature | Code implementation | Verified in desktop runtime |
| --- | --- | --- |
| Ten vector shape presets | Implemented | Not yet |
| Shape insertion gallery + click/drag/Escape | Implemented | Not yet |
| Shape-owned text and rich formatting spans | Implemented | Not yet |
| Shape text inset regions + overflow cue | Implemented conservatively | Not yet |
| Text fitting | Implemented as shrink/keep | Not yet |
| Move/resize/rotation/keyboard nudging | Implemented | Not yet |
| Move across pages + auto-scroll | Implemented for documented cases | Not yet |
| Floating block/page association | Implemented via anchor metadata | Not yet |
| Top-and-bottom text wrapping | Implemented at block-flow granularity | Not yet |
| True square/tight text wrapping in Writer | **Not completed** | No |
| Copy/cut/paste/duplicate shapes | Implemented | Not yet |
| Shift multiselect and group identity | Implemented | Not yet |
| Composite group rotation/resize | **Not completed** | No |
| Z-order and layer control | Implemented; visual audit pending | Not yet |
| SLDC source round-trip | Test coverage added | Not yet |
| PDF native vector path text | Implemented in companion Documaster PR | Not yet |
| DOCX native editable Word shapes | Implemented in companion Documaster PR | Not yet |
| Raster fallback for unsupported effects | Implemented with explicit reporting | Not yet |
| Editable DOCX shape **reimport** | **Not completed** | No |

### Rich text boundaries

Writer shapes now store formatting spans in the same basic range format as
the document text system, and reuse text-segmentation code. This is **not**
yet a universal rich-text engine: list structure, hyperlinks, paragraph
styles, arbitrary nested formatting, and editor-wide range selection are
not all available inside a shape. The shape-format editor supports bold,
italic, underline, color, font size and basic fitting.

The irregular-shape inset region is deliberately conservative, not a
per-scanline polygon layout algorithm. Overflow is displayed in the editor
and should be reviewed rather than silently truncated.

### Positioning boundaries

A floating shape can be moved to an adjacent or distant page by crossing a
page boundary, with auto-scroll and one atomic server transaction when a
drop target is available. Block-linked anchors survive basic block moves,
but cross-section semantics, sophisticated page-relative anchoring, tight
wrapping and reflow under arbitrary paragraph edits require further work.

Top/bottom wrapping participates in normal **block-level** pagination;
it is not line-level contour wrapping. Square/tight wrapping is not
available as a misleading control in Writer's UI.

Grouping currently assigns a shared identity, selects members together,
and moves them together; it does **not** perform a general affine
group transform on all members with independently maintained local origins.

## Format preservation matrix

| Format | Writer state | Native external representation | Known limitations |
| --- | --- | --- | --- |
| SLDC 1.x | Source native vector extension, remains editable | Data-only namespaced extension | External readers may retain but not render |
| PDF with companion Documaster | Vector geometry and text when supported | Native ReportLab paths and searchable text | Certain opacity, blur, spread and complex-run cases use a disclosed PNG fallback; line-level wrap unsupported |
| DOCX with companion Documaster | Word geometry/text native when supported | `wps:wsp` / WordprocessingShape DrawingML | Complex multi-shadow/corner/opacity/shrink cases use a disclosed PNG fallback; editable reimport not proven |
| PDF/DOCX with older Documaster | Visual fallback | High-resolution PNG image with descriptive alt text | Not semantically editable in the external format |
| ODT/RTF/HTML | Visual fallback | PNG illustration where supported | No native shape editability claimed |
| Plain text/Markdown/XML | Text-only loss-reporting fallback | Shape label/description | Vector geometry is lost |

Do **not** describe current external-format round trips as lossless.
The native PDF and DOCX changes live in **separate draft pull requests**,
so standard Writer installations continue to take the explicit fallback
until the companion converter is installed.

## Automated verification and commands

A new Writer `.github/workflows/shape-integration.yml` checks out actual
SLAI v2.4 + Writer + Documaster source, then attempts TypeScript typecheck,
compiled tests, browser build, and shape/export Python regression tests.
Documaster has a companion workflow for native shape writer tests.

As of this document update, GitHub Actions runs were seen in **queued**
state and previous runs failed with no available step logs. **No passed
tests are asserted.** Full functionality, visual fidelity and regression
safety remain unverified.

Local Windows verification (with the actual v2.4 checkout and Documaster):

```powershell
cd G:\GAIA\AI\SLAI
py -3.12 -m pytest applications\slai_writer\tests\test_shapes.py -v
py -3.12 -m pytest applications\slai_writer\tests\test_shape_export.py -v
py -3.12 -m pytest applications\slai_writer\tests -q
cd applications\slai_writer
npm.cmd install
npm.cmd run typecheck
npm.cmd run test:compiled
npm.cmd run build
```

Companion Documaster:

```powershell
cd G:\GAIA\AI\SLAI
py -3.12 -m pytest applications\Documaster\tests_py\test_vector_shapes.py -v
```

The final release gate also requires driving the actual application UI,
producing and reopening test documents, inspecting PDF and DOCX at multiple
page boundaries and zoom levels, confirming clipboard behavior in Chromium,
verifying undo/redo and pagination, and testing a document with hundreds of
shapes and long rich text.

## Remaining blockers

1. Verify and repair all TypeScript and Python compilation/test failures.
2. Validate WordprocessingShape export in real Microsoft Word/LibreOffice,
   including compatibility with native shape import and editor round trips.
3. Complete real line-level square/tight wrapping and reliable cross-section
   placement while preserving Writer's existing pagination architecture.
4. Complete compound group transforms and true group bounding boxes.
5. Validate exact text glyph metrics and opacity compositing between
   editor SVG, PDF vectors and raster fallbacks.
6. Test accessible keyboard interactions, hit testing, high zoom, and
   shadows/overlap across page boundaries.
7. Resolve any GitHub Actions runner availability/permission problems;
   publish measured green tests rather than relying on code inspection.

No mandatory acceptance criterion should be marked verified until the
corresponding test and end-to-end evidence exists.
