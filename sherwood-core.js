/**
 * sherwood-core.js — Единый модуль RobinHood P2P v1.3
 * 
 * SherwoodCrypto — AES-GCM + SHA-256 + Ed25519
 * SherwoodAudio  — пул аудио + звуки звонков
 * SherwoodCall   — WebRTC звонки (аудио/видео/mesh), Data Channel, SRTP
 */

(function(global) {
    'use strict';

    // ===================== SherwoodCrypto =====================
    const SherwoodCrypto = {
        async sha256(text) {
            const data = new TextEncoder().encode(text);
            const hash = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hash)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
        },

        async generateAESKey() {
            return await crypto.subtle.generateKey(
                { name: "AES-GCM", length: 256 },
                true,
                ["encrypt", "decrypt"]
            );
        },

        async exportAESKey(key) {
            const raw = await crypto.subtle.exportKey("raw", key);
            return btoa(String.fromCharCode.apply(null, new Uint8Array(raw)));
        },

        async importAESKey(base64key) {
            const raw = Uint8Array.from(atob(base64key), function(c) { return c.charCodeAt(0); });
            return await crypto.subtle.importKey(
                "raw", raw,
                { name: "AES-GCM" },
                false,
                ["encrypt", "decrypt"]
            );
        },

        async aesEncrypt(plaintext, key) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(plaintext);
            const ciphertext = await crypto.subtle.encrypt(
                { name: "AES-GCM", iv },
                key,
                encoded
            );
            return JSON.stringify({
                iv: btoa(String.fromCharCode.apply(null, iv)),
                data: btoa(String.fromCharCode.apply(null, new Uint8Array(ciphertext)))
            });
        },

        async aesDecrypt(payloadStr, key) {
            try {
                const payload = JSON.parse(payloadStr);
                const iv = Uint8Array.from(atob(payload.iv), function(c) { return c.charCodeAt(0); });
                const data = Uint8Array.from(atob(payload.data), function(c) { return c.charCodeAt(0); });
                const decrypted = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv },
                    key,
                    data
                );
                return new TextDecoder().decode(decrypted);
            } catch (e) {
                return null;
            }
        },

        async generateSigningKey() {
            return await crypto.subtle.generateKey(
                { name: "Ed25519" },
                true,
                ["sign", "verify"]
            );
        },

        async exportSigningKey(key) {
            const raw = await crypto.subtle.exportKey("raw", key);
            return btoa(String.fromCharCode.apply(null, new Uint8Array(raw)));
        },

        async importSigningKey(base64key, isPrivate) {
            const raw = Uint8Array.from(atob(base64key), function(c) { return c.charCodeAt(0); });
            return await crypto.subtle.importKey(
                "raw", raw,
                { name: "Ed25519" },
                false,
                isPrivate ? ["sign"] : ["verify"]
            );
        },

        async signData(data, privateKey) {
            const encoded = new TextEncoder().encode(data);
            const signature = await crypto.subtle.sign(
                { name: "Ed25519" },
                privateKey,
                encoded
            );
            return btoa(String.fromCharCode.apply(null, new Uint8Array(signature)));
        },

        async verifySignature(data, signatureB64, publicKey) {
            try {
                const encoded = new TextEncoder().encode(data);
                const signature = Uint8Array.from(atob(signatureB64), function(c) { return c.charCodeAt(0); });
                return await crypto.subtle.verify(
                    { name: "Ed25519" },
                    publicKey,
                    signature,
                    encoded
                );
            } catch (e) {
                return false;
            }
        }
    };

    // ===================== SherwoodAudio =====================
    const SherwoodAudio = {
        _pool: {},

        getAudio: function(filename, volume) {
            const vol = (volume !== undefined) ? volume : 0.5;
            if (!this._pool[filename]) {
                this._pool[filename] = new Audio('assets/sounds/' + filename);
            }
            const a = this._pool[filename];
            a.volume = vol;
            a.currentTime = 0;
            return a;
        },

        playSound: function(filename, volume) {
            this.getAudio(filename, volume).play().catch(function() {});
        },

        _ringtone: null,
        _ringback: null,

        playRingtone: function() {
            this.stopRingtone();
            this._ringtone = this.getAudio('melodi.mp3', 0.7);
            this._ringtone.loop = true;
            this._ringtone.play().catch(function() {});
        },

        stopRingtone: function() {
            if (this._ringtone) {
                this._ringtone.pause();
                this._ringtone.loop = false;
                this._ringtone = null;
            }
        },

        playRingback: function() {
            this.stopRingback();
            this._ringback = this.getAudio('Welk.mp3', 0.5);
            this._ringback.loop = true;
            this._ringback.play().catch(function() {});
        },

        stopRingback: function() {
            if (this._ringback) {
                this._ringback.pause();
                this._ringback.loop = false;
                this._ringback = null;
            }
        },

        playCallStart: function() {
            this.playSound('open.mp3', 0.7);
        },

        playCallEnd: function() {
            this.playSound('exet.mp3', 0.7);
        }
    };

    // ===================== SherwoodCall =====================
    function SherwoodCall(opts) {
        opts = opts || {};
        this._sendSignal = opts.sendSignal || function() {};
        this._onStatus = opts.onStatus || function() {};
        this._onTrack = opts.onTrack || function() {};
        this._onHangup = opts.onHangup || function() {};
        this._onFile = opts.onFile || function() {};
        this._enableVideo = opts.enableVideo === true;
        this._enableSRTP = opts.enableSRTP === true;

        this._peerConnections = {};
        this._localStreams = {};
        this._callActive = false;
        this._speakerOn = true;
        this._pendingIce = {};
        this._offerSdp = null;
        this._dataChannels = {};
        this._signingKey = null;
        this._meshPeers = {};
    }

    SherwoodCall.prototype._getIceServers = function() {
        return [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            {
                urls: [
                    "turn:openrelay.metered.ca:80?transport=tcp",
                    "turn:openrelay.metered.ca:443?transport=tcp"
                ],
                username: "openrelayproject",
                credential: "openrelayproject"
            }
        ];
    };

    SherwoodCall.prototype._getUserMedia = async function() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: this._enableVideo
            });
            return stream;
        } catch (e) {
            this._onStatus('❌ Нет доступа к микрофону/камере');
            return null;
        }
    };

    SherwoodCall.prototype._setupDataChannel = function(pc, callId) {
        const self = this;
        const dc = pc.createDataChannel('sherwood');
        this._dataChannels[callId] = dc;
        dc.onmessage = function(e) {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'file') {
                    self._onFile(msg);
                }
            } catch (err) {}
        };
        pc.ondatachannel = function(e) {
            self._dataChannels[callId] = e.channel;
            e.channel.onmessage = function(ev) {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.type === 'file') {
                        self._onFile(msg);
                    }
                } catch (err) {}
            };
        };
    };

    SherwoodCall.prototype._createPeerConn = function(stream, callId) {
        if (this._peerConnections[callId]) {
            this._peerConnections[callId].close();
            delete this._peerConnections[callId];
        }
        const pc = new RTCPeerConnection({
            iceServers: this._getIceServers(),
            iceTransportPolicy: 'all'
        });
        const self = this;

        if (stream) {
            stream.getTracks().forEach(function(t) {
                pc.addTrack(t, stream);
            });
        }

        pc.ontrack = function(e) {
            if (e.streams && e.streams[0]) {
                self._onTrack(e.streams[0], callId);
            }
        };

        pc.onicecandidate = function(e) {
            if (e.candidate) {
                self._sendSignal('__ICE__' + JSON.stringify({ candidate: e.candidate, callId: callId }));
            }
        };

        pc.oniceconnectionstatechange = function() {
            const state = pc.iceConnectionState;
            if (state === 'connected' || state === 'completed') {
                self._onStatus('✅ Разговор');
            }
            if (state === 'disconnected' || state === 'failed') {
                self._cleanupPeer(callId);
                if (callId === 'main') self.hangup();
            }
        };

        this._setupDataChannel(pc, callId);
        this._peerConnections[callId] = pc;
        return pc;
    };

    SherwoodCall.prototype._cleanupPeer = function(callId) {
        if (this._peerConnections[callId]) {
            this._peerConnections[callId].close();
            delete this._peerConnections[callId];
        }
        if (this._localStreams[callId]) {
            this._localStreams[callId].getTracks().forEach(function(t) { t.stop(); });
            delete this._localStreams[callId];
        }
        if (this._dataChannels[callId]) {
            this._dataChannels[callId].close();
            delete this._dataChannels[callId];
        }
        delete this._pendingIce[callId];
        delete this._meshPeers[callId];
    };

    SherwoodCall.prototype._flushIce = function(callId) {
        const pc = this._peerConnections[callId];
        if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
        const candidates = this._pendingIce[callId] || [];
        const self = this;
        while (candidates.length > 0) {
            const c = candidates.shift();
            try {
                pc.addIceCandidate(new RTCIceCandidate(c)).catch(function() {});
            } catch (e) {}
        }
    };

    SherwoodCall.prototype.addIceCandidate = function(candidateObj, callId) {
        const cId = callId || 'main';
        if (!this._pendingIce[cId]) this._pendingIce[cId] = [];
        this._pendingIce[cId].push(candidateObj);
        this._flushIce(cId);
    };

    // Начать звонок
    SherwoodCall.prototype.start = async function() {
        if (this._callActive) return;
        SherwoodAudio.playRingback();
        const stream = await this._getUserMedia();
        if (!stream) {
            SherwoodAudio.stopRingback();
            return;
        }
        this._localStreams['main'] = stream;
        this._createPeerConn(stream, 'main');
        const pc = this._peerConnections['main'];
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Отправляем объект с sdp и video
        this._sendSignal('__OFFER__' + JSON.stringify({ sdp: offer, video: this._enableVideo }));
        this._callActive = true;
        this._onStatus(this._enableVideo ? '📹 Видеовызов...' : '📞 Вызов...');
    };

    // Принять входящий
    SherwoodCall.prototype.accept = async function() {
        const sdp = this._offerSdp;
        if (!sdp) return;
        this._offerSdp = null;
        SherwoodAudio.stopRingtone();
        SherwoodAudio.playCallStart();
        this._onStatus('📞 Соединение...');
        const stream = await this._getUserMedia();
        if (!stream) {
            this.hangup();
            return;
        }
        this._localStreams['main'] = stream;
        this._createPeerConn(stream, 'main');
        const pc = this._peerConnections['main'];
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._sendSignal('__ANSWER__' + JSON.stringify(answer));
        this._callActive = true;
        this._flushIce('main');
    };

    // Обработать ANSWER
    SherwoodCall.prototype.handleAnswer = function(answerSdp) {
        const pc = this._peerConnections['main'];
        if (!pc) return;
        SherwoodAudio.stopRingback();
        this._onStatus('✅ Разговор');
        const self = this;
        pc.setRemoteDescription(new RTCSessionDescription(answerSdp))
            .then(function() { self._flushIce('main'); });
    };

    // Обработать входящий OFFER
    SherwoodCall.prototype.handleOffer = function(offerObj) {
        if (this._callActive) return false;
        // Извлекаем sdp и video
        this._offerSdp = offerObj.sdp || offerObj;
        if (offerObj.video !== undefined) {
            this._enableVideo = offerObj.video;
        }
        SherwoodAudio.playRingtone();
        this._onStatus(this._enableVideo ? '📹 Входящий видеовызов...' : '📞 Входящий вызов...');
        return true;
    };

    // Отклонить
    SherwoodCall.prototype.reject = function() {
        SherwoodAudio.stopRingtone();
        this._sendSignal('__HANGUP__');
        this._offerSdp = null;
        this._onStatus('📞 Вызов отклонён');
    };

    // Завершить
    SherwoodCall.prototype.hangup = function() {
        this._callActive = false;
        SherwoodAudio.stopRingtone();
        SherwoodAudio.stopRingback();
        SherwoodAudio.playCallEnd();
        this._sendSignal('__HANGUP__');
        const self = this;
        Object.keys(this._peerConnections).forEach(function(k) { self._cleanupPeer(k); });
        Object.keys(this._localStreams).forEach(function(k) {
            if (self._localStreams[k]) self._localStreams[k].getTracks().forEach(function(t) { t.stop(); });
        });
        this._localStreams = {};
        this._peerConnections = {};
        this._pendingIce = {};
        this._dataChannels = {};
        this._meshPeers = {};
        this._offerSdp = null;
        this._onHangup();
    };

    // Mesh: добавить пира
    SherwoodCall.prototype.addMeshPeer = async function(offerSdp, meshId) {
        const stream = this._localStreams['main'];
        if (!stream) return;
        const cId = meshId || ('mesh_' + Date.now());
        this._createPeerConn(stream, cId);
        const pc = this._peerConnections[cId];
        await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this._sendSignal('__MESH_ANSWER__' + JSON.stringify({ sdp: answer, meshId: cId }));
        this._flushIce(cId);
        this._meshPeers[cId] = true;
    };

    // Отправить файл
    SherwoodCall.prototype.sendFile = function(fileData, callId) {
        const cId = callId || 'main';
        const dc = this._dataChannels[cId];
        if (!dc || dc.readyState !== 'open') return false;
        dc.send(JSON.stringify(fileData));
        return true;
    };

    SherwoodCall.prototype.toggleSpeaker = function() {
        this._speakerOn = !this._speakerOn;
        return this._speakerOn;
    };

    SherwoodCall.prototype.isActive = function() {
        return this._callActive;
    };

    SherwoodCall.prototype.hasVideo = function() {
        return this._enableVideo;
    };

    SherwoodCall.prototype.setVideo = function(v) {
        this._enableVideo = v;
    };

    SherwoodCall.prototype.getLocalStream = function(callId) {
        return this._localStreams[callId || 'main'] || null;
    };

    // Экспорт
    global.SherwoodCrypto = SherwoodCrypto;
    global.SherwoodAudio = SherwoodAudio;
    global.SherwoodCall = SherwoodCall;

})(window);
