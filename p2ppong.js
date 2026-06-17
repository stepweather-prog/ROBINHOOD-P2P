// ===================================================================
// P2PPong v1.0 — Распределённая платформа (ядро)
// ===================================================================

const P2PPong = {
    _peerId: null,
    _beacons: {},
    _channels: {},
    _ws: null,
    _signalServers: [
        { type: 'http', url: 'https://robincall.stephanclaps-491.workers.dev', name: 'Cloudflare' },
        { type: 'http', url: 'https://p2ppong-v2.onrender.com', name: 'Render' }
    ],
    _currentSignalIndex: 0,
    _wsReconnectDelay: 1000,
    _maxReconnectDelay: 30000,
    _listeners: {},
    _state: 'idle',
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },
    _httpSignal: null,
    _peerHelpActive: false,
    _housekeepInterval: null,
    _pollTimer: null,
    _pollStart: null,
    _pollMax: 150,
    _pollSilence: 30000,
    _pollInterval: 15000,
    _pollFast: 5000,
    _pollFastStart: 135,

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return () => {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        };
    },

    _emit(event, data) {
        if (!this._listeners[event]) return;
        this._listeners[event].forEach(cb => {
            try { cb(data); } catch(e) { console.error('[P2PPong] Event error:', event, e); }
        });
    },

    async init() {
        if (this._state !== 'idle') return;
        this._state = 'connecting';
        this._emit('state-change', { state: 'connecting' });

        try {
            DHT._nodeId = this._peerId || RND();
            initBuckets();

            const channelsRaw = await decryptFromStorage('p2ppong_channels');
            if (channelsRaw) {
                try {
                    JSON.parse(channelsRaw).forEach(ch => {
                        if (Date.now() < ch.expires) {
                            this._channels[ch.id] = { ...ch, blobs: [], secret: null, reconnect: true };
                        }
                    });
                } catch(e) {}
            }

            if (typeof RobinHoodPeerHelp !== 'undefined') {
                RobinHoodPeerHelp.start(this._peerId);
                this._peerHelpActive = true;
            }

            this._connectSignal();
            this._startHousekeeping();

            this._state = 'online';
            this._emit('state-change', { state: 'online', peerId: this._peerId });
            this._emit('ready', {
                peerId: this._peerId,
                channels: Object.keys(this._channels).length
            });
        } catch(e) {
            this._state = 'offline';
            this._emit('state-change', { state: 'offline', error: e.message });
            this._emit('error', { message: 'Ошибка инициализации', error: e });
        }
    },

    // ==================== КРАФТ СТРЕЛ ====================
    async craftArrow() {
        if (this._peerId) return this._peerId;
        this._peerId = await generateHardwarePeerId();
        this._emit('peer-id-generated', { peerId: this._peerId });
        return this._peerId;
    },

    getPeerId() {
        return this._peerId;
    },

    // ==================== ОПРОС МАЯКОВ ====================
    startPolling() {
        if (!this._peerId) return;
        this._stopPolling();
        this._pollStart = Date.now();
        this._pollTimer = setTimeout(() => this._doPoll(), this._pollSilence);
    },

    _doPoll() {
        if (!this._peerId) return;

        const elapsed = (Date.now() - this._pollStart) / 1000;
        if (elapsed > this._pollMax) {
            this._stopPolling();
            this._emit('beacon-timeout');
            return;
        }

        let next;
        if (this._pollFast && this._pollFastStart && elapsed > this._pollFastStart) {
            next = this._pollFast;
        } else {
            next = this._pollInterval;
        }

        const keyHash = 'waiting_' + this._peerId;
        fetch(`https://robincall.stephanclaps-491.workers.dev/beacon?key=${keyHash}`)
            .then(r => r.json())
            .then(d => {
                if (d.status === 'found' && d.packet) {
                    this._stopPolling();
                    this._handleIncomingBlob(d.packet, BLOB_NS);
                } else {
                    this._pollTimer = setTimeout(() => this._doPoll(), next);
                }
            })
            .catch(() => {
                this._pollTimer = setTimeout(() => this._doPoll(), next);
            });
    },

    _stopPolling() {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    },

    // ==================== СИГНАЛЬНЫЙ СЕРВЕР ====================
    _connectSignal() {
        this._connectHttpPolling();
    },

    _connectWebSocket(url) {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
        try { this._ws = new WebSocket(url); } catch(e) {
            this._switchSignalServer(); return;
        }

        this._ws.onopen = () => {
            this._wsReconnectDelay = 1000;
            this._state = 'online';
            this._emit('state-change', { state: 'online' });
            this._emit('signal-connected', { server: 'Cloudflare' });
            try { this._ws.send(JSON.stringify({ action: 'subscribe', peerId: this._peerId })); } catch(e) {}
        };

        this._ws.onmessage = async (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch(er) {
                this._handleIncomingBlob(e.data, null); return;
            }
            if (msg.type === 'dht-signal' && msg.from !== DHT._nodeId) {
                await handleSignal(msg.from, msg.data); return;
            }
            if (msg.type === 'blob') {
                this._handleIncomingBlob(msg.blob, msg.channelId); return;
            }
        };

        this._ws.onclose = () => {
            if (document.visibilityState === 'hidden') return;
            this._state = 'offline';
            this._emit('state-change', { state: 'offline' });
            this._switchSignalServer();
        };

        this._ws.onerror = () => { this._ws.close(); };
    },

    _connectHttpPolling() {
        this._state = 'online';
        this._emit('state-change', { state: 'online' });
        this._emit('signal-connected', { server: 'Cloudflare HTTP' });
    },

    _switchSignalServer() {
        this._currentSignalIndex = (this._currentSignalIndex + 1) % this._signalServers.length;
        const delay = Math.min(this._wsReconnectDelay * 2, this._maxReconnectDelay);
        this._wsReconnectDelay = delay;
        setTimeout(() => this._connectSignal(), delay);
    },

    _startHousekeeping() {
        this._housekeepInterval = setInterval(() => {
            const now = Date.now();
            for (const [id, ch] of Object.entries(this._channels)) {
                if (now > ch.expires) { delete this._channels[id]; this._emit('channel-expired', { channelId: id }); }
            }
            for (const [id, b] of Object.entries(this._beacons)) {
                if (now > b.expires) delete this._beacons[id];
            }
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
        if (!targetPeerId || !this._peerId) return null;
        const kp = await generateKeyPair();
        const pk = await exportPublicKey(kp);
        const nonce = RND();
        const bid = RND();
        const beaconKey = await SHA(nonce + 'beacon');
        const inner = await encryptAES(JSON.stringify({ nonce, timestamp: Date.now(), peerId: this._peerId }), beaconKey);
        const beaconData = { type: 'beacon', pubKey: pk, peerId: this._peerId, inner, targetPeerId, nick: metadata.nick || '', avatar: metadata.avatar || '' };
        beaconData.sig = await computeHMAC(JSON.stringify(beaconData), beaconKey);
        this._beacons[bid] = { keyPair: kp, pubKey: pk, nonce, beaconKey, expires: Date.now() + 300000 };

        const keyHash = 'waiting_' + targetPeerId;
        const packet = JSON.stringify(beaconData);

        try {
            await fetch('https://robincall.stephanclaps-491.workers.dev/beacon', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyHash, packet })
            });
        } catch(e) {}

        this._emit('beacon-sent', { targetPeerId, beaconId: bid, keyHash });
        this.startPolling();
        return bid;
    },

    async sendMessage(channelId, data) {
        const ch = this._channels[channelId];
        if (!ch || !ch.ratchetKey) return false;
        const payload = JSON.stringify({ d: typeof data === 'string' ? data : JSON.stringify(data), t: Date.now(), n: RND() });
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

    async _handleIncomingBlob(blobData, channelId) {
        let data;
        try { data = JSON.parse(blobData); } catch(e) { return; }

        if (data && data.type === 'beacon' && data.pubKey && data.inner) {
            if (data.targetPeerId && data.targetPeerId !== this._peerId) return;
            if (data.sig && !await verifyHMAC(JSON.stringify(data), data.sig, await SHA('beacon'))) return;

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
                    this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: data.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now() };
                    const response = JSON.stringify({ type: 'beacon-response', pubKey: myPubKey, peerId: this._peerId, inner: data.inner, nick: data.nick, avatar: data.avatar });
                    this._broadcastBlob(response, BLOB_NS);
                    this._stats.channelsOpened++;
                    await this._saveChannels();
                    this._emit('channel-opened', { channelId: chId, peerId: data.peerId, nick: data.nick || 'Аноним', avatar: data.avatar || '001' });
                },
                reject: () => { this._emit('beacon-rejected', { peerId: data.peerId }); }
            });
            return;
        }

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
                this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: data.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now() };
                delete this._beacons[bid];
                this._stats.channelsOpened++;
                await this._saveChannels();
                this._emit('channel-opened', { channelId: chId, peerId: data.peerId, nick: data.nick || 'Аноним', avatar: data.avatar || '001' });
                return;
            }
        }

        if (data && data.type === 'ratchet-resync' && data.pubKey) {
            const chId = Object.keys(this._channels).find(id => this._channels[id].peerId === data.peerId);
            if (chId) {
                const ch = this._channels[chId];
                try {
                    const remotePubKey = await importPublicKey(data.pubKey);
                    const kp = await generateKeyPair();
                    const newSecret = await deriveSecret(kp, remotePubKey);
                    ch.secret = newSecret; ch.ratchetKey = newSecret; ch.ratchetIndex = 0; ch.oldKeys = []; ch.lastReceivedRi = -1;
                    this._emit('ratchet-reset', { channelId: chId });
                } catch(e) {}
            }
            return;
        }

        for (const [id, ch] of Object.entries(this._channels)) {
            if (!ch.ratchetKey) continue;
            const u = await unpackBlob(blobData, ch);
            if (!u) continue;
            if (u._ri !== undefined) {
                if (ch.lastReceivedRi === undefined) ch.lastReceivedRi = -1;
                if (u._ri <= ch.lastReceivedRi) return;
                ch.lastReceivedRi = u._ri;
            }
            if (u.webrtc) { this._emit('webrtc-signal', { channelId: id, data: u }); return; }
            if (u.voice) {
                ch.blobs = ch.blobs || [];
                ch.blobs.push({ ...u, from: 'them' });
                ch.expires = Date.now() + 600000;
                this._stats.messagesReceived++;
                await this._saveChannels();
                this._emit('voice-message', { channelId: id, data: u.data, from: 'them' });
                return;
            }
            ch.blobs = ch.blobs || [];
            ch.blobs.push({ ...u, from: 'them' });
            ch.expires = Date.now() + 600000;
            this._stats.messagesReceived++;
            await this._saveChannels();
            this._emit('message-received', { channelId: id, text: u.d || u.text || '', from: 'them', timestamp: u._t || Date.now() });
            return;
        }
    },

    _broadcastBlob(packed, channelId) {
        const targetId = channelId || BLOB_NS;
        const dhtPeers = getClosestPeers(targetId, 3).filter(p => p.conn?.readyState === 'open');
        if (dhtPeers.length > 0) {
            for (const p of dhtPeers) sendToPeer(p.id, { type: 'blob', channelId: targetId, blob: packed });
        }
    },

    async _saveChannels() {
        const data = Object.entries(this._channels).map(([id, ch]) => ({ id, peerId: ch.peerId, type: ch.type, expires: ch.expires, createdAt: ch.createdAt }));
        await encryptToStorage('p2ppong_channels', JSON.stringify(data));
    },

    getStats() {
        return { peerId: this._peerId, state: this._state, channels: Object.keys(this._channels).length, dhtPeers: DHT._peers.size, ...this._stats };
    },

    async destroy() {
        this._stopPolling();
        if (this._housekeepInterval) clearInterval(this._housekeepInterval);
        if (this._ws) { this._ws.onclose = null; this._ws.close(); this._ws = null; }
        if (this._peerHelpActive && typeof RobinHoodPeerHelp !== 'undefined') { RobinHoodPeerHelp.stop(); }
        this._channels = {}; this._beacons = {}; this._listeners = {}; this._state = 'idle';
        this._peerId = null;
        await this._saveChannels();
        this._emit('destroyed');
    }
};

