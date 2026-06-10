const CACHE_NAME = 'robinhood-v3.1';
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 час

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); startUpdateCheck(); });

function startUpdateCheck() {
    setInterval(async () => {
        try {
            const response = await fetch('https://stepweather-prog.github.io/ROBINHOOD-P2P/index.html', { method: 'HEAD', cache: 'no-store' });
            const etag = response.headers.get('ETag') || response.headers.get('Last-Modified');
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match('/index.html');
            const storedEtag = cached ? cached.headers.get('ETag') : null;
            if (etag && etag !== storedEtag) {
                const clients = await self.clients.matchAll();
                clients.forEach(client => client.postMessage({ type: 'update-available' }));
            }
        } catch (e) {}
    }, CHECK_INTERVAL);
}

self.addEventListener('message', async (event) => {
    if (event.data && event.data.type === 'apply-update') {
        const cache = await caches.open(CACHE_NAME);
        await cache.delete('/index.html');
        const clients = await self.clients.matchAll();
        clients.forEach(client => client.navigate(client.url));
    }
});
