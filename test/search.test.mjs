import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "../server/serve.mjs";
import { scoutBin } from "../server/search.mjs";

const exec = promisify(execFile);
let home, env, server, url, roots;
// Ask the CLI the app will actually use whether it can continue an index page.
// This runs before the test home replaces the environment, and before the test
// definitions below read the answer.
let pagesSupported = false;
try {
  pagesSupported = (await exec(scoutBin(), ["search", "query", "--help"])).stdout.includes("--after");
} catch {}
const previous = new Map();
const cli = (...args) => exec(process.execPath, ["bin/scout-search.mjs", ...args], { env });
const post = (query, headers = {}) => fetch(url + "/api/search", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(query),
});

before(async () => {
  home = await mkdtemp(join(tmpdir(), "search-test-"));
  const paths = {
    HOME: home, OPENSCOUT_INSTANCE: "prod", OPENSCOUT_HOME: join(home, ".openscout"),
    OPENSCOUT_CONTROL_HOME: join(home, "control"), OPENSCOUT_SUPPORT_DIRECTORY: join(home, "support"),
    OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT: join(home, ".codex/sessions"),
    OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT: join(home, ".claude/projects"),
    OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT: join(home, ".kimi-code/sessions"),
    OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT: join(home, "antigravity-test-brain"),
  };
  for (const [key, value] of Object.entries(paths)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  previous.set("SCOUT_BIN", process.env.SCOUT_BIN);
  delete process.env.SCOUT_BIN;
  assert.equal(homedir(), home);
  env = { ...process.env };
  roots = paths;
  const root = join(paths.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT, "2026/01/01");
  await mkdir(root, { recursive: true });
  await mkdir(paths.OPENSCOUT_SUPPORT_DIRECTORY);
  await writeFile(join(root, "rollout-example.jsonl"), [
    { type: "session_meta", payload: { id: "fixture-session", cwd: "/work/atlas" } },
    { type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: "The export queue uses a single writer for checkpoint files." }] } },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = "http://127.0.0.1:" + server.address().port;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (home) await rm(home, { recursive: true, force: true });
});

test("browser and CLI find a source in a fresh home with indexing off", async () => {
  const r = await post({ q: "checkpoint", harness: "codex" });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.coverage.kind, "recent");
  assert.equal(data.coverage.scannedFiles, 1);
  assert.equal(data.hits.length, 1);
  assert.equal(data.hits[0].session, "fixture-session");
  assert.equal(data.hits[0].project, "atlas");
  assert.deepEqual(data.hits[0].records, [1, 1]);
  assert.match(data.hits[0].source, /^~\/\.codex\/sessions\//);
  const result = JSON.parse((await cli("query", "checkpoint", "--harness", "codex", "--json")).stdout);
  assert.deepEqual(result, data);
  assert.equal((await (await post({ q: "checkpoint", harness: "kimi" })).json()).hits.length, 0);
  await assert.rejects(access(join(home, "control/knowledge/knowledge.sqlite")));
});

