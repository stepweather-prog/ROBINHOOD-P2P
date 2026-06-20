// ===================================================================
// P2PPong vFinal — Crypto Worker, HSTS, метрики, авто-ratchet
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
    BLOB_SIZE: 4096,
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

const DHT = { _nodeId: null, _buckets: [], _storage: {}, _k: 20, _alpha: 3, _peers: new Map(), _signalSend: null };
const BLOB_NS = '00000000000000000000000000000000';

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
const workerExportPublicKey = (kp) => cryptoCall('exportPublicKey', kp);
const workerImportPublicKey = (b64) => cryptoCall('importPublicKey', b64);
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

const P2PPong = {
    _peerId: null, _beacons: {}, _channels: {}, _ws: null,
    _signalServers: [
        { type: 'http', url: 'https://robincall.stephanclaps-491.workers.dev', name: 'Cloudflare' },
        { type: 'http', url: 'https://p2ppong-v2.onrender.com', name: 'Render' }
    ],
    _listeners: {}, _state: 'idle',
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },
    _housekeepInterval: null,
    _pollTimer: null, _pollStart: null, _pollKey: null,
    _webRTC: {}, _webRTCPolling: {}, _msgPollTimers: {},
    _pendingVerification: null, _verificationEmoji: null, _emojiAttempts: 0,
    _dedupTimers: {}, _crafting: false,

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    },
    _emit(event, data) { log('emit', event); const cbs = this._listeners[event]; if (cbs) cbs.forEach(cb => { try { cb(data); } catch(e) {} }); },

    async init() {
        if (this._state === 'online') { this._emit('ready', {}); return; }
        this._state = 'connecting'; this._emit('state-change', { state: 'connecting' });
        try {
            DHT._nodeId = RND(); initBuckets();
            if (typeof RobinHoodPeerHelp !== 'undefined') { RobinHoodPeerHelp.start(this._peerId); this._peerHelpActive = true; }
            this._startHousekeeping();
            this._state = 'online'; this._emit('state-change', { state: 'online' }); this._emit('ready', {});
        } catch(e) {
            this._state = 'offline'; this._emit('error', { message: 'Init failed: ' + e.message });
            log('init error', e);
        }
    },

    _genNonce() { const a = new Uint32Array(CONFIG.NONCE_LENGTH / 8); crypto.getRandomValues(a); return Array.from(a).map(function(x) { return x.toString(16).padStart(8, '0'); }).join(''); },
    _genEmoji() { const p = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😇','🤠','🫡','🤔','😏','😤','🥺','😱','💀','👽','🤖']; return [...Array(5)].map(() => p[Math.floor(Math.random()*p.length)]); },

    async craftArrow() {
        if (this._crafting) return this._peerId;
        this._crafting = true;
        try {
            this._peerId = RND();
            this._emit('peer-id-generated', { peerId: this._peerId });
            const kp = await workerGenerateKeyPair(); const pk = kp.publicKey;
            const beaconNonce = this._genNonce(); const bid = RND();
            const correctEmoji = this._genEmoji();
            this._verificationEmoji = correctEmoji;
            const bk = await SHA(beaconNonce + 'beacon');
            const inner = await workerEncryptAES(JSON.stringify({ timestamp: Date.now(), peerId: this._peerId, emoji: correctEmoji }), bk);
            const bd = { type: 'beacon', pubKey: pk, peerId: this._peerId, inner, nonce: beaconNonce, targetPeerId: this._peerId, nick: '', avatar: '' };
            bd.sig = await workerComputeHMAC(beaconNonce + bd.peerId, bk);
            this._beacons[bid] = { keyPair: kp, pubKey: pk, nonce: beaconNonce, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
            await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify(bd) });
            this.startPolling('waiting_' + this._peerId);
            return this._peerId;
        } finally { this._crafting = false; }
    },
    getPeerId() { return this._peerId; },

    async joinBeacon(targetPeerId) {
        if (!targetPeerId) return false;
        const d = await this._get('/beacon?key=waiting_' + targetPeerId);
        if (!d?.packet) { this._emit('error', { message: 'Маяк не найден' }); return false; }
        const bd = JSON.parse(d.packet);
        if (!bd?.pubKey || !bd?.inner) { this._emit('error', { message: 'Маяк повреждён' }); return false; }
        const beaconNonce = bd.nonce;
        if (!beaconNonce || beaconNonce.length < CONFIG.NONCE_LENGTH) { this._emit('error', { message: 'Маяк с невалидным nonce' }); return false; }
        if (!this._peerId) this._peerId = RND();
        const bk = await SHA(beaconNonce + 'beacon');
        const sigValid = await workerVerifyHMAC(beaconNonce + bd.peerId, bd.sig, bk);
        if (!sigValid) { this._emit('error', { message: 'Подпись маяка недействительна' }); return false; }
        const decrypted = await workerDecryptAES(bd.inner, bk);
        if (!decrypted) { this._emit('error', { message: 'Не удалось расшифровать маяк' }); return false; }
        const innerData = JSON.parse(decrypted);
        const correctEmoji = innerData.emoji || [];
        this._verificationEmoji = correctEmoji;
        this._pendingVerification = { bd, targetPeerId, emoji: correctEmoji };
        this._emojiAttempts = 0;

        const kp = await workerGenerateKeyPair();
        const ss = await deriveSecretLocal(kp.privateKey, bd.pubKey);
        const verificationHash = await SHA(ss + correctEmoji.join(''));
        const chId = RND();

        const bid = RND();
        this._beacons[bid] = { keyPair: kp, pubKey: bd.pubKey, nonce: beaconNonce, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
        this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + CONFIG.CHANNEL_TTL, createdAt: Date.now(), verificationHash };

        const ep = JSON.stringify({ type: 'verification-emoji', emoji: correctEmoji, peerId: this._peerId, pubKey: kp.publicKey, inner: bd.inner });
        await this._post('/beacon', { keyHash: 'emoji_' + bd.peerId, packet: ep });

        const br = JSON.stringify({ type: 'beacon-response', pubKey: kp.publicKey, peerId: this._peerId, inner: bd.inner, channelId: chId, verificationHash, nick: '', avatar: '' });
        await this._post('/beacon', { keyHash: 'waiting_' + targetPeerId, packet: br });

        this.startPolling('waiting_' + targetPeerId);
        this._emit('verification-needed', { emoji: correctEmoji });
        return true;
    },

    async confirmVerification() {
        if (!this._pendingVerification) return false;
        this._emojiAttempts++;
        if (this._emojiAttempts > CONFIG.MAX_EMOJI_ATTEMPTS) {
            this._emit('error', { message: 'Слишком много попыток. Создайте новый маяк.' });
            this._pendingVerification = null;
            return false;
        }
        this._pendingVerification = null;
        this._verificationEmoji = null;
        return true;
    },
    getVerificationEmoji() { return this._verificationEmoji; },

    async _autoConfirmAsAlice(d) {
        const keys = Object.keys(this._beacons);
        for (let i = 0; i < keys.length; i++) {
            const b = this._beacons[keys[i]];
            if (!b.keyPair) continue;
            try {
                const ss = await deriveSecretLocal(b.keyPair.privateKey, d.pubKey);
                const chId = d.channelId || RND();
                const channel = {
                    secret: ss,
                    ratchetKey: ss,
                    ratchetIndex: 0,
                    oldKeys: [],
                    lastReceivedRi: -1,
                    peerId: d.peerId,
                    type: 'cup',
                    blobs: [],
                    expires: Date.now() + CONFIG.CHANNEL_TTL,
                    createdAt: Date.now()
                };
                this._channels[chId] = channel;
                delete this._beacons[keys[i]];
                this._stopPolling();
                this._cleanupBeaconKeys(this._peerId);
                this._stats.channelsOpened++;
                this._emit('channel-opened', { channelId: chId, peerId: d.peerId, nick: 'Лучник', avatar: '001' });
                this._startMsgPoll(chId);
                this.startWebRTC(chId, true);
                await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify({
                    type: 'beacon-ack',
                    peerId: this._peerId,
                    channelId: chId,
                    pubKey: b.pubKey
                })});
                return;
            } catch(e) { log('_autoConfirmAsAlice error', e.message); }
        }
    },

    _cleanupBeaconKeys(peerId) {
        this._get('/delete?key=waiting_' + peerId).catch(() => {});
        this._get('/delete?key=emoji_' + peerId).catch(() => {});
        this._get('/delete?key=ack_' + peerId).catch(() => {});
    },

    async _post(path, body) {
        for (const s of this._signalServers) {
            try {
                const r = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
                if (r.ok) return r.json();
                if (r.status === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); }
            } catch(e) { log('_post error', s.name, e.message); }
            if (s.name === 'Render') await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return null;
    },
    async _get(path) {
        for (const s of this._signalServers) {
            try {
                const r = await fetch(s.url + path, { signal: AbortSignal.timeout(5000) });
                if (r.ok) return r.json();
                if (r.status === 429) { await new Promise(resolve => setTimeout(resolve, 10000)); }
            } catch(e) { log('_get error', s.name, e.message); }
            if (s.name === 'Render') await new Promise(resolve => setTimeout(resolve, 2000));
        }
        return null;
    },

    startPolling(keyHash) { if (!keyHash) return; this._stopPolling(); this._pollKey = keyHash; this._pollStart = Date.now(); this._doPoll(); },
    _doPoll() {
        if (!this._pollKey) return;
        const me = this;
        const el = (Date.now() - me._pollStart) / 1000;
        if (el > CONFIG.POLL_MAX) { me._stopPolling(); me._emit('beacon-timeout'); return; }
        me._get('/beacon?key=' + me._pollKey).then(function(d) {
            if (d && d.status === 'found' && d.packet) {
                try {
                    const p = JSON.parse(d.packet);
                    // Игнорируем маяки (свои и чужие) — продолжаем поллинг
                    if (p.type === 'beacon') {
                        me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000);
                        return;
                    }
                    // Игнорируем beacon-response (свой же) — продолжаем поллинг
                    if (p.type === 'beacon-response') {
                        me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000);
                        return;
                    }
                } catch(e) {}
                me._stopPolling(); me._handleIn(d.packet, BLOB_NS);
            }
            else if (d && d.status === 'taken') { me._stopPolling(); me._emit('beacon-taken'); }
            else { me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000); }
        }).catch(function(e) { log('_doPoll error', e.message); me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000); });
    },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; } },

    _startMsgPoll(chId) {
        if (this._msgPollTimers[chId]) return;
        const me = this;
        function poll() {
            if (!me._channels[chId]) { me._stopMsgPoll(chId); return; }
            if (me._webRTC[chId] && me._webRTC[chId].connected) { me._stopMsgPoll(chId); return; }
            me._get('/beacon?key=msg_' + chId).then(function(d) {
                if (d && d.packet) me._handleIn(d.packet, chId);
                me._msgPollTimers[chId] = setTimeout(poll, CONFIG.MSG_POLL_INTERVAL);
            }).catch(function(e) { log('msgPoll error', e.message); me._msgPollTimers[chId] = setTimeout(poll, CONFIG.MSG_POLL_INTERVAL); });
        }
        poll();
    },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; } },

    async startWebRTC(chId, asInitiator) {
        const ch = this._channels[chId]; if (!ch || this._webRTC[chId]) return;
        try {
            const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            this._webRTC[chId] = { pc, dc: null, iceBuffer: [], connected: false, initiator: asInitiator, seenMessages: new Set(), offerSent: false };
            const me = this;
            pc.onicecandidate = function(e) { if (e.candidate) me._webRTC[chId].iceBuffer.push(e.candidate); else me._flushICE(chId); };
            pc.onconnectionstatechange = function() {
                if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                    me._webRTC[chId].connected = false;
                    me._startMsgPoll(chId);
                }
            };
            if (asInitiator) {
                const dc = pc.createDataChannel('chat'); me._webRTC[chId].dc = dc;
                dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); me._stopMsgPoll(chId); };
                dc.onmessage = function(e) { me._handleDCMessage(chId, ch, e); };
                const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
                me._webRTC[chId].offerSent = true;
                me._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) });
            } else {
                pc.ondatachannel = function(e) {
                    const dc = e.channel; me._webRTC[chId].dc = dc;
                    dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); me._stopMsgPoll(chId); };
                    dc.onmessage = function(ev) { me._handleDCMessage(chId, ch, ev); };
                };
            }
            setTimeout(() => {
                if (me._webRTC[chId] && !me._webRTC[chId].connected) {
                    me._startWebRTCPoll(chId);
                }
            }, 15000);
        } catch(e) {
            log('startWebRTC error', e.message);
            this._emit('error', { message: 'Ошибка WebRTC: ' + e.message });
        }
    },
    _handleDCMessage(chId, ch, e) {
        let m; try { m = JSON.parse(e.data); } catch(er) { return; }
        if (m.type === 'message' && !this._webRTC[chId].seenMessages.has(m.nonce)) {
            this._webRTC[chId].seenMessages.add(m.nonce);
            ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them', status: 'delivered' });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
            this._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time });
        }
    },
    _startWebRTCPoll(chId) {
        if (this._webRTCPolling[chId]) return;
        const me = this;
        function poll() {
            if (!me._webRTC[chId] || me._webRTC[chId].connected) { me._stopWebRTCPoll(chId); return; }
            me._get('/beacon?key=webrtc_' + chId).then(function(d) {
                if (d && d.packet) me._handleWSig(chId, JSON.parse(d.packet));
                me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL);
            }).catch(function(e) { log('webrtcPoll error', e.message); me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL); });
        }
        poll();
    },
    _stopWebRTCPoll(chId) { if (this._webRTCPolling[chId]) { clearTimeout(this._webRTCPolling[chId]); delete this._webRTCPolling[chId]; } },

    async _handleWSig(chId, sig) {
        const rtc = this._webRTC[chId]; if (!rtc || !rtc.pc || rtc.connected) return;
        const pc = rtc.pc;
        try {
            if (sig.type === 'webrtc-ice') { const c = JSON.parse(sig.sdp); if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}); else rtc.iceBuffer.push(c); return; }
            if (sig.type === 'webrtc-offer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(function(c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}) }); rtc.iceBuffer = []; if (!rtc.initiator) { const a = await pc.createAnswer(); await pc.setLocalDescription(a); this._sendWSig(chId, { type: 'webrtc-answer', sdp: JSON.stringify(pc.localDescription) }); } return; }
            if (sig.type === 'webrtc-answer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(function(c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}) }); rtc.iceBuffer = []; }
        } catch(e) { log('_handleWSig error', e.message); }
    },
    _sendWSig(chId, data) { this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); },
    _flushICE(chId) { const rtc = this._webRTC[chId]; if (!rtc) return; const me = this; rtc.iceBuffer.forEach(function(c) { me._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) }); }); rtc.iceBuffer = []; },

    _startHousekeeping() {
        const me = this;
        this._housekeepInterval = setInterval(function() {
            const now = Date.now();
            Object.keys(me._channels).forEach(function(id) { if (now > me._channels[id].expires) { delete me._channels[id]; delete me._webRTC[id]; me._stopMsgPoll(id); me._stopWebRTCPoll(id); me._emit('channel-expired', { channelId: id }); } });
            Object.keys(me._beacons).forEach(function(id) { if (now > me._beacons[id].expires) delete me._beacons[id]; });
            if (me._peerId && Object.keys(me._channels).length === 0) {
                me._get('/beacon?key=emoji_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(e) { log('housekeep emoji error', e.message); });
                me._get('/beacon?key=ack_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(e) { log('housekeep ack error', e.message); });
            }
        }, CONFIG.HOUSEKEEP_INTERVAL);
    },

    async sendMessage(chId, text) {
        const ch = this._channels[chId]; if (!ch) return false;
        const nonce = RND();
        const rtc = this._webRTC[chId];
        if (rtc && rtc.dc && rtc.dc.readyState === 'open') {
            rtc.dc.send(JSON.stringify({ type: 'message', text, time: Date.now(), nonce }));
            ch.blobs.push({ d: text, t: Date.now(), n: nonce, from: 'me', status: 'sent' });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { channelId: chId, data: text, status: 'sent' }); return true;
        }
        if (ch.ratchetKey) {
            const result = await workerPackBlob(JSON.stringify({ d: text, t: Date.now(), n: nonce }), ch);
            ch.ratchetKey = result.newRatchetKey;
            ch.ratchetIndex = result.newRatchetIndex;
            if (!ch.oldKeys) ch.oldKeys = [];
            ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: ch.ratchetKey });
            if (ch.oldKeys.length > CONFIG.MAX_OLD_KEYS) ch.oldKeys.shift();
            await this._post('/beacon', { keyHash: 'msg_' + chId, packet: result.packed });
            ch.blobs.push({ d: text, t: Date.now(), n: nonce, from: 'me', status: 'sent' });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { channelId: chId, data: text, status: 'sent' }); return true;
        }
        return false;
    },

    async sendVoiceMessage(chId, audioData, duration) {
        const ch = this._channels[chId]; if (!ch) return false;
        if (audioData.length > CONFIG.MAX_VOICE_SIZE) { this._emit('error', { message: 'Голосовое сообщение слишком большое' }); return false; }
        if (duration > CONFIG.MAX_VOICE_DURATION) { this._emit('error', { message: 'Голосовое сообщение слишком длинное' }); return false; }
        return this.sendMessage(chId, JSON.stringify({ voice: true, data: audioData, duration }));
    },

    async _handleIn(blobData, chId) {
        let d; try { d = JSON.parse(blobData); } catch(e) { return; }
        log('_handleIn', d.type || 'unknown');
        const me = this;
        if (d.type && d.type.startsWith('webrtc-')) { this._handleWSig(chId || Object.keys(this._channels)[0], d); return; }

        if (d.type === 'beacon-response' && d.pubKey && d.inner) {
            if (Object.keys(this._channels).length > 0) return;
            if (this._verificationEmoji) {
                this._autoConfirmAsAlice(d);
                return;
            }
            return;
        }

        if (d.type === 'verification-emoji' && d.emoji) {
            if (Object.keys(this._channels).length > 0) return;
            if (this._verificationEmoji && arraysEqual(d.emoji, this._verificationEmoji)) {
                this._autoConfirmAsAlice(d);
                return;
            }
            this._verificationEmoji = d.emoji;
            if (!this._pendingVerification && d.pubKey && d.inner) {
                this._pendingVerification = { bd: { pubKey: d.pubKey, inner: d.inner, peerId: d.peerId }, targetPeerId: d.peerId, emoji: d.emoji };
            }
            this._emit('verification-received', { emoji: d.emoji });
            return;
        }

        if (d.type === 'verification-ack') {
            if (Object.keys(this._channels).length > 0) return;
            this._emit('verification-acked', {});
            return;
        }

        if (d.type === 'beacon-ack' && d.channelId) {
            const ch = this._channels[d.channelId];
            if (ch) {
                this._stopPolling();
                this._cleanupBeaconKeys(this._peerId);
                this._stats.channelsOpened++;
                this._emit('channel-opened', { channelId: d.channelId, peerId: d.peerId, nick: 'Лучник', avatar: '001' });
                this._startMsgPoll(d.channelId);
                this.startWebRTC(d.channelId, false);
                return;
            }
        }

        const ch = this._channels[chId];
        if (ch && ch.ratchetKey) {
            try {
                const u = await workerUnpackBlob(blobData, ch);
                if (u) {
                    const dedupKey = chId + '_' + (u.n || u._t || '');
                    if (this._dedupTimers[dedupKey]) return;
                    this._dedupTimers[dedupKey] = setTimeout(function() { delete me._dedupTimers[dedupKey]; }, CONFIG.CHANNEL_TTL);
                    ch.blobs.push({ d: u.d || u.text || '', t: u._t || Date.now(), n: u.n || '', from: 'them', status: 'delivered' });
                    ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                    this._emit('message-received', { channelId: chId, text: u.d || u.text || '', from: 'them', timestamp: u._t || Date.now(), status: 'delivered' });
                } else {
                    requestRatchetResync(ch);
                }
            } catch(e) { log('unpack error', e.message); requestRatchetResync(ch); }
        }
    },

    getStats() { return { peerId: this._peerId, state: this._state, channels: Object.keys(this._channels).length, messagesSent: this._stats.messagesSent, messagesReceived: this._stats.messagesReceived, peersConnected: this._stats.peersConnected, channelsOpened: this._stats.channelsOpened }; },
    clearData() { try { localStorage.removeItem('p2ppong_state'); localStorage.removeItem('p2ppong_channels'); } catch(e) {} },
    async destroy() { this._stopPolling(); Object.keys(this._msgPollTimers).forEach(function(id) { clearTimeout(this._msgPollTimers[id]); }); this._msgPollTimers = {}; Object.keys(this._webRTCPolling).forEach(function(id) { clearTimeout(this._webRTCPolling[id]); }); this._webRTCPolling = {}; Object.keys(this._webRTC).forEach(function(id) { try { this._webRTC[id].pc.close(); } catch(e) {} }); this._webRTC = {}; if (this._housekeepInterval) clearInterval(this._housekeepInterval); if (typeof RobinHoodPeerHelp !== 'undefined') RobinHoodPeerHelp.stop(); this._channels = {}; this._beacons = {}; this._listeners = {}; this._state = 'idle'; this._peerId = null; this._pendingVerification = null; this._verificationEmoji = null; this._emit('destroyed'); }
};

