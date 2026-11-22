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
if (mode === "unknown") {
  // What llama-server prints for a model type it was built without.
  process.stderr.write("llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'inkling9'\n");
  process.stderr.write("0.00.770.354 E srv  server_run_i: exiting due to model loading error\n");
  process.exit(1);
}
if (mode === "nomem") {
  process.stderr.write("ggml_backend_metal_buffer_type_alloc_buffer: error: failed to allocate buffer, size = 30000.00 MiB\n");
  process.stderr.write("llama_model_load: error loading model: unable to allocate Metal buffer\n");
  process.stderr.write("0.00.770.354 E srv  server_run_i: exiting due to model loading error\n");
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
  if (req.url === "/v1/embeddings" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const { input } = JSON.parse(body);
      // A character stands for a token: a text longer than the context is refused, as llama-server does.
      if (input.some((text) => text.length > Number(arg("-c")))) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "request exceeds the available context size" } }));
        return;
      }
      // A made-up vector that shows which prefix and text came in.
      const data = input.map((text, index) => ({ index, embedding: [text.startsWith("Instruct: ") ? 3 : 0, text.startsWith("Instruct: ") ? 0 : 3, 4] }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: data.reverse() }));
    });
    return;
  }
  res.writeHead(404).end();
}).listen(port, "127.0.0.1");

process.on("SIGTERM", () => process.exit(0));
