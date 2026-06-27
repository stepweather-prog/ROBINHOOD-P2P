Техники слепого рандеву для HTTPR + P2PPong
Введение
После внедрения HTTPR как транспортного ядра архитектура P2PPong получила конвертное шифрование. Теперь сигнальный сервер не видит содержимого пакетов и не знает routingKey в открытом виде. Однако сервер всё ещё может наблюдать:

IP-адреса создателя и джойнера

Временные метки запросов

kid (8-символьный фингерпринт транспортного ключа)

Факт обращения двух сторон к одному kid в близкое время

Этого достаточно, чтобы установить факт связи между двумя устройствами через корреляцию по времени и kid. Задача слепого рандеву — лишить сервер даже этой метаинформации.

Ниже описаны четыре техники, расположенные по нарастанию сложности и слепоты. Первые три — адаптация классических подходов под HTTPR. Четвёртая — собственная техника «Встреча в лесу», использующая сильные стороны HTTPR.

Техника 0: Текущая (конвертное шифрование HTTPR)
Слепота: Базовая
Сложность: Уже реализовано
Latency: ~100ms

Как работает
Создатель зажигает маяк с ключом waiting_<beaconId>

Джойнер приходит на тот же ключ

HTTPR шифрует routingKey внутри конверта

Сервер видит kid вместо beaconId

Что видит сервер
IP1 делает POST с kid: "a1b2c3d4" на ключ waiting_<encrypted>

IP2 делает GET с kid: "a1b2c3d4" на ключ waiting_<encrypted>

Временной интервал: 5-30 секунд

Что может узнать сервер
Два IP обратились к одному kid в близкое время

kid = фингерпринт транспортного ключа, одинаковый для создателя и джойнера

Корреляция: IP1 и IP2 общаются друг с другом

Достоинства
Уже работает

Нулевая дополнительная latency

Сервер не знает содержимого маяка

Недостатки
Сервер всё ещё может коррелировать IP по kid

kid одинаковый у создателя и джойнера

Техника 1: Общий пул маяков (Blind Pool)
Слепота: Высокая
Сложность: Средняя (6-8 часов)
Latency: 1-2 секунды (при 100 маяках)

Принцип
Сервер хранит все маяки в общем пуле без ключей. Создатель помещает маяк в пул. Джойнер скачивает все маяки из пула и пробует расшифровать каждый. Только один расшифруется успешно.

Сервер не знает:

Какой маяк кому принадлежит

Какой маяк искал джойнер

Состоялся ли контакт

Реализация
Серверные эндпоинты:
POST /pool
  Тело: { envelope: "<HTTPR-конверт>", timestamp: 1719000000000 }
  Ответ: { id: 42, status: "added" }
  Ограничения: максимум 100 маяков, TTL 5 минут

GET /pool
  Ответ: { beacons: [{ id: 42, envelope: "...", timestamp: ... }], count: 42 }

DELETE /pool?id=42
  Ответ: { status: "deleted" }
  (опционально, маяки самоудаляются по TTL)
  Создатель:
  async craftPoolArrow() {
    // 1. Формируем маяк как обычно
    const beaconId = RND();
    const code = this._genCode();
    const bd = await this._buildBeaconPacket(beaconId, code);
    *
    // 2. Шифруем маяк (уже зашифрован конвертно)
    const envelope = await this._buildEnvelope(bd);
    *
    // 3. Отправляем в общий пул
    const response = await fetch('/pool', {
        method: 'POST',
        body: JSON.stringify({ 
            envelope, 
            timestamp: Date.now() 
        })
    });
    *
    const { id } = await response.json();
    *
    // 4. Передаём джойнеру: beaconId + code (через QR/текст)
    return { beaconId, code, poolId: id };
}
Джойнер:
async joinPool(beaconId, code) {
    // 1. Скачиваем все маяки из пула
    const response = await fetch('/pool');
    const { beacons } = await response.json();
    *
    // 2. Для каждого маяка пробуем расшифровать конверт
    for (const beacon of beacons) {
        try {
            const env = JSON.parse(beacon.envelope);
            *
            // Пробуем расшифровать с нашим транспортным ключом
            let payload = null;
            *
            // Перебираем все известные нам ключи
            for (const [kid, key] of this._transportKeys) {
                const decrypted = await httprAesGcmDecrypt(env.pl, key);
                if (decrypted) {
                    try {
                        payload = JSON.parse(decrypted);
                        break;
                    } catch(e) {}
                }
            }
            *
            if (!payload) continue;
            *
            // 3. Проверяем что это наш маяк
            if (payload.beaconId === beaconId) {
                // Нашли!
                return this._processBeacon(payload);
            }
        } catch(e) {
            continue;
        }
    }
    *
    throw new Error('Маяк не найден в пуле');
}
Что видит сервер
IP1 сделал POST на /pool (положил маяк)

