// Tiny static server for the demo app: node examples/demo-app/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? process.env.DEMO_PORT ?? 4173);
const pages = { "/": "index.html", "/index.html": "index.html", "/todos": "todos.html", "/todos.html": "todos.html" };

http
  .createServer((req, res) => {
    const file = pages[new URL(req.url, "http://x").pathname];
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    if (!file) return res.writeHead(404).end("Not found");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(path.join(dir, file)).pipe(res);
  })
  .listen(port, () => console.log(`Demo app on http://localhost:${port}`));
