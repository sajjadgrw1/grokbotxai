// The analysis pipeline. Each stage uses the cheapest tool that is reliable for it:
//   1. collect   Grok + server-side x_search & web_search   (live data)
//   2. verify    plain code: keep posts whose URL Grok actually retrieved
//   3. classify  Grok structured output (strict JSON schema)
//   4. measure   plain code: exact counts, no LLM arithmetic
//   5. brief     Grok, streamed, citing post numbers
// Follow-up questions go back to Grok with x_search + code_interpreter.
import { respond, chatJSON, chatStream } from "./xai.js";

const MODELS = {
  collect: () => process.env.COLLECT_MODEL || "grok-4.7",
  classify: () => process.env.CLASSIFY_MODEL || "grok-4.3",
  brief: () => process.env.BRIEF_MODEL || "grok-4.3",
  followup: () => process.env.FOLLOWUP_MODEL || "grok-4.7",
};

export const THEMES = ["bug_or_outage", "pricing", "feature_request", "praise", "comparison", "news", "support", "other"];

const day = d => d.toISOString().slice(0, 10);

// ---------- 1. collect ----------
async function collect(topic, { days, maxPosts }, emit) {
  const from = day(new Date(Date.now() - days * 864e5));
  const to = day(new Date(Date.now() + 864e5)); // to_date is exclusive
  const input = `Research what people are saying on X about "${topic}" from ${from} until today.
Run several x_search queries from different angles: complaints, praise, pricing, bugs or outages, comparisons with competitors, news.
Run one web_search for recent news context.

Return up to ${maxPosts} distinct posts you actually retrieved, newest first. One line per post, exactly:
POST | <full x.com status URL> | @handle | YYYY-MM-DD | <likes as a number, or ?> | <post text on one line>

Then one final line:
CONTEXT | <2 sentences of news context from the web>

Only list posts you retrieved with a tool. Never invent or guess a URL.`;

  emit("stage", { id: "collect", status: "running", label: "Searching X and the web" });
  const r = await respond({
    model: MODELS.collect(),
    input,
    tools: [{ type: "x_search", from_date: from, to_date: to }, { type: "web_search" }],
  });
  for (const c of r.calls) emit("trace", { kind: "tool", title: c.type, detail: String(c.detail).slice(0, 400) });
  emit("trace", { kind: "model", title: `collect · ${r.usage.model}`, usage: r.usage, ms: r.ms });
  emit("stage", { id: "collect", status: "done", ms: r.ms });
  return r;
}

// ---------- 2. verify ----------
const normUrl = u => String(u).toLowerCase().replace("twitter.com", "x.com").replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
const statusId = u => (String(u).match(/status\/(\d+)/) || [])[1];

function parsePosts(text, citations) {
  const cited = new Set(citations.map(normUrl));
  const citedIds = new Set(citations.map(statusId).filter(Boolean));
  const posts = [], seen = new Set();
  let context = "";
  for (const line of text.split("\n")) {
    const parts = line.split("|").map(s => s.trim());
    if (parts[0] === "CONTEXT") context = parts.slice(1).join(" | ");
    if (parts[0] !== "POST" || parts.length < 6) continue;
    const [, url, handle, date, likes, ...rest] = parts;
    if (!/^https?:\/\/(x|twitter)\.com\/.+\/status\/\d+/i.test(url) || seen.has(statusId(url))) continue;
    seen.add(statusId(url));
    posts.push({
      n: posts.length + 1, url, handle: handle.startsWith("@") ? handle : "@" + handle, date,
      likes: /^\d+$/.test(likes) ? +likes : null, text: rest.join(" | "),
      verified: citations.length ? cited.has(normUrl(url)) || citedIds.has(statusId(url)) : null,
    });
  }
  return { posts, context };
}

// ---------- 3. classify ----------
const CLASSIFY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["posts"],
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["n", "sentiment", "theme", "urgency", "summary"],
        properties: {
          n: { type: "integer" },
          sentiment: { type: "string", enum: ["positive", "neutral", "negative"] },
          theme: { type: "string", enum: THEMES },
          urgency: { type: "string", enum: ["low", "medium", "high"] },
          summary: { type: "string", description: "What the post says, max 12 words" },
        },
      },
    },
  },
};

async function classify(topic, posts, emit) {
  emit("stage", { id: "classify", status: "running", label: `Classifying ${posts.length} posts` });
  const r = await chatJSON({
    model: MODELS.classify(), name: "post_labels", schema: CLASSIFY_SCHEMA,
    messages: [
      { role: "system", content: `You label social posts about a product or topic for a brand team.
urgency=high only for outages, safety issues, legal risk or a post going viral with complaints.
Label every post you are given, keeping its number n.` },
      { role: "user", content: `Topic: ${topic}\n\n` + posts.map(p => `[${p.n}] ${p.handle}: ${p.text}`).join("\n") },
    ],
  });
  const byN = new Map(r.data.posts.map(l => [l.n, l]));
  const labelled = posts.map(p => ({ ...p, ...(byN.get(p.n) || { sentiment: "neutral", theme: "other", urgency: "low", summary: p.text.slice(0, 80) }) }));
  emit("trace", { kind: "model", title: `classify · structured output${r.attempt > 1 ? " (retried)" : ""}`, usage: r.usage, ms: r.ms,
                  detail: `${posts.filter(p => byN.has(p.n)).length}/${posts.length} posts labelled against a strict JSON schema` });
  emit("stage", { id: "classify", status: "done", ms: r.ms });
  return { posts: labelled, usage: r.usage };
}

