/**
 * 吉吉利利 · 国内后端（阿里云 FC）连通性体检
 *
 * 用法：
 *   node tools/check-backend.js https://jjll-api-xxxx.cn-hangzhou.fcapp.run [访问口令]
 *
 * 它会依次测：
 *   1. DNS 能否解析        → 解析失败说明 URL 抄错 / 函数已删除
 *   2. /ping（不连 OSS）   → 返回 JSON 说明代码已跑起来；超时/连不上说明不是业务代码问题
 *   3. /（自检，会连 OSS） → 能返回 oss 字段说明 AK/SK/bucket 配好了
 *   4. /state 读写         → 验证家庭数据能否正常存取
 *
 * 退出码：0 全部通过；1 有失败项（看每项后面的说明）
 */

const base = (process.argv[2] || '').trim().replace(/\/+$/, '');
const token = (process.argv[3] || '').trim();

if (!base) {
  console.error('用法：node tools/check-backend.js <函数URL> [访问口令]');
  process.exit(1);
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (token) h['x-jjll-token'] = token;
  return h;
}

/* fetch 带超时：Node 18+ 有原生 fetch，但默认不超时，这里自己加 */
async function get(path, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeout) || 20000);
  const t0 = Date.now();
  try {
    const res = await fetch(base + path, {
      method: (opts && opts.method) || 'GET',
      headers: Object.assign(headers(), (opts && opts.extraHeaders) || {}),
      body: opts && opts.body,
      signal: ctrl.signal
    });
    const text = await res.text();
    return { ok: true, status: res.status, ms: Date.now() - t0, text: text };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.name === 'AbortError' ? '请求超时（函数没在规定时间内返回）' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function line(ok, name, detail) {
  const mark = ok ? '✅' : '❌';
  console.log(mark + ' ' + name + (detail ? '  →  ' + detail : ''));
}

/* HTTP 401 且返回 token 不匹配 → 说明后端设了口令但这次没带上，属于"没测到"而非"坏了" */
function isTokenBlocked(res) {
  return res && res.status === 401 && /token/i.test(res.text || '');
}

(async function main() {
  console.log('目标：' + base);
  if (token) console.log('口令：已提供');
  console.log('');

  /* 1. DNS */
  let host = '';
  try { host = new URL(base).hostname; } catch (e) {
    line(false, 'URL 格式', '不是合法地址，请从控制台「触发器」页重新复制');
    process.exit(1);
  }
  let dnsOk = true, dnsMsg = host;
  try {
    const dns = require('dns').promises;
    const addrs = await dns.lookup(host);
    dnsMsg = host + ' → ' + addrs[0].address;
  } catch (e) {
    dnsOk = false;
    dnsMsg = host + ' 解析失败：' + e.message + '（URL 可能抄错，或函数已被删除重建）';
  }
  line(dnsOk, '1. DNS 解析', dnsMsg);
  if (!dnsOk) process.exit(1);

  /* 2. /ping —— 关键：不连 OSS，能最快判断「代码是否跑起来」 */
  const ping = await get('/ping', { timeout: 15000 });
  if (!ping.ok) {
    line(false, '2. /ping（代码是否跑起来）', ping.err + '（' + ping.ms + 'ms）');
    console.log('');
    console.log('  → 请求连到了域名但没拿到响应，通常是以下之一：');
    console.log('     a) 函数「超时时间」还是默认 3 秒 → 改成 60 秒');
    console.log('     b) 代码包没真正部署 → 重新上传 jjll-api.zip 后必须点「部署」');
    console.log('     c) 触发器认证方式不是「无需认证」 → 编辑触发器改掉');
    console.log('     d) 触发器没启用或函数没关联到该触发器');
    console.log('     e) 控制台「日志」页有报错 → 把原文发给我，一次定位');
    process.exit(1);
  }
  if (isTokenBlocked(ping)) {
    line(false, '2. /ping', 'HTTP 401：token 不匹配 → 后端设了访问口令，但你没把口令传进来');
    console.log('');
    console.log('  ✅ 这说明函数代码其实已经跑起来了！（能返回 401 说明它正常执行到了鉴权那一步）');
    console.log('  → 把口令作为第二个参数传进来重试：');
    console.log('     node tools/check-backend.js ' + base + ' <访问口令>');
    process.exit(1);
  }
  if (ping.status !== 200) {
    line(false, '2. /ping', 'HTTP ' + ping.status + '：' + ping.text.slice(0, 200));
    process.exit(1);
  }
  line(true, '2. /ping（代码已跑起来）', ping.ms + 'ms  ' + ping.text.slice(0, 120));

  /* 3. / 自检：连 OSS 看配置 */
  const self = await get('/', { timeout: 25000 });
  if (!self.ok) {
    line(false, '3. / 自检（OSS 配置）', self.err + '（' + self.ms + 'ms）');
    console.log('     → 代码能跑但连 OSS 超时。请把函数「超时时间」调到 60 秒以上。');
    process.exit(1);
  }
  let selfJson = null;
  try { selfJson = JSON.parse(self.text); } catch (e) {}
  if (selfJson && selfJson.oss) {
    const ossOk = String(selfJson.oss).indexOf('OK') === 0;
    line(ossOk, '3. / 自检（OSS 可读写）', selfJson.oss);
    if (!ossOk) {
      console.log('     → bucket: ' + selfJson.bucket + '  endpoint: 内网');
      console.log('     → 若报 403：AK/SK 不对，或 RAM 子账号没给 OSS 权限');
      console.log('     → 若报签名错误：确认函数和 Bucket 同在「华东1（杭州）」');
    }
  } else {
    line(false, '3. / 自检（OSS 配置）', self.text.slice(0, 200));
  }

  /* 4. 状态读写（用一个测试家庭码，不影响真实数据） */
  const code = 'probe_test';
  const getState = await get('/state?code=' + code);
  if (getState.ok && getState.status === 200) {
    line(true, '4. 读取 /state', getState.ms + 'ms  ' + getState.text.slice(0, 80));
  } else {
    line(false, '4. 读取 /state', (getState.err || ('HTTP ' + getState.status)) + '  ' + (getState.text || '').slice(0, 100));
  }

  const postState = await get('/state?code=' + code, {
    method: 'POST',
    body: JSON.stringify({ ts: 0, data: { _probe: Date.now() } })
  });
  let putOk = false, putMsg = (postState.err || ('HTTP ' + postState.status));
  if (postState.ok && postState.status === 200) {
    try {
      const j = JSON.parse(postState.text);
      putOk = !!j.ok;
      putMsg = j.ok ? ('写入成功 ts=' + j.ts) : (j.error || '返回 ok=false');
    } catch (e) { putMsg = postState.text.slice(0, 100); }
  }
  line(putOk, '5. 写入 /state（CAS）', putMsg);

  console.log('');
  const allOk = putOk && ping.status === 200;
  if (allOk) {
    console.log('全部通过 ✅ 后端已就绪。');
    console.log('');
    console.log('接下来在网页端：');
    console.log('  1. ⚙️ 右上角齿轮 → 填「国内云 API 地址」= ' + base);
    console.log('  2. 填「访问口令」' + (token ? '（与上面一致）' : '（若未设口令则留空）'));
    console.log('  3. 保存 → 点「🚚 迁移照片到国内云」');
    process.exit(0);
  } else {
    console.log('有失败项，请把上面 ❌ 的内容发给我。');
    process.exit(1);
  }
})();