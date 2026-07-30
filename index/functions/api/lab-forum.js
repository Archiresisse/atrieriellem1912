/**
 * 潮汐檔案室 · 小論壇後端（Cloudflare Pages Functions）
 *
 * 部署方式：
 *   1. 這個檔案要放在「站台根目錄」的 functions/api/ 底下，不是 lab/ 裡面
 *      → 你的repo/functions/api/lab-forum.js
 *   2. Pages 專案 → Settings → Functions → KV namespace bindings
 *      新增一個綁定，Variable name 填 LAB_FORUM，選一個 KV namespace
 *   3. 推上去就會在 /api/lab-forum 生效
 *
 * 資料就存一顆 key（threads），小論壇夠用；上限 200 串。
 */

const KEY = "threads";
const MAX_THREADS = 200;
const MAX_REPLIES = 200;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

const clean = (s, max) => String(s ?? "").replace(/\s+$/g, "").slice(0, max);

export async function onRequest({ request, env }) {
  const KV = env.LAB_FORUM;
  if (!KV) return json({ error: "尚未綁定 KV：LAB_FORUM" }, 500);

  if (request.method === "GET") {
    const threads = JSON.parse((await KV.get(KEY)) || "[]");
    return json({ threads });
  }

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let b;
  try { b = await request.json(); } catch { return json({ error: "格式錯誤" }, 400); }

  if (b.hp) return json({ ok: true });                       // 蜜罐：機器人填了就假裝成功

  const threads = JSON.parse((await KV.get(KEY)) || "[]");
  const now = Date.now();

  // 同一 IP 20 秒內只能送一次
  const ip = request.headers.get("CF-Connecting-IP") || "0";
  const gate = `rl:${ip}`;
  if (await KV.get(gate)) return json({ error: "太快了，等幾秒再送。" }, 429);
  await KV.put(gate, "1", { expirationTtl: 20 });

  if (b.action === "thread") {
    const title = clean(b.title, 80), body = clean(b.body, 4000);
    if (!title || !body) return json({ error: "標題和內容都要填。" }, 400);
    threads.unshift({
      id: now.toString(36) + Math.random().toString(36).slice(2, 6),
      title, body, author: clean(b.author, 24) || "路過", ts: now, replies: []
    });
    if (threads.length > MAX_THREADS) threads.length = MAX_THREADS;

  } else if (b.action === "reply") {
    const t = threads.find(x => x.id === b.id);
    if (!t) return json({ error: "找不到這一串。" }, 404);
    const body = clean(b.body, 2000);
    if (!body) return json({ error: "回覆是空的。" }, 400);
    t.replies = t.replies || [];
    if (t.replies.length >= MAX_REPLIES) return json({ error: "這串回覆滿了。" }, 400);
    t.replies.push({ author: clean(b.author, 24) || "路過", body, ts: now });

  } else {
    return json({ error: "未知動作" }, 400);
  }

  await KV.put(KEY, JSON.stringify(threads));
  return json({ ok: true });
}
