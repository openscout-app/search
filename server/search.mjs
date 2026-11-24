import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pageCap, pageSize } from "../shared/pages.mjs";
import { defaultWindow, findWindow, windowChoices } from "../shared/windows.mjs";
import { scanRecent } from "./recent.mjs";

const exec = promisify(execFile);
export const harnesses = ["claude", "codex", "kimi"];
// The local index CLI returns at most 200 passages. Ask for its ceiling and
// report when it binds; the in-place scan has no such ceiling.
const indexHitCeiling = 200;

export class InputError extends Error {}

export function readScope(input) {
  const window = findWindow(input.window ?? defaultWindow);
  if (!window) throw new InputError(`Choose ${windowChoices()}.`);
  const harness = input.harness || "";
  if (harness && !harnesses.includes(harness)) throw new InputError("Choose Claude Code, Codex or Kimi.");
  return { window, harness };
}

export function readLimit(input) {
  const limit = input.limit == null ? pageSize : Number(input.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > pageCap) {
    throw new InputError(`Choose between 1 and ${pageCap} passages per page.`);
  }
  return limit;
}

function cursorPath(file) {
  const home = homedir();
  const rel = path.relative(home, file.path);
  if (rel && !rel.startsWith("..") && !rel.startsWith(path.sep)) return { root: "HOME", relPath: rel, mtimeMs: file.mtimeMs };
  return { root: "ABSOLUTE", relPath: file.path, mtimeMs: file.mtimeMs };
}

function absolutePath(at) {
  return at.root === "HOME" ? path.join(homedir(), at.relPath) : at.relPath;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(input, scope) {
  if (input.after == null || input.after === "") return null;
  let value;
  try {
    if (typeof input.after !== "string" || input.after.length > 2048) throw new Error();
    value = JSON.parse(Buffer.from(input.after, "base64url").toString("utf8"));
  } catch {
    throw new InputError("That page is not valid.");
  }
  const at = value?.at;
  if (value?.v !== 1 || (at?.root !== "HOME" && at?.root !== "ABSOLUTE")
    || typeof at?.relPath !== "string" || !at.relPath || !Number.isFinite(at?.mtimeMs)) {
    throw new InputError("That page is not valid.");
  }
  if (value.q !== scope.q || value.window !== scope.window || (value.harness || "") !== (scope.harness || "")) {
    throw new InputError("That page belongs to another search.");
  }
  return { path: absolutePath(at), mtimeMs: at.mtimeMs };
}

export function scoutBin() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  const root = path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json"));
  return path.join(root, "bin", "scout");
}

async function scoutJson(args, signal) {
  try {
    const { stdout } = await exec(scoutBin(), ["search", ...args, "--json"], {
      signal, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error("Scout could not read the local index. Run scout-search status in a terminal to check your installation.", { cause: error });
  }
}

export async function indexStatus(signal) {
  const value = await scoutJson(["status"], signal);
  return { enabled: value.enabled === true, collections: value.readyCollections, chunks: value.chunks,
    lastIndexedAt: value.warmSpans?.[0]?.completedAt ?? null, message: value.message };
}

function presentHit(hit) {
  const ref = hit.sourceRefs?.find((entry) => entry.kind === "harness_transcript");
  const coords = ref?.path;
  let source = null;
  if (coords?.relPath) {
    if (coords.root === "ABSOLUTE") source = coords.relPath;
    else source = (coords.root === "HOME" ? "~" : coords.root) + "/" + coords.relPath;
  }
  return {
    collection: hit.collectionId, title: hit.title, excerpt: hit.snippet,
    harness: ref?.harness ?? hit.facets.harness, project: hit.facets.project,
    session: ref?.sessionId ?? hit.facets.sessionId ?? null, source,
    records: ref?.recordRange ?? null, updatedAt: ref?.anchor?.mtimeMs ?? null,
  };
}

export async function search(input, signal) {
  const { window, harness } = readScope(input);
  const mode = input.mode ?? "recent";
  if (mode !== "recent" && mode !== "index") throw new InputError("Choose recent sessions or the local index.");
  const q = typeof input.q === "string" ? input.q.trim() : "";
  if (q.length > 300 || !q.split(/\s+/u).some((s) => s.length >= 2) || /[\x00-\x1f]/u.test(q)) {
    throw new InputError("Use at least one term of two characters and up to 300 characters in total.");
  }
  if (mode === "recent") {
    const limit = readLimit(input);
    const scope = { q, window: window.id, harness };
    const cursor = decodeCursor(input, scope);
    const scan = await scanRecent({ q, hours: window.hours, harness: harness || undefined, limit, cursor, signal });
    return { mode, q, window: window.id, limit, hits: scan.hits.map(presentHit), next: scan.next
      ? encodeCursor({ v: 1, ...scope, at: cursorPath(scan.next) })
      : null, coverage: {
      kind: "recent", window: window.id, scannedFiles: scan.scannedFiles, candidates: scan.candidates,
      partial: scan.truncated,
    } };
  }
  if (input.after != null && input.after !== "") throw new InputError("The local index cannot continue a page. Narrow the window instead.");
  // The indexed CLI treats dash-prefixed positional arguments as its own flags.
  if (q.startsWith("-")) throw new InputError("For a term beginning with a dash, use Recent sessions.");
  const result = await scoutJson(["query", q, "--hours", String(window.hours), "--limit", String(indexHitCeiling),
    ...(harness ? ["--harness", harness] : [])], signal);
  if (!Array.isArray(result.hits) || !result.coverage?.kind) throw new Error("Scout returned an unrecognized search result.");
  return { mode, q, window: window.id, limit: indexHitCeiling, hits: result.hits.map(presentHit), next: null, coverage: {
    ...result.coverage, partial: result.coverage.partial === true || result.hits.length >= indexHitCeiling,
  } };
}