IP2 сделал GET на /pool (скачал все маяки)

Сервер не знает, какой именно маяк искал IP2

Сервер не знает, связаны ли IP1 и IP2 вообще

IP2 мог просто «посмотреть что в пуле»

Достоинства
Полная слепота сервера: невозможно установить связь между создателем и джойнером

Простота серверной части: тупой массив с TTL

Устойчивость к анализу трафика: поведение джойнера неотличимо от любого другого читателя пула

Недостатки
Latency: O(n) расшифровок, ~1-2 секунды при 100 маяках

Масштабирование: пул ограничен 100 маяками

Вычислительная нагрузка на клиента: 100 попыток расшифровки

Оптимизации
Ленивый пул: джойнер скачивает маяки порциями по 20, начиная с самых новых

Кэш неудач: запоминать kid, которые точно не наши, не пробовать повторно

Приоритет по времени: маяки созданные в последние 2 минуты проверять первыми

Техника 2: Хэш от общего секрета (Secret Hash)
Слепота: Высокая
Сложность: Низкая (2-3 часа)
Latency: ~100ms

Принцип
Вместо случайного beaconId использовать SHA256(общий_секрет + соль) как routingKey. Общий секрет известен только создателю и джойнеру (например, пароль, переданный голосом или через QR). Сервер видит хэш, но не может связать его с пользователями без знания секрета.

Реализация
Создатель:
async craftSecretArrow(secret) {
    // 1. Генерируем соль
    const salt = RND();
    *
    // 2. Вычисляем beaconId из секрета
    const beaconId = await SHA(secret + salt);
    *
    // 3. Формируем маяк
    const code = this._genCode();
    const bd = await this._buildBeaconPacket(beaconId, code);
    bd.salt = salt; // Передаём соль внутри маяка
    *
    // 4. Зажигаем маяк с хэш-ключом
    await this._post('/beacon', {
        keyHash: 'waiting_' + beaconId,
        packet: JSON.stringify(bd)
    });
    *
    // 5. Передаём джойнеру: secret + salt (или только secret, если соль внутри маяка)
    return { beaconId, code, salt };
}
Джойнер:
async joinSecretArrow(secret, salt) {
    // 1. Вычисляем beaconId
    const beaconId = await SHA(secret + salt);
    *
    // 2. Запрашиваем маяк
    const d = await this._getWithRetry('/beacon?key=waiting_' + beaconId);
    *
    if (!d?.packet) throw new Error('Маяк не найден');
    *
    // 3. Обрабатываем маяк как обычно
    return this._processBeacon(JSON.parse(d.packet));
}
Что видит сервер
IP1 делает POST на ключ waiting_<sha256_hash>

IP2 делает GET на тот же ключ

Сервер видит хэш, но не может обратить его без знания секрета

Если секрет достаточно энтропийный (например, 7 случайных слов), перебор невозможен

Достоинства
Низкая latency: один запрос

Простота реализации: минимальные изменения

Сервер не знает beaconId: видит только хэш

Недостатки
Требуется предварительный обмен секретом: пользователи должны договориться о пароле

Корреляция по IP и времени: сервер всё ещё видит два IP у одного ключа

Секрет может быть скомпрометирован: если пароль утекает, сервер может вычислить beaconId

Защита от корреляции
Временная задержка: джойнер ждёт 10-30 секунд перед запросом

Ложные запросы: джойнер делает 2-3 запроса к случайным ключам перед настоящим

Соль внутри маяка: джойнер может сначала скачать соль из открытого канала, не раскрывая факт поиска

Техника 3: Bloom-фильтр + ложные запросы (Bloom Filter)
Слепота: Очень высокая
Сложность: Высокая (10-12 часов)
Latency: ~350ms (3 запроса)

Принцип
Джойнер отправляет серверу Bloom-фильтр, содержащий несколько kid — один настоящий и 5-10 фиктивных. Сервер возвращает все маяки, чьи kid проходят через фильтр. Джойнер делает несколько запросов с разными наборами фиктивных kid и находит пересечение — маяк, присутствующий во всех ответах.

