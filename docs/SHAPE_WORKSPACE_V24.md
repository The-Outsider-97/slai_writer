# SLAI Writer v2.4 — Shape Workspace Development Notes

Updated: 2026-11-04. Branch: `feature/shape-workspace-v24`.
Companion Documaster branch: `feature/shape-interop-v24`.

## Important repository update

The earlier Writer PR #9 and Documaster PR #4 have **already been merged to
their respective main branches**. This work starts from the new main revisions
and is developed in Writer PR #11 and Documaster PR #5. It does not modify
Writer/Documaster main directly or mutate SLAI-v.2.4.

## User-facing UI

The screenshot identified two specific defects: a nearly full-screen,
vertically long Shape Format form with a horizontal scrollbar, and
unacceptably precise numbers such as `48,83661048689139`.

- `shape_format.ts` now separates number *presentation* from underlying
  document numeric values; supports Dutch comma/English dot, negative zero
  normalization, finite-range validation and keyboard stepping.
- `shape_ribbon.ts` replaces the small 7-group banner with an integrated
  contextual workspace exposing ten categories: Shape, Geometry, Fill,
  Outline, Corners, Shape Text, Effects, Position, Arrange and Group.
  These controls use the **same shape_set/batch operations** as the existing
  properties dialog; write operations are serialized to avoid stale updates.
- `shape_ui.ts` now presents a tabbed properties dialog with a clear six-page
  arrangement and validated, rounded numeric fields; the previous long
  vertical form and unnecessary horizontal scrolling are removed.
- `editor.css` contains scoped, responsive layout rules without changing
  Writer's global theme.
- `shape_text_edit.ts` adds direct double-click text editing inside the shape.
  Browser textarea selection and IME operate in an isolated editor surface;
  changes commit once through the existing operation queue; Escape cancels.
  Bold/italic/underline/strike/super/sub and color/highlight formatting
  produce SLDC-compatible character spans. This is **partial rich text
  parity**: links, full named styles, paragraph lists, complex bidi shaping,
  and other advanced editor features still need integration.

## Contour-aware text

- `shape_contour.ts` provides deterministic point/polygon geometry,
  half-open scanline intersections, interval clipping across line-height
  bands, and UTF-16-preserving line positions.
- The renderer maps text runs onto per-line bands of real shape silhouettes
  instead of one generic rectangular inset.
- Rounded rectangles use physical X/Y radius conversion, not a single
  stretched SVG radius; vector stroke widths use CSS points conversion.
- Text overflow is explicit; shrink-to-fit recomputes the layout with bounded
  scale attempts; invalid dimensions and non-finite glyph metrics are rejected.

This contour engine is **not** a general-purpose bidirectional typesetter.
Browser Canvas glyph measurements, text shaping, font fallback, anti-aliasing,
selection and screen-reader behavior still require end-to-end visual testing.

## Shape formatting and grouping

The contextual workspace directly supports changing geometry presets, object
size, rotation, fill/outline colors/opacity/style, independent corners, shape
text and fitting, shadow galleries and multi-layer effect properties, inline
vs floating positioning, top/bottom wrapping (the currently implemented
block-flow policy), layer stacking, z-index, alignment, distribution,
grouping and existing basic group scale/rotation.

Do not claim full live preview/cancel support for every numeric control. Text,
color and geometry changes commit on change; the existing pointer resize/rotate
paths still commit once per completed gesture.

## SLDC and compatibility

The canonical shape representation remains the version-1
`slai.writer.shape` extension stored in a dedicated empty paragraph block.
Shape text spans are derived from existing Writer spans, and the server now
accepts safe strike/super/sub, highlighting and letter/word-spacing fields
with bounded validation. No independent document store or undo engine was
introduced.

Native PDF and DOCX are delegated to Documaster. Unsupported effects use an
explicit high-resolution fallback and loss reporting; the DOCX importer in
the companion PR reconstructs supported editable WordprocessingShape presets.

## Validation

Added or extended:

- `tests_ts/shape_format.test.ts` — locale, precision and geometry edits.
- `tests_ts/shape_contour.test.ts` — all shape polygons, cross-sections,
  concavity, text bands and explicit overflow.
- `tests_ts/shape_text_edit.test.ts` — direct text span rebasing and Unicode.
- `tests_ts/shapes.test.ts` — physical corner radii.
- Documaster `tests_py/test_read_vector_shapes.py` — OOXML geometry and
  formatting reconstruction and unknown-geometry policies.

**No passing CI build is asserted.** GitHub Actions runs in both repositories
have terminated as failed without usable step logs; this also affected main
before these changes. Local SLAI Windows desktop and complete native-export
end-to-end verification were not available inside this execution environment.

Developer verification on the actual checkout:

```powershell
cd G:\GAIA\AI\SLAI\applications\slai_writer
npm.cmd install
npm.cmd run typecheck
npm.cmd run test:compiled
npm.cmd run build

cd G:\GAIA\AI\SLAI
py -3.12 -m pytest applications\slai_writer\tests -q
py -3.12 -m pytest applications\Documaster\tests_py\test_read_vector_shapes.py -v
```

## Outstanding release blockers

1. Resolve actual TypeScript/Python errors, if any; rerun on the real SLAI
   checkout and inspect all GitHub Actions failure diagnostics.
2. Implement true paragraph-line **square, tight and through wrapping**
   without corrupting the current flex/block pagination layout. These modes
   must NOT be advertised as implemented by this PR.
3. Complete cross-section/page anchor transformation policies, portrait and
   landscape movement, and stable recovery when an anchor is deleted.
4. Generalize group selection handles and arbitrary group affine transforms.
5. Verify full rich-text parity, complex typography and bidirectional
   scripts; current direct text editing is a native textarea with transferable
   character spans rather than a complete embedded Writer editor.
6. Establish measured SVG/PDF/DOCX visual regression metrics against real
   output, including font fallback, alpha masks, shadows and page placement.
7. Test Word DrawingML reimport in Word/LibreOffice and validate preservation
   beyond supported preset geometries; never claim lossless round-trip for
   unsupported effects.
8. Establish measured performance budgets and screen reader / keyboard
   accessibility evidence.

**Implementation ≠ verification.** Neither draft PR is release-ready until
the associated tests and practical UI/export checks pass.
