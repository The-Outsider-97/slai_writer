/** The shapes the Writer server sends and receives. They mirror the SLDC document model (src/utils/sldc.py) and applications/slai_writer/routes_*.py. */

export type BlockType = "heading" | "paragraph" | "list_item" | "quote" | "code" | "table" | "figure" | "equation" | "embed";
export const TEXT_TYPES: readonly BlockType[] = ["heading", "paragraph", "list_item", "quote", "code"];
export const OBJECT_CHAR = "￼";

export interface EquationData { syntax: string; source: string; domain?: string; align?: string; numbered?: boolean }
export interface FigureCrop { left: number; top: number; right: number; bottom: number }
export interface FigurePlacement { mode: "floating"; anchor: "page" | "block"; target?: string; x_mm: number; y_mm: number; wrap?: "none" | "square" | "top_bottom"; layer?: "content" | "behind_text" | "in_front_of_text" }
export interface FigureData {
  asset: string; alt?: string; decorative?: boolean; width_mm?: number; height_mm?: number; align?: string; credit?: string; rights?: string;
  /** SLDC 1.1: the part of the picture that shows (0 to 1 of the original), turn in degrees (clockwise), mirrored, and where a picture that is not in line with the text sits. */
  crop?: FigureCrop; rotation_deg?: number; flip_horizontal?: boolean; flip_vertical?: boolean; placement?: FigurePlacement;
}
export interface Span {
  type: "format" | "link" | "style" | "ref" | "xref" | "equation" | "image";
  start: number; end: number;
  bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; superscript?: boolean; subscript?: boolean;
  color?: string; background?: string; font_family?: string; font_size_pt?: number;
  href?: string; style?: string; ref?: string; target?: string;
  equation?: EquationData; figure?: FigureData;
}
export interface Cell { text: string; colspan?: number; rowspan?: number }
export interface TableData { columns: number; header_rows?: number; rows: Cell[][] }
export interface Block {
  id: string; type: BlockType; text: string; spans?: Span[]; style?: string; section?: string;
  attributes?: { level?: number; ordered?: boolean; depth?: number; language?: string; [k: string]: unknown };
  table?: TableData; figure?: FigureData; equation?: EquationData; embed?: string;
}

export interface Margins { top: number; right: number; bottom: number; left: number }
export interface PageSetup { size?: string; orientation?: string; width_mm?: number; height_mm?: number; margins_mm?: Partial<Margins>; header_mm?: number; footer_mm?: number }
export interface HeaderFooter { left?: string; center?: string; right?: string }
export interface Section { id: string; page?: PageSetup; columns?: number; column_gap_mm?: number; numbering?: Record<string, unknown>; header?: HeaderFooter; footer?: HeaderFooter }
export interface Reference {
  id: string; kind: "citation" | "footnote"; title?: string; authors?: string[]; year?: number; doi?: string; url?: string; accessed?: string;
  container?: string; publisher?: string; volume?: string; issue?: string; pages?: string; note?: string; text?: string;
}
export interface EmbedDecl {
  id: string; kind: string; schema_version: number; params?: Record<string, unknown>; inputs?: Array<{ ref: string; sha256: string }>;
  output_sha256?: string; capabilities?: unknown; policy_ref?: string; redacted?: boolean;
}
export interface GuideSet { v?: number[]; h?: number[] }
export interface WriterExt {
  guides?: GuideSet; background?: { color?: string; asset?: string }; layers?: Array<{ id: string; name: string; visible: boolean; locked?: boolean; custom?: boolean }>;
  /** The layer a block is on when it is not the one its kind belongs to (text on Text, pictures on Illustrations). */
  layer_of?: Record<string, string>;
  view?: Record<string, unknown>; dictionary?: string[]; spell_ignore?: string[]; locks?: Record<string, { label?: string; summary?: string }>;
  source_status?: Record<string, { status: string; date: string; note?: string }>; signature_marks?: unknown;
}
export interface DocMeta {
  schema: string; id: string; title: string; language: string; metadata?: Record<string, unknown>;
  styles?: { paragraph?: Record<string, Record<string, unknown>>; character?: Record<string, Record<string, unknown>> };
  sections?: Section[]; references?: Reference[]; embeds?: EmbedDecl[]; extensions?: Record<string, unknown>;
  revision?: { number: number; created?: string }; history?: unknown[];
}
export interface CommentMessage { id: string; author: string; created: string; text: string }
export interface CommentThread {
  id: string; status: "open" | "resolved" | string; created: string; author: string; messages: CommentMessage[];
  anchor: { block: string; start?: number; end?: number }; anchorStatus?: string;
}
export interface Revision { number: number; created?: string | null; id: string; history: number }
export interface Stats { words: number; characters: number; blocks: number }
export interface Access { role: string; canEdit: boolean; readOnlyReason: string | null }
export interface AssetInfo { id: string; mediaType: string; bytes: number }

export interface DocSummary {
  sid: string; title: string; path: string | null; dirty: boolean; name: string; readOnly: boolean; signed: boolean; origin: Record<string, unknown> | null;
}
export interface DocState extends DocSummary {
  version: number; document: DocMeta; blocks: Block[]; assets: AssetInfo[]; comments: CommentThread[]; revision: Revision; stats: Stats;
  access: Access; undo: string | null; redo: string | null; notices: string[]; encrypted: boolean; signatures: number;
  savedAt: number | null; lastEdit: number | null; opened: number; alreadyOpen?: boolean; import?: Record<string, unknown>;
}
export interface Patch {
  version: number; result: Record<string, unknown>; blocks: Record<string, Block | null>; order?: string[]; document?: Partial<DocMeta>;
  dirty: boolean; stats: Stats; undo: string | null; redo: string | null; revision: Revision; signatures: number; notices: string[];
}

