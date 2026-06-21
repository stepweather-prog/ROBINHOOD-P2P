# RobinHood P2P v5.5.4

Децентрализованный P2P-мессенджер с оконечным шифрованием, построенный на платформе **P2PPong**. Работает в браузере. Без установки, без центрального сервера хранения сообщений.

## Архитектура

Приложение работает поверх платформы **P2PPong** — распределённого P2P-ядра, построенного на принципах ОГАС академика Глушкова.

RobinHood UI (интерфейс) — Анимации, темы, чат, звонки. НЕ знает про ECDH, Ratchet, DHT.

P2PPong (ядро) — Криптография, транспорт, каналы. НЕ знает про document, DOM, UI. Событийная шина: P2PPong.on() / P2PPong.emit().

Транспорт — Cloudflare Worker (основной), Render Server (резервный), WebRTC DataChannel (прямой канал).

## Схема рукопожатия

Пир А (создатель): craftArrow() → генерирует PeerID, ECDH, nonce → SHA(nonce+'beacon') → ключ маяка → AES(inner, ключ) → шифрует эмодзи → POST /beacon waiting_.

Пир Б (присоединяющийся): joinBeacon(peerIdA) → GET /beacon waiting_ → получает маяк → проверяет HMAC(nonce+peerId) → SHA(nonce+'beacon') → ключ → AES(inner, ключ) → эмодзи.

Верификация: Пир Б отправляет verification-emoji через emoji_. Пир А видит эмодзи, Пир Б вводит эмодзи. confirmVerification() → ECDH → общий секрет → SHA(секрет+эмодзи) → hash. verification-ack и beacon-response через waiting_.

Канал открыт. Ratchet + AES-256-GCM. WebRTC DataChannel (если доступен).

## Идентификация

Peer ID = 32 случайных hex-символа (криптографически безопасный PRNG). Генерируется заново при каждом craftArrow(). Не привязан к устройству, не сохраняется между сессиями.

## Сквозное шифрование (E2EE)

Рукопожатие: ECDH на кривой P-256. Ephemeral-пары. Обмен публичными ключами через маяки.

Маяки: Ключ маяка = SHA-256(nonce + 'beacon'), nonce = 128 бит. HMAC-SHA256 подпись = HMAC(nonce + peerId, ключ). Получатель проверяет HMAC → расшифровывает AES-256-GCM → извлекает эмодзи. Защита от подмены nonce через HMAC.

Double Ratchet + HMAC: Ratchet Key обновляется каждое сообщение = SHA-256(старый_ключ + индекс). HMAC-SHA256 подписывает каждое сообщение. Старые ключи сохраняются (до 50) для расшифровки неупорядоченных сообщений. Автоматическая ресинхронизация при расхождении ratchet.

Шифрование сообщений: AES-256-GCM, случайный IV (12 байт). GZIP-сжатие перед шифрованием. Случайный паддинг (20–70 байт). Фиксированный размер блоба: 4096 байт.

## Ограничения эмодзи-верификации

Максимум 5 попыток ввода эмодзи, затем маяк нужно пересоздать. Не более 5 эмодзи в последовательности.

## Голосовые сообщения

Максимальный размер: 300 КБ. Максимальная длительность: 10 секунд. Кодек: Opus в WebM, 16 kbps.

## Формат данных

Маяк (beacon): тип, pubKey, peerId, inner (AES-256-GCM), nonce, sig (HMAC-SHA256).

Сообщение (блоб): z (GZIP), t (время), n (nonce), ri (ratchet index).

## API для разработчиков

P2PPong.init() — инициализация.
P2PPong.craftArrow() — создать маяк, возвращает peerId.
P2PPong.joinBeacon(targetPeerId) — присоединиться к маяку.
P2PPong.confirmVerification() — подтвердить верификацию.
P2PPong.sendMessage(channelId, text) — отправить сообщение.
P2PPong.sendVoiceMessage(channelId, audioBase64) — отправить голосовое.
P2PPong.on('ready', () => {}) — ядро готово.
P2PPong.on('peer-id-generated', ({ peerId }) => {}) — маяк создан.
P2PPong.on('verification-needed', ({ emoji }) => {}) — нужно ввести эмодзи.
P2PPong.on('verification-received', ({ emoji }) => {}) — эмодзи получены.
P2PPong.on('channel-opened', ({ channelId, peerId }) => {}) — канал открыт.
P2PPong.on('message-received', ({ channelId, text, timestamp }) => {}) — сообщение получено.
P2PPong.on('message-sent', ({ channelId, data, status }) => {}) — сообщение отправлено.
P2PPong.on('error', ({ message }) => {}) — ошибка.

## Требования к браузеру

HTTPS (обязательно). Web Crypto API (ECDH, AES-GCM, HMAC-SHA256). WebRTC (опционально). CompressionStream API. Service Worker (опционально).

## Известные ограничения

Нет офлайн-доставки сообщений (маяк живёт 5 минут). Нет групповых чатов (только P2P). Нет push-уведомлений когда вкладка закрыта. Нет роуминга истории между устройствами. WebRTC может не работать за симметричным NAT без TURN-сервера. Emoji-верификация уязвима к MITM если злоумышленник перехватит маяк до получателя и знает эмодзи.

## Деплой

RobinHood UI — https://stepweather-prog.github.io/ROBINHOOD-P2P
Сигнальный сервер — https://robincall.stephanclaps-491.workers.dev
Резервный сервер — https://p2ppong-v2.onrender.com

## Ключевые константы

Кривая ECDH — P-256. Шифрование — AES-256-GCM. HMAC — SHA-256. Nonce маяка — 128 бит. Старых ключей Ratchet — 50. Размер блоба — 4096 байт. Время жизни маяка — 5 минут. Время жизни канала — 10 минут. Макс. попыток эмодзи — 5. Макс. размер голосового — 300 КБ. Макс. длительность голосового — 10 сек.

## Атрибуция

Иконки и графика — https://www.flaticon.com
Анимации — https://airbnb.io/lottie (MIT License)
Звуки — https://freesound.org/

## Ответственность

Проект предоставляется «как есть» (AS IS), без каких-либо гарантий. Разработчик не несёт ответственности за прямой или косвенный ущерб. Криптографические решения не прошли независимый аудит безопасности. Сигнальный сервер не читает содержимое сообщений. Метаданные (кто с кем) серверу недоступны. Пользователь самостоятельно оценивает риски.

## Лицензия

MIT

## Связанные проекты

P2PPong Core — https://github.com/stepweather-prog/P2PPong
Cloudflare Worker — worker.js в репозитории P2PPong
Render Server — server.js в репозитории P2PPong
Спецификация протокола — PROTOCOL.md
