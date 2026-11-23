// packages/runtime/src/knowledge/boilerplate.ts
function stripHarnessBoilerplate(text) {
  return text.replace(/<(recommended_plugins|local-command-caveat|system-reminder|system_reminder)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, "").trim();
}

// packages/runtime/src/support-paths.ts
import { dirname as dirname2, join as join2 } from "node:path";

// packages/runtime/src/instance.ts
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
var OPENSCOUT_PROD_INSTANCE = "prod";
var OPENSCOUT_DEV_INSTANCE = "dev";
var OPENSCOUT_INSTANCES_DIRECTORY = "instances";
var OPENSCOUT_PROD_PORTS = {
  broker: 43110,
  roomListening: 43112,
  mcp: 43115,
  web: 43120,
  webTerminalRelay: 43121,
  vite: 43122,
  pairingBridge: 43130,
  pairingRelay: 43131,
  pairingFileServer: 43132,
  studio: 43140,
  jetstream: 43150,
  jetstreamMonitor: 43151
};
var OPENSCOUT_INSTANCE_PORT_BLOCK_START = 24400;
var OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE = 50;
var OPENSCOUT_INSTANCE_PORT_BLOCK_COUNT = 120;
var INSTANCE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

class OpenScoutInstanceError extends Error {
  violations;
  constructor(message, violations = []) {
    super(message);
    this.name = "OpenScoutInstanceError";
    this.violations = violations;
  }
}
function normalizeOpenScoutInstanceName(raw) {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed || trimmed === "default" || trimmed === "production")
    return OPENSCOUT_PROD_INSTANCE;
  const normalized = trimmed.replace(/[\s_.]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  if (!INSTANCE_NAME_PATTERN.test(normalized)) {
    throw new OpenScoutInstanceError(`Invalid OPENSCOUT_INSTANCE ${JSON.stringify(raw)}: use 1-40 characters of a-z, 0-9 and '-', ` + "starting and ending with a letter or digit (for example `dev` or `dev-feature`).");
  }
  return normalized;
}
function resolveOpenScoutInstanceName(env = process.env) {
  return normalizeOpenScoutInstanceName(env.OPENSCOUT_INSTANCE);
}
function isProdOpenScoutInstance(name) {
  return name === OPENSCOUT_PROD_INSTANCE;
}
function fnv1a(input) {
  let hash = 2166136261;
  for (let index = 0;index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
var OPENSCOUT_INSTANCE_AVOIDED_PORTS = [
  24800,
  25565,
  25672,
  26257,
  27017,
  27018,
  27019,
  28015,
  30000
];
var LEGACY_LEDGER_FILE = ".ledger.json";
function openScoutInstanceRegistryDir(env = process.env, home = homedir()) {
  return env.OPENSCOUT_INSTANCE_REGISTRY?.trim() || join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY);
}
function slotsDir(env, home) {
  return join(openScoutInstanceRegistryDir(env, home), ".slots");
}
function claimsDir(env, home) {
  return join(openScoutInstanceRegistryDir(env, home), ".claims");
}
function slotPath(env, home, base) {
  return join(slotsDir(env, home), String(base));
}
function claimPath(env, home, name) {
  return join(claimsDir(env, home), `${name}.json`);
}
function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function parseClaim(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.portBase !== "number" || !Number.isInteger(parsed.portBase))
      return null;
    return {
      portBase: parsed.portBase,
      ...typeof parsed.root === "string" ? { root: parsed.root } : {},
      ...typeof parsed.checkout === "string" ? { checkout: parsed.checkout } : {},
      ...parsed.explicitBase === true ? { explicitBase: true } : {},
      claimedAt: typeof parsed.claimedAt === "number" ? parsed.claimedAt : 0
    };
  } catch {
    return null;
  }
}
function readClaim(env, home, name) {
  const path = claimPath(env, home, name);
  const raw = readText(path);
  if (raw === null)
    return { state: "missing" };
  const entry = parseClaim(raw);
  return entry ? { state: "ok", entry } : { state: "corrupt", path };
}
function readSlotOwner(env, home, base) {
  const raw = readText(slotPath(env, home, base));
  return raw === null ? null : raw.trim();
}
function listSlots(env, home) {
  const slots = {};
  let names = [];
  try {
    names = readdirSync(slotsDir(env, home));
  } catch {
    return slots;
  }
  for (const file of names) {
    if (!/^\d+$/.test(file))
      continue;
    const owner = readSlotOwner(env, home, Number(file));
    if (owner !== null)
      slots[Number(file)] = owner;
  }
  return slots;
}
function legacyLedgerPath(env, home) {
  return join(openScoutInstanceRegistryDir(env, home), LEGACY_LEDGER_FILE);
}
function registryView(env, home, name) {
  const instances = {};
  const legacy = readText(legacyLedgerPath(env, home));
  if (legacy !== null) {
    try {
      const parsed = JSON.parse(legacy);
      for (const [other, value] of Object.entries(parsed?.instances ?? {})) {
        const entry = parseClaim(JSON.stringify(value));
        if (entry)
          instances[other] = entry;
      }
    } catch {}
  }
  const own = readClaim(env, home, name);
  if (own.state === "ok")
    instances[name] = own.entry;
  else if (own.state === "corrupt" && openScoutInstanceNeedsLedger(name, env)) {
    throw corruptClaimError(name, own.path);
  }
  return { version: 1, instances, slots: listSlots(env, home) };
}
function corruptClaimError(name, path) {
  return new OpenScoutInstanceError(`The registry claim for OpenScout instance "${name}" (${path}) is unreadable. ` + "Run `scout instance repair` (it rebuilds the claim from the instance's slot and root), " + "or set OPENSCOUT_INSTANCE_PORT_BASE meanwhile.");
}
function blockIsAvoided(base) {
  return OPENSCOUT_INSTANCE_AVOIDED_PORTS.some((port) => port >= base && port < base + OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE);
}
function slotBase(slot) {
  return OPENSCOUT_INSTANCE_PORT_BLOCK_START + slot * OPENSCOUT_INSTANCE_PORT_BLOCK_SIZE;
}
function candidateBases(name) {
  const slots = OPENSCOUT_INSTANCE_PORT_BLOCK_COUNT - 1;
  const start = fnv1a(name) % slots;
  const bases = [];
  for (let offset = 0;offset < slots; offset += 1) {
    const base = slotBase(1 + (start + offset) % slots);
    if (!blockIsAvoided(base))
      bases.push(base);
  }
  return bases;
}
function openScoutInstancePortBase(name, env = process.env, ledger = { version: 1, instances: {} }) {
  if (isProdOpenScoutInstance(name))
    return OPENSCOUT_PROD_PORTS.broker;
  const explicit = parsePort(env.OPENSCOUT_INSTANCE_PORT_BASE);
  if (explicit !== undefined)
    return explicit;
  if (name === OPENSCOUT_DEV_INSTANCE)
    return slotBase(0);
  const recorded = ledger.instances[name]?.portBase;
  if (typeof recorded === "number" && Number.isInteger(recorded))
    return recorded;
  const taken = new Set([slotBase(0)]);
  for (const [other, entry] of Object.entries(ledger.instances)) {
    if (other !== name)
      taken.add(entry.portBase);
  }
  for (const [base, owner] of Object.entries(ledger.slots ?? {})) {
    if (owner !== name)
      taken.add(Number(base));
  }
  const free = candidateBases(name).find((base) => !taken.has(base));
  if (free === undefined)
    throw noFreeBlockError(name);
  return free;
}
function noFreeBlockError(name) {
  return new OpenScoutInstanceError(`No free OpenScout instance port block for "${name}": every block is claimed. ` + "See `scout instance list` (it prunes dead instances) and free one with " + "`scout instance release <name>`, or set OPENSCOUT_INSTANCE_PORT_BASE.");
}
function openScoutInstanceNeedsLedger(name, env = process.env) {
  if (isProdOpenScoutInstance(name))
    return false;
  if (name === OPENSCOUT_DEV_INSTANCE)
    return false;
  return parsePort(env.OPENSCOUT_INSTANCE_PORT_BASE) === undefined;
}
var PRUNE_GRACE_MS = 60 * 60000;
function deriveOpenScoutInstancePorts(name, env = process.env, ledger) {
  const base = openScoutInstancePortBase(name, env, ledger);
  const ports = {};
  for (const [key, prodPort] of Object.entries(OPENSCOUT_PROD_PORTS)) {
    ports[key] = base + (prodPort - OPENSCOUT_PROD_PORTS.broker);
  }
  return ports;
}
function normalizeOpenScoutHostLabel(value) {
  const firstLabel = (value ?? "").trim().replace(/\.local\.?$/i, "").split(".").find((part) => part.trim().length > 0) ?? "";
  const normalized = firstLabel.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return normalized || "localhost";
}
function prodOpenScoutSupportDirectory(home, platform, env) {
  if (platform === "darwin")
    return join(home, "Library", "Application Support", "OpenScout");
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return join(xdgDataHome || join(home, ".local", "share"), "openscout");
}
function deriveOpenScoutInstanceLayout(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const name = options.name !== undefined ? normalizeOpenScoutInstanceName(options.name) : resolveOpenScoutInstanceName(env);
  const isProd = isProdOpenScoutInstance(name);
  const hostLabel = normalizeOpenScoutHostLabel(options.hostname ?? osHostname());
  const ledger = isProd ? undefined : registryView(env, home, name);
  const ports = deriveOpenScoutInstancePorts(name, env, ledger);
  const meshId = env.OPENSCOUT_MESH_ID?.trim() || "openscout";
  if (isProd) {
    const openscoutHome = join(home, ".openscout");
    const supportDirectory = prodOpenScoutSupportDirectory(home, platform, env);
    const scoutHome = join(home, ".scout");
    const runtimeDirectory = join(supportDirectory, "runtime");
    return {
      name,
      isProd,
      root: null,
      openscoutHome,
      controlHome: join(openscoutHome, "control-plane"),
      supportDirectory,
      runtimeDirectory,
      relayHub: join(openscoutHome, "relay"),
      scoutHome,
      pairingHome: join(scoutHome, "pairing"),
      localEdgeDirectory: join(scoutHome, "local-edge"),
      brokerSocketPath: join(runtimeDirectory, "broker.sock"),
      appSocketPath: join(openscoutHome, "run", "scout-app.sock"),
      probesSocketPath: join(openscoutHome, "run", "scoutd-probes.sock"),
      ports,
      hostLabel,
      nodeName: options.hostname ?? osHostname(),
      nodeQualifier: hostLabel,
      nodeId: null,
      serviceLabel: "app.openscout",
      systemdUnitName: "scout.service",
      meshAllowed: true
    };
  }
  const explicitRoot = env.OPENSCOUT_INSTANCE_ROOT?.trim();
  const root = explicitRoot ? resolve(expandHome(explicitRoot, home)) : ledger?.instances[name]?.root ?? join(home, ".openscout", OPENSCOUT_INSTANCES_DIRECTORY, name);
  const supportDirectory = join(root, "support");
  const runtimeDirectory = join(supportDirectory, "runtime");
  const nodeQualifier = `${hostLabel}-${name}`;
  return {
    name,
    isProd,
    root,
    openscoutHome: root,
    controlHome: join(root, "control-plane"),
    supportDirectory,
    runtimeDirectory,
    relayHub: join(root, "relay"),
    scoutHome: root,
    pairingHome: join(root, "pairing"),
    localEdgeDirectory: join(root, "local-edge"),
    brokerSocketPath: join(runtimeDirectory, "broker.sock"),
    appSocketPath: join(root, "run", "scout-app.sock"),
    probesSocketPath: join(root, "run", "scoutd-probes.sock"),
    ports,
    hostLabel,
    nodeName: nodeQualifier,
    nodeQualifier,
    nodeId: `${nodeQualifier}-${normalizeOpenScoutHostLabel(meshId)}`,
    serviceLabel: `app.openscout.${name}`,
    systemdUnitName: `scout-${name}.service`,
    meshAllowed: readBoolean(env.OPENSCOUT_INSTANCE_MESH) === true
  };
}
function parsePort(value) {
  const raw = value?.trim();
  if (!raw)
    return;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
}
function readBoolean(value) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized)
    return;
  if (["1", "true", "yes", "on"].includes(normalized))
    return true;
  if (["0", "false", "no", "off"].includes(normalized))
    return false;
  return;
}
function expandHome(value, home) {
  if (value === "~")
    return home;
  if (value.startsWith("~/"))
    return join(home, value.slice(2));
  return value;
}

