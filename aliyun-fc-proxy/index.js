// 阿里云函数计算 FC 3.0 Web 函数 - AI 代理（含调试功能）
// GET /          → 状态检查
// GET /debug     → 查看最近一次 POST 请求的详细信息
// POST /         → 代理转发 AI 请求

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.CAPORT || 9000;

// 调试日志：记录最近一次 POST 的详情
let lastRequest = null;

function maskKey(key) {
  if (!key) return '(empty)';
  if (key.length <= 10) return key.substring(0, 3) + '***';
  return key.substring(0, 8) + '...' + key.substring(key.length - 4);
}

function proxyToUpstream(upstream, apiKey, model, messages, callback) {
  const postData = JSON.stringify({ model: model, messages: messages });
  const targetUrl = new URL(upstream);

  const options = {
    method: 'POST',
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + targetUrl.search,
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + apiKey,
    },
  };

  const req = https.request(options, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (lastRequest) {
        lastRequest.upstreamStatus = res.statusCode;
        lastRequest.upstreamResponsePreview = body.substring(0, 300);
      }
      callback(res.statusCode, body);
    });
  });

  req.on('error', (err) => {
    callback(502, JSON.stringify({ error: 'upstream fail: ' + err.message }));
  });

  req.setTimeout(60000, () => {
    req.destroy();
    callback(504, JSON.stringify({ error: 'timeout' }));
  });

  req.write(postData);
  req.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // 调试端点
  if (req.method === 'GET' && req.url === '/debug') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(lastRequest || { msg: '还没有收到 POST 请求' }, null, 2));
  }

  if (req.method === 'GET') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('ai-proxy is running (debug mode)');
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    return res.end('Method Not Allowed');
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'bad json' }));
    }

    // 记录调试信息
    lastRequest = {
      time: new Date().toISOString(),
      endpoint: payload.endpoint,
      apiKeyMasked: maskKey(payload.apiKey),
      apiKeyLength: (payload.apiKey || '').length,
      model: payload.model,
      messagesCount: (payload.messages || []).length,
      requestHeaders: req.headers,
    };

    const endpoint = payload.endpoint || process.env.UPSTREAM_ENDPOINT;
    const apiKey = payload.apiKey || process.env.UPSTREAM_API_KEY;
    const model = payload.model || process.env.UPSTREAM_MODEL || 'glm-5.1';
    const messages = payload.messages || [];

    if (!endpoint || !apiKey) {
      lastRequest.error = 'missing endpoint/apikey';
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: 'missing endpoint/apikey' }));
    }

    const upstream = endpoint.endsWith('/chat/completions')
      ? endpoint
      : endpoint.replace(/\/+$/, '') + '/chat/completions';

    lastRequest.resolvedUpstream = upstream;

    proxyToUpstream(upstream, apiKey, model, messages, (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(body);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('ai-proxy listening on ' + PORT);
});
