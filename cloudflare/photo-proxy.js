/**
 * 吉吉利利 图片中转代理（Cloudflare Worker）
 *
 * 要解决什么：
 *   浏览器能「显示」Supabase 上的图片（<img> 标签不需要 CORS 头），
 *   但应用要把图片「字节」取出来、迁移到国内 OSS 时，必须走 fetch / canvas，
 *   这两者都要求源站返回 Access-Control-Allow-Origin。
 *   而国内大量网络连 supabase.co 会被 GFW 把 Cloudflare 的 IP 做 TCP reset，
 *   表现就是「应用拉不到图、但浏览器直接打开那个网址能看到」。
 *
 *   本 Worker 跑在 Cloudflare 边缘节点，回源走 Cloudflare→Cloudflare（不受 GFW 影响），
 *   把图片字节原样取回并带上宽松的 CORS 头返回，于是应用就能正常取图、迁移。
 *
 * 调用格式（与网页 viaProxy 配套）：
 *   https://<你的worker>/photos/<bucket>/<file>
 *     → 回源 https://lrjiiacbzpcfpstxakuu.supabase.co/storage/v1/object/public/<bucket>/<file>
 *
 * 部署步骤：
 *   1) Cloudflare 控制台 → Workers 与 Pages → 创建 → 新建 Worker → 粘贴本文件 → 部署
 *   2) 记下分配的 *.workers.dev 地址（也可绑自己的域名）
 *   3) 打开吉吉利利网页 → ⚙️ API 设置 → 图片代理地址 → 填这个地址 → 保存
 *      （地址会随家庭数据同步，全家设备自动生效，不用每台都填）
 */

const SUPABASE_HOST = 'lrjiiacbzpcfpstxakuu.supabase.co';
const PUBLIC_PREFIX = '/storage/v1/object/public/';

// 极简内存缓存，避免同一张图反复回源（Worker 实例级，重启即空）
const _cache = new Map();
const TTL = 5 * 60 * 1000;   // 5 分钟
const MAX = 300;             // 最多缓存 300 张

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const cors = corsHeaders();

    // 健康检查 / 说明
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(
        'jijilili photo-proxy (Cloudflare) is running.\n' +
        '用法：GET /photos/<bucket>/<file>  →  回源 Supabase 公开存储',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...cors } }
      );
    }

    // 只接受 /photos/<bucket>/<file> 形态，禁止路径穿越
    if (!url.pathname.startsWith('/photos/')) {
      return new Response('bad path（仅支持 /photos/<bucket>/<file>）', { status: 400, headers: cors });
    }
    const tail = url.pathname.slice('/photos/'.length);
    if (!tail || tail.indexOf('..') >= 0) {
      return new Response('bad path', { status: 400, headers: cors });
    }

    const upstream = 'https://' + SUPABASE_HOST + PUBLIC_PREFIX + tail;

    // 命中缓存
    const hit = _cache.get(tail);
    if (hit && (Date.now() - hit.ts) < TTL) {
      return new Response(hit.body, {
        status: 200,
        headers: { 'Content-Type': hit.type, 'X-Cache': 'HIT', 'Cache-Control': 'public, max-age=2592000', ...cors }
      });
    }

    try {
      const r = await fetch(upstream, { headers: { 'User-Agent': 'jijilili-photo-proxy' } });
      const buf = await r.arrayBuffer();
      const type = r.headers.get('content-type') || 'image/jpeg';
      if (r.status === 200 && buf.byteLength) {
        if (_cache.size >= MAX) _cache.delete(_cache.keys().next().value);
        _cache.set(tail, { body: buf, type, ts: Date.now() });
      }
      return new Response(buf, {
        status: r.status,
        headers: { 'Content-Type': type, 'X-Cache': 'MISS', 'Cache-Control': 'public, max-age=2592000', ...cors }
      });
    } catch (e) {
      return new Response('upstream unreachable: ' + e.message, { status: 502, headers: cors });
    }
  }
};