// packages/runtime/src/support-paths.ts
var OPENSCOUT_RPC_CUTOVER_MARKER = "rpc-runtime-cutover-v1";
function envPath(key) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}
function resolveOpenScoutSupportPaths() {
  const layout = deriveOpenScoutInstanceLayout();
  const supportDirectory = envPath("OPENSCOUT_SUPPORT_DIRECTORY") ?? layout.supportDirectory;
  const logsDirectory = join2(supportDirectory, "logs");
  const runtimeDirectory = join2(supportDirectory, "runtime");
  const catalogDirectory = join2(supportDirectory, "catalog");
  const controlHome = envPath("OPENSCOUT_CONTROL_HOME") ?? layout.controlHome;
  const knowledgeDirectory = join2(controlHome, "knowledge");
  return {
    supportDirectory,
    logsDirectory,
    appLogsDirectory: join2(logsDirectory, "app"),
    brokerLogsDirectory: join2(logsDirectory, "broker"),
    runtimeDirectory,
    catalogDirectory,
    relayAgentsDirectory: join2(runtimeDirectory, "agents"),
    settingsPath: join2(supportDirectory, "settings.json"),
    harnessCatalogPath: join2(catalogDirectory, "harness-catalog.json"),
    relayAgentsRegistryPath: join2(supportDirectory, "relay-agents.json"),
    managedInstallsPath: join2(supportDirectory, "managed-installs.json"),
    hostInfoPath: join2(supportDirectory, ".host-info"),
    relayHubDirectory: envPath("OPENSCOUT_RELAY_HUB") ?? layout.relayHub,
    controlHome,
    knowledgeDirectory,
    knowledgeQmdDirectory: join2(knowledgeDirectory, "qmd"),
    knowledgeSqlitePath: join2(knowledgeDirectory, "knowledge.sqlite"),
    desktopStatusPath: join2(supportDirectory, "agent-status.json"),
    workspaceStatePath: join2(supportDirectory, "workspace-state.json"),
    cutoverMarkerPath: join2(supportDirectory, OPENSCOUT_RPC_CUTOVER_MARKER)
  };
}

