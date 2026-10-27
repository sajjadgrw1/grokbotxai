// Optional Telegram front end for the same pipeline. Starts only when
// TELEGRAM_BOT_TOKEN is set. Long polling, no webhook or public URL needed.
//   any text      → analyse that topic
//   ? <question>  → follow-up on the last topic in this chat (Grok runs code / searches)
import { analyze, followUp } from "./lib/pipeline.js";
import { saveRun } from "./lib/store.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const api = (method, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(r => r.json());

const lastRun = new Map(); // chatId -> run
const busy = new Set();
const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Markdown from the brief → Telegram HTML, with [n] linked to the post on X.
function toHtml(text, posts) {
  const url = n => posts.find(p => p.n === +n)?.url;
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (_, g) => g.split(/\s*,\s*/).map(n => url(n) ? `<a href="${url(n)}">[${n}]</a>` : `[${n}]`).join(""));
}

async function handle(msg) {
  const chat = msg.chat.id, text = (msg.text || "").trim();
  if (!text) return;
  if (text === "/start" || text === "/help") {
    return api("sendMessage", { chat_id: chat, parse_mode: "HTML", text:
      "<b>Grok X Intelligence</b>\nSend a brand, product or topic and I'll read live posts on X, label them and send you a brief.\n\nThen send <code>? your question</code> to dig into the data." });
  }
  if (busy.has(chat)) return api("sendMessage", { chat_id: chat, text: "Still working on the last request…" });
  busy.add(chat);
  const noop = () => {};
  try {
    if (text.startsWith("?")) {
      const run = lastRun.get(chat);
      if (!run) return api("sendMessage", { chat_id: chat, text: "Send a topic first, then ask follow-ups with ?" });
      await api("sendChatAction", { chat_id: chat, action: "typing" });
      const a = await followUp(run, text.slice(1).trim(), noop);
      return api("sendMessage", { chat_id: chat, parse_mode: "HTML", disable_web_page_preview: true, text: toHtml(a.answer, run.posts) });
    }
    const topic = text.replace(/^\/brief\s*/, "").slice(0, 120);
    const status = await api("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `🔎 Reading X for <b>${esc(topic)}</b>… (about a minute)` });
    const run = await analyze(topic, { days: 7, maxPosts: 25 }, noop);
    await saveRun(run);
    lastRun.set(chat, run);
    const s = run.stats;
    const head = `<b>${esc(topic)}</b> · last 7 days\n${s.total} posts · net sentiment ${s.netSentiment > 0 ? "+" : ""}${s.netSentiment} · ${s.urgent} urgent\n` +
      `👍 ${s.sentiment.positive}  😐 ${s.sentiment.neutral}  👎 ${s.sentiment.negative}\n\n`;
    const foot = `\n\n<i>${run.totals.xPosts} X posts fetched · $${run.totals.cost.toFixed(3)} · ${(run.ms / 1000).toFixed(0)}s</i>\nAsk a follow-up: <code>? which complaint is most common</code>`;
    await api("editMessageText", { chat_id: chat, message_id: status.result.message_id, parse_mode: "HTML",
                                   disable_web_page_preview: true, text: head + toHtml(run.brief, run.posts) + foot });
  } catch (e) {
    await api("sendMessage", { chat_id: chat, text: "⚠ " + e.message.slice(0, 300) });
  } finally {
    busy.delete(chat);
  }
}

export async function startTelegram() {
  if (!TOKEN) return;
  const me = await api("getMe", {});
  if (!me.ok) return console.warn("Telegram: invalid TELEGRAM_BOT_TOKEN");
  console.log(`Telegram bot running → https://t.me/${me.result.username}`);
  let offset = 0;
  for (;;) {
    try {
      const r = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const u of r.result || []) {
        offset = u.update_id + 1;
        if (u.message) handle(u.message); // not awaited: chats run concurrently
      }
    } catch (e) {
      console.warn("Telegram poll error:", e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