test("index opt-out and uncovered windows stay distinct from no matches", async () => {
  const q = { q: "checkpoint", mode: "index", harness: "codex" };
  const query = async () => (await post(q)).json();
  assert.equal((await query()).coverage.kind, "index_off");
  await assert.rejects(cli("index", "--window", "3d"), error => error.code === 1 && error.stderr.includes("Search index is off"));
  assert.equal((await (await fetch(url + "/api/status")).json()).enabled, false);
  await assert.rejects(access(join(home, "control/knowledge/knowledge.sqlite")));
  await writeFile(join(home, "support/settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
  assert.equal((await query()).coverage.kind, "empty_index");
  await cli("index", "--window", "3d", "--harness", "codex");
  const data = await query();
  assert.equal(data.coverage.kind, "warmed");
  assert.ok(data.hits.some(hit => hit.session === "fixture-session" && hit.excerpt.includes("checkpoint")));
  const none = await (await post({ ...q, q: "unfindable" })).json();
  assert.equal(none.coverage.kind, "warmed");
  assert.deepEqual(none.hits, []);
  assert.equal((await (await post({ ...q, window: "30d" })).json()).coverage.kind, "not_warmed");
});

test("accepts only local API traffic and bounded queries", async () => {
  assert.equal((await post({ q: "checkpoint" }, { Origin: "https://example.org" })).status, 403);
  assert.equal((await post({ q: "checkpoint" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ q: "checkpoint", harness: "unknown" })).status, 400);
  assert.equal((await post({ q: "checkpoint", window: "5h" })).status, 400);
  assert.equal((await post({ q: "x" })).status, 400);
  assert.equal((await post({ q: "--help", mode: "index" })).status, 400);
  assert.equal((await fetch(url + "/api/identity")).status, 200);
  assert.match(await (await fetch(url)).text(), /Scout Search/);
});

test("serves the built Search controls and theme from the same local origin", async () => {
  const page = await fetch(url);
  const html = await page.text();
  assert.match(html, /<div id="root">\s*<div data-scout-boot="search">[\s\S]*Scout Search[\s\S]*Recent transcripts/u);
  const critical = /<style>([\s\S]*?)<\/style>/u.exec(html)[1];
  const hash = createHash("sha256").update(critical).digest("base64");
  assert.ok(page.headers.get("content-security-policy").includes(`style-src 'self' 'sha256-${hash}'`));
  for (const [path, mime, marker] of [
    ["/app.js", "text/javascript", "Copy reference"],
    ["/app.css", "text/css", "--hud-ink"],
  ]) {
    assert.ok(html.includes(path));
    const asset = await fetch(url + path);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get("content-type").startsWith(mime));
    assert.ok((await asset.text()).includes(marker));
  }
});

test("a window search pages through every transcript in the window", async () => {
  const dir = join(roots.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT, "2026/02/01");
  await mkdir(dir, { recursive: true });
  await Promise.all(Array.from({ length: 120 }, (_, index) => writeFile(
    join(dir, `rollout-batch-${index}.jsonl`),
    [
      { type: "session_meta", payload: { id: `batch-${index}`, cwd: `/work/batch-${index}` } },
      { type: "response_item", payload: { type: "message", role: "assistant",
        content: [{ type: "output_text", text: `batchmarker passage ${index}` }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
  )));
  const sessions = new Set();
  let total = 0;
  let page = await (await post({ q: "batchmarker" })).json();
  assert.equal(page.hits.length, 30);
  assert.ok(page.next);
  for (;;) {
    total += page.hits.length;
    for (const hit of page.hits) sessions.add(hit.session);
    if (!page.next) break;
    page = await (await post({ q: "batchmarker", after: page.next })).json();
  }
  assert.equal(total, 120);
  assert.equal(sessions.size, 120);
  assert.equal(page.coverage.candidates, 121);
  assert.equal(page.next, null);

  const small = await (await post({ q: "batchmarker", limit: 7 })).json();
  assert.equal(small.hits.length, 7);
  assert.ok(small.next);
  const again = await (await post({ q: "batchmarker", limit: 7, after: small.next })).json();
  assert.equal(again.hits.length, 7);
  assert.equal(new Set([...small.hits, ...again.hits].map((hit) => hit.session)).size, 14);

  const wrong = await post({ q: "lantern", after: small.next });
  assert.equal(wrong.status, 400);
  assert.equal((await post({ q: "batchmarker", after: "not-a-page" })).status, 400);
  assert.equal((await post({ q: "batchmarker", limit: 0 })).status, 400);
  assert.equal((await post({ q: "batchmarker", limit: 501 })).status, 400);
  assert.equal((await post({ q: "batchmarker", mode: "index", after: small.next })).status, 400);
});

test("the local index pages with the token it returned", {
  skip: pagesSupported ? false : "needs @openscout/scout with search query --after",
}, async () => {
  // This test owns the opt-in it depends on, so it also runs alone.
  await writeFile(join(roots.OPENSCOUT_SUPPORT_DIRECTORY, "settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
  const dir = join(roots.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT, "2026/03/01");
  await mkdir(dir, { recursive: true });
  const rows = [{ type: "session_meta", payload: { id: "index-pages", cwd: "/work/pages" } }];
  for (let index = 0; index < 5; index++) {
    rows.push({ type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: `pageword passage ${index}` }] } });
  }
  // Each session is chunked separately, so several files give the index
  // enough passages to page through.
  for (let file = 0; file < 3; file++) {
    await writeFile(join(dir, `rollout-index-pages-${file}.jsonl`),
      [{ type: "session_meta", payload: { id: `index-pages-${file}`, cwd: `/work/pages-${file}` } },
        ...rows.slice(1)].map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  await cli("index", "--window", "3d", "--harness", "codex");

  const key = (hit) => `${hit.session}:${hit.source}:${(hit.records ?? []).join("-")}:${hit.excerpt}`;
  const single = await (await post({ q: "pageword", mode: "index", harness: "codex", limit: 500 })).json();
  assert.ok(single.hits.length >= 4);
  assert.equal(single.next, null);

  const collected = [];
  let after;
  let pages = 0;
  for (;;) {
    const page = await (await post({ q: "pageword", mode: "index", harness: "codex", limit: 2, ...(after ? { after } : {}) })).json();
    pages++;
    collected.push(...page.hits.map(key));
    if (!page.next) break;
    after = page.next;
  }
  assert.ok(pages > 1, "the page token continued the search");
  assert.deepEqual(collected.sort(), single.hits.map(key).sort());
  assert.equal(typeof after, "string");

  assert.equal((await post({ q: "otherword", mode: "index", harness: "codex", after: after })).status, 400);
  assert.equal((await post({ q: "pageword", mode: "index", harness: "codex", window: "30d", after: after })).status, 400);
  assert.equal((await post({ q: "pageword", mode: "index", after: "not-a-page" })).status, 400);
});

test("returns every matching passage in one session", async () => {
  const dir = join(roots.OPENSCOUT_TAIL_CODEX_SESSIONS_ROOT, "2026/02/02");
  await mkdir(dir, { recursive: true });
  const rows = [{ type: "session_meta", payload: { id: "many-hits", cwd: "/work/many" } }];
  for (let index = 0; index < 12; index++) {
    rows.push({ type: "response_item", payload: { type: "message", role: "assistant",
      content: [{ type: "output_text", text: `lantern number ${index}` }] } });
  }
  await writeFile(join(dir, "rollout-many.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const data = await (await post({ q: "lantern" })).json();
  assert.equal(data.hits.length, 12);
  assert.deepEqual([...new Set(data.hits.map((hit) => hit.session))], ["many-hits"]);
  assert.deepEqual(data.hits.map((hit) => hit.records[0]).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
});

test("reads Claude Code and Kimi transcripts", async () => {
  const claudeDir = join(roots.OPENSCOUT_TAIL_CLAUDE_PROJECTS_ROOT, "-work-atlas");
  await mkdir(claudeDir, { recursive: true });
  await writeFile(join(claudeDir, "claude-one.jsonl"), [
    { type: "user", sessionId: "claude-session", uuid: "u1",
      message: { role: "user", content: [{ type: "text", text: "the harbor parser keeps a queue" }] } },
    { type: "assistant", sessionId: "claude-session", uuid: "u2",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "rg harbor" } }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const kimiDir = join(roots.OPENSCOUT_TAIL_KIMI_SESSIONS_ROOT, "wd_atlas", "session_kimi_one", "agents", "main");
  await mkdir(kimiDir, { recursive: true });
  await writeFile(join(kimiDir, "wire.jsonl"), [
    { type: "turn.prompt", time: 1795452419, input: [{ type: "text", text: "wire harbor kimi" }] },
    { type: "context.append_loop_event", time: 1795452420, event: { type: "content.part", part: { type: "text", text: "harbor reply" } } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const claude = await (await post({ q: "harbor", harness: "claude" })).json();
  assert.equal(claude.hits.length, 2);
  assert.equal(claude.hits[0].harness, "claude");
  assert.equal(claude.hits[0].session, "claude-session");
  assert.equal(claude.hits[0].project, "atlas");
  assert.match(claude.hits[0].source, /^~\/\.claude\/projects\//u);
  const kimi = await (await post({ q: "harbor", harness: "kimi" })).json();
  assert.equal(kimi.hits.length, 2);
  assert.equal(kimi.hits[0].harness, "kimi");
  assert.equal(kimi.hits[0].session, "session_kimi_one");
});

test("searches Antigravity conversations and CLI transcript logs", async () => {
  const desktop = join(home, ".gemini", "antigravity", "conversations");
  const brain = join(roots.OPENSCOUT_TAIL_ANTIGRAVITY_BRAIN_ROOT, "cli-session", ".system_generated", "logs");
  await mkdir(desktop, { recursive: true });
  await mkdir(brain, { recursive: true });
  const rows = [
    { step_index: 0, type: "SYSTEM_MESSAGE", content: "moonstone system instructions" },
    { step_index: 1, type: "USER_INPUT", content: "Find the moonstone cache" },
    { step_index: 2, type: "PLANNER_RESPONSE", content: "The moonstone cache is ready", thinking: "private notes" },
  ];
  const jsonl = (records) => records.map((row) => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(join(brain, "transcript.jsonl"), jsonl(rows));
  await writeFile(join(brain, "other.jsonl"), jsonl(rows));
  await writeFile(join(desktop, "desktop-session.jsonl"), jsonl(rows.slice(1, 2)));

  const response = await post({ q: "moonstone", harness: "antigravity" });
  assert.equal(response.status, 200);
  const { hits, coverage } = await response.json();
  assert.equal(coverage.candidates, 2);
  assert.equal(hits.length, 3);
  assert.ok(hits.every((hit) => hit.harness === "antigravity"));
  assert.ok(hits.some((hit) => hit.session === "desktop-session"));
  const cliHit = hits.find((hit) => hit.session === "cli-session" && hit.excerpt === rows[2].content);
  assert.deepEqual(cliHit?.records, [2, 2]);
  assert.equal(cliHit?.source, "~/antigravity-test-brain/cli-session/.system_generated/logs/transcript.jsonl");
});

test("the window steps are the only scope", async () => {
  for (const step of ["4h", "24h", "3d", "7d", "30d"]) {
    const response = await post({ q: "checkpoint", window: step });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).coverage.window, step);
  }
  assert.equal((await post({ q: "checkpoint", window: "5h" })).status, 400);
  assert.equal((await post({ q: "checkpoint", window: "90d" })).status, 400);
  assert.equal((await post({ q: "checkpoint", window: 72 })).status, 400);
});
