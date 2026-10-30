/** Network layer: the shared JSON client plus the two things Writer needs that the kit does not have (raw uploads, POST downloads). */
import { ApiError, createClient, markerHeader, queryString, type Query } from "./kit.js";

export const SLUG = "writer";

type Failure = (error: ApiError) => void;
const failureListeners = new Set<Failure>();
/** Called for every failed request, including "can't reach the server". The shell uses it for the offline banner. */
export function onFailure(listener: Failure): () => void { failureListeners.add(listener); return () => { failureListeners.delete(listener); }; }

export const api = createClient({ slug: SLUG, onError: (error) => { for (const l of [...failureListeners]) l(error); } });

interface Envelope<T> { ok: boolean; data?: T; error?: { code?: string; message?: string; hint?: string; details?: unknown } }

async function unwrap<T>(response: Response): Promise<T> {
  let parsed: Envelope<T> | null = null;
  try { parsed = (await response.json()) as Envelope<T>; } catch { parsed = null; }
  if (parsed && parsed.ok) return parsed.data as T;
  const e = parsed?.error;
  const failure = new ApiError(response.status, e?.code ?? "http_error", e?.message ?? `The server answered ${response.status}.`, e?.hint, e?.details);
  for (const l of [...failureListeners]) l(failure);
  throw failure;
}

async function send(method: string, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { ...init, method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", [markerHeader(SLUG)]: "1", ...(init.headers as Record<string, string> | undefined) } });
  } catch (cause) {
    const failure = new ApiError(0, "offline", "Can't reach the local server.", "Check that SLAI Writer is still running, then try again.", String(cause));
    for (const l of [...failureListeners]) l(failure);
    throw failure;
  }
}

/** Send a file's bytes as the request body (pictures, imports, merge copies, cursors). */
export async function rawPost<T>(path: string, body: Blob | ArrayBuffer | Uint8Array, contentType: string, query?: Query): Promise<T> {
  const payload: BodyInit = body instanceof Uint8Array ? new Blob([body.slice().buffer as ArrayBuffer]) : body;
  return unwrap<T>(await send("POST", `/api${path}${queryString(query)}`, { body: payload, headers: { "Content-Type": contentType } }));
}

export interface Downloaded { blob: Blob; filename: string; report: Record<string, unknown> | null }

/** A conversion that returns a file: POST a JSON body, get a Blob back plus the server's conversion report. */
export async function postDownload(path: string, body: unknown): Promise<Downloaded> {
  const response = await send("POST", `/api${path}`, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  if (!response.ok) return unwrap<never>(response);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  let filename = "download";
  if (match?.[1]) { try { filename = decodeURIComponent(match[1]); } catch { filename = match[1]; } }
  let report: Record<string, unknown> | null = null;
  const header = response.headers.get("X-Writer-Report");
  if (header) { try { report = JSON.parse(decodeURIComponent(header)) as Record<string, unknown>; } catch { report = null; } }
  return { blob: await response.blob(), filename, report };
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.friendly;
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function assetUrl(sid: string, asset: string): string { return `/api/docs/${encodeURIComponent(sid)}/assets/${encodeURIComponent(asset)}`; }
