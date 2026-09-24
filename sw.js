// 吉吉利利 离线缓存 Service Worker
// v4：修复「手机快捷方式打开显示旧内容」——HTML 页面在线时强制走网络（永不缓存旧壳），
//     仅静态资源（图标/清单）走缓存以保证离线可用；缓存名升级以清掉旧缓存。
const CACHE = 'jjll-v5';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(ASSETS).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var req = e.request;

  // 导航请求（HTML 主页面）：在线时强制网络（no-store），保证永远是部署的最新版本；
  // 仅当真正离线时才回退到已缓存的页面。
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).catch(function () {
        return caches.match('./index.html').then(function (c) { return c || caches.match('./'); });
      })
    );
    return;
  }

  // 其它静态资源：缓存优先 + 后台刷新（离线可用、二次打开更快）
  e.respondWith(
    caches.match(req).then(function (cached) {
      var network = fetch(req, { cache: 'no-store' }).then(function (resp) {
        if (resp && resp.status === 200) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return resp;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
