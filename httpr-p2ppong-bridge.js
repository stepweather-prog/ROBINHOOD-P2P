// httpr-p2ppong-bridge.js — v1.3 fix: _get не подменяется
const P2PPongOverHTTPR = {
    _p2ppong: null,
    _httpr: null,
    _bridged: false,
    _originalPost: null,
    _originalPostWithRetry: null,
    _originalGet: null,
    _originalGetWithRetry: null,
    _originalStartPolling: null,
    _originalStopPolling: null,
    _originalHandleIn: null,

    async bridge(p2ppong, httpr) {
        if (this._bridged) {
            console.warn('[HTTPR Bridge] Уже подключён');
            return;
        }

        this._p2ppong = p2ppong;
        this._httpr = httpr;

        this._originalPost = p2ppong._post.bind(p2ppong);
        this._originalPostWithRetry = p2ppong._postWithRetry.bind(p2ppong);
        this._originalGet = p2ppong._get.bind(p2ppong);
        this._originalGetWithRetry = p2ppong._getWithRetry.bind(p2ppong);
        this._originalStartPolling = p2ppong.startPolling.bind(p2ppong);
        this._originalStopPolling = p2ppong._stopPolling.bind(p2ppong);
        this._originalHandleIn = p2ppong._handleIn.bind(p2ppong);

        this._patchPost(p2ppong);
        this._patchPolling(p2ppong);
        this._patchHandleIn(p2ppong);

        this._bridged = true;
        console.log('[HTTPR Bridge] Подключён');
    },

    async unbridge() {
        if (!this._bridged) return;

        const p = this._p2ppong;

        p._post = this._originalPost;
        p._postWithRetry = this._originalPostWithRetry;
        p._get = this._originalGet;
        p._getWithRetry = this._originalGetWithRetry;
        p.startPolling = this._originalStartPolling;
        p._stopPolling = this._originalStopPolling;
        p._handleIn = this._originalHandleIn;

        this._p2ppong = null;
        this._httpr = null;
        this._bridged = false;

        console.log('[HTTPR Bridge] Отключён');
    },

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
        return map[oldType] || 'system';
    },

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

    _detectPacketType(packetData) {
        try {
            const parsed = JSON.parse(packetData);
            return parsed.type || null;
        } catch (e) {
            return null;
        }
    },

    _patchPost(p2ppong) {
        const self = this;

        p2ppong._post = async function (path, body) {
            const keyHash = body?.keyHash;
            const packet = body?.packet || JSON.stringify(body);

            if (self._httpr && keyHash) {
                const oldType = self._detectPacketType(packet);
                const newType = self._mapTypeToHTTPR(oldType);

                const payload = {
                    type: newType,
                    from: p2ppong._peerId,
                    to: p2ppong._remotePeerId || null,
                    ch: p2ppong._chId || null,
                    ri: 0,
                    dh: null,
                    data: packet
                };

                try {
                    const result = await self._httpr.send(payload, keyHash);
                    if (result.success) {
                        return { ok: true };
                    }
                } catch (e) {
                    console.warn('[HTTPR Bridge] _post HTTPR failed:', e.message);
                }
            }

            try {
                const result = await self._originalPostWithRetry(path, body);
                return result || { ok: false, error: 'no response' };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        };
    },

    _patchPolling(p2ppong) {
        const self = this;

        p2ppong.startPolling = function (keyHash) {
            if (!keyHash) return;

            p2ppong._stopPolling();

            p2ppong._pollKey = keyHash;
            p2ppong._pollStart = Date.now();

            if (self._httpr) {
                self._httpr.subscribe(keyHash, (payload, meta) => {
                    if (payload && payload.data) {
                        p2ppong._stopPolling();
                        p2ppong._handleIn(payload.data);
                    }
                }).catch(() => {});
            }

            if (p2ppong._firebaseActive) {
                p2ppong._firebaseListen(keyHash, (data) => {
                    if (data && data.packet) {
                        p2ppong._stopPolling();
                        p2ppong._handleIn(data.packet);
                    }
                });
            }

            p2ppong._doPoll();
        };

        p2ppong._stopPolling = function () {
            if (p2ppong._pollTimer) {
                clearTimeout(p2ppong._pollTimer);
                p2ppong._pollTimer = null;
            }

            if (self._httpr && p2ppong._pollKey) {
                self._httpr.unsubscribe(p2ppong._pollKey).catch(() => {});
            }

            if (p2ppong._pollKey) {
                p2ppong._firebaseUnlisten(p2ppong._pollKey);
            }
        };
    },

    _patchHandleIn(p2ppong) {
        const self = this;

        p2ppong._handleIn = async function (blobData) {
            try {
                const env = JSON.parse(blobData);

                if (env.v && env.pl && env.tid) {
                    let payload;

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

                    if (!payload) {
                        try {
                            payload = JSON.parse(httprDecodeBase64(env.pl));
                        } catch (e) {
                            payload = JSON.parse(blobData);
                        }
                    }

                    if (payload && payload.type) {
                        const oldType = self._mapTypeToOld(payload.type);

                        let dataToProcess = payload.data || blobData;

                        if (oldType) {
                            try {
                                const parsed = JSON.parse(dataToProcess);
                                parsed.type = oldType;
                                dataToProcess = JSON.stringify(parsed);
                            } catch (e) {}
                        }

                        return self._originalHandleIn(dataToProcess);
                    }
                }
            } catch (e) {}

            return self._originalHandleIn(blobData);
        };
    },

    async setTransportKey(key) {
        if (!this._httpr) throw new Error('Мост не подключён');
        return this._httpr.setTransportKey(key);
    },

    removeTransportKey(kid) {
        if (this._httpr) {
            this._httpr.removeTransportKey(kid);
        }
    },

    getStats() {
        if (!this._httpr) return null;
        return this._httpr.getStats();
    },

    getActiveTransport() {
        if (!this._httpr) return null;
        return this._httpr.getActiveTransport();
    }
};

if (typeof window !== 'undefined') {
    window.P2PPongOverHTTPR = P2PPongOverHTTPR;
}