const DEBUG = false;
function logError(c, e) { if (DEBUG) console.error(`[${c}]`, e); }
function logWarn(c, m) { if (DEBUG) console.warn(`[${c}]`, m); }
if (!window.crypto?.subtle) throw new Error('Требуется HTTPS');
const RND = () => { const a = new Uint32Array(4); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(8, '0')).join(''); };
const SHA = async t => { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); };

async function deriveStorageKey() {
    try {
        const salt = localStorage.getItem('pp4_hw_salt') || RND();
        if (!localStorage.getItem('pp4_hw_salt')) localStorage.setItem('pp4_hw_salt', salt);
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'PBKDF2' }, false, ['deriveKey']);
        return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('p2ppong_storage'), iterations: 100000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } catch(e) { return null; }
}

async function encryptToStorage(key, value) {
    try {
        const k = await deriveStorageKey();
        if (!k) { localStorage.setItem(key, value); return; }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(value));
        const c = new Uint8Array(iv.length + new Uint8Array(ct).length);
        c.set(iv); c.set(new Uint8Array(ct), iv.length);
        localStorage.setItem(key, btoa(String.fromCharCode(...c)));
    } catch(e) { localStorage.setItem(key, value); }
}

async function decryptFromStorage(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        if (raw.startsWith('{') || raw.startsWith('[')) return raw;
        const k = await deriveStorageKey();
        if (!k) return raw;
        const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
        const iv = bytes.slice(0, 12);
        const ct = bytes.slice(12);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct);
        return new TextDecoder().decode(decrypted);
    } catch(e) { return localStorage.getItem(key); }
}

