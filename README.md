# RobinHood P2P — OSPRP/HTTPR Protocol v6.3

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Protocol](https://img.shields.io/badge/Protocol-HTTPR%20v1.0-blue)]()

Децентрализованный P2P-мессенджер с оконечным шифрованием (Triple Ratchet, одноразовые сеансы, без сохранения ключей между сессиями). Работает в браузере. Без установки, без центрального сервера хранения сообщений.

Построен на принципах ОГАС академика В.М. Глушкова. Ядро реализовано на чистом JavaScript через Web Crypto API и Web Workers.

---

## 🏗️ Архитектура
RobinHood UI (robinhood-ui.js)
↓ вызовы sendMessage(), craftArrow()
P2PPong (p2ppong.js) — Криптография, ratchet, маяки
↓ через мост (httpr-p2ppong-bridge.js)
HTTPR Core (httpr-core.js) — Плагинная система транспортов
├── HTTPRelayTransport → Cloudflare Workers (основной)
├── HTTPRelayTransport → Render (резервный)
├── Firebase Realtime DB (мгновенная доставка)
└── WebRTC DataChannel (прямой P2P)

## 🔒 Модель угроз

**Проект защищает от:**
- Чтения сообщений третьей стороной (AES-256-GCM + ECDH P-256 + Triple Ratchet)
- Подмены сообщений (HMAC-SHA256 на каждом пакете)
- Повторного воспроизведения старых сообщений (одноразовые nonce + ratchet index)
- Раскрытия истории при компрометации ключа (Perfect Forward Secrecy — sending-ключи уничтожаются сразу после использования)
- Раскрытия будущих сообщений при компрометации текущего ключа (Post-Compromise Security через DH Ratchet каждые 10 сообщений)
- Связывания сессий по Peer ID (beaconId скрывает идентификатор от сервера)
- Массового сбора метаданных в публичном пуле (сервер не знает, какой маяк кому принадлежит)

**Проект НЕ защищает от:**
- Корреляции пиров по IP-адресам и времени запросов
- MitM при компрометации сигнального сервера (рекомендуется подтверждать код голосом или при встрече)
- Анализа паттернов трафика
- Атак на конечные устройства
- Расхождения ratchet при одновременной отправке (автоматическое восстановление через advanceRecvRatchet)

## 🔐 Криптографический стек

**Рукопожатие:**
- ECDH на кривой P-256, ephemeral-пары
- Обмен публичными ключами через маяки

**Triple Ratchet (как в Signal Protocol):**
- Symmetric Ratchet — новый ключ для каждого сообщения (HKDF)
- DH Ratchet — новый корневой ключ каждые 10 сообщений
- Раздельные Send Chain / Recv Chain
- Старые receiving-ключи сохраняются (до 3) для восстановления порядка
- Sending-ключи не сохраняются (Forward Secrecy)
- Автоматическое продвижение ratchet при расхождении индексов

**Конвертное шифрование (HTTPR Envelope):**
- AES-256-GCM на транспортном ключе `SHA-256(secret + "transport")`
- Сервер видит только `beaconId`, не может расшифровать содержимое

**Маяки:**
- Ключ маяка = SHA-256(pubKey + 'beacon')
- HMAC-SHA256 подпись для проверки целостности
- Внутренний слой: AES-256-GCM (peerId, beaconId, код, ник, аватар)

**Сообщения:**
- AES-256-GCM, случайный IV (12 байт)
- HMAC-SHA256 подпись
- GZIP-сжатие перед шифрованием
- Случайный паддинг (20–70 байт)

## 🎯 Режимы маяков (Колчаны)

**Обычный маяк:** beaconId как ключ на сервере. Peer ID скрыт от сервера.

**Публичный колчан:** маяк в общем пуле `/pool`. Джойнер скачивает все маяки и расшифровывает. Сервер не знает, какой маяк кому принадлежит.

**Тайный колчан:** beaconId = SHA-256(секрет + соль). Только создатель и джойнер могут вычислить ключ.

## 🔄 Схема рукопожатия

1. **Алиса:** `craftArrow()` → генерирует PeerID, ECDH, beaconId, код → шифрует внутренности маяка → POST /beacon
2. **Боб:** вставляет beaconId → GET /beacon → получает маяк → проверяет HMAC → расшифровывает
3. **Верификация:** 7-значный код. Боб вводит код → Алиса сверяет → канал открывается
4. **Канал открыт:** Triple Ratchet + WebRTC DataChannel (если доступен)

## 📦 Формат пакета HTTPR

### Конверт (видит транспорт)
``json
{
  "v": 1,
  "tid": "a1b2c3d4...",
  "hop": 0,
  "ttl": 5,
  "ts": 1719000000000,
  "pl": "<base64 зашифрованный payload>"
}
Payload (после расшифровки)
{
  "type": "message",
  "from": "peer_id",
  "to": "peer_id",
  "ch": "channel_id",
  "ri": 5,
  "dh": null,
  "data": "<внутренний шифротекст>"
}
🚀 API
P2PPong (ядро)
P2PPong.init() — инициализация

P2PPong.craftArrow() — создать маяк, возвращает beaconId

P2PPong.craftPublicArrow() — создать маяк в общем пуле

P2PPong.joinBeacon(targetBeaconId) — присоединиться к маяку

P2PPong.confirmVerification() — подтвердить верификацию

P2PPong.sendMessage(channelId, text) — отправить сообщение

P2PPong.sendVoiceMessage(channelId, audioBase64) — отправить голосовое

P2PPong.getBeaconId() — получить beaconId

P2PPong.getVerificationCode() — получить код верификации

События
P2PPong.on('ready', () => {}) — ядро готово

P2PPong.on('peer-id-generated', ({ peerId, beaconId, code }) => {}) — маяк создан

P2PPong.on('verification-needed', ({ code }) => {}) — нужно ввести код

P2PPong.on('channel-opened', ({ channelId, peerId, nick, avatar }) => {}) — канал открыт

P2PPong.on('message-received', ({ channelId, text, timestamp, nick, avatar }) => {}) — сообщение получено

P2PPong.on('message-sent', ({ channelId, data, status }) => {}) — сообщение отправлено

P2PPong.on('beacon-timeout', () => {}) — таймаут ожидания маяка

P2PPong.on('error', ({ message }) => {}) — ошибка

HTTPR Core (транспортный слой)
httpr.registerTransport(transport, config) — зарегистрировать транспорт

httpr.send(payload, routingKey) — отправить пакет

httpr.subscribe(routingKey, callback) — подписаться на канал

httpr.getStats() — статистика транспортов

🎨 Особенности UI
12 тем оформления (Лес, Закат, Океан, Сланец и др.)

Анимации (Lottie): лучник, колчан, дым

Голосовые сообщения (Opus/WebM, до 10 сек)

WebRTC звонки (P2P голос)

Шайки (групповые чаты с иерархией: Соколиный Глаз / Вольные Стрелки)

PIN-блокировка (PBKDF2, 5 цифр)

Листопад (автоудаление сообщений)

QR-коды для передачи маяков

Кнопка "Скурить" (полное уничтожение канала с очисткой кеша)

📋 Требования к браузеру
HTTPS (обязательно)

Web Crypto API (ECDH, AES-GCM, HMAC-SHA256)

Web Workers

WebRTC (опционально)

CompressionStream API (опционально)

⚠️ Известные ограничения
Нет офлайн-доставки (маяк живёт 5 минут)

Нет push-уведомлений когда вкладка закрыта

Нет роуминга истории между устройствами

WebRTC может не работать за симметричным NAT без TURN

Криптографические решения не прошли независимый аудит

📊 Ключевые константы
Параметр	Значение
Кривая ECDH	P-256
Шифрование	AES-256-GCM
HMAC	SHA-256
DH Ratchet порог	10 сообщений
Старых ключей Ratchet	3 (receiving)
Код верификации	7 цифр
Время жизни маяка	5 минут
Время жизни канала	10 минут
Макс. размер голосового	50 КБ
Макс. длительность голосового	10 сек
🌐 Деплой
UI: https://stepweather-prog.github.io/ROBINHOOD-P2P

Cloudflare Worker: https://robincall.stephanclaps-491.workers.dev

Render: https://p2ppong-v2.onrender.com

Firebase: https://robinhood-p2p-a59e1-default-rtdb.europe-west1.firebasedatabase.app

📚 Структура проекта
ROBINHOOD-P2P/
├── index.html                  — PWA-оболочка
├── robinhood-ui.js             — UI (v6.3, HTTPR мост активирован)
├── p2ppong.js                  — Крипто-ядро (v6.2, Triple Ratchet)
├── httpr-core.js               — HTTPR ядро (v1.0, плагинные транспорты)
├── httpr-p2ppong-bridge.js     — Мост HTTPR ↔ P2PPong (v1.3)
├── crypto-worker.js            — Криптография в Web Worker (v3.0)
├── firebase-config.js          — Конфиг Firebase (в .gitignore)
├── peer-help.js                — Вспомогательные функции
├── manifest.json               — PWA манифест
└── assets/                     — Иконки, аватары, звуки, анимации
📄 Лицензия
MIT

⚖️ Ответственность
Проект предоставляется «как есть» (AS IS), без каких-либо гарантий. Разработчик не несёт ответственности за прямой или косвенный ущерб. Криптографические решения не прошли независимый аудит безопасности. Пользователь самостоятельно оценивает риски.

🔗 Связанные проекты
Спецификация протокола — PROTOCOL.md

Слепое рандеву — BLIND-RENDEZVOUS.md

Сигнальный сервер — worker.js / server.js
