// ===================================================================
// P2PPong 
// ===================================================================

const DEBUG = true;
function log(msg, data) { if (DEBUG) console.log(`[P2PPong] ${msg}`, data || ''); }

const CONFIG = {
    BEACON_TTL: 300000,
    CHANNEL_TTL: 600000,
    POLL_INTERVAL: 15000,
    POLL_FAST: 5000,
    POLL_FAST_START: 135,
    POLL_MAX: 150,
    MSG_POLL_INTERVAL: 2000,
    WEBRTC_POLL_INTERVAL: 3000,
    HOUSEKEEP_INTERVAL: 5000,
    MAX_OLD_KEYS: 50,
    BLOB_SIZE: 4096
};

const DHT = { _nodeId: null, _buckets: [], _storage: {}, _k: 20, _alpha: 3, _peers: new Map(), _signalSend: null };
const BLOB_NS = '00000000000000000000000000000000';

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
    _pendingVerification: null, _verificationEmoji: null,
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
        }
    },

    _genEmoji() { const p = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😇','🤠','🫡','🤔','😏','😤','🥺','😱','💀','👽','🤖']; return [...Array(5)].map(() => p[Math.floor(Math.random()*p.length)]); },

    async craftArrow() {
        if (this._crafting) return this._peerId;
        this._crafting = true;
        try {
            this._peerId = RND();
            this._emit('peer-id-generated', { peerId: this._peerId });
            const kp = await generateKeyPair(); const pk = await exportPublicKey(kp);
            const nonce = RND(); const bid = RND();
            const correctEmoji = this._genEmoji();
            this._verificationEmoji = correctEmoji;
            const bk = await SHA('beacon');
            const inner = await encryptAES(JSON.stringify({ nonce, timestamp: Date.now(), peerId: this._peerId, emoji: correctEmoji }), bk);
            const bd = { type: 'beacon', pubKey: pk, peerId: this._peerId, inner, targetPeerId: this._peerId, nick: '', avatar: '' };
            bd.sig = await computeHMAC(JSON.stringify(bd), bk);
            this._beacons[bid] = { keyPair: kp, pubKey: pk, nonce, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
            await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify(bd) });
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
        if (!this._peerId) this._peerId = RND();
        const decrypted = await decryptAES(bd.inner, await SHA('beacon'));
        if (!decrypted) { this._emit('error', { message: 'Не удалось расшифровать' }); return false; }
        const innerData = JSON.parse(decrypted);
        const correctEmoji = innerData.emoji || [];
        this._verificationEmoji = correctEmoji;
        this._pendingVerification = { bd, targetPeerId, emoji: correctEmoji };
        const bid = RND();
        this._beacons[bid] = { keyPair: await generateKeyPair(), pubKey: bd.pubKey, nonce: innerData.nonce || '', beaconKey: await SHA('beacon'), expires: Date.now() + CONFIG.BEACON_TTL };
        const ep = JSON.stringify({ type: 'verification-emoji', emoji: correctEmoji, peerId: this._peerId, pubKey: bd.pubKey, inner: bd.inner });
        await this._post('/beacon', { keyHash: 'emoji_' + bd.peerId, packet: ep });
        this._emit('verification-needed', { emoji: correctEmoji });
        return true;
    },

    async confirmVerification() {
        if (!this._pendingVerification) return false;
        const { bd, targetPeerId, emoji } = this._pendingVerification;
        this._pendingVerification = null;
        const rpk = await importPublicKey(bd.pubKey); const kp = await generateKeyPair(); const mpk = await exportPublicKey(kp);
        const ss = await deriveSecret(kp, rpk);
        const verificationHash = await SHA(ss + emoji.join(''));
        const chId = RND();
        this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + CONFIG.CHANNEL_TTL, createdAt: Date.now(), verificationHash };
        await this._post('/beacon', { keyHash: 'ack_' + targetPeerId, packet: JSON.stringify({ type: 'verification-ack', peerId: this._peerId, verificationHash }) });
        const ok = await this._post('/beacon', { keyHash: 'waiting_' + targetPeerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: this._peerId, inner: bd.inner, channelId: chId, verificationHash, nick: '', avatar: '' }) });
        if (!ok) return false;
        this._stopPolling(); this._stats.channelsOpened++;
        this._emit('channel-opened', { channelId: chId, peerId: bd.peerId, nick: 'Лучник', avatar: '001' });
        this._startMsgPoll(chId); this._verificationEmoji = null;
        this.startWebRTC(chId, true);
        return true;
    },
    getVerificationEmoji() { return this._verificationEmoji; },

    async _post(path, body) {
        for (const s of this._signalServers) {
            try {
                const r = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
                if (r.ok) return r.json();
            } catch(e) {}
        }
        return null;
    },
    async _get(path) {
        for (const s of this._signalServers) {
            try {
                const r = await fetch(s.url + path, { signal: AbortSignal.timeout(5000) });
                if (r.ok) return r.json();
            } catch(e) {}
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
            if (d && d.status === 'found' && d.packet) { me._stopPolling(); me._handleIn(d.packet, BLOB_NS); }
            else if (d && d.status === 'taken') { me._stopPolling(); me._emit('beacon-taken'); }
            else { me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000); }
        }).catch(function() { me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000); });
    },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; } },

    _startMsgPoll(chId) {
        if (this._msgPollTimers[chId]) return;
        const me = this;
        function poll() {
            if (!me._channels[chId]) { me._stopMsgPoll(chId); return; }
            me._get('/beacon?key=msg_' + chId).then(function(d) {
                if (d && d.packet) me._handleIn(d.packet, chId);
                me._msgPollTimers[chId] = setTimeout(poll, CONFIG.MSG_POLL_INTERVAL);
            }).catch(function() { me._msgPollTimers[chId] = setTimeout(poll, CONFIG.MSG_POLL_INTERVAL); });
        }
        poll();
    },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; } },

    async startWebRTC(chId, asInitiator) {
        const ch = this._channels[chId]; if (!ch || this._webRTC[chId]) return;
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this._webRTC[chId] = { pc, dc: null, iceBuffer: [], connected: false, initiator: asInitiator, seenMessages: new Set(), offerSent: false };
        const me = this;
        if (asInitiator) {
            const dc = pc.createDataChannel('chat'); me._webRTC[chId].dc = dc;
            dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); };
            dc.onmessage = function(e) { let m; try { m = JSON.parse(e.data); } catch(er) { return; } if (m.type === 'message' && !me._webRTC[chId].seenMessages.has(m.nonce)) { me._webRTC[chId].seenMessages.add(m.nonce); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + CONFIG.CHANNEL_TTL; me._stats.messagesReceived++; me._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } };
        } else {
            pc.ondatachannel = function(e) {
                const dc = e.channel; me._webRTC[chId].dc = dc;
                dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); };
                dc.onmessage = function(ev) { let m; try { m = JSON.parse(ev.data); } catch(er) { return; } if (m.type === 'message' && !me._webRTC[chId].seenMessages.has(m.nonce)) { me._webRTC[chId].seenMessages.add(m.nonce); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + CONFIG.CHANNEL_TTL; me._stats.messagesReceived++; me._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } };
            };
        }
        pc.onicecandidate = function(e) { if (e.candidate) me._webRTC[chId].iceBuffer.push(e.candidate); else me._flushICE(chId); };
        if (asInitiator && !me._webRTC[chId].offerSent) {
            const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
            me._webRTC[chId].offerSent = true;
            me._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) });
        }
        this._startWebRTCPoll(chId);
    },
    _startWebRTCPoll(chId) {
        if (this._webRTCPolling[chId]) return;
        const me = this;
        function poll() {
            if (!me._webRTC[chId] || me._webRTC[chId].connected) { me._stopWebRTCPoll(chId); return; }
            me._get('/beacon?key=webrtc_' + chId).then(function(d) {
                if (d && d.packet) me._handleWSig(chId, JSON.parse(d.packet));
                me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL);
            }).catch(function() { me._webRTCPolling[chId] = setTimeout(poll, CONFIG.WEBRTC_POLL_INTERVAL); });
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
        } catch(e) {}
    },
    _sendWSig(chId, data) { this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); },
    _flushICE(chId) { const rtc = this._webRTC[chId]; if (!rtc) return; const me = this; rtc.iceBuffer.forEach(function(c) { me._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) }); }); rtc.iceBuffer = []; },

    _startHousekeeping() {
        const me = this;
        this._housekeepInterval = setInterval(function() {
            const now = Date.now();
            Object.keys(me._channels).forEach(function(id) { if (now > me._channels[id].expires) { delete me._channels[id]; delete me._webRTC[id]; me._stopMsgPoll(id); me._stopWebRTCPoll(id); me._emit('channel-expired', { channelId: id }); } });
            Object.keys(me._beacons).forEach(function(id) { if (now > me._beacons[id].expires) delete me._beacons[id]; });
            if (me._peerId) {
                me._get('/beacon?key=emoji_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(){});
                me._get('/beacon?key=ack_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(){});
            }
        }, CONFIG.HOUSEKEEP_INTERVAL);
    },

    async sendMessage(chId, text) {
        const ch = this._channels[chId]; if (!ch) return false;
        const nonce = RND();
        const rtc = this._webRTC[chId];
        if (rtc && rtc.dc && rtc.dc.readyState === 'open') {
            rtc.dc.send(JSON.stringify({ type: 'message', text, time: Date.now(), nonce }));
            ch.blobs.push({ d: text, t: Date.now(), n: nonce, from: 'me' });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { channelId: chId, data: text }); return true;
        }
        if (ch.ratchetKey) {
            const packed = await packBlob(JSON.stringify({ d: text, t: Date.now(), n: nonce }), ch);
            await this._post('/beacon', { keyHash: 'msg_' + chId, packet: packed });
            ch.blobs.push({ d: text, t: Date.now(), n: nonce, from: 'me' });
            ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesSent++;
            this._emit('message-sent', { channelId: chId, data: text }); return true;
        }
        return false;
    },

    async _handleIn(blobData, chId) {
        let d; try { d = JSON.parse(blobData); } catch(e) { return; }
        log('_handleIn', d.type || 'unknown');
        const me = this;
        if (d.type && d.type.startsWith('webrtc-')) { this._handleWSig(chId || Object.keys(this._channels)[0], d); return; }
        if (d.type === 'verification-emoji' && d.emoji) { this._verificationEmoji = d.emoji; if (!this._pendingVerification && d.pubKey && d.inner) { this._pendingVerification = { bd: { pubKey: d.pubKey, inner: d.inner, peerId: d.peerId }, targetPeerId: d.peerId, emoji: d.emoji }; } this._emit('verification-received', { emoji: d.emoji }); return; }
        if (d.type === 'verification-ack') { this._emit('verification-acked', {}); this.startPolling('waiting_' + this._peerId); return; }
        if (d.type === 'beacon-response' && d.pubKey && d.inner) {
            const keys = Object.keys(this._beacons);
            for (let i = 0; i < keys.length; i++) { const b = this._beacons[keys[i]]; if (!b.keyPair) continue;
                const rpk = await importPublicKey(d.pubKey); const ss = await deriveSecret(b.keyPair, rpk); const nid = d.channelId || RND();
                if (d.verificationHash) { const expectedHash = await SHA(ss + (this._verificationEmoji ? this._verificationEmoji.join('') : '')); if (d.verificationHash !== expectedHash) { log('_handleIn', 'HASH MISMATCH'); return; } }
                this._channels[nid] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: d.peerId, type: 'cup', blobs: [], expires: Date.now() + CONFIG.CHANNEL_TTL, createdAt: Date.now(), verificationHash: d.verificationHash };
                delete this._beacons[keys[i]]; this._stopPolling(); this._stats.channelsOpened++;
                this._emit('channel-opened', { channelId: nid, peerId: d.peerId, nick: 'Лучник', avatar: '001' }); this._startMsgPoll(nid); this.startWebRTC(nid, false); return;
            }
        }
        const ch = this._channels[chId];
        if (ch && ch.ratchetKey) {
            const u = await unpackBlob(blobData, ch);
            if (u) {
                const dedupKey = chId + '_' + (u.n || u._t || '');
                if (this._dedupTimers[dedupKey]) return;
                this._dedupTimers[dedupKey] = setTimeout(function() { delete me._dedupTimers[dedupKey]; }, CONFIG.CHANNEL_TTL);
                ch.blobs.push({ d: u.d || u.text || '', t: u._t || Date.now(), n: u.n || '', from: 'them' });
                ch.expires = Date.now() + CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                this._emit('message-received', { channelId: chId, text: u.d || u.text || '', from: 'them', timestamp: u._t || Date.now() });
            }
        }
    },

    getStats() { return { peerId: this._peerId, state: this._state, channels: Object.keys(this._channels).length, messagesSent: this._stats.messagesSent, messagesReceived: this._stats.messagesReceived, peersConnected: this._stats.peersConnected, channelsOpened: this._stats.channelsOpened }; },
    clearData() { try { localStorage.removeItem('p2ppong_state'); localStorage.removeItem('p2ppong_channels'); } catch(e) {} },
    async destroy() { this._stopPolling(); Object.keys(this._msgPollTimers).forEach(function(id) { clearTimeout(this._msgPollTimers[id]); }); this._msgPollTimers = {}; Object.keys(this._webRTCPolling).forEach(function(id) { clearTimeout(this._webRTCPolling[id]); }); this._webRTCPolling = {}; Object.keys(this._webRTC).forEach(function(id) { try { this._webRTC[id].pc.close(); } catch(e) {} }); this._webRTC = {}; if (this._housekeepInterval) clearInterval(this._housekeepInterval); if (typeof RobinHoodPeerHelp !== 'undefined') RobinHoodPeerHelp.stop(); this._channels = {}; this._beacons = {}; this._listeners = {}; this._state = 'idle'; this._peerId = null; this._pendingVerification = null; this._verificationEmoji = null; this._emit('destroyed'); }
};

