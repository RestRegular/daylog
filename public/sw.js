/* DayLog Service Worker：静态资源缓存优先，接口始终走网络 */
const VERSION = 'daylog-v39';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/share.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/app.js',
  '/js/api.js',
  '/js/util.js',
  '/js/ui.js',
  '/js/timeline.js',
  '/js/theme.js',
  '/js/composer.js',
  '/js/attachment-editor.js',
  '/js/media.js',
  '/js/friends.js',
  '/js/celebration.js',
  '/js/anniversaries.js',
  '/js/datenav.js',
  '/js/debug.js',
  '/js/share.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  // 接口与媒体：始终走网络（离线时给出 JSON 兜底）
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/m/') || url.pathname.startsWith('/u/')) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(JSON.stringify({ error: '当前离线' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
      )
    );
    return;
  }

  // 其余（页面、JS、CSS、图标）：网络优先，失败才用缓存。
  // 这样改完代码刷新即生效，不会出现"看到旧版本"的问题；断网时仍可打开已缓存的页面。
  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = (await caches.match('/index.html')) || (await caches.match('/'));
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
