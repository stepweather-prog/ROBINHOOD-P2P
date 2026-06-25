// p2ppong.js — v5.2 fix: поллинг code_ + beacon-ack только после verification-code
const DEBUG = true;
function log(msg, data) { if (DEBUG) console.log(`[P2PPong] ${msg}`, data || ''); }

const CONFIG = {
    BEACON_TTL: 300000,
    CHANNEL_TTL: 600000,
    POLL_MAX: 150,
    MSG_POLL_INTERVAL: 3000,
    WEBRTC_POLL_INTERVAL: 5000,
    HOUSEKEEP_INTERVAL: 30000,
    MAX_OLD_KEYS: 50,
    MAX_EMOJI_ATTEMPTS: 5,
    MAX_VOICE_SIZE: 50000,
    MAX_VOICE_DURATION: 10,
    NONCE_LENGTH: 32,
    RATCHET_RESYNC_INTERVAL: 60000,
    SERVER_HEALTH_TTL: 300000,
    SERVER_FAIL_TIMEOUT: 5000,
    MAX_RETRIES: 3
};

function arraysEqual(a, b) {
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const cryptoWorker = new Worker('crypto-worker.js');
const cryptoCallbacks = {};
let cryptoMsgId = 0;

function cryptoCall(action, payload) {
    return new Promise((resolve, reject) => {
        const id = ++cryptoMsgId;
        cryptoCallbacks[id] = { resolve, reject };
        cryptoWorker.postMessage({ id, action, payload });
    });
}

cryptoWorker.onmessage = function(e) {
    const { id, result, error } = e.data;
    if (cryptoCallbacks[id]) {
        if (error) cryptoCallbacks[id].reject(new Error(error));
        else cryptoCallbacks[id].resolve(result);
        delete cryptoCallbacks[id];
    }
};

const SHA = (t) => cryptoCall('SHA', t);
const workerGenerateKeyPair = () => cryptoCall('generateKeyPair');
const workerEncryptAES = (text, secret) => cryptoCall('encryptAES', { text, secret });
const workerDecryptAES = (enc, secret) => cryptoCall('decryptAES', { enc, secret });
const workerComputeHMAC = (data, secret) => cryptoCall('computeHMAC', { data, secret });
const workerVerifyHMAC = (data, sig, secret) => cryptoCall('verifyHMAC', { data, sig, secret });
const workerPackBlob = (jsonString, ch) => cryptoCall('packBlob', { jsonString, ch });
const workerUnpackBlob = (blob, ch) => cryptoCall('unpackBlob', { blob, ch });
const workerDeriveSecret = (myPrivateKey, theirPublicKey) => cryptoCall('deriveSecret', { myPrivateKey, theirPublicKey });
const workerAdvanceRecvRatchet = (ch, targetRi) => cryptoCall('advanceRecvRatchet', { ch, targetRi });

const P2PPong = {
    _peerId: null,
    _kp: null,
    _remotePubKey: null,
    _remotePeerId: null,
    _secret: null,
    _chId: null,
    _channels: {},
    _beacons: {},
    _pending: null,
    _pendingChannelData: null,
    _signalServer: null,
    _serverHealth: {},
    _webRTCSignalBuffer: {},
    _myNick: 'Лучник',
    _myAvatar: '001',
    _theirNick: 'Незнакомец',
    _theirAvatar: '000',
    _verificationCode: null,
    _beaconId: null,
    _poolBeaconId: null,
    _codeVerified: false,
    _codePollTimer: null,
    _codePollActive: false,
    
    _signalServers: [
        { type: 'http', url: 'https://robincall.stephanclaps-491.workers.dev', name: 'Cloudflare', priority: 1 },
        { type: 'http', url: 'https://p2ppong-v2.onrender.com', name: 'Render', priority: 1 },
        { type: 'xmpp', url: 'xmpp://jabber.ru', name: 'Jabber.ru', priority: 3 },
        { type: 'xmpp', url: 'xmpp://jabber.cz', name: 'Jabber.cz', priority: 3 },
        { type: 'xmpp', url: 'xmpp://xmpp.jp', name: 'XMPP.jp', priority: 3 },
        { type: 'tor', url: 'http://p2ppong.onion', name: 'Tor', priority: 4 }
    ],
    
    _listeners: {}, _state: 'idle',
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },
    _housekeepInterval: null,
    _pollTimer: null, _pollStart: null, _pollKey: null,
    _webRTC: {}, _webRTCPolling: {}, _msgPollTimers: {},
    _dedupTimers: {},
    _retryCount: {},

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    },
    _emit(event, data) { log('emit', event); const cbs = this._listeners[event]; if (cbs) cbs.forEach(cb => { try { cb(data); } catch(e) {} }); },

    setMyProfile(nick, avatar) {
        this._myNick = nick || 'Лучник';
        this._myAvatar = avatar || '001';
    },

    async init() {
        if (this._state === 'online') { this._emit('ready', {}); return; }
        this._state = 'connecting'; this._emit('state-change', { state: 'connecting' });
        try {
            this._startHousekeeping();
            this._state = 'online'; this._emit('state-change', { state: 'online' }); this._emit('ready', {});
        } catch(e) {
            this._state = 'offline'; this._emit('error', { message: 'Init failed: ' + e.message });
        }
    },

    _genNonce() { const a = new Uint32Array(CONFIG.NONCE_LENGTH / 8); crypto.getRandomValues(a); return Array.from(a).map(x => x.toString(16).padStart(8, '0')).join(''); },
    
    _genCode() {
        const arr = new Uint32Array(1);
        crypto.getRandomValues(arr);
        return (arr[0] % 10000000).toString().padStart(7, '0');
    },

    async _pickServer() {
        const now = Date.now();
        const healthyServers = this._signalServers
            .filter(s => {
                const health = this._serverHealth[s.url];
                return !health || !health.failed || (now - health.lastCheck > CONFIG.SERVER_HEALTH_TTL);
            })
            .sort((a, b) => a.priority - b.priority);
        
        if (healthyServers.length === 0) {
            this._serverHealth = {};
            return this._pickServer();
        }
        
        for (const server of healthyServers) {
            if (server.type === 'http') {
                try {
                    const r = await fetch(server.url + '/health', { signal: AbortSignal.timeout(CONFIG.SERVER_FAIL_TIMEOUT) });
                    if (r.ok) {
                        this._signalServer = server;
                        this._serverHealth[server.url] = { healthy: true, lastCheck: now };
                        log('signal-server-selected', server.name);
                        return server;
                    }
                } catch(e) {
                    this._serverHealth[server.url] = { healthy: false, failed: true, lastCheck: now };
                }
            } else if (server.type === 'xmpp' || server.type === 'tor') {
                continue;
            }
        }
        
        this._signalServer = this._signalServers[0];
        return this._signalServer;
    },

    async craftArrow() {
        this._codeVerified = false;
        this._peerId = RND();
        this._kp = await workerGenerateKeyPair();
        this._remotePubKey = null;
        this._remotePeerId = null;
        this._secret = null;
        this._chId = null;
        await this._pickServer();
        
        const code = this._genCode();
        this._verificationCode = code;
        
        const beaconId = RND();
        this._beaconId = beaconId;
        
        const bk = await SHA(this._kp.publicKey + 'beacon');
        const inner = await workerEncryptAES(JSON.stringify({ 
            timestamp: Date.now(), 
            peerId: this._peerId,
            beaconId: beaconId,
            code: code,
            nick: this._myNick,
            avatar: this._myAvatar
        }), bk);
        
        const bd = { 
            type: 'beacon', 
            pubKey: this._kp.publicKey, 
            peerId: this._peerId, 
            inner, 
            signalServer: this._signalServer.url 
        };
        bd.sig = await workerComputeHMAC(bd.pubKey + bd.peerId, bk);
        
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'creator' };
        
        await this._postWithRetry('/beacon', { keyHash: 'waiting_' + beaconId, packet: JSON.stringify(bd) });
        this.startPolling('waiting_' + beaconId);
        this._emit('peer-id-generated', { peerId: this._peerId, beaconId: this._beaconId, code: code, pubKey: this._kp.publicKey });
        return this._beaconId;
    },

    async craftPublicArrow() {
        this._codeVerified = false;
        this._peerId = RND();
        this._kp = await workerGenerateKeyPair();
        this._remotePubKey = null;
        this._remotePeerId = null;
        this._secret = null;
        this._chId = null;
        await this._pickServer();
        
        const code = this._genCode();
        this._verificationCode = code;
        
        const beaconId = RND();
        this._beaconId = beaconId;
        
        const bk = await SHA(this._kp.publicKey + 'beacon');
        const inner = await workerEncryptAES(JSON.stringify({ 
            timestamp: Date.now(), 
            peerId: this._peerId,
            beaconId: beaconId,
            code: code,
            nick: this._myNick,
            avatar: this._myAvatar
        }), bk);
        
        const bd = { 
            type: 'beacon', 
            pubKey: this._kp.publicKey, 
            peerId: this._peerId, 
            inner, 
            signalServer: this._signalServer.url 
        };
        bd.sig = await workerComputeHMAC(bd.pubKey + bd.peerId, bk);
        
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'creator' };
        
        const result = await this._postWithRetry('/pool', { packet: JSON.stringify(bd) });
        this._poolBeaconId = result?.id;
        
        this._emit('peer-id-generated', { peerId: this._peerId, beaconId: this._beaconId, code: code, pubKey: this._kp.publicKey });
        return this._beaconId;
    },

    async joinBeacon(targetBeaconId) {
        await this._pickServer();
        const d = await this._getWithRetry('/beacon?key=waiting_' + targetBeaconId);
        if (!d?.packet) { this._emit('error', { message: 'Маяк не найден' }); return false; }
        
        const bd = JSON.parse(d.packet);
        if (!bd?.pubKey || !bd?.inner) { this._emit('error', { message: 'Маяк повреждён' }); return false; }
        
        if (window._expectedPubKey && bd.pubKey !== window._expectedPubKey) {
            this._emit('error', { message: 'Публичный ключ не совпадает с QR! Возможна атака MitM.' });
            return false;
        }
        
        if (bd.signalServer) {
            const srv = this._signalServers.find(s => s.url === bd.signalServer);
            if (srv) { this._signalServer = srv; log('signal-synced', srv.name); }
        }
        
        const bk = await SHA(bd.pubKey + 'beacon');
        const sigValid = await workerVerifyHMAC(bd.pubKey + bd.peerId, bd.sig, bk);
        if (!sigValid) { this._emit('error', { message: 'Подпись маяка недействительна' }); return false; }
        
        const decrypted = await workerDecryptAES(bd.inner, bk);
        if (!decrypted) { this._emit('error', { message: 'Не удалось расшифровать маяк' }); return false; }
        
        const innerData = JSON.parse(decrypted);
        const code = innerData.code || '';
        this._verificationCode = code;
        this._remotePeerId = innerData.peerId;
        this._theirNick = innerData.nick || 'Незнакомец';
        this._theirAvatar = innerData.avatar || '000';
        
        const beaconId = innerData.beaconId;
        this._beaconId = beaconId;
        
        this._peerId = RND();
        this._kp = await workerGenerateKeyPair();
        this._remotePubKey = bd.pubKey;
        this._chId = RND();
        
        this._secret = await workerDeriveSecret(this._kp.privateKey, bd.pubKey);
        const verificationHash = await SHA(this._secret + code);
        
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'joiner', targetPeerId: innerData.peerId, verificationHash };
        
        const br = JSON.stringify({ 
            type: 'beacon-response', 
            pubKey: this._kp.publicKey, 
            peerId: this._peerId, 
            inner: bd.inner, 
            channelId: this._chId, 
            verificationHash, 
            signalServer: this._signalServer.url,
            nick: this._myNick,
            avatar: this._myAvatar
        });
        await this._postWithRetry('/beacon', { keyHash: 'waiting_' + beaconId, packet: br });
        
        const ep = JSON.stringify({ type: 'verification-code', code: code, peerId: this._peerId, pubKey: this._kp.publicKey, inner: bd.inner });
        await this._postWithRetry('/beacon', { keyHash: 'code_' + beaconId, packet: ep });
        
        this.startPolling('waiting_' + beaconId);
        this._emit('verification-needed', { code: code });
        return true;
    },

    confirmVerification() { 
        if (this._pendingChannelData) {
            const data = this._pendingChannelData;
            this._pendingChannelData = null;
            this._openChannel(data.peerId, data.signalServer, data.nick, data.avatar);
        }
        return true; 
    },
    
    getVerificationCode() { return this._verificationCode; },
    getPeerId() { return this._peerId; },
    getBeaconId() { return this._beaconId; },
    getPubKey() { return this._kp?.publicKey; },
    getTheirProfile() { return { nick: this._theirNick, avatar: this._theirAvatar }; },

    _openChannel(peerId, signalServerUrl, theirNick, theirAvatar) {
        if (!this._chId) this._chId = RND();
        if (!this._secret) return;
        
        if (signalServerUrl && this._signalServer?.url !== signalServerUrl) {
            const srv = this._signalServers.find(s => s.url === signalServerUrl);
            if (srv) { this._signalServer = srv; log('signal-server-synced', srv.name); }
        }
        
        if (theirNick) this._theirNick = theirNick;
        if (theirAvatar) this._theirAvatar = theirAvatar;
        
        if (peerId) this._remotePeerId = peerId;
        
        this._channels[this._chId] = {
            secret: this._secret,
            sendKey: this._secret,
            sendIndex: 0,
            recvKey: this._secret,
            recvIndex: 0,
            oldRecvKeys: [],
            peerId: peerId || 'unknown',
            type: 'cup',
            blobs: [],
            expires: Date.now() + CONFIG.CHANNEL_TTL,
            createdAt: Date.now()
        };
        
        this._stopPolling();
        this._stopCodePoll();
        
        const me = this;
        const beaconId = this._beaconId;
        setTimeout(() => me._cleanupBeaconKeys(beaconId), 10000);
        
        this._stats.channelsOpened++;
        
        const isCreator = this._pending?.type === 'creator';
        this._pending = null;
        
        this._emit('channel-opened', { 
            channelId: this._chId, 
            peerId: peerId || 'unknown', 
            nick: this._theirNick, 
            avatar: this._theirAvatar 
        });
        this._startMsgPoll(this._chId);
        this._startWebRTC(this._chId, isCreator);
    },

    _startCodePoll() {
        this._stopCodePoll();
        this._codePollActive = true;
        const me = this;
        let attempts = 0;
        const maxAttempts = 120;
        
        function poll() {
            if (!me._codePollActive || !me._beaconId || attempts >= maxAttempts) return;
            if (Object.keys(me._channels).length > 0) { me._stopCodePoll(); return; }
            
            attempts++;
            me._get('/beacon?key=code_' + me._beaconId).then(function(d) {
                if (d && d.packet) {
                    me._stopCodePoll();
                    me._handleIn(d.packet);
                    return;
                }
                me._codePollTimer = setTimeout(poll, 1000);
            }).catch(() => {
                me._codePollTimer = setTimeout(poll, 1000);
            });
        }
        
        poll();
    },
    
    _stopCodePoll() {
        this._codePollActive = false;
        if (this._codePollTimer) {
            clearTimeout(this._codePollTimer);
            this._codePollTimer = null;
        }
    },

    async _postWithRetry(path, body, retryCount = 0) {
        if (retryCount >= CONFIG.MAX_RETRIES) {
            await this._pickServer();
            return this._postWithRetry(path, body, 0);
        }
        
        const s = this._signalServer || this._signalServers[0];
        try {
            const r = await fetch(s.url + path, { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }, 
                body: JSON.stringify(body), 
                signal: AbortSignal.timeout(CONFIG.SERVER_FAIL_TIMEOUT) 
            });
            if (r.ok) return r.json();
            if (r.status === 429) { 
                await new Promise(resolve => setTimeout(resolve, 10000)); 
                return this._postWithRetry(path, body, retryCount + 1);
            }
        } catch(e) { 
            this._serverHealth[s.url] = { healthy: false, failed: true, lastCheck: Date.now() };
            await this._pickServer();
            return this._postWithRetry(path, body, retryCount + 1);
        }
        return null;
    },
    
    async _getWithRetry(path, retryCount = 0) {
        if (retryCount >= CONFIG.MAX_RETRIES) {
            await this._pickServer();
            return this._getWithRetry(path, 0);
        }
        
        const s = this._signalServer || this._signalServers[0];
        try {
            const r = await fetch(s.url + path, { signal: AbortSignal.timeout(CONFIG.SERVER_FAIL_TIMEOUT) });
            if (r.ok) return r.json();
            if (r.status === 429) { 
                await new Promise(resolve => setTimeout(resolve, 10000)); 
                return this._getWithRetry(path, retryCount + 1);
            }
        } catch(e) { 
            this._serverHealth[s.url] = { healthy: false, failed: true, lastCheck: Date.now() };
            await this._pickServer();
            return this._getWithRetry(path, retryCount + 1);
        }
        return null;
    },

    async _delete(path) {
        const s = this._signalServer || this._signalServers[0];
        try {
            const r = await fetch(s.url + path, { 
                method: 'DELETE', 
                signal: AbortSignal.timeout(CONFIG.SERVER_FAIL_TIMEOUT) 
            });
            if (r.ok) return r.json();
        } catch(e) {}
        return null;
    },

    async _post(path, body) { return this._postWithRetry(path, body); },
    async _get(path) { return this._getWithRetry(path); },

    startPolling(keyHash) { if (!keyHash) return; this._stopPolling(); this._pollKey = keyHash; this._pollStart = Date.now(); this._doPoll(); },
    _doPoll() {
        if (!this._pollKey) return;
        const me = this;
        if ((Date.now() - me._pollStart) / 1000 > CONFIG.POLL_MAX) { me._stopPolling(); me._emit('beacon-timeout'); return; }
        me._get('/beacon?key=' + me._pollKey).then(function(d) {
            if (d && d.status === 'found' && d.packet) {
                try {
                    const p = JSON.parse(d.packet);
                    if (p.type === 'beacon') { me._pollTimer = setTimeout(() => me._doPoll(), 1000); return; }
                    if (p.type === 'beacon-response' && p.peerId === me._peerId) { me._pollTimer = setTimeout(() => me._doPoll(), 1000); return; }
                } catch(e) {}
                me._stopPolling(); me._handleIn(d.packet);
            } else if (d && d.status === 'taken') { me._stopPolling(); me._emit('beacon-taken'); }
            else { me._pollTimer = setTimeout(() => me._doPoll(), 1000); }
        }).catch(() => { me._pollTimer = setTimeout(() => me._doPoll(), 1000); });
    },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; } },

    async _handleIn(blobData) {
        const chId = this._chId || Object.keys(this._channels)[0];
        const ch = this._channels[chId];
        
        if (ch && ch.secret && typeof blobData === 'string') {
            try {
                const u = await workerUnpackBlob(blobData, ch);
                if (u) {
                    if (u.from === this._peerId) return;
                    if (u._ri !== undefined) {
                        const targetRi = parseInt(u._ri) || 0;
                        const recvResult = await workerAdvanceRecvRatchet(ch, targetRi);
                        ch.recvKey = recvResult.finalKey;
                        ch.recvIndex = recvResult.index;
                        ch.oldRecvKeys = recvResult.oldKeys.slice(-3);
                    }
                    const dedupKey = chId + '_' + (u.n || u._t || '');
                    if (this._dedupTimers[dedupKey]) return;
                    this._dedupTimers[dedupKey] = setTimeout(() => delete this._dedupTimers[dedupKey], CONFIG.CHANNEL_TTL);
                    
                    if (u.nick) this._theirNick = u.nick;
                    if (u.avatar) this._theirAvatar = u.avatar;
                    
                    const displayText = u.type === 'voice' ? '[Голосовое сообщение]' : (u.d || u.text || '');
                    ch.blobs.push({ d: displayText, voiceData: u.type === 'voice' ? u.d : null, t: u._t || Date.now(), n: u.n || '', from: 'them', status: 'delivered', nick: this._theirNick, avatar: this._theirAvatar });
                    ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                    this._emit('message-received', { channelId: chId, text: displayText, voiceData: u.type === 'voice' ? u.d : null, type: u.type || 'text', from: 'them', timestamp: u._t || Date.now(), nick: this._theirNick, avatar: this._theirAvatar });
                    return;
                }
            } catch(e) { log('unpack error', e.message); }
        }
        
        let d;
        try { d = JSON.parse(blobData); } catch(e) { return; }
        
        if (d.peerId === this._peerId) return;
        
        if (d.type && d.type.startsWith('webrtc-')) {
            if (this._chId) {
                if (!this._webRTC[this._chId]) {
                    if (!this._webRTCSignalBuffer[this._chId]) this._webRTCSignalBuffer[this._chId] = [];
                    this._webRTCSignalBuffer[this._chId].push(d);
                } else { this._handleWSig(this._chId, d); }
            }
            return;
        }
        
        // beacon-response от Боба → Алисе. НЕ отправляем ack, ждём verification-code
        if (d.type === 'beacon-response' && d.pubKey && d.channelId) {
            if (this._pending?.type !== 'creator') return;
            this._remotePubKey = d.pubKey;
            this._remotePeerId = d.peerId;
            this._chId = d.channelId;
            this._secret = await workerDeriveSecret(this._kp.privateKey, d.pubKey);
            if (d.nick) this._theirNick = d.nick;
            if (d.avatar) this._theirAvatar = d.avatar;
            this._pendingChannelData = { peerId: d.peerId, signalServer: d.signalServer, nick: d.nick, avatar: d.avatar };
            
            // ✅ Сразу начинаем поллить code_ ключ
            this._startCodePoll();
            
            log('beacon-response received, polling code_ for verification');
            return;
        }
        
        // beacon-ack от Алисы → Бобу. Вот теперь открываем канал
        if (d.type === 'beacon-ack' && d.channelId) {
            if (this._pending?.type !== 'joiner') return;
            this._chId = d.channelId;
            if (!this._secret && d.pubKey) { this._secret = await workerDeriveSecret(this._kp.privateKey, d.pubKey); }
            if (d.peerId) this._remotePeerId = d.peerId;
            if (d.nick) this._theirNick = d.nick;
            if (d.avatar) this._theirAvatar = d.avatar;
            log('beacon-ack received, opening channel for Bob');
            this._openChannel(d.peerId, this._signalServer?.url, d.nick, d.avatar);
            return;
        }
        
        // verification-code от Боба → Алисе. Проверяем код и отправляем ack
        if (d.type === 'verification-code' && d.code) {
            if (this._pending?.type === 'creator' && this._verificationCode && d.code === this._verificationCode) {
                this._remotePubKey = d.pubKey;
                this._remotePeerId = d.peerId;
                this._secret = await workerDeriveSecret(this._kp.privateKey, d.pubKey);
                
                // Отправляем beacon-ack только после проверки кода
                await this._post('/beacon', { keyHash: 'waiting_' + this._beaconId, packet: JSON.stringify({
                    type: 'beacon-ack', peerId: this._peerId, channelId: this._chId, pubKey: this._kp.publicKey, signalServer: this._signalServer.url, nick: this._myNick, avatar: this._myAvatar
                })});
                
                log('verification-code valid, sent beacon-ack, opening channel for Alice');
                this._openChannel(d.peerId, d.signalServer, d.nick, d.avatar);
                return;
            }
            return;
        }
        
        if (d.type === 'ratchet-resync' && d.pubKey) {
            if (ch) {
                try {
                    const ss = await workerDeriveSecret(this._kp?.privateKey || '', d.pubKey);
                    ch.secret = ss; ch.sendKey = ss; ch.sendIndex = 0; ch.recvKey = ss; ch.recvIndex = 0; ch.oldRecvKeys = [];
                } catch(e) { log('resync error', e.message); }
            }
            return;
        }
    },

    async sendMessage(chId, text) {
        const ch = this._channels[chId || this._chId]; if (!ch) return false;
        const nonce = RND();
        const messageData = JSON.stringify({ type: 'text', d: text, t: Date.now(), n: nonce, from: this._peerId, nick: this._myNick, avatar: this._myAvatar });
        return this._sendEncrypted(ch, chId, messageData, text, nonce);
    },

    async sendVoiceMessage(chId, voiceBase64) {
        const ch = this._channels[chId || this._chId]; if (!ch) return false;
        if (voiceBase64.length > CONFIG.MAX_VOICE_SIZE) {
            this._emit('error', { message: 'Голосовое слишком длинное. Максимум ' + CONFIG.MAX_VOICE_DURATION + ' секунд.' });
            return false;
        }
        const nonce = RND();
        const messageData = JSON.stringify({ type: 'voice', d: voiceBase64, t: Date.now(), n: nonce, from: this._peerId, nick: this._myNick, avatar: this._myAvatar });
        return this._sendEncrypted(ch, chId, messageData, '[Голосовое сообщение]', nonce);
    },

    async _sendEncrypted(ch, chId, messageData, displayText, nonce) {
        const rtc = this._webRTC[chId || this._chId];
        
        if (rtc && rtc.dc && rtc.dc.readyState === 'open') {
            const result = await workerPackBlob(messageData, ch);
            ch.sendKey = result.newSendKey;
            ch.sendIndex = result.newSendIndex;
            if (result.packed.length > 60000) { this._emit('error', { message: 'Сообщение слишком большое.' }); return false; }
            rtc.dc.send(result.packed);
            ch.blobs.push({ d: displayText, t: Date.now(), n: nonce, from: 'me', status: 'sent', nick: this._myNick, avatar: this._myAvatar });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { channelId: chId || this._chId, data: displayText, status: 'sent', nick: this._myNick, avatar: this._myAvatar }); 
            return true;
        }
        
        if (ch.sendKey) {
            const result = await workerPackBlob(messageData, ch);
            if (result.packed.length > 60000) { this._emit('error', { message: 'Сообщение слишком большое для сервера.' }); return false; }
            ch.sendKey = result.newSendKey;
            ch.sendIndex = result.newSendIndex;
            await this._post('/beacon', { keyHash: 'msg_' + (chId || this._chId) + '_' + this._beaconId, packet: result.packed });
            ch.blobs.push({ d: displayText, t: Date.now(), n: nonce, from: 'me', status: 'sent', nick: this._myNick, avatar: this._myAvatar });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { channelId: chId || this._chId, data: displayText, status: 'sent', nick: this._myNick, avatar: this._myAvatar }); 
            return true;
        }
        return false;
    },

    _cleanupBeaconKeys(beaconId) {
        this._get('/delete?key=waiting_' + beaconId).catch(() => {});
        this._get('/delete?key=code_' + beaconId).catch(() => {});
        this._get('/delete?key=ack_' + beaconId).catch(() => {});
    },

    _startHousekeeping() {
        const me = this;
        this._housekeepInterval = setInterval(function() {
            const now = Date.now();
            Object.keys(me._channels).forEach(function(id) { 
                if (now > me._channels[id].expires) { delete me._channels[id]; delete me._webRTC[id]; me._stopMsgPoll(id); me._stopWebRTCPoll(id); me._emit('channel-expired', { channelId: id }); } 
            });
            Object.keys(me._beacons).forEach(function(id) { if (now > me._beacons[id].expires) delete me._beacons[id]; });
            me._pickServer().catch(() => {});
        }, CONFIG.HOUSEKEEP_INTERVAL);
    },

    _startMsgPoll(chId) {
        if (this._msgPollTimers[chId]) return;
        const me = this;
        function poll() {
            if (!me._channels[chId]) { me._stopMsgPoll(chId); return; }
            if (me._webRTC[chId] && me._webRTC[chId].connected) { me._stopMsgPoll(chId); return; }
            me._get('/beacon?key=msg_' + chId + '_' + me._beaconId).then(function(d) {
                if (d && d.packet) me._handleIn(d.packet);
                me._msgPollTimers[chId] = setTimeout(poll, CONFIG.MSG_POLL_INTERVAL);
            }).catch(() => { me._msgPollTimers[chId] = setTimeout(poll, CONFIG.MSG_POLL_INTERVAL); });
        }
        poll();
    },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; } },

    _startWebRTC(chId, asInitiator) {
        const ch = this._channels[chId]; if (!ch || this._webRTC[chId]) return;
        try {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }] });
            this._webRTC[chId] = { pc, dc: null, iceBuffer: [], connected: false, initiator: asInitiator, seenMessages: new Set(), offerSent: false };
            if (this._webRTCSignalBuffer[chId]) { const buffered = this._webRTCSignalBuffer[chId]; delete this._webRTCSignalBuffer[chId]; buffered.forEach(sig => this._handleWSig(chId, sig)); }
            const me = this;
            pc.onicecandidate = e => { if (e.candidate) { me._webRTC[chId].iceBuffer.push(e.candidate); } else { me._flushICE(chId); } };
            pc.onconnectionstatechange = () => { if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') { me._webRTC[chId].connected = false; me._startMsgPoll(chId); } };
            if (asInitiator) { const dc = pc.createDataChannel('chat'); me._setupDataChannel(chId, ch, dc, true); pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => { me._webRTC[chId].offerSent = true; me._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) }); }); }
            else { pc.ondatachannel = e => { me._setupDataChannel(chId, ch, e.channel, false); }; }
            setTimeout(() => { if (me._webRTC[chId] && !me._webRTC[chId].connected) { me._startWebRTCPoll(chId); } }, 5000);
        } catch(e) { log('startWebRTC error', e.message); }
    },
    
    _setupDataChannel(chId, ch, dc, isInitiator) { const me = this; this._webRTC[chId].dc = dc; dc.onopen = () => { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId, nick: me._theirNick, avatar: me._theirAvatar }); me._stopWebRTCPoll(chId); me._stopMsgPoll(chId); }; dc.onmessage = e => me._handleDCMessage(chId, ch, e); },
    
    async _handleDCMessage(chId, ch, e) {
        if (typeof e.data === 'string' && e.data.length > 50) {
            try {
                const u = await workerUnpackBlob(e.data, ch);
                if (u) {
                    if (u.from === this._peerId) return;
                    if (u._ri !== undefined) {
                        const targetRi = parseInt(u._ri) || 0;
                        const recvResult = await workerAdvanceRecvRatchet(ch, targetRi);
                        ch.recvKey = recvResult.finalKey;
                        ch.recvIndex = recvResult.index;
                        ch.oldRecvKeys = recvResult.oldKeys.slice(-3);
                    }
                    const dedupKey = chId + '_' + (u.n || u._t || ''); if (this._webRTC[chId]?.seenMessages?.has(u.n)) return; if (this._dedupTimers[dedupKey]) return;
                    this._dedupTimers[dedupKey] = setTimeout(() => delete this._dedupTimers[dedupKey], CONFIG.CHANNEL_TTL); this._webRTC[chId]?.seenMessages?.add(u.n);
                    if (u.nick) this._theirNick = u.nick;
                    if (u.avatar) this._theirAvatar = u.avatar;
                    const displayText = u.type === 'voice' ? '[Голосовое сообщение]' : (u.d || u.text || '');
                    ch.blobs.push({ d: displayText, voiceData: u.type === 'voice' ? u.d : null, t: u._t || Date.now(), n: u.n || '', from: 'them', status: 'delivered', nick: this._theirNick, avatar: this._theirAvatar });
                    ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                    this._emit('message-received', { channelId: chId, text: displayText, voiceData: u.type === 'voice' ? u.d : null, type: u.type || 'text', from: 'them', timestamp: u._t || Date.now(), nick: this._theirNick, avatar: this._theirAvatar });
                    return;
                }
            } catch(er) {}
        }
        try { const m = JSON.parse(e.data); if (m.type === 'message' && m.text) { const dedupKey = chId + '_' + (m.nonce || ''); if (this._dedupTimers[dedupKey]) return; this._dedupTimers[dedupKey] = setTimeout(() => delete this._dedupTimers[dedupKey], CONFIG.CHANNEL_TTL); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them', status: 'delivered', nick: this._theirNick, avatar: this._theirAvatar }); ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++; this._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time, nick: this._theirNick, avatar: this._theirAvatar }); } } catch(er) {}
    },
    
    _startWebRTCPoll(chId) { if (this._webRTCPolling[chId]) return; const me = this; function poll() { if (!me._webRTC[chId] || me._webRTC[chId].connected) { me._stopWebRTCPoll(chId); return; } me._get('/beacon?key=webrtc_' + chId).then(function(d) { if (d && d.packet) { const sig = JSON.parse(d.packet); if (sig.peerId !== me._peerId) { me._handleWSig(chId, sig); } } me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL); }).catch(() => { me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL); }); } poll(); },
    _stopWebRTCPoll(chId) { if (this._webRTCPolling[chId]) { clearTimeout(this._webRTCPolling[chId]); delete this._webRTCPolling[chId]; } },

    _handleWSig(chId, sig) { const rtc = this._webRTC[chId]; if (!rtc || !rtc.pc || rtc.connected) return; const pc = rtc.pc; try { if (sig.type === 'webrtc-ice') { const c = JSON.parse(sig.sdp); if (pc.remoteDescription) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}); } else { rtc.iceBuffer.push(c); } return; } if (sig.type === 'webrtc-offer') { pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))).then(() => { rtc.iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); rtc.iceBuffer = []; if (!rtc.initiator) { pc.createAnswer().then(a => pc.setLocalDescription(a)).then(() => this._sendWSig(chId, { type: 'webrtc-answer', sdp: JSON.stringify(pc.localDescription) })); } }); return; } if (sig.type === 'webrtc-answer') { pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))).then(() => { rtc.iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); rtc.iceBuffer = []; }); } } catch(e) {} },
    _sendWSig(chId, data) { this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); },
    _flushICE(chId) { const rtc = this._webRTC[chId]; if (!rtc) return; rtc.iceBuffer.forEach(c => this._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) })); rtc.iceBuffer = []; },

    async destroy() {
        this._stopPolling();
        this._stopCodePoll();
        Object.keys(this._msgPollTimers).forEach(id => clearTimeout(this._msgPollTimers[id])); this._msgPollTimers = {};
        Object.keys(this._webRTCPolling).forEach(id => clearTimeout(this._webRTCPolling[id])); this._webRTCPolling = {};
        Object.keys(this._webRTC).forEach(id => { try { this._webRTC[id].pc.close(); } catch(e) {} }); this._webRTC = {};
        if (this._housekeepInterval) clearInterval(this._housekeepInterval);
        for (const k in this._dedupTimers) clearTimeout(this._dedupTimers[k]);
        this._dedupTimers = {};
        this._channels = {}; this._beacons = {}; this._listeners = {};
        this._state = 'idle'; this._peerId = null; this._kp = null;
        this._remotePubKey = null; this._secret = null; this._chId = null;
        this._pending = null; this._pendingChannelData = null; this._verificationCode = null; this._signalServer = null;
        this._webRTCSignalBuffer = {}; this._remotePeerId = null; this._serverHealth = {};
        this._beaconId = null; this._poolBeaconId = null; this._codeVerified = false;
        this._emit('destroyed');
    }
};

const RND = () => { const a = new Uint32Array(4); crypto.getRandomValues(a); return Array.from(a).map(x => x.toString(16).padStart(8, '0')).join(''); };

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
