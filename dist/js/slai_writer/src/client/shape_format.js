export function showShapeNumber(value, digits = 2, locale = "en-US") {
    if (!Number.isFinite(value))
        return "";
    const n = Number(value.toFixed(Math.max(0, Math.min(5, digits))));
    const result = Object.is(n, -0) ? "0" : String(n);
    return /^nl(?:-|$)/i.test(locale) ? result.replace(".", ",") : result;
}
export function parseShapeNumber(text, min, max) {
    const normalized = text.trim().replace(/\u00a0/g, " ").replace(",", ".");
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized))
        return null;
    const n = Number(normalized);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
export function readShapeNumber(input, min, max) {
    const n = parseShapeNumber(input.value, min, max);
    if (n === null) {
        input.setCustomValidity(`Enter a value between ${min} and ${max}.`);
        input.reportValidity();
        throw Error(`Enter a value between ${min} and ${max}.`);
    }
    input.setCustomValidity("");
    return n;
}
export function shapeNumberInput(label, value, min, max, step = .5, digits = 2) {
    const node = document.createElement("input");
    const locale = typeof navigator !== "undefined" ? navigator.language : "en-US";
    node.type = "text";
    node.inputMode = "decimal";
    node.value = showShapeNumber(value, digits, locale);
    node.setAttribute("aria-label", label);
    node.setAttribute("title", `${label} (${min}–${max})`);
    node.dataset["min"] = String(min);
    node.dataset["max"] = String(max);
    node.dataset["step"] = String(step);
    node.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown")
            return;
        event.preventDefault();
        const now = parseShapeNumber(node.value, min, max) ?? value;
        const amount = step * (event.shiftKey ? 10 : event.altKey ? 0.1 : 1);
        node.value = showShapeNumber(Math.max(min, Math.min(max, now + (event.key === "ArrowUp" ? amount : -amount))), digits, locale);
        node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    node.addEventListener("blur", () => {
        const n = parseShapeNumber(node.value, min, max);
        if (n !== null)
            node.value = showShapeNumber(n, digits, locale);
    });
    return node;
}
/** Only round/truncate a value at display time; do not put the display string into SLDC. */
export function shapePrecision(value, digits = 2) {
    return showShapeNumber(value, digits);
}
export function normalizeShapeCorners(input, w, h) {
    const radii = Array.from({ length: 4 }, (_, i) => Math.min(w / 2, h / 2, Math.max(0, input[i] ?? 0)));
    const factor = Math.min(1, w / Math.max(1e-12, radii[0] + radii[1]), w / Math.max(1e-12, radii[3] + radii[2]), h / Math.max(1e-12, radii[0] + radii[3]), h / Math.max(1e-12, radii[1] + radii[2]));
    return radii.map(x => x * factor);
}
export function resizeShape(shape, width, height, lockRatio = false) {
    if (!Number.isFinite(width) || !Number.isFinite(height))
        throw Error("Invalid shape dimensions");
    const ratio = shape.width_mm / shape.height_mm;
    const w = Math.max(2, Math.min(1000, width));
    const h = lockRatio ? Math.max(2, Math.min(1000, w / ratio)) : Math.max(2, Math.min(1000, height));
    return { ...shape, width_mm: w, height_mm: h, corners_mm: normalizeShapeCorners(shape.corners_mm, w, h),
        text: { ...shape.text, padding_mm: Math.min(shape.text.padding_mm, w / 4, h / 4) } };
}
export function changeShapeKind(shape, kind) {
    return { ...shape, kind, corners_mm: kind === "rectangle" ? normalizeShapeCorners(shape.corners_mm, shape.width_mm, shape.height_mm) : [0, 0, 0, 0] };
}
export const shadowPreset = (kind) => {
    switch (kind) {
        case "soft": return { enabled: true, color: "#303030", opacity: .35, offset_x_mm: 2, offset_y_mm: 3, blur_mm: 4, spread_mm: 0 };
        case "hard": return { enabled: true, color: "#303030", opacity: .55, offset_x_mm: 4, offset_y_mm: 4, blur_mm: 0, spread_mm: 0 };
        case "bottom": return { enabled: true, color: "#000000", opacity: .3, offset_x_mm: 0, offset_y_mm: 5, blur_mm: 5, spread_mm: 0 };
        case "glow": return { enabled: true, color: "#437ac8", opacity: .4, offset_x_mm: 0, offset_y_mm: 0, blur_mm: 5, spread_mm: 2 };
    }
};
