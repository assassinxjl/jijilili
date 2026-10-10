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
/* 仅作提示、不代表出错的项（比如本机 DNS 被公司网络限制） */
function lineInfo(name, detail) {
  console.log('ℹ️  ' + name + (detail ? '  →  ' + detail : ''));
}

/* HTTP 401 且返回 token 不匹配 → 说明后端设了口令但这次没带上，属于"没测到"而非"坏了" */
function isTokenBlocked(res) {
  return res && res.status === 401 && /token/i.test(res.text || '');
}
/* 对 probeRoute 的结果做同样判断（它拿到的是已解析的 JSON，没有 status/text 字段） */
function isTokenBlockedRes(probe) {
  if (!probe) return false;
  const a = probe.pathOk && probe.pathJson && /token/i.test(probe.pathJson.error || '');
  const b = probe.queryOk && probe.queryJson && /token/i.test(probe.queryJson.error || '');
  return !!a || !!b;
}

/* ========== 路径通道 vs __p 通道 ==========
   实测发现阿里云 FC 某种触发器形态下后端拿不到真实路径：/ping /info /diag 全部被当成根路径。
   所以这里两种通道都测：
     路径通道：/ping
     参数通道：/?__p=%2Fping   （新版后端优先读 __p，能绕开路径识别问题）
   只要有一通就算后端可用，另一通用于告诉你「前端应该走哪条路」。 */
async function probeRoute(route) {
  const byPath = await get(route, { timeout: 15000 });
  const byQuery = await get('/?__p=' + encodeURIComponent(route), { timeout: 15000 });
  function parse(r) { try { return JSON.parse(r.text || ''); } catch (e) { return null; } }
  const jp = byPath.ok ? parse(byPath) : null;
  const jq = byQuery.ok ? parse(byQuery) : null;
  return {
    route: route,
    pathOk: !!jp,
    pathMs: byPath.ms,
    pathJson: jp,
    queryOk: !!jq,
    queryMs: byQuery.ms,
    queryJson: jq
  };
}

