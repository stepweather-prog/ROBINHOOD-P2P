# P2PPong Protocol Specification v1.0

## 1. Введение

P2PPong — распределённая P2P-платформа для защищённой коммуникации, построенная на принципах ОГАС академика В.М. Глушкова.

Платформа обеспечивает:
- Оконечное шифрование (E2EE) всех сообщений
- Децентрализованную маршрутизацию через DHT (Kademlia)
- Адресную доставку маяков (не broadcast)
- Отказоустойчивость с тремя уровнями сигнальной сети
- Защиту от replay-атак и анализа размера сообщений

---

## 2. Идентификация пиров

### 2.1 Peer ID

Peer ID = первые 32 символа SHA-256 от конкатенации:

WebGL_VENDOR + WebGL_RENDERER + AudioContext_SampleRate + AudioContext_MaxChannels

Screen_Width + Screen_Height + ColorDepth + HardwareConcurrency + DeviceMemory + RandomSalt


Где:
- WebGL_VENDOR — gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)
- WebGL_RENDERER — gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
- AudioContext_SampleRate — ctx.sampleRate.toString()
- AudioContext_MaxChannels — ctx.destination.maxChannelCount.toString()
- Screen_Width, Screen_Height — screen.width + 'x' + screen.height
- ColorDepth — screen.colorDepth.toString()
- HardwareConcurrency — navigator.hardwareConcurrency || ''
- DeviceMemory — navigator.deviceMemory || ''
- RandomSalt — crypto.getRandomValues(new Uint32Array(4)), сохраняется в localStorage однократно

Свойства:
- Стабильный для одного устройства (не меняется между сессиями)
- Не привязан к личности пользователя
- Не требует регистрации
- Может быть сброшен очисткой localStorage

---

## 3. Сигнальная сеть (три уровня)

### 3.1 Уровень 1: WebSocket (Cloudflare Worker)

Пир А ──WSS──► Cloudflare Worker ◄──WSS── Пир Б


- Протокол: WSS (WebSocket Secure)
- Адрес: wss://robincall.stephanclaps-491.workers.dev/ws
- Назначение: быстрая адресная маршрутизация маяков и DHT-сигналов
- Worker не читает содержимое сообщений
- Worker не хранит историю подключений дольше времени жизни WebSocket
- Worker доставляет сообщения только целевому пиру (по targetPeerId), не делает broadcast

### 3.2 Уровень 2: HTTP Polling (Render)

Пир А ──HTTPS──► Render Server ◄──HTTPS── Пир Б


- Протокол: HTTPS (REST API)
- Адрес: https://p2ppong-v2.onrender.com
- Назначение: резервный канал при блокировке WebSocket

Эндпоинты:
- POST /beacon — создать маяк
- POST /find — найти маяк по tempKeyHash
- POST /message — отправить зашифрованное сообщение
- GET /message?id=&since= — получить сообщения (long polling, 2 сек)
- GET /ping — проверка здоровья сервера

### 3.3 Уровень 3: Прямой DHT (WebRTC DataChannel)


Пир А ──WebRTC DataChannel──► Пир Б


- Без серверов вообще
- Используется Kademlia-подобный DHT (256 корзин, k=20, α=3)
- Прямые соединения через RTCPeerConnection

---

## 4. Рукопожатие (Handshake)

### 4.1 Маяк (Beacon)

Цель: установить защищённый канал между двумя пирами без раскрытия их связи серверу.

Процесс:
1. Пир А генерирует ephemeral-пару ECDH P-256: (kp_A_priv, kp_A_pub)
2. Вычисляет beaconKey = SHA-256(nonce + "beacon")
3. Шифрует inner-сообщение: inner = AES-256-GCM(JSON.stringify({nonce, timestamp, peerId_A}), beaconKey)
4. Формирует маяк:

{
"type": "beacon",
"pubKey": "base64(kp_A_pub)",
"peerId": "peerId_A",
"inner": "base64(iv + ciphertext)",
"targetPeerId": "peerId_B",
"nick": "Alice",
"avatar": "042",
"sig": "HMAC-SHA256(beaconKey, beacon_data)"
}


5. Отправляет маяк через сигнальный сервер только пиру Б (по targetPeerId)

### 4.2 Ответ на маяк (Beacon Response)

1. Пир Б получает маяк
2. Проверяет подпись sig через HMAC-SHA256(SHA-256("beacon"), beacon_data)
3. Если подпись верна — генерирует свою ephemeral-пару: (kp_B_priv, kp_B_pub)
4. Вычисляет общий секрет: sharedSecret = ECDH(kp_B_priv, kp_A_pub)
5. Создаёт канал: channelId = RND(), channel.secret = sharedSecret
6. Отправляет ответ:

{
"type": "beacon-response",
"pubKey": "base64(kp_B_pub)",
"peerId": "peerId_B",
"inner": "inner_from_beacon",
"nick": "Bob",
"avatar": "001"
}


### 4.3 Завершение рукопожатия

1. Пир А получает beacon-response
2. Вычисляет общий секрет: sharedSecret = ECDH(kp_A_priv, kp_B_pub)
3. Создаёт канал: channelId = RND(), channel.secret = sharedSecret
4. Канал установлен. Оба пира имеют одинаковый sharedSecret.

---

## 5. Double Ratchet

### 5.1 Инициализация

ratchetKey = sharedSecret
ratchetIndex = 0
oldKeys = []


### 5.2 Продвижение Ratchet (каждое сообщение)
salt = ratchetIndex.toString(16).padStart(16, '0')
newKey = SHA-256(ratchetKey + salt)

oldKeys.push({ index: ratchetIndex, key: ratchetKey })
if (oldKeys.length > 50) oldKeys.shift()

ratchetKey = newKey
ratchetIndex = ratchetIndex + 1


