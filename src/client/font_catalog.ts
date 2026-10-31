/** Shared Python font catalogue exposed through Writer's same-origin read-only API. */
import { api } from "./net.js";

interface Face { id: string; family: string; weight: number; italic: boolean; format: string; axes: Array<{ tag: string; min: number; max: number }> }
interface FontCatalogue { families: string[]; faces: Face[] }

let catalogue: Promise<FontCatalogue> | undefined;
const loaded = new Set<string>();

export function bundledFonts(): Promise<FontCatalogue> {
  if (!catalogue) catalogue = api.get<FontCatalogue>("/fonts").catch((err: unknown) => { catalogue = undefined; throw err; });
  return catalogue;
}

/** Load the requested family only, preserving installed/system families as fallbacks. */
export async function ensureBundledFont(family: string): Promise<void> {
  const info = await bundledFonts();
  const matches = info.faces.filter((f) => f.family === family);
  if (!matches.length) return; // A normal system font; the browser owns substitution.
  const staticFaces = matches.filter((f) => f.axes.length === 0);
  const files = staticFaces.length ? staticFaces : matches;
  const tasks = files.filter((f) => !loaded.has(f.id)).map(async (face) => {
    const variableWeight = face.axes.find((a) => a.tag === "wght");
    const descriptors: FontFaceDescriptors = {
      style: face.italic ? "italic" : "normal",
      weight: variableWeight ? `${variableWeight.min} ${variableWeight.max}` : String(face.weight),
      display: "swap",
    };
    const entry = new FontFace(family, `url("/api/fonts/${face.id}") format("${face.format}")`, descriptors);
    await entry.load();
    document.fonts.add(entry);
    loaded.add(face.id);
  });
  await Promise.all(tasks);
}
