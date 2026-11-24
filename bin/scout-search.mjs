#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createServer } from "../server/serve.mjs";
import { indexStatus, readScope, scoutBin, search } from "../server/search.mjs";
import { defaultWindow, findWindow, windows } from "../shared/windows.mjs";

const steps = windows.map((entry) => entry.id).join("|");
const help = [
  "Scout Search",
  "  scout-search [--port <n>] [--no-open]",
  `  scout-search query <text> [--mode recent|index] [--harness claude|codex|kimi] [--window ${steps}] [--json]`,
  "  scout-search status [--json]",
  `  scout-search index [--harness claude|codex|kimi] [--window ${steps}]`,
  "",
  `Search the ${findWindow(defaultWindow).label.toLowerCase()} by default. Recent sessions work without setup.`,
  "The local index uses Scout's opt-in setting. Enable Local search index in Scout Settings > System before indexing.",
].join("\n");

function openBrowser(url) {
  const [command, ...args] = process.platform === "darwin" ? ["open", url] :
    process.platform === "win32" ? ["rundll32.exe", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.error("Open " + url + " in your browser."));
  child.unref();
}

async function serve(first, noOpen) {
  if (!Number.isInteger(first) || first < 1 || first > 65535) throw new Error("Use a port between 1 and 65535.");
  for (let port = first; port <= Math.min(65535, first + 9); port++) {
    const url = "http://127.0.0.1:" + port;
    const server = createServer();
    let existing = false;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      try {
        const response = await fetch(url + "/api/identity", { signal: AbortSignal.timeout(800), redirect: "error" });
        existing = response.ok && (await response.json()).app === "@openscout/search";
      } catch {}
      if (!existing) continue;
    }
    console.log((existing ? "Scout Search is already running at " : "Scout Search is running at ") + url);
    if (!noOpen) openBrowser(url);
    return;
  }
  throw new Error("Those ports are in use. Pass --port to choose another.");
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return console.log(help);
  const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "serve";
  const str = { type: "string" }, bool = { type: "boolean" };
  const scope = { window: str, harness: str };
  const flags = { serve: { port: str, "no-open": bool }, status: { json: bool }, index: scope,
    query: { ...scope, mode: str, json: bool } };
  if (!Object.hasOwn(flags, command)) throw new Error("Unknown command. Run scout-search --help.");
  const { values, positionals } = parseArgs({ args: argv, options: flags[command], allowPositionals: command === "query" });
  if (command === "serve") return serve(Number(values.port ?? process.env.SCOUT_SEARCH_PORT ?? 4803), values["no-open"]);
  if (command === "status") {
    const status = await indexStatus();
    if (values.json) return console.log(JSON.stringify(status, null, 2));
    console.log("Recent sessions are available on this host.");
    console.log(status.enabled ? "Local index: " + status.collections + " ready collections, " + status.chunks + " passages." : status.message);
    return;
  }
  if (command === "index") {
    const { window, harness } = readScope(values);
    const result = spawnSync(scoutBin(), ["search", "index", "--source", "sessions", "--hours", String(window.hours),
      ...(harness ? ["--harness", harness] : []), "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      return;
    }
    const report = JSON.parse(result.stdout);
    if (report.enabled === false) throw new Error(report.message);
    console.log("Index job " + report.state + ". Indexed " + report.indexed + " sessions, skipped " + report.skipped + ", failed " + report.failed + ".");
    if (report.state !== "completed" || report.failed > 0) {
      for (const session of (report.sessions || []).filter(item => item.error).slice(0, 8)) console.error(session.error);
      process.exitCode = 1;
    }
    return;
  }
  const result = await search({ ...values, q: positionals.join(" ") });
  if (values.json) return console.log(JSON.stringify(result, null, 2));
  const c = result.coverage;
  if (c.kind === "recent") console.log("Recent sessions · " + c.candidates + (c.candidates === 1 ? " transcript file" : " transcript files") + " read in the " + findWindow(result.window).label.toLowerCase() + (c.partial ? " · partial scan" : ""));
  else console.log(c.suggestion ?? ("Indexed coverage: " + c.kind + (c.stale ? " (stale)" : "")));
  console.log(result.hits.length + " matching passages returned.");
  for (const hit of result.hits) {
    console.log("\n" + [hit.harness, hit.project, hit.session].filter(Boolean).join(" · "));
    console.log(hit.excerpt);
    if (hit.source) console.log(hit.source + (hit.records ? " (records " + hit.records.join("–") + ")" : ""));
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  if (error.cause) console.error(error.cause.stderr?.trim() || error.cause.message);
  process.exitCode = 1;
});
