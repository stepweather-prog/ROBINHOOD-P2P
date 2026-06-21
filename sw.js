// sw.js — Service Worker для RobinHood P2P
const CACHE_VERSION = 'v8';
const CACHE_NAME = 'robinhood-' + CACHE_VERSION;
const ASSETS = [
  '/ROBINHOOD-P2P/',
  '/ROBINHOOD-P2P/index.html',
  '/ROBINHOOD-P2P/manifest.json',
  '/ROBINHOOD-P2P/lottie.min.js',
  '/ROBINHOOD-P2P/peer-help.js',
  '/ROBINHOOD-P2P/p2ppong.js',
  '/ROBINHOOD-P2P/robinhood-ui.js',
  '/ROBINHOOD-P2P/crypto-worker.js',
  '/ROBINHOOD-P2P/assets/icons/01icon.png',
  '/ROBINHOOD-P2P/assets/icons/02icon.png',
  '/ROBINHOOD-P2P/assets/icons/03icon.png',
  '/ROBINHOOD-P2P/assets/icons/05icon.png',
  '/ROBINHOOD-P2P/assets/icons/06icon.png',
  '/ROBINHOOD-P2P/assets/icons/08icon.png',
  '/ROBINHOOD-P2P/assets/icons/11icon.png',
  '/ROBINHOOD-P2P/assets/icons/12icon.png',
  '/ROBINHOOD-P2P/assets/icons/15icon.png',
  '/ROBINHOOD-P2P/assets/icons/16icon.png',
  '/ROBINHOOD-P2P/assets/icons/18icon.png',
  '/ROBINHOOD-P2P/assets/icons/background.webp',
  '/ROBINHOOD-P2P/assets/sounds/melodi.mp3',
  '/ROBINHOOD-P2P/assets/sounds/Welk.mp3',
  '/ROBINHOOD-P2P/assets/sounds/open.mp3',
  '/ROBINHOOD-P2P/assets/sounds/exet.mp3',
  '/ROBINHOOD-P2P/assets/sounds/shot.mp3',
  '/ROBINHOOD-P2P/assets/sounds/clear cache.mp3',
  '/ROBINHOOD-P2P/assets/sounds/arrow_hit.wav',
  '/ROBINHOOD-P2P/assets/smoke.json',
  '/ROBINHOOD-P2P/assets/Archer.json',
  '/ROBINHOOD-P2P/assets/bow.json',
  '/ROBINHOOD-P2P/assets/docking.webp'
];

for (let i = 1; i <= 168; i++) {
  ASSETS.push('/ROBINHOOD-P2P/assets/avatar/' + String(i).padStart(3, '0') + 'ava.png');
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.error('Cache addAll error:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
  // Принудительно обновить все открытые вкладки
  event.waitUntil(
    self.clients.matchAll().then(clients => {
      clients.forEach(client => client.navigate(client.url));
    })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.hostname !== self.location.hostname) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response.ok || response.status !== 200) return response;
        if (response.headers.get('content-length') > 5 * 1024 * 1024) return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, clone).catch(() => {});
        });
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') {
          return caches.match('/ROBINHOOD-P2P/');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
