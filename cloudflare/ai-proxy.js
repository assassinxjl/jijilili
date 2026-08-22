// Cloudflare Worker: ai-proxy
// 作用：在服务器端转发 AI 请求，规避浏览器跨域(CORS)限制。Cloudflare 出网可达标准 443 端口，
//       对 bayesdl 这类「接口本身可用但浏览器被 CORS 拦」的场景最有效。
// 部署：Cloudflare 后台 → Workers & Pages → Create → 新建 Worker → 粘贴本文件 → Deploy → 复制 Worker 地址
//       （地址形如 https://ai-proxy.<你的子域>.workers.dev/）
// 浏览器调用（在「智能推荐 · API 设置」的「代理地址」里填这个 Worker 地址）：
//   POST <Worker地址>
//   请求体：{ "endpoint":"https://.../chat/completions", "apiKey":"sk-xxx", "model":"glm-5.1", "messages":[...] }

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405, headers: cors });
    }
    try {
      const { endpoint, apiKey, model, messages } = await request.json();
      if (!endpoint || !apiKey) {
        return new Response(JSON.stringify({ error: '缺少 endpoint 或 apiKey' }),
          { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const upstream = endpoint.endsWith('/chat/completions')
        ? endpoint
        : endpoint.replace(/\/+$/, '') + '/chat/completions';
      const upstreamResp = await fetch(upstream, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ model: model || 'glm-5.1', messages: messages || [] }),
      });
      const text = await upstreamResp.text();
      return new Response(text, {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }),
        { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }
};
