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

/* ------------------------------------------------------------------
 * 找不到控制台「环境变量」入口时，直接把值填在下面的 DEFAULTS 里也能用。
 * 两种方式任选其一；环境变量优先级更高（填了就以环境变量为准）。
 * ------------------------------------------------------------------ */
const DEFAULTS = {
  OSS_AK: '',            // AccessKey ID
  OSS_SK: '',            // AccessKey Secret
  OSS_BUCKET: '',        // 如 jijilili
  OSS_ENDPOINT: '',      // 内网：oss-cn-hangzhou-internal.aliyuncs.com
  OSS_PUBLIC_BASE: '',   // 如 https://jijilili.oss-cn-hangzhou.aliyuncs.com
  JJLL_TOKEN: ''         // 可选口令，留空表示不校验
};
function env(k) {
  const v = process.env[k];
  if (v !== undefined && v !== '') return v;
  return DEFAULTS[k] || '';
}
// 阿里云 Web 函数注入的端口环境变量是 PORT；CAPORT 作为自定义别名兜底。
// 二者都没有时降级到 9000（FC Web 函数默认端口）。
const PORT = process.env.PORT || process.env.CAPORT || 9000;
const AK = env('OSS_AK');
const SK = env('OSS_SK');
const BUCKET = env('OSS_BUCKET');
const ENDPOINT = env('OSS_ENDPOINT') || 'oss-cn-hangzhou-internal.aliyuncs.com';
const PUBLIC_BASE = (env('OSS_PUBLIC_BASE') || ('https://' + BUCKET + '.oss-cn-hangzhou.aliyuncs.com')).replace(/\/+$/, '');
const TOKEN = env('JJLL_TOKEN');
const HOST = BUCKET + '.' + ENDPOINT;
const MAX_UPLOAD = 15 * 1024 * 1024;

/* 每次改动代码都把 BUILD 改掉，这样打开根地址就能一眼确认「线上跑的是不是这一版」。
   排查部署时非常好用：返回的 buildId 对不上，说明代码包没真正生效。 */
const BUILD_ID = 'v2-pathfix-20261010-1030';

/* 配置项来源，用于自检时一眼看出哪些没配上 */
function configReport() {
  const keys = ['OSS_AK', 'OSS_SK', 'OSS_BUCKET', 'OSS_ENDPOINT', 'OSS_PUBLIC_BASE', 'JJLL_TOKEN'];
  const rep = {};
  keys.forEach((k) => {
    if (process.env[k] !== undefined && process.env[k] !== '') rep[k] = '环境变量';
    else if (DEFAULTS[k]) rep[k] = '代码内置';
    else rep[k] = k === 'JJLL_TOKEN' ? '未设置（可选）' : '❌ 缺失';
  });
  return rep;
}

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
    // FC 默认函数超时只有 3 秒，这里必须比它短，否则报错来自 FC 网关而不是我们自己的提示。
    // 调大函数超时时间（建议 60 秒）后可以再放宽。
    req.setTimeout(Number(process.env.OSS_TIMEOUT_MS) || 8000, () => { req.destroy(); reject(new Error('oss timeout')); });
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

/* ---------- 主服务 ----------
   双模式兼容：
   1) 事件函数模式（阿里云内置运行时 nodejs18/20，FC 用 bootstrap.mjs 加载，要求导出 handler）
   2) Web 服务模式（自定义运行时 / 本地 node，代码自己 server.listen）
   自动判断：本文件被 require 时导出 handler，同时仍然尝试监听端口；
   监听失败也不影响 handler 正常工作。 */
function buildResponse(status, obj) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'content-type,x-jjll-token',
      'Access-Control-Max-Age': '86400'
    },
    body: JSON.stringify(obj),
    isBase64Encoded: false
  };
}

/* 把 FC 事件对象转成与 http.IncomingMessage 一致的形状，复用下面的同一套路由逻辑。
   注意：不同触发器类型下 event.path 的形态不一致，可能是 "/upload"，
   也可能是完整 URL "https://xxx.fcapp.run/upload?code=a"，
   还有的带在 requestContext.http.path。这里逐个回退，保证 pathname 一定是纯路径。 */
