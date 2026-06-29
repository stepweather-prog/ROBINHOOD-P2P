// p2ppong.js — P2PPong Protocol (HTTPR) 
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
    MAX_VOICE_SIZE: 100000,
    MAX_VOICE_DURATION: 10,
    NONCE_LENGTH: 32,
    RATCHET_RESYNC_INTERVAL: 60000,
    SERVER_HEALTH_TTL: 300000,
    SERVER_FAIL_TIMEOUT: 5000,
    MAX_RETRIES: 3,
    DH_RATCHET_THRESHOLD: 10,
    MAX_PACKET_SIZE: 100000
};

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

const p2pSHA = (t) => cryptoCall('SHA', t);
const workerGenerateKeyPair = () => cryptoCall('generateKeyPair');
const workerEncryptAES = (text, secret) => cryptoCall('encryptAES', { text, secret });
const workerDecryptAES = (enc, secret) => cryptoCall('decryptAES', { enc, secret });
const workerComputeHMAC = (data, secret) => cryptoCall('computeHMAC', { data, secret });
const workerVerifyHMAC = (data, sig, secret) => cryptoCall('verifyHMAC', { data, sig, secret });
const workerPackBlob = (jsonString, ch) => cryptoCall('packBlob', { jsonString, ch });
const workerUnpackBlob = (blob, ch) => cryptoCall('unpackBlob', { blob, ch });
const workerDeriveSecret = (myPrivateKey, theirPublicKey) => cryptoCall('deriveSecret', { myPrivateKey, theirPublicKey });
const workerAdvanceRecvRatchet = (ch, targetRi) => cryptoCall('advanceRecvRatchet', { ch, targetRi });
const workerDHRatchetStep = (rootKey, myPrivKey, theirPubKey) => cryptoCall('dhRatchetStep', { rootKey, myPrivKey, theirPubKey });
const workerDHRatchetReceive = (rootKey, myPrivKey, theirNewPubKey) => cryptoCall('dhRatchetReceive', { rootKey, myPrivKey, theirNewPubKey });

