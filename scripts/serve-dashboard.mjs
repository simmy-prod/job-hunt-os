#!/usr/bin/env node
// Serves dashboard/ over http so the page can fetch data.local.json / data.json.
// Opening dashboard/index.html as a file:// path does not work: the browser
// blocks fetch() of a sibling file, so the page silently falls back to sample
// data. Run this (or `npm start`, which builds first) and open the printed URL.
// Zero dependencies, Node built-ins only. Port: $PORT or 8000.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const port = Number(process.env.PORT) || 8000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const path = join(dashboardDir, rel === "/" || rel === "" ? "index.html" : rel);
  if (!path.startsWith(dashboardDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
});

server.listen(port, () => {
  console.log(`Dashboard: http://localhost:${port}  (serving ${dashboardDir})`);
  console.log("Stop with Ctrl+C.");
});