const KNOWN_ROUTES = ['/upload', '/state', '/info', '/ping', '/diag'];
function normalizePath(raw) {
  let p = String(raw || '').trim();
  if (!p) return '';
  p = p.split('#')[0].split('?')[0];            // 去掉 query 与 fragment
  if (p.indexOf('://') >= 0) {                  // 完整 URL → 取 pathname 部分
    const m = p.match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i);
    p = (m && m[1]) || '/';
  }
  if (p.charAt(0) !== '/') p = '/' + p;          // 补前导斜杠
  return p;
}
function extractPath(event) {
  const cands = [];
  if (event.path) cands.push(event.path);
  if (event.rawPath) cands.push(event.rawPath);
  if (event.requestContext) {
    if (event.requestContext.path) cands.push(event.requestContext.path);
    if (event.requestContext.http && event.requestContext.http.path) cands.push(event.requestContext.http.path);
  }
  for (let i = 0; i < cands.length; i++) {
    const p = normalizePath(cands[i]);
    if (p) return p;
  }
  /* 兜底：路径字段名可能完全不在上面这些里（例如只在 headers 或某个自定义字段中）。
     把整个 event 序列化后扫描已知路由，避免又落到 '/' 上导致 /state /upload 全部失效。 */
  try {
    const s = JSON.stringify(event);
    for (let i = 0; i < KNOWN_ROUTES.length; i++) {
      if (s.indexOf(KNOWN_ROUTES[i]) >= 0) return KNOWN_ROUTES[i];
    }
  } catch (e) {}
  return '/';
}
function makeFakeReq(event) {
  const headers = {};
  const hs = event.headers || {};
  Object.keys(hs).forEach((k) => { headers[k.toLowerCase()] = hs[k]; });

  /* query 有三种可能来法，全都要兼容：
     ① event.queryString（字符串，可能带前导 ?）
     ② event.queryStringParameters（对象 {code:"xxx"}）
     ③ 直接挂在 path 上（完整 URL 形态，extractPath 剥 query 时被丢掉了）
     任何一种缺失都会导致 code 变 undefined → 读错家庭数据。 */
  let queryString = '';
  function addQuery(s) {
    if (!s) return;
    const t = String(s).charAt(0) === '?' ? String(s).slice(1) : String(s);
    if (!t) return;
    if (queryString) { queryString += '&' + t; } else { queryString = t; }
  }
  const qs = event.queryString || event.rawQueryString || '';
  if (typeof qs === 'string' && qs) {
    addQuery(qs);
  } else if (qs && typeof qs === 'object') {
    addQuery(Object.keys(qs).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(qs[k])).join('&'));
  }
  if (event.queryStringParameters && typeof event.queryStringParameters === 'object') {
    addQuery(Object.keys(event.queryStringParameters).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(event.queryStringParameters[k])).join('&'));
  }
  ['path', 'rawPath'].forEach((k) => {
    if (event[k] && String(event[k]).indexOf('?') >= 0) addQuery(String(event[k]).split('?')[1]);
  });
  if (event.requestContext && event.requestContext.http && event.requestContext.http.path &&
      String(event.requestContext.http.path).indexOf('?') >= 0) {
    addQuery(String(event.requestContext.http.path).split('?')[1]);
  }
  const path = extractPath(event);

  /* HTTP 方法同样有多种来法 */
  let method = event.httpMethod || event.method || '';
  if (!method && event.requestContext) {
    method = (event.requestContext.http && event.requestContext.http.method) || event.requestContext.httpMethod || '';
  }
  const url = queryString ? (path + '?' + queryString) : path;
  const bodyBuf = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');
  const listeners = {};
  const req = {
    method: String(method || 'GET').toUpperCase(),
    url: url,
    headers: headers,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return req; },
    emit(ev, arg) { (listeners[ev] || []).forEach((f) => f(arg)); }
  };
  process.nextTick(() => {
    if (bodyBuf.length) req.emit('data', bodyBuf);
    req.emit('end');
  });
  req._bodyBuf = bodyBuf;
  req._event = event || {};
  return req;
}

/* 收集响应（sendJSON 会写入这里） */
function makeFakeRes(resolve) {
  const res = {
    statusCode: 0,
    _headers: {},
    setHeader(k, v) { res._headers[k] = v; },
    end(payload) {
      resolve(buildResponse(res.statusCode || 200, payload ? safeParse(payload) : null));
    }
  };
  return res;
}
function safeParse(s) { try { return JSON.parse(s); } catch (e) { return { ok: false, error: 'bad response' }; } }

