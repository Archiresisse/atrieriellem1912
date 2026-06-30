// functions/api/forum.js
// 「自由論壇」共享後端 — Cloudflare Pages Function（KV 儲存）
//
// 路由：自動對應 /api/forum（GET 讀取、POST 寫入）。
// 隱私：發文者所在地僅取自 request.cf.country（兩位國碼，例如 HK / TW / US），
//       永不讀取、永不儲存任何 IP 位址 —— 與首頁留言板相同的模型。
//
// 綁定：在 Pages 專案 Settings → Bindings 新增一個 KV namespace，
//       變數名稱（Variable name）必須為 FORUM（與下方 env.FORUM 一致）。
//
// 結構：
//   idx          -> JSON 陣列，每篇貼文的「摘要」（列表用，輕量、不含媒體）
//   post:<id>    -> JSON 物件，單篇完整貼文（含內文、媒體 base64、回覆）
//
// KV 單值上限 25 MiB；每篇貼文各自一個 key，媒體互不擠壓。
// 前端已將影片上限降到 ~12MB（base64 ~16MB），可安全塞進單一 KV 值。

const IDX_KEY = 'idx';
const MAX_POSTS = 200;                 // 索引保留的最新貼文數，超出淘汰最舊（連同其 post:<id>）
const MAX_BODY = 20000;                // 內文字元上限
const MAX_MEDIA = 24 * 1024 * 1024;    // 單篇媒體 base64 上限，預留 KV 25 MiB 餘裕
const MAX_AVATAR = 200000;             // 頭像 dataURL 上限（圓形頭像很小）

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
const clip = (v, n) => (typeof v === 'string' ? v : '').slice(0, n);

async function readIdx(kv) {
  const raw = await kv.get(IDX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function summarize(p) {
  return {
    id: p.id, title: p.title, excerpt: (p.body || '').slice(0, 120),
    cat: p.cat, name: p.name, anon: !!p.anon, avatar: p.avatar || '', seed: p.seed || '',
    cc: p.cc || '', ts: p.ts, likes: p.likes || 0,
    rc: (p.replies || []).length, mk: p.media ? p.media.kind : '',
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.FORUM;
  if (!kv) {
    return json({ error: 'KV 未綁定：請在 Pages 專案 Settings → Bindings 新增 KV namespace，變數名 FORUM。' }, 500);
  }

  // ───────────────── GET ─────────────────
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) {
      const raw = await kv.get('post:' + id);
      if (!raw) return json({ error: 'not found' }, 404);
      return new Response(raw, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const idx = await readIdx(kv);
    idx.sort((a, b) => b.ts - a.ts);
    return json({ posts: idx });
  }

  // ───────────────── POST ─────────────────
  if (request.method === 'POST') {
    let b;
    try { b = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

    // 唯一的地區來源：Cloudflare 邊緣判定的國碼，無 IP。
    const cc = (request.cf && request.cf.country) ? String(request.cf.country) : '';
    const action = b && b.action;

    if (action === 'create') {
      const title = clip(b.title, 60);
      if (!title) return json({ error: '缺少標題' }, 400);
      const media = (b.media && b.media.data)
        ? { kind: b.media.kind === 'video' ? 'video' : 'image', data: clip(b.media.data, MAX_MEDIA) }
        : null;
      const post = {
        id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
        cat: clip(b.cat, 20) || '閒聊',
        title,
        body: clip(b.body, MAX_BODY),
        name: clip(b.name, 40) || '訪客',
        anon: !!b.anon,
        avatar: clip(b.avatar, MAX_AVATAR),
        seed: clip(b.seed, 80),
        cc, ts: Date.now(), likes: 0, replies: [], media,
      };
      await kv.put('post:' + post.id, JSON.stringify(post));
      const idx = await readIdx(kv);
      idx.unshift(summarize(post));
      while (idx.length > MAX_POSTS) {
        const drop = idx.pop();
        if (drop && drop.id) { try { await kv.delete('post:' + drop.id); } catch (e) {} }
      }
      await kv.put(IDX_KEY, JSON.stringify(idx));
      return json({ id: post.id, cc });
    }

    if (action === 'reply') {
      const id = String(b.id || '');
      const text = clip(b.text, 500);
      if (!text) return json({ error: '回覆空白' }, 400);
      const raw = await kv.get('post:' + id);
      if (!raw) return json({ error: 'not found' }, 404);
      const post = JSON.parse(raw);
      post.replies = post.replies || [];
      post.replies.push({
        // 樓中樓：rid＝此回覆自身 id；replyTo＝被回覆的樓層（貼文 id 或某回覆 rid）。
        rid: clip(b.rid, 48) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
        replyTo: clip(b.replyTo, 48) || id,
        name: clip(b.name, 40) || '訪客', anon: !!b.anon,
        avatar: clip(b.avatar, MAX_AVATAR), seed: clip(b.seed, 80),
        text, cc, ts: Date.now(),
      });
      await kv.put('post:' + id, JSON.stringify(post));
      const idx = await readIdx(kv);
      const s = idx.find((x) => x.id === id);
      if (s) { s.rc = post.replies.length; await kv.put(IDX_KEY, JSON.stringify(idx)); }
      return json({ ok: true, cc, rc: post.replies.length });
    }

    if (action === 'like') {
      const id = String(b.id || '');
      const delta = b.delta === -1 ? -1 : 1;
      const raw = await kv.get('post:' + id);
      if (!raw) return json({ error: 'not found' }, 404);
      const post = JSON.parse(raw);
      post.likes = Math.max(0, (post.likes || 0) + delta);
      await kv.put('post:' + id, JSON.stringify(post));
      const idx = await readIdx(kv);
      const s = idx.find((x) => x.id === id);
      if (s) { s.likes = post.likes; await kv.put(IDX_KEY, JSON.stringify(idx)); }
      return json({ likes: post.likes });
    }

    return json({ error: 'unknown action' }, 400);
  }

  return json({ error: 'method not allowed' }, 405);
}
