import { api, errorText } from "../net.js";
import { needDoc } from "../fileops.js";
import { buildShell } from "../shell.js";
import { clear, confirmDialog, glyph, h, labelled, toast } from "../kit.js";
import { button, errorLine, notice, pickFile, run } from "../widgets.js";
export const VISUAL_WARNING = "A placed image alone does not create a cryptographic signature.";
/** Place a saved graphic into an open document as an ordinary, undoable edit. Returns the new document state. */
export async function placeMark(sid, markId, after, widthMm = 45) {
    const out = await api.post(`/docs/${encodeURIComponent(sid)}/signature-graphic`, { mark: markId, after, widthMm });
    return out.state;
}
function drawPad() {
    const canvas = h("canvas", { class: "draw-pad", width: 640, height: 220, attrs: { role: "img", "aria-label": "Signature drawing area. Draw with a pointer, finger or pen. To enter a signature without drawing, use Upload graphic." } });
    const ctx = canvas.getContext("2d");
    let drawing = false;
    let any = false;
    let last = null;
    const point = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) }; };
    if (ctx) {
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#111";
    }
    canvas.addEventListener("pointerdown", (e) => { drawing = true; last = point(e); canvas.setPointerCapture(e.pointerId); if (ctx && last) {
        ctx.beginPath();
        ctx.arc(last.x, last.y, 1.4, 0, Math.PI * 2);
        ctx.fill();
        any = true;
    } });
    canvas.addEventListener("pointermove", (e) => { if (!drawing || !ctx || !last)
        return; const p = point(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; any = true; });
    const stop = () => { drawing = false; last = null; };
    canvas.addEventListener("pointerup", stop);
    canvas.addEventListener("pointercancel", stop);
    return { el: canvas, dataUrl: () => canvas.toDataURL("image/png"), clear: () => { ctx?.clearRect(0, 0, canvas.width, canvas.height); any = false; }, empty: () => !any };
}
function readAsDataUrl(file) {
    return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error("The file could not be read.")); r.readAsDataURL(file); });
}
export async function signaturesScreen(app) {
    let data = await api.get("/signing/marks");
    const shell = buildShell(app, "signatures");
    const who = app.signedIn ? `your account (${app.account?.username})` : "the guest profile on this computer";
    const body = h("div", {});
    const savedHost = h("div", { class: "marks" });
    const error = errorLine();
    const label = h("input", { type: "text", maxLength: 60, value: "Personal document mark" });
    const group = h("select", {}, h("option", { value: "1", text: "Signature 1" }), h("option", { value: "2", text: "Signature 2" }));
    let mode = "draw";
    const pad = drawPad();
    let uploaded = null;
    const preview = h("div", { class: "upload-preview" });
    const tabs = h("div", { class: "seg", attrs: { role: "tablist", "aria-label": "Signature graphics" } });
    const panels = { draw: h("div", { class: "tab-panel", attrs: { role: "tabpanel" } }), upload: h("div", { class: "tab-panel", attrs: { role: "tabpanel" } }), saved: h("div", { class: "tab-panel", attrs: { role: "tabpanel" } }) };
    const save = async () => {
        error.show(null);
        const kind = mode === "draw" ? "draw" : "upload";
        let image;
        if (mode === "draw") {
            if (pad.empty()) {
                error.show("Draw your signature first.");
                return;
            }
            image = pad.dataUrl();
        }
        else {
            if (!uploaded) {
                error.show("Choose a PNG or JPEG picture first.");
                return;
            }
            image = uploaded.dataUrl;
        }
        try {
            await api.post("/signing/marks", { image, kind, label: label.value.trim() || "Signature", group: Number(group.value) });
            toast("Visual signature saved.", { kind: "ok" });
            pad.clear();
            uploaded = null;
            clear(preview);
            data = await api.get("/signing/marks");
            paintSaved();
        }
        catch (e) {
            error.show(errorText(e));
        }
    };
    const paintSaved = () => {
        clear(savedHost);
        const count = data.marks.length;
        savedHost.appendChild(h("p", { class: "muted", text: `${count} of ${data.limits.samples} pictures saved, in up to ${data.limits.distinct} different signatures.` }));
        if (!count) {
            savedHost.appendChild(h("p", { text: "Nothing saved yet. Draw or upload one." }));
            return;
        }
        const grid = h("div", { class: "mark-grid" });
        for (const m of data.marks) {
            const place = h("button", { class: "btn", type: "button" }, glyph("page-plus"), "Place graphic in current document");
            place.addEventListener("click", () => {
                void run(place, async () => {
                    const sid = await needDoc(app, "Place graphic");
                    if (!sid)
                        return;
                    await placeMark(sid, m.id, null);
                    toast(`Placed as a picture at the start of the document. ${VISUAL_WARNING}`, { kind: "ok", action: { label: "Open document", run: () => app.go({ name: "doc", sid }) } });
                });
            });
            const del = h("button", { class: "btn danger", type: "button" }, glyph("trash"), "Delete saved graphic");
            del.addEventListener("click", () => {
                void run(del, async () => {
                    if (!await confirmDialog({ title: "Delete this saved graphic?", message: "Copies already placed in documents stay where they are.", confirmLabel: "Delete", danger: true }))
                        return;
                    await api.del(`/signing/marks/${m.id}`);
                    data = await api.get("/signing/marks");
                    paintSaved();
                });
            });
            grid.appendChild(h("figure", { class: "mark" }, m.image ? h("img", { attrs: { src: m.image, alt: `Saved signature ${m.label}` } }) : h("span", { text: m.label }), h("figcaption", { text: `${m.label} · ${m.kind === "draw" ? "drawn" : "uploaded"} · signature ${m.group ?? 1}` }), h("div", { class: "actions" }, place, del)));
        }
        savedHost.appendChild(grid);
    };
    const show = (next) => {
        mode = next;
        for (const [key, el] of Object.entries(panels))
            el.hidden = key !== next;
        for (const b of tabs.querySelectorAll("button"))
            b.setAttribute("aria-selected", String(b.dataset["tab"] === next));
        if (next === "saved")
            paintSaved();
    };
    for (const [key, text] of [["draw", "Draw signature"], ["upload", "Upload graphic"], ["saved", "Choose saved"]]) {
        tabs.appendChild(h("button", { type: "button", class: "btn small", data: { tab: key }, attrs: { role: "tab", "aria-selected": String(key === mode) }, text, on: { click: () => show(key) } }));
    }
    panels.draw.append(pad.el, h("div", { class: "actions" }, button("Clear", () => { pad.clear(); })));
    panels.upload.append(h("p", { text: "Use a PNG or JPEG picture of your signature (up to 2 MiB). Writer checks the file type and size, and re-encodes it so no hidden data is kept. Nothing is uploaded anywhere: it stays on this computer." }), button("Choose a picture…", async () => {
        const [file] = await pickFile("image/png,image/jpeg");
        if (!file)
            return;
        if (file.size > 2 * 1024 * 1024) {
            error.show("That picture is larger than 2 MiB.");
            return;
        }
        error.show(null);
        uploaded = { dataUrl: await readAsDataUrl(file), name: file.name };
        clear(preview);
        preview.append(h("img", { attrs: { src: uploaded.dataUrl, alt: `Preview of ${file.name}` } }), h("p", { class: "muted", text: `${file.name} — check that it shows only your signature, then save it.` }));
    }, "", "upload"), preview);
    panels.saved.append(savedHost);
    body.append(h("h2", { class: "page-title", text: "Signature graphics" }), h("p", { class: "muted", text: "Optional visible marks for documents; not account credentials." }), notice(`Saved for ${who}. ${data.note}`, "info"), tabs, panels.draw, panels.upload, panels.saved, h("div", { class: "grid-2 saver" }, labelled("Saved signature label", label), labelled("Which signature", group, { hint: `Up to ${data.limits.distinct} different signatures; ${data.limits.samples} pictures in all.` })), error.el, h("div", { class: "actions" }, button("Save visual signature", save, "primary", "save")), notice(VISUAL_WARNING + " Cryptographic signing is a separate action on a frozen revision.", "warn"));
    shell.main.append(body);
    show("draw");
    return { el: shell.el, destroy: shell.dispose };
}
