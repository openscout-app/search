import { execFileSync, spawnSync, execFile, spawn } from "node:child_process";
import path, { basename, join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, parseArgs } from "node:util";
import fs, { existsSync, createReadStream } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os, { homedir } from "node:os";
import { createHash } from "node:crypto";
import { stat, opendir, open } from "node:fs/promises";
const require$1 = createRequire(import.meta.url);
const DEFAULT_WINDOW_MS = 14 * 24 * 36e5;
function homeDir() {
  return process.env.SCOUT_SESSIONS_HOME || process.env.HOME || os.homedir();
}
function runtimeUrl() {
  const explicit = process.env.SCOUT_RUNTIME_URL || process.env.OPENSCOUT_BROKER_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(homeDir(), ".openscout", "config.json"), "utf8"));
    if (cfg?.port) return `http://127.0.0.1:${cfg.port}`;
  } catch {
  }
  return "http://127.0.0.1:43110";
}
function scoutBin$1() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  try {
    const pkg = require$1.resolve("@openscout/scout/package.json");
    const candidate = path.join(path.dirname(pkg), "bin", "scout");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
  }
  const which = spawnSync("which", ["scout"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
function findBun() {
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  return which.status === 0 ? which.stdout.trim() : null;
}
async function checkRuntime(base = runtimeUrl()) {
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500), redirect: "error" });
    return res.ok;
  } catch {
    return false;
  }
}
function runScoutSetup(packageName = "@openscout/scout") {
  const bin = scoutBin$1();
  const bun = findBun();
  if (!bin) throw new Error(`Scout CLI not found. Reinstall ${packageName}.`);
  if (!bun) throw new Error("Bun 1.4.4+ is required to run Scout's background runtime (https://bun.sh).");
  const env = { ...process.env, PATH: `${path.dirname(bun)}:${process.env.PATH || ""}` };
  execFileSync(bin, ["setup"], { stdio: "pipe", env, timeout: 3e4 });
}
function isSyntheticPromptRecord(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^# AGENTS\.md instructions\b/i.test(trimmed)) return true;
  if (/^<environment_context>/i.test(trimmed) && !trimmed.includes("</environment_context>\n")) return true;
  if (/^The following is a <SYSTEM_MESSAGE>/i.test(trimmed)) return true;
  if (/<command-name>\s*\/(?:clear|compact|login|logout|status|help)\s*<\/command-name>/i.test(trimmed)) return true;
  return false;
}
function stripPromptEnvelope(raw) {
  if (!raw) return "";
  if (isSyntheticPromptRecord(raw)) return "";
  const userReq = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const picked = userReq ? userReq[1] : raw;
  return picked.replace(/<(ADDITIONAL_METADATA|CONTEXT_SUMMARY|SYSTEM_MESSAGE|INSTRUCTIONS|environment_context|system-reminder|system_reminder|local-command-caveat|recommended_plugins|command-name|command-message|command-args)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ").replace(/<\/?pasted_content\b[^>]*>/gi, " ").replace(/^New (?:broker|runtime) ask from [^\n]+?\.\s*(?:Task:\s*)?/i, "").replace(/<\/?[A-Z_]{4,}>/g, " ").replace(/<truncated \d+ (?:bytes|lines)>/gi, "").replace(/\s+/g, " ").trim();
}
function summarizeHumanTitle(raw, maxLen = 110) {
  if (!raw) return null;
  const cleaned = stripPromptEnvelope(raw).replace(/^#+\s*/, "").replace(/^[>*-\s]+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();
  if (!cleaned) return null;
  const firstSentence = cleaned.split(/\n/)[0]?.trim() || cleaned;
  return firstSentence.length <= maxLen ? firstSentence : `${firstSentence.slice(0, maxLen - 1).trimEnd()}…`;
}
function sniffWorkspaceFromPathHint(candidatePath) {
  if (typeof candidatePath !== "string" || !candidatePath.startsWith("/")) return null;
  const devMatch = /^(\/(?:Users|home)\/[^/]+\/dev\/[^/]+)/.exec(candidatePath);
  if (devMatch?.[1]) return devMatch[1];
  const parts = candidatePath.split("/").filter(Boolean);
  if (parts.length >= 4 && (parts[0] === "Users" || parts[0] === "home") && !parts[2]?.startsWith(".")) {
    return `/${parts.slice(0, 4).join("/")}`;
  }
  return null;
}
function sniffWorkspaceFromText(text) {
  const activeMatch = /Active Workspaces:\s*\n\s*-\s*([^\r\n<]+)/i.exec(text);
  if (activeMatch?.[1]?.trim()) return activeMatch[1].trim();
  const cwdMatch = /Command Working Directory:\s*([^\r\n<]+)/i.exec(text);
  if (cwdMatch?.[1]?.trim()) return cwdMatch[1].trim();
  return null;
}
function walkJsonl(dir, maxDepth, windowMs, filter, out = [], depth = 0) {
  if (depth > maxDepth || !fs.existsSync(dir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const now = Date.now();
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonl(full, maxDepth, windowMs, filter, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      if (filter && !filter(full, entry.name)) continue;
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs <= windowMs && st.size > 0) {
          out.push({ path: full, mtimeMs: st.mtimeMs, size: st.size });
        }
      } catch {
      }
    }
  }
  return out;
}
function readSlice(filePath, start, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const clampedStart = Math.max(0, Math.min(start, size));
    const clampedLen = Math.max(0, Math.min(length, size - clampedStart));
    if (clampedLen === 0) return "";
    const buf = Buffer.alloc(clampedLen);
    fs.readSync(fd, buf, 0, clampedLen, clampedStart);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") {
        const rec = item;
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.input_text === "string") return rec.input_text;
        if (typeof rec.output_text === "string") return rec.output_text;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}