const RND = function() { const a = new Uint32Array(4); crypto.getRandomValues(a); return Array.from(a).map(function(x) { return x.toString(16).padStart(8, '0'); }).join(''); };
const SHA = async function(t) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(h)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); };
function xorDistance(id1, id2) { let dist = ''; for (let i = 0; i < Math.min(id1.length, id2.length); i++) dist += (parseInt(id1[i], 16) ^ parseInt(id2[i], 16)).toString(16); return BigInt('0x' + dist); }
function getBucketIndex(dist) { if (dist === 0n) return 0; return dist.toString(2).length - 1; }
function initBuckets() { DHT._buckets = Array.from({ length: 256 }, function() { return []; }); }
function addPeer(peerId, conn) { const dist = xorDistance(DHT._nodeId, peerId); const idx = Math.min(getBucketIndex(dist), 255); const bucket = DHT._buckets[idx]; const existing = bucket.findIndex(function(p) { return p.id === peerId; }); if (existing >= 0) bucket.splice(existing, 1); bucket.unshift({ id: peerId, conn, lastSeen: Date.now() }); if (bucket.length > DHT._k) bucket.pop(); DHT._peers.set(peerId, { conn, lastSeen: Date.now() }); }
function getClosestPeers(targetId, count) { count = count || DHT._k; const all = []; DHT._buckets.forEach(function(bucket) { bucket.forEach(function(peer) { all.push({ id: peer.id, conn: peer.conn, lastSeen: peer.lastSeen, distance: xorDistance(targetId, peer.id) }); }); }); all.sort(function(a, b) { return a.distance < b.distance ? -1 : 1; }); return all.slice(0, count); }
async function sendToPeer(peerId, message) { const peer = DHT._peers.get(peerId); if (!peer || !peer.conn || peer.conn.readyState !== 'open') return; try { peer.conn.send(JSON.stringify(message)); } catch(e) {} }
async function generateKeyPair() { return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); }
async function exportPublicKey(kp) { const r = await crypto.subtle.exportKey('raw', kp.publicKey); return btoa(String.fromCharCode.apply(null, new Uint8Array(r))); }
async function importPublicKey(b64) { const r = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); }); return await crypto.subtle.importKey('raw', r, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
async function deriveSecret(kp, remotePubKey) { const b = await crypto.subtle.deriveBits({ name: 'ECDH', public: remotePubKey }, kp.privateKey, 256); return Array.from(new Uint8Array(b)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); }
async function encryptAES(text, secret) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['encrypt']); const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text)); const c = new Uint8Array(iv.length + new Uint8Array(ct).length); c.set(iv); c.set(new Uint8Array(ct), iv.length); return btoa(String.fromCharCode.apply(null, c)); }
async function decryptAES(enc, secret) { try { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['decrypt']); const c = Uint8Array.from(atob(enc), function(x) { return x.charCodeAt(0); }); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, k, c.slice(12))); } catch(e) { return null; } }
async function computeHMAC(data, secret) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return btoa(String.fromCharCode.apply(null, new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))))); }
async function verifyHMAC(data, sig, secret) { try { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); return await crypto.subtle.verify('HMAC', k, Uint8Array.from(atob(sig), function(c) { return c.charCodeAt(0); }), new TextEncoder().encode(data)); } catch(e) { return false; } }
async function advanceRatchet(ch) { const oldKey = ch.ratchetKey || ch.secret; const salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0'); const newKey = await SHA(oldKey + salt); ch.ratchetKey = newKey; ch.ratchetIndex = (ch.ratchetIndex || 0) + 1; if (!ch.oldKeys) ch.oldKeys = []; ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: oldKey }); if (ch.oldKeys.length > CONFIG.MAX_OLD_KEYS) ch.oldKeys.shift(); return newKey; }
async function packBlob(jsonString, ch) { const compressed = await compressData(jsonString); const padSize = Math.floor(Math.random() * 50) + 20; const randomPad = btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(padSize)))); const data = JSON.stringify({ z: compressed, t: Date.now(), n: RND(), pad: randomPad, ri: ch.ratchetIndex || 0 }); const currentKey = ch.ratchetKey || ch.secret; const hmac = await computeHMAC(data, currentKey); let padded = hmac + '|' + data; if (padded.length < CONFIG.BLOB_SIZE) { const pad = crypto.getRandomValues(new Uint8Array(CONFIG.BLOB_SIZE - padded.length)); padded += String.fromCharCode.apply(null, pad); } await advanceRatchet(ch); return await encryptAES(padded, ch.secret); }
async function unpackBlob(blob, ch) { const dec = await decryptAES(blob, ch.secret); if (!dec) return null; let result = await tryDecryptWithKey(dec, ch.ratchetKey || ch.secret); if (result) return result; if (ch.oldKeys) { for (let i = ch.oldKeys.length - 1; i >= 0; i--) { result = await tryDecryptWithKey(dec, ch.oldKeys[i].key); if (result) return result; } } return null; }
async function tryDecryptWithKey(decrypted, key) { const separatorIndex = decrypted.indexOf('|'); if (separatorIndex === -1) return null; const hmac = decrypted.substring(0, separatorIndex); const data = decrypted.substring(separatorIndex + 1).trim().replace(/\x00+$/, ''); if (!await verifyHMAC(data, hmac, key)) return null; try { const parsed = JSON.parse(data); if (parsed.z) { const inner = JSON.parse(await decompressData(parsed.z)); inner._t = parsed.t; inner._ri = parsed.ri; return inner; } delete parsed.pad; delete parsed.ri; return parsed; } catch(e) { return null; } }
async function compressData(str) { try { const cs = new CompressionStream('gzip'); const writer = cs.writable.getWriter(); writer.write(new TextEncoder().encode(str)); writer.close(); const reader = cs.readable.getReader(); const chunks = []; while (true) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); } const total = new Uint8Array(chunks.reduce(function(s, c) { return s + c.length; }, 0)); let offset = 0; chunks.forEach(function(chunk) { total.set(chunk, offset); offset += chunk.length; }); return btoa(String.fromCharCode.apply(null, total)); } catch(e) { return btoa(str); } }
async function decompressData(b64) { try { const bytes = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); }); const ds = new DecompressionStream('gzip'); const writer = ds.writable.getWriter(); writer.write(bytes); writer.close(); const reader = ds.readable.getReader(); const chunks = []; while (true) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); } const total = new Uint8Array(chunks.reduce(function(s, c) { return s + c.length; }, 0)); let offset = 0; chunks.forEach(function(chunk) { total.set(chunk, offset); offset += chunk.length; }); return new TextDecoder().decode(total); } catch(e) { return atob(b64); } }
let lastResyncTime = {}, resyncInProgress = {};
async function requestRatchetResync(ch) { const chId = Object.keys(P2PPong._channels).find(function(id) { return P2PPong._channels[id] === ch; }); if (!chId) return; const now = Date.now(); if (lastResyncTime[chId] && now - lastResyncTime[chId] < 60000) return; if (resyncInProgress[chId]) return; resyncInProgress[chId] = true; lastResyncTime[chId] = now; try { const kp = await generateKeyPair(); P2PPong._post('/beacon', { keyHash: 'msg_' + chId, packet: await encryptAES(JSON.stringify({ type: 'ratchet-resync', pubKey: await exportPublicKey(kp), peerId: P2PPong._peerId }), ch.secret) }); } catch(e) {} finally { resyncInProgress[chId] = false; } }

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
