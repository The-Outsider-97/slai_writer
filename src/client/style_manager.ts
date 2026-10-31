/** One named-style editor. Style semantics, inheritance and validation live in SLDC. */
import { h, labelled, openDialog, toast } from "./kit.js";
import type { DocCtx } from "./docctx.js";
import { errorText } from "./net.js";
import { FRONT_MATTER_STYLES } from "./named_styles.js";
import { ensureBundledFont } from "./font_catalog.js";
import { checkbox, selectField } from "./widgets.js";

type Props = Record<string, unknown>;
const fields: Array<[string, string, string, number, number]> = [
  ["font_size_pt", "Font size (pt)", "0.5", 4, 400],
  ["line_height", "Line spacing", "0.05", 0.5, 5],
  ["space_before_pt", "Paragraph space before (pt)", "0.5", 0, 1000],
  ["space_after_pt", "Paragraph space after (pt)", "0.5", 0, 1000],
  ["letter_spacing_pt", "Letter spacing (pt)", "0.1", -5, 50],
  ["word_spacing_pt", "Word spacing (pt)", "0.1", -20, 100],
  ["indent_mm", "Left indent (mm)", "0.5", 0, 1000],
  ["first_line_indent_mm", "First-line indent (mm)", "0.5", -100, 1000],
];