/* 阿里云内置运行时（事件函数）入口 */
exports.handler = function (event, context) {
  return new Promise((resolve) => {
    let settled = false;
    /* 必须在超时前清掉定时器，否则残留的 timer 会让实例迟迟不退出 */
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(buildResponse(504, { ok: false, error: 'handler timeout（请把函数「超时时间」调到 60 秒以上）' }));
    }, 25000);
    function done(r) { if (settled) return; settled = true; clearTimeout(timer); resolve(r); }

    try {
      const req = makeFakeReq(event || {});
      const res = makeFakeRes(done);
      server.emit('request', req, res);
    } catch (e) {
      done(buildResponse(500, { ok: false, error: 'handler error: ' + e.message }));
    }
  });
};
/* 部分版本要求 handler.async 或 main，本地 serverless 框架也认这两个别名 */
exports.main = exports.handler;
exports.handler.async = function (event, context) { return exports.handler(event, context); };

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

  /* 快速自检：不去连 OSS，纯粹确认「代码跑起来了 + 环境变量读到了」。
     必须放在所有 OSS 访问之前，因为 FC 默认超时只有 3 秒，连 OSS 可能来不及返回。 */
  if (pathname === '/ping') {
    return sendJSON(res, 200, {
      ok: true, pong: true, buildId: BUILD_ID, service: 'jijilili-backend',
      runtime: 'fc-handler', bucket: BUCKET, publicBase: PUBLIC_BASE,
      config: configReport(), time: new Date().toISOString()
    });
  }

  /* 现场诊断：把 FC 传进来的 event 结构原样吐出来（含各个路径候选字段的值），
     用来一次性判断问题出在哪：代码包没更新 / 路径字段名异常 / 触发器类型不对。
     注意：token 校验要放在它之后，否则传不上口令就看不到诊断信息。 */
  if (pathname === '/diag') {
    const lastEvent = req._event || {};
    const picked = {};
    ['path', 'rawPath', 'httpMethod', 'method', 'queryString', 'queryStringParameters', 'isBase64Encoded'].forEach((k) => {
      if (lastEvent[k] !== undefined) picked[k] = lastEvent[k];
    });
    if (lastEvent.requestContext) {
      picked.requestContext = {
        path: lastEvent.requestContext.path,
        http: lastEvent.requestContext.http,
        httpMethod: lastEvent.requestContext.httpMethod
      };
    }
    picked.headerKeys = Object.keys(lastEvent.headers || {});
    picked.eventTopKeys = Object.keys(lastEvent);
    return sendJSON(res, 200, {
      ok: true, buildId: BUILD_ID, resolvedPath: pathname,
      resolvedQuery: query, event: picked,
      hint: 'buildId 与本地最新代码一致 = 代码包已生效；若 resolvedPath 变成 "/" 说明路径字段未被识别，把 event 内容发给我。'
    });
  }

  if (!BUCKET || !AK || !SK) {
    return sendJSON(res, 500, { ok: false, error: 'OSS 环境变量未配置（OSS_AK/OSS_SK/OSS_BUCKET）' });
  }
  if (TOKEN && req.headers['x-jjll-token'] !== TOKEN) {
    return sendJSON(res, 401, { ok: false, error: 'token 不匹配' });
  }

  /* 自检：打开函数根地址就能看到 OSS 是否配置正确（AK/SK、bucket、内网 endpoint） */
  if (pathname === '/' || pathname === '') {
    const missing = ['OSS_AK', 'OSS_SK', 'OSS_BUCKET'].filter((k) => !env(k));
    const base = {
      service: 'jijilili-backend',
      buildId: BUILD_ID,
      bucket: BUCKET,
      publicBase: PUBLIC_BASE,
      config: configReport(),
      time: new Date().toISOString()
    };
    if (missing.length) {
      base.ok = false;
      base.oss = '❌ 还没配上：' + missing.join('、') + '。请在本函数「配置 → 高级配置 → 编辑 → 环境变量」里补齐，或直接写在本文件顶部的 DEFAULTS 里，然后点「部署」。';
      return sendJSON(res, 200, base);
    }
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
    return sendJSON(res, 200, { ok: true, buildId: BUILD_ID, publicBase: PUBLIC_BASE, bucket: BUCKET });
  }

  const code = safeCode(query.code);

  /* 只取 ts 的轻量轮询（前端 ossPoll 用 &only=ts 调用），避免每次都把整份数据传回来。
     不带 data 字段，前端只用来判断「云端有没有更新」。 */
  const onlyTs = String(query.only || '') === 'ts';

  /* 读取家庭数据 */
  if (pathname === '/state' && req.method === 'GET') {
    return oss('GET', 'data/' + code + '.json', null, '')
      .then((r) => {
        if (r.status === 404) return sendJSON(res, 200, { ok: true, ts: 0, data: null });
        const obj = parseJSON(r.body);
        const ts = (obj && obj.ts) || 0;
        if (onlyTs) return sendJSON(res, 200, { ok: true, ts: ts });
        return sendJSON(res, 200, { ok: true, ts: ts, data: (obj && obj.data) || null });
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

/* 尝试以独立 Web 服务方式监听端口（自定义运行时 / 本地 node 场景）。
   在内置运行时的事件函数模式下，端口可能被平台占用而监听失败——这没关系，
   平台会直接调用上面导出的 handler，所以捕获错误、不让进程崩掉。 */
try {
  server.on('error', (e) => {
    console.log('listen failed (ignored in handler mode): ' + e.message);
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('jijilili-backend listening on ' + PORT);
  });
} catch (e) {
  console.log('listen skipped (handler mode): ' + e.message);
}