export type Op = { op: string; label?: string; [k: string]: unknown };

/* ------------------------------------------------------------------------------------------------ application */
export interface Prefs {
  theme: "system" | "light" | "dark" | "contrast"; scale: number; motion: "system" | "reduce"; autosave: boolean; autosave_seconds: number; language: string;
  page_size: string; orientation: string; units: "mm" | "in"; zoom: number; zoom_mode: "custom" | "height" | "width"; show_rulers: boolean; show_guides: boolean;
  spell: boolean; grammar: boolean; ai_enabled: boolean; ai_cloud: boolean; ai_notes: boolean; ai_budget: number; side_panel: boolean;
  cursor_default: string; cursor_drag: string; cursor_draw: string; cursor_text: string; last_folder: string; wizard_done: boolean; lookup_online: boolean;
}
export interface AccountPublic {
  id: string; username: string; email: string; plan: string; twoFactor: boolean; recoveryCodesLeft: number; created: string;
  mfaResetAt: string | null; planSource: string;
}
export interface PlanInfo {
  id: string; name: string; monthly: number; yearly: number; current: boolean; recommended?: boolean; per_seat?: boolean;
  local_documents: string; cloud_gb: number; hosted_credits: number; local_ai: string; collaboration: string; live_editors: number;
  embed_level: string; embed: string; workspace: string; support: string;
}
export interface PlansData { plans: PlanInfo[]; currency: string; vatNote: string; enforcement: string; yearlyDiscountPercent: number; studentDiscountPercent: number }
export interface Capabilities {
  sldc: boolean; documaster: { available: boolean; reason: string | null; version?: string };
  email: { configured: boolean; reason: string | null }; billing: { configured: boolean; reason: string | null };
  ai: AssistStatus; workspace: WorkspaceStatus; qr: { available: boolean; reason: string | null }; nativePicker: boolean;
  exportFormats: { export: ExportFormat[]; import: ImportFormat[] };
}
export interface AssistStatus {
  providers: Array<{ id: string; label: string; available: boolean | null; note: string }>; enabled: boolean; canUseAgents: boolean;
  spell: { available: boolean | null; note: string }; grammar: { available: boolean | null; note: string };
  tasks: Array<{ id: string; label: string }>; privacy: string;
}
export interface WorkspaceStatus { available: boolean; reason: string; offline: { shareCopy: boolean; mergeCopy: boolean; comments: boolean }; needs: string }
export interface ExportFormat { id: string; label: string; available: boolean; reason: string | null; lossy: string[] }
export interface ImportFormat { id: string; label: string; available: boolean; reason: string | null; note: string }
export interface Bootstrap {
  app: { name: string; version: string; slai: Record<string, unknown> }; prefs: Prefs; notices: Array<{ kind: string; text: string }>;
  capabilities: Capabilities; account: AccountPublic | null; profile: string; plan: string; plans: PlansData;
  storage: { dataDir: string; library: string }; open: DocSummary[]; now: string;
}
export interface HomeDoc {
  path: string; name: string; title: string; opened: string; size: number | null; revision: string | null; favorite: boolean;
  state: "saved" | "missing" | "unsaved" | "recovered"; folder: string | null; location: string; open: boolean; sid: string | null; legacy: boolean;
}
export interface HomeData {
  documents: HomeDoc[]; folders: Array<{ id: string; name: string; path: string }>; recovery: RecoveryItem[]; library: string;
}
export interface RecoveryItem { id: string; name: string; path: string | null; saved: number; encrypted: boolean; bytes: number }
export interface TemplateInfo { id: string; name: string; description: string; minPlan: string; available: boolean; toc: boolean }
export interface TemplateData {
  templates: TemplateInfo[]; pageSizes: string[]; orientations: string[]; plan: string; library: string;
  folders: Array<{ id: string; name: string; path: string }>; defaults: { page_size: string; orientation: string; language: string };
}
export interface VersionRow { id: string; created: string; kind: string; label: string; revision: number; bytes: number; words: number; signed: boolean; encrypted: boolean }
export interface SourceRow {
  id: string; kind: string; uses: number; data: Record<string, unknown>; status: string; statusLabel: string; statusDate?: string; inText: string; line: string; problems: string[];
}
export interface Match { block: string; where: string; start: number; end: number; snippet: string }
export interface OutlineItem { block: string; level: number; text: string }
export interface Problem { severity: "error" | "warn" | "info"; code: string; message: string; block: string | null }
export interface SigResult {
  id: string; key_id: string; algorithm: string; purpose: string; state: string; trust: string; signature_valid: boolean; covers_current_content: boolean;
  changed_parts: string[]; signed_revision_id: string; statement: string | null; problems: string[]; signerLabel?: string; signerFingerprint?: string;
  coveredBytes?: number; coveredParts?: number; signedAtClaimed?: string; timestampNote?: string; headline?: string;
}
export interface Mark { id: string; label: string; kind: string; group?: number; created?: string; image?: string; width?: number; height?: number; [k: string]: unknown }