Реализация
Bloom-фильтр (клиент):
class BloomFilter {
    constructor(size = 256, hashCount = 3) {
        this.size = size;
        this.hashCount = hashCount;
        this.bits = new Uint8Array(Math.ceil(size / 8));
    }
    *
    add(item) {
        const hashes = this._hashes(item);
        for (const h of hashes) {
            const idx = h % this.size;
            this.bits[Math.floor(idx / 8)] |= (1 << (idx % 8));
        }
    }
    *
    mightContain(item) {
        const hashes = this._hashes(item);
        for (const h of hashes) {
            const idx = h % this.size;
            if (!(this.bits[Math.floor(idx / 8)] & (1 << (idx % 8)))) {
                return false;
            }
        }
        return true; // Возможно ложноположительное
    }
    *
    _hashes(item) {
        const result = [];
        let h1 = 0, h2 = 0;
        *
        // Двойное хэширование
        for (let i = 0; i < item.length; i++) {
            h1 = (h1 * 31 + item.charCodeAt(i)) >>> 0;
            h2 = (h2 * 37 + item.charCodeAt(i)) >>> 0;
        }
        *
        for (let i = 0; i < this.hashCount; i++) {
            result.push((h1 + i * h2) >>> 0);
        }
        *
        return result;
    }
    *
    serialize() {
        return btoa(String.fromCharCode(...this.bits));
    }
    *
    static deserialize(data) {
        const filter = new BloomFilter();
        filter.bits = new Uint8Array(
            atob(data).split('').map(c => c.charCodeAt(0))
        );
        return filter;
    }
}
Серверный эндпоинт:
POST /search
  Тело: { filter: "<base64_bloom_filter>", requestId: "random_id" }
  Ответ: { beacons: [{ kid: "...", envelope: "..." }], requestId: "random_id" }
  Серверная логика:
app.post('/search', async (req) => {
    const { filter: filterData, requestId } = req.body;
    const filter = BloomFilter.deserialize(filterData);
    *
    const results = [];
    *
    for (const [kid, beacon] of activeBeacons) {
        if (filter.mightContain(kid)) {
            results.push({
                kid: kid,
                envelope: beacon.envelope,
                timestamp: beacon.timestamp
            });
        }
    }
    *
    return { beacons: results, requestId };
});
Джойнер:
async joinWithBloomFilter(targetKid) {
    const NUM_DECOY_KIDS = 7;  // Фиктивных kid
    const NUM_REQUESTS = 3;     // Количество запросов
    *
    // Генерируем фиктивные kid
    const allDecoys = [];
    for (let i = 0; i < NUM_REQUESTS; i++) {
        const decoys = new Set();
        decoys.add(targetKid); // Всегда включаем настоящий
       * 
        while (decoys.size < NUM_DECOY_KIDS + 1) {
            decoys.add(RND().slice(0, 8)); // Случайный 8-символьный kid
        }
        *
        allDecoys.push([...decoys]);
    }
    *
    // Делаем запросы
    const responses = [];
    for (const decoySet of allDecoys) {
        const filter = new BloomFilter();
        for (const kid of decoySet) {
            filter.add(kid);
        }
        *
        const response = await fetch('/search', {
            method: 'POST',
            body: JSON.stringify({
                filter: filter.serialize(),
                requestId: RND()
            })
        });
        *
        responses.push(await response.json());
    }
    *
    // Находим маяк, присутствующий во всех ответах
    const beaconCount = {};
    for (const resp of responses) {
        for (const beacon of resp.beacons) {
            beaconCount[beacon.kid] = (beaconCount[beacon.kid] || 0) + 1;
        }
    }
    *
    // Настоящий маяк будет в ответе на каждый запрос
    const foundKid = Object.entries(beaconCount)
        .find(([kid, count]) => count === NUM_REQUESTS)?.[0];
    *
    if (!foundKid) throw new Error('Маяк не найден');
    *
    // Расшифровываем конверт
    const targetBeacon = responses[0].beacons.find(b => b.kid === foundKid);
    return this._decryptEnvelope(targetBeacon.envelope);
}
Что видит сервер
IP1 сделал POST на /beacon с kid: "a1b2c3d4"

IP2 делает 3 запроса POST /search с разными Bloom-фильтрами

