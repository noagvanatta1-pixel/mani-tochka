/* Копилка: минимальный service worker.
   Нужен, чтобы приложение устанавливалось на экран «Домой» и открывалось без сети.
   Страница всегда берётся из сети (так обновления приходят сразу), кэш — только запасной вариант. */
const CACHE = 'kopilka-v1';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => {
      if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put('/', c)); }
      return r;
    }).catch(() => caches.match('/').then((r) => r || new Response('Нет сети', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))));
    return;
  }
  if (url.pathname.startsWith('/pwa/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
      if (r.ok) { const c = r.clone(); caches.open(CACHE).then((x) => x.put(req, c)); }
      return r;
    })));
  }
});
