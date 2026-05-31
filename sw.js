const PRIMARY = 'https://robinhood-final.pages.dev';
const FALLBACK = 'https://robinhood-proxy.stephanclaps.workers.dev';
let useFallback = false;

// Проверяем доступность основного сервера
async function checkPrimary() {
  try {
    const response = await fetch(PRIMARY, { method: 'HEAD', mode: 'no-cors' });
    return response.ok || response.type === 'opaque';
  } catch {
    return false;
  }
}

// При установке сразу определяем, доступен ли основной сервер
self.addEventListener('install', event => {
  event.waitUntil(
    checkPrimary().then(available => {
      useFallback = !available;
    })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Если уже используем fallback, сразу идём через прокси
  if (useFallback) {
    const fallbackUrl = FALLBACK + url.pathname + url.search;
    event.respondWith(fetch(fallbackUrl));
  } else {
    // Иначе пробуем основной сервер, при ошибке переключаемся на fallback
    event.respondWith(
      fetch(event.request).catch(() => {
        useFallback = true; // запоминаем, что сервер недоступен
        const fallbackUrl = FALLBACK + url.pathname + url.search;
        return fetch(fallbackUrl);
      })
    );
  }
});
