/** Shared set-up for the v2.4 browser tests: a real Writer server (own data folder, own port) and a real Chromium. Run after `npm run build`
 *  with NODE_PATH pointing at a folder that contains `playwright`. Nothing in the page is mocked unless a test says so (network interception). */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

export const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const root = resolve(app, "../..");
const require = createRequire(import.meta.url);
export const { chromium } = process.env.NODE_PATH ? require(join(process.env.NODE_PATH, "playwright")) : require("playwright");
export const shots = join(app, "tests_e2e", "failures");
mkdirSync(shots, { recursive: true });
export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export const ok = (c, m) => { if (!c) throw new Error(m); };
export const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
export const until = async (fn, label, ms = 8000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const v = await fn(); if (v) return v; last = v; } catch (e) { last = e; } await delay(100); } throw new Error(`timed out: ${label}${last instanceof Error ? ` (${last.message})` : ""}`); };
const freePort = () => new Promise((yes, no) => { const s = net.createServer(); s.on("error", no); s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => yes(a.port)); }); });

export async function startServer(tag = "v24") {
  const temp = mkdtempSync(join(tmpdir(), `writer-${tag}-`));
  const config = join(temp, "config.yaml");
  writeFileSync(config, readFileSync(join(app, "configs/config.yaml"), "utf8").replace('library_root: ""', `library_root: "${join(temp, "library").replaceAll("\\", "/")}"`));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn("python3", ["-m", "applications.slai_writer", "--data-dir", join(temp, "data"), "--port", String(port), "--token", tag, "--no-browser", "--config", config],
    { cwd: root, env: { ...process.env, PYTHONPATH: root }, stdio: ["ignore", "pipe", "pipe"] });
  const log = { text: "" };
  child.stdout.on("data", (b) => { log.text += b; }); child.stderr.on("data", (b) => { log.text += b; });
  for (let i = 0; i < 120; i++) { try { const r = await fetch(base + "/"); if (r.status < 500) break; } catch { /* not up yet */ } await delay(100); }
  return { base, token: tag, child, log, temp, stop: () => child.kill() };
}

/** A tiny runner: `scenario(name, fn)` records ok / FAIL, takes a screenshot of the failing page, and `finish()` prints the totals and sets the exit code. */
export function runner() {
  const results = [];
  const state = { page: null };
  return {
    state, results,
    async scenario(name, fn) {
      if (process.env.ONLY && !name.toLowerCase().includes(process.env.ONLY.toLowerCase())) return;   // ONLY=<words from the name> runs just that scenario
      const t = Date.now();
      try { await fn(); results.push({ name, ok: true }); console.log(`  ok    ${name} (${Date.now() - t} ms)`); }
      catch (error) {
        results.push({ name, ok: false, error: error.message });
        console.log(`  FAIL  ${name}\n        ${String(error.message).split("\n")[0]}`);
        try { await state.page?.screenshot({ path: join(shots, name.replace(/\W+/g, "_") + ".png") }); } catch { /* the page may be gone */ }
      }
    },
    finish(extra = () => {}) {
      const bad = results.filter((r) => !r.ok);
      console.log(`\n${results.length - bad.length} passed, ${bad.length} failed`);
      extra();
      process.exitCode = bad.length ? 1 : 0;
    },
  };
}
