// Cloudflare Pages Function —— 路徑：/api/messages
//
// 部署前置：在 Pages 專案的 Settings → Functions → KV namespace bindings，
// 新增一個 binding，變數名稱填  MESSAGES ，綁到你建立的 KV namespace。
//
// 隱私：本檔只從 Cloudflare 邊緣取「國家／地區代碼」，
//       絕不讀取、不儲存、不回傳訪客 IP。

const KEY = 'messages';
const MAX = 500;            // 最多保留最近 500 則
const AVATAR_MAX = 60000;   // 上傳頭像 dataURL 上限（約 45KB）

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function clip(s, n) { return (typeof s === 'string' ? s : '').slice(0, n); }

async function readAll(env) {
  if (!env.MESSAGES) return [];
  const raw = await env.MESSAGES.get(KEY);
  return raw ? JSON.parse(raw) : [];
}
async function writeAll(env, arr) {
  if (env.MESSAGES) await env.MESSAGES.put(KEY, JSON.stringify(arr));
}

export async function onRequestGet({ env }) {
  return json(await readAll(env));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

  const text = clip(body.text, 500).trim();
  if (!text) return json({ error: 'empty' }, 400);

  const anon = !!body.anon;

  // 只取國碼（HK / TW / US…），永不存 IP
  let country = (request.cf && request.cf.country) || request.headers.get('cf-ipcountry') || '';
  if (country === 'XX' || country === 'T1') country = '';   // 未知 / Tor

  // 頭像：只有具名才接受；限制 dataURL 大小或單一 emoji
  let avatar = '';
  if (!anon) {
    const a = typeof body.avatar === 'string' ? body.avatar : '';
    if (a.indexOf('data:image/') === 0) { if (a.length <= AVATAR_MAX) avatar = a; }
    else avatar = clip(a, 8);
  }

  const msg = {
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
    ts: Date.now(),
    anon,
    name: anon ? '' : clip(body.name, 20),
    avatar,
    seed: anon ? clip(body.seed, 48) : '',
    text,
    country,
    // 樓中樓：保存父留言 id（為空＝頂層留言）。前端用它重建巢狀。
    replyTo: (typeof body.replyTo === 'string' && body.replyTo) ? clip(body.replyTo, 64) : null,
  };

  const all = await readAll(env);
  all.push(msg);
  while (all.length > MAX) all.shift();
  await writeAll(env, all);

  return json(all);
}
