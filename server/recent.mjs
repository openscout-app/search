import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { open, opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";

// Transcripts are read in place: no index, no runtime. The window is the only
// scope. A query that matches a mountain of text still stops at the passage
// guard so the server cannot be pushed out of memory; the response says so.
const MATCH_CHARS = 8 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const RG_BATCH = 200;

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function flatten(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(" ");
  const object = recordValue(value);
  if (!object) return "";
  if (typeof object.text === "string") return object.text;
  if (typeof object.content === "string") return object.content;
  if (object.content) return flatten(object.content);
  return "";
}

function trimOneLine(value, max) {
  const flat = value.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}

function oneLineInput(input) {
  return trimOneLine(typeof input === "string" ? input : compactJson(input ?? {}), 120);
}

// Harness scaffolding is not what a person remembers reading.
function stripHarnessBoilerplate(text) {
  return text
    .replace(/<(recommended_plugins|local-command-caveat|system-reminder|system_reminder)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, "")
    .trim();
}

function stableId(value, length = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function isTranscriptFile(harness, name) {
  return harness === "kimi" ? name === "wire.jsonl" : name.endsWith(".jsonl");
}

function sessionRoots(harness) {
  const home = homedir();
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join(home, ".kimi-code");
  const roots = [
    { harness: "codex", root: process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ?? join(home, ".codex", "sessions") },
    { harness: "codex", root: join(home, ".openai-codex", "sessions") },
    { harness: "claude", root: process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT ?? join(home, ".claude", "projects") },
    { harness: "kimi", root: process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ?? join(kimiHome, "sessions") },
  ];
  return roots.filter((entry) => existsSync(entry.root) && (!harness || entry.harness === harness));
}

async function discoverFiles(cutoffMs, harness, signal) {
  const files = [];
  for (const { harness: name, root } of sessionRoots(harness)) {
    const stack = [root];
    const visited = new Set();
    while (stack.length) {
      signal?.throwIfAborted();
      const directory = stack.pop();
      let info;
      try {
        info = await stat(directory);
      } catch {
        continue;
      }
      const identity = `${info.dev}:${info.ino}`;
      if (visited.has(identity)) continue;
      visited.add(identity);
      let entries;
      try {
        entries = await opendir(directory);
      } catch {
        continue;
      }
      for await (const entry of entries) {
        signal?.throwIfAborted();
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (!isTranscriptFile(name, entry.name)) continue;
        let file;
        try {
          file = await stat(path);
        } catch {
          continue;
        }
        if (file.isDirectory()) {
          stack.push(path);
          continue;
        }
        if (file.mtimeMs < cutoffMs) continue;
        files.push({ harness: name, path, mtimeMs: file.mtimeMs, size: file.size });
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs
    || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function resumeIndex(files, at) {
  if (!at) return 0;
  const index = files.findIndex((file) => file.path === at.path && file.mtimeMs === at.mtimeMs);
  if (index >= 0) return index + 1;
  const next = files.findIndex((file) => file.mtimeMs < at.mtimeMs
    || (file.mtimeMs === at.mtimeMs && file.path > at.path));
  return next >= 0 ? next : files.length;
}

function findRipgrep() {
  const override = process.env.OPENSCOUT_RG_PATH;
  if (override === "none") return null;
  if (override) return existsSync(override) ? override : null;
  const candidates = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"];
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir) candidates.push(join(dir, "rg"));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

// Only human turns, tool calls and tool results carry a passage. Session
// metadata, system records and reasoning summaries are skipped.
function recordText(raw, harness) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const object = recordValue(value);
  if (!object) return null;
  const text = harness === "claude" ? claudeText(object) : harness === "kimi" ? kimiText(object) : codexText(object);
  return text && text.trim() ? text : null;
}

function codexText(object) {
  const type = String(object.type ?? "");
  if (type === "session_meta" || type === "turn_context") return null;
  if (type === "event_msg") {
    const payload = recordValue(object.payload) ?? {};
    if (payload.type === "user_message") return String(payload.message ?? payload.text ?? "");
    if (payload.type === "agent_message") return String(payload.message ?? payload.text ?? "");
    return null;
  }
  if (type === "response_item" || type === "message" || type === "reasoning" || type === "function_call" ||
    type === "local_shell_call" || type === "function_call_output" || type === "local_shell_call_output") {
    return codexPayloadText(recordValue(object.payload) ?? object, type);
  }
  return null;
}

function codexPayloadText(payload, fallback) {
  const type = String(payload.type ?? "") || fallback;
  if (type === "message") return flatten(payload.content);
  if (type === "reasoning") {
    if (Array.isArray(payload.summary)) return payload.summary.map((entry) => recordValue(entry)?.text).filter(Boolean).join(" ");
    return stringValue(payload.content) ?? "";
  }
  if (type === "function_call" || type === "local_shell_call") {
    return `name=${payload.name ?? payload.command ?? "tool"} input=${oneLineInput(payload.arguments ?? payload.args ?? payload.input ?? {})}`;
  }
  if (type === "function_call_output" || type === "local_shell_call_output") {
    return trimOneLine(typeof payload.output === "string" ? payload.output : flatten(payload.output ?? payload.content), 180);
  }
  return null;
}

function claudeText(object) {
  const type = String(object.type ?? "");
  const message = recordValue(object.message);
  if (type === "user") return flatten(message?.content ?? object.content);
  if (type === "assistant") {
    const content = message?.content ?? object.content;
    const tool = Array.isArray(content) ? content.map(recordValue).find((entry) => entry?.type === "tool_use") : null;
    if (tool) return `name=${tool.name ?? "tool"} input=${oneLineInput(tool.input ?? {})}`;
    return flatten(content);
  }
  if (type === "tool_use") return `name=${object.name ?? "tool"} input=${oneLineInput(object.input ?? {})}`;
  if (type === "tool_result") return trimOneLine(typeof object.content === "string" ? object.content : flatten(object.content), 180);
  return null;
}

function kimiText(object) {
  const type = String(object.type ?? "");
  if (type === "turn.prompt" || type === "turn.steer") return flatten(object.input ?? object.content);
  if (type === "context.append_message") return flatten(recordValue(object.message)?.content);
  if (type !== "context.append_loop_event") return null;
  const event = recordValue(object.event) ?? {};
  if (event.type === "tool.call") return `name=${event.name ?? "tool"} input=${oneLineInput(event.args ?? event.input ?? {})}`;
  if (event.type === "tool.result") {
    const result = recordValue(event.result) ?? {};
    return trimOneLine(typeof result.output === "string" ? result.output : flatten(result.output ?? result.content ?? event.result), 180);
  }
  if (event.type === "content.part" && event.part?.type === "text") return String(event.part.text ?? "");
  return null;
}

function inferCwd(record) {
  const meta = recordValue(record);
  const cwd = stringValue(meta?.cwd) ?? stringValue(meta?.workDir);
  return cwd && cwd.trim() ? cwd : null;
}

function projectName(cwd, path) {
  if (cwd) return basename(cwd);
  const claude = /\/\.claude\/projects\/([^/]+)/u.exec(path);
  if (claude?.[1]) return claude[1].replace(/^-/, "").replace(/-/gu, "/").split("/").pop() || "claude";
  return basename(path).replace(/\.jsonl$/u, "");
}

function portablePath(path, home) {
  const rel = relative(home, path);
  if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return { root: "HOME", relPath: rel };
  return { root: "ABSOLUTE", relPath: path };
}

function scanSnippet(text, terms) {
  const compact = text.replace(/\s+/gu, " ").trim();
  if (compact.length <= 220) return compact;
  const index = compact.toLowerCase().indexOf(terms[0] ?? "");
  let start = Math.max(0, index >= 0 ? index - 70 : 0);
  let end = Math.min(compact.length, start + 220);
  if (start > 0) {
    const space = compact.indexOf(" ", start);
    if (space > start && space < index) start = space + 1;
  }
  if (end < compact.length) {
    const space = compact.lastIndexOf(" ", end);
    if (space > start) end = space;
  }
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

async function transcriptHead(file) {
  const kimiAgent = basename(dirname(file.path));
  const kimiSession = basename(dirname(dirname(dirname(file.path))));
  let sessionId = file.harness === "kimi" ? (kimiAgent === "main" ? kimiSession : `${kimiSession}:${kimiAgent}`) : null;
  let cwd = null;
  let head = "";
  try {
    const handle = await open(file.path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, file.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { cwd, sessionId };
  }
  for (const line of head.split("\n").slice(0, -1)) {
    if (cwd && sessionId) break;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const object = recordValue(value);
      if (!object) continue;
      cwd ??= inferCwd(object.meta ?? object.payload ?? object);
      sessionId ??= file.harness === "claude"
        ? stringValue(object.sessionId) ?? stringValue(object.session_id)
        : stringValue(object.payload?.id) ?? stringValue(object.id) ?? stringValue(object.meta?.sessionId);
    } catch {
      // A partial head line contributes nothing.
    }
  }
  return { cwd, sessionId };
}

function readRipgrepBatch(rg, paths, needle, signal, onLine, shouldStop) {
  return new Promise((resolve) => {
    const child = spawn(rg, [
      "--ignore-case",
      "--fixed-strings",
      "--line-number",
      "--byte-offset",
      "--no-heading",
      "--with-filename",
      "--null",
      "--no-messages",
      // One thread keeps matches in file order, so a page can stop at a file
      // boundary without skipping the files it has not reported yet.
      "--threads=1",
      "--",
      needle,
      ...paths,
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let carry = "";
    let failed = false;
    let killed = false;
    let killTimer;
    const stop = () => {
      killed = true;
      child.kill();
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
    };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const take = (row) => {
      const nul = row.indexOf("\x00");
      if (nul < 0) return;
      const match = /^(\d+):(\d+):/u.exec(row.slice(nul + 1));
      if (!match) return;
      onLine(row.slice(0, nul), Number(match[1]), Number(match[2]), row.slice(nul + 1 + match[0].length));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (signal?.aborted) return;
      carry += chunk;
      const rows = carry.split("\n");
      carry = rows.pop() ?? "";
      for (const row of rows) {
        if (shouldStop?.()) {
          stop();
          return;
        }
        take(row);
      }
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      if (carry && !killed) take(carry);
      if (killed) return resolve(!signal?.aborted);
      if (failed || (code !== 0 && code !== 1)) return resolve(false);
      resolve(true);
    });
  });
}

async function readFiles(files, terms, signal, onLine, shouldStop) {
  for (const file of files) {
    if (signal?.aborted || shouldStop?.()) return;
    let carry = "";
    let byte = 0;
    let lineNo = 0;
    const stream = createReadStream(file.path, { encoding: "utf8", signal, highWaterMark: 64 * 1024 });
    const take = (text) => {
      lineNo++;
      const lower = text.toLowerCase();
      if (terms.every((term) => lower.includes(term))) onLine(file.path, lineNo, byte, text);
      byte += Buffer.byteLength(text, "utf8") + 1;
    };
    try {
      for await (const chunk of stream) {
        carry += chunk;
        let newline;
        while ((newline = carry.indexOf("\n")) >= 0) {
          take(carry.slice(0, newline));
          carry = carry.slice(newline + 1);
        }
      }
      if (carry) take(carry);
    } catch {
      // A file that disappears mid-read contributes what was read.
    } finally {
      stream.destroy();
    }
  }
}

// Matched lines are parsed as they arrive, so only passages are held. The
// guard stops a query that matches a mountain of text; it is a memory bound,
// not a result limit.
async function scanFiles(files, terms, signal, onLine, shouldStop) {
  const needle = [...terms].sort((left, right) => right.length - left.length)[0];
  const rg = findRipgrep();
  if (rg && files.length > 0) {
    let complete = true;
    for (let start = 0; start < files.length && complete && !shouldStop?.(); start += RG_BATCH) {
      complete = await readRipgrepBatch(rg, files.slice(start, start + RG_BATCH).map((file) => file.path), needle, signal, onLine, shouldStop);
    }
    if (complete || signal?.aborted) return true;
  }
  await readFiles(files, terms, signal, onLine, shouldStop);
  return false;
}

export async function scanRecent({ q, hours, harness, limit = 30, cursor, signal }) {
  const terms = [...new Set(q.toLowerCase().split(/\s+/u).filter((term) => term.length > 1))];
  if (terms.length === 0) return { hits: [], scannedFiles: 0, candidates: 0, truncated: false, next: null };
  const cutoffMs = Date.now() - hours * 3_600_000;
  const files = await discoverFiles(cutoffMs, harness, signal);
  const pending = files.slice(resumeIndex(files, cursor));
  const byPath = new Map(pending.map((file) => [file.path, file]));
  const phrase = terms.join(" ");
  const matchesByPath = new Map();
  let collected = 0;
  let truncated = false;
  let stopped = false;
  let current = null;
  let found = 0;
  const onLine = (path, lineNo, byte, raw) => {
    if (truncated || stopped) return;
    const file = byPath.get(path);
    if (!file) return;
    // Stop at a file boundary once the page has enough to return.
    if (current !== path) {
      if (found >= limit) {
        stopped = true;
        return;
      }
      current = path;
    }
    const text = recordText(raw, file.harness);
    if (!text) return;
    const body = stripHarnessBoilerplate(text);
    const haystack = body.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return;
    const snippet = scanSnippet(body, terms);
    let entry = matchesByPath.get(path);
    if (!entry) {
      entry = { matches: [], seen: new Map() };
      matchesByPath.set(path, entry);
    }
    // One session repeats injected context. Show each distinct passage once,
    // and keep its latest occurrence.
    const key = snippet.toLowerCase();
    const earlier = entry.seen.get(key);
    if (earlier) {
      earlier.text = body;
      earlier.snippet = snippet;
      earlier.index = lineNo - 1;
      earlier.byte = byte;
      earlier.bytes = Buffer.byteLength(raw, "utf8");
      earlier.phrase = haystack.includes(phrase);
      return;
    }
    const match = {
      text: body,
      snippet,
      index: lineNo - 1,
      byte,
      bytes: Buffer.byteLength(raw, "utf8"),
      phrase: haystack.includes(phrase),
    };
    collected += snippet.length;
    if (collected > MATCH_CHARS) {
      truncated = true;
      return;
    }
    entry.seen.set(key, match);
    entry.matches.push(match);
    found++;
  };
  await scanFiles(pending, terms, signal, onLine, () => stopped);
  signal?.throwIfAborted();
  const home = homedir();
  const hits = [];
  let last = null;
  let scanned = 0;
  for (const file of pending) {
    if (hits.length >= limit) break;
    last = file;
    scanned++;
    const entry = matchesByPath.get(file.path);
    if (!entry?.matches.length) continue;
    entry.matches.sort((left, right) => Number(right.phrase) - Number(left.phrase) || right.index - left.index);
    signal?.throwIfAborted();
    const head = await transcriptHead(file);
    const sessionId = head.sessionId ?? basename(file.path).replace(/\.jsonl$/u, "");
    const project = projectName(head.cwd, file.path);
    const dir = `sessions/${file.harness}/${sessionId.replace(/[^A-Za-z0-9_.-]+/gu, "-").slice(0, 80)}-${stableId(file.path, 10)}`;
    const when = new Date(file.mtimeMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    for (const match of entry.matches) {
      const sourceRef = {
        kind: "harness_transcript",
        harness: file.harness,
        path: portablePath(file.path, home),
        sessionId,
        recordRange: [match.index, match.index],
        byteRange: [match.byte, match.byte + match.bytes],
        anchor: { sizeBytes: file.size, mtimeMs: file.mtimeMs },
      };
      const id = `basic:${stableId(`${file.path}\x00${match.index}`)}`;
      hits.push({
        id,
        collectionId: dir,
        documentId: `${dir}/basic`,
        chunkId: id,
        title: `${file.harness} ${project} ${when} - ${trimOneLine(match.text, 80)}`,
        snippet: match.snippet,
        score: 0,
        scoreSource: "fts",
        origin: "mechanical",
        ownership: "observed_source",
        freshness: "fresh",
        sourceRefs: [sourceRef],
        drilldown: [{ kind: "harness_transcript", sourceRef }],
        facets: {
          harness: file.harness,
          project,
          ...(head.cwd ? { projectPath: head.cwd } : {}),
          source: "sessions",
          transcriptPath: file.path,
          sessionId,
          documentKind: "events",
          match: "basic",
        },
      });
    }
  }
  const more = !truncated && last !== null && last !== pending[pending.length - 1];
  return {
    hits,
    scannedFiles: scanned,
    candidates: files.length,
    truncated,
    next: more ? { path: last.path, mtimeMs: last.mtimeMs } : null,
  };
}
