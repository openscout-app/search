import { createHash } from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { InputError, indexStatus, search } from "./search.mjs";

const assets = new Map([
  ["/", ["public/index.html", "text/html"]],
  ["/app.css", ["dist/app.css", "text/css"]],
  ["/search.svg", ["public/search.svg", "image/svg+xml"]],
  ["/app.js", ["dist/app.js", "text/javascript"]],
]);
const packageRoot = new URL("../", import.meta.url);

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readQuery(req) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") throw new InputError("Send a JSON search request.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new InputError("Search request is too large.");
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new InputError("Send a JSON object with a search term.");
}

export function createServer() {
  let searches = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    const port = server.address()?.port;
    const host = req.headers.host;
    if (host !== "127.0.0.1:" + port && host !== "localhost:" + port) return json(res, 421, { error: "Use the local Search address." });
    const pathname = req.url?.split("?")[0];
    if (pathname?.startsWith("/api/") && ((req.headers.origin && req.headers.origin !== "http://" + host)
      || req.headers["sec-fetch-site"] === "cross-site")) return json(res, 403, { error: "Open Scout Search on this host." });
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      if (req.method === "GET" && pathname === "/api/identity") return json(res, 200, { app: "@openscout/search" });
      if (req.method === "GET" && pathname === "/api/status") return json(res, 200, await indexStatus(controller.signal));
      if (req.method === "POST" && pathname === "/api/search") {
        const input = await readQuery(req);
        if (searches >= 2) return json(res, 429, { error: "Two searches are running. Try again in a moment." });
        searches++;
        try { return json(res, 200, await search(input, controller.signal)); }
        finally { searches--; }
      }
      const asset = assets.get(pathname);
      if (req.method === "GET" && asset) {
        const data = await readFile(new URL(asset[0], packageRoot));
        if (pathname === "/") {
          // Allow only the trusted boot stylesheet, not arbitrary inline CSS.
          const critical = /<style>([\s\S]*?)<\/style>/u.exec(data.toString("utf8"))?.[1];
          if (critical) {
            const hash = createHash("sha256").update(critical.replace(/\r\n?/gu, "\n")).digest("base64");
            res.setHeader("Content-Security-Policy",
              res.getHeader("Content-Security-Policy") + `; style-src 'self' 'sha256-${hash}'`);
          }
        }
        res.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8" });
        return res.end(data);
      }
      return json(res, 404, { error: "Page not found." });
    } catch (error) {
      if (!res.destroyed) json(res, error instanceof InputError ? 400 : 503, {
        error: error instanceof InputError ? error.message : "Search is unavailable. Run scout-search status in a terminal for details.",
      });
    }
  });
  return server;
}
