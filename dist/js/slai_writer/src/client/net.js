/** Network layer: the shared JSON client plus the two things Writer needs that the kit does not have (raw uploads, POST downloads). */
import { ApiError, createClient, markerHeader, queryString } from "./kit.js";
export const SLUG = "writer";
const failureListeners = new Set();
/** Called for every failed request, including "can't reach the server". The shell uses it for the offline banner. */
export function onFailure(listener) { failureListeners.add(listener); return () => { failureListeners.delete(listener); }; }
export const api = createClient({ slug: SLUG, onError: (error) => { for (const l of [...failureListeners])
        l(error); } });
async function unwrap(response) {
    let parsed = null;
    try {
        parsed = (await response.json());
    }
    catch {
        parsed = null;
    }
    if (parsed && parsed.ok)
        return parsed.data;
    const e = parsed?.error;
    const failure = new ApiError(response.status, e?.code ?? "http_error", e?.message ?? `The server answered ${response.status}.`, e?.hint, e?.details);
    for (const l of [...failureListeners])
        l(failure);
    throw failure;
}
async function send(method, path, init) {
    try {
        return await fetch(path, { ...init, method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", [markerHeader(SLUG)]: "1", ...init.headers } });
    }
    catch (cause) {
        const failure = new ApiError(0, "offline", "Can't reach the local server.", "Check that SLAI Writer is still running, then try again.", String(cause));
        for (const l of [...failureListeners])
            l(failure);
        throw failure;
    }
}
/** Send a file's bytes as the request body (pictures, imports, merge copies, cursors). */
export async function rawPost(path, body, contentType, query) {
    const payload = body instanceof Uint8Array ? new Blob([body.slice().buffer]) : body;
    return unwrap(await send("POST", `/api${path}${queryString(query)}`, { body: payload, headers: { "Content-Type": contentType } }));
}
/** A conversion that returns a file: POST a JSON body, get a Blob back plus the server's conversion report. */
export async function postDownload(path, body) {
    const response = await send("POST", `/api${path}`, { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    if (!response.ok)
        return unwrap(response);
    const disposition = response.headers.get("Content-Disposition") ?? "";
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    let filename = "download";
    if (match?.[1]) {
        try {
            filename = decodeURIComponent(match[1]);
        }
        catch {
            filename = match[1];
        }
    }
    let report = null;
    const header = response.headers.get("X-Writer-Report");
    if (header) {
        try {
            report = JSON.parse(decodeURIComponent(header));
        }
        catch {
            report = null;
        }
    }
    return { blob: await response.blob(), filename, report };
}
export function errorText(error) {
    if (error instanceof ApiError)
        return error.friendly;
    return error instanceof Error ? error.message : "Something went wrong.";
}
export function assetUrl(sid, asset) { return `/api/docs/${encodeURIComponent(sid)}/assets/${encodeURIComponent(asset)}`; }
