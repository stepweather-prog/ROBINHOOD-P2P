// ===================================================================
// P2PPong v1.0 Final — Распределённая платформа (ядро)
// Все фиксы применены
// ===================================================================

const DEBUG = true;
function log(msg, data) { if (DEBUG) console.log(`[P2PPong] ${msg}`, data || ''); }

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
            this._connectSignal(); this._startHousekeeping();
            this._state = 'online';
            this._emit('state-change', { state: 'online' }); this._emit('ready', { peerId: this._peerId, channels: Object.keys(this._channels).length });
            log('init', 'done');
        } catch(e) { this._state = 'offline'; this._emit('error', { message: e.message }); log('init error', e); }
    },

    _genEmoji() { const p = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😇','🤠','🫡','🤔','😏','😤','🥺','😱','💀','👽','🤖']; return [...Array(5)].map(() => p[Math.floor(Math.random()*p.length)]); },

    async craftArrow() {
        if (this._peerId) return this._peerId;
        this._peerId = await generateHardwarePeerId(); this._emit('peer-id-generated', { peerId: this._peerId }); log('craft', this._peerId);
        const kp = await generateKeyPair(); const pk = await exportPublicKey(kp); const nonce = RND(); const bid = RND();
        const bk = await SHA(nonce + 'beacon');
        const inner = await encryptAES(JSON.stringify({ nonce, timestamp: Date.now(), peerId: this._peerId }), bk);
        const bd = { type: 'beacon', pubKey: pk, peerId: this._peerId, inner, targetPeerId: this._peerId, nick: '', avatar: '' };
        bd.sig = await computeHMAC(JSON.stringify(bd), bk);
        this._beacons[bid] = { keyPair: kp, pubKey: pk, nonce, beaconKey: bk, expires: Date.now() + 300000 };
        const ok = await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify(bd) });
        if (!ok) log('craft POST failed');
        this.startPolling('waiting_' + this._peerId); return this._peerId;
    },

    getPeerId() { return this._peerId; },

    async joinBeacon(targetPeerId) {
        if (!targetPeerId) return false;
        log('joinBeacon', targetPeerId);
        const d = await this._get('/beacon?key=waiting_' + targetPeerId);
        if (!d?.packet) { log('joinBeacon no packet'); return false; }
        const bd = JSON.parse(d.packet);
        if (!bd?.pubKey || !bd?.inner) { log('joinBeacon invalid beacon'); return false; }
        if (!this._peerId) this._peerId = await generateHardwarePeerId();
        const emoji = this._genEmoji();
        this._verificationEmoji = emoji;
        this._pendingVerification = { bd, targetPeerId };
        const emojiPacket = JSON.stringify({ type: 'verification-emoji', emoji, peerId: this._peerId, pubKey: bd.pubKey, inner: bd.inner });
        await this._post('/beacon', { keyHash: 'emoji_' + targetPeerId, packet: emojiPacket });
        this._emit('verification-needed', { emoji }); return true;
    },

    async confirmVerification() {
        if (!this._pendingVerification) { log('confirmVerification no pending'); return false; }
        const { bd, targetPeerId } = this._pendingVerification; this._pendingVerification = null;
        log('confirmVerification', targetPeerId);
        const rpk = await importPublicKey(bd.pubKey); const kp = await generateKeyPair(); const mpk = await exportPublicKey(kp);
        const ss = await deriveSecret(kp, rpk); const chId = RND();
        this._channels[chId] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: bd.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now() };
        const ok = await this._post('/beacon', { keyHash: 'waiting_' + targetPeerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: this._peerId, inner: bd.inner, nick: '', avatar: '' }) });
        if (!ok) { log('confirmVerification POST failed'); return false; }
        this._stopPolling();
        this._stats.channelsOpened++; await this._saveCh();
        this._emit('channel-opened', { channelId: chId, peerId: bd.peerId, nick: 'Лучник', avatar: '001' });
        this._startMsgPoll(chId);
        await this._post('/beacon', { keyHash: 'ack_' + targetPeerId, packet: JSON.stringify({ type: 'verification-ack', peerId: this._peerId }) });
        this._verificationEmoji = null; this._verificationConfirmed = true;
        this._pendingWebRTC.set(chId, true);
        this.startWebRTC(chId); // ФИКС 1: Запуск WebRTC сразу
        return true;
    },

    getVerificationEmoji() { return this._verificationEmoji; },

    async _post(path, body) {
        // ФИКС 3: Если packet пустой — удаляем через /delete
        if (body.packet === '') {
            for (const s of this._signalServers) {
                try { const r = await fetch(s.url + '/delete?key=' + body.keyHash, { signal: AbortSignal.timeout(5000) }); if (r.ok) return { status: 'deleted' }; } catch(e) {}
            }
            return null;
        }
        for (const s of this._signalServers) {
            try {
                const r = await fetch(s.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
                if (r.ok) { log('_post ok', s.name); return r.json(); }
                log('_post fail', s.name + ' ' + r.status);
            } catch(e) { log('_post error', s.name + ' ' + e.message); }
        }
        return null;
    },
    async _get(path) { for (const s of this._signalServers) { try { const r = await fetch(s.url + path, { signal: AbortSignal.timeout(5000) }); if (r.ok) { const j = await r.json(); if (j.status !== 'empty') log('_get ok', s.name + ' ' + j.status); return j; } log('_get fail', s.name + ' ' + r.status); } catch(e) { log('_get error', s.name + ' ' + e.message); } } return null; },

    startPolling(keyHash) { if (!keyHash) return; this._stopPolling(); this._pollKey = keyHash; this._pollStart = Date.now(); log('startPolling', keyHash); this._pollTimer = setTimeout(() => this._doPoll(), this._pollSilence); },
    _doPoll() { if (!this._pollKey) return; const el = (Date.now() - this._pollStart) / 1000; if (el > this._pollMax) { this._stopPolling(); this._emit('beacon-timeout'); return; } let next = this._pollInterval; if (this._pollFast && this._pollFastStart && el > this._pollFastStart) next = this._pollFast;
        this._get('/beacon?key=' + this._pollKey).then(d => { if (d?.status === 'found' && d.packet) { log('_doPoll found'); this._stopPolling(); this._handleIn(d.packet, BLOB_NS); } else if (d?.status === 'taken') { log('_doPoll taken'); } this._pollTimer = setTimeout(() => this._doPoll(), next); }).catch(() => { this._pollTimer = setTimeout(() => this._doPoll(), next); }); },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer = null; log('_stopPolling'); } },

    _startMsgPoll(chId) { if (this._msgPollTimers[chId]) return; log('_startMsgPoll', chId); const poll = () => { if (!this._channels[chId]) { this._stopMsgPoll(chId); return; }
        this._get('/beacon?key=msg_' + chId).then(d => {
            if (d?.packet) {
                const msgId = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                this._handleIn(d.packet, chId);
                this._scheduleMsgDelete(chId, msgId);
            }
            this._msgPollTimers[chId] = setTimeout(poll, 5000);
        }).catch(() => { this._msgPollTimers[chId] = setTimeout(poll, 5000); }); }; poll(); },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; log('_stopMsgPoll', chId); } },
    _scheduleMsgDelete(chId, msgId) { // ФИКС 2: уникальный ключ на сообщение
        const timerKey = chId + '_' + msgId;
        if (this._msgReadTimers[timerKey]) clearTimeout(this._msgReadTimers[timerKey]);
        this._msgReadTimers[timerKey] = setTimeout(() => {
            this._post('/beacon', { keyHash: 'msg_' + chId + '_' + msgId, packet: '' });
            delete this._msgReadTimers[timerKey];
            log('msg deleted', timerKey);
        }, 60000);
    },

    async startWebRTC(chId) {
        const ch = this._channels[chId]; if (!ch || this._webRTC[chId]) return;
        log('startWebRTC', chId);
        const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        const dc = pc.createDataChannel('chat');
        this._webRTC[chId] = { pc, dc, iceBuffer: [], connected: false, offerSent: false };
        dc.onopen = () => { this._webRTC[chId].connected = true; this._stats.peersConnected++; this._emit('peer-connected', { channelId: chId }); this._stopWebRTCPoll(chId); log('WebRTC connected', chId); };
        dc.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch(er) { return; } if (m.type === 'message') { ch.blobs = ch.blobs || []; ch.blobs.push({ d: m.text, t: m.time, n: m.nonce, from: 'them' }); ch.expires = Date.now() + 600000; this._stats.messagesReceived++; this._saveCh(); this._emit('message-received', { channelId: chId, text: m.text, from: 'them', timestamp: m.time }); } };
        pc.onicecandidate = (e) => { if (e.candidate) this._webRTC[chId].iceBuffer.push(e.candidate); else this._flushICE(chId); };
        if (this._webRTC[chId].offerSent) { log('startWebRTC offer already sent, skipping'); return; }
        const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
        this._webRTC[chId].offerSent = true;
        this._sendWSig(chId, { type: 'webrtc-offer', sdp: JSON.stringify(pc.localDescription) });
        this._startWebRTCPoll(chId);
    },

    _startWebRTCPoll(chId) { if (this._webRTCPolling[chId]) return; log('_startWebRTCPoll', chId); const poll = () => { if (!this._webRTC[chId] || this._webRTC[chId].connected) { this._stopWebRTCPoll(chId); return; }
        this._get('/beacon?key=webrtc_' + chId).then(d => { if (d?.packet) this._handleWSig(chId, JSON.parse(d.packet)); this._webRTCPolling[chId] = setTimeout(poll, 3000); }).catch(() => { this._webRTCPolling[chId] = setTimeout(poll, 3000); }); }; poll(); },
    _stopWebRTCPoll(chId) { if (this._webRTCPolling[chId]) { clearTimeout(this._webRTCPolling[chId]); delete this._webRTCPolling[chId]; log('_stopWebRTCPoll', chId); } },

    async _handleWSig(chId, sig) { const rtc = this._webRTC[chId]; if (!rtc?.pc || rtc.connected) return; const { pc } = rtc; log('_handleWSig', sig.type);
        try { if (sig.type === 'webrtc-ice') { const c = JSON.parse(sig.sdp); if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(c)); else rtc.iceBuffer.push(c); return; } if (sig.type === 'webrtc-offer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{})); rtc.iceBuffer = []; const a = await pc.createAnswer(); await pc.setLocalDescription(a); this._sendWSig(chId, { type: 'webrtc-answer', sdp: JSON.stringify(pc.localDescription) }); } else if (sig.type === 'webrtc-answer') { await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))); rtc.iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{})); rtc.iceBuffer = []; } } catch(e) { log('_handleWSig error', e.message); } },
    _sendWSig(chId, data) { this._post('/beacon', { keyHash: 'webrtc_' + chId, packet: JSON.stringify(data) }); },
    _flushICE(chId) { const rtc = this._webRTC[chId]; if (!rtc) return; rtc.iceBuffer.forEach(c => this._sendWSig(chId, { type: 'webrtc-ice', sdp: JSON.stringify(c) })); rtc.iceBuffer = []; },

    _connectSignal() { this._connectHttpPolling(); },
    _connectHttpPolling() { this._state = 'online'; this._emit('state-change', { state: 'online' }); this._emit('signal-connected', {}); },

    _startHousekeeping() { this._housekeepInterval = setInterval(() => { const now = Date.now();
        for (const [id, ch] of Object.entries(this._channels)) { if (now > ch.expires) { delete this._channels[id]; delete this._webRTC[id]; this._stopMsgPoll(id); this._stopWebRTCPoll(id); this._pendingWebRTC.delete(id); this._emit('channel-expired', { channelId: id }); } }
        for (const [id, b] of Object.entries(this._beacons)) { if (now > b.expires) delete this._beacons[id]; }
        if (this._peerId) { this._get('/beacon?key=emoji_' + this._peerId).then(d => { if (d?.packet) this._handleIn(d.packet, null); }).catch(()=>{}); this._get('/beacon?key=ack_' + this._peerId).then(d => { if (d?.packet) this._handleIn(d.packet, null); }).catch(()=>{}); }
        const dhtData = []; for (const [id, p] of DHT._peers) dhtData.push({ id, lastSeen: p.lastSeen }); encryptToStorage('p2ppong_dht', JSON.stringify(dhtData.slice(0, 50))); this._saveCh(); }, 5000); },

    async sendMessage(chId, data) { const ch = this._channels[chId]; if (!ch) { log('sendMessage no channel', chId); return false; } const rtc = this._webRTC[chId];
        if (rtc?.dc?.readyState === 'open') { log('sendMessage via WebRTC'); rtc.dc.send(JSON.stringify({ type: 'message', text: data, time: Date.now(), nonce: RND() })); ch.blobs.push({ d: data, t: Date.now(), n: RND(), from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; await this._saveCh(); this._emit('message-sent', { channelId: chId, data }); return true; }
        const dhtPeers = getClosestPeers(ch.peerId || chId, 3).filter(p => p.conn?.readyState === 'open'); if (dhtPeers.length > 0) { log('sendMessage via DHT'); for (const p of dhtPeers) sendToPeer(p.id, { type: 'blob', channelId: chId, blob: JSON.stringify({ d: data, t: Date.now(), n: RND() }) }); ch.blobs.push({ d: data, t: Date.now(), n: RND(), from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; await this._saveCh(); this._emit('message-sent', { channelId: chId, data }); return true; }
        if (!ch.ratchetKey) { log('sendMessage no ratchet key'); return false; } log('sendMessage via Ratchet'); const packed = await packBlob(JSON.stringify({ d: typeof data === 'string' ? data : JSON.stringify(data), t: Date.now(), n: RND() }), ch); await this._post('/beacon', { keyHash: 'msg_' + chId, packet: packed }); ch.blobs.push({ d: data, t: Date.now(), n: RND(), from: 'me' }); ch.expires = Date.now() + 600000; this._stats.messagesSent++; await this._saveCh(); this._emit('message-sent', { channelId: chId, data }); return true; },

    async _handleIn(blobData, chId) { let d; try { d = JSON.parse(blobData); } catch(e) { return; }
        if (d?.type?.startsWith('webrtc-')) { this._handleWSig(chId || Object.keys(this._channels)[0], d); return; }
        if (d?.type === 'verification-emoji' && d.emoji) { log('verification-emoji received'); this._verificationEmoji = d.emoji;
            if (!this._pendingVerification && d.pubKey && d.inner) { this._pendingVerification = { bd: { pubKey: d.pubKey, inner: d.inner, peerId: d.peerId }, targetPeerId: d.peerId }; log('_pendingVerification set for peer A'); }
            this._emit('verification-received', { emoji: d.emoji }); return; }
        if (d?.type === 'verification-ack') { log('verification-ack received'); this._verificationConfirmed = true; this._emit('verification-acked', {}); for (const [id, waiting] of this._pendingWebRTC) { if (waiting) { this.startWebRTC(id); this._pendingWebRTC.set(id, false); } } return; }
        if (d?.type === 'beacon' && d.pubKey && d.inner) { if (d.targetPeerId && d.targetPeerId !== this._peerId) return; if (d.sig && !await verifyHMAC(JSON.stringify(d), d.sig, await SHA('beacon'))) return; log('beacon received');
            this._emit('beacon-received', { peerId: d.peerId, accept: async () => { const rpk = await importPublicKey(d.pubKey); const kp = await generateKeyPair(); const mpk = await exportPublicKey(kp); const ss = await deriveSecret(kp, rpk); const nid = RND();
                this._channels[nid] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: d.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now() };
                await this._post('/beacon', { keyHash: 'waiting_' + this._peerId, packet: JSON.stringify({ type: 'beacon-response', pubKey: mpk, peerId: this._peerId, inner: d.inner }) });
                this._stats.channelsOpened++; await this._saveCh(); this._emit('channel-opened', { channelId: nid, peerId: d.peerId, nick: 'Лучник', avatar: '001' }); this._startMsgPoll(nid); this._pendingWebRTC.set(nid, true); this.startWebRTC(nid); } }); return; }
        if (d?.type === 'beacon-response' && d.pubKey && d.inner) { log('beacon-response received'); for (const [bid, b] of Object.entries(this._beacons)) { if (!b.beaconKey) continue; const dec = await decryptAES(d.inner, b.beaconKey); if (!dec) continue; let p; try { p = JSON.parse(dec); } catch(e) { continue; } if (p.nonce !== b.nonce) continue;
            const rpk = await importPublicKey(d.pubKey); const ss = await deriveSecret(b.keyPair, rpk); const nid = RND(); this._channels[nid] = { secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1, peerId: d.peerId, type: 'cup', blobs: [], expires: Date.now() + 600000, createdAt: Date.now() };
            delete this._beacons[bid]; this._stopPolling(); this._stats.channelsOpened++; await this._saveCh(); this._emit('channel-opened', { channelId: nid, peerId: d.peerId, nick: 'Лучник', avatar: '001' }); this._startMsgPoll(nid); this._pendingWebRTC.set(nid, true); this.startWebRTC(nid); return; } }
        const ch = this._channels[chId]; if (ch?.ratchetKey) { const u = await unpackBlob(blobData, ch); if (u) { if (u._ri !== undefined) { if (ch.lastReceivedRi === undefined) ch.lastReceivedRi = -1; if (u._ri <= ch.lastReceivedRi) return; ch.lastReceivedRi = u._ri; } ch.blobs = ch.blobs || []; ch.blobs.push({ ...u, from: 'them' }); ch.expires = Date.now() + 600000; this._stats.messagesReceived++; await this._saveCh(); this._emit('message-received', { channelId: chId, text: u.d || u.text || '', from: 'them', timestamp: u._t || Date.now() }); } } },

    async _saveCh() { const d = Object.entries(this._channels).map(([id, ch]) => ({ id, peerId: ch.peerId, type: ch.type, expires: ch.expires, createdAt: ch.createdAt })); await encryptToStorage('p2ppong_channels', JSON.stringify(d)); },
    getStats() { return { peerId: this._peerId, state: this._state, channels: Object.keys(this._channels).length, dhtPeers: DHT._peers.size, ...this._stats }; },
    async destroy() { this._stopPolling(); for (const [id, t] of Object.entries(this._msgPollTimers)) clearTimeout(t); this._msgPollTimers = {}; for (const [id, t] of Object.entries(this._webRTCPolling)) clearTimeout(t); this._webRTCPolling = {}; for (const [id, t] of Object.entries(this._msgReadTimers)) clearTimeout(t); this._msgReadTimers = {}; for (const [id, rtc] of Object.entries(this._webRTC)) { try { rtc.pc.close(); } catch(e) {} } this._webRTC = {}; if (this._housekeepInterval) clearInterval(this._housekeepInterval); if (this._ws) { this._ws.onclose = null; this._ws.close(); this._ws = null; } if (this._peerHelpActive && typeof RobinHoodPeerHelp !== 'undefined') RobinHoodPeerHelp.stop(); this._channels = {}; this._beacons = {}; this._listeners = {}; this._state = 'idle'; this._peerId = null; this._pendingVerification = null; this._verificationEmoji = null; this._verificationConfirmed = false; this._pendingWebRTC.clear(); await this._saveCh(); this._emit('destroyed'); }
};

const RND = () => { const a = new Uint32Array(4); crypto.getRandomValues(a); return [...a].map(x => x.toString(16).padStart(8, '0')).join(''); };
const SHA = async t => { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); };
async function deriveStorageKey() { try { const salt = localStorage.getItem('pp4_hw_salt') || RND(); if (!localStorage.getItem('pp4_hw_salt')) localStorage.setItem('pp4_hw_salt', salt); const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'PBKDF2' }, false, ['deriveKey']); return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: new TextEncoder().encode('p2ppong_storage'), iterations: 100000, hash: 'SHA-256' }, k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); } catch(e) { return null; } }
async function encryptToStorage(key, value) { try { const k = await deriveStorageKey(); if (!k) { localStorage.setItem(key, value); return; } const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(value)); const c = new Uint8Array(iv.length + new Uint8Array(ct).length); c.set(iv); c.set(new Uint8Array(ct), iv.length); localStorage.setItem(key, btoa(String.fromCharCode(...c))); } catch(e) { localStorage.setItem(key, value); } }
async function decryptFromStorage(key) { try { const raw = localStorage.getItem(key); if (!raw) return null; if (raw.startsWith('{') || raw.startsWith('[')) return raw; const k = await deriveStorageKey(); if (!k) return raw; const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0)); const iv = bytes.slice(0, 12); const ct = bytes.slice(12); const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct); return new TextDecoder().decode(decrypted); } catch(e) { return localStorage.getItem(key); } }
async function generateHardwarePeerId() { const p = []; try { const c = document.createElement('canvas'); const gl = c.getContext('webgl'); const ext = gl.getExtension('WEBGL_debug_renderer_info'); if (ext) { p.push(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)); p.push(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)); } } catch(e) {} try { const ctx = new AudioContext(); p.push(ctx.sampleRate.toString()); p.push(ctx.destination.maxChannelCount.toString()); ctx.close(); } catch(e) {} p.push(screen.width + 'x' + screen.height, screen.colorDepth.toString(), navigator.hardwareConcurrency || '', navigator.deviceMemory || ''); let s = localStorage.getItem('pp4_hw_salt'); if (!s) { s = RND(); localStorage.setItem('pp4_hw_salt', s); } p.push(s); const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.join('|'))); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32); }
async function generateKeyPair() { return await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); }
async function exportPublicKey(kp) { const r = await crypto.subtle.exportKey('raw', kp.publicKey); return btoa(String.fromCharCode(...new Uint8Array(r))); }
async function importPublicKey(b64) { const r = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); return await crypto.subtle.importKey('raw', r, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
async function deriveSecret(kp, remotePubKey) { const b = await crypto.subtle.deriveBits({ name: 'ECDH', public: remotePubKey }, kp.privateKey, 256); return Array.from(new Uint8Array(b)).map(b => b.toString(16).padStart(2, '0')).join(''); }
async function encryptAES(text, secret) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['encrypt']); const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text)); const c = new Uint8Array(iv.length + new Uint8Array(ct).length); c.set(iv); c.set(new Uint8Array(ct), iv.length); return btoa(String.fromCharCode(...c)); }
async function decryptAES(enc, secret) { try { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'AES-GCM' }, false, ['decrypt']); const c = Uint8Array.from(atob(enc), x => x.charCodeAt(0)); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, k, c.slice(12))); } catch(e) { return null; } }
async function computeHMAC(data, secret) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))))); }
async function verifyHMAC(data, sig, secret) { try { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.substring(0, 32)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); return await crypto.subtle.verify('HMAC', k, Uint8Array.from(atob(sig), c => c.charCodeAt(0)), new TextEncoder().encode(data)); } catch(e) { return false; } }
async function advanceRatchet(ch) { const oldKey = ch.ratchetKey || ch.secret; const salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0'); const newKey = await SHA(oldKey + salt); ch.ratchetKey = newKey; ch.ratchetIndex = (ch.ratchetIndex || 0) + 1; if (!ch.oldKeys) ch.oldKeys = []; ch.oldKeys.push({ index: ch.ratchetIndex - 1, key: oldKey }); if (ch.oldKeys.length > 50) ch.oldKeys.shift(); return newKey; }
async function packBlob(jsonString, ch) { const compressed = await compressData(jsonString); const padSize = Math.floor(Math.random() * 50) + 20; const randomPad = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(padSize)))); const data = JSON.stringify({ z: compressed, t: Date.now(), n: RND(), pad: randomPad, ri: ch.ratchetIndex || 0 }); const currentKey = ch.ratchetKey || ch.secret; const hmac = await computeHMAC(data, currentKey); let padded = hmac + '|' + data; if (padded.length < 4096) { const pad = crypto.getRandomValues(new Uint8Array(4096 - padded.length)); padded += String.fromCharCode(...pad); } await advanceRatchet(ch); return await encryptAES(padded, ch.secret); }
async function unpackBlob(blob, ch) { const dec = await decryptAES(blob, ch.secret); if (!dec) return null; let result = await tryDecryptWithKey(dec, ch.ratchetKey || ch.secret); if (result) return result; if (ch.oldKeys) { for (let i = ch.oldKeys.length - 1; i >= 0; i--) { result = await tryDecryptWithKey(dec, ch.oldKeys[i].key); if (result) return result; } } requestRatchetResync(ch); return null; }
async function tryDecryptWithKey(decrypted, key) { const separatorIndex = decrypted.indexOf('|'); if (separatorIndex === -1) return null; const hmac = decrypted.substring(0, separatorIndex); const data = decrypted.substring(separatorIndex + 1).trim().replace(/\x00+$/, ''); if (!await verifyHMAC(data, hmac, key)) return null; try { const parsed = JSON.parse(data); if (parsed.z) { const inner = JSON.parse(await decompressData(parsed.z)); inner._t = parsed.t; inner._ri = parsed.ri; return inner; } delete parsed.pad; delete parsed.ri; return parsed; } catch(e) { return null; } }
async function compressData(str) { try { const cs = new CompressionStream('gzip'); const writer = cs.writable.getWriter(); writer.write(new TextEncoder().encode(str)); writer.close(); const reader = cs.readable.getReader(); const chunks = []; while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); } const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0)); let offset = 0; for (const chunk of chunks) { total.set(chunk, offset); offset += chunk.length; } return btoa(String.fromCharCode(...total)); } catch(e) { return btoa(str); } }
async function decompressData(b64) { try { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); const ds = new DecompressionStream('gzip'); const writer = ds.writable.getWriter(); writer.write(bytes); writer.close(); const reader = ds.readable.getReader(); const chunks = []; while (true) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); } const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0)); let offset = 0; for (const chunk of chunks) { total.set(chunk, offset); offset += chunk.length; } return new TextDecoder().decode(total); } catch(e) { return atob(b64); } }
let lastResyncTime = {}, resyncInProgress = {};
async function requestRatchetResync(ch) { const chId = Object.keys(P2PPong._channels).find(id => P2PPong._channels[id] === ch); if (!chId) return; const now = Date.now(); if (lastResyncTime[chId] && now - lastResyncTime[chId] < 60000) return; if (resyncInProgress[chId]) return; resyncInProgress[chId] = true; lastResyncTime[chId] = now; try { const kp = await generateKeyPair(); P2PPong._post('/beacon', { keyHash: 'msg_' + chId, packet: await encryptAES(JSON.stringify({ type: 'ratchet-resync', pubKey: await exportPublicKey(kp), peerId: P2PPong._peerId }), ch.secret) }); } catch(e) {} finally { resyncInProgress[chId] = false; } }

