/**
 * 潮汐檔案室 · 小論壇後端（Cloudflare Pages Functions）
 *
 * 放置位置：站台根目錄的 functions/api/lab-forum.js（不是 lab/ 裡面）
 * KV 綁定：Pages 專案 → Settings → Functions → KV namespace bindings
 *          Variable name 填 LAB_FORUM
 * 生效網址：/api/lab-forum
 */

const KEY = "threads";
const MAX_THREADS = 200;
const MAX_REPLIES = 200;
const COOLDOWN_MS = 15000;      // 同一 IP 冷卻 15 秒

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });

const clean = (s, max) => String(s ?? "").replace(/\s+$/g, "").slice(0, max);

export async function onRequest({ request, env }) {
  try {
    const KV = env.LAB_FORUM;
    if (!KV) return json({ error: "後端沒有讀到 KV 綁定 LAB_FORUM，請到 Pages → Settings → Functions 檢查變數名稱是否完全一致" }, 500);

    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.has("diag")) {           // 健檢：/api/lab-forum?diag=1
        await KV.put("diag", String(Date.now()), { expirationTtl: 60 });
        return json({ ok: true, kv: "可讀可寫", now: new Date().toISOString() });
      }
      return json({ threads: JSON.parse((await KV.get(KEY)) || "[]") });
    }

    if (request.method !== "POST") return json({ error: "只接受 GET / POST" }, 405);

    let b;
    try { b = await request.json(); }
    catch { return json({ error: "送出的內容不是合法 JSON" }, 400); }

    if (b.hp) return json({ ok: true });            // 蜜罐：機器人填了就假裝成功

    /* 冷卻：注意 KV 的 expirationTtl 最小值是 60 秒，
       低於 60 會直接丟錯（先前寫 20 就是卡在這裡），
       所以改成存時間戳、自己比對間隔。 */
    const ip = request.headers.get("CF-Connecting-IP") || "0";
    const gate = `rl:${ip}`;
    const last = await KV.get(gate);
    if (last && Date.now() - Number(last) < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (Date.now() - Number(last))) / 1000);
      return json({ error: `太快了，再等 ${wait} 秒。` }, 429);
    }

    const threads = JSON.parse((await KV.get(KEY)) || "[]");
    const now = Date.now();

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
      return json({ error: "未知動作：" + b.action }, 400);
    }

    await KV.put(KEY, JSON.stringify(threads));
    await KV.put(gate, String(now), { expirationTtl: 60 });   // 最小值就是 60
    return json({ ok: true });

  } catch (err) {
    return json({ error: "後端例外：" + (err && err.message ? err.message : String(err)) }, 500);
  }
}