// packages/runtime/src/knowledge/paths.ts
function resolveOpenScoutKnowledgePaths() {
  const supportPaths = resolveOpenScoutSupportPaths();
  return {
    knowledgeRoot: supportPaths.knowledgeDirectory,
    qmdRoot: supportPaths.knowledgeQmdDirectory,
    sqlitePath: supportPaths.knowledgeSqlitePath
  };
}

// packages/runtime/src/knowledge/limits.ts
var KNOWLEDGE_MAX_BYTES = 256 * 1024 * 1024;
// packages/runtime/src/knowledge/session-indexer.ts
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync as existsSync2,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  statSync as statSync2
} from "node:fs";
import { spawn } from "node:child_process";
import { open, opendir, stat } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, dirname as dirname3, join as join3, relative as relative2, sep as sep2 } from "node:path";

// packages/runtime/src/knowledge/store.ts
var KNOWLEDGE_WARM_SPAN_STALE_MS = 6 * 60 * 60 * 1000;
var STALE_INDEX_JOB_MS = 10 * 60 * 1000;

// packages/runtime/src/knowledge/session-indexer.ts
var DEFAULT_DAYS = 3;
var KNOWN_HARNESSES = ["codex", "claude", "kimi"];
function clampPositiveInt(value, fallback, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return fallback;
  return Math.min(max, Math.floor(value));
}
function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
function createYieldBudget(intervalMs = 12) {
  let last = Date.now();
  return async () => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      await yieldToEventLoop();
      last = Date.now();
    }
  };
}
function normalizeHarnessFilter(value) {
  if (value == null)
    return null;
  const raw = Array.isArray(value) ? value : [value];
  const selected = new Set;
  for (const entry of raw) {
    const key = entry.trim().toLowerCase();
    if (!key)
      continue;
    if (KNOWN_HARNESSES.includes(key)) {
      selected.add(key);
    }
  }
  return selected.size > 0 ? selected : null;
}
function sessionRoots(harnessFilter) {
  const home = homedir2();
  const kimiHome = process.env.KIMI_CODE_HOME?.trim() || join3(home, ".kimi-code");
  const roots = [
    { harness: "codex", root: process.env.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT ?? join3(home, ".codex", "sessions") },
    { harness: "codex", root: join3(home, ".openai-codex", "sessions") },
    { harness: "claude", root: process.env.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT ?? join3(home, ".claude", "projects") },
    { harness: "kimi", root: process.env.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT ?? join3(kimiHome, "sessions") }
  ];
  return roots.filter((entry, index, entries) => existsSync2(entry.root) && (harnessFilter == null || harnessFilter.has(entry.harness)) && entries.findIndex((candidate) => candidate.harness === entry.harness && candidate.root === entry.root) === index);
}
function isHarnessTranscriptFile(harness, entry) {
  if (harness === "kimi")
    return entry === "wire.jsonl";
  return entry.endsWith(".jsonl");
}
function normalizeRecord(obj, i, sourceOffset, harness) {
  if (harness === "codex")
    return normalizeCodex(obj, i, sourceOffset);
  if (harness === "claude")
    return normalizeClaude(obj, i, sourceOffset);
  return normalizeKimi(obj, i, sourceOffset);
}
function normalizeCodex(obj, i, sourceOffset) {
  const type = String(obj.type ?? "");
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
  const payload = recordValue(obj.payload) ?? {};
  const base = { i, ts, sourceType: type, sourceOffset };
  if (type === "session_meta") {
    return {
      ...base,
      kind: "session_meta",
      tag: "meta",
      meta: payload,
      refs: { sessionId: stringValue(payload.id) }
    };
  }
  if (type === "turn_context") {
    return { ...base, kind: "system_record", tag: "turn_context", meta: payload };
  }
  if (type === "response_item")
    return normalizeCodexInner(payload, base);
  if (type === "event_msg")
    return normalizeCodexEvent(payload, base);
  if (type === "message")
    return normalizeCodexMessage(payload, base);
  if (type === "function_call" || type === "local_shell_call")
    return normalizeCodexTool(payload, base);
  if (type === "function_call_output" || type === "local_shell_call_output")
    return normalizeCodexResult(payload, base);
  if (type === "reasoning")
    return normalizeCodexReasoning(payload, base);
  return { ...base, kind: "system_record", tag: type || "record", text: compactJson(payload) };
}
function normalizeCodexInner(payload, base) {
  const type = String(payload.type ?? "");
  if (type === "message")
    return normalizeCodexMessage(payload, base);
  if (type === "reasoning")
    return normalizeCodexReasoning(payload, base);
  if (type === "function_call" || type === "local_shell_call")
    return normalizeCodexTool(payload, base);
  if (type === "function_call_output" || type === "local_shell_call_output")
    return normalizeCodexResult(payload, base);
  return { ...base, kind: "system_record", tag: type || "response_item", meta: payload };
}
function normalizeCodexEvent(payload, base) {
  const type = String(payload.type ?? "");
  if (type === "user_message") {
    return { ...base, kind: "user_turn", tag: "user", text: String(payload.message ?? payload.text ?? "") };
  }
  if (type === "agent_message") {
    return { ...base, kind: "assistant_turn", tag: "assistant", text: String(payload.message ?? payload.text ?? "") };
  }
  return { ...base, kind: "system_record", tag: type || "event_msg", meta: payload };
}
function normalizeCodexMessage(payload, base) {
  const role = String(payload.role ?? "");
  const text = extractText(payload.content);
  if (role === "user")
    return { ...base, kind: "user_turn", tag: "user", text };
  if (role === "assistant")
    return { ...base, kind: "assistant_turn", tag: "assistant", text };
  return { ...base, kind: "system_record", tag: role || "message", text };
}
function normalizeCodexTool(payload, base) {
  const name = String(payload.name ?? payload.command ?? "tool");
  const input = payload.arguments ?? payload.args ?? payload.input ?? {};
  return { ...base, kind: "command_or_tool", tag: name, tool: { name, input } };
}
function normalizeCodexResult(payload, base) {
  return { ...base, kind: "observation", tag: "result", result: { output: payload.output ?? payload.content ?? "" } };
}
function normalizeCodexReasoning(payload, base) {
  let text = "";
  if (Array.isArray(payload.summary)) {
    text = payload.summary.map((entry) => recordValue(entry)?.text).filter((entry) => typeof entry === "string").join(" ");
  }
  return { ...base, kind: "assistant_turn", tag: "reasoning", text: text || stringValue(payload.content) || "" };
}
function normalizeClaude(obj, i, sourceOffset) {
  const type = String(obj.type ?? "");
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
  const refs = {
    id: stringValue(obj.uuid),
    parentId: stringValue(obj.parentUuid),
    sessionId: stringValue(obj.sessionId) ?? stringValue(obj.session_id)
  };
  const base = { i, ts, sourceType: type, sourceOffset, refs };
  if (type === "user") {
    const message = recordValue(obj.message);
    return { ...base, kind: "user_turn", tag: "user", text: extractText(message?.content ?? obj.content) };
  }
  if (type === "assistant") {
    const message = recordValue(obj.message);
    const content = message?.content ?? obj.content;
    const tool = Array.isArray(content) ? content.map(recordValue).find((entry) => entry?.type === "tool_use") : null;
    if (tool) {
      const name = String(tool.name ?? "tool");
      return {
        ...base,
        kind: "command_or_tool",
        tag: name,
        sourceType: "tool_use",
        tool: { name, input: tool.input ?? {} }
      };
    }
    return { ...base, kind: "assistant_turn", tag: "assistant", text: extractText(content) };
  }
  if (type === "tool_use") {
    const name = String(obj.name ?? "tool");
    return { ...base, kind: "command_or_tool", tag: name, tool: { name, input: obj.input ?? {} } };
  }
  if (type === "tool_result") {
    return { ...base, kind: "observation", tag: "result", result: { output: obj.content ?? "" } };
  }
  if (type === "system") {
    return { ...base, kind: "system_record", tag: "system", text: extractText(obj.content) };
  }
  return { ...base, kind: "system_record", tag: type || "record", meta: obj };
}
function kimiTimestamp(obj) {
  const raw = obj.time ?? obj.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw < 1000000000000 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
  }
  return;
}
function normalizeKimi(obj, i, sourceOffset) {
  const type = String(obj.type ?? "");
  const ts = kimiTimestamp(obj);
  const base = { i, ts, sourceType: type, sourceOffset };
  if (type === "turn.prompt" || type === "turn.steer") {
    return {
      ...base,
      kind: "user_turn",
      tag: type === "turn.steer" ? "steer" : "user",
      text: extractText(obj.input ?? obj.content)
    };
  }
  if (type === "context.append_message") {
    const message = recordValue(obj.message) ?? {};
    const role = String(message.role ?? "");
    const text = extractText(message.content);
    if (role === "assistant")
      return { ...base, kind: "assistant_turn", tag: "assistant", text };
    return { ...base, kind: "user_turn", tag: role || "user", text };
  }
  if (type === "context.append_loop_event") {
    const event = recordValue(obj.event) ?? {};
    const eventType = String(event.type ?? "");
    const eventBase = {
      ...base,
      sourceType: eventType || type,
      refs: {
        id: stringValue(event.uuid) ?? stringValue(event.toolCallId),
        parentId: stringValue(event.parentUuid)
      }
    };
    if (eventType === "tool.call") {
      const name = String(event.name ?? "tool");
      return {
        ...eventBase,
        kind: "command_or_tool",
        tag: name,
        tool: { name, input: event.args ?? event.input ?? {} }
      };
    }
    if (eventType === "tool.result") {
      const result = recordValue(event.result) ?? {};
      return {
        ...eventBase,
        kind: "observation",
        tag: "result",
        result: { output: result.output ?? result.content ?? event.result ?? "" },
        refs: {
          ...eventBase.refs,
          id: stringValue(event.toolCallId) ?? eventBase.refs.id,
          parentId: stringValue(event.parentUuid)
        }
      };
    }
    if (eventType === "content.part") {
      const part = recordValue(event.part) ?? {};
      if (part.type === "text" && typeof part.text === "string") {
        return { ...eventBase, kind: "assistant_turn", tag: "assistant", text: part.text };
      }
      if (part.type === "think") {
        return { ...eventBase, kind: "system_record", tag: "think" };
      }
      return { ...eventBase, kind: "system_record", tag: eventType || "part", meta: event };
    }
    return { ...eventBase, kind: "system_record", tag: eventType || "loop_event", meta: event };
  }
  if (type === "metadata" || type === "config.update") {
    return { ...base, kind: "session_meta", tag: "meta", meta: obj };
  }
  return { ...base, kind: "system_record", tag: type || "record", meta: obj };
}
function inferCwd(record) {
  const meta = record.meta;
  const cwd = stringValue(meta?.cwd) ?? stringValue(meta?.workDir);
  return cwd && cwd.trim() ? cwd : null;
}
function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function extractText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.map((entry) => {
    if (typeof entry === "string")
      return entry;
    const block = recordValue(entry);
    if (!block)
      return "";
    if (typeof block.text === "string")
      return block.text;
    if (typeof block.content === "string")
      return block.content;
    return "";
  }).filter(Boolean).join(" ");
}
function compactJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
function trimOneLine(value, max) {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 3))}...`;
}
function stableId(value, length = 16) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}
function portablePath(filePath) {
  const home = homedir2();
  const paths = resolveOpenScoutKnowledgePaths();
  const roots = [
    { root: "OPENSCOUT_CONTROL_HOME", path: paths.knowledgeRoot.replace(new RegExp(`${sep2}knowledge$`), "") },
    { root: "HOME", path: home }
  ];
  for (const root of roots) {
    const rel = relative2(root.path, filePath);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep2)) {
      return { root: root.root, relPath: rel };
    }
  }
  return { root: "ABSOLUTE", relPath: filePath };
}
function projectName(cwd, filePath) {
  if (cwd)
    return basename2(cwd);
  const claudeProjectMatch = /\/\.claude\/projects\/([^/]+)/u.exec(filePath);
  if (claudeProjectMatch?.[1])
    return claudeProjectMatch[1].replace(/^-/, "").replace(/-/g, "/").split("/").pop() || "claude";
  return basename2(filePath).replace(/\.jsonl$/u, "");
}
function oneLineInput(input) {
  const text = typeof input === "string" ? input : compactJson(input ?? {});
  return trimOneLine(text, 120);
}
function summarizeRecord(record) {
  if (record.text)
    return trimOneLine(record.text, 180);
  if (record.tool)
    return `name=${record.tool.name} input=${oneLineInput(record.tool.input)}`;
  if (record.result) {
    const output = typeof record.result.output === "string" ? record.result.output : compactJson(record.result.output ?? "");
    return trimOneLine(output, 180);
  }
  if (record.meta)
    return trimOneLine(compactJson(record.meta), 180);
  return "";
}
var SCAN_HITS_PER_FILE = 3;
var SCAN_RG_MAX_PER_FILE = 200;
var SCAN_RG_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
var SCAN_HEAD_BYTES = 256 * 1024;
function scanSnippet(text, terms) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 220)
    return compact;
  const index = compact.toLowerCase().indexOf(terms[0] ?? "");
  const start = Math.max(0, index >= 0 ? index - 70 : 0);
  const end = Math.min(compact.length, start + 220);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}
async function discoverScanFiles(cutoffMs, limit, harnessFilter, budget) {
  const files = [];
  let inspected = 0;
  for (const { harness, root } of sessionRoots(harnessFilter)) {
    const stack = [root];
    const visited = new Set;
    while (stack.length && !budget.stopped()) {
      const directory = stack.pop();
      try {
        const directoryStat = await stat(directory);
        const identity = `${directoryStat.dev}:${directoryStat.ino}`;
        if (visited.has(identity) || budget.stopped())
          continue;
        visited.add(identity);
        const entries = await opendir(directory);
        for await (const entry of entries) {
          if (budget.stopped())
            break;
          if (++inspected % 32 === 0)
            await yieldToEventLoop();
          if (budget.stopped())
            break;
          const path = join3(directory, entry.name);
          if (entry.isDirectory()) {
            stack.push(path);
            continue;
          }
          if (!entry.isSymbolicLink() && !isHarnessTranscriptFile(harness, entry.name))
            continue;
          let info;
          try {
            info = await stat(path);
          } catch {
            continue;
          }
          if (budget.stopped())
            break;
          if (info.isDirectory()) {
            stack.push(path);
            continue;
          }
          if (!isHarnessTranscriptFile(harness, entry.name) || info.mtimeMs < cutoffMs)
            continue;
          files.push({ harness, path, mtimeMs: info.mtimeMs, size: info.size });
          files.sort((left, right) => right.mtimeMs - left.mtimeMs);
          if (files.length > limit)
            files.pop();
        }
      } catch {}
    }
    if (budget.stopped())
      break;
  }
  return files;
}
var ripgrepPath;
function findRipgrep() {
  const override = process.env.OPENSCOUT_RG_PATH;
  if (override === "none")
    return null;
  if (override && existsSync2(override))
    return override;
  if (ripgrepPath !== undefined)
    return ripgrepPath;
  const candidates = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"];
  for (const dir of (process.env.PATH ?? "").split(":"))
    if (dir)
      candidates.push(join3(dir, "rg"));
  ripgrepPath = candidates.find((candidate) => existsSync2(candidate)) ?? null;
  return ripgrepPath;
}
function ripgrepLines(files, needle, budget) {
  const rg = findRipgrep();
  if (!rg)
    return Promise.resolve(null);
  if (!files.length || budget.stopped())
    return Promise.resolve({ lines: new Map, read: 0, truncated: budget.stopped() });
  return new Promise((resolve) => {
    const out = new Map;
    const child = spawn(rg, [
      "--ignore-case",
      "--fixed-strings",
      "--line-number",
      "--byte-offset",
      "--no-heading",
      "--with-filename",
      "--null",
      "--no-messages",
      "--max-count",
      String(SCAN_RG_MAX_PER_FILE),
      "--",
      needle,
      ...files
    ], { stdio: ["ignore", "pipe", "ignore"] });
    let carry = "";
    let received = 0;
    let capped = false;
    let failed = false;
    let killTimer;
    const stop = () => {
      child.kill();
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
    };
    budget.signal.addEventListener("abort", stop, { once: true });
    if (budget.stopped())
      stop();
    const take = (line) => {
      const nul = line.indexOf("\x00");
      if (nul < 0)
        return;
      const path = line.slice(0, nul);
      const match = /^(\d+):(\d+):/u.exec(line.slice(nul + 1));
      if (!match)
        return;
      const list = out.get(path) ?? [];
      list.push({ lineNo: Number(match[1]), byte: Number(match[2]), text: line.slice(nul + 1 + match[0].length) });
      out.set(path, list);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (capped || budget.stopped())
        return;
      received += Buffer.byteLength(chunk, "utf8");
      if (received > SCAN_RG_MAX_OUTPUT_BYTES) {
        capped = true;
        stop();
        return;
      }
      carry += chunk;
      const lines = carry.split(`
