import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "../server/serve.mjs";

const exec = promisify(execFile);
let home, env, server, url;
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
  };
  for (const [key, value] of Object.entries(paths)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  previous.set("SCOUT_BIN", process.env.SCOUT_BIN);
  delete process.env.SCOUT_BIN;
  assert.equal(homedir(), home);
  env = { ...process.env };
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
  await assert.rejects(cli("index", "--hours", "72"), error => error.code === 1 && error.stderr.includes("Search index is off"));
  assert.equal((await (await fetch(url + "/api/status")).json()).enabled, false);
  await assert.rejects(access(join(home, "control/knowledge/knowledge.sqlite")));
  await writeFile(join(home, "support/settings.json"), JSON.stringify({ knowledgeIndexEnabled: true }));
  assert.equal((await query()).coverage.kind, "empty_index");
  await cli("index", "--hours", "72", "--harness", "codex");
  const data = await query();
  assert.equal(data.coverage.kind, "warmed");
  assert.ok(data.hits.some(hit => hit.session === "fixture-session" && hit.excerpt.includes("checkpoint")));
  const none = await (await post({ ...q, q: "unfindable" })).json();
  assert.equal(none.coverage.kind, "warmed");
  assert.deepEqual(none.hits, []);
  assert.equal((await (await post({ ...q, hours: 720 })).json()).coverage.kind, "not_warmed");
});

test("accepts only local API traffic and bounded queries", async () => {
  assert.equal((await post({ q: "checkpoint" }, { Origin: "https://example.org" })).status, 403);
  assert.equal((await post({ q: "checkpoint" }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post({ q: "checkpoint", harness: "unknown" })).status, 400);
  assert.equal((await post({ q: "checkpoint", hours: 721 })).status, 400);
  assert.equal((await post({ q: "x" })).status, 400);
  assert.equal((await post({ q: "--help", mode: "index" })).status, 400);
  assert.equal((await fetch(url + "/api/identity")).status, 200);
  assert.match(await (await fetch(url)).text(), /Scout Search/);
});

test("serves the built Search controls and theme from the same local origin", async () => {
  const page = await fetch(url);
  const html = await page.text();
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
