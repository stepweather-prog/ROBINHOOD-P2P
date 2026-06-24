# Пакет для независимого криптоаудита P2PPong v1.0

## Объём аудита

Проверке подлежат следующие компоненты:
1. crypto-worker.js — реализация ECDH, AES-256-GCM, HMAC-SHA256, Double Ratchet
2. p2ppong.js — протокол рукопожатия, обмен ключами, ratchet, формат пакетов
3. server.js / worker.js — слепая ячейка и публичный пул (на предмет утечки метаданных)

## Не подлежат проверке

- robinhood-ui.js (UI, анимации, голосовые звонки)
- peer-help.js (фоновая P2P-помощь)
- sw.js (service worker)
- index.html, manifest.json

## Ключевые вопросы аудитору

1. Достаточна ли энтропия генерации ключей? (crypto.getRandomValues, crypto.subtle.generateKey)
2. Корректна ли реализация ECDH P-256? (deriveSecret, импорт/экспорт ключей)
3. Правильно ли используется AES-256-GCM? (IV 12 байт, аутентификация тега)
4. Непротиворечива ли логика Double Ratchet? (раздельные sending/receiving, forward secrecy)
5. Возможна ли атака на верификационный код? (crypto.getRandomValues, 7 цифр = ~23 бит)
6. Какие метаданные доступны серверу в каждом из трёх режимов соединения?
7. Есть ли векторы атак на HMAC-подпись маяка? (SHA-256(pubKey + "beacon"))

## Расположение файлов

- Криптография: `/crypto-worker.js`
- Протокол: `/p2ppong.js` (функции craftArrow, joinBeacon, _handleIn, _sendEncrypted)
- Спецификация: `/PROTOCOL.md`
- Слепое рандеву: `/BLIND-RENDEZVOUS.md`

## Ожидаемый результат

Отчёт с перечнем уязвимостей, ранжированных по критичности (Critical/Major/Minor), и рекомендациями по исправлению.
