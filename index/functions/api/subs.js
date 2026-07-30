/**
 * 訂閱狀態每日更新（Cloudflare Pages Functions）
 *
 * 放在 你的repo/functions/api/subs.js，推上去就會在 /api/subs 生效。
 * 前端每次載入會呼叫它，回傳每條訂閱的存活狀態、節點數、剩餘流量、到期日。
 * 結果會快取 6 小時，所以不會每次開頁都去打你的機場。
 *
 * 要換訂閱連結，只改下面 SUBS 這個陣列（要和 index.html 第 501 行的 NODES 對得上）。
 */

const SUBS = [
  "https://rde19125.ccwu.cc/592e0598-1e5d-2b38-f352-af598afaa588/sub?target=clash",
  "https://rde19125.ccwu.cc/592e0598-1e5d-2b38-f352-af598afaa588/sub",
  "https://tw114514.ccwu.cc/sub?token=cadd8204e648c305536a6bb1ea0b3f5f",
  "https://hk114514.ccwu.cc/sub?token=3bc237d55498e8409a0ebb1ed87ba43a"
];

const TTL = 60 * 60 * 6;        // 快取 6 小時
const GB = n => (n / 1073741824).toFixed(1) + " GB";
const day = ts => new Date(ts * 1000).toISOString().slice(0, 10);

function parseUserInfo(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(";")) {
    const [k, v] = part.split("=").map(x => x && x.trim());
    if (k && v !== undefined) out[k] = Number(v);
  }
  return out;
}

function countNodes(text) {
  if (!text) return 0;
  let body = text;
  // 多數通用訂閱回傳 base64
  if (/^[A-Za-z0-9+/=\s]+$/.test(text.slice(0, 400))) {
    try { body = atob(text.replace(/\s/g, "")); } catch { /* 不是 base64 就算了 */ }
  }
  const yaml = body.match(/^\s*-\s+\{?\s*name\s*:/gm);
  if (yaml) return yaml.length;
  return body.split(/\r?\n/).filter(l => /^(vmess|vless|trojan|ss|ssr|hysteria2?|tuic):\/\//.test(l.trim())).length;
}

async function probe(url) {
  const row = { url, alive: false, checked: new Date().toISOString().slice(5, 16).replace("T", " ") };
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "clash-verge/1.0" },
      cf: { cacheTtl: TTL, cacheEverything: true },
      signal: AbortSignal.timeout(8000)
    });
    row.alive = r.ok;
    if (!r.ok) return row;
    const info = parseUserInfo(r.headers.get("subscription-userinfo"));
    if (info.total) {
      const used = (info.upload || 0) + (info.download || 0);
      row.left = GB(Math.max(info.total - used, 0));
    }
    if (info.expire) row.expire = day(info.expire);
    row.nodes = countNodes(await r.text());
  } catch {
    row.alive = false;
  }
  return row;
}

export async function onRequest({ request }) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).origin + "/api/subs__cache", { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;

  const list = await Promise.all(SUBS.map(probe));
  const res = new Response(JSON.stringify(list), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${TTL}`
    }
  });
  await cache.put(key, res.clone());
  return res;
}
