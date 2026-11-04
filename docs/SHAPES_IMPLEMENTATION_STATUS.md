# Vector shapes — implementation status (work in progress)

This branch implements a first integrated **experimental** vector-shape subsystem.
It is **not** a production-complete implementation of the full acceptance matrix.

## Repository architecture checked
- The Writer browser client uses TypeScript in `src/client/`.
- `ops.py` is the authoritative undoable transaction layer; `session.py` validates SLDC.
- SLAI's `src/utils/sldc.py` v1.x permits inert namespaced extensions on blocks but does not recognize a native `shape` block.
- The editor already has figure selection, page overlay, picture editing, block moves and a ribbon.
- Existing PDF/DOCX exports are separate pipelines; this branch has **not** added vector shape support to them.

## Implemented in branch
- Ten shape kinds in a fixed declarative geometry registry.
- `slai.writer.shape` inert block extension with strict server validation.
- Undoable `shape_set` operation, with session-level SLDC validation.
- Insert tab containing Insert Picture and Insert Shape; shape gallery.
- Shape Format dialog: dimensions, rotation, fill, outline, independent opacity, corner radii, text, shadow layers.
- SVG editor painting with geometry-derived multiple shadow layers.
- Existing object selection, shape resize/rotation handles, drag-to-reorder blocks across page boundaries.
- Python validation and persistence tests added.

## Known limitations and release blockers
- **PDF and DOCX**: the new vector shape extension is not mapped into the export renderers. Output may omit shapes. This is a release blocker, not a successful export.
- **Shape text**: text is a shape-owned string, but not yet Writer rich-text runs; irregular-shape text containment, overflow indicators and accessibility require more work.
- **Geometry**: corner radii only for rectangles. Rounded paths and shadow spread require further rendering accuracy tests.
- **Interaction**: drag reorders an inline shape block; free floating positioning and cross-page floating anchors are not implemented. No auto-scroll during drag. Rotation/resize preview is not yet geometry-aware under arbitrary rotation.
- **Clipboard, groups, multi-select, wrapping, z-order**: not implemented for shape objects.
- **Security**: server-side `shape_set` validates the shape payload; additional document-import validation and resource limits need review.
- **Tests**: tests have been added but **not executed in a complete SLAI runtime**. TypeScript typecheck, browser interaction, PDF/DOCX regression and full repository test suite are pending.
- **UI**: the shape gallery uses labels rather than ten icon previews, and the advanced format dialog has not been visually inspected in the running desktop app.
- **SLDC interoperability**: the shape remains editable by this Writer extension, but other SLDC clients will only preserve inert data and must not claim to render it.

## Required next work
1. Verify TS compilation and Python tests in SLAI v2.4 workspace.
2. Correct all compiler/runtime failures.
3. Integrate vector PDF output and documented DOCX native/fallback mappings.
4. Add native rich-text editing, measured containment, and overflow policies.
5. Integrate shape anchoring/wrapping, cross-page auto-scroll, clipboard, and layering.
6. Complete visual and automated regression testing before marking the feature production-ready.

Suggested verification in the SLAI repository root:

```powershell
python -m pytest applications/slai_writer/tests/test_shapes.py -v
cd applications/slai_writer
npm.cmd run typecheck
npm.cmd run test:compiled
npm.cmd run build
```

Do not merge solely on the basis of the implementation files: the acceptance criteria remain partially unmet.