// ---------- 4. measure ----------
function measure(posts) {
  const count = (key, vals) => Object.fromEntries(vals.map(v => [v, posts.filter(p => p[key] === v).length]));
  const sentiment = count("sentiment", ["positive", "neutral", "negative"]);
  const themes = count("theme", THEMES);
  const total = posts.length || 1;
  const negThemes = count("theme", THEMES);
  for (const t of THEMES) negThemes[t] = posts.filter(p => p.theme === t && p.sentiment === "negative").length;
  const topComplaint = Object.entries(negThemes).sort((a, b) => b[1] - a[1])[0];
  return {
    total: posts.length,
    sentiment,
    netSentiment: Math.round(((sentiment.positive - sentiment.negative) / total) * 100),
    themes,
    urgent: posts.filter(p => p.urgency === "high").length,
    topComplaint: topComplaint && topComplaint[1] ? topComplaint[0] : null,
    verified: posts.filter(p => p.verified).length,
  };
}

// ---------- 5. brief ----------
async function brief(topic, posts, stats, context, emit) {
  emit("stage", { id: "brief", status: "running", label: "Writing the brief" });
  const r = await chatStream({
    model: MODELS.brief(),
    messages: [
      { role: "system", content: `You write short intelligence briefs for a brand or product lead.
Format: one bold headline line, then "Key findings" with 3 bullets, "Watch" with 1-2 bullets, "Recommended actions" with 2 bullets.
Cite posts as [n]. Use only the data given. Max 170 words. Markdown: **bold** and "- " bullets only.` },
      { role: "user", content: `Topic: ${topic}\nStats (computed exactly): ${JSON.stringify(stats)}\nWeb context: ${context || "none"}\n\nPosts:\n` +
        posts.map(p => `[${p.n}] ${p.sentiment}/${p.theme}/${p.urgency} ${p.handle} (${p.likes ?? "?"} likes): ${p.text}`).join("\n") },
    ],
    onToken: t => emit("token", { text: t }),
  });
  emit("trace", { kind: "model", title: `brief · streamed`, usage: r.usage, ms: r.ms });
  emit("stage", { id: "brief", status: "done", ms: r.ms });
  return r;
}

export async function analyze(topic, opts, emit) {
  const started = Date.now();
  const usages = [];
  const c = await collect(topic, opts, emit); usages.push(c.usage);

  const { posts: parsed, context } = parsePosts(c.text, c.citations);
  // Drop posts whose URL Grok never retrieved (likely hallucinated). Safeguard: if most
  // posts fail to match, the citation format probably changed, so keep all and flag them.
  const ok = parsed.filter(p => p.verified === true).length;
  const strict = c.citations.length > 0 && ok >= parsed.length / 2;
  const raw = (strict ? parsed.filter(p => p.verified) : parsed).map((p, i) => ({ ...p, n: i + 1 }));
  emit("trace", { kind: "code", title: "verify · citation check",
                  detail: `${parsed.length} posts parsed · ${c.citations.length} source URLs returned by x_search\n` +
                    (strict ? `${parsed.length - raw.length} post(s) with no matching source dropped`
                            : `source matching inconclusive, all posts kept and flagged`) });
  if (!raw.length) throw new Error("No posts found for that topic in the time window. Try a broader topic or more days.");

  const cl = await classify(topic, raw, emit); usages.push(cl.usage);
  const stats = measure(cl.posts);
  emit("trace", { kind: "code", title: "measure · exact counts", detail: JSON.stringify(stats) });
  emit("posts", { posts: cl.posts, stats, context });

  const b = await brief(topic, cl.posts, stats, context, emit); usages.push(b.usage);

  const totals = sumUsage(usages);
  return { id: Date.now().toString(36), topic, days: opts.days, createdAt: new Date().toISOString(),
           posts: cl.posts, stats, context, brief: b.text, totals, ms: Date.now() - started };
}

export async function followUp(run, question, emit) {
  emit("stage", { id: "followup", status: "running", label: "Grok is working on it" });
  // Stable context first, question last: lets Grok's automatic prompt caching hit on repeat questions.
  const input = `You are an analyst. Below is a JSON dataset of X posts about "${run.topic}" that were already collected and labelled.
Use code_interpreter for any counting, percentages or comparisons over this data. Use x_search only if the answer needs posts that are not in the dataset.
Cite posts from the dataset as [n]. Answer in under 120 words.

DATASET:
${JSON.stringify(run.posts.map(({ n, handle, date, likes, sentiment, theme, urgency, text }) => ({ n, handle, date, likes, sentiment, theme, urgency, text })))}

QUESTION: ${question}`;
  const r = await respond({ model: MODELS.followup(), input, tools: [{ type: "code_interpreter" }, { type: "x_search" }] });
  for (const c of r.calls) emit("trace", { kind: "tool", title: c.type, detail: String(c.detail).slice(0, 600) });
  emit("trace", { kind: "model", title: `follow-up · ${r.usage.model}`, usage: r.usage, ms: r.ms });
  emit("stage", { id: "followup", status: "done", ms: r.ms });
  return { answer: r.text, citations: r.citations, usage: r.usage };
}

export function sumUsage(list) {
  const t = { in: 0, cached: 0, out: 0, reasoning: 0, cost: 0, xPosts: 0, searches: 0, codeRuns: 0 };
  for (const u of list) {
    t.in += u.in; t.cached += u.cached; t.out += u.out; t.reasoning += u.reasoning; t.cost += u.cost;
    t.xPosts += u.tools.x_posts_fetched || 0;
    t.searches += (u.tools.x_search_calls || 0) + (u.tools.web_search_calls || 0);
    t.codeRuns += u.tools.code_interpreter_calls || 0;
  }
  return t;
}
