// sw.js — Service Worker для RobinHood P2P
const CACHE_NAME = 'robinhood-v1';
const ASSETS = [
  '/ROBINHOOD-P2P/',
  '/ROBINHOOD-P2P/index.html',
  '/ROBINHOOD-P2P/manifest.json',
  '/ROBINHOOD-P2P/lottie.min.js',
  '/ROBINHOOD-P2P/peer-help.js',
  '/ROBINHOOD-P2P/p2ppong.js',
  '/ROBINHOOD-P2P/robinhood-ui.js',
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
  '/ROBINHOOD-P2P/assets/avatar/001ava.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
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