const RND = function() { const a = new Uint32Array(4); crypto.getRandomValues(a); return Array.from(a).map(function(x) { return x.toString(16).padStart(8, '0'); }).join(''); };
function xorDistance(id1, id2) { let dist = ''; for (let i = 0; i < Math.min(id1.length, id2.length); i++) dist += (parseInt(id1[i], 16) ^ parseInt(id2[i], 16)).toString(16); return BigInt('0x' + dist); }
function getBucketIndex(dist) { if (dist === 0n) return 0; return dist.toString(2).length - 1; }
function initBuckets() { DHT._buckets = Array.from({ length: 256 }, function() { return []; }); }
function addPeer(peerId, conn) { const dist = xorDistance(DHT._nodeId, peerId); const idx = Math.min(getBucketIndex(dist), 255); const bucket = DHT._buckets[idx]; const existing = bucket.findIndex(function(p) { return p.id === peerId; }); if (existing >= 0) bucket.splice(existing, 1); bucket.unshift({ id: peerId, conn, lastSeen: Date.now() }); if (bucket.length > DHT._k) bucket.pop(); DHT._peers.set(peerId, { conn, lastSeen: Date.now() }); }
function getClosestPeers(targetId, count) { count = count || DHT._k; const all = []; DHT._buckets.forEach(function(bucket) { bucket.forEach(function(peer) { all.push({ id: peer.id, conn: peer.conn, lastSeen: peer.lastSeen, distance: xorDistance(targetId, peer.id) }); }); }); all.sort(function(a, b) { return a.distance < b.distance ? -1 : 1; }); return all.slice(0, count); }
async function sendToPeer(peerId, message) { const peer = DHT._peers.get(peerId); if (!peer || !peer.conn || peer.conn.readyState !== 'open') return; try { peer.conn.send(JSON.stringify(message)); } catch(e) {} }
let lastResyncTime = {}, resyncInProgress = {};
async function requestRatchetResync(ch) { const chId = Object.keys(P2PPong._channels).find(function(id) { return P2PPong._channels[id] === ch; }); if (!chId) return; const now = Date.now(); if (lastResyncTime[chId] && now - lastResyncTime[chId] < CONFIG.RATCHET_RESYNC_INTERVAL) return; if (resyncInProgress[chId]) return; resyncInProgress[chId] = true; lastResyncTime[chId] = now; log('ratchet-resync', 'Запрошен для ' + chId); try { const kp = await workerGenerateKeyPair(); P2PPong._post('/beacon', { keyHash: 'msg_' + chId, packet: await workerEncryptAES(JSON.stringify({ type: 'ratchet-resync', pubKey: kp.publicKey, peerId: P2PPong._peerId }), ch.secret) }); } catch(e) {} finally { resyncInProgress[chId] = false; } }

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