async function generateHardwarePeerId() {
    const p = [];
    try { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); const ext = gl.getExtension('WEBGL_debug_renderer_info'); if (ext) { p.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)); p.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)); } } catch(e) {}
    try { const ctx = new AudioContext(); p.push(ctx.sampleRate.toString()); p.push(ctx.destination.maxChannelCount.toString()); ctx.close(); } catch(e) {}
    p.push(screen.width + 'x' + screen.height, screen.colorDepth.toString(), navigator.hardwareConcurrency || '', navigator.deviceMemory || '');
    let s = localStorage.getItem('pp4_hw_salt');
    if (!s) { s = RND(); localStorage.setItem('pp4_hw_salt', s); }
    p.push(s);
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.join('|')));
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

async function generateKeyPair() { return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); }
async function exportPublicKey(kp) { const r = await crypto.subtle.exportKey('raw', kp.publicKey); return btoa(String.fromCharCode(...new Uint8Array(r))); }
async function importPublicKey(b64) { const r = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); return await crypto.subtle.importKey('raw', r, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
async function deriveSecret(kp, remotePubKey) { const b = await crypto.subtle.deriveBits({ name: 'ECDH', public: remotePubKey }, kp.privateKey, 256); return Array.from(new Uint8Array(b)).map(b => b.toString(16).padStart(2, '0')).join(''); }

async function encryptAES(text, secret) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text));
    const c = new Uint8Array(iv.length + new Uint8Array(ct).length);
    c.set(iv); c.set(new Uint8Array(ct), iv.length);
    return btoa(String.fromCharCode(...c));
}

