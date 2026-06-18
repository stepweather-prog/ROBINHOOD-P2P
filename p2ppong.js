// ===================================================================
// P2PPong —  Nonce, ECDH, верификация.
// ===================================================================

const DEBUG = true;
function log(msg, data) { if (DEBUG) console.log(`[P2PPong] ${msg}`, data || ''); }

const DHT = { _nodeId: null, _buckets: [], _storage: {}, _k: 20, _alpha: 3, _peers: new Map(), _signalSend: null };
const BLOB_NS = '00000000000000000000000000000000';

const P2PPong = {
    _peerId: null, _beacons: {}, _channels: {}, _ws: null,
    _signalServers: [
        { type: 'http', url: 'https://robincall.stephanclaps-491.workers.dev', name: 'Cloudflare' },
        { type: 'http', url: 'https://p2ppong-v2.onrender.com', name: 'Render' }
    ],
    _currentSignalIndex: 0, _wsReconnectDelay: 1000, _maxReconnectDelay: 30000,
    _listeners: {}, _state: 'idle',
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },
    _httpSignal: null, _peerHelpActive: false, _housekeepInterval: null,
    _pollTimer: null, _pollStart: null, _pollKey: null,
    _pollMax: 150, _pollSilence: 30000, _pollInterval: 15000, _pollFast: 5000, _pollFastStart: 135,
    _webRTC: {}, _webRTCPolling: {}, _msgPollTimers: {}, _msgReadTimers: {},
    _pendingVerification: null, _verificationEmoji: null, _verificationConfirmed: false,
    _pendingWebRTC: new Map(),
    _dedupTimers: {},
    _crafting: false,

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
        return () => { this._listeners[event] = this._listeners[event].filter(cb => cb !== callback); };
    },
    _emit(event, data) { log('emit', event); if (!this._listeners[event]) return; this._listeners[event].forEach(cb => { try { cb(data); } catch(e) {} }); },

    async init() {
        if (this._state !== 'idle') return;
        this._state = 'connecting'; this._emit('state-change', { state: 'connecting' });
        try {
            DHT._nodeId = RND(); initBuckets();
            if (typeof RobinHoodPeerHelp !== 'undefined') { RobinHoodPeerHelp.start(this._peerId); this._peerHelpActive = true; }
            this._connectSignal(); this._startHousekeeping();
            this._state = 'online';
            this._emit('state-change', { state: 'online' }); this._emit('ready', {});
        } catch(e) { this._state = 'offline'; this._emit('error', { message: e.message }); }
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
            const bk = await SHA(nonce + 'beacon');
            const inner = await encryptAES(JSON.stringify({ nonce, timestamp: Date.now(), peerId: this._peerId, emoji: correctEmoji }), bk);
            const bd = { type: 'beacon', pubKey: pk, peerId: this._peerId, inner, targetPeerId: this._peerId, nick: '', avatar: '' };
            bd.sig = await computeHMAC(JSON.stringify(bd), bk);
            this._beacons[bid] = { keyPair: kp, pubKey: pk, nonce, beaconKey: bk, expires: Date.now() + 300000 };
            await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify(bd) });
            return this._peerId;
        } finally { this._crafting = false; }
    },
    getPeerId() { return this._peerId; },

    async joinBeacon(targetPeerId) {
        if (!targetPeerId) return false;
        const d = await this._get('/beacon?key=waiting_' + targetPeerId);
        if (!d?.packet) return false;
        const bd = JSON.parse(d.packet);
        if (!bd?.pubKey || !bd?.inner) return false;
        if (!this._peerId) this._peerId = RND();
        this._pendingVerification = { bd, targetPeerId };
        this._emit('beacon-received', {
            peerId: bd.peerId,
            bd: bd,
            accept: async (userEmojiInput) => {
                const rpk = await importPublicKey(bd.pubKey);
                const kp = await generateKeyPair(); const mpk = await exportPublicKey(kp);
                const ss = await deriveSecret(kp, rpk);
                const verificationHash = await SHA(ss + userEmojiInput.join(''));
                const chId = RND();
                this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash };
                const ep = JSON.stringify({ type: 'verification-emoji', emoji: userEmojiInput, peerId: this._peerId, pubKey: bd.pubKey, inner: bd.inner });
                await this._post('/beacon', { keyHash: 'emoji_' + bd.peerId, packet: ep });
                await this._post('/beacon', { keyHash: 'ack_' + bd.peerId, packet: JSON.stringify({ type: 'verification-ack', peerId: this._peerId, verificationHash }) });
                await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: this._peerId, inner: bd.inner, channelId: chId, verificationHash }) });
                this._stats.channelsOpened++;
                this._emit('channel-opened', { channelId: chId, peerId: bd.peerId, nick: 'Лучник', avatar: '001' });
                this._startMsgPoll(chId); this.startWebRTC(chId, true);
            }
        });
        return true;
    },

    async confirmVerification() {
        if (!this._pendingVerification) return false;
        const { bd, targetPeerId } = this._pendingVerification;
        this._pendingVerification = null;
        const rpk = await importPublicKey(bd.pubKey); const kp = await generateKeyPair(); const mpk = await exportPublicKey(kp);
        const ss = await deriveSecret(kp, rpk);
        const emoji = this._verificationEmoji || [];
        const verificationHash = await SHA(ss + emoji.join(''));
        const chId = RND();
        this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash };
        await this._post('/beacon', { keyHash: 'ack_' + targetPeerId, packet: JSON.stringify({ type: 'verification-ack', peerId: this._peerId, verificationHash }) });
        await this._post('/beacon', { keyHash: 'waiting_' + targetPeerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: this._peerId, inner: bd.inner, channelId: chId, verificationHash, nick: '', avatar: '' }) });
        this._stopPolling(); this._stats.channelsOpened++;
        this._emit('channel-opened', { channelId: chId, peerId: bd.peerId, nick: 'Лучник', avatar: '001' });
        this._startMsgPoll(chId); this._verificationEmoji = null; this._verificationConfirmed = true;
        this.startWebRTC(chId, true);
        return true;
    },
    getVerificationEmoji() { return this._verificationEmoji; },

    async _post(path, body) { if (body.packet === '') { for (const s of this._signalServers) { try { const r = await fetch(s.url + '/delete?key=' + body.keyHash, { signal: AbortSignal.timeout(5000) }); if (r.ok) return { status: 'deleted' }; } catch(e) {} } return null; } for (const s of this._signalServers) { try { const r = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); if (r.ok) return r.json(); } catch(e) {} } return null; },
    async _get(path) { for (const s of this._signalServers) { try { const r = await fetch(s.url + path, { signal: AbortSignal.timeout(5000) }); if (r.ok) return r.json(); } catch(e) {} } return null; },

    startPolling(keyHash) { if (!keyHash) return; this._stopPolling(); this._pollKey = keyHash; this._pollStart = Date.now(); this._doPoll(); },
    _doPoll() { if (!this._pollKey) return; var me = this; var el = (Date.now() - me._pollStart) / 1000; if (el > me._pollMax) { me._stopPolling(); me._emit('beacon-timeout'); return; } me._get('/beacon?key=' + me._pollKey).then(function(d) { if (d && d.status === 'found' && d.packet) { me._stopPolling(); me._handleIn(d.packet, BLOB_NS); } else { me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000); } }).catch(function() { me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000); }); },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; } },

    _startMsgPoll(chId) { if (this._msgPollTimers[chId]) return; var me = this; function poll() { if (!me._channels[chId]) { me._stopMsgPoll(chId); return; } me._get('/beacon?key=msg_' + chId).then(function(d) { if (d && d.packet) { me._handleIn(d.packet, chId); } me._msgPollTimers[chId] = setTimeout(poll, 5000); }).catch(function() { me._msgPollTimers[chId] = setTimeout(poll, 5000); }); } poll(); },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; } },

    async startWebRTC(chId, asInitiator) { var ch = this._channels[chId]; if (!ch || this._webRTC[chId]) return; var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); this._webRTC[chId] = { pc: pc, dc: null, iceBuffer: [], connected: false, initiator: asInitiator, seenMessages: new Set() }; var me = this; if (asInitiator) { var dc = pc.createDataChannel('chat'); me._webRTC[chId].dc = dc; dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); }; dc.onmessage = function(e) { var m; try { m = JSON.parse(e.data); } catch(er) { return; } if (m.type === 'message' && !me._webRTC[chId].seenMessages.has(m.nonce)) { me._webRTC[chId].seenMessages.add(m.nonce); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + 600000; me._stats.messagesReceived++; me._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } }; } else { pc.ondatachannel = function(e) { var dc = e.channel; me._webRTC[chId].dc = dc; dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); }; dc.onmessage = function(ev) { var m; try { m = JSON.parse(ev.data); } catch(er) { return; } if (m.type === 'message' && !me._webRTC[chId].seenMessages.has(m.nonce)) { me._webRTC[chId].seenMessages.add(m.nonce); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + 600000; me._stats.messagesReceived++; me._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } }; }; } pc.onicecandidate = function(e) { if (e.candidate) me._webRTC[chId].iceBuffer.push(e.candidate); else me._flushICE(chId); }; if (asInitiator && !me._webRTC[chId].offerSent) { var offer = await pc.createOffer(); await pc.setLocalDescription(offer); me._webRTC[chId].offerSent = true; me._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) }); } this._startWebRTCPoll(chId); },
    _startWebRTCPoll(chId) { if (this._webRTCPolling[chId]) return; var me = this; function poll() { if (!me._webRTC[chId] || me._webRTC[chId].connected) { me._stopWebRTCPoll(chId); return; } me._get('/beacon?key=webrtc_' + chId).then(function(d) { if (d && d.packet) me._handleWSig(chId, JSON.parse(d.packet)); me._webRTCPolling[chId] = setTimeout(poll, 3000); }).catch(function() { me._webRTCPolling[chId] = setTimeout(poll, 3000); }); } poll(); },
    _stopWebRTCPoll(chId) { if (this._webRTCPolling[chId]) { clearTimeout(this._webRTCPolling[chId]); delete this._webRTCPolling[chId]; } },

    async _handleWSig(chId, sig) { var rtc = this._webRTC[chId]; if (!rtc || !rtc.pc || rtc.connected) return; var pc = rtc.pc; try { if (sig.type === 'webrtc-ice') { var c = JSON.parse(sig.sdp); if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}); else rtc.iceBuffer.push(c); return; } if (sig.type === 'webrtc-offer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(function(c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}) }); rtc.iceBuffer = []; if (!rtc.initiator) { var a = await pc.createAnswer(); await pc.setLocalDescription(a); this._sendWSig(chId, { type: 'webrtc-answer', sdp: JSON.stringify(pc.localDescription) }); } return; } if (sig.type === 'webrtc-answer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(function(c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}) }); rtc.iceBuffer = []; } } catch(e) {} },
    _sendWSig(chId, data) { this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); },
    _flushICE(chId) { var rtc = this._webRTC[chId]; if (!rtc) return; var me = this; rtc.iceBuffer.forEach(function(c) { me._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) }); }); rtc.iceBuffer = []; },

    _connectSignal() { this._state = 'online'; this._emit('state-change', { state: 'online' }); },
    _startHousekeeping() { var me = this; this._housekeepInterval = setInterval(function() { var now = Date.now(); Object.keys(me._channels).forEach(function(id) { if (now > me._channels[id].expires) { delete me._channels[id]; delete me._webRTC[id]; me._stopMsgPoll(id); me._stopWebRTCPoll(id); me._emit('channel-expired', { channelId: id }); } }); Object.keys(me._beacons).forEach(function(id) { if (now > me._beacons[id].expires) delete me._beacons[id]; }); if (me._peerId) { me._get('/beacon?key=emoji_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(){}); me._get('/beacon?key=ack_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(){}); } }, 5000); },

    async sendMessage(chId, data) { var ch = this._channels[chId]; if (!ch) return false; var nonce = RND(); var rtc = this._webRTC[chId]; if (rtc && rtc.dc && rtc.dc.readyState === 'open') { rtc.dc.send(JSON.stringify({ type: 'message', text: data, time: Date.now(), nonce: nonce })); ch.blobs.push({ d: data, t: Date.now(), n: nonce, from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; this._emit('message-sent', { channelId: chId, data: data }); return true; } if (!ch.ratchetKey) return false; var packed = await packBlob(JSON.stringify({ d: data, t: Date.now(), n: nonce }), ch); await this._post('/beacon', { keyHash: 'msg_' + chId, packet: packed }); ch.blobs.push({ d: data, t: Date.now(), n: nonce, from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; this._emit('message-sent', { channelId: chId, data: data }); return true; },

    async _handleIn(blobData, chId) {
        var d; try { d = JSON.parse(blobData); } catch(e) { return; }
        var me = this;
        if (d.type && d.type.startsWith('webrtc-')) { this._handleWSig(chId || Object.keys(this._channels)[0], d); return; }
        if (d.type === 'verification-emoji' && d.emoji) { this._verificationEmoji = d.emoji; if (!this._pendingVerification && d.pubKey && d.inner) { this._pendingVerification = { bd: { pubKey: d.pubKey, inner: d.inner, peerId: d.peerId }, targetPeerId: d.peerId, emoji: d.emoji }; } this._emit('verification-received', { emoji: d.emoji }); return; }
        if (d.type === 'verification-ack') { this._verificationConfirmed = true; this._emit('verification-acked', {}); this.startPolling('waiting_' + this._peerId); return; }
        if (d.type === 'beacon' && d.pubKey && d.inner) {
            if (d.peerId === this._peerId) return;
            this._emit('beacon-received', { peerId: d.peerId, bd: d, accept: async function(userEmojiInput) {
                if (!me._pendingVerification) return;
                const { bd } = me._pendingVerification;
                const rpk = await importPublicKey(bd.pubKey); const kp = await generateKeyPair(); const mpk = await exportPublicKey(kp);
                const ss = await deriveSecret(kp, rpk); const verificationHash = await SHA(ss + userEmojiInput.join('')); const chId = RND();
                me._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash };
                const ep = JSON.stringify({ type: 'verification-emoji', emoji: userEmojiInput, peerId: me._peerId, pubKey: bd.pubKey, inner: bd.inner });
                await me._post('/beacon', { keyHash: 'emoji_' + bd.peerId, packet: ep });
                await me._post('/beacon', { keyHash: 'ack_' + bd.peerId, packet: JSON.stringify({ type: 'verification-ack', peerId: me._peerId, verificationHash }) });
                await me._post('/beacon', { keyHash: 'waiting_' + me._peerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: me._peerId, inner: bd.inner, channelId: chId, verificationHash }) });
                me._stats.channelsOpened++; me._emit('channel-opened', { channelId: chId, peerId: bd.peerId, nick: 'Лучник', avatar: '001' }); me._startMsgPoll(chId); me.startWebRTC(chId, true);
            }});
            return;
        }
        if (d.type === 'beacon-response' && d.pubKey && d.inner) {
            var keys = Object.keys(this._beacons);
            for (var i = 0; i < keys.length; i++) { var b = this._beacons[keys[i]]; if (!b.beaconKey) continue;
                var rpk = await importPublicKey(d.pubKey); var ss = await deriveSecret(b.keyPair, rpk); var nid = d.channelId || RND();
                if (d.verificationHash) { var expectedHash = await SHA(ss + (this._verificationEmoji ? this._verificationEmoji.join('') : '')); if (d.verificationHash !== expectedHash) { log('_handleIn', 'HASH MISMATCH'); return; } }
                this._channels[nid] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: d.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash: d.verificationHash };
                delete this._beacons[keys[i]]; this._stopPolling(); this._stats.channelsOpened++;
                this._emit('channel-opened', { channelId: nid, peerId: d.peerId, nick: 'Лучник', avatar: '001' }); this._startMsgPoll(nid); this.startWebRTC(nid, false); return;
            }
        }
        var ch = this._channels[chId];
        if (ch && ch.ratchetKey) { var u = await unpackBlob(blobData, ch); if (u) { var dedupKey = chId + '_' + (u.n || u._t || ''); if (this._dedupTimers[dedupKey]) return; this._dedupTimers[dedupKey] = setTimeout(function() { delete me._dedupTimers[dedupKey]; }, 300000); ch.blobs.push({ d: u.d || u.text || '', t: u._t || Date.now(), n: u.n || '', from: 'them' }); ch.expires = Date.now() + 600000; this._stats.messagesReceived++; this._emit('message-received', { channelId: chId, text: u.d || u.text || '', from: 'them', timestamp: u._t || Date.now() }); } }
    },

    getStats() { return { peerId: this._peerId, state: this._state, channels: Object.keys(this._channels).length, dhtPeers: DHT._peers.size, messagesSent: this._stats.messagesSent, messagesReceived: this._stats.messagesReceived, peersConnected: this._stats.peersConnected, channelsOpened: this._stats.channelsOpened }; },
    async destroy() { this._stopPolling(); Object.keys(this._msgPollTimers).forEach(function(id) { clearTimeout(this._msgPollTimers[id]); }); this._msgPollTimers = {}; Object.keys(this._webRTCPolling).forEach(function(id) { clearTimeout(this._webRTCPolling[id]); }); this._webRTCPolling = {}; Object.keys(this._dedupTimers).forEach(function(id) { clearTimeout(this._dedupTimers[id]); }); this._dedupTimers = {}; Object.keys(this._webRTC).forEach(function(id) { try { this._webRTC[id].pc.close(); } catch(e) {} }); this._webRTC = {}; if (this._housekeepInterval) clearInterval(this._housekeepInterval); if (this._peerHelpActive && typeof RobinHoodPeerHelp !== 'undefined') RobinHoodPeerHelp.stop(); this._channels = {}; this._beacons = {}; this._listeners = {}; this._state = 'idle'; this._peerId = null; this._pendingVerification = null; this._verificationEmoji = null; this._verificationConfirmed = false; this._pendingWebRTC.clear(); this._emit('destroyed'); }
};