`);
      carry = lines.pop() ?? "";
      for (const line of lines)
        take(line);
    });
    child.on("error", () => {
      failed = true;
    });
    child.on("close", (code) => {
      if (killTimer)
        clearTimeout(killTimer);
      budget.signal.removeEventListener("abort", stop);
      if (carry && !capped)
        take(carry);
      const completed = !capped && !budget.stopped() && (code === 0 || code === 1);
      resolve(failed && !budget.stopped() ? null : {
        lines: out,
        read: completed ? files.length : out.size,
        truncated: !completed
      });
    });
  });
}
async function readerLines(files, terms, budget) {
  const out = new Map;
  const maybeYield = createYieldBudget();
  let read = 0;
  let matchedBytes = 0;
  let capped = false;
  for (const path of files) {
    if (budget.stopped() || capped)
      break;
    const stream = createReadStream(path, { encoding: "utf8", signal: budget.signal, highWaterMark: 64 * 1024 });
    const list = [];
    let carry = "";
    let byte = 0;
    let lineNo = 0;
    let readAny = false;
    let completed = false;
    const take = (text) => {
      lineNo++;
      const lower = text.toLowerCase();
      if (terms.every((term) => lower.includes(term))) {
        matchedBytes += Buffer.byteLength(text, "utf8");
        if (matchedBytes > SCAN_RG_MAX_OUTPUT_BYTES)
          capped = true;
        else
          list.push({ lineNo, byte, text });
      }
      byte += Buffer.byteLength(text, "utf8") + 1;
    };
    try {
      for await (const chunk of stream) {
        if (budget.stopped())
          break;
        readAny = true;
        carry += chunk;
        let newline;
        while ((newline = carry.indexOf(`