Каждый фильтр содержит ~8 kid (один настоящий + фиктивные)

Сервер возвращает 2-5 маяков на каждый запрос (включая ложноположительные)

Сервер не может определить какой из возвращённых маяков искомый

Сервер не может определить какой kid в фильтре настоящий

Достоинства
Очень высокая слепота: сервер не знает ни какой маяк ищут, ни какой kid настоящий

Компромисс нагрузки: джойнер получает 2-5 маяков вместо всех 100

Гибкость: можно регулировать количество фиктивных kid и запросов

Недостатки
Сложность реализации: Bloom-фильтр на клиенте и сервере

Ложноположительные срабатывания: ~1% вероятность

Несколько запросов: увеличивает latency в 3 раза

Техника 4: «Встреча в лесу» — собственная техника HTTPR
Слепота: Полная
Сложность: Средняя (8-10 часов)
Latency: 5-30 секунд

Принцип
Вдохновлена историей про лес, где деревья не могут двигаться, а люди могут. В классическом P2P сервер — это неподвижное «дерево», к которому приходят и создатель, и джойнер.

Идея: сделать сервер подвижным деревом. Точка рандеву не фиксирована — она перемещается по расписанию, известному только создателю и джойнеру.

Создатель и джойнер договариваются о трёх параметрах:

Начальное время (с точностью до минуты)

Секретный сдвиг (число от 1 до 100)

Количество прыжков (обычно 3-5)

Сервер хранит маяки в циклическом буфере из 100 слотов. Маяк перемещается между слотами по формуле:
slot(t) = (SHA256(secret + floor(t / 60)) + shift) % 100
Где t — текущее время в секундах, floor(t / 60) — номер минуты.

Реализация
Создатель:
async craftForestArrow(secret, shift, jumps) {
    const beaconId = RND();
    const code = this._genCode();
    const bd = await this._buildBeaconPacket(beaconId, code);
    const envelope = await this._buildEnvelope(bd);
    *
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = Math.floor(now / 60);
    *
    // Размещаем маяк в нескольких слотах (текущий + будущие)
    const slots = [];
    for (let j = 0; j < jumps; j++) {
        const minute = currentMinute + j;
        const slotInput = secret + '|' + minute;
        const slotHash = await SHA(slotInput);
        const slotNumber = (parseInt(slotHash.slice(0, 8), 16) + shift) % 100;
        *
        slots.push(slotNumber);
        *
        // Отправляем маяк в этот слот
        await fetch('/forest', {
            method: 'POST',
            body: JSON.stringify({
                slot: slotNumber,
                envelope: envelope,
                expires: (minute + 1) * 60 // Истекает в конце минуты
            })
        });
    }
    *
    return { beaconId, code, secret, shift, jumps };
}
Джойнер:
async joinForestArrow(secret, shift, jumps) {
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = Math.floor(now / 60);
    *
    // Проверяем слоты: текущий, предыдущий и следующий
    // (для компенсации рассинхронизации часов)
    for (let offset = -1; offset <= jumps; offset++) {
        const minute = currentMinute + offset;
        if (minute < 0) continue;
        *
        const slotInput = secret + '|' + minute;
        const slotHash = await SHA(slotInput);
        const slotNumber = (parseInt(slotHash.slice(0, 8), 16) + shift) % 100;
        *
        const response = await fetch('/forest?slot=' + slotNumber);
        const data = await response.json();
        *
        if (data && data.envelope) {
            // Пробуем расшифровать
            const payload = await this._decryptEnvelope(data.envelope);
            if (payload) {
                return this._processBeacon(payload);
            }
        }
    }
    *
    throw new Error('Маяк не найден');
}
Сервер:
// Хранилище: циклический буфер из 100 слотов
const forestSlots = new Array(100).fill(null);

app.post('/forest', async (req) => {
    const { slot, envelope, expires } = req.body;
    *
    if (slot < 0 || slot >= 100) return { error: 'Invalid slot' };
    *
    forestSlots[slot] = {
        envelope,
        expires: expires * 1000 // в миллисекундах
    };
    *
    // Автоочистка
    setTimeout(() => {
        if (forestSlots[slot]?.expires <= Date.now()) {
            forestSlots[slot] = null;
        }
    }, 60000);
    *
    return { status: 'placed', slot };
});