const RND = function() { var a = new Uint32Array(4); crypto.getRandomValues(a); return Array.from(a).map(function(x) { return x.toString(16).padStart(8, '0'); }).join(''); };
const SHA = async function(t) { var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(h)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); };
function xorDistance(id1, id2) { var dist = ''; for (var i = 0; i < Math.min(id1.length, id2.length); i++) dist += (parseInt(id1[i], 16) ^ parseInt(id2[i], 16)).toString(16); return BigInt('0x' + dist); }
function getBucketIndex(dist) { if (dist === 0n) return 0; return dist.toString(2).length - 1; }
function initBuckets() { DHT._buckets = Array.from({ length: 256 }, function() { return []; }); }
function addPeer(peerId, conn) { var dist = xorDistance(DHT._nodeId, peerId); var idx = Math.min(getBucketIndex(dist), 255); var bucket = DHT._buckets[idx]; var existing = bucket.findIndex(function(p) { return p.id === peerId; }); if (existing >= 0) bucket.splice(existing, 1); bucket.unshift({ id: peerId, conn: conn, lastSeen: Date.now() }); if (bucket.length > DHT._k) bucket.pop(); DHT._peers.set(peerId, { conn: conn, lastSeen: Date.now() }); }
function getClosestPeers(targetId, count) { count = count || DHT._k; var all = []; DHT._buckets.forEach(function(bucket) { bucket.forEach(function(peer) { all.push({ id: peer.id, conn: peer.conn, lastSeen: peer.lastSeen, distance: xorDistance(targetId, peer.id) }); }); }); all.sort(function(a, b) { return a.distance < b.distance ? -1 : 1; }); return all.slice(0, count); }
async function sendToPeer(peerId, message) { var peer = DHT._peers.get(peerId); if (!peer || !peer.conn || peer.conn.readyState !== 'open') return; try { peer.conn.send(JSON.stringify(message)); } catch(e) {} }
async function generateKeyPair() { return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); }
async function exportPublicKey(kp) { var r = await crypto.subtle.exportKey('raw', kp.publicKey); return btoa(String.fromCharCode.apply(null, new Uint8Array(r))); }
async function importPublicKey(b64) { var r = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); }); return await crypto.subtle.importKey('raw', r, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
async function deriveSecret(kp, remotePubKey) { var b = await crypto.subtle.deriveBits({ name: 'ECDH', public: remotePubKey }, kp.privateKey, 256); return Array.from(new Uint8Array(b)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); }
async function encryptAES(text, secret) { var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['encrypt']); var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(text)); var c = new Uint8Array(iv.length + new Uint8Array(ct).length); c.set(iv); c.set(new Uint8Array(ct), iv.length); return btoa(String.fromCharCode.apply(null, c)); }
async function decryptAES(enc, secret) { try { var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['decrypt']); var c = Uint8Array.from(atob(enc), function(x) { return x.charCodeAt(0); }); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, k, c.slice(12))); } catch(e) { return null; } }
async function computeHMAC(data, secret) { var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return btoa(String.fromCharCode.apply(null, new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))))); }
async function verifyHMAC(data, sig, secret) { try { var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); return await crypto.subtle.verify('HMAC', k, Uint8Array.from(atob(sig), function(c) { return c.charCodeAt(0); }), new TextEncoder().encode(data)); } catch(e) { return false; } }
async function advanceRatchet(ch) { var oldKey = ch.ratchetKey || ch.secret; var salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0'); var newKey = await SHA(oldKey + salt); ch.ratchetKey = newKey; ch.ratchetIndex = (ch.ratchetIndex || 0) + 1; if (!ch.oldKeys) ch.oldKeys = []; ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: oldKey }); if (ch.oldKeys.length > 50) ch.oldKeys.shift(); return newKey; }
async function packBlob(jsonString, ch) { var compressed = await compressData(jsonString); var padSize = Math.floor(Math.random() * 50) + 20; var randomPad = btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(padSize)))); var data = JSON.stringify({ z: compressed, t: Date.now(), n: RND(), pad: randomPad, ri: ch.ratchetIndex || 0 }); var currentKey = ch.ratchetKey || ch.secret; var hmac = await computeHMAC(data, currentKey); var padded = hmac + '|' + data; if (padded.length < 4096) { var pad = crypto.getRandomValues(new Uint8Array(4096 - padded.length)); padded += String.fromCharCode.apply(null, pad); } await advanceRatchet(ch); return await encryptAES(padded, ch.secret); }
async function unpackBlob(blob, ch) { var dec = await decryptAES(blob, ch.secret); if (!dec) return null; var result = await tryDecryptWithKey(dec, ch.ratchetKey || ch.secret); if (result) return result; if (ch.oldKeys) { for (var i = ch.oldKeys.length - 1; i >= 0; i--) { result = await tryDecryptWithKey(dec, ch.oldKeys[i].key); if (result) return result; } } requestRatchetResync(ch); return null; }
async function tryDecryptWithKey(decrypted, key) { var separatorIndex = decrypted.indexOf('|'); if (separatorIndex === -1) return null; var hmac = decrypted.substring(0, separatorIndex); var data = decrypted.substring(separatorIndex + 1).trim().replace(/\x00+$/, ''); if (!await verifyHMAC(data, hmac, key)) return null; try { var parsed = JSON.parse(data); if (parsed.z) { var inner = JSON.parse(await decompressData(parsed.z)); inner._t = parsed.t; inner._ri = parsed.ri; return inner; } delete parsed.pad; delete parsed.ri; return parsed; } catch(e) { return null; } }
async function compressData(str) { try { var cs = new CompressionStream('gzip'); var writer = cs.writable.getWriter(); writer.write(new TextEncoder().encode(str)); writer.close(); var reader = cs.readable.getReader(); var chunks = []; while (true) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); } var total = new Uint8Array(chunks.reduce(function(s, c) { return s + c.length; }, 0)); var offset = 0; chunks.forEach(function(chunk) { total.set(chunk, offset); offset += chunk.length; }); return btoa(String.fromCharCode.apply(null, total)); } catch(e) { return btoa(str); } }
async function decompressData(b64) { try { var bytes = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); }); var ds = new DecompressionStream('gzip'); var writer = ds.writable.getWriter(); writer.write(bytes); writer.close(); var reader = ds.readable.getReader(); var chunks = []; while (true) { var r = await reader.read(); if (r.done) break; chunks.push(r.value); } var total = new Uint8Array(chunks.reduce(function(s, c) { return s + c.length; }, 0)); var offset = 0; chunks.forEach(function(chunk) { total.set(chunk, offset); offset += chunk.length; }); return new TextDecoder().decode(total); } catch(e) { return atob(b64); } }
var lastResyncTime = {}, resyncInProgress = {};
async function requestRatchetResync(ch) { var chId = Object.keys(P2PPong._channels).find(function(id) { return P2PPong._channels[id] === ch; }); if (!chId) return; var now = Date.now(); if (lastResyncTime[chId] && now - lastResyncTime[chId] < 60000) return; if (resyncInProgress[chId]) return; resyncInProgress[chId] = true; lastResyncTime[chId] = now; try { var kp = await generateKeyPair(); P2PPong._post('/beacon', { keyHash: 'msg_' + chId, packet: await encryptAES(JSON.stringify({ type: 'ratchet-resync', pubKey: await exportPublicKey(kp), peerId: P2PPong._peerId }), ch.secret) }); } catch(e) {} finally { resyncInProgress[chId] = false; } }

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
