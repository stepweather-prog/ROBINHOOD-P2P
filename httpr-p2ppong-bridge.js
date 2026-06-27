// httpr-p2ppong-bridge.js — v1.0
// Мост между HTTPR Core и P2PPong
// Постепенно заменяет прямые fetch-запросы на HTTPR транспорт

const P2PPongOverHTTPR = {
    _p2ppong: null,
    _httpr: null,
    _bridged: false,
    _originalPost: null,
    _originalGet: null,
    _originalStartPolling: null,
    _originalStopPolling: null,
    _originalHandleIn: null,

    /**
     * Подключить мост между P2PPong и HTTPR Core
     * @param {Object} p2ppong - экземпляр P2PPong
     * @param {HTTPRCore} httpr - экземпляр HTTPRCore
     */
    async bridge(p2ppong, httpr) {
        if (this._bridged) {
            console.warn('[HTTPR Bridge] Уже подключён');
            return;
        }

        this._p2ppong = p2ppong;
        this._httpr = httpr;

        // Сохраняем оригинальные методы
        this._originalPost = p2ppong._post.bind(p2ppong);
        this._originalGet = p2ppong._get.bind(p2ppong);
        this._originalStartPolling = p2ppong.startPolling.bind(p2ppong);
        this._originalStopPolling = p2ppong._stopPolling.bind(p2ppong);
        this._originalHandleIn = p2ppong._handleIn.bind(p2ppong);

        // Подменяем методы
        this._patchPost(p2ppong);
        this._patchGet(p2ppong);
        this._patchPolling(p2ppong);
        this._patchHandleIn(p2ppong);

        this._bridged = true;
        console.log('[HTTPR Bridge] Подключён');
    },

    /**
     * Отключить мост, вернуть оригинальные методы
     */
    async unbridge() {
        if (!this._bridged) return;

        const p = this._p2ppong;

        p._post = this._originalPost;
        p._get = this._originalGet;
        p.startPolling = this._originalStartPolling;
        p._stopPolling = this._originalStopPolling;
        p._handleIn = this._originalHandleIn;

        this._p2ppong = null;
        this._httpr = null;
        this._bridged = false;

        console.log('[HTTPR Bridge] Отключён');
    },

    /**
     * Маппинг старых типов пакетов P2PPong → новые HTTPR
     */
    _mapTypeToHTTPR(oldType) {
        const map = {
            'beacon': 'beacon',
            'beacon-response': 'beacon-resp',
            'beacon-ack': 'beacon-ack',
            'verification-code': 'verify-code',
            'webrtc-offer': 'webrtc-offer',
            'webrtc-answer': 'webrtc-answer',
            'webrtc-ice': 'webrtc-ice',
            'channel-destroyed': 'channel-close',
            'band-destroyed': 'channel-close'
        };
        return map[oldType] || null;
    },

    /**
     * Маппинг новых типов HTTPR → старые P2PPong
     */
    _mapTypeToOld(newType) {
        const map = {
            'beacon': 'beacon',
            'beacon-resp': 'beacon-response',
            'beacon-ack': 'beacon-ack',
            'verify-code': 'verification-code',
            'message': null,
            'voice': null,
            'webrtc-offer': null,
            'webrtc-answer': null,
            'webrtc-ice': null,
            'channel-close': 'channel-destroyed',
            'beacon-close': 'channel-destroyed',
            'system': null,
            'ping': null,
            'ratchet-resync': 'ratchet-resync',
            'fragment': null
        };
        return map[newType] !== undefined ? map[newType] : null;
    },

    /**
     * Извлечь тип пакета из сырых данных
     */
    _detectPacketType(packetData) {
        try {
            const parsed = JSON.parse(packetData);
            return parsed.type || null;
        } catch (e) {
            return null;
        }
    },

    /**
     * Подменить _post — отправка через HTTPR
     */
    _patchPost(p2ppong) {
        const self = this;

        p2ppong._post = async function (path, body) {
            const keyHash = body?.keyHash;
            const packet = body?.packet || JSON.stringify(body);

            // Если HTTPR не готов — используем оригинал
            if (!self._httpr || !keyHash) {
                return self._originalPost(path, body);
            }

            // Определяем тип пакета
            const oldType = self._detectPacketType(packet);
            const newType = self._mapTypeToHTTPR(oldType) || 'system';

            // Строим HTTPR payload
            const payload = {
                type: newType,
                from: p2ppong._peerId,
                to: p2ppong._remotePeerId || null,
                ch: p2ppong._chId || null,
                ri: 0,
                dh: null,
                data: packet
            };

            // Отправляем через HTTPR
            try {
                const result = await self._httpr.send(payload, keyHash);
                if (result.success) {
                    // Успешно отправлено через HTTPR
                    return { ok: true };
                }
            } catch (e) {
                console.warn('[HTTPR Bridge] Send failed:', e.message);
            }

            // Fallback: оригинальный метод
            return self._originalPost(path, body);
        };
    },

    /**
     * Подменить _get — для health-check оставляем прямой
     */
    _patchGet(p2ppong) {
        const self = this;

        p2ppong._get = async function (path) {
            // Пробуем через HTTPR подписку
            const keyHash = new URLSearchParams(path.split('?')[1])?.get('key');

            if (self._httpr && keyHash) {
                // _get для получения маяка/сообщения
                // Используем одноразовый запрос через HTTPR
                try {
                    // HTTPR не имеет метода get — только subscribe
                    // Поэтому для совместимости оставляем прямой запрос
                    // Но помечаем что этот ключ нужно слушать
                } catch (e) {}
            }

            // Fallback: оригинальный метод
            return self._originalGet(path);
        };
    },

    /**
     * Подменить поллинг на HTTPR подписки
     */
    _patchPolling(p2ppong) {
        const self = this;

        p2ppong.startPolling = function (keyHash) {
            if (!keyHash) return;

            // Останавливаем предыдущий поллинг
            p2ppong._stopPolling();

            p2ppong._pollKey = keyHash;
            p2ppong._pollStart = Date.now();

            // Подписываемся через HTTPR
            if (self._httpr) {
                self._httpr.subscribe(keyHash, (payload, meta) => {
                    if (payload && payload.data) {
                        p2ppong._stopPolling();
                        p2ppong._handleIn(payload.data);
                    }
                }).catch(e => {
                    console.warn('[HTTPR Bridge] Subscribe failed:', e.message);
                });
            }

            // Firebase слушатель
            if (p2ppong._firebaseActive) {
                p2ppong._firebaseListen(keyHash, (data) => {
                    if (data && data.packet) {
                        p2ppong._stopPolling();
                        p2ppong._handleIn(data.packet);
                    }
                });
            }

            // Оставляем HTTP поллинг как резерв
            p2ppong._doPoll();
        };

        p2ppong._stopPolling = function () {
            if (p2ppong._pollTimer) {
                clearTimeout(p2ppong._pollTimer);
                p2ppong._pollTimer = null;
            }

            // Отписываемся от HTTPR
            if (self._httpr && p2ppong._pollKey) {
                self._httpr.unsubscribe(p2ppong._pollKey).catch(() => {});
            }

            // Отписываемся от Firebase
            if (p2ppong._pollKey) {
                p2ppong._firebaseUnlisten(p2ppong._pollKey);
            }
        };
    },

    /**
     * Подменить _handleIn — поддержка конвертов HTTPR
     */
    _patchHandleIn(p2ppong) {
        const self = this;

        p2ppong._handleIn = async function (blobData) {
            // Пробуем распарсить как HTTPR конверт
            try {
                const env = JSON.parse(blobData);

                // Проверяем что это HTTPR конверт
                if (env.v && env.pl && env.tid) {
                    let payload;

                    // Пробуем расшифровать конверт
                    if (env.kid && self._httpr && self._httpr._transportKeys) {
                        const transportKey = self._httpr._transportKeys.get(env.kid);
                        if (transportKey) {
                            const decrypted = await httprAesGcmDecrypt(env.pl, transportKey);
                            if (decrypted) {
                                try {
                                    payload = JSON.parse(decrypted);
                                } catch (e) {
                                    payload = JSON.parse(blobData);
                                }
                            }
                        }
                    }

                    // Если не расшифровали — пробуем без шифрования
                    if (!payload) {
                        try {
                            payload = JSON.parse(httprDecodeBase64(env.pl));
                        } catch (e) {
                            payload = JSON.parse(blobData);
                        }
                    }

                    if (payload && payload.type) {
                        // Маппим новый тип на старый
                        const oldType = self._mapTypeToOld(payload.type);

                        // Извлекаем данные
                        let dataToProcess = payload.data || blobData;

                        // Для message/voice — передаём как есть
                        if (payload.type === 'message' || payload.type === 'voice') {
                            // Пробуем распарсить внутренние данные
                            try {
                                const inner = JSON.parse(payload.data);
                                // Передаём оригинальный формат
                                dataToProcess = payload.data;
                            } catch (e) {
                                dataToProcess = payload.data;
                            }
                        }

                        // Для beacon типов — сохраняем правильный type
                        if (oldType) {
                            try {
                                const parsed = JSON.parse(dataToProcess);
                                parsed.type = oldType;
                                dataToProcess = JSON.stringify(parsed);
                            } catch (e) {}
                        }

                        // Обрабатываем через оригинальный метод
                        return self._originalHandleIn(dataToProcess);
                    }
                }
            } catch (e) {
                // Не HTTPR конверт — обрабатываем как обычно
            }

            // Вызываем оригинальный обработчик
            return self._originalHandleIn(blobData);
        };
    },

    /**
     * Установить транспортный ключ для конвертного шифрования
     * @param {string} key - ключ шифрования конвертов
     * @returns {string} kid - идентификатор ключа
     */
    async setTransportKey(key) {
        if (!this._httpr) throw new Error('Мост не подключён');
        return this._httpr.setTransportKey(key);
    },

    /**
     * Удалить транспортный ключ
     */
    removeTransportKey(kid) {
        if (this._httpr) {
            this._httpr.removeTransportKey(kid);
        }
    },

    /**
     * Получить статистику HTTPR
     */
    getStats() {
        if (!this._httpr) return null;
        return this._httpr.getStats();
    },

    /**
     * Получить имя активного транспорта
     */
    getActiveTransport() {
        if (!this._httpr) return null;
        return this._httpr.getActiveTransport();
    }
};

if (typeof window !== 'undefined') {
    window.P2PPongOverHTTPR = P2PPongOverHTTPR;
}