app.get('/forest', async (req) => {
    const slot = parseInt(req.query.slot);
    *
    if (slot < 0 || slot >= 100) return { error: 'Invalid slot' };
    *
    const beacon = forestSlots[slot];
    *
    if (beacon && beacon.expires > Date.now()) {
        return { found: true, envelope: beacon.envelope };
    }
    *
    return { found: false };
});
Что видит сервер
IP1 делает POST на /forest с slot: 42 (и ещё 2-4 слота)

IP2 делает GET на /forest?slot=42 (и ещё несколько соседних слотов)

Другие пользователи тоже читают и пишут в случайные слоты

Сервер не может отличить создателя, джойнера и случайного читателя

Сервер не знает, какие слоты связаны друг с другом

Каждую минуту маяк перемещается в новый слот

Достоинства
Полная слепота: сервер видит только запросы к случайным слотам

Нет корреляции по ключу: слоты меняются каждую минуту

Естественная маскировка: другие пользователи создают шум

Устойчивость к анализу трафика: запросы к слотам неотличимы от фонового шума

Недостатки
Требуется синхронизация времени: часы создателя и джойнера должны быть ±30 секунд

Latency: джойнер может ждать до 60 секунд (начало следующей минуты)

Сложнее отладка: труднее понять почему соединение не удалось

Сравнительная таблица
Критерий	Техника 0 (Текущая)	Техника 1 (Пул)	Техника 2 (Хэш)	Техника 3 (Bloom)	Техника 4 (Лес)
Слепота сервера	Базовая	Высокая	Высокая	Очень высокая	Полная
Корреляция по IP	Да	Нет	Да	Частично	Нет
Latency	~100ms	1-2 сек	~100ms	~350ms	5-30 сек
Сложность сервера	Базовая	Низкая	Без изменений	Средняя	Средняя
Сложность клиента	Базовая	Средняя	Низкая	Высокая	Средняя
Требования к пользователю	Нет	Нет	Обмен секретом	Нет	Обмен параметрами
Масштабируемость	∞	100 маяков	∞	∞	100 слотов
Защита от анализа трафика	Низкая	Высокая	Низкая	Средняя	Очень высокая
Время реализации	Готово	6-8 часов	2-3 часа	10-12 часов	8-10 часов
Рекомендации по внедрению
Фаза 3A: Базовые техники (неделя 1)
Техника 1 — Общий пул (6-8 часов)

Серверные эндпоинты /pool

Клиентский PoolTransport для HTTPR

Режим «Публичный колчан» в UI

Техника 2 — Хэш от секрета (2-3 часа)

Поле ввода пароля в UI

Хэширование beaconId

Режим «Тайный колчан» в UI

Фаза 3B: Продвинутые техники (неделя 2)
Техника 4 — Встреча в лесу (8-10 часов)

Циклический буфер слотов на сервере

Клиентская логика перемещения по слотам

Синхронизация времени

Режим «Лесная встреча» в UI

Фаза 3C: Оптимизация (неделя 3)
Техника 3 — Bloom-фильтр (10-12 часов)

Как оптимизация для масштабирования Техники 1

Когда пул >50 маяков и latency становится проблемой

Итоговая архитектура режимов
Настройки приватности:
├── «Обычный колчан» (Техника 0)
│   └── Быстро, сервер видит корреляцию по kid
│
├── «Публичный колчан» (Техника 1)
│   └── Сервер не знает чей маяк, latency 1-2 сек
│
├── «Тайный колчан» (Техника 2)
│   └── Нужен пароль, сервер не может обратить хэш
│
└── «Лесная встреча» (Техника 4)
    └── Полная анонимность, маяк прыгает по слотам каждую минуту
    Каждый следующий уровень даёт больше приватности ценой небольших неудобств. Пользователь сам выбирает свой баланс. Это и есть настоящая свобода — не навязывать один уровень защиты, а дать выбор.

Заключение
Внедрение HTTPR создало фундамент для всех четырёх техник. Конвертное шифрование уже скрыло содержимое маяков. Теперь задача — скрыть сам факт обращения к маяку.

Техника 1 (Пул) — лучший компромисс для большинства пользователей: высокая слепота, не требует действий от пользователя, приемлемая latency.

Техника 2 (Хэш) — для параноиков: требует пароль, но сервер не может даже вычислить ключ маяка.

Техника 4 (Лес) — для полной анонимности: сервер видит только шум, корреляция невозможна.

Все три техники могут сосуществовать как режимы в одном приложении, работая поверх одного транспортного ядра HTTPR.