### 5.3 Расшифровка сообщений

При получении сообщения с индексом ri:
1. Если ri > lastReceivedRi — использовать tryDecryptWithKey(decrypted, ratchetKey)
2. Если не удалось — перебрать oldKeys в обратном порядке
3. Если ни один ключ не подошёл — запросить ресинхронизацию

### 5.4 Ресинхронизация

При расхождении ratchet:
1. Сгенерировать новую ephemeral-пару ECDH
2. Отправить ratchet-resync сообщение с новым публичным ключом
3. Получатель вычисляет новый sharedSecret через ECDH
4. Оба пира сбрасывают ratchetIndex = 0, oldKeys = []
5. Канал продолжает работу с новым секретом

---

## 6. Формат сообщения (Blob)

### 6.1 Упаковка (Pack)

1. Исходные данные: JSON.stringify({ d: "hello", t: timestamp, n: nonce })
2. GZIP-сжатие: compressData(jsonString)
3. Случайный паддинг: padSize = random(20, 70) байт
4. Формирование пакета:

data = JSON.stringify({
z: compressed_base64,
t: timestamp,
n: nonce,
pad: random_pad_base64,
ri: ratchetIndex
})


5. HMAC-подпись: hmac = HMAC-SHA256(currentRatchetKey, data)
6. Сборка: packed = hmac + '|' + data
7. Дополнение до 4096 байт:
if (packed.length < 4096) {
pad = crypto.getRandomValues(new Uint8Array(4096 - packed.length))
packed += String.fromCharCode(...pad)
}

8. Шифрование: blob = AES-256-GCM(channel.secret, packed)

### 6.2 Распаковка (Unpack)

1. Расшифрование: decrypted = AES-256-GCM-Decrypt(channel.secret, blob)
2. Поиск разделителя: separatorIndex = decrypted.indexOf('|')
3. Извлечение HMAC: hmac = decrypted[0..separatorIndex]
4. Извлечение данных: data = decrypted[separatorIndex+1..]
5. Проверка HMAC: HMAC-SHA256-Verify(currentRatchetKey, data, hmac)
6. Если не совпало — перебрать oldKeys
7. Парсинг JSON, извлечение z (сжатые данные)
8. GZIP-распаковка: decompressData(z)
9. Парсинг итогового JSON с полями d, t, n
10. Проверка на replay-атаку: ri > lastReceivedRi

---

## 7. DHT (Kademlia)

### 7.1 Параметры

- Количество корзин: 256
- Размер корзины (k): 20
- Параллелизм поиска (α): 3
- Метрика расстояния: XOR

### 7.2 Маршрутизация

distance = XOR(peerId_A, peerId_B)
bucketIndex = getBucketIndex(distance)

closestPeers = allPeers
.map(peer => ({ ...peer, distance: XOR(targetId, peer.id) }))
.sort((a, b) => a.distance < b.distance ? -1 : 1)
.slice(0, k)


### 7.3 Хранение данных

DHT хранит произвольные пары key → value:
DHT._storage[key] = {
value: data,
publisher: peerId,
timestamp: Date.now()
}

---

## 8. Слепая ячейка (Blind Locker)

### 8.1 Принцип

Сервер не знает ни кто положил маяк, ни кто забрал, ни что внутри.

Маяк кладётся в ячейку по ключу `keyHash = SHA-256(nonce + targetPeerId)`. Забрать маяк может любой кто знает `keyHash`. `keyHash` передаётся от отправителя к получателю вне канала.

### 8.2 Процесс

1. Пир А генерирует `nonce`, вычисляет `keyHash`
2. Пир А отправляет `POST /beacon` с `keyHash` и зашифрованным пакетом
3. Сервер сохраняет пакет в ячейке `keyHash`
4. Пир Б опрашивает `GET /beacon?key=keyHash`
5. Сервер отдаёт пакет и удаляет ячейку
6. Если за 60 секунд никто не забрал — ячейка самоуничтожается

### 8.3 Защита

- Сервер не знает `targetPeerId` (он внутри зашифрованного пакета)
- Сервер не знает кто положил (HTTP-запрос анонимный)
- Сервер не знает кто забрал (ключ известен только А и Б)
- Пакет защищён HMAC — невозможно подменить

---

## 9. Защита от атак

- Replay-атака: проверка ratchetIndex. Сообщения с ri <= lastReceivedRi отбрасываются
- Анализ размера: все блобы дополняются до 4096 байт случайным паддингом
- MITM на сигнальном сервере: сервер не может прочитать содержимое (AES-GCM), не может подменить (HMAC)
- Sybil-атака на DHT: ограничение k=20 пиров на корзину
- Перехват маяка: маяк зашифрован beaconKey, который известен только отправителю и целевому пиру

---

## 10. Ограничения и известные проблемы

- Отсутствие независимого криптоаудита — требуется
- Peer ID может использоваться как fingerprint устройства — добавить опцию "одноразовый Peer ID"
- Зависимость от Cloudflare/Render для первоначального соединения — частично решено через DHT
- Нет офлайн-режима — запланировано
- Нет групповых чатов — запланировано

---

## 11. Совместимость

- Браузер: Chrome 80+, Firefox 75+, Safari 15+, Edge 80+
- Web Crypto API: SubtleCrypto (ECDH, AES-GCM, HMAC)
- WebRTC: RTCPeerConnection, DataChannel
- Сжатие: CompressionStream / DecompressionStream
- Сеть: HTTPS (обязательно), WebSocket

---

## 12. История версий

- v1.0 (Июнь 2026): Первая публичная спецификация. Double Ratchet (50 ключей), адресная доставка, три уровня сети.

---

## 13. Лицензия

MIT. Спецификация может свободно использоваться для реализации совместимых клиентов.