/** Create, duplicate, rename, inherit, edit, reset and delete styles in existing document transactions. */
export async function manageStyles(ctx: DocCtx): Promise<void> {
  const { ed } = ctx;
  if (ed.readOnly) return;
  const kinds = selectField("Style category", [["paragraph", "Paragraph styles"], ["character", "Character styles"]], "paragraph");
  const existing = selectField("Edit style", [["", "Create new style"]], "");
  const name = h("input", { type: "text", maxLength: 64, attrs: { "aria-label": "Style name" } });
  const parent = selectField("Based on", [["", "Document defaults"]], "");
  const font = h("input", { type: "text", maxLength: 100, attrs: { "aria-label": "Font family", placeholder: "Inherit font family" } });
  const color = h("input", { type: "text", maxLength: 7, attrs: { "aria-label": "Font colour", placeholder: "Inherit colour or #rrggbb" } });
  const bold = selectField("Bold", [["", "Inherit"], ["true", "On"], ["false", "Off"]], "");
  const italic = selectField("Italic", [["", "Inherit"], ["true", "On"], ["false", "Off"]], "");
  const alignment = selectField("Alignment", [["", "Inherit"], ["left", "Left"], ["center", "Centre"], ["right", "Right"], ["justify", "Justified"]], "");
  const numbers = new Map<string, HTMLInputElement>();
  const numeric = fields.map(([key, label, step, min, max]) => {
    const input = h("input", { type: "number", step, min, max, attrs: { "aria-label": label, placeholder: "Inherit" } });
    numbers.set(key, input);
    return labelled(label, input);
  });
  const includeOriginal = checkbox("Duplicate the current properties when creating a copy", true);
  const group = (): Record<string, Props> => ed.model.meta.styles?.[kinds.select.value as "paragraph" | "character"] ?? {};
  const inherited = (): Props => group()[existing.select.value] ?? {};
  const populate = (): void => {
    const props = inherited();
    name.value = existing.select.value;
    parent.select.replaceChildren(...[["", "Document defaults"], ...Object.keys(group()).filter((x) => x !== existing.select.value).sort().map((x) => [x, x])]
      .map(([value, text]) => h("option", { value, text })));
    parent.select.value = String(props["based_on"] ?? "");
    font.value = String(props["font_family"] ?? "");
    color.value = String(props["color"] ?? "");
    bold.select.value = props["bold"] === undefined ? "" : String(props["bold"]);
    italic.select.value = props["italic"] === undefined ? "" : String(props["italic"]);
    alignment.select.value = String(props["align"] ?? "");
    for (const [key, input] of numbers) input.value = props[key] === undefined ? "" : String(props[key]);
    const character = kinds.select.value === "character";
    alignment.root.hidden = character;
    for (const key of ["line_height", "space_before_pt", "space_after_pt", "indent_mm", "first_line_indent_mm"]) {
      const input = numbers.get(key);
      if (input) input.parentElement!.hidden = character;
    }
  };
  const syncOptions = (): void => {
    const last = existing.select.value;
    existing.select.replaceChildren(h("option", { value: "", text: "Create new style" }),
      ...Object.keys(group()).sort().map((value) => h("option", { value, text: value })));
    existing.select.value = last && group()[last] ? last : "";
    populate();
  };
  kinds.select.addEventListener("change", syncOptions);
  existing.select.addEventListener("change", populate);
  syncOptions();

  const collect = (): Props => {
    const props: Props = { ...inherited() };
    const update = (key: string, input: string): void => { if (input.trim()) props[key] = input.trim(); else delete props[key]; };
    update("font_family", font.value);
    update("color", color.value);
    update("based_on", parent.select.value);
    for (const [key, input] of numbers) {
      if (kinds.select.value === "character" && ["line_height", "space_before_pt", "space_after_pt", "indent_mm", "first_line_indent_mm"].includes(key)) {
        delete props[key]; continue;
      }
      if (!input.value) { delete props[key]; continue; }
      const n = Number(input.value);
      if (!Number.isFinite(n)) throw new Error(`Invalid ${key}`);
      props[key] = n;
    }
    for (const [key, value] of [["bold", bold.select.value], ["italic", italic.select.value]] as Array<[string, string]>) {
      if (!value) delete props[key]; else props[key] = value === "true";
    }
    if (kinds.select.value === "paragraph") update("align", alignment.select.value);
    else delete props["align"];
    return props;
  };
  const apply = async (action: "save" | "duplicate" | "rename" | "reset" | "delete"): Promise<true | undefined> => {
    const source = existing.select.value;
    const chosen = name.value.trim();
    const kind = kinds.select.value;
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/.test(chosen) && action !== "delete" && action !== "reset") {
      toast("Choose a valid style name of up to 64 characters.", { kind: "error" }); return undefined;
    }
    try {
      if (action === "rename") {
        if (!source) throw new Error("Choose an existing style to rename.");
        await ed.op({ op: "style_rename", kind, name: source, new_name: chosen });
      } else if (action === "delete") {
        if (!source) throw new Error("Choose a style to delete.");
        await ed.op({ op: "style_define", kind, name: source, delete: true });
      } else {
        if (action === "duplicate" && (!source || source === chosen)) throw new Error("Enter a different name for the duplicate.");
        if (action === "save" && source && source !== chosen) throw new Error("Use Rename to change an existing style's name.");
        if (action === "reset" && !source) throw new Error("Choose an existing style to reset.");
        const target = action === "reset" ? source : chosen;
        if (action === "duplicate" && group()[target]) throw new Error("A style with this name already exists.");
        const props = action === "reset" ? { ...(FRONT_MATTER_STYLES[target] ?? {}) }
          : action === "duplicate" && !includeOriginal.input.checked ? {} : collect();
        await ed.op({ op: "style_define", kind, name: target, props });
        if (typeof props["font_family"] === "string") void ensureBundledFont(props["font_family"]).then(() => ed.layout()).catch(() => {});
      }
      toast(`Style ${action === "save" ? "saved" : action === "reset" ? "reset" : `${action}d`}.`, { kind: "ok" });
      return true;
    } catch (error) { toast(errorText(error), { kind: "error" }); return undefined; }
  };

  const handle = openDialog<true>({ title: "Manage named styles", size: "wide",
    body: h("div", { class: "stack" }, kinds.root, existing.root, labelled("Name / new name", name), parent.root,
      h("div", { class: "grid-2" }, labelled("Font family", font), labelled("Font colour (#rrggbb)", color)),
      h("div", { class: "grid-3" }, bold.root, italic.root, alignment.root),
      h("div", { class: "grid-3" }, ...numeric), includeOriginal.root),
    actions: [{ label: "Delete", run: () => apply("delete") }, { label: "Reset", run: () => apply("reset") },
      { label: "Rename", run: () => apply("rename") }, { label: "Duplicate", run: () => apply("duplicate") },
      { label: "Save style", kind: "primary", run: () => apply("save") }],
  });
  await handle.result;
}