async function decryptAES(enc, secret) {
    try {
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['decrypt']);
        const c = Uint8Array.from(atob(enc), x => x.charCodeAt(0));
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, k, c.slice(12)));
    } catch(e) { return null; }
}

async function computeHMAC(data, secret) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)))));
}

async function verifyHMAC(data, sig, secret) {
    try {
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        return await crypto.subtle.verify('HMAC', k, Uint8Array.from(atob(sig), c => c.charCodeAt(0)), new TextEncoder().encode(data));
    } catch(e) { return false; }
}

async function advanceRatchet(ch) {
    const oldKey = ch.ratchetKey || ch.secret;
    const salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0');
    const newKey = await SHA(oldKey + salt);
    ch.ratchetKey = newKey;
    ch.ratchetIndex = (ch.ratchetIndex || 0) + 1;
    if (!ch.oldKeys) ch.oldKeys = [];
    ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: oldKey });
    if (ch.oldKeys.length > 50) ch.oldKeys.shift();
    return newKey;
}

async function packBlob(jsonString, ch) {
    const compressed = await compressData(jsonString);
    const padSize = Math.floor(Math.random() * 50) + 20;
    const randomPad = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(padSize))));
    const data = JSON.stringify({ z: compressed, t: Date.now(), n: RND(), pad: randomPad, ri: ch.ratchetIndex || 0 });
    const currentKey = ch.ratchetKey || ch.secret;
    const hmac = await computeHMAC(data, currentKey);
    let padded = hmac + '|' + data;
    if (padded.length < 4096) {
        const pad = crypto.getRandomValues(new Uint8Array(4096 - padded.length));
        padded += String.fromCharCode(...pad);
    }
    await advanceRatchet(ch);
    return await encryptAES(padded, ch.secret);
}

