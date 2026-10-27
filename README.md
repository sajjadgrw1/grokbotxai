# Grok X Intelligence

Live brand and topic monitoring on X, built on the xAI Grok API. Type a brand, product or topic. Grok searches live posts on X and the web, every post is labelled against a strict schema, the numbers are counted in code, and Grok writes a brief where every claim links to a real post. Follow-up questions make Grok run Python over the dataset.

Every model call, tool call, token count (including cached and reasoning tokens), X post fetched and dollar of cost shows in the agent trace panel.

## Run

```bash
XAI_API_KEY=xai-your-key node server.js
# open http://localhost:3000
```

Node 18+ and nothing to install. A full analysis usually takes 30–90 seconds, mostly live X search.

**Telegram (optional):** create a bot with @BotFather and add `TELEGRAM_BOT_TOKEN=...` to the command above. Message the bot a topic to get the brief in chat, then send `? your question` to follow up. It uses long polling, so it needs no public URL.

## Pipeline

| Stage | How | Why |
|---|---|---|
| 1. Collect | Responses API, server-side `x_search` (date-filtered) + `web_search` | Live data from X, which other model APIs can't search |
| 2. Verify | Code: keep only posts whose URL was in the sources Grok returned | Drops hallucinated posts before they reach the stats |
| 3. Classify | Chat Completions with a strict JSON schema; one retry if validation fails | Labels you can rely on for counting |
| 4. Measure | Code: exact counts, net sentiment, top complaint | LLMs are bad at arithmetic, and code is free |
| 5. Brief | Streamed, every finding cites a post `[n]` | Fast first output, traceable claims |
| Follow-up | Responses API with `code_interpreter` + `x_search` | Grok runs Python on the data, or searches again |

Each stage has its own model. The defaults are below and can be overridden with env vars:

| Env var | Default |
|---|---|
| `COLLECT_MODEL` | `grok-4.7` |
| `CLASSIFY_MODEL` | `grok-4.3` |
| `BRIEF_MODEL` | `grok-4.3` |
| `FOLLOWUP_MODEL` | `grok-4.7` |

For follow-ups, the stable dataset goes first in the prompt and the question last, so Grok's automatic prompt caching applies when you ask several questions about the same run.

Runs are saved to `runs/` and reopen instantly from the "Saved runs" row at no API cost.

## Files

- `lib/xai.js`: xAI client (structured, streaming, Responses API) plus usage and cost accounting
- `lib/pipeline.js`: the five stages and follow-up
- `server.js`: HTTP and server-sent events API
- `telegram.js`: optional Telegram front end
- `public/index.html`: dashboard

Prices in `lib/xai.js` are per 1M tokens plus $5 per 1,000 X posts fetched. Check console.x.ai for current rates.