`)) >= 0) {
          take(carry.slice(0, newline));
          carry = carry.slice(newline + 1);
          await maybeYield();
          if (budget.stopped() || capped)
            break;
        }
        if (Buffer.byteLength(carry, "utf8") > SCAN_RG_MAX_OUTPUT_BYTES)
          capped = true;
        if (budget.stopped() || capped)
          break;
      }
      if (carry && !budget.stopped() && !capped)
        take(carry);
      completed = !budget.stopped() && !capped;
    } catch {} finally {
      stream.destroy();
    }
    if (readAny || completed)
      read++;
    if (list.length)
      out.set(path, list);
  }
  return { lines: out, read, truncated: capped || budget.stopped() || read < files.length };
}
async function transcriptHead(file) {
  let cwd = null;
  const kimiAgent = basename2(dirname3(file.path));
  const kimiSession = basename2(dirname3(dirname3(dirname3(file.path))));
  let sessionId = file.harness === "kimi" ? kimiAgent === "main" ? kimiSession : `${kimiSession}:${kimiAgent}` : null;
  let head = "";
  try {
    const handle = await open(file.path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(SCAN_HEAD_BYTES, file.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return { cwd, sessionId };
  }
  let index = 0;
  for (const line of head.split(`
`).slice(0, -1)) {
    if (cwd && sessionId)
      break;
    if (!line.trim())
      continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value))
        continue;
      const record = normalizeRecord(value, index++, 0, file.harness);
      cwd ??= inferCwd(record);
      sessionId ??= record.refs?.sessionId ?? stringValue(record.meta?.id) ?? stringValue(record.meta?.sessionId) ?? null;
    } catch {}
  }
  return { cwd, sessionId };
}
async function scanRecentSessionKnowledge(input) {
  const terms = [...new Set(input.q.toLowerCase().split(/\s+/u).filter((term) => term.length > 1))];
  if (terms.length === 0)
    return { hits: [], scannedFiles: 0, totalFiles: 0, truncated: false };
  const days = clampPositiveInt(input.days, DEFAULT_DAYS, 30);
  const cutoffMs = Math.max(Date.now() - days * 24 * 60 * 60 * 1000, input.updatedAfterMs ?? 0);
  const limit = clampPositiveInt(input.limit, 30, 200);
  input.signal?.throwIfAborted();
  const budgetMs = clampPositiveInt(input.budgetMs, 2500, 15000);
  const deadline = Date.now() + budgetMs;
  const controller = new AbortController;
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const budget = { signal: controller.signal, stopped: () => controller.signal.aborted || Date.now() >= deadline };
  try {
    const files = await discoverScanFiles(cutoffMs, clampPositiveInt(input.fileLimit, 80, 400), normalizeHarnessFilter(input.harness), budget);
    const paths = files.map((file) => file.path);
    const needle = [...terms].sort((left, right) => right.length - left.length)[0];
    const rg = await ripgrepLines(paths, needle, budget);
    const fallback = rg ? null : await readerLines(paths, terms, budget);
    const lines = rg?.lines ?? fallback.lines;
    const scannedFiles = rg?.read ?? fallback.read;
    let truncated = (rg?.truncated ?? fallback.truncated) || budget.stopped();
    const maybeYield = createYieldBudget();
    const phrase = terms.join(" ");
    const hits = [];
    for (const file of files) {
      input.signal?.throwIfAborted();
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      const candidates = lines.get(file.path);
      if (!candidates?.length)
        continue;
      const matches = [];
      for (const line of candidates) {
        await maybeYield();
        input.signal?.throwIfAborted();
        const lower = line.text.toLowerCase();
        if (!terms.every((term) => lower.includes(term)))
          continue;
        let record;
        try {
          const value = JSON.parse(line.text);
          if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
          record = normalizeRecord(value, line.lineNo - 1, line.byte, file.harness);
        } catch {
          continue;
        }
        if (record.kind === "system_record" || record.kind === "unknown" || record.kind === "session_meta")
          continue;
        const text = stripHarnessBoilerplate(record.text ?? summarizeRecord(record));
        const haystack = text.toLowerCase();
        if (!terms.every((term) => haystack.includes(term)))
          continue;
        matches.push({ record, text, byte: line.byte, bytes: Buffer.byteLength(line.text, "utf8"), phrase: haystack.includes(phrase) });
      }
      if (matches.length === 0)
        continue;
      matches.sort((left, right) => Number(right.phrase) - Number(left.phrase) || right.record.i - left.record.i);
      input.signal?.throwIfAborted();
      const head = await transcriptHead(file);
      input.signal?.throwIfAborted();
      const resolvedSession = head.sessionId ?? basename2(file.path).replace(/\.jsonl$/u, "");
      const project = projectName(head.cwd, file.path);
      const collectionId = `sessions/${file.harness}/${resolvedSession.replace(/[^A-Za-z0-9_.-]+/gu, "-").slice(0, 80)}-${stableId(file.path, 10)}`;
      const when = new Date(file.mtimeMs).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      for (const match of matches.slice(0, SCAN_HITS_PER_FILE)) {
        if (hits.length >= limit)
          break;
        const sourceRef = {
          kind: "harness_transcript",
          harness: file.harness,
          path: portablePath(file.path),
          sessionId: resolvedSession,
          recordRange: [match.record.i, match.record.i],
          byteRange: [match.byte, match.byte + match.bytes],
          anchor: { sizeBytes: file.size, mtimeMs: file.mtimeMs }
        };
        const id = `basic:${stableId(`${file.path}\x00${match.record.i}`)}`;
        hits.push({
          id,
          collectionId,
          documentId: `${collectionId}/basic`,
          chunkId: id,
          title: `${file.harness} ${project} ${when} - ${trimOneLine(match.text, 80)}`,
          snippet: scanSnippet(match.text, terms),
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
            source: "sessions",
            transcriptPath: file.path,
            sessionId: resolvedSession,
            documentKind: "events",
            match: "basic"
          }
        });
      }
    }
    input.signal?.throwIfAborted();
    return { hits, scannedFiles, totalFiles: files.length, truncated };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abort);
  }
}
export {
  scanRecentSessionKnowledge
};