async function unpackBlob(blob, ch) {
    const dec = await decryptAES(blob, ch.secret);
    if (!dec) return null;
    let result = await tryDecryptWithKey(dec, ch.ratchetKey || ch.secret);
    if (result) return result;
    if (ch.oldKeys) {
        for (let i = ch.oldKeys.length - 1; i >= 0; i--) {
            result = await tryDecryptWithKey(dec, ch.oldKeys[i].key);
            if (result) return result;
        }
    }
    requestRatchetResync(ch);
    return null;
}

async function tryDecryptWithKey(decrypted, key) {
    const separatorIndex = decrypted.indexOf('|');
    if (separatorIndex === -1) return null;
    const hmac = decrypted.substring(0, separatorIndex);
    const data = decrypted.substring(separatorIndex + 1).trim().replace(/\x00+$/, '');
    if (!await verifyHMAC(data, hmac, key)) return null;
    try {
        const parsed = JSON.parse(data);
        if (parsed.z) { const inner = JSON.parse(await decompressData(parsed.z)); inner._t = parsed.t; inner._ri = parsed.ri; return inner; }
        delete parsed.pad; delete parsed.ri; return parsed;
    } catch(e) { return null; }
}

async function compressData(str) {
    try {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(new TextEncoder().encode(str)); writer.close();
        const reader = cs.readable.getReader();
        const chunks = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
        let offset = 0; for (const chunk of chunks) { total.set(chunk, offset); offset += chunk.length; }
        return btoa(String.fromCharCode(...total));
    } catch(e) { return btoa(str); }
}

async function decompressData(b64) {
    try {
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes); writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
        const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
        let offset = 0; for (const chunk of chunks) { total.set(chunk, offset); offset += chunk.length; }
        return new TextDecoder().decode(total);
    } catch(e) { return atob(b64); }
}