const P2PPong = {
    _peerId: null, _kp: null, _remotePubKey: null, _remotePeerId: null, _secret: null, _chId: null,
    _channels: {}, _beacons: {}, _pending: null, _pendingChannelData: null, _signalServer: null, _serverHealth: {},
    _webRTCSignalBuffer: {}, _myNick: 'Лучник', _myAvatar: '001', _theirNick: 'Незнакомец', _theirAvatar: '000',
    _verificationCode: null, _beaconId: null, _codeVerified: false, _codePollTimer: null, _codePollActive: false,
    
    _signalServers: [
        { type: 'http', url: 'https://robincall.stephanclaps-491.workers.dev', name: 'Cloudflare', priority: 1 },
        { type: 'http', url: 'https://p2ppong-v2.onrender.com', name: 'Render', priority: 1 }
    ],
    
    _listeners: {}, _state: 'idle',
    _stats: { messagesSent: 0, messagesReceived: 0, peersConnected: 0, channelsOpened: 0 },
    _housekeepInterval: null, _pollTimer: null, _pollStart: null, _pollKey: null,
    _webRTC: {}, _webRTCPolling: {}, _msgPollTimers: {}, _dedupTimers: {}, _retryCount: {},
    _firebaseActive: false, _firebaseDB: null, _firebaseListeners: {},

    // === Call system (integrated) ===
    _callState: 'idle',          // 'idle' | 'calling' | 'ringing' | 'active'
    _callLocalStream: null,
    _callRemoteAudio: null,
    _callMicEnabled: true,
    _callSpeakerEnabled: true,
    _callMicVolume: 1.0,
    _callSpeakerVolume: 1.0,
    _callAudioContext: null,
    _callMicGain: null,
    _callSpeakerGain: null,
    _callRemoteSource: null,
    _callIncomingOffer: null,
    _callIceBuffer: [],
    _callIceFlushTimer: null,
    _callIceRestartTimer: null,
    _callIceRestartInProgress: false,
    _callHangInProgress: false,

    on(event, callback) { if (!this._listeners[event]) this._listeners[event] = []; this._listeners[event].push(callback); },
    _emit(event, data) { log('emit', event); const cbs = this._listeners[event]; if (cbs) cbs.forEach(cb => { try { cb(data); } catch(e) {} }); },
    setMyProfile(nick, avatar) { this._myNick = nick || 'Лучник'; this._myAvatar = avatar || '001'; },

    async init() {
        if (this._state === 'online') { this._emit('ready', {}); return; }
        this._state = 'connecting'; this._emit('state-change', { state: 'connecting' });
        try { this._initFirebase(); this._startHousekeeping(); this._state = 'online'; this._emit('state-change', { state: 'online' }); this._emit('ready', {}); }
        catch(e) { this._state = 'offline'; this._emit('error', { message: 'Init failed: ' + e.message }); }
    },

    _genNonce() { const a = new Uint32Array(CONFIG.NONCE_LENGTH / 8); crypto.getRandomValues(a); return Array.from(a).map(x => x.toString(16).padStart(8, '0')).join(''); },
    _genCode() { const arr = new Uint32Array(1); crypto.getRandomValues(arr); return (arr[0] % 10000000).toString().padStart(7, '0'); },

    async _pickServer() {
        const now = Date.now();
        const healthy = this._signalServers.filter(s => !this._serverHealth[s.url]?.failed || (now - this._serverHealth[s.url].lastCheck > CONFIG.SERVER_HEALTH_TTL)).sort((a,b) => a.priority - b.priority);
        for (const s of healthy) {
            if (s.type === 'http') {
                try { const r = await fetch(s.url + '/health', { signal: AbortSignal.timeout(5000) }); if (r.ok) { this._signalServer = s; this._serverHealth[s.url] = { healthy: true, lastCheck: now }; return s; } }
                catch(e) { this._serverHealth[s.url] = { healthy: false, failed: true, lastCheck: now }; }
            }
        }
        this._signalServer = this._signalServers[0]; return this._signalServer;
    },

    _initFirebase() { if (window.firebaseDB && !this._firebaseActive) { this._firebaseDB = window.firebaseDB; this._firebaseActive = true; } },
    async _firebasePost(keyHash, packet) { if (!this._firebaseDB) return false; try { await window.firebaseSet(window.firebaseRef(this._firebaseDB, 'beacons/' + keyHash), { packet, timestamp: Date.now(), peerId: this._peerId }); setTimeout(() => { window.firebaseSet(window.firebaseRef(this._firebaseDB, 'beacons/' + keyHash), null).catch(()=>{}); }, 300000); return true; } catch(e) { return false; } },
    async _firebaseGet(keyHash) { if (!this._firebaseDB) return null; try { const s = await window.firebaseGet(window.firebaseRef(this._firebaseDB, 'beacons/' + keyHash)); const d = s.val(); if (d?.packet && d.peerId !== this._peerId) return { packet: d.packet, status: 'found' }; return { status: 'waiting' }; } catch(e) { return null; } },
    _firebaseListen(keyHash, cb) { if (!this._firebaseDB) return; this._firebaseUnlisten(keyHash); const ref = window.firebaseRef(this._firebaseDB, 'beacons/' + keyHash); window.firebaseOnValue(ref, (s) => { const d = s.val(); if (d?.packet && d.peerId !== this._peerId) cb({ packet: d.packet, status: 'found' }); }); this._firebaseListeners[keyHash] = ref; },
    _firebaseUnlisten(keyHash) { if (this._firebaseListeners[keyHash]) { window.firebaseOff(this._firebaseListeners[keyHash]); delete this._firebaseListeners[keyHash]; } },
    _firebaseUnlistenAll() { Object.keys(this._firebaseListeners).forEach(k => this._firebaseUnlisten(k)); this._firebaseListeners = {}; },

    async craftArrow() {
        this._codeVerified = false; this._peerId = RND(); this._kp = await workerGenerateKeyPair(); this._remotePubKey = null; this._remotePeerId = null; this._secret = null; this._chId = null;
        await this._pickServer();
        const code = this._genCode(); this._verificationCode = code; const beaconId = RND(); this._beaconId = beaconId;
        const bk = await p2pSHA(this._kp.publicKey + 'beacon');
        const inner = await workerEncryptAES(JSON.stringify({ timestamp: Date.now(), peerId: this._peerId, beaconId, code, nick: this._myNick, avatar: this._myAvatar }), bk);
        const bd = { type: 'beacon', pubKey: this._kp.publicKey, peerId: this._peerId, inner, signalServer: this._signalServer.url };
        bd.sig = await workerComputeHMAC(bd.pubKey + bd.peerId, bk);
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'creator' };
        const packet = JSON.stringify(bd);
        for (const s of this._signalServers.filter(s=>s.type==='http')) { fetch(s.url+'/beacon',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keyHash:'waiting_'+beaconId,packet}),signal:AbortSignal.timeout(5000)}).catch(()=>{}); }
        if (this._firebaseActive) this._firebasePost('waiting_'+beaconId, packet).catch(()=>{});
        this.startPolling('ack_'+beaconId);
        this._emit('peer-id-generated', { peerId: this._peerId, beaconId: this._beaconId, code, pubKey: this._kp.publicKey });
        return this._beaconId;
    },

    async joinBeacon(targetBeaconId) {
        await this._pickServer(); let d = null;
        if (this._firebaseActive) { try { d = await this._firebaseGet('waiting_'+targetBeaconId); if (d?.status==='found') log('beacon-found','Firebase'); } catch(e) {} }
        if (!d?.packet) { for (const s of this._signalServers.filter(s=>s.type==='http')) { try { const r = await fetch(s.url+'/beacon?key=waiting_'+targetBeaconId,{signal:AbortSignal.timeout(5000)}); if (r.ok) { const data = await r.json(); if (data?.status==='found'&&data.packet) { d = data; log('beacon-found',s.name); break; } } } catch(e) {} } }
        if (!d?.packet) { this._emit('error', { message: 'Маяк не найден' }); return false; }
        let bd; try { bd = JSON.parse(d.packet); } catch(e) { this._emit('error', { message: 'Маяк повреждён' }); return false; }
        if (!bd?.pubKey || !bd?.inner) { this._emit('error', { message: 'Маяк повреждён — нет ключей' }); return false; }
        if (bd.signalServer) { const srv = this._signalServers.find(s=>s.url===bd.signalServer); if (srv) { this._signalServer = srv; log('signal-synced',srv.name); } }
        const bk = await p2pSHA(bd.pubKey + 'beacon');
        if (!await workerVerifyHMAC(bd.pubKey+bd.peerId, bd.sig, bk)) { this._emit('error', { message: 'Подпись маяка недействительна' }); return false; }
        const decrypted = await workerDecryptAES(bd.inner, bk);
        if (!decrypted) { this._emit('error', { message: 'Не удалось расшифровать маяк' }); return false; }
        const innerData = JSON.parse(decrypted); const code = innerData.code || ''; this._verificationCode = code;
        this._remotePeerId = innerData.peerId; this._theirNick = innerData.nick || 'Незнакомец'; this._theirAvatar = innerData.avatar || '000';
        const beaconId = innerData.beaconId; this._beaconId = beaconId;
        this._peerId = RND(); this._kp = await workerGenerateKeyPair(); this._remotePubKey = bd.pubKey; this._chId = RND();
        this._secret = await workerDeriveSecret(this._kp.privateKey, bd.pubKey);
        const verificationHash = await p2pSHA(this._secret + code);
        this._beacons[this._peerId] = { keyPair: this._kp, beaconKey: bk, expires: Date.now() + CONFIG.BEACON_TTL };
        this._pending = { type: 'joiner', targetPeerId: innerData.peerId, verificationHash };
        const br = JSON.stringify({ type: 'beacon-response', pubKey: this._kp.publicKey, peerId: this._peerId, inner: bd.inner, channelId: this._chId, verificationHash, signalServer: this._signalServer.url, nick: this._myNick, avatar: this._myAvatar });
        await this._post('/beacon', { keyHash: 'ack_'+beaconId, packet: br });
        this.startPolling('ack_'+beaconId);
        this._emit('verification-needed', { code }); return true;
    },

    confirmVerification() {
        if (this._pending?.type==='joiner'&&this._beaconId&&this._verificationCode) { this._post('/beacon',{keyHash:'code_'+this._beaconId,packet:JSON.stringify({type:'verification-code',code:this._verificationCode,peerId:this._peerId,pubKey:this._kp.publicKey})}); }
        if (this._pendingChannelData) { const d=this._pendingChannelData; this._pendingChannelData=null; this._openChannel(d.peerId,d.signalServer,d.nick,d.avatar); } return true;
    },
    getVerificationCode(){return this._verificationCode}, getPeerId(){return this._peerId}, getBeaconId(){return this._beaconId}, getPubKey(){return this._kp?.publicKey},

    _openChannel(peerId, signalServerUrl, theirNick, theirAvatar) {
        if (!this._chId) this._chId = RND(); if (!this._secret) return;
        if (signalServerUrl) { const srv = this._signalServers.find(s=>s.url===signalServerUrl); if (srv) this._signalServer = srv; }
        if (theirNick) this._theirNick = theirNick; if (theirAvatar) this._theirAvatar = theirAvatar; if (peerId) this._remotePeerId = peerId;
        const rootKey = this._secret;
        this._channels[this._chId] = { secret: this._secret, sendKey: rootKey, sendIndex: 0, recvKey: rootKey, recvIndex: 0, oldRecvKeys: [], peerId: peerId||'unknown', type: 'cup', blobs: [], expires: Date.now()+CONFIG.CHANNEL_TTL, createdAt: Date.now(), rootKey, dhKeyPair: { publicKey: this._kp.publicKey, privateKey: this._kp.privateKey }, dhRemotePubKey: this._remotePubKey, dhSendCount: 0, dhRecvCount: 0 };
        this._stopPolling(); this._stopCodePoll();
        setTimeout(() => this._cleanupBeaconKeys(this._beaconId), 10000);
        this._stats.channelsOpened++; this._pending = null;
        this._emit('channel-opened', { channelId: this._chId, peerId: peerId||'unknown', nick: this._theirNick, avatar: this._theirAvatar });
        this._startMsgPoll(this._chId); this._startWebRTC(this._chId, true);
    },

    async _dhRatchetStep(ch) { if (!ch?.rootKey||!ch.dhKeyPair||!ch.dhRemotePubKey) return null; const r = await workerDHRatchetStep(ch.rootKey,ch.dhKeyPair.privateKey,ch.dhRemotePubKey); ch.rootKey=r.newRootKey; ch.dhKeyPair={publicKey:r.newPubKey,privateKey:r.newPrivKey}; ch.sendKey=r.newSendKey; ch.sendIndex=0; ch.recvKey=r.newRecvKey; ch.recvIndex=0; ch.dhSendCount=0; ch.oldRecvKeys=[]; return r; },
    async _dhRatchetReceive(ch, pk) { if (!ch?.rootKey||!ch.dhKeyPair) return null; ch.dhRemotePubKey=pk; const r = await workerDHRatchetReceive(ch.rootKey,ch.dhKeyPair.privateKey,pk); ch.rootKey=r.newRootKey; ch.recvKey=r.newRecvKey; ch.recvIndex=0; ch.sendKey=r.newSendKey; ch.sendIndex=0; ch.dhRecvCount=0; ch.oldRecvKeys=[]; return r; },

    _startCodePoll() { this._stopCodePoll(); this._codePollActive=true; const me=this; let n=0; (function p(){ if (!me._codePollActive||!me._beaconId||n>=120) return; if (Object.keys(me._channels).length>0) { me._stopCodePoll(); return; } n++; me._get('/beacon?key=code_'+me._beaconId).then(d=>{ if (d?.packet) { me._stopCodePoll(); me._handleIn(d.packet); } else me._codePollTimer=setTimeout(p,1000); }).catch(()=>{ me._codePollTimer=setTimeout(p,1000); }); })(); },
    _stopCodePoll() { this._codePollActive=false; if (this._codePollTimer) { clearTimeout(this._codePollTimer); this._codePollTimer=null; } },

    async _postWithRetry(path, body, n=0) { if (n>=CONFIG.MAX_RETRIES) { await this._pickServer(); return this._postWithRetry(path,body,0); } const s=this._signalServer||this._signalServers[0]; try { const r=await fetch(s.url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)}); if (r.ok) return r.json(); if (r.status===429) { await new Promise(r=>setTimeout(r,10000)); return this._postWithRetry(path,body,n+1); } } catch(e) { this._serverHealth[s.url]={healthy:false,failed:true,lastCheck:Date.now()}; await this._pickServer(); return this._postWithRetry(path,body,n+1); } return null; },
    async _getWithRetry(path, n=0) { if (n>=CONFIG.MAX_RETRIES) { await this._pickServer(); return this._getWithRetry(path,0); } const s=this._signalServer||this._signalServers[0]; try { const r=await fetch(s.url+path,{signal:AbortSignal.timeout(5000)}); if (r.ok) return r.json(); if (r.status===429) { await new Promise(r=>setTimeout(r,10000)); return this._getWithRetry(path,n+1); } } catch(e) { this._serverHealth[s.url]={healthy:false,failed:true,lastCheck:Date.now()}; await this._pickServer(); return this._getWithRetry(path,n+1); } return null; },
    async _post(path, body) { const kh=body?.keyHash; if (this._firebaseActive&&kh) this._firebasePost(kh,body.packet||JSON.stringify(body)).catch(()=>{}); return this._postWithRetry(path,body); },
    async _get(path) { const kh=new URLSearchParams(path.split('?')[1])?.get('key'); if (this._firebaseActive&&kh) { const fb=await this._firebaseGet(kh); if (fb?.status==='found') return fb; } return this._getWithRetry(path); },

    startPolling(keyHash) { if (!keyHash) return; this._stopPolling(); this._pollKey=keyHash; this._pollStart=Date.now(); if (this._firebaseActive) this._firebaseListen(keyHash, d=>{ if (d?.packet) { this._stopPolling(); this._handleIn(d.packet); } }); this._doPoll(); },
    _doPoll() { if (!this._pollKey) return; const me=this; if ((Date.now()-me._pollStart)/1000>CONFIG.POLL_MAX) { me._stopPolling(); me._emit('beacon-timeout'); return; } me._get('/beacon?key='+me._pollKey).then(d=>{ if (d?.status==='found'&&d.packet) { try { const p=JSON.parse(d.packet); if (p.type==='beacon'||(p.type==='beacon-response'&&p.peerId===me._peerId)) { me._pollTimer=setTimeout(()=>me._doPoll(),1000); return; } } catch(e) {} me._stopPolling(); me._handleIn(d.packet); } else if (d?.status==='taken') { me._stopPolling(); me._emit('beacon-taken'); } else me._pollTimer=setTimeout(()=>me._doPoll(),1000); }).catch(()=>{ me._pollTimer=setTimeout(()=>me._doPoll(),1000); }); },
    _stopPolling() { if (this._pollTimer) { clearTimeout(this._pollTimer); this._pollTimer=null; } if (this._pollKey) this._firebaseUnlisten(this._pollKey); },

    async _handleIn(blobData) {
        const chId = this._chId || Object.keys(this._channels)[0]; const ch = this._channels[chId];
        if (ch?.secret && typeof blobData === 'string') {
            let ur = await workerUnpackBlob(blobData, ch);
            if (!ur) { try { const raw=JSON.parse(blobData); if (raw._ri!==undefined) { const t=parseInt(raw._ri)||0; if (t>(ch.recvIndex||0)) { const rr=await workerAdvanceRecvRatchet(ch,t); ch.recvKey=rr.finalKey; ch.recvIndex=rr.index; ch.oldRecvKeys=rr.oldKeys.slice(-3); ur=await workerUnpackBlob(blobData,ch); } } } catch(e) {} }
            if (ur) {
                const u = ur.data; if (u.from === this._peerId) return;
                if (u.dhPubKey&&ch.dhKeyPair) await this._dhRatchetReceive(ch, u.dhPubKey);
                ch.dhRecvCount = (ch.dhRecvCount||0)+1;
                const dk = chId+'_'+(u.n||u._t||''); if (this._dedupTimers[dk]) return;
                this._dedupTimers[dk] = setTimeout(()=>delete this._dedupTimers[dk], CONFIG.CHANNEL_TTL);
                if (u.nick) this._theirNick=u.nick; if (u.avatar) this._theirAvatar=u.avatar;
                
                // Определяем тип сообщения
                const msgType = u.type || 'text';
                const displayText = msgType === 'voice' ? '[Голосовое сообщение]' : (u.d || u.text || '');
                
                ch.blobs.push({ 
                    d: displayText, 
                    voiceData: msgType === 'voice' ? u.d : null, 
                    t: u._t || Date.now(), 
                    n: u.n || '', 
                    from: 'them', 
                    status: 'delivered', 
                    nick: this._theirNick, 
                    avatar: this._theirAvatar,
                    type: msgType
                });
                ch.expires=Date.now()+CONFIG.CHANNEL_TTL; this._stats.messagesReceived++;
                this._emit('message-received', { 
                    channelId: chId, 
                    text: displayText, 
                    voiceData: msgType === 'voice' ? u.d : null, 
                    type: msgType, 
                    from: 'them', 
                    timestamp: u._t||Date.now(), 
                    nick: this._theirNick, 
                    avatar: this._theirAvatar 
                });
                return;
            }
        }
        let d; try { d=JSON.parse(blobData); } catch(e) { return; }
        if (d.peerId===this._peerId) return;
        
        // Call signaling (integrated)
        if (d.type?.startsWith('call-')) {
            this._handleCallSignal(d);
            return;
        }
        
        if (d.type?.startsWith('webrtc-')) { if (this._chId) { if (!this._webRTC[this._chId]) { if (!this._webRTCSignalBuffer[this._chId]) this._webRTCSignalBuffer[this._chId]=[]; this._webRTCSignalBuffer[this._chId].push(d); } else this._handleWSig(this._chId,d); } return; }
        if (d.type==='beacon-response'&&d.pubKey&&d.channelId) { if (this._pending?.type!=='creator') return; this._remotePubKey=d.pubKey; this._remotePeerId=d.peerId; this._chId=d.channelId; this._secret=await workerDeriveSecret(this._kp.privateKey,d.pubKey); if (d.nick) this._theirNick=d.nick; if (d.avatar) this._theirAvatar=d.avatar; this._pendingChannelData={ peerId:d.peerId, signalServer:d.signalServer, nick:d.nick, avatar:d.avatar }; this._startCodePoll(); return; }
        if (d.type==='beacon-ack'&&d.channelId) { if (this._pending?.type!=='joiner') return; this._chId=d.channelId; if (!this._secret&&d.pubKey) this._secret=await workerDeriveSecret(this._kp.privateKey,d.pubKey); if (d.peerId) this._remotePeerId=d.peerId; if (d.nick) this._theirNick=d.nick; if (d.avatar) this._theirAvatar=d.avatar; this._openChannel(d.peerId,this._signalServer?.url,d.nick,d.avatar); return; }
        if (d.type==='verification-code'&&d.code) { if (Object.keys(this._channels).length>0) return; if (this._pending?.type==='creator'&&this._verificationCode&&d.code===this._verificationCode) { this._remotePubKey=d.pubKey; this._remotePeerId=d.peerId; this._secret=await workerDeriveSecret(this._kp.privateKey,d.pubKey); await this._post('/beacon',{keyHash:'ack_'+this._beaconId,packet:JSON.stringify({type:'beacon-ack',peerId:this._peerId,channelId:this._chId,pubKey:this._kp.publicKey,signalServer:this._signalServer.url,nick:this._myNick,avatar:this._myAvatar})}); this._openChannel(d.peerId,d.signalServer,d.nick,d.avatar); return; } return; }
        if (d.type==='ratchet-resync'&&d.pubKey) { if (ch) { try { const ss=await workerDeriveSecret(this._kp?.privateKey||'',d.pubKey); ch.secret=ss; ch.sendKey=ss; ch.sendIndex=0; ch.recvKey=ss; ch.recvIndex=0; ch.oldRecvKeys=[]; } catch(e) { log('resync error',e.message); } } return; }
    },

    async sendMessage(chId, text) { const ch=this._channels[chId||this._chId]; if (!ch) return false; const nonce=RND(); const md=JSON.stringify({type:'text',d:text,t:Date.now(),n:nonce,from:this._peerId,nick:this._myNick,avatar:this._myAvatar}); return this._sendEncrypted(ch,chId,md,text,nonce); },
    
    async sendVoiceMessage(chId, voiceBase64) { 
        const ch=this._channels[chId||this._chId]; 
        if (!ch) return false; 
        if (voiceBase64.length > CONFIG.MAX_VOICE_SIZE) { 
            this._emit('error',{message:'Голосовое слишком длинное. Максимум '+CONFIG.MAX_VOICE_DURATION+' секунд.'}); 
            return false; 
        } 
        const nonce=RND(); 
        const md=JSON.stringify({type:'voice',d:voiceBase64,t:Date.now(),n:nonce,from:this._peerId,nick:this._myNick,avatar:this._myAvatar}); 
        return this._sendEncrypted(ch,chId,md,'[Голосовое сообщение]',nonce); 
    },

    async _sendEncrypted(ch, chId, messageData, displayText, nonce) {
        const rtc=this._webRTC[chId||this._chId];
        if (ch.dhSendCount>=CONFIG.DH_RATCHET_THRESHOLD&&ch.dhKeyPair&&ch.dhRemotePubKey) { const dr=await this._dhRatchetStep(ch); if (dr) { const parsed=JSON.parse(messageData); parsed.dhPubKey=dr.newPubKey; messageData=JSON.stringify(parsed); } }
        if (rtc&&rtc.dc&&rtc.dc.readyState==='open') { const result=await workerPackBlob(messageData,ch); ch.sendKey=result.newSendKey; ch.sendIndex=result.newSendIndex; ch.dhSendCount=(ch.dhSendCount||0)+1; if (result.packed.length>CONFIG.MAX_PACKET_SIZE) { this._emit('error',{message:'Сообщение слишком большое.'}); return false; } rtc.dc.send(result.packed); ch.blobs.push({d:displayText,t:Date.now(),n:nonce,from:'me',status:'sent',nick:this._myNick,avatar:this._myAvatar}); ch.expires=Date.now()+CONFIG.CHANNEL_TTL; this._stats.messagesSent++; this._emit('message-sent',{channelId:chId||this._chId,data:displayText,status:'sent',nick:this._myNick,avatar:this._myAvatar}); return true; }
        if (ch.sendKey) { const result=await workerPackBlob(messageData,ch); if (result.packed.length>CONFIG.MAX_PACKET_SIZE) { this._emit('error',{message:'Сообщение слишком большое для сервера.'}); return false; } ch.sendKey=result.newSendKey; ch.sendIndex=result.newSendIndex; ch.dhSendCount=(ch.dhSendCount||0)+1; this._post('/beacon',{keyHash:'msg_'+(chId||this._chId)+'_'+this._beaconId,packet:result.packed}); ch.blobs.push({d:displayText,t:Date.now(),n:nonce,from:'me',status:'sent',nick:this._myNick,avatar:this._myAvatar}); ch.expires=Date.now()+CONFIG.CHANNEL_TTL; this._stats.messagesSent++; this._emit('message-sent',{channelId:chId||this._chId,data:displayText,status:'sent',nick:this._myNick,avatar:this._myAvatar}); return true; }
        return false;
    },

    // === Integrated Call System ===

    async _getCallMedia() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: { 
                    echoCancellation: true, 
                    noiseSuppression: true
                } 
            });
            return stream;
        } catch(e) {
            log('getUserMedia error', e.message);
            return null;
        }
    },

    _setupCallAudio() {
        if (!this._callAudioContext) {
            this._callAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this._callAudioContext.state === 'suspended') {
            this._callAudioContext.resume().catch(() => {});
        }
    },

    _createCallPC() {
        // Закрываем предыдущее соединение если есть
        if (this._callPC) {
            this._callPC.onconnectionstatechange = null;
            this._callPC.ontrack = null;
            this._callPC.onicecandidate = null;
            this._callPC.close();
            this._callPC = null;
        }
        this._callIceBuffer = [];
        if (this._callIceFlushTimer) clearTimeout(this._callIceFlushTimer);

        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun.cloudflare.com:3478' }
            ]
        });

        // Добавляем локальные треки
        if (this._callLocalStream) {
            this._callLocalStream.getTracks().forEach(track => {
                pc.addTrack(track, this._callLocalStream);
            });
        }

        // Обработка входящего аудио
        pc.ontrack = (e) => {
            if (e.streams[0]) {
                this._setupCallAudio();
                // Удаляем старое аудио
                if (this._callRemoteAudio) {
                    this._callRemoteAudio.srcObject = null;
                    this._callRemoteAudio.remove();
                }
                if (this._callRemoteSource) {
                    try { this._callRemoteSource.disconnect(); } catch(e) {}
                }

                const audioCtx = this._callAudioContext;
                const source = audioCtx.createMediaStreamSource(e.streams[0]);
                this._callRemoteSource = source;
                
                const gainNode = audioCtx.createGain();
                gainNode.gain.value = this._callSpeakerVolume;
                this._callSpeakerGain = gainNode;
                
                source.connect(gainNode);
                gainNode.connect(audioCtx.destination);

                // Также создаём Audio элемент для автовоспроизведения
                const audio = new Audio();
                audio.srcObject = e.streams[0];
                audio.autoplay = true;
                audio.volume = this._callSpeakerVolume;
                audio.style.display = 'none';
                document.body.appendChild(audio);
                this._callRemoteAudio = audio;
                
                audio.play().catch(() => {
                    // Автовоспроизведение заблокировано — ждём клик
                    const unlock = () => {
                        audio.play().catch(() => {});
                        document.removeEventListener('click', unlock);
                    };
                    document.addEventListener('click', unlock);
                });
            }
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._callIceBuffer.push(e.candidate);
            } else {
                // Кандидаты собраны — отправляем
                this._callIceFlushTimer = setTimeout(() => {
                    this._flushCallICE();
                }, 100);
            }
        };

        pc.onconnectionstatechange = () => {
            log('Call PC state:', pc.connectionState);
            
            if (pc.connectionState === 'connected') {
                this._callState = 'active';
                if (this._callIceRestartTimer) clearTimeout(this._callIceRestartTimer);
                this._callIceRestartInProgress = false;
                this._emit('call-connected', {});
            }
            
            if (pc.connectionState === 'disconnected' && this._callState === 'active' && !this._callIceRestartInProgress) {
                this._callIceRestartInProgress = true;
                this._callIceRestartTimer = setTimeout(async () => {
                    if (this._callPC && this._callPC.connectionState === 'disconnected') {
                        try {
                            await this._restartCallICE();
                        } catch(e) {
                            this.endCall();
                        } finally {
                            this._callIceRestartInProgress = false;
                        }
                    }
                }, 15000);
            }
            
            if (pc.connectionState === 'failed') {
                if (this._callIceRestartTimer) clearTimeout(this._callIceRestartTimer);
                this._callIceRestartInProgress = false;
                this.endCall();
            }
        };

        this._callPC = pc;
        return pc;
    },

    _flushCallICE() {
        if (!this._callPC || this._callIceBuffer.length === 0) return;
        const chId = this._chId || Object.keys(this._channels)[0];
        if (!chId) return;
        
        this._callIceBuffer.forEach(candidate => {
            this.sendMessage(chId, JSON.stringify({
                type: 'call-ice',
                sdp: JSON.stringify(candidate)
            }));
        });
        this._callIceBuffer = [];
    },

    async _restartCallICE() {
        if (!this._callPC || this._callPC.connectionState === 'closed') return;
        const chId = this._chId || Object.keys(this._channels)[0];
        if (!chId) return;
        
        const offer = await this._callPC.createOffer({ iceRestart: true });
        await this._callPC.setLocalDescription(offer);
        await this.sendMessage(chId, JSON.stringify({
            type: 'call-offer',
            sdp: JSON.stringify(this._callPC.localDescription)
        }));
    },

    _handleCallSignal(d) {
        const chId = this._chId || Object.keys(this._channels)[0];
        if (!chId) return;

        if (d.type === 'call-offer') {
            if (this._callState !== 'idle' && this._callState !== 'ringing') return;
            try {
                this._callIncomingOffer = typeof d.sdp === 'string' ? JSON.parse(d.sdp) : d.sdp;
            } catch(e) {
                this._callIncomingOffer = d.sdp;
            }
            this._callState = 'ringing';
            this._emit('call-incoming', { offer: this._callIncomingOffer });
            return;
        }

        if (d.type === 'call-answer') {
            if (!this._callPC || this._callState !== 'calling') return;
            try {
                const answerSdp = typeof d.sdp === 'string' ? JSON.parse(d.sdp) : d.sdp;
                this._callPC.setRemoteDescription(new RTCSessionDescription(answerSdp))
                    .then(() => {
                        // Применяем буферизированные ICE
                        this._callIceBuffer.forEach(c => {
                            this._callPC.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
                        });
                        this._callIceBuffer = [];
                    })
                    .catch(e => log('setRemoteDescription error', e.message));
            } catch(e) {
                log('call-answer parse error', e.message);
            }
            return;
        }

        if (d.type === 'call-ice') {
            if (!this._callPC) return;
            try {
                const candidate = typeof d.sdp === 'string' ? JSON.parse(d.sdp) : d.sdp;
                if (this._callPC.remoteDescription) {
                    this._callPC.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
                } else {
                    this._callIceBuffer.push(candidate);
                }
            } catch(e) {}
            return;
        }

        if (d.type === 'call-hangup') {
            this.endCall(false);
            return;
        }
    },

    async startCall() {
        if (this._callState !== 'idle') return false;
        const chId = this._chId || Object.keys(this._channels)[0];
        if (!chId) {
            this._emit('error', { message: 'Нет активного канала' });
            return false;
        }

        const stream = await this._getCallMedia();
        if (!stream) {
            this._emit('error', { message: 'Нет доступа к микрофону' });
            return false;
        }

        this._callLocalStream = stream;
        this._setupCallAudio();
        
        // Настройка микрофона
        const source = this._callAudioContext.createMediaStreamSource(stream);
        const gainNode = this._callAudioContext.createGain();
        gainNode.gain.value = this._callMicVolume;
        this._callMicGain = gainNode;
        source.connect(gainNode);

        const pc = this._createCallPC();
        this._callState = 'calling';

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            await this.sendMessage(chId, JSON.stringify({
                type: 'call-offer',
                sdp: JSON.stringify(offer)
            }));
            
            this._emit('call-started', {});
            
            // Повторная отправка offer через 3 сек на случай потери
            setTimeout(() => {
                if (this._callState === 'calling' && pc.signalingState === 'have-local-offer') {
                    this.sendMessage(chId, JSON.stringify({
                        type: 'call-offer',
                        sdp: JSON.stringify(offer)
                    }));
                }
            }, 3000);
            
            return true;
        } catch(e) {
            log('startCall error', e.message);
            this.endCall();
            return false;
        }
    },

    async acceptCall() {
        if (!this._callIncomingOffer || this._callState !== 'ringing') return false;
        const chId = this._chId || Object.keys(this._channels)[0];
        if (!chId) return false;

        const stream = await this._getCallMedia();
        if (!stream) {
            this._emit('error', { message: 'Нет доступа к микрофону' });
            this.endCall(false);
            return false;
        }

        this._callLocalStream = stream;
        this._setupCallAudio();
        
        const source = this._callAudioContext.createMediaStreamSource(stream);
        const gainNode = this._callAudioContext.createGain();
        gainNode.gain.value = this._callMicVolume;
        this._callMicGain = gainNode;
        source.connect(gainNode);

        const pc = this._createCallPC();

        try {
            const offerSdp = this._callIncomingOffer;
            await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
            
            // Применяем буферизированные ICE
            this._callIceBuffer.forEach(c => {
                pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            });
            this._callIceBuffer = [];
            
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            await this.sendMessage(chId, JSON.stringify({
                type: 'call-answer',
                sdp: JSON.stringify(answer)
            }));
            
            this._callIncomingOffer = null;
            this._callState = 'active';
            this._emit('call-connected', {});
            return true;
        } catch(e) {
            log('acceptCall error', e.message);
            this.endCall(false);
            return false;
        }
    },

    endCall(sendHangup = true) {
        if (this._callHangInProgress) return;
        this._callHangInProgress = true;

        const prevState = this._callState;
        this._callState = 'idle';
        this._callIncomingOffer = null;

        // Отправляем сигнал hangup
        if (sendHangup && prevState !== 'idle') {
            const chId = this._chId || Object.keys(this._channels)[0];
            if (chId) {
                this.sendMessage(chId, JSON.stringify({ type: 'call-hangup' }));
            }
        }

        // Закрываем PC
        if (this._callPC) {
            this._callPC.onconnectionstatechange = null;
            this._callPC.ontrack = null;
            this._callPC.onicecandidate = null;
            this._callPC.close();
            this._callPC = null;
        }

        // Останавливаем локальный стрим
        if (this._callLocalStream) {
            this._callLocalStream.getTracks().forEach(t => t.stop());
            this._callLocalStream = null;
        }

        // Убираем удалённое аудио
        if (this._callRemoteAudio) {
            this._callRemoteAudio.srcObject = null;
            this._callRemoteAudio.remove();
            this._callRemoteAudio = null;
        }

        if (this._callRemoteSource) {
            try { this._callRemoteSource.disconnect(); } catch(e) {}
            this._callRemoteSource = null;
        }

        this._callMicGain = null;
        this._callSpeakerGain = null;
        this._callIceBuffer = [];
        
        if (this._callIceFlushTimer) clearTimeout(this._callIceFlushTimer);
        if (this._callIceRestartTimer) clearTimeout(this._callIceRestartTimer);
        this._callIceRestartInProgress = false;
        
        this._emit('call-ended', {});
        this._callHangInProgress = false;
    },

    toggleCallMic() {
        this._callMicEnabled = !this._callMicEnabled;
        if (this._callLocalStream) {
            this._callLocalStream.getAudioTracks().forEach(t => t.enabled = this._callMicEnabled);
        }
        return this._callMicEnabled;
    },

    toggleCallSpeaker() {
        this._callSpeakerEnabled = !this._callSpeakerEnabled;
        return this._callSpeakerEnabled;
    },

    setCallMicVolume(volume) {
        this._callMicVolume = Math.max(0, Math.min(2, volume));
        if (this._callMicGain) {
            this._callMicGain.gain.value = this._callMicVolume;
        }
    },

    setCallSpeakerVolume(volume) {
        this._callSpeakerVolume = Math.max(0, Math.min(2, volume));
        if (this._callSpeakerGain) {
            this._callSpeakerGain.gain.value = this._callSpeakerVolume;
        }
        if (this._callRemoteAudio) {
            this._callRemoteAudio.volume = this._callSpeakerVolume;
        }
    },

    getCallState() {
        return this._callState;
    },

    // === End Call System ===

    _cleanupBeaconKeys(beaconId) { this._get('/delete?key=waiting_'+beaconId).catch(()=>{}); this._get('/delete?key=code_'+beaconId).catch(()=>{}); this._get('/delete?key=ack_'+beaconId).catch(()=>{}); },

    _startHousekeeping() { const me=this; this._housekeepInterval=setInterval(()=>{ const now=Date.now(); Object.keys(me._channels).forEach(id=>{ if (now>me._channels[id].expires) { delete me._channels[id]; delete me._webRTC[id]; me._stopMsgPoll(id); me._stopWebRTCPoll(id); me._emit('channel-expired',{channelId:id}); } }); Object.keys(me._beacons).forEach(id=>{ if (now>me._beacons[id].expires) delete me._beacons[id]; }); me._pickServer().catch(()=>{}); },CONFIG.HOUSEKEEP_INTERVAL); },

    _startMsgPoll(chId) { if (this._msgPollTimers[chId]) return; const me=this; (function p(){ if (!me._channels[chId]) { me._stopMsgPoll(chId); return; } if (me._webRTC[chId]&&me._webRTC[chId].connected) { me._stopMsgPoll(chId); return; } const kh='msg_'+chId+'_'+me._beaconId; if (me._firebaseActive) me._firebaseListen(kh,d=>{ if (d?.packet) me._handleIn(d.packet); }); me._get('/beacon?key='+kh).then(d=>{ if (d?.packet) me._handleIn(d.packet); me._msgPollTimers[chId]=setTimeout(p,CONFIG.MSG_POLL_INTERVAL); }).catch(()=>{ me._msgPollTimers[chId]=setTimeout(p,CONFIG.MSG_POLL_INTERVAL); }); })(); },
    _stopMsgPoll(chId) { if (this._msgPollTimers[chId]) { clearTimeout(this._msgPollTimers[chId]); delete this._msgPollTimers[chId]; } },

    _startWebRTC(chId, asInitiator) { const ch=this._channels[chId]; if (!ch||this._webRTC[chId]) return; try { const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}]}); this._webRTC[chId]={pc,dc:null,iceBuffer:[],connected:false,initiator:asInitiator,seenMessages:new Set(),offerSent:false}; if (this._webRTCSignalBuffer[chId]) { const bf=this._webRTCSignalBuffer[chId]; delete this._webRTCSignalBuffer[chId]; bf.forEach(sig=>this._handleWSig(chId,sig)); } const me=this; pc.onicecandidate=e=>{ if (e.candidate) { me._webRTC[chId].iceBuffer.push(e.candidate); } else { me._flushICE(chId); } }; pc.onconnectionstatechange=()=>{ if (pc.connectionState==='disconnected'||pc.connectionState==='failed'||pc.connectionState==='closed') { me._webRTC[chId].connected=false; me._startMsgPoll(chId); } }; if (asInitiator) { const dc=pc.createDataChannel('chat'); me._setupDataChannel(chId,ch,dc,true); pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>{ me._webRTC[chId].offerSent=true; me._sendWSig(chId,{type:'webrtc-offer',sdp:JSON.stringify(pc.localDescription)}); }); } else { pc.ondatachannel=e=>{ me._setupDataChannel(chId,ch,e.channel,false); }; } setTimeout(()=>{ if (me._webRTC[chId]&&!me._webRTC[chId].connected) me._startWebRTCPoll(chId); },5000); } catch(e) { log('startWebRTC error',e.message); } },
    _setupDataChannel(chId, ch, dc, isInitiator) { const me=this; this._webRTC[chId].dc=dc; dc.onopen=()=>{ me._webRTC[chId].connected=true; me._stats.peersConnected++; me._emit('peer-connected',{channelId:chId,nick:me._theirNick,avatar:me._theirAvatar}); me._stopWebRTCPoll(chId); me._stopMsgPoll(chId); }; dc.onmessage=e=>me._handleDCMessage(chId,ch,e); },
    async _handleDCMessage(chId, ch, e) { if (typeof e.data==='string'&&e.data.length>50) { let ur=await workerUnpackBlob(e.data,ch); if (!ur) { try { const raw=JSON.parse(e.data); if (raw._ri!==undefined) { const t=parseInt(raw._ri)||0; if (t>(ch.recvIndex||0)) { const rr=await workerAdvanceRecvRatchet(ch,t); ch.recvKey=rr.finalKey; ch.recvIndex=rr.index; ch.oldRecvKeys=rr.oldKeys.slice(-3); ur=await workerUnpackBlob(e.data,ch); } } } catch(er) {} } if (ur) { const u=ur.data; if (u.from===this._peerId) return; if (u.dhPubKey&&ch.dhKeyPair) await this._dhRatchetReceive(ch,u.dhPubKey); ch.dhRecvCount=(ch.dhRecvCount||0)+1; const dk=chId+'_'+(u.n||u._t||''); if (this._webRTC[chId]?.seenMessages?.has(u.n)) return; if (this._dedupTimers[dk]) return; this._dedupTimers[dk]=setTimeout(()=>delete this._dedupTimers[dk],CONFIG.CHANNEL_TTL); this._webRTC[chId]?.seenMessages?.add(u.n); if (u.nick) this._theirNick=u.nick; if (u.avatar) this._theirAvatar=u.avatar; const msgType = u.type || 'text'; const dt = msgType === 'voice' ? '[Голосовое сообщение]' : (u.d||u.text||''); ch.blobs.push({d:dt,voiceData:msgType==='voice'?u.d:null,t:u._t||Date.now(),n:u.n||'',from:'them',status:'delivered',nick:this._theirNick,avatar:this._theirAvatar,type:msgType}); ch.expires=Date.now()+CONFIG.CHANNEL_TTL; this._stats.messagesReceived++; this._emit('message-received',{channelId:chId,text:dt,voiceData:msgType==='voice'?u.d:null,type:msgType,from:'them',timestamp:u._t||Date.now(),nick:this._theirNick,avatar:this._theirAvatar}); return; } } try { const m=JSON.parse(e.data); if (m.type?.startsWith('call-')) { this._handleCallSignal(m); return; } if (m.type==='message'&&m.text) { const dk=chId+'_'+(m.nonce||''); if (this._dedupTimers[dk]) return; this._dedupTimers[dk]=setTimeout(()=>delete this._dedupTimers[dk],CONFIG.CHANNEL_TTL); ch.blobs.push({d:m.text,t:m.time,n:m.nonce,from:'them',status:'delivered',nick:this._theirNick,avatar:this._theirAvatar}); ch.expires=Date.now()+CONFIG.CHANNEL_TTL; this._stats.messagesReceived++; this._emit('message-received',{channelId:chId,text:m.text,from:'them',timestamp:m.time,nick:this._theirNick,avatar:this._theirAvatar}); } } catch(er) {} },
    _startWebRTCPoll(chId) { if (this._webRTCPolling[chId]) return; const me=this; (function p(){ if (!me._webRTC[chId]||me._webRTC[chId].connected) { me._stopWebRTCPoll(chId); return; } me._get('/beacon?key=webrtc_'+chId).then(d=>{ if (d?.packet) { const sig=JSON.parse(d.packet); if (sig.peerId!==me._peerId) me._handleWSig(chId,sig); } me._webRTCPolling[chId]=setTimeout(p,CONFIG.WEBRTC_POLL_INTERVAL); }).catch(()=>{ me._webRTCPolling[chId]=setTimeout(p,CONFIG.WEBRTC_POLL_INTERVAL); }); })(); },
    _stopWebRTCPoll(chId) { if (this._webRTCPolling[chId]) { clearTimeout(this._webRTCPolling[chId]); delete this._webRTCPolling[chId]; } },
    _handleWSig(chId, sig) { const rtc=this._webRTC[chId]; if (!rtc||!rtc.pc||rtc.connected) return; const pc=rtc.pc; try { if (sig.type==='webrtc-ice') { const c=JSON.parse(sig.sdp); if (pc.remoteDescription) { pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{}); } else { rtc.iceBuffer.push(c); } return; } if (sig.type==='webrtc-offer') { pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))).then(()=>{ rtc.iceBuffer.forEach(c=>pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{})); rtc.iceBuffer=[]; if (!rtc.initiator) { pc.createAnswer().then(a=>pc.setLocalDescription(a)).then(()=>this._sendWSig(chId,{type:'webrtc-answer',sdp:JSON.stringify(pc.localDescription)})); } }); return; } if (sig.type==='webrtc-answer') { pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(sig.sdp))).then(()=>{ rtc.iceBuffer.forEach(c=>pc.addIceCandidate(new RTCIceCandidate(c)).catch(()=>{})); rtc.iceBuffer=[]; }); } } catch(e) {} },
    _sendWSig(chId, data) { this._post('/beacon',{keyHash:'webrtc_'+chId,packet:JSON.stringify(data)}); },
    _flushICE(chId) { const rtc=this._webRTC[chId]; if (!rtc) return; rtc.iceBuffer.forEach(c=>this._sendWSig(chId,{type:'webrtc-ice',sdp:JSON.stringify(c)})); rtc.iceBuffer=[]; },

    async destroy() {
        this.endCall(false);
        this._stopPolling(); this._stopCodePoll(); this._firebaseUnlistenAll();
        Object.keys(this._msgPollTimers).forEach(id=>clearTimeout(this._msgPollTimers[id])); this._msgPollTimers={};
        Object.keys(this._webRTCPolling).forEach(id=>clearTimeout(this._webRTCPolling[id])); this._webRTCPolling={};
        Object.keys(this._webRTC).forEach(id=>{ try{this._webRTC[id].pc.close();}catch(e){} }); this._webRTC={};
        if (this._housekeepInterval) clearInterval(this._housekeepInterval);
        for (const k in this._dedupTimers) clearTimeout(this._dedupTimers[k]);
        this._dedupTimers={}; this._channels={}; this._beacons={}; this._listeners={};
        this._state='idle'; this._peerId=null; this._kp=null;
        this._remotePubKey=null; this._secret=null; this._chId=null;
        this._pending=null; this._pendingChannelData=null; this._verificationCode=null; this._signalServer=null;
        this._webRTCSignalBuffer={}; this._remotePeerId=null; this._serverHealth={};
        this._beaconId=null; this._codeVerified=false;
        this._firebaseActive=false; this._firebaseDB=null;
        this._emit('destroyed');
    }
};

const RND = () => { const a = new Uint32Array(4); crypto.getRandomValues(a); return Array.from(a).map(x => x.toString(16).padStart(8, '0')).join(''); };

if (typeof window !== 'undefined') { window.P2PPong = P2PPong; }