const DHT = { _nodeId: null, _buckets: [], _storage: {}, _k: 20, _alpha: 3, _peers: new Map(), _signalSend: null };
const BLOB_NS = '00000000000000000000000000000000';
function xorDistance(id1, id2) { let dist = ''; for (let i = 0; i < Math.min(id1.length, id2.length); i++) dist += (parseInt(id1[i], 16) ^ parseInt(id2[i], 16)).toString(16); return BigInt('0x' + dist); }
function getBucketIndex(dist) { if (dist === 0n) return 0; return dist.toString(2).length - 1; }
function initBuckets() { DHT._buckets = Array.from({ length: 256 }, () => []); }
function addPeer(peerId, conn) { const dist = xorDistance(DHT._nodeId, peerId); const idx = Math.min(getBucketIndex(dist), 255); const bucket = DHT._buckets[idx]; const existing = bucket.findIndex(p => p.id === peerId); if (existing >= 0) bucket.splice(existing, 1); bucket.unshift({ id: peerId, conn, lastSeen: Date.now() }); if (bucket.length > DHT._k) bucket.pop(); DHT._peers.set(peerId, { conn, lastSeen: Date.now() }); }
function getClosestPeers(targetId, count = DHT._k) { const all = []; for (const bucket of DHT._buckets) for (const peer of bucket) all.push({ ...peer, distance: xorDistance(targetId, peer.id) }); all.sort((a, b) => a.distance < b.distance ? -1 : 1); return all.slice(0, count); }
async function sendToPeer(peerId, message) { const peer = DHT._peers.get(peerId); if (!peer?.conn || peer.conn.readyState !== 'open') return; try { peer.conn.send(JSON.stringify(message)); } catch(e) {} }

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