let lastResyncTime = {}, resyncInProgress = {};
async function requestRatchetResync(ch) {
    const chId = Object.keys(P2PPong._channels).find(id => P2PPong._channels[id] === ch);
    if (!chId) return;
    const now = Date.now();
    if (lastResyncTime[chId] && now - lastResyncTime[chId] < 60000) return;
    if (resyncInProgress[chId]) return;
    resyncInProgress[chId] = true; lastResyncTime[chId] = now;
    try {
        const kp = await generateKeyPair();
        const resyncData = JSON.stringify({ type: 'ratchet-resync', pubKey: await exportPublicKey(kp), peerId: P2PPong._peerId });
        P2PPong._broadcastBlob(await encryptAES(resyncData, ch.secret), chId);
    } catch(e) {} finally { resyncInProgress[chId] = false; }
}

const DHT = { _nodeId: null, _buckets: [], _storage: {}, _k: 20, _alpha: 3, _peers: new Map(), _signalSend: null };
const BLOB_NS = '00000000000000000000000000000000';
const pendingDHTRequests = new Map();

function xorDistance(id1, id2) { let dist = ''; for (let i = 0; i < Math.min(id1.length, id2.length); i++) dist += (parseInt(id1[i], 16) ^ parseInt(id2[i], 16)).toString(16); return BigInt('0x' + dist); }
function getBucketIndex(dist) { if (dist === 0n) return 0; return dist.toString(2).length - 1; }
function initBuckets() { DHT._buckets = Array.from({ length: 256 }, () => []); }
function addPeer(peerId, conn) { const dist = xorDistance(DHT._nodeId, peerId); const idx = Math.min(getBucketIndex(dist), 255); const bucket = DHT._buckets[idx]; const existing = bucket.findIndex(p => p.id === peerId); if (existing >= 0) bucket.splice(existing, 1); bucket.unshift({ id: peerId, conn, lastSeen: Date.now() }); if (bucket.length > DHT._k) bucket.pop(); DHT._peers.set(peerId, { conn, lastSeen: Date.now() }); }
function getClosestPeers(targetId, count = DHT._k) { const all = []; for (const bucket of DHT._buckets) for (const peer of bucket) all.push({ ...peer, distance: xorDistance(targetId, peer.id) }); all.sort((a, b) => a.distance < b.distance ? -1 : 1); return all.slice(0, count); }

function setupDataChannel(dc, peerId) {
    dc.onopen = () => { addPeer(peerId, dc); };
    dc.onclose = () => { DHT._peers.delete(peerId); for (const bucket of DHT._buckets) { const idx = bucket.findIndex(p => p.id === peerId); if (idx >= 0) bucket.splice(idx, 1); } };
    dc.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch(er) { P2PPong._handleIncomingBlob(e.data, null); return; }
        const peer = DHT._peers.get(peerId);
        if (peer) peer.lastSeen = Date.now();
        if (msg.type === 'dht-ping') { try { dc.send(JSON.stringify({ type: 'dht-pong' })); } catch(er) {} return; }
        if (msg.type === 'dht-pong') return;
        if (msg.type === 'blob') { P2PPong._handleIncomingBlob(msg.blob, msg.channelId); return; }
    };
}

async function sendToPeer(peerId, message) { const peer = DHT._peers.get(peerId); if (!peer?.conn || peer.conn.readyState !== 'open') return; try { peer.conn.send(JSON.stringify(message)); } catch(e) {} }

async function handleSignal(fromPeerId, signal) {
    let pc;
    try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); } catch(e) { return; }
    pc.ondatachannel = (e) => { setupDataChannel(e.channel, fromPeerId); };
    pc.onicecandidate = (e) => { if (!e.candidate && pc.localDescription && DHT._signalSend) DHT._signalSend(fromPeerId, { type: 'dht-signal', sdp: JSON.stringify(pc.localDescription) }); };
    try { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(signal.sdp))); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); } catch(e) {}
}

DHT._signalSend = (targetPeerId, data) => {
    if (P2PPong._ws?.readyState === WebSocket.OPEN) {
        try { P2PPong._ws.send(JSON.stringify({ action: 'dht-signal', targetPeerId, from: DHT._nodeId, data })); } catch(e) {}
    }
};

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
