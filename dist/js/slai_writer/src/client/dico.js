/** Writer's editor icons. They are the pictures drawn in the design (SLAI Writer (main), pages 9–14), cut out once and stored in this
 *  application's assets folder. Each is shown through a CSS mask, so it takes the colour of the text around it and follows the light and
 *  dark appearances; the green pen is a plain picture. Thin arrows and chevrons are drawn as SVG strokes. */
import { h, s } from "./kit.js";
/** A masked icon (`span.dico.i-<name>`); the size comes from the font size or from CSS. */
export function dico(name, label) {
    return h("span", { class: `dico i-${name}`, attrs: label ? { role: "img", "aria-label": label } : { "aria-hidden": "true" } });
}
/** A thin chevron like the ones in the design (page tabs, rail arrows, drop-downs). */
export function chevron(direction, cls = "") {
    const points = { left: "14,3 6,12 14,21", right: "10,3 18,12 10,21", up: "3,15 12,7 21,15", down: "3,9 12,17 21,9" };
    const svg = s("svg", { class: `chev ${cls}`.trim(), attrs: { viewBox: "0 0 24 24", width: 16, height: 16, "aria-hidden": "true", focusable: "false" } });
    svg.appendChild(s("polyline", { attrs: { points: points[direction], fill: "none", "stroke": "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" } }));
    return svg;
}
/** The cross that replaces the sandwich while the menu is open. */
export function crossIcon() {
    const svg = s("svg", { class: "cross", attrs: { viewBox: "0 0 24 24", width: 22, height: 22, "aria-hidden": "true", focusable: "false" } });
    svg.appendChild(s("path", { attrs: { d: "M3 3L21 21M21 3L3 21", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round" } }));
    return svg;
}
/** The two faces of the light/dark switch's knob: the 8-point star (light) and the crescent (dark). Both stay in the knob and cross-fade, so the switch can animate. */
export function toggleKnob(face) {
    const svg = s("svg", { class: `knob ${face}`, attrs: { viewBox: "0 0 24 24", width: 18, height: 18, "aria-hidden": "true", focusable: "false" } });
    if (face === "dark")
        svg.appendChild(s("path", { attrs: { d: "M15.5 4.2a8 8 0 1 0 4.3 11.4A6.6 6.6 0 0 1 15.5 4.2z", fill: "currentColor" } }));
    else {
        const star = Array.from({ length: 16 }, (_, i) => { const r = i % 2 === 0 ? 10 : 2.6; const a = (Math.PI * i) / 8 - Math.PI / 2; return `${(12 + r * Math.cos(a)).toFixed(2)},${(12 + r * Math.sin(a)).toFixed(2)}`; }).join(" ");
        svg.appendChild(s("polygon", { attrs: { points: star, fill: "currentColor" } }));
    }
    return svg;
}
