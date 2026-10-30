/** The left Tools panel (design page 11): the other SLAI apps and the AI Assistant, then Plans & Pricing and Support. Other apps are listed
 *  honestly: Writer cannot start them from here, and says so rather than showing a button that does nothing. The same entries fill the
 *  icon rail that shows while the panel is collapsed. */
import type { DesignIcon } from "../dico.js";
import { h, openDialog } from "../kit.js";
import type { DocCtx } from "../docctx.js";
import { exportFlow } from "../fileops.js";
import { notice } from "../widgets.js";

export interface ToolEntry { id: string; label: string; icon: DesignIcon; state: string; run(): void }

interface Tool { id: string; label: string; icon: DesignIcon; note: (ctx: DocCtx) => { state: string; text: string } }

const TOOLS: Tool[] = [
  { id: "documaster", label: "Documaster", icon: "t-documaster", note: (c) => c.app.boot.capabilities.documaster.available
    ? { state: "Used by Writer", text: "Documaster is the converter Writer uses for importing Word and PDF files, exporting, and the print preview. It runs inside Writer; no separate window is needed." }
    : { state: "Not found", text: c.app.boot.capabilities.documaster.reason ?? "Documaster was not found, so importing, exporting to Word/PDF and print preview are unavailable. Writing and saving .sldc files are not affected." } },
  { id: "sreader", label: "SReader", icon: "t-reader", note: () => ({ state: "Not connected", text: "SReader is a separate SLAI app for reading documents. Writer cannot start it from here because this installation has no SLAI launcher. Export this document and open the file in SReader." }) },
  { id: "splanner", label: "SPlanner", icon: "t-planner", note: () => ({ state: "Not connected", text: "SPlanner is a separate SLAI app for planning. It is not part of this installation, so Writer cannot open it." }) },
  { id: "scical", label: "SciCal", icon: "t-scical", note: () => ({ state: "Not connected", text: "SciCal is a separate SLAI calculator. Writer cannot start it from here because this installation has no SLAI launcher." }) },
  { id: "secure", label: "Secure folder", icon: "t-secure", note: () => ({ state: "Unavailable", text: "There is no Secure folder app in this installation. To protect a document, use Export with a password (the file is encrypted) or keep it in a folder you already protect." }) },
];

export function toolEntries(ctx: DocCtx): ToolEntry[] {
  const { app } = ctx;
  const entries: ToolEntry[] = TOOLS.map((tool) => {
    const info = tool.note(ctx);
    return { id: tool.id, label: tool.label, icon: tool.icon, state: info.state, run: () => {
      const extra = tool.id === "documaster" && app.boot.capabilities.documaster.available ? [{ label: "Export this document…", run: () => { void exportFlow(app, ctx.sid); return true as const; } }] : [];
      void openDialog<true>({ title: tool.label, size: "narrow", body: h("div", { class: "stack" }, notice(info.text, info.state === "Used by Writer" ? "info" : "warn", info.state + ".")), actions: extra, cancelLabel: "Close" });
    } };
  });
  entries.push({ id: "ai", label: "AI Assistant", icon: "t-ai", state: app.prefs.ai_enabled ? "On" : "Off", run: () => ctx.ui.openPanel("red", "ai") });
  return entries;
}

export function footerEntries(ctx: DocCtx): ToolEntry[] {
  const { app } = ctx;
  return [
    { id: "plans", label: "Plans & Pricing", icon: "n-plans", state: "", run: () => app.go({ name: "plans" }) },
    { id: "help", label: "Support SLAI Writer", icon: "n-support", state: "", run: () => app.go({ name: "help" }) },
  ];
}
