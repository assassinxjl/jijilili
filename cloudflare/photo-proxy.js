/**
 * Cloudflare Worker：吉吉利利 照片代理（读取 + 上传）
 *
 * 背景：食谱照片存在 Supabase Storage，直连域名
 *   https://lrjiiacbzpcfpstxakuu.supabase.co/storage/v1/object/public/photos/xxx.jpg
 * 在国内不少网络下（DNS 污染 / 丢包 / 运营商干扰）加载不出来，表现为
 * 「只有在上传时的那个 WiFi 下能看到，换个网络就空白」。
 * 本 Worker 作为中转回源 Supabase，并做边缘缓存。
 *
 * 部署方式：
 *   1. Cloudflare 控制台 → Workers 和 Pages → 创建 → 创建 Worker
 *   2. 起个名字（如 jijilili-photo）→ 部署
 *   3. 点「编辑代码」，把本文件内容整段覆盖进去 → 保存并部署
 *   4. 复制访问地址，如 https://jijilili-photo.<你的子域>.workers.dev
 *   5. 在网页「⚙️ API 设置 → 图片代理地址」里填入该地址（会随家庭数据同步，填一次即可）
 *
 * 接口：
 *   GET  /photos/<文件名>   → 回源取图并缓存
 *   POST /photos/<文件名>   → 转发上传到 Supabase Storage（携带 anon key，前端不用直连 supabase）
 */

const SUPABASE_URL = 'https://lrjiiacbzpcfpstxakuu.supabase.co';
const BUCKET = 'photos';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyamlpYWNienBjZnBzdHhha3V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNjE3MTAsImV4cCI6MjEwMjkzNzcxMH0.EkoYcU_L7nn7A44fj4Q86yVdPxwL4L1VWhinS53MkMA';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-upsert',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = url.pathname.replace(/^\/+/, '');

    // 首页：自检用
    if (!path.startsWith(BUCKET + '/')) {
      return new Response(
        'jijilili photo-proxy is running.\nGET  /' + BUCKET + '/<file>\nPOST /' + BUCKET + '/<file>',
        { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    /* ---------- POST：转发上传 ---------- */
    if (request.method === 'POST') {
      const ctype = request.headers.get('content-type') || 'image/jpeg';
      if (!ctype.startsWith('image/')) {
        return new Response('only image upload allowed', { status: 415, headers: CORS });
      }
      const len = parseInt(request.headers.get('content-length') || '0', 10);
      if (len > 15 * 1024 * 1024) {
        return new Response('file too large (max 15MB)', { status: 413, headers: CORS });
      }
      const body = await request.arrayBuffer();
      let upstream;
      try {
        upstream = await fetch(`${SUPABASE_URL}/storage/v1/object/${path}`, {
          method: 'POST',
          headers: {
            'apikey': ANON,
            'Authorization': 'Bearer ' + ANON,
            'Content-Type': ctype,
            'x-upsert': 'true'
          },
          body
        });
      } catch (e) {
        return new Response('upstream unreachable: ' + e.message, { status: 502, headers: CORS });
      }
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { ...CORS, 'Content-Type': upstream.headers.get('content-type') || 'application/json' }
      });
    }

    /* ---------- GET：回源取图 + 边缘缓存 ---------- */
    const target = `${SUPABASE_URL}/storage/v1/object/public/${path}`;
    const cache = caches.default;

    try {
      const cached = await cache.match(request);
      if (cached) {
        const hit = new Response(cached.body, cached);
        hit.headers.set('Access-Control-Allow-Origin', '*');
        hit.headers.set('X-Cache', 'HIT');
        return hit;
      }
    } catch (e) { /* 缓存不可用时忽略，直接回源 */ }

    let upstream;
    try {
      upstream = await fetch(target, {
        headers: { 'User-Agent': 'jijilili-photo-proxy' },
        cf: { cacheTtl: 86400, polish: 'lossless' }
      });
    } catch (e) {
      return new Response('upstream unreachable', { status: 502, headers: CORS });
    }

    const resp = new Response(upstream.body, upstream);
    resp.headers.set('Cache-Control', 'public, max-age=2592000');
    resp.headers.set('Access-Control-Allow-Origin', '*');
    resp.headers.set('X-Cache', 'MISS');

    try {
      ctx.waitUntil(cache.put(request, resp.clone()));
    } catch (e) { /* 忽略缓存写入失败 */ }

    return resp;
  }
};
