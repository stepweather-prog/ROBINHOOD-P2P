// ===================================================================
// P2PPong vFinal — Единое ядро. Один код для обеих сторон.
// ===================================================================

const DEBUG = true;
function log(msg, data) { if (DEBUG) console.log(`[P2PPong] ${msg}`, data || ''); }

const CONFIG = {
    BEACON_TTL: 300000,
    CHANNEL_TTL: 600000,
    POLL_MAX: 150,
    MSG_POLL_INTERVAL: 10000,
    WEBRTC_POLL_INTERVAL: 15000,
    HOUSEKEEP_INTERVAL: 30000,
    MAX_OLD_KEYS: 50,
    MAX_EMOJI_ATTEMPTS: 5,
    MAX_VOICE_SIZE: 300000,
    MAX_VOICE_DURATION: 120,
    NONCE_LENGTH: 32,
    RATCHET_RESYNC_INTERVAL: 60000
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

async function deriveSecretLocal(myPrivateKeyB64, theirPublicKeyB64) {
    const myPrivKey = await crypto.subtle.importKey('pkcs8',
        Uint8Array.from(atob(myPrivateKeyB64), c => c.charCodeAt(0)),
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const theirPubKey = await crypto.subtle.importKey('raw',
        Uint8Array.from(atob(theirPublicKeyB64), c => c.charCodeAt(0)),
        { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPubKey }, myPrivKey, 256);
    return Array.from(new Uint8Array(bits)).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function advanceRatchetLocal(ch) {
    const oldKey = ch.ratchetKey || ch.secret;
    const salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0');
    const newKey = await SHA(oldKey + salt);
    return { newKey, index: (ch.ratchetIndex || 0) + 1, oldKey };
}

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
    _signalServer: null,
    _webRTCSignalBuffer: {},
    _myNick: 'Лучник',
    _myAvatar: '001',
    _theirNick: 'Незнакомец',
    _theirAvatar: '000',
    
    _signalServers: [
        { type: 'http', url: 'https://robincall.stephanclaps-491.workers.dev', name: 'Cloudflare' },
        { type: 'http', url: 'https://p2ppong-v2.onrender.com', name: 'Render' }
    ],
    _listeners: {}, _state: 'idle',
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },
    _housekeepInterval: null,
    _pollTimer: null, _pollStart: null, _pollKey: null,
    _webRTC: {}, _webRTCPolling: {}, _msgPollTimers: {},
    _verificationEmoji: null,
    _dedupTimers: {},

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
    _genEmoji() { const p = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😇','🤠','🫡','🤔','😏','😤','🥺','😱','💀','👽','🤖']; return [...Array(5)].map(() => p[Math.floor(Math.random()*p.length)]); },

    async _pickServer() {
        for (const s of this._signalServers) {
            try {
                const r = await fetch(s.url + '/health', { signal: AbortSignal.timeout(3000) });
                if (r.ok) { this._signalServer = s; return s; }
            } catch(e) {}
        }
        this._signalServer = this._signalServers[0];
        return this._signalServer;
    },

    async craftArrow() {
        this._peerId = RND();
        this._kp = await workerGenerateKeyPair();
        this._remotePubKey = null;
        this._remotePeerId = null;
        this._secret = null;
        this._chId = null;
        await this._pickServer();
        
        const emoji = this._genEmoji();
        this._verificationEmoji = emoji;
        
        const nonce = this._genNonce();
        const bk = await SHA(nonce + 'beacon');
        const inner = await workerEncryptAES(JSON.stringify({ 
            timestamp: Date.now(), 
            peerId: this._peerId, 
            emoji,
            nick: this._myNick,
            avatar: this._myAvatar
        }), bk);
        const bd = { type: 'beacon', pubKey: this._kp.publicKey, peerId: this._peerId, inner, nonce, signalServer: this._signalServer.url };
        bd.sig = await workerComputeHMAC(nonce + bd.peerId, bk);
        
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, nonce, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'creator' };
        
        await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify(bd) });
        this.startPolling('waiting_' + this._peerId);
        this._emit('peer-id-generated', { peerId: this._peerId });
        return this._peerId;
    },

    async joinBeacon(targetPeerId) {
        await this._pickServer();
        const d = await this._get('/beacon?key=waiting_' + targetPeerId);
        if (!d?.packet) { this._emit('error', { message: 'Маяк не найден' }); return false; }
        
        const bd = JSON.parse(d.packet);
        if (!bd?.pubKey || !bd?.inner) { this._emit('error', { message: 'Маяк повреждён' }); return false; }
        
        if (bd.signalServer) {
            const srv = this._signalServers.find(s => s.url === bd.signalServer);
            if (srv) { this._signalServer = srv; log('signal-synced', srv.name); }
        }
        
        const bk = await SHA(bd.nonce + 'beacon');
        const sigValid = await workerVerifyHMAC(bd.nonce + bd.peerId, bd.sig, bk);
        if (!sigValid) { this._emit('error', { message: 'Подпись маяка недействительна' }); return false; }
        
        const decrypted = await workerDecryptAES(bd.inner, bk);
        if (!decrypted) { this._emit('error', { message: 'Не удалось расшифровать маяк' }); return false; }
        
        const innerData = JSON.parse(decrypted);
        const emoji = innerData.emoji || [];
        this._verificationEmoji = emoji;
        this._remotePeerId = innerData.peerId;
        this._theirNick = innerData.nick || 'Незнакомец';
        this._theirAvatar = innerData.avatar || '000';
        
        this._peerId = RND();
        this._kp = await workerGenerateKeyPair();
        this._remotePubKey = bd.pubKey;
        this._chId = RND();
        
        this._secret = await deriveSecretLocal(this._kp.privateKey, bd.pubKey);
        const verificationHash = await SHA(this._secret + emoji.join(''));
        
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, nonce: bd.nonce, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'joiner', targetPeerId, verificationHash };
        
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
        await this._post('/beacon', { keyHash: 'waiting_' + targetPeerId, packet: br });
        
        const ep = JSON.stringify({ type: 'verification-emoji', emoji, peerId: this._peerId, pubKey: this._kp.publicKey, inner: bd.inner });
        await this._post('/beacon', { keyHash: 'emoji_' + targetPeerId, packet: ep });
        
        this.startPolling('waiting_' + targetPeerId);
        this._emit('verification-needed', { emoji });
        return true;
    },

    confirmVerification() { return true; },
    getVerificationEmoji() { return this._verificationEmoji; },
    getPeerId() { return this._peerId; },
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
        
        this._channels[this._chId] = {
            secret: this._secret,
            ratchetKey: this._secret,
            ratchetIndex: 0,
            oldKeys: [],
            lastReceivedRi: -1,
            peerId: peerId || 'unknown',
            type: 'cup',
            blobs: [],
            expires: Date.now() + CONFIG.CHANNEL_TTL,
            createdAt: Date.now()
        };
        
        this._stopPolling();
        const me = this, pid = this._peerId;
        setTimeout(() => me._cleanupBeaconKeys(pid), 10000);
        
        this._stats.channelsOpened++;
        this._emit('channel-opened', { 
            channelId: this._chId, 
            peerId: peerId || 'unknown', 
            nick: this._theirNick, 
            avatar: this._theirAvatar 
        });
        this._startMsgPoll(this._chId);
        this._startWebRTC(this._chId, this._pending?.type === 'creator');
        this._pending = null;
    },

    async _post(path, body) {
        const s = this._signalServer || this._signalServers[0];
        try {
            const r = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
            if (r.ok) return r.json();
            if (r.status === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); }
        } catch(e) { log('_post error', s.name, e.message); }
        return null;
    },
    async _get(path) {
        const s = this._signalServer || this._signalServers[0];
        try {
            const r = await fetch(s.url + path, { signal: AbortSignal.timeout(5000) });
            if (r.ok) return r.json();
            if (r.status === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); }
        } catch(e) { log('_get error', s.name, e.message); }
        return null;
    },

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
        
        // Шаг 1: Пробуем расшифровать как сообщение от другого Понга
        if (ch && ch.secret && typeof blobData === 'string') {
            try {
                const u = await workerUnpackBlob(blobData, ch);
                if (u) {
                    // ПРОВЕРКА: это не моё сообщение?
                    if (u.from === this._peerId) {
                        log('_handleIn', 'игнорирую своё сообщение');
                        return;
                    }
                    log('_handleIn', 'сообщение от другого Понга');
                    if (u._ri !== undefined) {
                        const targetRi = parseInt(u._ri) || 0;
                        while ((ch.ratchetIndex || 0) <= targetRi) {
                            const r = await advanceRatchetLocal(ch);
                            if (!ch.oldKeys) ch.oldKeys = [];
                            ch.oldKeys.push({ index: ch.ratchetIndex || 0, key: r.oldKey });
                            if (ch.oldKeys.length > CONFIG.MAX_OLD_KEYS) ch.oldKeys.shift();
                            ch.ratchetKey = r.newKey;
                            ch.ratchetIndex = r.index;
                        }
                        ch.lastReceivedRi = targetRi;
                    }
                    const dedupKey = chId + '_' + (u.n || u._t || '');
                    if (this._dedupTimers[dedupKey]) return;
                    this._dedupTimers[dedupKey] = setTimeout(() => delete this._dedupTimers[dedupKey], CONFIG.CHANNEL_TTL);
                    ch.blobs.push({ 
                        d: u.d || u.text || '', 
                        t: u._t || Date.now(), 
                        n: u.n || '', 
                        from: 'them', 
                        status: 'delivered',
                        nick: this._theirNick,
                        avatar: this._theirAvatar
                    });
                    ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                    this._emit('message-received', { 
                        channelId: chId, 
                        text: u.d || u.text || '', 
                        from: 'them', 
                        timestamp: u._t || Date.now(),
                        nick: this._theirNick,
                        avatar: this._theirAvatar
                    });
                    return;
                }
            } catch(e) { log('unpack error', e.message); }
        }
        
        // Шаг 2: Не сообщение — парсим как JSON (сигналы, маяки, команды)
        let d;
        try { d = JSON.parse(blobData); } catch(e) { return; }
        log('_handleIn', d.type || 'unknown');
        
        // Проверка на свои сигналы (не от другого Понга)
        if (d.peerId === this._peerId) {
            log('_handleIn', 'игнорирую свой сигнал:', d.type);
            return;
        }
        
        if (d.type && d.type.startsWith('webrtc-')) {
            if (this._chId) {
                if (!this._webRTC[this._chId]) {
                    if (!this._webRTCSignalBuffer[this._chId]) {
                        this._webRTCSignalBuffer[this._chId] = [];
                    }
                    this._webRTCSignalBuffer[this._chId].push(d);
                    log('webrtc-signal-buffered', d.type);
                } else {
                    this._handleWSig(this._chId, d);
                }
            }
            return;
        }
        
        if (d.type === 'beacon-response' && d.pubKey && d.channelId) {
            if (this._pending?.type !== 'creator') return;
            this._remotePubKey = d.pubKey;
            this._remotePeerId = d.peerId;
            this._chId = d.channelId;
            this._secret = await deriveSecretLocal(this._kp.privateKey, d.pubKey);
            await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify({
                type: 'beacon-ack', 
                peerId: this._peerId, 
                channelId: this._chId, 
                pubKey: this._kp.publicKey, 
                signalServer: this._signalServer.url,
                nick: this._myNick,
                avatar: this._myAvatar
            })});
            this._openChannel(d.peerId, d.signalServer, d.nick, d.avatar);
            return;
        }
        
        if (d.type === 'beacon-ack' && d.channelId) {
            if (this._pending?.type !== 'joiner') return;
            this._chId = d.channelId;
            if (!this._secret && d.pubKey) {
                this._secret = await deriveSecretLocal(this._kp.privateKey, d.pubKey);
            }
            this._openChannel(d.peerId, d.signalServer, d.nick, d.avatar);
            return;
        }
        
        if (d.type === 'verification-emoji' && d.emoji) {
            if (this._pending?.type === 'creator' && this._verificationEmoji && arraysEqual(d.emoji, this._verificationEmoji)) {
                this._remotePubKey = d.pubKey;
                this._remotePeerId = d.peerId;
                this._chId = RND();
                this._secret = await deriveSecretLocal(this._kp.privateKey, d.pubKey);
                await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify({
                    type: 'beacon-ack', 
                    peerId: this._peerId, 
                    channelId: this._chId, 
                    pubKey: this._kp.publicKey, 
                    signalServer: this._signalServer.url,
                    nick: this._myNick,
                    avatar: this._myAvatar
                })});
                this._openChannel(d.peerId, d.signalServer);
                return;
            }
            this._emit('verification-received', { emoji: d.emoji });
            return;
        }
        
        if (d.type === 'ratchet-resync' && d.pubKey) {
            if (ch) {
                try {
                    const ss = await deriveSecretLocal(this._kp?.privateKey || '', d.pubKey);
                    ch.secret = ss;
                    ch.ratchetKey = ss;
                    ch.ratchetIndex = 0;
                    ch.oldKeys = [];
                    ch.lastReceivedRi = -1;
                } catch(e) { log('resync error', e.message); }
            }
            return;
        }
    },

    async sendMessage(chId, text) {
        const ch = this._channels[chId || this._chId]; if (!ch) return false;
        const nonce = RND();
        const rtc = this._webRTC[chId || this._chId];
        const messageData = JSON.stringify({ 
            d: text, 
            t: Date.now(), 
            n: nonce,
            from: this._peerId,
            nick: this._myNick,
            avatar: this._myAvatar
        });
        
        if (rtc && rtc.dc && rtc.dc.readyState === 'open') {
            const result = await workerPackBlob(messageData, ch);
            const oldKey = ch.ratchetKey;
            ch.ratchetKey = result.newRatchetKey;
            ch.ratchetIndex = result.newRatchetIndex;
            if (!ch.oldKeys) ch.oldKeys = [];
            ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: oldKey });
            if (ch.oldKeys.length > CONFIG.MAX_OLD_KEYS) ch.oldKeys.shift();
            rtc.dc.send(result.packed);
            ch.blobs.push({ d: text, t: Date.now(), n: nonce, from: 'me', status: 'sent', nick: this._myNick, avatar: this._myAvatar });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { 
                channelId: chId || this._chId, 
                data: text, 
                status: 'sent',
                nick: this._myNick,
                avatar: this._myAvatar
            }); 
            return true;
        }
        
        if (ch.ratchetKey) {
            const result = await workerPackBlob(messageData, ch);
            const oldKey = ch.ratchetKey;
            ch.ratchetKey = result.newRatchetKey;
            ch.ratchetIndex = result.newRatchetIndex;
            if (!ch.oldKeys) ch.oldKeys = [];
            ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: oldKey });
            if (ch.oldKeys.length > CONFIG.MAX_OLD_KEYS) ch.oldKeys.shift();
            await this._post('/beacon', { keyHash: 'msg_' + (chId || this._chId), packet: result.packed });
            ch.blobs.push({ d: text, t: Date.now(), n: nonce, from: 'me', status: 'sent', nick: this._myNick, avatar: this._myAvatar });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { 
                channelId: chId || this._chId, 
                data: text, 
                status: 'sent',
                nick: this._myNick,
                avatar: this._myAvatar
            }); 
            return true;
        }
        return false;
    },

    _cleanupBeaconKeys(peerId) {
        this._get('/delete?key=waiting_' + peerId).catch(() => {});
        this._get('/delete?key=emoji_' + peerId).catch(() => {});
        this._get('/delete?key=ack_' + peerId).catch(() => {});
    },

    _startHousekeeping() {
        const me = this;
        this._housekeepInterval = setInterval(function() {
            const now = Date.now();
            Object.keys(me._channels).forEach(function(id) { 
                if (now > me._channels[id].expires) { 
                    delete me._channels[id]; 
                    delete me._webRTC[id]; 
                    me._stopMsgPoll(id); 
                    me._stopWebRTCPoll(id); 
                    me._emit('channel-expired', { channelId: id }); 
                } 
            });
            Object.keys(me._beacons).forEach(function(id) { 
                if (now > me._beacons[id].expires) delete me._beacons[id]; 
            });
            if (me._peerId && me._pending?.type === 'creator' && Object.keys(me._channels).length === 0) {
                me._get('/beacon?key=emoji_' + me._peerId).then(function(d) { 
                    if (d && d.packet) me._handleIn(d.packet); 
                }).catch(() => {});
            }
        }, CONFIG.HOUSEKEEP_INTERVAL);
    },

    _startMsgPoll(chId) {
        if (this._msgPollTimers[chId]) return;
        const me = this;
        function poll() {
            if (!me._channels[chId]) { me._stopMsgPoll(chId); return; }
            if (me._webRTC[chId] && me._webRTC[chId].connected) { me._stopMsgPoll(chId); return; }
            me._get('/beacon?key=msg_' + chId).then(function(d) {
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
            const pc = new RTCPeerConnection({ 
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun.cloudflare.com:3478' }
                ] 
            });
            this._webRTC[chId] = { 
                pc, 
                dc: null, 
                iceBuffer: [], 
                connected: false, 
                initiator: asInitiator, 
                seenMessages: new Set(), 
                offerSent: false 
            };
            
            if (this._webRTCSignalBuffer[chId]) {
                const buffered = this._webRTCSignalBuffer[chId];
                delete this._webRTCSignalBuffer[chId];
                buffered.forEach(sig => this._handleWSig(chId, sig));
                log('webrtc-buffer-flushed', buffered.length);
            }
            
            const me = this;
            pc.onicecandidate = e => { 
                if (e.candidate) {
                    me._webRTC[chId].iceBuffer.push(e.candidate);
                } else {
                    me._flushICE(chId);
                }
            };
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                    me._webRTC[chId].connected = false;
                    me._startMsgPoll(chId);
                }
            };
            
            // DataChannel для сообщений
            if (asInitiator) {
                const dc = pc.createDataChannel('chat');
                me._setupDataChannel(chId, ch, dc, true);
                pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => {
                    me._webRTC[chId].offerSent = true;
                    me._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) });
                });
            } else {
                pc.ondatachannel = e => {
                    me._setupDataChannel(chId, ch, e.channel, false);
                };
            }
            
            setTimeout(() => { 
                if (me._webRTC[chId] && !me._webRTC[chId].connected) {
                    me._startWebRTCPoll(chId);
                }
            }, 5000);
        } catch(e) { log('startWebRTC error', e.message); }
    },
    
    _setupDataChannel(chId, ch, dc, isInitiator) {
        const me = this;
        this._webRTC[chId].dc = dc;
        
        dc.onopen = () => { 
            me._webRTC[chId].connected = true; 
            me._stats.peersConnected++; 
            me._emit('peer-connected', { 
                channelId: chId, 
                nick: me._theirNick, 
                avatar: me._theirAvatar 
            }); 
            me._stopWebRTCPoll(chId); 
            me._stopMsgPoll(chId); 
        };
        
        dc.onmessage = e => me._handleDCMessage(chId, ch, e);
    },
    
    async _handleDCMessage(chId, ch, e) {
        if (typeof e.data === 'string' && e.data.length > 50) {
            try {
                const u = await workerUnpackBlob(e.data, ch);
                if (u) {
                    // ПРОВЕРКА: не моё сообщение?
                    if (u.from === this._peerId) {
                        log('_handleDCMessage', 'игнорирую своё сообщение через WebRTC');
                        return;
                    }
                    if (u._ri !== undefined) {
                        const targetRi = parseInt(u._ri) || 0;
                        while ((ch.ratchetIndex || 0) <= targetRi) {
                            const r = await advanceRatchetLocal(ch);
                            if (!ch.oldKeys) ch.oldKeys = [];
                            ch.oldKeys.push({ index: ch.ratchetIndex || 0, key: r.oldKey });
                            if (ch.oldKeys.length > CONFIG.MAX_OLD_KEYS) ch.oldKeys.shift();
                            ch.ratchetKey = r.newKey;
                            ch.ratchetIndex = r.index;
                        }
                        ch.lastReceivedRi = targetRi;
                    }
                    const dedupKey = chId + '_' + (u.n || u._t || '');
                    if (this._webRTC[chId]?.seenMessages?.has(u.n)) return;
                    if (this._dedupTimers[dedupKey]) return;
                    this._dedupTimers[dedupKey] = setTimeout(() => delete this._dedupTimers[dedupKey], CONFIG.CHANNEL_TTL);
                    this._webRTC[chId]?.seenMessages?.add(u.n);
                    ch.blobs.push({ 
                        d: u.d || u.text || '', 
                        t: u._t || Date.now(), 
                        n: u.n || '', 
                        from: 'them', 
                        status: 'delivered',
                        nick: this._theirNick,
                        avatar: this._theirAvatar
                    });
                    ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                    this._emit('message-received', { 
                        channelId: chId, 
                        text: u.d || u.text || '', 
                        from: 'them', 
                        timestamp: u._t || Date.now(),
                        nick: this._theirNick,
                        avatar: this._theirAvatar
                    });
                    return;
                }
            } catch(er) {}
        }
        
        // Fallback для старых форматов
        try {
            const m = JSON.parse(e.data);
            if (m.type === 'message' && m.text) {
                const dedupKey = chId + '_' + (m.nonce || '');
                if (this._dedupTimers[dedupKey]) return;
                this._dedupTimers[dedupKey] = setTimeout(() => delete this._dedupTimers[dedupKey], CONFIG.CHANNEL_TTL);
                ch.blobs.push({ 
                    d: m.text, 
                    t: m.time, 
                    n: m.nonce, 
                    from: 'them', 
                    status: 'delivered',
                    nick: this._theirNick,
                    avatar: this._theirAvatar
                });
                ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                this._emit('message-received', { 
                    channelId: chId, 
                    text: m.text, 
                    from: 'them', 
                    timestamp: m.time,
                    nick: this._theirNick,
                    avatar: this._theirAvatar
                });
            }
        } catch(er) {}
    },
    
    _startWebRTCPoll(chId) {
        if (this._webRTCPolling[chId]) return;
        const me = this;
        function poll() {
            if (!me._webRTC[chId] || me._webRTC[chId].connected) { 
                me._stopWebRTCPoll(chId); 
                return; 
            }
            me._get('/beacon?key=webrtc_' + chId).then(function(d) {
                if (d && d.packet) {
                    const sig = JSON.parse(d.packet);
                    if (sig.peerId !== me._peerId) {
                        me._handleWSig(chId, sig);
                    }
                }
                me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL);
            }).catch(() => { 
                me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL); 
            });
        }
        poll();
    },
    _stopWebRTCPoll(chId) { 
        if (this._webRTCPolling[chId]) { 
            clearTimeout(this._webRTCPolling[chId]); 
            delete this._webRTCPolling[chId]; 
        } 
    },

    _handleWSig(chId, sig) {
        const rtc = this._webRTC[chId]; 
        if (!rtc || !rtc.pc || rtc.connected) return;
        const pc = rtc.pc;
        try {
            if (sig.type === 'webrtc-ice') { 
                const c = JSON.parse(sig.sdp); 
                if (pc.remoteDescription) {
                    pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
                } else {
                    rtc.iceBuffer.push(c); 
                }
                return; 
            }
            if (sig.type === 'webrtc-offer') { 
                pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))).then(() => { 
                    rtc.iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); 
                    rtc.iceBuffer = []; 
                    if (!rtc.initiator) { 
                        pc.createAnswer().then(a => pc.setLocalDescription(a)).then(() => 
                            this._sendWSig(chId, { type: 'webrtc-answer', sdp: JSON.stringify(pc.localDescription) })
                        ); 
                    } 
                }); 
                return; 
            }
            if (sig.type === 'webrtc-answer') { 
                pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))).then(() => { 
                    rtc.iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); 
                    rtc.iceBuffer = []; 
                }); 
            }
        } catch(e) {}
    },
    _sendWSig(chId, data) { 
        this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); 
    },
    _flushICE(chId) { 
        const rtc = this._webRTC[chId]; 
        if (!rtc) return; 
        rtc.iceBuffer.forEach(c => this._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) })); 
        rtc.iceBuffer = []; 
    },

    async destroy() {
        this._stopPolling();
        Object.keys(this._msgPollTimers).forEach(id => clearTimeout(this._msgPollTimers[id]));
        this._msgPollTimers = {};
        Object.keys(this._webRTCPolling).forEach(id => clearTimeout(this._webRTCPolling[id]));
        this._webRTCPolling = {};
        Object.keys(this._webRTC).forEach(id => { 
            try { this._webRTC[id].pc.close(); } catch(e) {} 
        });
        this._webRTC = {};
        if (this._housekeepInterval) clearInterval(this._housekeepInterval);
        this._channels = {}; this._beacons = {}; this._listeners = {};
        this._state = 'idle'; this._peerId = null; this._kp = null;
        this._remotePubKey = null; this._secret = null; this._chId = null;
        this._pending = null; this._verificationEmoji = null; this._signalServer = null;
        this._webRTCSignalBuffer = {};
        this._remotePeerId = null;
        this._emit('destroyed');
    }
};

const RND = () => { 
    const a = new Uint32Array(4); 
    crypto.getRandomValues(a); 
    return Array.from(a).map(x => x.toString(16).padStart(8, '0')).join(''); 
};

let lastResyncTime = {}, resyncInProgress = {};
async function requestRatchetResync(ch) {
    const chId = Object.keys(P2PPong._channels).find(id => P2PPong._channels[id] === ch);
    if (!chId) return;
    const now = Date.now();
    if (lastResyncTime[chId] && now - lastResyncTime[chId] < CONFIG.RATCHET_RESYNC_INTERVAL) return;
    if (resyncInProgress[chId]) return;
    resyncInProgress[chId] = true;
    lastResyncTime[chId] = now;
    log('ratchet-resync', 'Запрошен для ' + chId);
    try {
        const kp = await workerGenerateKeyPair();
        P2PPong._post('/beacon', { 
            keyHash: 'msg_' + chId, 
            packet: await workerEncryptAES(JSON.stringify({ 
                type: 'ratchet-resync', 
                pubKey: kp.publicKey, 
                peerId: P2PPong._peerId 
            }), ch.secret) 
        });
    } catch(e) {} finally { 
        resyncInProgress[chId] = false; 
    }
}

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
