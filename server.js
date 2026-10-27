// Grok X Intelligence — live brand & topic monitoring on X, built on the xAI API.
// Zero dependencies (Node 18+).  Run:  XAI_API_KEY=xai-... node server.js
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyze, followUp } from "./lib/pipeline.js";
import { saveRun, loadRun, listRuns } from "./lib/store.js";
import { startTelegram } from "./telegram.js";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const readBody = async req => { let b = ""; for await (const c of req) b += c; return JSON.parse(b || "{}"); };
const json = (res, data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
function sse(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(await readFile(path.join(DIR, "public/index.html")));
    }
    if (req.method === "GET" && url.pathname === "/api/config") return json(res, { hasKey: !!process.env.XAI_API_KEY });
    if (req.method === "GET" && url.pathname === "/api/runs") return json(res, await listRuns());
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) return json(res, await loadRun(url.pathname.split("/").pop()));

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const { topic, days = 7, maxPosts = 25 } = await readBody(req);
      const emit = sse(res);
      try {
        const run = await analyze(String(topic).slice(0, 120), { days: Math.min(+days, 30), maxPosts: Math.min(+maxPosts, 40) }, emit);
        await saveRun(run);
        emit("done", run);
      } catch (e) { emit("error", { message: e.message }); }
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      const { runId, question } = await readBody(req);
      const emit = sse(res);
      try {
        const run = await loadRun(runId);
        const a = await followUp(run, String(question).slice(0, 500), emit);
        emit("answer", a);
      } catch (e) { emit("error", { message: e.message }); }
      return res.end();
    }
    res.writeHead(404).end();
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
}).listen(PORT, () => {
  console.log(`Grok X Intelligence → http://localhost:${PORT}`);
  if (!process.env.XAI_API_KEY) console.warn("⚠  XAI_API_KEY is not set");
  startTelegram();
});
