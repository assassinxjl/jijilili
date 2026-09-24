/**
 * 命令行迁移工具（浏览器内迁移失败时的兜底方案）
 *
 * 用途：把导出的 JSON 里所有 Supabase 照片地址，下载后原样上传到阿里云 OSS，
 *       生成一个引用已替换的新 JSON，再在网页里导入即可。
 * 与浏览器内迁移的区别：不受浏览器跨域(CORS)限制，也不受页面超时影响，原图画质无损。
 *
 * 用法：
 *   1. 网页端「设置 → 数据管理 → 导出数据」，得到 jijilili-data.json
 *   2. 设置环境变量后运行：
 *
 *   set OSS_AK=你的AccessKeyId
 *   set OSS_SK=你的AccessKeySecret
 *   set OSS_BUCKET=jijilili
 *   set OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com
 *   set OSS_PUBLIC_BASE=https://jijilili.oss-cn-hangzhou.aliyuncs.com
 *   node migrate-to-oss.js jijilili-data.json
 *
 *   3. 生成 jijilili-data-oss.json → 网页端「导入数据」选它
 *
 * （PowerShell 用 $env:OSS_AK="xxx" 代替 set OSS_AK=xxx）
 */

const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const AK = process.env.OSS_AK || '';
const SK = process.env.OSS_SK || '';
const BUCKET = process.env.OSS_BUCKET || '';
const ENDPOINT = process.env.OSS_ENDPOINT || 'oss-cn-hangzhou.aliyuncs.com';
const PUBLIC = (process.env.OSS_PUBLIC_BASE || ('https://' + BUCKET + '.' + ENDPOINT)).replace(/\/+$/, '');
const HOST = BUCKET + '.' + ENDPOINT;

if (!AK || !SK || !BUCKET) {
  console.error('缺少环境变量 OSS_AK / OSS_SK / OSS_BUCKET');
  process.exit(1);
}
const inFile = process.argv[2];
if (!inFile) {
  console.error('用法: node migrate-to-oss.js <导出的json文件>');
  process.exit(1);
}

/* ---------- OSS 签名与上传 ---------- */
function ossSign(verb, contentType, date, resource) {
  const str = verb + '\n\n' + (contentType || '') + '\n' + date + '\n' + resource;
  return 'OSS ' + AK + ':' + crypto.createHmac('sha1', SK).update(str).digest('base64');
}
function ossPut(key, buf, contentType) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const headers = {
      'Date': date,
      'Host': HOST,
      'Authorization': ossSign('PUT', contentType, date, '/' + BUCKET + '/' + key),
      'Content-Type': contentType,
      'Content-Length': buf.length
    };
    const req = https.request(
      { method: 'PUT', hostname: HOST, path: '/' + key.split('/').map(encodeURIComponent).join('/'), headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error('oss timeout')); }, 60000);
    req.write(buf);
    req.end();
  });
}

/* ---------- 下载原图 ---------- */
function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'jijilili-migrator' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: (res.headers['content-type'] || 'image/jpeg').split(';')[0] }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

/* ---------- 遍历 JSON，收集并替换 http 图片地址 ---------- */
function collectUrls(node, out) {
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node) && /\.(jpe?g|png|webp|gif|bmp)/i.test(node.split('?')[0])) out.add(node);
    return;
  }
  if (Array.isArray(node)) { node.forEach((n) => collectUrls(n, out)); return; }
  if (node && typeof node === 'object') { Object.keys(node).forEach((k) => collectUrls(node[k], out)); }
}
function replaceUrls(node, map) {
  if (typeof node === 'string') return map[node] || node;
  if (Array.isArray(node)) return node.map((n) => replaceUrls(n, map));
  if (node && typeof node === 'object') {
    const o = {};
    Object.keys(node).forEach((k) => { o[k] = replaceUrls(node[k], map); });
    return o;
  }
  return node;
}

/* ---------- 主流程 ---------- */
(async function main() {
  const raw = fs.readFileSync(inFile, 'utf8');
  const data = JSON.parse(raw);
  const urls = new Set();
  collectUrls(data, urls);

  const todo = Array.from(urls).filter((u) => u.indexOf(PUBLIC) !== 0 && !u.startsWith('data:'));
  console.log('共发现 ' + urls.size + ' 个图片地址，其中待迁移 ' + todo.length + ' 个');
  if (!todo.length) { console.log('没有需要迁移的图片'); return; }

  const map = {};
  let okc = 0, failc = 0;
  for (const url of todo) {
    try {
      const r = await download(url);
      if (!r.buf.length) throw new Error('空文件');
      let base = path.basename(url.split('?')[0]) || 'photo.jpg';
      const md5 = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
      const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
      const key = 'photos/migrated/' + md5 + '-' + safe;
      const w = await ossPut(key, r.buf, r.type);
      if (w.status < 200 || w.status >= 300) throw new Error('OSS ' + w.status + ' ' + w.body.toString().slice(0, 120));
      map[url] = PUBLIC + '/' + key;
      okc++;
      console.log('  ✓ ' + (r.buf.length / 1024).toFixed(0) + 'KB  → ' + map[url]);
    } catch (e) {
      failc++;
      console.log('  ✗ ' + url.slice(0, 80) + '  失败：' + e.message);
    }
  }

  const outData = replaceUrls(data, map);
  const outFile = inFile.replace(/\.json$/i, '') + '-oss.json';
  fs.writeFileSync(outFile, JSON.stringify(outData), 'utf8');
  console.log('\n完成：成功 ' + okc + ' 张，失败 ' + failc + ' 张');
  console.log('已生成 ' + outFile + ' ，请在网页端「设置 → 数据管理 → 导入数据」导入它。');
})();
