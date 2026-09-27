#!/usr/bin/env node
// Stands in for llama-server in tests: same flags, same /health, same key.
import { createServer } from "node:http";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const port = Number(arg("--port"));
const key = arg("--api-key");
const mode = process.env.FAKE_ENGINE_MODE ?? "ok";

if (mode === "crash") {
  process.stderr.write("error: model does not fit in memory\n");
  process.exit(1);
}
let ready = mode !== "slow";
if (mode === "slow") setTimeout(() => { ready = true; }, 400);

createServer((req, res) => {
  if (req.url === "/health") return res.writeHead(ready ? 200 : 503).end();
  if (req.headers.authorization !== `Bearer ${key}`) return res.writeHead(401).end();
  if (req.url === "/die") {
    res.writeHead(200).end();
    setTimeout(() => process.exit(3), 10);
    return;
  }
  if (req.url === "/args") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(args));
  res.writeHead(404).end();
}).listen(port, "127.0.0.1");

process.on("SIGTERM", () => process.exit(0));
