// ===================================================================
// P2PPong v1.0 — Распределённая платформа (ядро)
// Подключение: <script src="p2ppong.js"></script>
// Всё общение через события: P2PPong.on('событие', callback)
// ===================================================================

const P2PPong = {
    // ==================== СОСТОЯНИЕ ====================
    _peerId: null,
    _beacons: {},
    _channels: {},
    _ws: null,
    _signalServers: [
        'wss://robincall.stephanclaps-491.workers.dev/ws',
        // 'wss://p2ppong-render.onrender.com/ws'  // раскомментировать когда поднимешь Render
    ],
    _currentSignalIndex: 0,
    _wsReconnectDelay: 1000,
    _maxReconnectDelay: 30000,
    _listeners: {},
    _state: 'idle', // idle | connecting | online | offline
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },

    // ==================== ШИНА СОБЫТИЙ ====================
    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return () => { // возвращаем функцию для отписки
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        };
    },

    _emit(event, data) {
        if (!this._listeners[event]) return;
        this._listeners[event].forEach(cb => {
            try { cb(data); } catch(e) { console.error('[P2PPong] Event error:', event, e); }
        });
    },

    // ==================== ИНИЦИАЛИЗАЦИЯ ====================
    async init(options = {}) {
        if (this._state !== 'idle') return;

        this._state = 'connecting';
        this._emit('state-change', { state: 'connecting' });

        try {
            this._peerId = await generateHardwarePeerId();
            DHT._nodeId = this._peerId;
            initBuckets();

            // Загружаем сохранённые каналы
            const channelsRaw = await decryptFromStorage('p2ppong_channels');
            if (channelsRaw) {
                try {
                    const channels = JSON.parse(channelsRaw);
                    channels.forEach(ch => {
                        if (Date.now() < ch.expires) {
                            this._channels[ch.id] = {
                                ...ch, blobs: ch.blobs || [], secret: null, reconnect: true
                            };
                        }
                    });
                } catch(e) { console.warn('[P2PPong] Ошибка загрузки каналов:', e); }
            }

            this._connectSignal();
            this._startHousekeeping();

            this._state = 'online';
            this._emit('state-change', { state: 'online', peerId: this._peerId });
            this._emit('ready', {
                peerId: this._peerId,
                channels: Object.keys(this._channels).length,
                signalServer: this._signalServers[this._currentSignalIndex]
            });
        } catch(e) {
            this._state = 'offline';
            this._emit('state-change', { state: 'offline', error: e.message });
            this._emit('error', { message: 'Ошибка инициализации', error: e });
        }
    },

    // ==================== СИГНАЛЬНЫЙ СЕРВЕР ====================
    _connectSignal() {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) return;

        const url = this._signalServers[this._currentSignalIndex];

        try {
            this._ws = new WebSocket(url);
        } catch(e) {
            this._switchSignalServer();
            return;
        }

        this._ws.onopen = () => {
            this._wsReconnectDelay = 1000;
            this._state = 'online';
            this._emit('state-change', { state: 'online' });
            this._emit('signal-connected', { server: url });

            try {
                this._ws.send(JSON.stringify({ action: 'subscribe', peerId: this._peerId }));
            } catch(e) { console.error('[P2PPong] Ошибка подписки:', e); }
        };

        this._ws.onmessage = async (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch(er) {
                this._handleIncomingBlob(e.data, null);
                return;
            }

            if (msg.type === 'dht-signal' && msg.from !== DHT._nodeId) {
                await handleSignal(msg.from, msg.data);
                return;
            }

            if (msg.type === 'blob') {
                this._handleIncomingBlob(msg.blob, msg.channelId);
                return;
            }
        };

        this._ws.onclose = () => {
            this._state = 'offline';
            this._emit('state-change', { state: 'offline' });
            this._switchSignalServer();
        };

        this._ws.onerror = () => {
            this._ws.close();
        };
    },

    _switchSignalServer() {
        this._currentSignalIndex = (this._currentSignalIndex + 1) % this._signalServers.length;
        const delay = Math.min(this._wsReconnectDelay * 2, this._maxReconnectDelay);
        this._wsReconnectDelay = delay;
        setTimeout(() => this._connectSignal(), delay);
    },

    // ==================== КАНАЛЫ ====================
    _startHousekeeping() {
        setInterval(() => {
            const now = Date.now();

            // Чистим истекшие каналы
            for (const [id, ch] of Object.entries(this._channels)) {
                if (now > ch.expires) {
                    delete this._channels[id];
                    this._emit('channel-expired', { channelId: id });
                }
            }

            // Чистим истекшие маяки
            for (const [id, b] of Object.entries(this._beacons)) {
                if (now > b.expires) delete this._beacons[id];
            }

            // DHT-пинг для поддержания соединений
            for (const [id, peer] of DHT._peers) {
                if (now - peer.lastSeen > 30000 && peer.conn?.readyState === 'open') {
                    try { peer.conn.send(JSON.stringify({ type: 'dht-ping' })); } catch(e) {}
                }
                if (now - peer.lastSeen > 120000) {
                    DHT._peers.delete(id);
                    for (const bucket of DHT._buckets) {
                        const idx = bucket.findIndex(p => p.id === id);
                        if (idx >= 0) bucket.splice(idx, 1);
                    }
                }
            }

            this._saveChannels();
        }, 10000);
    },

    // ==================== МАЯКИ ====================
    async createBeacon(targetPeerId, metadata = {}) {
        if (!targetPeerId) {
            this._emit('error', { message: 'Peer ID не указан' });
            return null;
        }

        const kp = await generateKeyPair();
        const pk = await exportPublicKey(kp);
        const nonce = RND();
        const bid = RND();
        const beaconKey = await SHA(nonce + 'beacon');

        const inner = await encryptAES(JSON.stringify({
            nonce, timestamp: Date.now(), peerId: this._peerId
        }), beaconKey);

        const beaconData = {
            type: 'beacon', pubKey: pk, peerId: this._peerId,
            inner, targetPeerId,
            nick: metadata.nick || '', avatar: metadata.avatar || ''
        };

        beaconData.sig = await computeHMAC(JSON.stringify({
            type: beaconData.type, pubKey: beaconData.pubKey,
            peerId: beaconData.peerId, inner: beaconData.inner,
            targetPeerId: beaconData.targetPeerId,
            nick: beaconData.nick, avatar: beaconData.avatar
        }), beaconKey);

        this._beacons[bid] = {
            keyPair: kp, pubKey: pk, nonce,
            beaconKey, expires: Date.now() + 300000
        };

        this._broadcastBlob(JSON.stringify(beaconData), BLOB_NS);
        this._emit('beacon-sent', { targetPeerId, beaconId: bid });

        return bid;
    },

    // ==================== СООБЩЕНИЯ ====================
    async sendMessage(channelId, data) {
        const ch = this._channels[channelId];
        if (!ch || !ch.ratchetKey) {
            this._emit('error', { message: 'Канал не найден', channelId });
            return false;
        }

        const payload = JSON.stringify({
            d: typeof data === 'string' ? data : JSON.stringify(data),
            t: Date.now(),
            n: RND()
        });

        const packed = await packBlob(payload, ch);
        this._broadcastBlob(packed, channelId);

        ch.blobs = ch.blobs || [];
        ch.blobs.push({ d: data, t: Date.now(), n: RND(), from: 'me' });
        ch.expires = Date.now() + 600000;
        this._stats.messagesSent++;
        await this._saveChannels();

        this._emit('message-sent', { channelId, data });
        return true;
    },

    // ==================== ОБРАБОТКА ВХОДЯЩИХ ====================
    async _handleIncomingBlob(blobData, channelId) {
        let data;
        try { data = JSON.parse(blobData); } catch(e) { return; }

        // ВХОДЯЩИЙ МАЯК
        if (data && data.type === 'beacon' && data.pubKey && data.inner) {
            if (data.targetPeerId && data.targetPeerId !== this._peerId) return;

            // Проверка подписи
            const beaconPayload = {
                type: data.type, pubKey: data.pubKey, peerId: data.peerId,
                inner: data.inner, targetPeerId: data.targetPeerId,
                nick: data.nick, avatar: data.avatar
            };

            if (data.sig) {
                const valid = await verifyHMAC(
                    JSON.stringify(beaconPayload), data.sig, await SHA('beacon')
                );
                if (!valid) {
                    console.warn('[P2PPong] Подпись маяка недействительна');
                    return;
                }
            }

            this._emit('beacon-received', {
                peerId: data.peerId,
                nick: data.nick || 'Аноним',
                avatar: data.avatar || '001',
                accept: async () => {
                    const remotePubKey = await importPublicKey(data.pubKey);
                    const kp = await generateKeyPair();
                    const myPubKey = await exportPublicKey(kp);
                    const ss = await deriveSecret(kp, remotePubKey);
                    const chId = RND();

                    this._channels[chId] = {
                        secret: ss, ratchetKey: ss, ratchetIndex: 0,
                        oldKeys: [], lastReceivedRi: -1,
                        peerId: data.peerId, type: 'cup', blobs: [],
                        expires: Date.now() + 600000, createdAt: Date.now()
                    };

                    const response = JSON.stringify({
                        type: 'beacon-response', pubKey: myPubKey,
                        peerId: this._peerId, inner: data.inner,
                        nick: data.nick, avatar: data.avatar
                    });

                    this._broadcastBlob(response, BLOB_NS);
                    this._stats.channelsOpened++;
                    await this._saveChannels();

                    this._emit('channel-opened', {
                        channelId: chId,
                        peerId: data.peerId,
                        nick: data.nick || 'Аноним',
                        avatar: data.avatar || '001'
                    });
                },
                reject: () => {
                    this._emit('beacon-rejected', { peerId: data.peerId });
                }
            });
            return;
        }

        // ОТВЕТ НА НАШ МАЯК
        if (data && data.type === 'beacon-response' && data.pubKey && data.inner) {
            for (const [bid, b] of Object.entries(this._beacons)) {
                if (!b.beaconKey) continue;

                const dec = await decryptAES(data.inner, b.beaconKey);
                if (!dec) continue;

                let payload;
                try { payload = JSON.parse(dec); } catch(e) { continue; }
                if (payload.nonce !== b.nonce) continue;

                const remotePubKey = await importPublicKey(data.pubKey);
                const ss = await deriveSecret(b.keyPair, remotePubKey);
                const chId = RND();

                this._channels[chId] = {
                    secret: ss, ratchetKey: ss, ratchetIndex: 0,
                    oldKeys: [], lastReceivedRi: -1,
                    peerId: data.peerId, type: 'cup', blobs: [],
                    expires: Date.now() + 600000, createdAt: Date.now()
                };

                delete this._beacons[bid];
                this._stats.channelsOpened++;
                await this._saveChannels();

                this._emit('channel-opened', {
                    channelId: chId,
                    peerId: data.peerId,
                    nick: data.nick || 'Аноним',
                    avatar: data.avatar || '001'
                });
                return;
            }
        }

        // РЕСИНХРОНИЗАЦИЯ RATCHET
        if (data && data.type === 'ratchet-resync' && data.pubKey) {
            const chId = Object.keys(this._channels).find(
                id => this._channels[id].peerId === data.peerId
            );
            if (chId) {
                const ch = this._channels[chId];
                try {
                    const remotePubKey = await importPublicKey(data.pubKey);
                    const kp = await generateKeyPair();
                    const newSecret = await deriveSecret(kp, remotePubKey);
                    ch.secret = newSecret;
                    ch.ratchetKey = newSecret;
                    ch.ratchetIndex = 0;
                    ch.oldKeys = [];
                    ch.lastReceivedRi = -1;
                    this._emit('ratchet-reset', { channelId: chId });
                } catch(e) {
                    console.error('[P2PPong] Ошибка ресинхронизации:', e);
                }
            }
            return;
        }

        // ОБЫЧНОЕ СООБЩЕНИЕ / ГОЛОСОВОЕ / WEBRTC
        for (const [id, ch] of Object.entries(this._channels)) {
            if (!ch.ratchetKey) continue;

            const u = await unpackBlob(blobData, ch);
            if (!u) continue;

            // Проверка на replay-атаку
            if (u._ri !== undefined) {
                if (ch.lastReceivedRi === undefined) ch.lastReceivedRi = -1;
                if (u._ri <= ch.lastReceivedRi) {
                    console.warn('[P2PPong] Replay-атака обнаружена, сообщение отброшено');
                    return;
                }
                ch.lastReceivedRi = u._ri;
            }

            // WebRTC сигнализация
            if (u.webrtc) {
                this._emit('webrtc-signal', { channelId: id, data: u });
                return;
            }

            // Голосовое сообщение
            if (u.voice) {
                ch.blobs = ch.blobs || [];
                ch.blobs.push({ ...u, from: 'them' });
                ch.expires = Date.now() + 600000;
                this._stats.messagesReceived++;
                await this._saveChannels();

                this._emit('voice-message', {
                    channelId: id, data: u.data, from: 'them'
                });
                return;
            }

            // Текстовое сообщение
            ch.blobs = ch.blobs || [];
            ch.blobs.push({ ...u, from: 'them' });
            ch.expires = Date.now() + 600000;
            this._stats.messagesReceived++;
            await this._saveChannels();

            this._emit('message-received', {
                channelId: id,
                text: u.d || u.text || '',
                from: 'them',
                timestamp: u._t || Date.now()
            });
            return;
        }
    },

    // ==================== ТРАНСПОРТ ====================
    _broadcastBlob(packed, channelId) {
        const targetId = channelId || BLOB_NS;

        // DHT-пиры
        const dhtPeers = getClosestPeers(targetId, 3)
            .filter(p => p.conn?.readyState === 'open');

        if (dhtPeers.length > 0) {
            for (const p of dhtPeers) {
                sendToPeer(p.id, { type: 'blob', channelId: targetId, blob: packed });
            }
        }

        // Сигнальный сервер (только если есть targetPeerId)
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
            try {
                this._ws.send(JSON.stringify({
                    type: 'blob',
                    channelId: targetId,
                    blob: packed
                }));
            } catch(e) { console.error('[P2PPong] Ошибка отправки:', e); }
        }
    },

    // ==================== СОХРАНЕНИЕ ====================
    async _saveChannels() {
        try {
            const data = Object.entries(this._channels).map(([id, ch]) => ({
                id, peerId: ch.peerId, type: ch.type,
                expires: ch.expires, createdAt: ch.createdAt
            }));
            await encryptToStorage('p2ppong_channels', JSON.stringify(data));
        } catch(e) { console.error('[P2PPong] Ошибка сохранения каналов:', e); }
    },

    // ==================== СТАТИСТИКА ====================
    getStats() {
        return {
            peerId: this._peerId,
            state: this._state,
            channels: Object.keys(this._channels).length,
            dhtPeers: DHT._peers.size,
            signalServer: this._signalServers[this._currentSignalIndex],
            ...this._stats
        };
    },

    // ==================== РАЗРУШЕНИЕ ====================
    async destroy() {
        if (this._ws) {
            this._ws.onclose = null;
            this._ws.close();
            this._ws = null;
        }
        this._channels = {};
        this._beacons = {};
        this._listeners = {};
        this._state = 'idle';
        localStorage.clear();
        this._emit('destroyed');
    }
};

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
async function decryptFromStorage(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;

        // Проверяем — зашифровано или нет
        if (raw.startsWith('{') || raw.startsWith('[')) return raw;

        const k = await deriveStorageKey();
        if (!k) return raw;

        const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
        const iv = bytes.slice(0, 12);
        const ct = bytes.slice(12);

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv }, k, ct
        );
        return new TextDecoder().decode(decrypted);
    } catch(e) {
        return localStorage.getItem(key);
    }
}

// ==================== СОВМЕСТИМОСТЬ ====================
// Экспорт для использования в RobinHood
if (typeof window !== 'undefined') {
    window.P2PPong = P2PPong;
}
