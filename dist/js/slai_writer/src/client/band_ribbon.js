import { h, toast } from "./kit.js";
import { errorText } from "./net.js";
import { defaultShape } from "./shape.js";
import { normalizeShapeCorners, readShapeNumber, shapeNumberInput, showShapeNumber } from "./shape_format.js";
import { beginShapePlacement } from "./shape_placement.js";
import { insertShape } from "./shape_ui.js";
import { drawTextBox } from "./textbox_ui.js";
import { textBoxOf, withParagraphs } from "./textbox.js";
export function buildBandRibbon(ctx, group, button) {
    const { ed } = ctx;
    const bands = ed.bands;
    const guard = (task) => { void Promise.resolve().then(task).catch((error) => toast(errorText(error), { kind: "error" })); };
    const number = (label, min, max, apply, step = 1) => {
        const node = shapeNumberInput(label, min, min, max, step);
        node.classList.add("band-number");
        node.addEventListener("change", () => {
            try {
                apply(readShapeNumber(node, min, max));
            }
            catch (error) {
                toast(errorText(error), { kind: "error" });
                update();
            }
        });
        return node;
    };
    const field = (label, node) => h("label", { class: "ribbon-field" }, h("span", { class: "ribbon-field-label", text: label }), node);
    const check = (label, apply) => {
        const input = h("input", { type: "checkbox" });
        input.addEventListener("change", () => apply(input.checked));
        return { el: h("label", { class: "check" }, input, h("span", { text: label })), input };
    };
    const percent = (raw) => Math.max(0, Math.min(1, raw / 100));
    /* ------------------------------------------------------------------------------------------------------------ what is edited */
    const status = h("span", { class: "band-status", attrs: { role: "status", "aria-live": "polite" } });
    const pages = h("span", { class: "band-pages" });
    const close = button("Close Header & Footer", () => bands.exit(), "close");
    close.classList.add("band-close");
    const first = check("Different first page", (on) => guard(() => bands.config({ first_page: on })));
    const oddEven = check("Different odd & even pages", (on) => guard(() => bands.oddEven(on)));
    const link = check("Link to previous section", (on) => guard(() => bands.config({ link: on })));
    const options = h("div", { class: "ribbon-options band-options" }, first.el, oddEven.el, link.el);
    /* --------------------------------------------------------------------------------------------------------------------- insert */
    const place = (kind, label, build) => button(label, () => {
        const template = build?.();
        beginShapePlacement(ctx, kind, { ...(template ? { template } : {}), label });
    }, kind === "line" ? "pen" : "layers");
    const rounded = () => { const s = defaultShape("rectangle"); s.width_mm = 40; s.height_mm = 10; s.corners_mm = [3, 3, 3, 3]; return s; };
    const insertGroup = group("Insert", button("Shape…", () => guard(() => insertShape(ctx)), "layers"), place("line", "Line"), place("rectangle", "Rectangle"), place("rectangle", "Rounded rectangle", rounded), place("ellipse", "Ellipse"), place("arrow", "Arrow"), button("Text Box", () => drawTextBox(ctx), "paragraph"));
    /* ---------------------------------------------------------------------------------------------------------------------- format */
    const fill = h("input", { type: "color", value: "#f1d24b", attrs: { "aria-label": "Fill colour" } });
    const outline = h("input", { type: "color", value: "#202020", attrs: { "aria-label": "Outline colour" } });
    fill.addEventListener("change", () => guard(() => bands.changeShape((s) => { s.fill.color = fill.value; s.fill.enabled = true; })));
    outline.addEventListener("change", () => guard(() => bands.changeShape((s) => { s.outline.color = outline.value; s.outline.enabled = true; })));
    const noFill = button("No fill", () => guard(() => bands.changeShape((s) => { s.fill.enabled = false; })), "close");
    const noOutline = button("No outline", () => guard(() => bands.changeShape((s) => { s.outline.enabled = false; })), "close");
    const width = number("Outline width (pt)", 0.1, 72, (v) => guard(() => bands.changeShape((s) => { s.outline.width_pt = v; })), 0.25);
    const opacity = number("Transparency: opacity %", 0, 100, (v) => guard(() => bands.changeShape((s) => { s.opacity = percent(v); })), 5);
    const corners = number("Corner radius (mm)", 0, 100, (v) => guard(() => bands.changeShape((s) => { s.corners_mm = normalizeShapeCorners([v, v, v, v], s.width_mm, s.height_mm); })), 0.5);
    const rotation = number("Rotation (°)", -360, 360, (v) => guard(() => bands.changeShape((s) => { s.rotation_deg = v; })), 1);
    const formatGroup = group("Format", fill, noFill, outline, noOutline, field("Outline (pt)", width), field("Opacity %", opacity), field("Corners (mm)", corners), field("Rotation °", rotation));
    const text = h("textarea", { rows: "2", attrs: { "aria-label": "Text in the shape", placeholder: "Text" } });
    text.classList.add("band-text");
    text.addEventListener("change", () => guard(() => bands.changeShape((s) => {
        const box = textBoxOf(s);
        if (box) {
            const base = box.paragraphs[0];
            const paragraphs = text.value.split("\n").map((line, i) => ({ ...(box.paragraphs[i] ?? base ?? { text: "" }), text: line, spans: [] }));
            const next = withParagraphs(s, paragraphs); // the plain-text mirror stays in step, as the server requires
            s.textbox = next.textbox;
            s.text = next.text;
        }
        else {
            s.text.content = text.value;
            s.text.spans = [];
        }
    }, "header or footer shape text")));
    const textSize = number("Text size (pt)", 4, 200, (v) => guard(() => bands.changeShape((s) => { s.text.font_size_pt = v; })), 1);
    const textGroup = group("Text", text, field("Size (pt)", textSize));
    /* ------------------------------------------------------------------------------------------------------------ size and position */
    const xBox = number("X: distance from the left margin (mm)", -1000, 3000, (v) => guard(() => bands.change({ x_mm: v })), 1);
    const yBox = number("Y (mm)", -1000, 3000, (v) => guard(() => bands.change({ y_mm: v })), 1);
    const wBox = number("Width (mm)", 2, 1000, (v) => guard(() => bands.changeShape((s) => { s.width_mm = v; s.corners_mm = normalizeShapeCorners(s.corners_mm, s.width_mm, s.height_mm); })), 1);
    const hBox = number("Height (mm)", 2, 1000, (v) => guard(() => bands.changeShape((s) => { s.height_mm = v; s.corners_mm = normalizeShapeCorners(s.corners_mm, s.width_mm, s.height_mm); })), 1);
    const yLabel = h("span", { class: "ribbon-field-label", text: "Y (mm)" });
    const span = check("Span the margins", (on) => guard(() => bands.change({ span: on }, "header or footer shape width")));
    const positionGroup = group("Size & Position", field("X (mm)", xBox), h("label", { class: "ribbon-field" }, yLabel, yBox), field("Width", wBox), field("Height", hBox), span.el);
    /* ----------------------------------------------------------------------------------------------------------------------- arrange */
    const layer = h("select", { attrs: { "aria-label": "Behind or in front of the text" } }, h("option", { value: "front", text: "In front of text" }), h("option", { value: "behind", text: "Behind text" }));
    layer.addEventListener("change", () => guard(() => bands.change({ layer: layer.value }, "header or footer shape layer")));
    const lock = button("Lock", () => guard(() => bands.change({ locked: !(bands.selected?.locked ?? false) }, "lock header or footer shape")), "shield");
    const arrangeGroup = group("Arrange", field("Layer", layer), button("Bring to front", () => guard(() => bands.order("front")), "bring-front"), button("Send to back", () => guard(() => bands.order("back")), "send-back"), button("Forward", () => guard(() => bands.order("forward")), "arrow-up"), button("Backward", () => guard(() => bands.order("backward")), "arrow-down"), lock, button("Duplicate", () => guard(() => bands.duplicate()), "page-plus"), button("Delete", () => guard(() => bands.remove()), "trash"));
    const el = h("div", { class: "format-ribbon references-ribbon band-ribbon", attrs: { role: "toolbar", "aria-label": "Header & Footer ribbon" } }, group("Header & Footer", h("span", { class: "band-where" }, status, pages), close), group("Options", options), insertGroup, formatGroup, textGroup, positionGroup, arrangeGroup);
    el.hidden = true;
    const idle = (node, on) => {
        if ("disabled" in node)
            node.disabled = !on;
        else
            node.toggleAttribute("aria-disabled", !on);
    };
    function update() {
        const t = bands.active;
        if (!t)
            return;
        status.textContent = bands.label();
        const used = bands.pagesUsing();
        pages.textContent = used.length ? `Shown on page${used.length > 1 ? "s" : ""} ${used.length > 8 ? `${used.slice(0, 8).join(", ")} … (${used.length})` : used.join(", ")}` : "Shown on no page yet";
        const o = bands.options();
        first.input.checked = o.first_page;
        oddEven.input.checked = o.odd_even;
        link.input.checked = o.linked;
        link.input.disabled = !o.canLink;
        link.input.title = o.canLink ? "Show the previous section's shapes in this header or footer" : "The first section has no previous section";
        yLabel.textContent = t.edge === "header" ? "Y (mm from top)" : "Y (mm from bottom)";
        const item = bands.selected;
        const on = Boolean(item) && !item?.locked;
        for (const node of [fill, outline, noFill, noOutline, width, opacity, corners, rotation, text, textSize, xBox, yBox, wBox, hBox, layer, span.input])
            idle(node, on);
        for (const node of el.querySelectorAll(".ribbon-action")) {
            const label = node.title;
            if (["Bring to front", "Send to back", "Forward", "Backward", "Duplicate", "Delete"].includes(label))
                node.disabled = !item || (item.locked && (label === "Delete"));
            if (label === "Lock" || label === "Unlock")
                node.disabled = !item;
        }
        if (!item)
            return;
        const s = item.shape;
        const set = (node, value) => { if (document.activeElement !== node)
            node.value = value; };
        set(fill, s.fill.color);
        set(outline, s.outline.color);
        set(width, showShapeNumber(s.outline.width_pt));
        set(opacity, showShapeNumber(Math.round(s.opacity * 100)));
        set(corners, showShapeNumber(s.corners_mm[0] ?? 0));
        set(rotation, showShapeNumber(s.rotation_deg));
        const box = textBoxOf(s);
        set(text, box ? box.paragraphs.map((p) => p.text).join("\n") : s.text.content);
        set(textSize, showShapeNumber(s.text.font_size_pt));
        corners.disabled = !on || s.kind !== "rectangle";
        text.disabled = !on || s.kind === "line";
        set(xBox, showShapeNumber(item.x_mm));
        set(yBox, showShapeNumber(item.y_mm));
        set(wBox, showShapeNumber(s.width_mm));
        set(hBox, showShapeNumber(s.height_mm));
        xBox.disabled = !on || item.span;
        wBox.disabled = !on || item.span;
        span.input.checked = item.span;
        set(layer, item.layer);
        const lockButton = el.querySelector(".ribbon-action[title='Lock'], .ribbon-action[title='Unlock']");
        if (lockButton) {
            lockButton.title = item.locked ? "Unlock" : "Lock";
            const label = lockButton.querySelector("span");
            if (label)
                label.textContent = item.locked ? "Unlock" : "Lock";
        }
    }
    bands.listen(() => update());
    return { el, update };
}
