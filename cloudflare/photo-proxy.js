/**
 * Cloudflare Worker：吉吉利利 照片代理（图片 CDN）
 *
 * 背景：食谱照片存在 Supabase Storage，直连域名
 *   https://lrjiiacbzpcfpstxakuu.supabase.co/storage/v1/object/public/photos/xxx.jpg
 * 在国内不少网络下（DNS 污染 / 丢包 / 运营商干扰）加载不出来，表现为
 * 「只有在上传时的那个 WiFi 下能看到，换个网络就空白」。
 * 本 Worker 作为图片代理回源 Supabase，并做边缘缓存，访问稳定性大幅提升。
 *
 * 部署方式：
 *   1. Cloudflare 控制台 → Workers 和 Pages → 创建 → 创建 Worker
 *   2. 起个名字（如 jijilili-photo）→ 部署
 *   3. 点「编辑代码」，把本文件内容整段覆盖进去 → 保存并部署
 *   4. 复制得到的访问地址，如 https://jijilili-photo.<你的子域>.workers.dev
 *   5. 在网页「⚙️ API 设置 → 图片代理地址」里填入该地址（每台设备各填一次）
 *
 * 说明：无需配环境变量，Supabase 地址已写死在下方常量。
 */

const SUPABASE_URL = 'https://lrjiiacbzpcfpstxakuu.supabase.co';
const BUCKET = 'photos';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 只接受 /photos/... 形式的路径
    const path = url.pathname.replace(/^\/+/, '');
    if (!path.startsWith(BUCKET + '/')) {
      return new Response(
        'jijilili photo-proxy is running. Use /' + BUCKET + '/<filename>',
        { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    const target = `${SUPABASE_URL}/storage/v1/object/public/${path}`;
    const cache = caches.default;

    // 命中边缘缓存直接返回
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
      return new Response('upstream unreachable', {
        status: 502,
        headers: { 'Access-Control-Allow-Origin': '*' }
      });
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
