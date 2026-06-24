# P2PPong Protocol Specification v1.0

**Версия протокола: 1.0.** Кривая: P-256. Шифрование: AES-256-GCM. HMAC: SHA-256. При смене кривой или алгоритма шифрования — мажорное обновление версии протокола.

## 1. Введение

P2PPong — распределённая P2P-платформа для защищённой коммуникации, построенная на принципах ОГАС академика В.М. Глушкова. Платформа обеспечивает: оконечное шифрование (E2EE) всех сообщений, одноразовые сеансы (каждая встреча как первая, без сохранения ключей), три режима соединения (обычный маяк, публичный пул, тайный колчан), адресную доставку маяков (не broadcast), отказоустойчивость с тремя уровнями сигнальной сети, защиту от replay-атак.

## 2. Идентификация пиров

**Peer ID** = 32 случайных hex-символа, сгенерированных через `crypto.getRandomValues()`. Генерируется заново при каждом `craftArrow()`. Не привязан к устройству, не сохраняется между сессиями. Каждая сессия — новый Peer ID.

**Beacon ID** = 32 случайных hex-символа, сгенерированных через `crypto.getRandomValues()`. Используется как ключ на сигнальном сервере (`waiting_<beaconId>`). Peer ID скрыт от сервера — он находится внутри зашифрованного inner-пакета. Beacon ID передаётся между пользователями для соединения.

## 3. Сигнальная сеть (три уровня)

**Уровень 1 — Cloudflare Worker:** HTTPS REST API по адресу `https://robincall.stephanclaps-491.workers.dev`. Назначение: быстрая адресная маршрутизация маяков, публичный пул `/pool`. Эндпоинты: `POST /beacon`, `GET /beacon?key=`, `DELETE /delete?key=`, `POST /pool`, `GET /pool`, `DELETE /pool?id=`, `GET /health`. Worker не читает содержимое сообщений, не хранит историю подключений дольше TTL маяка.

**Уровень 2 — Render Server:** HTTPS REST API по адресу `https://p2ppong-v2.onrender.com`. Назначение: резервный канал при недоступности Cloudflare Worker. Эндпоинты идентичны Уровню 1.

**Уровень 3 — WebRTC DataChannel:** Прямые соединения через RTCPeerConnection без серверов. Используется для передачи сообщений после установки канала. Резервный канал: HTTP-поллинг через сигнальный сервер.

## 4. Режимы соединения

**Обычный маяк:** Beacon ID генерируется случайно. Маяк кладётся на сервер по ключу `waiting_<beaconId>`. Джойнер запрашивает маяк по тому же ключу. Peer ID скрыт внутри зашифрованного inner-пакета.

**Публичный колчан (Blind Pool):** Маяк кладётся в общий пул `/pool` без ключа. Джойнер скачивает все маяки из пула и пытается расшифровать каждый. Сервер не знает, какой маяк кому принадлежит. Параметры пула: максимум 100 маяков, TTL 5 минут, маяк удаляется после успешного соединения.

**Тайный колчан (Hash from Secret):** Beacon ID = SHA-256(секрет + соль). Только создатель и джойнер, знающие секрет, могут вычислить ключ маяка. Соль передаётся внутри зашифрованного inner-пакета. Требует обмена секретом вне полосы.

## 5. Рукопожатие (Handshake)

**Маяк (Beacon):** Пир А генерирует ephemeral-пару ECDH P-256 `(kp_A_priv, kp_A_pub)`, генерирует `peerId_A`, `beaconId`, `code` (7 цифр), вычисляет ключ маяка `bk = SHA-256(pubKey_A + "beacon")`, шифрует inner-сообщение `inner = AES-256-GCM(JSON.stringify({timestamp, peerId_A, beaconId, code, nick, avatar}), bk)`, формирует маяк `{ type: "beacon", pubKey: base64(kp_A_pub), peerId: peerId_A, inner: base64(iv + ciphertext), signalServer: url, sig: HMAC-SHA256(pubKey + peerId, bk) }`, отправляет на сервер `POST /beacon` с `keyHash: 'waiting_' + beaconId`.

**Ответ (Beacon Response):** Пир Б получает маяк по `beaconId`, проверяет подпись `HMAC-SHA256(pubKey + peerId, sig, bk)` где `bk = SHA-256(pubKey + "beacon")`, расшифровывает inner, генерирует свою ephemeral-пару `(kp_B_priv, kp_B_pub)`, вычисляет общий секрет `sharedSecret = ECDH(kp_B_priv, kp_A_pub)`, отправляет beacon-response на сервер по ключу `waiting_<beaconId>`, отправляет verification-code на сервер по ключу `code_<beaconId>`.

**Верификация:** Пир А получает verification-code, сверяет код. При совпадении канал открывается автоматически. Код: 7 цифр через `crypto.getRandomValues()`. Опционально: подтверждение через QR-код или голос (Web Speech API).

**Завершение:** Пир А получает beacon-response, вычисляет `sharedSecret = ECDH(kp_A_priv, kp_B_pub)`, создаёт канал `channelId = RND()`, `channel.secret = sharedSecret`. Канал установлен. Оба пира имеют одинаковый sharedSecret.

