// A synthetic OpenAI-compatible model server at LM Studio's address
// (127.0.0.1:1234), for the Linux smoke run only. Every agent turn that
// offers files_write gets one files_write call, so a task reaches its first
// approval card without a real model. Test data only.
import { createServer } from "node:http";
const log = [];
const send = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    log.push(`${req.method} ${req.url}`);
    console.error(`[mock] ${req.method} ${req.url}`);
    if (req.url === "/v1/models") return send(res, 200, { object: "list", data: [{ id: "mock-tool-model", object: "model" }] });
    if (req.url !== "/v1/chat/completions") return send(res, 404, { error: "not here" });
    const body = JSON.parse(raw || "{}");
    const tools = (body.tools ?? []).map((t) => t.function.name);
    console.error(`[mock] tools: ${tools.join(",")}`);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    const forced = body.tool_choice?.function?.name;
    const call = forced ?? (tools.includes("files_write") ? "files_write" : null);
    if (call) {
      const args = call === "files_write" ? { path: "~/Documents/vunemi-smoke.txt", content: "Synthetic smoke test.\n" } : {};
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_smoke_1", type: "function", function: { name: call, arguments: "" } }] });
      chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: "OK." });
      chunk({}, "stop");
    }
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
}).listen(1234, "127.0.0.1", () => console.error("[mock] listening on 127.0.0.1:1234"));
