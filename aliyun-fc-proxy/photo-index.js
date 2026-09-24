// 阿里云函数计算 FC 3.0 Web 函数 —— 吉吉利利「照片中转」
// 作用：国内网络经常连不上 supabase.co，导致照片只有上传时的那个 WiFi 能看到。
//       本函数部署在阿里云（如 cn-hangzhou），域名国内直连可达，替手机取图/传图。
//
//   GET  /photos/<文件名>   → 回源 Supabase Storage 取图（带 5 分钟内存缓存）
//   POST /photos/<文件名>   → 转发上传到 Supabase Storage
//   GET  /                  → 状态检查
//
// 部署（和之前 ai-proxy 同样的流程）：
//   1. 函数计算控制台 → 创建函数 → 「Web 函数」→ 运行环境 Node.js 18/20
//   2. 代码上传方式选「上传 ZIP」或直接在编辑器里粘贴本文件内容（入口文件名保持一致）
//   3. 启动命令/监听端口：Web 函数默认监听 9000（读环境变量 CAPORT，已兼容）
//   4. 触发器 → HTTP 触发器 → 勾选「允许匿名访问」；高级配置里开启 POST 方法
//   5. 拿到函数 URL（如 https://photo-proxy-yinnhlesct.cn-hangzhou.fcapp.run）
//      → 填到网页「⚙️ API 设置 → 图片代理地址」，保存后会随家庭数据同步到所有设备

const http = require('http');
const https = require('https');

const PORT = process.env.CAPORT || 9000;
const SUPABASE_HOST = 'lrjiiacbzpcfpstxakuu.supabase.co';
const BUCKET = 'photos';
const ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxyamlpYWNienBjZnBzdHhha3V1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODczNjE3MTAsImV4cCI6MjEwMjkzNzcxMH0.EkoYcU_L7nn7A44fj4Q86yVdPxwL4L1VWhinS53MkMA';

// 简单内存缓存：key -> {buf, type, ts}
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 60;   // 最多缓存 60 张，防止内存撑爆

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL) { cache.delete(key); return null; }
  return hit;
}
function cacheSet(key, val) {
  if (cache.size >= CACHE_MAX) {
    // 丢掉最早写入的一个
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, val);
}

function fetchUpstream(method, path, headers, body, cb) {
  const options = {
    method: method,
    hostname: SUPABASE_HOST,
    port: 443,
    path: path,
    headers: headers
  };
  const req = https.request(options, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, res.statusCode, res.headers, Buffer.concat(chunks)));
  });
  req.on('error', (e) => cb(e, 502, {}, Buffer.from('upstream unreachable: ' + e.message)));
  req.setTimeout(30000, () => { req.destroy(); cb(new Error('timeout'), 504, {}, Buffer.from('upstream timeout')); });
  if (body) req.write(body);
  req.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-upsert');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const path = (req.url || '/').split('?')[0].replace(/^\/+/, '');

  if (!path || path === '' || !path.startsWith(BUCKET + '/')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('jijilili photo-proxy is running\nGET /' + BUCKET + '/<file>\nPOST /' + BUCKET + '/<file>');
  }

  /* ---------- POST：上传 ---------- */
  if (req.method === 'POST') {
    const ctype = req.headers['content-type'] || 'image/jpeg';
    if (!ctype.startsWith('image/')) {
      res.statusCode = 415; return res.end('only image upload allowed');
    }
    const chunks = [];
    let size = 0, tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > 15 * 1024 * 1024) { tooBig = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) { res.statusCode = 413; return res.end('file too large (max 15MB)'); }
      fetchUpstream(
        'POST',
        '/storage/v1/object/' + path,
        {
          'apikey': ANON,
          'Authorization': 'Bearer ' + ANON,
          'Content-Type': ctype,
          'x-upsert': 'true',
          'Content-Length': Buffer.concat(chunks).length
        },
        Buffer.concat(chunks),
        (err, status, headers, body) => {
          res.statusCode = status;
          res.setHeader('Content-Type', headers['content-type'] || 'application/json');
          res.end(body);
        }
      );
    });
    return;
  }

  /* ---------- GET：取图 ---------- */
  const hit = cacheGet(path);
  if (hit) {
    res.statusCode = 200;
    res.setHeader('Content-Type', hit.type);
    res.setHeader('X-Cache', 'HIT');
    return res.end(hit.buf);
  }
  fetchUpstream(
    'GET',
    '/storage/v1/object/public/' + path,
    { 'User-Agent': 'jijilili-photo-proxy' },
    null,
    (err, status, headers, body) => {
      res.statusCode = status;
      const type = headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', type);
      res.setHeader('Cache-Control', 'public, max-age=2592000');
      res.setHeader('X-Cache', 'MISS');
      if (status === 200 && body.length) cacheSet(path, { buf: body, type: type, ts: Date.now() });
      res.end(body);
    }
  );
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('photo-proxy listening on ' + PORT);
});