## 6. Раздельные Ratchet

**Инициализация канала:** `sendKey = sharedSecret`, `sendIndex = 0`, `recvKey = sharedSecret`, `recvIndex = 0`, `oldRecvKeys = []`.

**Отправка (Sending Chain):** `salt = 'send_' + sendIndex.toString(16).padStart(16, '0')`, `newKey = SHA-256(sendKey + salt)`, `sendKey = newKey`, `sendIndex = sendIndex + 1`. Sending-ключи не сохраняются — старый ключ удаляется (forward secrecy).

**Получение (Receiving Chain):** При получении сообщения с индексом `ri`: если `ri > recvIndex`, прокрутить receiving chain до `ri`: `salt = 'recv_' + recvIndex.toString(16).padStart(16, '0')`, `newKey = SHA-256(recvKey + salt)`, `oldRecvKeys.push({ index: recvIndex, key: recvKey })`, `recvKey = newKey`, `recvIndex = recvIndex + 1`. Хранить последние 3 старых receiving-ключа. При расшифровке: сначала `recvKey`, затем `oldRecvKeys` в обратном порядке.

**Ресинхронизация:** Сгенерировать новую ephemeral-пару ECDH, отправить `ratchet-resync` с новым публичным ключом, получатель вычисляет новый sharedSecret через ECDH, оба пира сбрасывают: `sendKey = recvKey = sharedSecret`, `sendIndex = recvIndex = 0`, `oldRecvKeys = []`.

## 7. Формат сообщения (Blob)

**Упаковка:** Исходные данные `JSON.stringify({ type: "text", d: "hello", t: timestamp, n: nonce, from: peerId, nick, avatar })` → GZIP-сжатие → случайный паддинг 20–70 байт → пакет `{ z: compressed_base64, t: timestamp, n: nonce, ri: sendIndex }` → HMAC-подпись `hmac = HMAC-SHA256(sendKey, data)` → сборка `payload = hmac + '\x00' + data` → шифрование `blob = AES-256-GCM(channel.secret, payload)`. Максимальный размер пакета: 65536 байт.

**Распаковка:** Расшифрование `decrypted = AES-256-GCM-Decrypt(channel.secret, blob)` → поиск разделителя `\x00` → извлечение HMAC и данных → проверка HMAC через `recvKey` или `oldRecvKeys` → парсинг JSON → GZIP-распаковка с защитой от zip-бомбы (макс. 1 МБ) → проверка на replay-атаку: `ri > lastReceivedRi`.

## 8. Слепая ячейка (Blind Locker)

Сервер хранит маяки как key-value пары. Ключ — `beaconId`. Значение — зашифрованный пакет. Сервер не знает ни кто положил маяк, ни кто забрал, ни что внутри. Процесс: Пир А генерирует `beaconId`, вычисляет `bk = SHA-256(pubKey + "beacon")`, отправляет `POST /beacon` с `keyHash: 'waiting_' + beaconId`. Сервер сохраняет пакет. Пир Б запрашивает `GET /beacon?key=waiting_<beaconId>`. Для webrtc-пакетов ячейка помечается как `taken`. Для сообщений (`msg_`) ячейка остаётся доступной. Защита: сервер не знает `peerId` (внутри inner), не может вычислить `bk` без приватного ключа, пакет защищён HMAC. В режиме публичного пула сервер не знает, какой маяк кому принадлежит.

## 9. Защита от атак

- **Replay-атака:** проверка ratchetIndex, сообщения с `ri <= lastReceivedRi` отбрасываются
- **Анализ размера:** случайный паддинг 20–70 байт
- **MITM на сервере:** сервер не может прочитать содержимое (AES-GCM), не может подменить (HMAC)
- **Перехват маяка:** маяк зашифрован bk = SHA-256(pubKey + "beacon"), сервер не может вычислить bk без приватного ключа
- **Компрометация ключа:** sending-ключи не сохраняются (forward secrecy), история не расшифровывается задним числом

## 10. Ограничения и известные проблемы

Отсутствие независимого криптоаудита (требуется). Корреляция по IP и времени: сервер видит два IP у одного ключа (в публичном пуле ослаблена). Код верификации через сервер: MitM возможен при компрометации сервера (рекомендуется голосовое подтверждение). Рассинхрон ratchet при одновременной отправке. Зависимость от Cloudflare/Render для первоначального соединения. Нет офлайн-режима (маяк — 5 минут). Нет групповых чатов (только P2P).

## 11. Совместимость

Браузер: Chrome 80+, Firefox 75+, Safari 15+, Edge 80+. Web Crypto API: SubtleCrypto (ECDH, AES-GCM, HMAC). WebRTC: RTCPeerConnection, DataChannel (опционально). Сжатие: CompressionStream / DecompressionStream. Сеть: HTTPS (обязательно).

## 12. История версий

**v1.0** (Июнь 2026): Первая публичная спецификация. Раздельные sending/receiving ratchet, три режима соединения, публичный пул маяков, beaconId для сокрытия Peer ID.

## 13. Лицензия

MIT. Спецификация может свободно использоваться для реализации совместимых клиентов.
