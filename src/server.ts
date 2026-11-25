import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createScoutThinHttpHandler,
  createScoutThinServer,
  discoverLocalTranscripts,
  readJsonBody,
  runScoutThinCli,
  sendJson,
  serveScoutThinServer,
  type ScoutThinServerOptions,
} from "scout-app/thin-server";
import { InputError, indexStatus, readScope, scoutBin, search } from "../server/search.mjs";
import { defaultWindow, findWindow, windows } from "../shared/windows.mjs";

export const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

const steps = windows.map((entry) => entry.id).join("|");
const HELP = [
  "Scout Search",
  "  scout-search [--port <n>] [--no-open]",
  `  scout-search query <text> [--mode recent|index] [--harness claude|codex|kimi|antigravity] [--window ${steps}] [--limit N] [--after <page>] [--json]`,
  "  scout-search status [--json]",
  `  scout-search index [--harness claude|codex|kimi] [--window ${steps}]`,
  "  scout-search setup",
  "",
  `Search the ${findWindow(defaultWindow)!.label.toLowerCase()} by default. Recent sessions work without setup.`,
  "The local index uses Scout's opt-in setting. Enable Local search index in Scout Settings > System before indexing.",
].join("\n");

let activeSearches = 0;

const SERVER_OPTIONS: ScoutThinServerOptions = {
  packageName: "@openscout/search",
  product: "Search",
  distDir: DIST,
  getStatus: async () => {
    let idx: Record<string, unknown> = { enabled: false, collections: 0, chunks: 0, lastIndexedAt: null };
    try {
      idx = await indexStatus();
    } catch {}
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
        const input = await readJsonBody<Record<string, unknown>>(req, 4096);
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
      } catch (error: any) {
        if (!res.destroyed) {
          const isInput = error instanceof InputError || /too large|Expected a JSON/i.test(String(error?.message));
          sendJson(res, isInput ? 400 : 503, {
            error: isInput
              ? error.message
              : "Search is unavailable. Run scout-search status in a terminal for details.",
          });
        }
      }
      return true;
    }
    return false;
  },
};

export const handle = createScoutThinHttpHandler(SERVER_OPTIONS);

export function createServer() {
  return createScoutThinServer(SERVER_OPTIONS);
}

export const createSearchServer = createServer;

export function serve(port: number, host = "127.0.0.1") {
  return serveScoutThinServer(createServer, port, host);
}

export function cli(argv = process.argv.slice(2)) {
  const str = { type: "string" as const };
  const bool = { type: "boolean" as const };
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
            status.enabled
              ? `Local index: ${status.collections} ready collections, ${status.chunks} passages.`
              : String(status.message || "Local index is off."),
          ],
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
              ...(harness ? ["--harness", harness] : []),
              "--json",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 8 * 1024 * 1024 },
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
            `Index job ${report.state}. Indexed ${report.indexed} sessions, skipped ${report.skipped}, failed ${report.failed}.`,
          );
          if (report.state !== "completed" || report.failed > 0) {
            for (const session of (report.sessions || []).filter((item: any) => item.error).slice(0, 8)) {
              console.error(session.error);
            }
            process.exitCode = 1;
          }
        },
        query: async (subArgv) => {
          const { values, positionals } = parseArgs({
            args: subArgv,
            options: { ...scopeOpts, mode: str, limit: str, after: str, json: bool },
            allowPositionals: true,
          });
          const result = await search({ ...values, q: positionals.join(" ") });
          if (values.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          for (const hit of result.hits) {
            console.log(`[${hit.harness}] ${hit.project || hit.session}: ${hit.excerpt}`);
          }
        },
      },
    },
    argv,
  );
}
