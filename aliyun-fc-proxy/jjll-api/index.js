/**
 * 吉吉利利 国内后端 —— 阿里云函数计算 FC 3.0 Web 函数 + 阿里云 OSS
 *
 * 为什么需要它：照片和家庭数据原来存在 Supabase（supabase.co 在国内大量网络下
 * TCP 被重置，实测 "Recv failure: Connection was reset"），换网络就裂图、同步也断。
 * 本函数部署在阿里云（与你的 FC 同地域），域名国内直连可达；数据在 OSS，
 * FC 与 OSS 走内网互通，免流量费。
 *
 * 提供的接口：
 *   GET  /info                        → 返回 OSS 公开读域名（前端据此判断照片是否已迁移）
 *   GET  /state?code=xxx              → { ok, ts, data }        读取家庭数据
 *   POST /state?code=xxx  {data, ts}  → { ok, ts }              写入（带 CAS，冲突返回当前数据）
 *   POST /upload?code=xxx&name=xxx    → { ok, url }             上传照片（二进制 body）
 *   GET  /                            → 运行状态自检
 *
 * 需要配置的环境变量（函数配置 → 环境变量）：
 *   OSS_AK          AccessKey ID（建议用只授权本 bucket 的 RAM 子账号）
 *   OSS_SK          AccessKey Secret
 *   OSS_BUCKET      bucket 名，如 jijilili
 *   OSS_ENDPOINT    内网 endpoint，如 oss-cn-hangzhou-internal.aliyuncs.com（与函数同地域，免流量费）
 *   OSS_PUBLIC_BASE 公开读域名，如 https://jijilili.oss-cn-hangzhou.aliyuncs.com
 *   JJLL_TOKEN      可选，简单口令；填了之后前端也要填同样的值
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const PORT = process.env.CAPORT || 9000;
const AK = process.env.OSS_AK || '';
const SK = process.env.OSS_SK || '';
const BUCKET = process.env.OSS_BUCKET || '';
const ENDPOINT = process.env.OSS_ENDPOINT || 'oss-cn-hangzhou-internal.aliyuncs.com';
const PUBLIC_BASE = (process.env.OSS_PUBLIC_BASE || ('https://' + BUCKET + '.oss-cn-hangzhou.aliyuncs.com')).replace(/\/+$/, '');
const TOKEN = process.env.JJLL_TOKEN || '';
const HOST = BUCKET + '.' + ENDPOINT;
const MAX_UPLOAD = 15 * 1024 * 1024;

/* ---------- OSS 签名（V1，Header 方式，无需 SDK 依赖） ---------- */
function ossSign(verb, contentType, date, resource) {
  const str = verb + '\n\n' + (contentType || '') + '\n' + date + '\n' + resource;
  return 'OSS ' + AK + ':' + crypto.createHmac('sha1', SK).update(str).digest('base64');
}
function oss(method, key, body, contentType) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const resource = '/' + BUCKET + '/' + key;
    const headers = {
      'Date': date,
      'Host': HOST,
      'Authorization': ossSign(method, contentType || '', date, resource)
    };
    if (body) {
      headers['Content-Type'] = contentType || 'application/octet-stream';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(
      { method, hostname: HOST, path: '/' + key.split('/').map(encodeURIComponent).join('/'), headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('oss timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

/* ---------- 工具 ---------- */
function safeCode(c) {
  const s = String(c || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return s.slice(0, 32) || 'public';
}
function safeName(n) {
  // 只允许 photos/<code>/<file> 形态，禁止 .. 与绝对路径
  const s = String(n || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (s.indexOf('..') >= 0) return '';
  if (!/^[A-Za-z0-9_\-\/.]+$/.test(s)) return '';
  if (!s.startsWith('photos/')) return '';
  return s.slice(0, 200);
}
function sendJSON(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, aborted = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { aborted = true; req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
function parseJSON(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}

/* ---------- 主服务 ---------- */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,x-jjll-token');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  const pathname = (req.url || '/').split('?')[0];
  const query = {};
  ((req.url || '').split('?')[1] || '').split('&').forEach((kv) => {
    if (!kv) return;
    const p = kv.split('=');
    query[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' '));
  });

  if (!BUCKET || !AK || !SK) {
    return sendJSON(res, 500, { ok: false, error: 'OSS 环境变量未配置（OSS_AK/OSS_SK/OSS_BUCKET）' });
  }
  if (TOKEN && req.headers['x-jjll-token'] !== TOKEN) {
    return sendJSON(res, 401, { ok: false, error: 'token 不匹配' });
  }

  /* 自检：打开函数根地址就能看到 OSS 是否配置正确（AK/SK、bucket、内网 endpoint） */
  if (pathname === '/' || pathname === '') {
    const base = { service: 'jijilili-backend', bucket: BUCKET, publicBase: PUBLIC_BASE, time: new Date().toISOString() };
    return oss('GET', 'data/_ping.json', null, '').then((r) => {
      const ok = r.status === 200 || r.status === 404;
      base.ok = ok;
      base.oss = ok ? 'OK（OSS 可读写）' : ('异常：HTTP ' + r.status + ' ' + r.body.toString('utf8').slice(0, 300));
      return sendJSON(res, 200, base);
    }).catch((e) => {
      base.ok = false;
      base.oss = 'FAIL: ' + e.message;
      return sendJSON(res, 200, base);
    });
  }

  /* 公开读域名 */
  if (pathname === '/info') {
    return sendJSON(res, 200, { ok: true, publicBase: PUBLIC_BASE, bucket: BUCKET });
  }

  const code = safeCode(query.code);

  /* 读取家庭数据 */
  if (pathname === '/state' && req.method === 'GET') {
    return oss('GET', 'data/' + code + '.json', null, '')
      .then((r) => {
        if (r.status === 404) return sendJSON(res, 200, { ok: true, ts: 0, data: null });
        const obj = parseJSON(r.body);
        return sendJSON(res, 200, { ok: true, ts: (obj && obj.ts) || 0, data: (obj && obj.data) || null });
      })
      .catch((e) => sendJSON(res, 502, { ok: false, error: 'oss read failed: ' + e.message }));
  }

  /* 写入家庭数据（CAS：ts 对不上说明别的设备改过，返回当前数据让前端重新合并） */
  if (pathname === '/state' && req.method === 'POST') {
    return readBody(req, 8 * 1024 * 1024).then((buf) => {
      const payload = parseJSON(buf);
      if (!payload) return sendJSON(res, 400, { ok: false, error: 'bad json' });
      const inTs = Number(payload.ts) || 0;
      return oss('GET', 'data/' + code + '.json', null, '').then((r) => {
        const cur = r.status === 200 ? parseJSON(r.body) : null;
        const curTs = (cur && cur.ts) || 0;
        if (curTs && inTs && inTs !== curTs) {
          return sendJSON(res, 200, { ok: false, conflict: true, ts: curTs, data: (cur && cur.data) || null });
        }
        const newTs = Date.now();
        return oss('PUT', 'data/' + code + '.json', Buffer.from(JSON.stringify({ ts: newTs, data: payload.data })), 'application/json')
          .then((w) => {
            if (w.status >= 200 && w.status < 300) return sendJSON(res, 200, { ok: true, ts: newTs });
            return sendJSON(res, 502, { ok: false, error: 'oss write failed: ' + w.status + ' ' + w.body.toString().slice(0, 200) });
          });
      });
    }).catch((e) => sendJSON(res, 400, { ok: false, error: e.message }));
  }

  /* 上传照片 */
  if (pathname === '/upload' && req.method === 'POST') {
    const name = safeName(query.name);
    if (!name) return sendJSON(res, 400, { ok: false, error: 'bad name' });
    const ctype = (req.headers['content-type'] || 'image/jpeg').split(';')[0];
    if (!ctype.startsWith('image/')) return sendJSON(res, 415, { ok: false, error: 'only image allowed' });
    return readBody(req, MAX_UPLOAD).then((buf) => {
      if (!buf.length) return sendJSON(res, 400, { ok: false, error: 'empty body' });
      return oss('PUT', name, buf, ctype).then((w) => {
        if (w.status >= 200 && w.status < 300) {
          return sendJSON(res, 200, { ok: true, url: PUBLIC_BASE + '/' + name });
        }
        return sendJSON(res, 502, { ok: false, error: 'oss put failed: ' + w.status + ' ' + w.body.toString().slice(0, 200) });
      });
    }).catch((e) => sendJSON(res, 413, { ok: false, error: e.message }));
  }

  return sendJSON(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('jijilili-backend listening on ' + PORT);
});
