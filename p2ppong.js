// ===================================================================
// P2PPong v1.0 — Рабочий
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
        this._state = 'connecting'; this._emit('state-change', { state: 'connecting' }); log('init', 'start');
        try {
            DHT._nodeId = this._peerId || RND(); initBuckets();
            const dhtRaw = await decryptFromStorage('p2ppong_dht');
            if (dhtRaw) { try { JSON.parse(dhtRaw).forEach(p => DHT._peers.set(p.id, { conn: null, lastSeen: p.lastSeen })); } catch(e) {} }
            const raw = await decryptFromStorage('p2ppong_channels');
            if (raw) { try { JSON.parse(raw).forEach(ch => { if (Date.now() < ch.expires) this._channels[ch.id] = { ...ch, blobs: [], secret: null, reconnect: true }; }); } catch(e) {} }
            if (typeof RobinHoodPeerHelp !== 'undefined') { RobinHoodPeerHelp.start(this._peerId); this._peerHelpActive = true; }
            this._connectSignal(); this._startHousekeeping(); this._setupLifecycle();
            const restored = await this.restoreState();
            if (restored) { this._resumeAfterRestore(); }
            this._state = 'online';
            this._emit('state-change', { state: 'online' }); this._emit('ready', { peerId: this._peerId, channels: Object.keys(this._channels).length });
            log('init', 'done');
        } catch(e) { this._state = 'offline'; this._emit('error', { message: e.message }); log('init error', e); }
    },

    async saveState() { const s = { p: this._peerId, c: Object.keys(this._channels), e: this._verificationEmoji, v: this._verificationConfirmed, pv: this._pendingVerification, pw: Array.from(this._pendingWebRTC.entries()), b: Object.keys(this._beacons), t: Date.now() }; try { localStorage.setItem('p2ppong_state', JSON.stringify(s)); } catch(e) {} },
    async restoreState() { if (Object.keys(this._channels).length > 0) return false; try { const r = localStorage.getItem('p2ppong_state'); if (!r) return false; const s = JSON.parse(r); if (Date.now() - s.t > 300000) return false; this._peerId = s.p; this._verificationEmoji = s.e; this._verificationConfirmed = s.v; this._pendingVerification = s.pv; this._pendingWebRTC = new Map(s.pw || []); for (const id of s.c) { const ch = await decryptFromStorage('p2ppong_channel_' + id); if (ch && JSON.parse(ch).expires > Date.now()) this._channels[id] = JSON.parse(ch); } return true; } catch(e) { return false; } },
    _setupLifecycle() { document.addEventListener('visibilitychange', () => { if (document.hidden) { this.saveState(); } else { this.restoreState(); this._resumeAfterRestore(); } }); },
    async _resumeAfterRestore() { for (const [id, ch] of Object.entries(this._channels)) { if (ch.expires > Date.now() && !this._webRTC[id]) this.startWebRTC(id, false); } if (this._pendingVerification && this._verificationEmoji) this._emit('verification-received', { emoji: this._verificationEmoji }); for (const id of Object.keys(this._beacons)) { if (this._beacons[id].expires > Date.now()) this.startPolling('waiting_' + this._peerId); } },

    _genEmoji() { const p = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😇','🤠','🫡','🤔','😏','😤','🥺','😱','💀','👽','🤖']; return [...Array(5)].map(() => p[Math.floor(Math.random()*p.length)]); },

    async craftArrow() {
        if (this._crafting) return this._peerId;
        if (this._peerId) return this._peerId;
        this._crafting = true;
        try {
            this._peerId = await generateHardwarePeerId();
            this._emit('peer-id-generated', { peerId: this._peerId });
            const kp = await generateKeyPair(); const pk = await exportPublicKey(kp); const nonce = RND(); const bid = RND();
            const correctEmoji = this._genEmoji();
            this._verificationEmoji = correctEmoji;
            const bk = await SHA('beacon');
            const inner = await encryptAES(JSON.stringify({ nonce, timestamp: Date.now(), peerId: this._peerId, emoji: correctEmoji }), bk);
            const bd = { type: 'beacon', pubKey: pk, peerId: this._peerId, inner, targetPeerId: this._peerId, nick: '', avatar: '' };
            bd.sig = await computeHMAC(JSON.stringify(bd), bk);
            this._beacons[bid] = { keyPair: kp, pubKey: pk, nonce, beaconKey: bk, expires: Date.now() + 300000 };
            const result = await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify(bd) });
            if (result) {
                log('craftArrow', 'OK');
            } else {
                this._emit('error', { message: 'Не удалось опубликовать маяк' });
            }
            this.saveState();
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
        if (!this._peerId) this._peerId = await generateHardwarePeerId();
        
        const decrypted = await decryptAES(bd.inner, await SHA('beacon'));
        if (!decrypted) return false;
        let innerData;
        try { innerData = JSON.parse(decrypted); } catch(e) { return false; }
        
        const correctEmoji = innerData.emoji || [];
        this._verificationEmoji = correctEmoji;
        this._pendingVerification = { bd, targetPeerId, emoji: correctEmoji };
        
        const bid = RND();
        this._beacons[bid] = {
            keyPair: await generateKeyPair(),
            pubKey: bd.pubKey,
            nonce: innerData.nonce || '',
            beaconKey: await SHA('beacon'),
            expires: Date.now() + 300000
        };
        
        this._emit('verification-needed', { emoji: correctEmoji });
        this.saveState();
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
        this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash };
        await this._post('/beacon', { keyHash: 'ack_' + targetPeerId, packet: JSON.stringify({ type: 'verification-ack', peerId: this._peerId, verificationHash }) });
        const ok = await this._post('/beacon', { keyHash: 'waiting_' + targetPeerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: this._peerId, inner: bd.inner, channelId: chId, verificationHash, nick: '', avatar: '' }) });
        if (!ok) return false;
        this._stopPolling(); this._stats.channelsOpened++; await this._saveCh();
        this._emit('channel-opened', { channelId: chId, peerId: bd.peerId, nick: 'Лучник', avatar: '001' });
        this._startMsgPoll(chId); this._verificationEmoji = null; this._verificationConfirmed = true;
        this.startWebRTC(chId, true);
        try { localStorage.removeItem('p2ppong_state'); } catch(e) {} this.saveState(); return true;
    },
    getVerificationEmoji() { return this._verificationEmoji; },

    async _post(path, body) { if (body.packet === '') { for (const s of this._signalServers) { try { const r = await fetch(s.url + '/delete?key=' + body.keyHash, { signal: AbortSignal.timeout(5000) }); if (r.ok) return { status: 'deleted' }; } catch(e) {} } return null; } for (const s of this._signalServers) { try { const r = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }); if (r.ok) return r.json(); } catch(e) {} } return null; },
    async _get(path) { for (const s of this._signalServers) { try { const r = await fetch(s.url + path, { signal: AbortSignal.timeout(5000) }); if (r.ok) return r.json(); } catch(e) {} } return null; },

    startPolling(keyHash, fastMode) {
        if (!keyHash) return;
        this._stopPolling();
        this._pollKey = keyHash;
        this._pollStart = Date.now();
        this._doPoll();
    },
    _doPoll() {
        if (!this._pollKey) return;
        var me = this;
        var el = (Date.now() - me._pollStart) / 1000;
        if (el > me._pollMax) { me._stopPolling(); me._emit('beacon-timeout'); return; }
        me._get('/beacon?key=' + me._pollKey).then(function(d) {
            if (d && d.status === 'found' && d.packet) {
                me._stopPolling();
                me._handleIn(d.packet, BLOB_NS);
            } else {
                me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000);
            }
        }).catch(function() {
            me._pollTimer = setTimeout(function() { me._doPoll(); }, 1000);
        });
    },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; } },

    _startMsgPoll(chId) { if (this._msgPollTimers[chId]) return; var me = this; function poll() { if (!me._channels[chId]) { me._stopMsgPoll(chId); return; } me._get('/beacon?key=msg_' + chId).then(function(d) { if (d && d.packet) { me._handleIn(d.packet, chId); } me._msgPollTimers[chId] = setTimeout(poll, 5000); }).catch(function() { me._msgPollTimers[chId] = setTimeout(poll, 5000); }); } poll(); },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; } },

    async startWebRTC(chId, asInitiator) {
        var ch = this._channels[chId];
        if (!ch || this._webRTC[chId]) return;
        var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this._webRTC[chId] = { pc: pc, dc: null, iceBuffer: [], connected: false, initiator: asInitiator, seenMessages: new Set() };
        var me = this;
        if (asInitiator) {
            var dc = pc.createDataChannel('chat');
            me._webRTC[chId].dc = dc;
            dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); };
            dc.onmessage = function(e) { var m; try { m = JSON.parse(e.data); } catch(er) { return; } if (m.type === 'message' && !me._webRTC[chId].seenMessages.has(m.nonce)) { me._webRTC[chId].seenMessages.add(m.nonce); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + 600000; me._stats.messagesReceived++; me._saveCh(); me._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } };
        } else {
            pc.ondatachannel = function(e) {
                var dc = e.channel; me._webRTC[chId].dc = dc;
                dc.onopen = function() { me._webRTC[chId].connected = true; me._stats.peersConnected++; me._emit('peer-connected', { channelId: chId }); me._stopWebRTCPoll(chId); };
                dc.onmessage = function(ev) { var m; try { m = JSON.parse(ev.data); } catch(er) { return; } if (m.type === 'message' && !me._webRTC[chId].seenMessages.has(m.nonce)) { me._webRTC[chId].seenMessages.add(m.nonce); ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + 600000; me._stats.messagesReceived++; me._saveCh(); me._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } };
            };
        }
        pc.onicecandidate = function(e) { if (e.candidate) me._webRTC[chId].iceBuffer.push(e.candidate); else me._flushICE(chId); };
        if (asInitiator && !me._webRTC[chId].offerSent) {
            var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
            me._webRTC[chId].offerSent = true;
            me._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) });
        }
        this._startWebRTCPoll(chId);
    },

    _startWebRTCPoll(chId) { if (this._webRTCPolling[chId]) return; var me = this; function poll() { if (!me._webRTC[chId] || me._webRTC[chId].connected) { me._stopWebRTCPoll(chId); return; } me._get('/beacon?key=webrtc_' + chId).then(function(d) { if (d && d.packet) me._handleWSig(chId, JSON.parse(d.packet)); me._webRTCPolling[chId] = setTimeout(poll, 3000); }).catch(function() { me._webRTCPolling[chId] = setTimeout(poll, 3000); }); } poll(); },
    _stopWebRTCPoll(chId) { if (this._webRTCPolling[chId]) { clearTimeout(this._webRTCPolling[chId]); delete this._webRTCPolling[chId]; } },

    async _handleWSig(chId, sig) {
        var rtc = this._webRTC[chId];
        if (!rtc || !rtc.pc || rtc.connected) return;
        var pc = rtc.pc;
        try {
            if (sig.type === 'webrtc-ice') { var c = JSON.parse(sig.sdp); if (pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}); else rtc.iceBuffer.push(c); return; }
            if (sig.type === 'webrtc-offer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(function(c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}) }); rtc.iceBuffer = []; if (!rtc.initiator) { var a = await pc.createAnswer(); await pc.setLocalDescription(a); this._sendWSig(chId, { type: 'webrtc-answer', sdp: JSON.stringify(pc.localDescription) }); } return; }
            if (sig.type === 'webrtc-answer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(function(c) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(){}) }); rtc.iceBuffer = []; }
        } catch(e) {}
    },
    _sendWSig(chId, data) { this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); },
    _flushICE(chId) { var rtc = this._webRTC[chId]; if (!rtc) return; var me = this; rtc.iceBuffer.forEach(function(c) { me._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) }); }); rtc.iceBuffer = []; },

    _connectSignal() { this._state = 'online'; this._emit('state-change', { state: 'online' }); },
    _startHousekeeping() { var me = this; this._housekeepInterval = setInterval(function() { var now = Date.now(); Object.keys(me._channels).forEach(function(id) { if (now > me._channels[id].expires) { delete me._channels[id]; delete me._webRTC[id]; me._stopMsgPoll(id); me._stopWebRTCPoll(id); me._emit('channel-expired', { channelId: id }); } }); Object.keys(me._beacons).forEach(function(id) { if (now > me._beacons[id].expires) delete me._beacons[id]; }); if (me._peerId) { me._get('/beacon?key=emoji_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(){}); me._get('/beacon?key=ack_' + me._peerId).then(function(d) { if (d && d.packet) me._handleIn(d.packet, null); }).catch(function(){}); } me._saveCh(); }, 5000); },

    async sendMessage(chId, data) { var ch = this._channels[chId]; if (!ch) return false; var nonce = RND(); var rtc = this._webRTC[chId]; if (rtc && rtc.dc && rtc.dc.readyState === 'open') { rtc.dc.send(JSON.stringify({ type: 'message', text: data, time: Date.now(), nonce: nonce })); ch.blobs.push({ d: data, t: Date.now(), n: nonce, from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; await this._saveCh(); this._emit('message-sent', { channelId: chId, data: data }); return true; } if (!ch.ratchetKey) return false; var packed = await packBlob(JSON.stringify({ d: data, t: Date.now(), n: nonce }), ch); await this._post('/beacon', { keyHash: 'msg_' + chId, packet: packed }); ch.blobs.push({ d: data, t: Date.now(), n: nonce, from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; await this._saveCh(); this._emit('message-sent', { channelId: chId, data: data }); return true; },

    async _handleIn(blobData, chId) {
        var d;
        try { d = JSON.parse(blobData); } catch(e) { return; }
        log('_handleIn', d.type || 'unknown');
        var me = this;

        if (d.type && d.type.startsWith('webrtc-')) { this._handleWSig(chId || Object.keys(this._channels)[0], d); return; }

        if (d.type === 'verification-emoji' && d.emoji) {
            this._verificationEmoji = d.emoji;
            if (!this._pendingVerification && d.pubKey && d.inner) {
                this._pendingVerification = { bd: { pubKey: d.pubKey, inner: d.inner, peerId: d.peerId }, targetPeerId: d.peerId, emoji: d.emoji };
            }
            this._emit('verification-received', { emoji: d.emoji });
            return;
        }

        if (d.type === 'verification-ack') {
            this._verificationConfirmed = true;
            this._emit('verification-acked', {});
            this.startPolling('waiting_' + this._peerId);
            return;
        }

        if (d.type === 'beacon' && d.pubKey && d.inner) {
            if (d.peerId === this._peerId) return;
            var correctEmoji = [];
            try {
                var decrypted = await decryptAES(d.inner, await SHA('beacon'));
                if (decrypted) {
                    var innerData = JSON.parse(decrypted);
                    correctEmoji = innerData.emoji || [];
                }
            } catch(e) {}
            this._verificationEmoji = correctEmoji;
            this._emit('beacon-received', {
                peerId: d.peerId,
                correctEmoji: correctEmoji,
                accept: async function(userEmojiInput) {
                    if (JSON.stringify(userEmojiInput) !== JSON.stringify(correctEmoji)) {
                        me._emit('error', { message: 'Неверный порядок смайлов' });
                        return;
                    }
                    var rpk = await importPublicKey(d.pubKey);
                    var kp = await generateKeyPair();
                    var mpk = await exportPublicKey(kp);
                    var ss = await deriveSecret(kp, rpk);
                    var nid = RND();
                    var verificationHash = await SHA(ss + userEmojiInput.join(''));
                    me._channels[nid] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: d.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash: verificationHash };
                    var ep = JSON.stringify({ type: 'verification-emoji', emoji: userEmojiInput, peerId: me._peerId, pubKey: d.pubKey, inner: d.inner });
                    await me._post('/beacon', { keyHash: 'emoji_' + d.peerId, packet: ep });
                    await me._post('/beacon', { keyHash: 'ack_' + d.peerId, packet: JSON.stringify({ type: 'verification-ack', peerId: me._peerId, verificationHash: verificationHash }) });
                    await me._post('/beacon', { keyHash: 'waiting_' + me._peerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: me._peerId, inner: d.inner, channelId: nid, verificationHash: verificationHash }) });
                    me._stats.channelsOpened++; await me._saveCh();
                    me._emit('channel-opened', { channelId: nid, peerId: d.peerId, nick: 'Лучник', avatar: '001' });
                    me._startMsgPoll(nid); me.startWebRTC(nid, true);
                }
            });
            return;
        }

        if (d.type === 'beacon-response' && d.pubKey && d.inner) {
            var keys = Object.keys(this._beacons);
            for (var i = 0; i < keys.length; i++) {
                var b = this._beacons[keys[i]];
                if (!b.beaconKey) continue;
                var dec = await decryptAES(d.inner, await SHA('beacon'));
                if (!dec) continue;
                var rpk = await importPublicKey(d.pubKey);
                var ss = await deriveSecret(b.keyPair, rpk);
                var nid = d.channelId || RND();
                if (d.verificationHash) {
                    var expectedHash = await SHA(ss + (this._verificationEmoji ? this._verificationEmoji.join('') : ''));
                    if (d.verificationHash !== expectedHash) {
                        log('_handleIn', 'HASH MISMATCH');
                        return;
                    }
                }
                this._channels[nid] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: d.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now(), verificationHash: d.verificationHash };
                delete this._beacons[keys[i]];
                this._stopPolling();
                this._stats.channelsOpened++;
                await this._saveCh();
                this._emit('channel-opened', { channelId: nid, peerId: d.peerId, nick: 'Лучник', avatar: '001' });
                this._startMsgPoll(nid);
                this.startWebRTC(nid, false);
                return;
            }
        }

        var ch = this._channels[chId];
        if (ch && ch.ratchetKey) {
            var u = await unpackBlob(blobData, ch);
            if (u) {
                var dedupKey = chId + '_' + (u.n || u._t || '');
                if (this._dedupTimers[dedupKey]) return;
                this._dedupTimers[dedupKey] = setTimeout(function() { delete me._dedupTimers[dedupKey]; }, 300000);
                ch.blobs.push({ d: u.d || u.text || '', t: u._t || Date.now(), n: u.n || '', from: 'them' });
                ch.expires = Date.now() + 600000;
                this._stats.messagesReceived++;
                await this._saveCh();
                this._emit('message-received', { channelId: chId, text: u.d || u.text || '', from: 'them', timestamp: u._t || Date.now() });
            }
        }
    },

    async _saveCh() { var arr = []; var me = this; Object.keys(this._channels).forEach(function(id) { var ch = me._channels[id]; arr.push({ id: id, peerId: ch.peerId, type: ch.type, expires: ch.expires, createdAt: ch.createdAt }); }); await encryptToStorage('p2ppong_channels', JSON.stringify(arr)); },
    getStats() { return { peerId: this._peerId, state: this._state, channels: Object.keys(this._channels).length, dhtPeers: DHT._peers.size, messagesSent: this._stats.messagesSent, messagesReceived: this._stats.messagesReceived, peersConnected: this._stats.peersConnected, channelsOpened: this._stats.channelsOpened }; },
    async destroy() { this._stopPolling(); Object.keys(this._msgPollTimers).forEach(function(id) { clearTimeout(this._msgPollTimers[id]); }); this._msgPollTimers = {}; Object.keys(this._webRTCPolling).forEach(function(id) { clearTimeout(this._webRTCPolling[id]); }); this._webRTCPolling = {}; Object.keys(this._dedupTimers).forEach(function(id) { clearTimeout(this._dedupTimers[id]); }); this._dedupTimers = {}; Object.keys(this._webRTC).forEach(function(id) { try { this._webRTC[id].pc.close(); } catch(e) {} }); this._webRTC = {}; if (this._housekeepInterval) clearInterval(this._housekeepInterval); if (this._peerHelpActive && typeof RobinHoodPeerHelp !== 'undefined') RobinHoodPeerHelp.stop(); this._channels = {}; this._beacons = {}; this._listeners = {}; this._state = 'idle'; this._peerId = null; this._pendingVerification = null; this._verificationEmoji = null; this._verificationConfirmed = false; this._pendingWebRTC.clear(); try { localStorage.removeItem('p2ppong_state'); } catch(e) {} await this._saveCh(); this._emit('destroyed'); }
};

const RND = function() { var a = new Uint32Array(4); crypto.getRandomValues(a); return Array.from(a).map(function(x) { return x.toString(16).padStart(8, '0'); }).join(''); };
const SHA = async function(t) { var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(h)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(''); };
function xorDistance(id1, id2) { var dist = ''; for (var i = 0; i < Math.min(id1.length, id2.length); i++) dist += (parseInt(id1[i], 16) ^ parseInt(id2[i], 16)).toString(16); return BigInt('0x' + dist); }
function getBucketIndex(dist) { if (dist === 0n) return 0; return dist.toString(2).length - 1; }
function initBuckets() { DHT._buckets = Array.from({ length: 256 }, function() { return []; }); }
function addPeer(peerId, conn) { var dist = xorDistance(DHT._nodeId, peerId); var idx = Math.min(getBucketIndex(dist), 255); var bucket = DHT._buckets[idx]; var existing = bucket.findIndex(function(p) { return p.id === peerId; }); if (existing >= 0) bucket.splice(existing, 1); bucket.unshift({ id: peerId, conn: conn, lastSeen: Date.now() }); if (bucket.length > DHT._k) bucket.pop(); DHT._peers.set(peerId, { conn: conn, lastSeen: Date.now() }); }
function getClosestPeers(targetId, count) { count = count || DHT._k; var all = []; DHT._buckets.forEach(function(bucket) { bucket.forEach(function(peer) { all.push({ id: peer.id, conn: peer.conn, lastSeen: peer.lastSeen, distance: xorDistance(targetId, peer.id) }); }); }); all.sort(function(a, b) { return a.distance < b.distance ? -1 : 1; }); return all.slice(0, count); }
async function sendToPeer(peerId, message) { var peer = DHT._peers.get(peerId); if (!peer || !peer.conn || peer.conn.readyState !== 'open') return; try { peer.conn.send(JSON.stringify(message)); } catch(e) {} }
async function deriveStorageKey() { try { var salt = localStorage.getItem('pp4_hw_salt') || RND(); if (!localStorage.getItem('pp4_hw_salt')) localStorage.setItem('pp4_hw_salt', salt); var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'PBKDF2' }, false, ['deriveKey']); return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('p2ppong_storage'), iterations: 100000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); } catch(e) { return null; } }
async function encryptToStorage(key, value) { try { var k = await deriveStorageKey(); if (!k) { localStorage.setItem(key, value); return; } var iv = crypto.getRandomValues(new Uint8Array(12)); var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(value)); var c = new Uint8Array(iv.length + new Uint8Array(ct).length); c.set(iv); c.set(new Uint8Array(ct), iv.length); localStorage.setItem(key, btoa(String.fromCharCode.apply(null, c))); } catch(e) { localStorage.setItem(key, value); } }
async function decryptFromStorage(key) { try { var raw = localStorage.getItem(key); if (!raw) return null; if (raw.startsWith('{') || raw.startsWith('[')) return raw; var k = await deriveStorageKey(); if (!k) return raw; var bytes = Uint8Array.from(atob(raw), function(c) { return c.charCodeAt(0); }); var iv = bytes.slice(0, 12); var ct = bytes.slice(12); var decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, k, ct); return new TextDecoder().decode(decrypted); } catch(e) { return localStorage.getItem(key); } }
async function generateHardwarePeerId() { var p = []; try { var c = document.createElement('canvas'); var gl = c.getContext('webgl'); var ext = gl.getExtension('WEBGL_debug_renderer_info'); if (ext) { p.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)); p.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)); } } catch(e) {} try { var ctx = new AudioContext(); p.push(ctx.sampleRate.toString()); p.push(ctx.destination.maxChannelCount.toString()); ctx.close(); } catch(e) {} p.push(screen.width + 'x' + screen.height, screen.colorDepth.toString(), navigator.hardwareConcurrency || '', navigator.deviceMemory || ''); var s = localStorage.getItem('pp4_hw_salt'); if (!s) { s = RND(); localStorage.setItem('pp4_hw_salt', s); } p.push(s); var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.join('|'))); return Array.from(new Uint8Array(h)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('').substring(0, 32); }
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
