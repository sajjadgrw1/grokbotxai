// Thin xAI client: Chat Completions (plain, structured, streaming) and the
// Responses API (server-side tools: x_search, web_search, code_interpreter).
// Every call returns normalised usage so the app can show tokens and cost.

const KEY = () => process.env.XAI_API_KEY;
const BASE = () => process.env.XAI_BASE_URL || "https://api.x.ai/v1";

// $ per 1M tokens, 0–200K context tier. Check console.x.ai if prices change.
export const PRICING = {
  "grok-4.7": { in: 2.0, out: 6.0, cached: 0.5 },
  "grok-4.6": { in: 2.0, out: 6.0, cached: 0.5 },
  "grok-4.5": { in: 2.0, out: 6.0, cached: 0.3 },
  "grok-4.3": { in: 1.25, out: 2.5, cached: 0.2 },
  "grok-4.20-0309-reasoning": { in: 1.25, out: 2.5, cached: 0.2 },
  "grok-4.20-0309-non-reasoning": { in: 1.25, out: 2.5, cached: 0.2 },
};
const X_POST_FEE = 5 / 1000;   // $ per X post fetched by x_search
const X_USER_FEE = 10 / 1000;  // $ per X profile fetched

export function normaliseUsage(model, u = {}) {
  const tools = u.server_side_tool_usage_details || {};
  const n = {
    model,
    in: u.prompt_tokens ?? u.input_tokens ?? 0,
    cached: (u.prompt_tokens_details || u.input_tokens_details || {}).cached_tokens || 0,
    out: u.completion_tokens ?? u.output_tokens ?? 0,
    reasoning: (u.completion_tokens_details || u.output_tokens_details || {}).reasoning_tokens || 0,
    tools,
  };
  const p = PRICING[model] || PRICING["grok-4.3"];
  n.cost = ((n.in - n.cached) * p.in + n.cached * p.cached + n.out * p.out) / 1e6
    + (tools.x_posts_fetched || 0) * X_POST_FEE + (tools.x_users_fetched || 0) * X_USER_FEE;
  return n;
}

async function post(path, body, timeoutMs = 180_000) {
  if (!KEY()) throw new Error("XAI_API_KEY is not set");
  const res = await fetch(`${BASE()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`xAI ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// Structured output: the model must return JSON matching `schema`.
// Parses and retries once if the output is invalid.
export async function chatJSON({ model, messages, schema, name }) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    const res = await post("/chat/completions", {
      model, messages,
      response_format: { type: "json_schema", json_schema: { name, schema, strict: true } },
    });
    const data = await res.json();
    const usage = normaliseUsage(model, data.usage);
    try {
      return { data: JSON.parse(data.choices[0].message.content), usage, ms: Date.now() - t0, attempt };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Structured output failed validation twice: ${lastErr.message}`);
}

// Streaming chat: calls onToken for each text delta.
export async function chatStream({ model, messages, onToken }) {
  const t0 = Date.now();
  const res = await post("/chat/completions", { model, messages, stream: true, stream_options: { include_usage: true } });
  const dec = new TextDecoder();
  let buf = "", text = "", usage = {};
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const evt = JSON.parse(line.slice(6));
      if (evt.usage) usage = evt.usage;
      const d = evt.choices?.[0]?.delta?.content;
      if (d) { text += d; onToken(d); }
    }
  }
  return { text, usage: normaliseUsage(model, usage), ms: Date.now() - t0 };
}

// Responses API with server-side tools. Grok runs the searches / code itself.
export async function respond({ model, input, tools, maxTurns }) {
  const t0 = Date.now();
  const body = { model, input, tools };
  if (maxTurns) body.max_turns = maxTurns;
  const data = await (await post("/responses", body)).json();

  let text = data.output_text || "";
  const urls = new Set(data.citations || []);
  const calls = [];
  for (const item of data.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text") {
          if (!data.output_text) text += c.text;
          for (const a of c.annotations || []) if (a.url) urls.add(a.url);
        }
      }
    } else if (item.type?.endsWith("_call")) {
      calls.push({
        type: item.type,
        detail: item.code || item.action?.query || item.query || item.arguments || item.input || "",
        output: item.outputs || item.output || undefined,
      });
    }
  }
  return { text: text.trim(), citations: [...urls].map(u => (typeof u === "string" ? u : u.url)), calls,
           usage: normaliseUsage(model, data.usage), ms: Date.now() - t0 };
}