function looksLikeUuid(value) {
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
}
function sniffTranscriptMeta(filePath, source, size) {
  let sessionId = path.basename(filePath, ".jsonl");
  let cwd = null;
  let branch = null;
  let model = null;
  let firstPrompt = null;
  let latestPrompt = null;
  if (source === "antigravity") {
    const brainMatch = /brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/i.exec(filePath) || /brain[\\/]([\da-f-]{36})[\\/]/i.exec(filePath);
    if (brainMatch?.[1]) sessionId = brainMatch[1];
  } else if (source === "kimi") {
    const kimiMatch = /sessions[\\/][^\\/]+[\\/]([^\\/]+)[\\/]agents/i.exec(filePath);
    if (kimiMatch?.[1]) sessionId = kimiMatch[1];
  }
  const fileSize = size ?? (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);
  const head = readSlice(filePath, 0, 48e3);
  const tail = fileSize > 48e3 ? readSlice(filePath, Math.max(0, fileSize - 48e3), 48e3) : "";
  const lines = [...head.split("\n").slice(0, 30), ...tail ? tail.split("\n").slice(1) : []];
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof obj.cwd === "string" && !cwd) cwd = obj.cwd;
    if (typeof obj.gitBranch === "string" && !branch) branch = obj.gitBranch;
    if (source === "claude") {
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      if (typeof obj.message?.model === "string") model = obj.message.model;
      if (obj.type === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "codex") {
      if (obj.type === "session_meta" && obj.payload) {
        if (typeof obj.payload.id === "string") sessionId = obj.payload.id;
        if (typeof obj.payload.cwd === "string" && !cwd) cwd = obj.payload.cwd;
        if (typeof obj.payload.git?.branch === "string" && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && typeof obj.payload?.model === "string") model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const txt = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      } else if (obj.type === "event_msg" && obj.payload?.type === "user_message") {
        const txt = stripPromptEnvelope(String(obj.payload.message ?? obj.payload.text ?? ""));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (typeof step.metadata?.generatorModel === "string") model = step.metadata.generatorModel;
      if (typeof step.model === "string" && !model) model = step.model;
      const ws = step.userInput?.activeUserState?.activeDocument?.workspaceUri;
      if (typeof ws === "string" && ws.startsWith("file://") && !cwd) {
        cwd = decodeURIComponent(ws.slice("file://".length));
      }
      if (!cwd && typeof step.content === "string") {
        cwd = sniffWorkspaceFromText(step.content);
      }
      const rawCalls = step.plannerResponse?.toolCalls || step.tool_calls || [];
      if (!cwd && Array.isArray(rawCalls)) {
        for (const call of rawCalls) {
          let args = call?.args || call?.arguments || {};
          if (typeof call?.argumentsJson === "string") {
            try {
              args = JSON.parse(call.argumentsJson);
            } catch {
            }
          }
          cwd = sniffWorkspaceFromPathHint(args?.Path || args?.TargetFile);
          if (cwd) break;
        }
      }
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const rawPrompt = String(step.userInput?.userResponse ?? step.content ?? "");
        if (!cwd) cwd = sniffWorkspaceFromText(rawPrompt);
        const txt = stripPromptEnvelope(rawPrompt);
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    } else if (source === "kimi") {
      if (obj.type === "turn.prompt") {
        const txt = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (txt) {
          firstPrompt ??= txt;
          latestPrompt = txt;
        }
      }
    }
  }
  let project = "session";
  if (cwd) {
    project = path.basename(cwd);
  } else if (source === "claude") {
    const dirName = path.basename(path.dirname(filePath));
    project = dirName.replace(/^-/, "").split("-").pop() || "claude";
  } else if (source === "kimi") {
    const wdMatch = /sessions[\\/]wd_([^\\/]+)[\\/]/i.exec(filePath);
    project = wdMatch?.[1] || "kimi";
  } else if (!looksLikeUuid(sessionId)) {
    project = sessionId;
  } else {
    project = source === "antigravity" ? "Antigravity" : source;
  }
  const title = summarizeHumanTitle(latestPrompt || firstPrompt);
  return { sessionId, cwd, project, branch, model, title };
}
const transcriptDiscoveryCache = /* @__PURE__ */ new Map();
function discoverLocalTranscripts(options = {}) {
  const home = homeDir();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxPerHarness = options.maxPerHarness ?? 40;
  const filterHarness = options.harness || "";
  const cacheKey = `${home}|${windowMs}|${maxPerHarness}|${filterHarness}|${process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || ""}|${process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT || ""}|${process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || ""}`;
  const cached = !options.bypassCache ? transcriptDiscoveryCache.get(cacheKey) : void 0;
  if (cached && Date.now() - cached.at < 2500) {
    return cached.items;
  }
  const claudeRoot = process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT || path.join(home, ".claude", "projects");
  const codexRoot = process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT || path.join(home, ".codex", "sessions");
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || path.join(home, ".kimi-code");
  const kimiRoot = process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT || path.join(kimiHome, "sessions");
  const agyBrainOverride = process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT;
  const brainFilter = (full, name) => name === "transcript.jsonl" && full.includes(`${path.sep}.system_generated${path.sep}logs${path.sep}`);
  const sources = [
    { source: "claude", files: walkJsonl(claudeRoot, 3, windowMs) },
    {
      source: "codex",
      files: [
        ...walkJsonl(codexRoot, 4, windowMs),
        ...process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".openai-codex", "sessions"), 4, windowMs)
      ]
    },
    {
      source: "antigravity",
      files: [
        ...agyBrainOverride ? walkJsonl(agyBrainOverride, 4, windowMs, brainFilter) : [
          ...walkJsonl(path.join(home, ".gemini", "antigravity-cli", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity", "brain"), 4, windowMs, brainFilter),
          ...walkJsonl(path.join(home, ".gemini", "antigravity-ide", "brain"), 4, windowMs, brainFilter)
        ],
        ...walkJsonl(path.join(home, ".gemini", "antigravity", "conversations"), 2, windowMs)
      ]
    },
    {
      source: "kimi",
      files: [
        ...walkJsonl(kimiRoot, 5, windowMs, (_full, name) => name === "wire.jsonl"),
        ...process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ? [] : walkJsonl(path.join(home, ".kimi", "sessions"), 5, windowMs)
      ]
    }
  ];
  const seenPaths = /* @__PURE__ */ new Set();
  const transcripts = [];
  for (const group of sources) {
    if (filterHarness && group.source !== filterHarness) continue;
    const recent = group.files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, maxPerHarness);
    for (const item of recent) {
      if (seenPaths.has(item.path)) continue;
      seenPaths.add(item.path);
      try {
        const meta = sniffTranscriptMeta(item.path, group.source, item.size);
        transcripts.push({
          source: group.source,
          sessionId: meta.sessionId,
          project: meta.project,
          cwd: meta.cwd,
          branch: meta.branch,
          model: meta.model,
          title: meta.title,
          transcriptPath: item.path,
          mtimeMs: Math.floor(item.mtimeMs),
          size: item.size
        });
      } catch {
      }
    }
  }
  const sorted = transcripts.sort((a, b) => b.mtimeMs - a.mtimeMs);
  transcriptDiscoveryCache.set(cacheKey, { at: Date.now(), items: sorted });
  return sorted;
}
function parseSessionObserve(transcript) {
  const content = fs.readFileSync(transcript.transcriptPath, "utf8");
  const allLines = content.split("\n");
  const startIdx = Math.max(0, allLines.length - 1600);
  const events = [];
  let model = transcript.model ?? null;
  let branch = transcript.branch ?? null;
  let cwd = transcript.cwd ?? null;
  let seq = 0;
  for (let i = startIdx; i < allLines.length; i++) {
    const line = allLines[i];
    if (!line?.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(obj.timestamp || obj.created_at || obj.step?.metadata?.createdAt || "") || transcript.mtimeMs;
    if (transcript.source === "claude") {
      if (obj.cwd && !cwd) cwd = obj.cwd;
      if (obj.gitBranch && !branch) branch = obj.gitBranch;
      if (obj.message?.model) model = obj.message.model;
      if (obj.type === "user") {
        const text = stripPromptEnvelope(flattenContent(obj.message?.content ?? obj.content));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
        for (const block of obj.message.content) {
          if (block?.type === "text" && block.text) {
            events.push({ id: `ev-${++seq}`, kind: "message", text: block.text, ts, recordIndex: i });
          } else if (block?.type === "tool_use") {
            const pathVal = block.input?.file_path || block.input?.path || void 0;
            const arg = block.input?.command || pathVal || block.input?.pattern || "";
            events.push({
              id: `ev-${++seq}`,
              kind: "tool",
              tool: block.name || "tool",
              arg: String(arg),
              ...pathVal ? { path: String(pathVal) } : {},
              text: `${block.name || "tool"} ${arg}`.trim(),
              ts,
              recordIndex: i
            });
          }
        }
      }
    } else if (transcript.source === "codex") {
      if (obj.type === "session_meta") {
        if (obj.payload?.cwd && !cwd) cwd = obj.payload.cwd;
        if (obj.payload?.git?.branch && !branch) branch = obj.payload.git.branch;
      }
      if (obj.type === "turn_context" && obj.payload?.model) model = obj.payload.model;
      if (obj.type === "response_item" && obj.payload?.role === "user") {
        const text = stripPromptEnvelope(flattenContent(obj.payload.content));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "response_item" && obj.payload?.role === "assistant") {
        const text = flattenContent(obj.payload.content).trim();
        if (text) events.push({ id: `ev-${++seq}`, kind: "message", text, ts, recordIndex: i });
      } else if (obj.type === "response_item" && (obj.payload?.type === "function_call" || obj.payload?.type === "local_shell_call")) {
        let arg = String(obj.payload.arguments || obj.payload.command || "");
        try {
          const parsed = JSON.parse(arg);
          arg = parsed.cmd || parsed.command || (Array.isArray(parsed.command) ? parsed.command.join(" ") : arg);
        } catch {
        }
        events.push({
          id: `ev-${++seq}`,
          kind: "tool",
          tool: obj.payload.name || "shell",
          arg: String(arg).slice(0, 220),
          text: `${obj.payload.name || "shell"} ${String(arg).slice(0, 220)}`.trim(),
          ts,
          recordIndex: i
        });
      }
    } else if (transcript.source === "antigravity") {
      const step = obj.step || obj;
      const type = String(step.type || "");
      if (step.metadata?.generatorModel) model = step.metadata.generatorModel;
      if (typeof step.model === "string") model = step.model;
      if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
        const text = stripPromptEnvelope(String(step.userInput?.userResponse ?? step.content ?? ""));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
        const pr = step.plannerResponse;
        const calls = pr?.toolCalls || step.tool_calls || [];
        for (const call of calls) {
          let args = {};
          try {
            args = typeof call.argumentsJson === "string" ? JSON.parse(call.argumentsJson) : call.arguments || call.args || {};
          } catch {
          }
          const toolName = call.name || call.tool_name || "tool";
          const pathVal = args.Path || args.TargetFile || null;
          if (!cwd && pathVal) cwd = sniffWorkspaceFromPathHint(pathVal);
          const arg = args.CommandLine || pathVal || args.query || args.toolSummary || toolName;
          events.push({
            id: `ev-${++seq}`,
            kind: "tool",
            tool: toolName,
            arg: String(arg),
            ...pathVal ? { path: String(pathVal) } : {},
            text: `${toolName} ${arg}`.trim(),
            ts,
            recordIndex: i
          });
        }
        const reply = pr?.modifiedResponse || pr?.response || (typeof step.content === "string" ? step.content : "");
        if (reply) events.push({ id: `ev-${++seq}`, kind: "message", text: reply, ts, recordIndex: i });
      }
    } else if (transcript.source === "kimi") {
      if (obj.type === "turn.prompt") {
        const text = stripPromptEnvelope(flattenContent(obj.input ?? obj.content));
        if (text) events.push({ id: `ev-${++seq}`, kind: "prompt", text, ts, recordIndex: i });
      } else if (obj.type === "context.append_loop_event") {
        const ev = obj.event;
        if (ev?.type === "tool.call") {
          const arg = typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args ?? ev.input ?? {}).slice(0, 180);
          events.push({ id: `ev-${++seq}`, kind: "tool", tool: ev.name || "tool", arg, text: `${ev.name || "tool"} ${arg}`.trim(), ts, recordIndex: i });
        } else if (ev?.part?.text) {
          events.push({ id: `ev-${++seq}`, kind: "message", text: String(ev.part.text), ts, recordIndex: i });
        }
      }
    }
  }
  return {
    live: Date.now() - transcript.mtimeMs < 6e4,
    events,
    files: [],
    metadata: {
      session: {
        adapterType: transcript.source,
        cwd,
        externalSessionId: transcript.sessionId || path.basename(transcript.transcriptPath, ".jsonl"),
        ...model ? { model } : {},
        ...branch ? { branch } : {},
        ...transcript.title ? { title: transcript.title } : {}
      }
    }
  };
}
async function resolveSessionObserve(requestedId) {
  const cleaned = requestedId.replace(/^session:[^:]+:/, "");
  let hit = discoverLocalTranscripts({ maxPerHarness: 80 }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  ) ?? discoverLocalTranscripts({ maxPerHarness: 80, bypassCache: true }).find(
    (t) => t.sessionId === cleaned || t.transcriptPath === cleaned || t.transcriptPath.includes(cleaned)
  );
  if (!hit) {
    const base = runtimeUrl();
    if (await checkRuntime(base)) {
      try {
        const res = await fetch(`${base}/v1/tail/discover`, {
          signal: AbortSignal.timeout(2500),
          redirect: "error"
        });
        if (res.ok) {
          const snap = await res.json();
          const rtHit = (snap?.transcripts || []).find(
            (t) => t.sessionId === cleaned || typeof t.transcriptPath === "string" && t.transcriptPath.includes(cleaned)
          );
          if (rtHit && typeof rtHit.transcriptPath === "string" && fs.existsSync(rtHit.transcriptPath)) {
            const st = fs.statSync(rtHit.transcriptPath);
            const meta = sniffTranscriptMeta(rtHit.transcriptPath, rtHit.source || "claude", st.size);
            hit = {
              source: rtHit.source || "claude",
              sessionId: rtHit.sessionId || meta.sessionId,
              project: rtHit.project || meta.project,
              cwd: rtHit.cwd || meta.cwd,
              branch: meta.branch,
              model: meta.model,
              title: meta.title,
              transcriptPath: rtHit.transcriptPath,
              mtimeMs: Math.floor(st.mtimeMs),
              size: st.size
            };
          }
        }
      } catch {
      }
    }
  }
  if (!hit || !fs.existsSync(hit.transcriptPath)) return null;
  const data = parseSessionObserve(hit);
  return {
    kind: "observe",
    refId: hit.sessionId,
    observe: {
      kind: "history",
      refId: hit.sessionId,
      sessionId: hit.sessionId,
      source: hit.source,
      project: hit.project,
      fidelity: "timestamped",
      updatedAt: hit.mtimeMs,
      data
    }
  };
}
function readTranscriptContextWindow(params) {
  const home = homeDir();
  let filePath = null;
  if (params.source) {
    const candidate = params.source.startsWith("~/") ? path.join(home, params.source.slice(2)) : params.source;
    if (fs.existsSync(candidate) && candidate.endsWith(".jsonl")) filePath = candidate;
  }
  const local = discoverLocalTranscripts({ maxPerHarness: 80 });
  const hit = local.find(
    (t) => filePath && t.transcriptPath === filePath || params.sessionId && (t.sessionId === params.sessionId || t.transcriptPath.includes(params.sessionId))
  );
  if (!hit && !filePath) return null;
  const targetPath = hit?.transcriptPath ?? filePath;
  const harness = hit?.source ?? (targetPath.includes(".claude") ? "claude" : targetPath.includes("antigravity") ? "antigravity" : targetPath.includes("kimi") ? "kimi" : "codex");
  const st = fs.statSync(targetPath);
  const meta = hit ?? { ...sniffTranscriptMeta(targetPath, harness, st.size), source: harness, transcriptPath: targetPath, mtimeMs: st.mtimeMs, size: st.size };
  const parsed = parseSessionObserve(meta);
  const center = params.centerRecord ?? -1;
  const radius = params.radius ?? 3;
  let matchPos = parsed.events.findIndex((e) => e.recordIndex === center);
  if (matchPos < 0 && center >= 0) {
    matchPos = parsed.events.reduce((best, ev, idx) => {
      if (ev.recordIndex == null) return best;
      if (best < 0) return idx;
      const prevDiff = Math.abs((parsed.events[best]?.recordIndex ?? 0) - center);
      return Math.abs(ev.recordIndex - center) < prevDiff ? idx : best;
    }, -1);
  }
  const sliceStart = matchPos >= 0 ? Math.max(0, matchPos - radius) : Math.max(0, parsed.events.length - (radius * 2 + 1));
  const sliceEnd = matchPos >= 0 ? Math.min(parsed.events.length, matchPos + radius + 1) : parsed.events.length;
  const turns = parsed.events.slice(sliceStart, sliceEnd).map((ev, idx) => ({
    index: ev.recordIndex ?? sliceStart + idx,
    role: ev.kind === "prompt" ? "prompt" : ev.kind === "tool" ? "tool" : "reply",
    label: ev.kind === "prompt" ? "You" : ev.kind === "tool" ? ev.tool || "Tool" : "Agent",
    text: ev.kind === "tool" ? ev.arg || ev.text : ev.text,
    matched: matchPos >= 0 ? sliceStart + idx === matchPos : false
  }));
  return {
    sessionId: meta.sessionId,
    project: meta.project,
    harness: meta.source,
    title: meta.title,
    turns
  };
}
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};
function isLoopbackHost(req) {
  return LOCAL_HOST.test(req.headers.host || "");
}
function isLocalRequest(req) {
  const host = req.headers.host || "";
  if (!isLoopbackHost(req)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data));
}
async function readJsonBody(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("Request body is too large.");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}
function createScoutThinHttpHandler(options) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  return async function handleThinApi(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/v1/")) return false;
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { error: `Open ${title} on this host.` });
      return true;
    }
    const runtimeBase = runtimeUrl();
    if (req.method === "GET" && pathname === "/api/identity") {
      sendJson(res, 200, { app: options.packageName, product: options.product });
      return true;
    }
    if (options.apiHandler) {
      const handled = await options.apiHandler(req, res, { url, pathname, runtimeBase });
      if (handled) return true;
    }
    if (req.method === "GET" && pathname === "/api/status") {
      const runtimeUp = await checkRuntime(runtimeBase);
      const extra = options.getStatus ? await options.getStatus({ runtimeUp, runtimeUrl: runtimeBase }) : {};
      sendJson(res, 200, { runtimeUp, runtimeUrl: runtimeBase, ...extra });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/setup") {
      try {
        runScoutSetup(options.packageName);
        sendJson(res, 200, { ok: true, runtimeUp: await checkRuntime(runtimeBase) });
      } catch (err) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    if (req.method === "GET" && (pathname === "/v1/events/stream" || pathname === "/v1/tail/events")) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive"
      });
      res.write(": connected\n\n");
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 2e4);
      req.on("close", () => clearInterval(keepAlive));
      return true;
    }
    if (req.method === "GET" && pathname === "/api/recent-sessions") {
      const limit = Math.min(24, Math.max(1, Number(url.searchParams.get("limit") ?? 8)));
      const sessions = discoverLocalTranscripts({ maxPerHarness: 15 }).slice(0, limit).map((item) => ({
        sessionId: item.sessionId,
        harness: item.source,
        project: item.project,
        branch: item.branch,
        model: item.model,
        title: item.title,
        updatedAt: item.mtimeMs
      }));
      sendJson(res, 200, { sessions });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/session-context") {
      try {
        const body = await readJsonBody(req);
        const context = readTranscriptContextWindow(body);
        if (!context) {
          sendJson(res, 404, { error: "Session transcript not found." });
          return true;
        }
        sendJson(res, 200, context);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    const refMatch = /^\/api\/session-ref\/(.+)$/.exec(pathname);
    if (req.method === "GET" && refMatch?.[1]) {
      const resolved = await resolveSessionObserve(decodeURIComponent(refMatch[1]));
      if (!resolved) {
        sendJson(res, 404, { error: "Session transcript not found." });
        return true;
      }
      sendJson(res, 200, resolved);
      return true;
    }
    if (req.method === "GET" && pathname === "/api/messages") {
      const conversationId = url.searchParams.get("conversationId") || "";
      if (conversationId && await checkRuntime(runtimeBase)) {
        try {
          const upstream = await fetch(`${runtimeBase}/v1/messages?conversationId=${encodeURIComponent(conversationId)}&limit=50`, {
            signal: AbortSignal.timeout(3e3),
            redirect: "error"
          });
          if (upstream.ok) {
            const data = await upstream.json();
            sendJson(res, 200, Array.isArray(data) ? data : data.messages || []);
            return true;
          }
        } catch {
        }
      }
      sendJson(res, 200, []);
      return true;
    }
    sendJson(res, 404, { error: `Unknown ${title} API route.` });
    return true;
  };
}
function createScoutThinServer(options) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  const distDir = path.resolve(options.distDir);
  const handleApi = createScoutThinHttpHandler(options);
  return http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!isLoopbackHost(req)) {
      sendJson(res, 421, { error: `Open ${title} via its local loopback address.` });
      return;
    }
    try {
      if (await handleApi(req, res)) return;
    } catch (err) {
      if (!res.destroyed) {
        sendJson(res, 503, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const urlPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const rel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");
    let file = path.join(distDir, rel);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(distDir, "index.html");
    }
    if (!fs.existsSync(file)) {
      sendJson(res, 503, { error: `${title}: dist/index.html is missing. Run npm run build first.` });
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] || "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(file).pipe(res);
  });
}
function serveScoutThinServer(createServer2, port, host = "127.0.0.1") {
  const server = createServer2();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const cmdArgs = process.platform === "win32" ? ["/c", "start", url] : [url];
  execFile(cmd, cmdArgs, () => {
  });
}
async function runScoutThinCli(options, argv = process.argv.slice(2)) {
  const title = options.product === "Scout" ? "Scout" : `Scout ${options.product}`;
  const opt = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : void 0;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(options.help);
    return;
  }
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : null;
  if (sub && options.commands && Object.hasOwn(options.commands, sub)) {
    await options.commands[sub](argv.slice(1));
    return;
  }
  if (sub === "setup") {
    try {
      runScoutSetup(options.packageName);
      console.log(`Scout runtime is ready at ${runtimeUrl()}.`);
      return;
    } catch (err) {
      console.error(`${options.binName}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  if (sub === "status") {
    if (options.getStatus) {
      const report = await options.getStatus();
      if (argv.includes("--json")) {
        console.log(JSON.stringify(report.json, null, 2));
      } else {
        for (const line of report.lines) console.log(line);
      }
      return;
    }
    const url = runtimeUrl();
    const up = await checkRuntime(url);
    if (argv.includes("--json")) {
      console.log(JSON.stringify({ runtimeUp: up, runtimeUrl: url }, null, 2));
    } else {
      console.log(`Runtime: ${up ? `up at ${url}` : `not running (run ${options.binName} setup to start it)`}`);
    }
    return;
  }
  if (sub && sub !== "serve") {
    console.error(`${options.binName}: unknown command "${sub}". Run ${options.binName} --help.`);
    process.exit(1);
  }
  const indexHtml = path.join(path.resolve(options.distDir), "index.html");
  if (!fs.existsSync(indexHtml)) {
    console.error(`${options.binName}: dist/index.html is missing. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const requested = Number(opt("--port") ?? process.env[options.portEnvVar] ?? 0);
  if (opt("--port") !== void 0 && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
    console.error(`${options.binName}: use a port between 1 and 65535.`);
    process.exit(1);
  }
  const startPort = requested || options.defaultPort;
  const open2 = !argv.includes("--no-open");
  for (let port = startPort; port < startPort + (requested ? 1 : 10); port++) {
    try {
      await serveScoutThinServer(options.createServer, port);
      const url = `http://127.0.0.1:${port}`;
      console.log(`${title}: ${url}`);
      if (open2) openBrowser(url);
      return;
    } catch (err) {
      if (err?.code === "EADDRINUSE") {
        try {
          const check = await fetch(`http://127.0.0.1:${port}/api/identity`, {
            signal: AbortSignal.timeout(800),
            redirect: "error"
          });
          if (check.ok && (await check.json()).app === options.packageName) {
            const url = `http://127.0.0.1:${port}`;
            console.log(`${title} is already running at ${url}`);
            if (open2) openBrowser(url);
            return;
          }
        } catch {
        }
        if (!requested) continue;
      }
      console.error(`${options.binName}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
  console.error(`${options.binName}: ports ${startPort}-${startPort + 9} are in use. Pass --port to choose another.`);
  process.exit(1);
}
const pageSize = 30;
const pageCap = 500;
const windows = [
  { id: "4h", hours: 4, label: "Last 4 hours" },
  { id: "24h", hours: 24, label: "Last 24 hours" },
  { id: "3d", hours: 72, label: "Last 3 days" },
  { id: "7d", hours: 168, label: "Last 7 days" },
  { id: "30d", hours: 720, label: "Last 30 days" }
];
const defaultWindow = "3d";
function findWindow(id) {
  return windows.find((entry) => entry.id === id) ?? null;
}
function windowChoices() {
  return windows.map((entry) => entry.label.toLowerCase()).join(", ");
}
const MATCH_CHARS = 8 * 1024 * 1024;
const HEAD_BYTES = 256 * 1024;
const RG_BATCH = 200;
function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
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
function stripHarnessBoilerplate(text) {
  const userReq = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/iu.exec(text);
  const picked = userReq ? userReq[1] : text;
  return picked.replace(/<(recommended_plugins|local-command-caveat|system-reminder|system_reminder|ADDITIONAL_METADATA|CONTEXT_SUMMARY|SYSTEM_MESSAGE|INSTRUCTIONS|environment_context|command-name|command-message|command-args)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, "").replace(/<\/?pasted_content\b[^>]*>/giu, "").replace(/<truncated \d+ (?:bytes|lines)>/giu, "").trim();
}
function cleanHumanSessionTitle(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^# AGENTS\.md instructions\b/iu.test(trimmed)) return null;
  if (/^The following is a <SYSTEM_MESSAGE>/iu.test(trimmed)) return null;
  if (/<command-name>\s*\/(?:clear|compact|login|logout|status|help)\s*<\/command-name>/iu.test(trimmed)) return null;
  const cleaned = stripHarnessBoilerplate(trimmed).replace(/^New (?:broker|runtime) ask from [^\n]+?\.\s*(?:Task:\s*)?/iu, "").replace(/^#+\s*/u, "").replace(/\*\*([^*]+)\*\*/gu, "$1").replace(/`([^`]+)`/gu, "$1").replace(/\s+/gu, " ").trim();
  return cleaned.length >= 3 ? trimOneLine(cleaned, 110) : null;
}
function stableId(value, length = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function isTranscriptFile(harness, name, brain) {
  if (brain) return name === "transcript.jsonl";
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
    { harness: "antigravity", root: join(home, ".gemini", "antigravity", "conversations") },
    {
      harness: "antigravity",
      brain: true,
      root: process.env.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT ?? join(home, ".gemini", "antigravity-cli", "brain")
    }
  ];
  return roots.filter((entry) => existsSync(entry.root) && (!harness || entry.harness === harness));
}
async function discoverFiles(cutoffMs, harness, signal) {
  const files = [];
  for (const { harness: name, root, brain } of sessionRoots(harness)) {
    const stack = [root];
    const visited = /* @__PURE__ */ new Set();
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
        const path2 = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (brain) {
            const parts2 = relative(root, path2).split(sep);
            if (parts2.length > 3 || parts2.length > 1 && parts2[1] !== ".system_generated" || parts2.length === 3 && parts2[2] !== "logs") continue;
          }
          stack.push(path2);
          continue;
        }
        if (!isTranscriptFile(name, entry.name, brain)) continue;
        const parts = brain ? relative(root, path2).split(sep) : null;
        if (parts && (parts.length !== 4 || parts[1] !== ".system_generated" || parts[2] !== "logs")) continue;
        let file;
        try {
          file = await stat(path2);
        } catch {
          continue;
        }
        if (file.isDirectory()) {
          stack.push(path2);
          continue;
        }
        if (!file.isFile() || file.mtimeMs < cutoffMs) continue;
        files.push({ harness: name, path: path2, mtimeMs: file.mtimeMs, size: file.size, sessionId: parts?.[0] });
      }
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
function resumeIndex(files, at) {
  if (!at) return 0;
  const index = files.findIndex((file) => file.path === at.path && file.mtimeMs === at.mtimeMs);
  if (index >= 0) return index + 1;
  const next = files.findIndex((file) => file.mtimeMs < at.mtimeMs || file.mtimeMs === at.mtimeMs && file.path > at.path);
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
function recordEntry(raw, harness) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const object = recordValue(value);
  if (!object) return null;
  const entry = harness === "claude" ? claudeEntry(object) : harness === "kimi" ? kimiEntry(object) : harness === "antigravity" ? antigravityEntry(object) : codexEntry(object);
  return entry && entry.text && entry.text.trim() ? entry : null;
}
function codexEntry(object) {
  const type = String(object.type ?? "");
  if (type === "session_meta" || type === "turn_context") return null;
  if (type === "event_msg") {
    const payload = recordValue(object.payload) ?? {};
    if (payload.type === "user_message") return { role: "prompt", text: String(payload.message ?? payload.text ?? "") };
    if (payload.type === "agent_message") return { role: "reply", text: String(payload.message ?? payload.text ?? "") };
    return null;
  }
  if (type === "response_item" || type === "message" || type === "reasoning" || type === "function_call" || type === "local_shell_call" || type === "function_call_output" || type === "local_shell_call_output") {
    return codexPayloadEntry(recordValue(object.payload) ?? object, type);
  }
  return null;
}
function codexPayloadEntry(payload, fallback) {
  const type = String(payload.type ?? "") || fallback;
  if (type === "message") {
    const role = payload.role === "user" ? "prompt" : "reply";
    return { role, text: flatten(payload.content) };
  }
  if (type === "reasoning") {
    const text = Array.isArray(payload.summary) ? payload.summary.map((entry) => recordValue(entry)?.text).filter(Boolean).join(" ") : stringValue(payload.content) ?? "";
    return { role: "reply", text };
  }
  if (type === "function_call" || type === "local_shell_call") {
    return { role: "tool", text: `name=${payload.name ?? payload.command ?? "tool"} input=${oneLineInput(payload.arguments ?? payload.args ?? payload.input ?? {})}` };
  }
  if (type === "function_call_output" || type === "local_shell_call_output") {
    return { role: "tool", text: trimOneLine(typeof payload.output === "string" ? payload.output : flatten(payload.output ?? payload.content), 180) };
  }
  return null;
}
function claudeEntry(object) {
  const type = String(object.type ?? "");
  const message = recordValue(object.message);
  if (type === "user") return { role: "prompt", text: flatten(message?.content ?? object.content) };
  if (type === "assistant") {
    const content = message?.content ?? object.content;
    const tool = Array.isArray(content) ? content.map(recordValue).find((entry) => entry?.type === "tool_use") : null;
    if (tool) return { role: "tool", text: `name=${tool.name ?? "tool"} input=${oneLineInput(tool.input ?? {})}` };
    return { role: "reply", text: flatten(content) };
  }
  if (type === "tool_use") return { role: "tool", text: `name=${object.name ?? "tool"} input=${oneLineInput(object.input ?? {})}` };
  if (type === "tool_result") return { role: "tool", text: trimOneLine(typeof object.content === "string" ? object.content : flatten(object.content), 180) };
  return null;
}
function kimiEntry(object) {
  const type = String(object.type ?? "");
  if (type === "turn.prompt" || type === "turn.steer") return { role: "prompt", text: flatten(object.input ?? object.content) };
  if (type === "context.append_message") {
    const msg = recordValue(object.message);
    return { role: msg?.role === "user" ? "prompt" : "reply", text: flatten(msg?.content) };
  }
  if (type !== "context.append_loop_event") return null;
  const event = recordValue(object.event) ?? {};
  if (event.type === "tool.call") return { role: "tool", text: `name=${event.name ?? "tool"} input=${oneLineInput(event.args ?? event.input ?? {})}` };
  if (event.type === "tool.result") {
    const result = recordValue(event.result) ?? {};
    return { role: "tool", text: trimOneLine(typeof result.output === "string" ? result.output : flatten(result.output ?? result.content ?? event.result), 180) };
  }
  if (event.type === "content.part" && event.part?.type === "text") return { role: "reply", text: String(event.part.text ?? "") };
  return null;
}
function antigravityEntry(object) {
  const step = recordValue(object.step) ?? object;
  const type = String(step.type ?? "");
  if (type === "USER_INPUT" || type.endsWith("_USER_INPUT")) {
    return { role: "prompt", text: String(step.userInput?.userResponse ?? flatten(step.content)) };
  }
  if (type === "PLANNER_RESPONSE" || type.endsWith("_PLANNER_RESPONSE")) {
    const pr = recordValue(step.plannerResponse);
    if (pr) {
      const reply = stringValue(pr.modifiedResponse) ?? stringValue(pr.response);
      if (reply) return { role: "reply", text: reply };
      const call = Array.isArray(pr.toolCalls) ? recordValue(pr.toolCalls[0]) : null;
      if (call) return { role: "tool", text: `name=${call.name ?? "tool"} input=${oneLineInput(call.argumentsJson ?? call.arguments ?? {})}` };
    }
    return { role: "reply", text: flatten(step.content) };
  }
  return null;
}
function inferCwd(record) {
  const meta = recordValue(record);
  const cwd = stringValue(meta?.cwd) ?? stringValue(meta?.workDir);
  return cwd && cwd.trim() ? cwd : null;
}
function projectName(cwd, path2) {
  if (cwd) return basename(cwd);
  const claude = /\/\.claude\/projects\/([^/]+)/u.exec(path2);
  if (claude?.[1]) return claude[1].replace(/^-/, "").replace(/-/gu, "/").split("/").pop() || "claude";
  return basename(path2).replace(/\.jsonl$/u, "");
}
function portablePath(path2, home) {
  const rel = relative(home, path2);
  if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return { root: "HOME", relPath: rel };
  return { root: "ABSOLUTE", relPath: path2 };
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
function sniffAntigravityWorkspace(object) {
  const step = recordValue(object.step) ?? object;
  const ws = step?.userInput?.activeUserState?.activeDocument?.workspaceUri;
  if (typeof ws === "string" && ws.startsWith("file://")) {
    return decodeURIComponent(ws.slice("file://".length));
  }
  const text = typeof step?.content === "string" ? step.content : String(step?.userInput?.userResponse ?? "");
  const active = /Active Workspaces:\s*\n\s*-\s*([^\r\n<]+)/iu.exec(text);
  if (active?.[1]?.trim()) return active[1].trim();
  const cwd = /Command Working Directory:\s*([^\r\n<]+)/iu.exec(text);
  if (cwd?.[1]?.trim()) return cwd[1].trim();
  const calls = step?.plannerResponse?.toolCalls || step?.tool_calls || [];
  if (Array.isArray(calls)) {
    for (const call of calls) {
      let args = call?.args || call?.arguments || {};
      if (typeof call?.argumentsJson === "string") {
        try {
          args = JSON.parse(call.argumentsJson);
        } catch {
        }
      }
      const p = args?.Path || args?.TargetFile;
      if (typeof p === "string") {
        const devMatch = /^(\/(?:Users|home)\/[^/]+\/dev\/[^/]+)/u.exec(p);
        if (devMatch?.[1]) return devMatch[1];
      }
    }
  }
  return null;
}
async function transcriptHead(file) {
  const kimiAgent = basename(dirname(file.path));
  const kimiSession = basename(dirname(dirname(dirname(file.path))));
  let sessionId = file.sessionId ?? (file.harness === "kimi" ? kimiAgent === "main" ? kimiSession : `${kimiSession}:${kimiAgent}` : null);
  let cwd = null;
  let sessionTitle = null;
  let head = "";
  try {
    const handle2 = await open(file.path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, file.size));
      const { bytesRead } = await handle2.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle2.close();
    }
  } catch {
    return { cwd, sessionId, sessionTitle };
  }
  for (const line of head.split("\n").slice(0, -1)) {
    if (cwd && sessionId && sessionTitle) break;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      const object = recordValue(value);
      if (!object) continue;
      cwd ??= inferCwd(object.meta ?? object.payload ?? object) ?? (file.harness === "antigravity" ? sniffAntigravityWorkspace(object) : null);
      sessionId ??= file.harness === "claude" ? stringValue(object.sessionId) ?? stringValue(object.session_id) : stringValue(object.payload?.id) ?? stringValue(object.id) ?? stringValue(object.meta?.sessionId);
      if (!sessionTitle) {
        const entry = recordEntry(line, file.harness);
        if (entry?.role === "prompt") {
          sessionTitle = cleanHumanSessionTitle(entry.text);
        }
      }
    } catch {
    }
  }
  return { cwd, sessionId, sessionTitle };
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
      ...paths
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
      const nul = row.indexOf("\0");
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
      if (failed || code !== 0 && code !== 1) return resolve(false);
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
    } finally {
      stream.destroy();
    }
  }
}
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
async function scanRecent({ q, hours, harness, limit = 30, cursor, signal }) {
  const terms = [...new Set(q.toLowerCase().split(/\s+/u).filter((term) => term.length > 1))];
  if (terms.length === 0) return { hits: [], scannedFiles: 0, candidates: 0, truncated: false, next: null };
  const cutoffMs = Date.now() - hours * 36e5;
  const files = await discoverFiles(cutoffMs, harness, signal);
  const pending = files.slice(resumeIndex(files, cursor));
  const byPath = new Map(pending.map((file) => [file.path, file]));
  const phrase = terms.join(" ");
  const matchesByPath = /* @__PURE__ */ new Map();
  let collected = 0;
  let truncated = false;
  let stopped = false;
  let current = null;
  let found = 0;
  const onLine = (path2, lineNo, byte, raw) => {
    if (truncated || stopped) return;
    const file = byPath.get(path2);
    if (!file) return;
    if (current !== path2) {
      if (found >= limit) {
        stopped = true;
        return;
      }
      current = path2;
    }
    const parsedEntry = recordEntry(raw, file.harness);
    if (!parsedEntry) return;
    const body = stripHarnessBoilerplate(parsedEntry.text);
    const haystack = body.toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return;
    const snippet = scanSnippet(body, terms);
    let entry = matchesByPath.get(path2);
    if (!entry) {
      entry = { matches: [], seen: /* @__PURE__ */ new Map() };
      matchesByPath.set(path2, entry);
    }
    const key = snippet.toLowerCase();
    const earlier = entry.seen.get(key);
    if (earlier) {
      earlier.text = body;
      earlier.snippet = snippet;
      earlier.role = parsedEntry.role;
      earlier.index = lineNo - 1;
      earlier.byte = byte;
      earlier.bytes = Buffer.byteLength(raw, "utf8");
      earlier.phrase = haystack.includes(phrase);
      return;
    }
    const match = {
      text: body,
      snippet,
      role: parsedEntry.role,
      index: lineNo - 1,
      byte,
      bytes: Buffer.byteLength(raw, "utf8"),
      phrase: haystack.includes(phrase)
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
    const project = file.sessionId && !head.cwd ? sessionId : projectName(head.cwd, file.path);
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
        anchor: { sizeBytes: file.size, mtimeMs: file.mtimeMs }
      };
      const id = `basic:${stableId(`${file.path}\0${match.index}`)}`;
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
          ...head.cwd ? { projectPath: head.cwd } : {},
          ...head.sessionTitle ? { sessionTitle: head.sessionTitle } : {},
          ...match.role ? { role: match.role } : {},
          source: "sessions",
          transcriptPath: file.path,
          sessionId,
          documentKind: "events",
          match: "basic"
        }
      });
    }
  }
  const more = !truncated && last !== null && last !== pending[pending.length - 1];
  return {
    hits,
    scannedFiles: scanned,
    candidates: files.length,
    truncated,
    next: more ? { path: last.path, mtimeMs: last.mtimeMs } : null
  };
}
const exec = promisify(execFile);
const harnesses = ["claude", "codex", "kimi", "antigravity"];
class InputError extends Error {
}
function readScope(input) {
  const window = findWindow(input.window ?? defaultWindow);
  if (!window) throw new InputError(`Choose ${windowChoices()}.`);
  const harness = input.harness || "";
  if (harness && !harnesses.includes(harness)) throw new InputError("Choose Claude Code, Codex, Kimi or Antigravity.");
  return { window, harness };
}
function readLimit(input) {
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
  if (value?.v !== 1 || at?.root !== "HOME" && at?.root !== "ABSOLUTE" || typeof at?.relPath !== "string" || !at.relPath || !Number.isFinite(at?.mtimeMs)) {
    throw new InputError("That page is not valid.");
  }
  if (value.q !== scope.q || value.window !== scope.window || (value.harness || "") !== (scope.harness || "")) {
    throw new InputError("That page belongs to another search.");
  }
  return { path: absolutePath(at), mtimeMs: at.mtimeMs };
}
function readIndexPage(input, scope) {
  if (input.after == null || input.after === "") return null;
  let value;
  try {
    if (typeof input.after !== "string" || input.after.length > 2048) throw new Error();
    value = JSON.parse(Buffer.from(input.after, "base64url").toString("utf8"));
  } catch {
    throw new InputError("That page is not valid.");
  }
  const harness = Array.isArray(value?.harness) ? value.harness.join(",") : null;
  if (value?.v !== 1 || value.ftsMode !== "and" && value.ftsMode !== "or" || value.q !== scope.q || value.hours !== scope.hours || harness !== (scope.harness || "") || (value.project ?? null) !== null) {
    throw new InputError("That page belongs to another search.");
  }
  return input.after;
}
function scoutBin() {
  if (process.env.SCOUT_BIN) return process.env.SCOUT_BIN;
  const root = path.dirname(createRequire(import.meta.url).resolve("@openscout/scout/package.json"));
  return path.join(root, "bin", "scout");
}
async function scoutJson(args, signal) {
  try {
    const { stdout } = await exec(scoutBin(), ["search", ...args, "--json"], {
      signal,
      timeout: 15e3,
      maxBuffer: 4 * 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error("Scout could not read the local index. Run scout-search status in a terminal to check your installation.", { cause: error });
  }
}
async function indexStatus(signal) {
  const value = await scoutJson(["status"], signal);
  return {
    enabled: value.enabled === true,
    collections: value.readyCollections,
    chunks: value.chunks,
    lastIndexedAt: value.warmSpans?.[0]?.completedAt ?? null,
    message: value.message
  };
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
    collection: hit.collectionId,
    title: hit.title,
    excerpt: hit.snippet,
    harness: ref?.harness ?? hit.facets.harness,
    project: hit.facets.project,
    session: ref?.sessionId ?? hit.facets.sessionId ?? null,
    source,
    records: ref?.recordRange ?? null,
    updatedAt: ref?.anchor?.mtimeMs ?? null,
    ...hit.facets?.sessionTitle ? { sessionTitle: hit.facets.sessionTitle } : {},
    ...hit.facets?.role ? { role: hit.facets.role } : {}
  };
}
async function search(input, signal) {
  const { window, harness } = readScope(input);
  const mode = input.mode ?? "recent";
  if (mode !== "recent" && mode !== "index") throw new InputError("Choose recent sessions or the local index.");
  const q = typeof input.q === "string" ? input.q.trim() : "";
  if (q.length > 300 || !q.split(/\s+/u).some((s) => s.length >= 2) || /[\x00-\x1f]/u.test(q)) {
    throw new InputError("Use at least one term of two characters and up to 300 characters in total.");
  }
  if (mode === "recent") {
    const limit2 = readLimit(input);
    const scope = { q, window: window.id, harness };
    const cursor = decodeCursor(input, scope);
    const scan = await scanRecent({ q, hours: window.hours, harness: harness || void 0, limit: limit2, cursor, signal });
    return { mode, q, window: window.id, limit: limit2, hits: scan.hits.map(presentHit), next: scan.next ? encodeCursor({ v: 1, ...scope, at: cursorPath(scan.next) }) : null, coverage: {
      kind: "recent",
      window: window.id,
      scannedFiles: scan.scannedFiles,
      candidates: scan.candidates,
      partial: scan.truncated
    } };
  }
  if (q.startsWith("-")) throw new InputError("For a term beginning with a dash, use Recent sessions.");
  const limit = readLimit(input);
  const page = readIndexPage(input, { q, hours: window.hours, harness });
  const result = await scoutJson([
    "query",
    q,
    "--hours",
    String(window.hours),
    "--limit",
    String(limit),
    ...harness ? ["--harness", harness] : [],
    ...page ? ["--after", page] : []
  ], signal);
  if (!Array.isArray(result.hits) || !result.coverage?.kind) throw new Error("Scout returned an unrecognized search result.");
  return {
    mode,
    q,
    window: window.id,
    limit,
    hits: result.hits.map(presentHit),
    next: typeof result.next === "string" ? result.next : null,
    coverage: {
      ...result.coverage,
      partial: result.coverage.partial === true
    }
  };
}
const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const steps = windows.map((entry) => entry.id).join("|");
const HELP = [
  "Scout Search",
  "  scout-search [--port <n>] [--no-open]",
  `  scout-search query <text> [--mode recent|index] [--harness claude|codex|kimi|antigravity] [--window ${steps}] [--limit N] [--after <page>] [--json]`,
  "  scout-search status [--json]",
  `  scout-search index [--harness claude|codex|kimi] [--window ${steps}]`,
  "  scout-search setup",
  "",
  `Search the ${findWindow(defaultWindow).label.toLowerCase()} by default. Recent sessions work without setup.`,
  "The local index uses Scout's opt-in setting. Enable Local search index in Scout Settings > System before indexing."
].join("\n");
let activeSearches = 0;
const SERVER_OPTIONS = {
  packageName: "@openscout/search",
  product: "Search",
  distDir: DIST,
  getStatus: async () => {
    let idx = { enabled: false, collections: 0, chunks: 0, lastIndexedAt: null };
    try {
      idx = await indexStatus();
    } catch {
    }
    const recentTranscripts = discoverLocalTranscripts({ maxPerHarness: 30 }).length;
    return { ...idx, recentTranscripts };
  },
  apiHandler: async (req, res, { pathname }) => {
    if (req.method === "POST" && pathname === "/api/search") {
      if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
        sendJson(res, 400, { error: "Send a JSON search request." });
        return true;
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      try {
        const input = await readJsonBody(req, 4096);
        if (activeSearches >= 4) {
          sendJson(res, 429, { error: "Searches are running. Try again in a moment." });
          return true;
        }
        activeSearches++;
        try {
          const data = await search(input, controller.signal);
          sendJson(res, 200, data);
        } finally {
          activeSearches--;
        }
      } catch (error) {
        if (!res.destroyed) {
          const isInput = error instanceof InputError || /too large|Expected a JSON/i.test(String(error?.message));
          sendJson(res, isInput ? 400 : 503, {
            error: isInput ? error.message : "Search is unavailable. Run scout-search status in a terminal for details."
          });
        }
      }
      return true;
    }
    return false;
  }
};
const handle = createScoutThinHttpHandler(SERVER_OPTIONS);
function createServer() {
  return createScoutThinServer(SERVER_OPTIONS);
}
const createSearchServer = createServer;
function serve(port, host = "127.0.0.1") {
  return serveScoutThinServer(createServer, port, host);
}
function cli(argv = process.argv.slice(2)) {
  const str = { type: "string" };
  const bool = { type: "boolean" };
  const scopeOpts = { window: str, harness: str };
  return runScoutThinCli(
    {
      binName: "scout-search",
      packageName: "@openscout/search",
      product: "Search",
      defaultPort: 4803,
      portEnvVar: "SCOUT_SEARCH_PORT",
      distDir: DIST,
      help: HELP,
      createServer,
      getStatus: async () => {
        const status = await indexStatus();
        return {
          json: status,
          lines: [
            "Recent sessions are available on this host.",
            status.enabled ? `Local index: ${status.collections} ready collections, ${status.chunks} passages.` : String(status.message || "Local index is off.")
          ]
        };
      },
      commands: {
        index: (subArgv) => {
          const { values } = parseArgs({ args: subArgv, options: scopeOpts });
          const { window, harness } = readScope(values);
          const result = spawnSync(
            scoutBin(),
            [
              "search",
              "index",
              "--source",
              "sessions",
              "--hours",
              String(window.hours),
              ...harness ? ["--harness", harness] : [],
              "--json"
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 8 * 1024 * 1024 }
          );
          if (result.error) throw result.error;
          if (result.status !== 0) {
            process.exitCode = result.status ?? 1;
            return;
          }
          const report = JSON.parse(result.stdout);
          if (report.enabled === false) {
            console.error(report.message);
            process.exit(1);
          }
          console.log(
            `Index job ${report.state}. Indexed ${report.indexed} sessions, skipped ${report.skipped}, failed ${report.failed}.`
          );
          if (report.state !== "completed" || report.failed > 0) {
            for (const session of (report.sessions || []).filter((item) => item.error).slice(0, 8)) {
              console.error(session.error);
            }
            process.exitCode = 1;
          }
        },
        query: async (subArgv) => {
          const { values, positionals } = parseArgs({
            args: subArgv,
            options: { ...scopeOpts, mode: str, limit: str, after: str, json: bool },
            allowPositionals: true
          });
          const result = await search({ ...values, q: positionals.join(" ") });
          if (values.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          for (const hit of result.hits) {
            console.log(`[${hit.harness}] ${hit.project || hit.session}: ${hit.excerpt}`);
          }
        }
      }
    },
    argv
  );
}
export {
  DIST,
  cli,
  createSearchServer,
  createServer,
  handle,
  serve
};
