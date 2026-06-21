# RobinHood P2P v5.5.4

Децентрализованный P2P-мессенджер с оконечным шифрованием, построенный на платформе **P2PPong**. Работает в браузере. Без установки, без центрального сервера хранения сообщений.

## Архитектура

Приложение работает поверх платформы **P2PPong** — распределённого P2P-ядра, построенного на принципах ОГАС академика Глушкова.

- **RobinHood UI** (интерфейс): анимации, темы, чат, звонки. НЕ знает про ECDH, Ratchet, DHT
- **P2PPong** (ядро): криптография, транспорт, каналы. НЕ знает про document, DOM, UI. Событийная шина: P2PPong.on() / P2PPong.emit()
- **Транспорт**: Cloudflare Worker (основной), Render Server (резервный), WebRTC DataChannel (прямой канал)

## Схема рукопожатия

1. Пир А → `craftArrow()` → генерирует PeerID, ECDH, nonce → `SHA(nonce+'beacon')` → ключ маяка → `AES(inner, ключ)` → шифрует эмодзи → `POST /beacon waiting_`
2. Пир Б → `joinBeacon(peerIdA)` → `GET /beacon waiting_` → получает маяк → проверяет `HMAC(nonce+peerId)` → `SHA(nonce+'beacon')` → ключ → `AES⁻¹(inner, ключ)` → эмодзи
3. Пир Б → отправляет verification-emoji через `emoji_`
4. Пир А видит эмодзи, Пир Б вводит эмодзи
5. `confirmVerification()` → ECDH → общий секрет → `SHA(секрет+эмодзи)` → hash
6. verification-ack и beacon-response через `waiting_`
7. Канал открыт. Ratchet + AES-256-GCM. WebRTC DataChannel (если доступен)

## Идентификация

**Peer ID** = 32 случайных hex-символа (криптографически безопасный PRNG). Генерируется заново при каждом `craftArrow()`. Не привязан к устройству, не сохраняется между сессиями.

## Сквозное шифрование (E2EE)

### Рукопожатие
ECDH на кривой P-256. Ephemeral-пары. Обмен публичными ключами через маяки.

### Маяки
- Ключ маяка: `SHA-256(nonce + 'beacon')`, nonce = 128 бит (CRNG)
- HMAC-SHA256 подпись: `HMAC(nonce + peerId, ключ)`
- Получатель проверяет HMAC → расшифровывает AES-256-GCM → извлекает эмодзи
- Защита от подмены nonce через HMAC

### Double Ratchet + HMAC
- Ratchet Key обновляется каждое сообщение: `SHA-256(старый_ключ + индекс)`
- HMAC-SHA256 подписывает каждое сообщение
- Старые ключи сохраняются (до 50) для расшифровки неупорядоченных сообщений
- Автоматическая ресинхронизация при расхождении ratchet

### Шифрование сообщений
- AES-256-GCM, случайный IV (12 байт)
- GZIP-сжатие перед шифрованием
- Случайный паддинг (20–70 байт)
- Фиксированный размер блоба: 4096 байт

## Голосовые сообщения
- Максимальный размер: 300 КБ
- Максимальная длительность: 10 секунд
- Кодек: Opus в WebM, 16 kbps

## API для разработчиков

``javascript
// Инициализация
P2PPong.init()

// Создать маяк
const peerId = await P2PPong.craftArrow()

// Присоединиться к маяку
const ok = await P2PPong.joinBeacon(targetPeerId)

// Подтвердить верификацию
await P2PPong.confirmVerification()

// Отправить сообщение
await P2PPong.sendMessage(channelId, text)

// Отправить голосовое
await P2PPong.sendVoiceMessage(channelId, audioBase64)

// Подписка на события
P2PPong.on('ready', () => {})
P2PPong.on('peer-id-generated', ({ peerId }) => {})
P2PPong.on('verification-needed', ({ emoji }) => {})
P2PPong.on('verification-received', ({ emoji }) => {})
P2PPong.on('channel-opened', ({ channelId, peerId }) => {})
P2PPong.on('message-received', ({ channelId, text, timestamp }) => {})
P2PPong.on('message-sent', ({ channelId, data, status }) => {})
P2PPong.on('error', ({ message }) => {})
Требования к браузеру
HTTPS (обязательно для Web Crypto API)

Web Crypto API (ECDH, AES-GCM, HMAC-SHA256)

WebRTC (опционально, для прямых звонков)

CompressionStream API (для GZIP)

Service Worker (опционально, для PWA)

Известные ограничения
Нет офлайн-доставки сообщений (маяк живёт 5 минут)

Нет групповых чатов (только P2P)

Нет push-уведомлений когда вкладка закрыта

Нет роуминга истории между устройствами

WebRTC может не работать за симметричным NAT без TURN-сервера

Emoji-верификация уязвима к MITM если злоумышленник перехватит маяк до получателя и знает эмодзи

Деплой
Компонент	Где	URL
RobinHood UI	GitHub Pages	stepweather-prog.github.io/ROBINHOOD-P2P
Сигнальный сервер	Cloudflare Worker	robincall.stephanclaps-491.workers.dev
Резервный сервер	Render	p2ppong-v2.onrender.com
Ключевые константы
Параметр	Значение
Кривая ECDH	P-256
Шифрование	AES-256-GCM
HMAC	SHA-256
Nonce (маяк)	128 бит
Старых ключей Ratchet	50
Размер блоба	4096 байт
Время жизни маяка	5 минут
Время жизни канала	10 минут
Макс. попыток эмодзи	5
Макс. размер голосового	300 КБ
Макс. длительность голосового	10 сек
Атрибуция
Иконки и графика: Flaticon

Анимации: Lottie (MIT License)

Звуки: Freesound

Ответственность
Проект предоставляется «как есть» (AS IS), без каких-либо гарантий.

Разработчик не несёт ответственности за прямой или косвенный ущерб

Криптографические решения не прошли независимый аудит безопасности

Сигнальный сервер не читает содержимое сообщений. Метаданные (кто с кем) серверу недоступны

Пользователь самостоятельно оценивает риски

Лицензия
MIT

Связанные проекты
Проект	Репозиторий	Описание
P2PPong Core	github.com/stepweather-prog/P2PPong	Ядро платформы: криптография, DHT, транспорт
Cloudflare Worker	worker.js в P2PPong	Сигнальный сервер
Render Server	server.js в P2PPong	Резервный сигнальный сервер
Спецификация протокола	PROTOCOL.md	Криптография, рукопожатие, формат блобов