(async function main() {
  console.log('目标：' + base);
  if (token) console.log('口令：已提供');
  console.log('');

  /* 1. DNS —— 这一步只是"参考信息"，解析不出来不代表函数有问题（公司网络 DNS 常被限制），
     所以失败只提示、不中断，真正判定看下面能不能连上。 */
  let host = '';
  try { host = new URL(base).hostname; } catch (e) {
    line(false, 'URL 格式', '不是合法地址，请从控制台「触发器」页重新复制');
    process.exit(1);
  }
  let dnsOk = false, dnsMsg = '';
  try {
    const dns = require('dns').promises;
    const res = await dns.lookup(host, { all: true });
    const list = Array.isArray(res) ? res : (res && res.address ? [res] : []);
    if (list.length) {
      dnsOk = true;
      dnsMsg = host + ' → ' + list.map((a) => a.address).join(', ');
    } else {
      dnsMsg = host + ' 本机 DNS 没返回结果（不影响判断，继续实测）';
    }
  } catch (e) {
    dnsMsg = host + ' 本机 DNS 查询失败：' + (e && e.message) + '（不影响判断，继续实测）';
  }
  if (dnsOk) line(true, '1. DNS 解析', dnsMsg);
  else lineInfo('1. DNS 解析', dnsMsg);

  /* 2. /ping 双通道探测 —— 判断「代码是否跑起来」+「路径能不能识别」 */
  const pingProbe = await probeRoute('/ping');
  if (!pingProbe.pathOk && !pingProbe.queryOk) {
    line(false, '2. /ping（代码是否跑起来）', '两种通道都没响应');
    console.log('');
    if (!dnsOk) {
      console.log('  → 注意：本机 DNS 也没解析出这个域名。下面按优先级排查：');
      console.log('     a) 先换个网络（手机热点）再跑一次——公司网络的 DNS 经常被限制，');
      console.log('        如果热点下能通，说明只是本机 DNS 的问题，后端本身是好的；');
      console.log('     b) 若热点下也不通 → 触发器可能没启用，或 URL 抄错；');
      console.log('     c) 也可以用浏览器手机版打开，或直接看控制台「日志」页。');
    } else {
      console.log('  → 请求连到了域名但没拿到响应，通常是以下之一：');
      console.log('     a) 函数「超时时间」还是默认 3 秒 → 改成 60 秒');
      console.log('     b) 代码包没真正部署 → 重新上传 jjll-api.zip 后必须点「部署」');
      console.log('     c) 触发器认证方式不是「无需认证」 → 编辑触发器改掉');
      console.log('     d) 触发器没启用或函数没关联到该触发器');
      console.log('     e) 控制台「日志」页有报错 → 把原文发给我，一次定位');
    }
    process.exit(1);
  }
  if (isTokenBlockedRes(pingProbe)) {
    line(false, '2. /ping', 'HTTP 401：token 不匹配 → 后端设了访问口令，但你没把口令传进来');
    console.log('');
    console.log('  ✅ 这说明函数代码其实已经跑起来了！（能返回 401 说明它正常执行到了鉴权那一步）');
    console.log('  → 把口令作为第二个参数传进来重试：');
    console.log('     node tools/check-backend.js ' + base + ' <访问口令>');
    process.exit(1);
  }

  const alive = pingProbe.pathOk ? pingProbe : pingProbe;
  line(true, '2. /ping（代码已跑起来）', (alive.pathMs || alive.queryMs) + 'ms  ' + (alive.pathJson ? JSON.stringify(alive.pathJson) : JSON.stringify(alive.queryJson)).slice(0, 120));

  /* 2.1 路径通道状态：这是本次排查的核心 */
  if (pingProbe.pathOk && pingProbe.pathJson && pingProbe.pathJson.pong) {
    line(true, '2.1 路径识别', '正常（/ping 能返回 pong）→ 前端可继续用 /state、/upload 路径');
  } else {
    line(false, '2.1 路径识别', 'FC 拿不到真实路径，所有子路径都被当成根路径');
    console.log('     → 这是根因：后端 event 里没有路径字段，/state /upload /info 全部落到 \'/\'，');
    console.log('       所以「迁移照片到国内云」必然全部失败。');
    console.log('     → 新版后端支持 __p 参数通道绕过，前端已自动改用它，功能不受影响。');
    console.log('     → 请上传最新版 jjll-api.zip 并点「部署」，让线上也支持 __p 通道。');
    console.log('     → 现场信息：打开 ' + base + '/  响应里的 diag 字段会显示后端实际收到的 event 结构。');
  }
  if (pingProbe.queryOk && pingProbe.queryJson && pingProbe.queryJson.pong) {
    line(true, '2.2 __p 备用通道', '可用（/?__p=%2Fping 返回 pong）→ 前端已走这条通道');
  } else {
    line(false, '2.2 __p 备用通道', '不可用（线上后端还没支持）→ 前端会全部失败，必须先更新后端代码包');
  }

  /* 2.5 版本自检：后端每次改代码都会换 buildId */
  const pingJson = pingProbe.pathJson || pingProbe.queryJson || {};
  const EXPECTED_BUILD = 'v6-queryparams-20261010-1120';
  if (pingJson.buildId) {
    if (pingJson.buildId === EXPECTED_BUILD) {
      line(true, '2.5 代码包版本', 'buildId=' + pingJson.buildId + '（✅ 与本地最新一致）');
    } else {
      line(false, '2.5 代码包版本', 'buildId=' + pingJson.buildId + '（❌ 本地最新是 ' + EXPECTED_BUILD + '）');
      console.log('');
      console.log('  → 线上跑的是旧版本代码包。');
      console.log('  → 本地最新代码包：C:\\Users\\11637\\WorkBuddy\\20260504223628\\jijilili-app\\aliyun-fc-proxy\\jjll-api\\jjll-api.zip');
      console.log('  → 请重新上传该文件，上传完务必点「部署」按钮。');
      console.log('');
      process.exit(1);
    }
  } else {
    line(false, '2.5 代码包版本', '响应里没有 buildId → 线上是更老的代码包');
    console.log('     → 重新上传最新 jjll-api.zip 并点「部署」。');
    process.exit(1);
  }

  /* 3. / 自检：连 OSS 看配置（顺便把后端看到的 event 现场打出来） */
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
  /* 后端新版会在根路径回传 diag（它实际收到的 event 结构），这是定位路径问题的关键现场 */
  if (selfJson && selfJson.diag && selfJson.diag.event) {
    const d = selfJson.diag;
    console.log('');
    console.log('  🔎 后端看到的请求现场（diag）：');
    console.log('     rawPathname=' + d.rawPathname + '  resolvedPath=' + d.resolvedPath +
      '  viaQueryRoute=' + d.viaQueryRoute);
    /* event 形态：Buffer/string 本身不是故障——v6 后端已能正确处理。
       真正的判据是"路由走没走通"，而 2.1/2.2/4/5 项已经证明了这一点。
       这里只做客观陈述，避免让人误以为还有问题。 */
    if (d.event.rawType && d.event.rawType !== 'object') {
      console.log('     event 形态 = ' + d.event.rawType + '（FC 直接传二进制，非 JSON 对象；新版后端已支持）');
      if (d.event.rawPreview) {
        console.log('       内容前 160 字符: ' + String(d.event.rawPreview).replace(/\s+/g, ' ').slice(0, 160));
      }
    } else {
      console.log('     event 形态 = object');
    }
    console.log('     event 顶层字段: ' + JSON.stringify(d.event.eventTopKeys).slice(0, 200) +
      (d.event.eventTopKeyCount > 30 ? (' …（共 ' + d.event.eventTopKeyCount + ' 项，上面只显示前 30）') : ''));
    console.log('     headers: ' + JSON.stringify(d.event.headerKeys));
    if (d.event.stringValues && d.event.stringValues.length) {
      console.log('     event 里的字符串值: ' + JSON.stringify(d.event.stringValues).slice(0, 300));
    }
    if (d.resolvedPath === '/' && d.viaQueryRoute === false) {
      /* 这条只说明「本次访问的是根路径自检」，本身不算故障——
         真正是否路由失效，看 2.1 / 2.2 / 4 / 5 四项的结果即可。 */
      console.log('     （本次是访问根路径自检，所以 resolvedPath 为 "/"；' +
        '是否路由正常请以 2.1/2.2/4/5 项为准）');
    }
    console.log('');
  }

  /* 4. 状态读写（用一个测试家庭码 probe_test，不影响真实数据）
     同样双通道：路径通道 /state?code=x 与参数通道 /?__p=/state&code=x */
  const code = 'probe_test';
  const stateProbe = await probeState();
  function probeState() {
    const p = get('/state?code=' + code, { timeout: 20000 });
    const q = get('/?__p=' + encodeURIComponent('/state') + '&code=' + code, { timeout: 20000 });
    return Promise.all([p, q]).then((arr) => ({ byPath: arr[0], byQuery: arr[1] }));
  }
  /* 命中根路径自检 = 请求被当成 '/' 处理了（路由失效），不能当成"OSS 坏了" */
  const routedToRoot = (r) => r && r.status === 200 && /"service"\s*:\s*"jijilili-backend"/.test(r.text || '');

  const useQuery = !isStateOk(stateProbe.byPath) && isStateOk(stateProbe.byQuery);
  const chosen = useQuery ? stateProbe.byQuery : stateProbe.byPath;
  const whichCh = useQuery ? '__p 参数通道' : '路径通道';

  function isStateOk(r) {
    if (!r || !r.ok || r.status !== 200) return false;
    if (routedToRoot(r)) return false;
    try { const j = JSON.parse(r.text); return typeof j.ts === 'number'; } catch (e) { return false; }
  }

  if (isStateOk(chosen)) {
    line(true, '4. 读取 /state（' + whichCh + '）', chosen.ms + 'ms  ' + chosen.text.slice(0, 80));
  } else {
    line(false, '4. 读取 /state', '两种通道都没读到数据');
    console.log('');
    console.log('  路径通道   : ' + (routedToRoot(stateProbe.byPath) ? '返回根路径自检（路由失效）'
      : (stateProbe.byPath.err || 'HTTP ' + stateProbe.byPath.status + ' ' + (stateProbe.byPath.text || '').slice(0, 90))));
    console.log('  __p 通道   : ' + (routedToRoot(stateProbe.byQuery) ? '返回根路径自检（线上后端还不支持 __p）'
      : (stateProbe.byQuery.err || 'HTTP ' + stateProbe.byQuery.status + ' ' + (stateProbe.byQuery.text || '').slice(0, 90))));
    console.log('');
    console.log('  ✅ 解决办法：上传最新版后端代码包（支持 __p 通道）并点「部署」：');
    console.log('     C:\\Users\\11637\\WorkBuddy\\20260504223628\\jijilili-app\\aliyun-fc-proxy\\jjll-api\\jjll-api.zip');
    console.log('');
    process.exit(1);
  }

  const postState = await get('/?__p=' + encodeURIComponent('/state') + '&code=' + code, {
    method: 'POST',
    body: JSON.stringify({ ts: 0, data: { _probe: Date.now() } })
  });
  let putOk = false, putMsg = (postState.err || ('HTTP ' + postState.status));
  if (postState.ok && postState.status === 200) {
    try {
      const j = JSON.parse(postState.text);
      // 后端写成功时返回 { ok:true, ts:<毫秒时间戳> }
      putOk = !!j.ok && typeof j.ts === 'number';
      if (putOk) putMsg = '写入成功 ts=' + j.ts + '（数据已进 OSS）';
      else if (j.ok) putMsg = '返回 ok=true 但没有 ts 字段，响应异常：' + postState.text.slice(0, 120);
      else putMsg = j.error || ('ok=false：' + postState.text.slice(0, 120));
    } catch (e) { putMsg = '响应不是合法 JSON：' + postState.text.slice(0, 120); }
  }
  line(putOk, '5. 写入 /state（CAS）', putMsg);

  console.log('');
  const allOk = putOk && pingJson.buildId === EXPECTED_BUILD && (isStateOk(stateProbe.byPath) || isStateOk(stateProbe.byQuery));
  if (allOk) {
    console.log('全部通过 ✅ 后端已就绪。');
    if (useQuery) {
      console.log('');
      console.log('⚠️ 注意：你的 FC 拿不到真实路径，前端已自动改用 __p 参数通道，功能不受影响。');
      console.log('   建议上传最新版后端代码包，让 /state、/upload 等路径也能直接用。');
    }
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