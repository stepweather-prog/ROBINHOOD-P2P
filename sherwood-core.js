/**
 * sherwood-core.js — Единый модуль RobinHood P2P v1.3.1
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
            if (!text) throw new Error('Text is required for SHA-256');
            const data = new TextEncoder().encode(text);
            const hash = await crypto.subtle.digest('SHA-256', data);
            return Array.from(new Uint8Array(hash))
                .map(function(b) { return b.toString(16).padStart(2, '0'); })
                .join('');
        },

        async generateAESKey() {
            return await crypto.subtle.generateKey(
                { name: "AES-GCM", length: 256 },
                true,
                ["encrypt", "decrypt"]
            );
        },

        async exportAESKey(key) {
            if (!key) throw new Error('Key is required for export');
            const raw = await crypto.subtle.exportKey("raw", key);
            return btoa(String.fromCharCode.apply(null, new Uint8Array(raw)));
        },

        async importAESKey(base64key) {
            if (!base64key) throw new Error('Base64 key is required for import');
            try {
                const raw = Uint8Array.from(atob(base64key), function(c) { return c.charCodeAt(0); });
                return await crypto.subtle.importKey(
                    "raw", raw,
                    { name: "AES-GCM" },
                    false,
                    ["encrypt", "decrypt"]
                );
            } catch (e) {
                console.error('Import AES key error:', e.message);
                return null;
            }
        },

        async aesEncrypt(plaintext, key) {
            if (!plaintext || !key) return null;
            try {
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
            } catch (e) {
                console.error('AES encrypt error:', e.message);
                return null;
            }
        },

        async aesDecrypt(payloadStr, key) {
            if (!payloadStr || !key) return null;
            try {
                const payload = JSON.parse(payloadStr);
                if (!payload.iv || !payload.data) return null;
                
                const iv = Uint8Array.from(atob(payload.iv), function(c) { return c.charCodeAt(0); });
                const data = Uint8Array.from(atob(payload.data), function(c) { return c.charCodeAt(0); });
                const decrypted = await crypto.subtle.decrypt(
                    { name: "AES-GCM", iv },
                    key,
                    data
                );
                return new TextDecoder().decode(decrypted);
            } catch (e) {
                console.error('AES decrypt error:', e.message);
                return null;
            }
        },

        async generateSigningKey() {
            // Примечание: Ed25519 может не поддерживаться во всех браузерах
            try {
                return await crypto.subtle.generateKey(
                    { name: "Ed25519" },
                    true,
                    ["sign", "verify"]
                );
            } catch (e) {
                console.warn('Ed25519 не поддерживается, используем ECDSA P-256');
                return await crypto.subtle.generateKey(
                    { name: "ECDSA", namedCurve: "P-256" },
                    true,
                    ["sign", "verify"]
                );
            }
        },

        async exportSigningKey(key) {
            if (!key) throw new Error('Key is required for export');
            const raw = await crypto.subtle.exportKey("raw", key);
            return btoa(String.fromCharCode.apply(null, new Uint8Array(raw)));
        },

        async importSigningKey(base64key, isPrivate) {
            if (!base64key) return null;
            try {
                const raw = Uint8Array.from(atob(base64key), function(c) { return c.charCodeAt(0); });
                // Пробуем Ed25519 сначала
                try {
                    return await crypto.subtle.importKey(
                        "raw", raw,
                        { name: "Ed25519" },
                        false,
                        isPrivate ? ["sign"] : ["verify"]
                    );
                } catch (e) {
                    // Fallback на ECDSA
                    return await crypto.subtle.importKey(
                        "raw", raw,
                        { name: "ECDSA", namedCurve: "P-256" },
                        false,
                        isPrivate ? ["sign"] : ["verify"]
                    );
                }
            } catch (e) {
                console.error('Import signing key error:', e.message);
                return null;
            }
        },

        async signData(data, privateKey) {
            if (!data || !privateKey) return null;
            try {
                const encoded = new TextEncoder().encode(data);
                const signature = await crypto.subtle.sign(
                    { name: privateKey.algorithm.name || "Ed25519" },
                    privateKey,
                    encoded
                );
                return btoa(String.fromCharCode.apply(null, new Uint8Array(signature)));
            } catch (e) {
                console.error('Sign data error:', e.message);
                return null;
            }
        },

        async verifySignature(data, signatureB64, publicKey) {
            if (!data || !signatureB64 || !publicKey) return false;
            try {
                const encoded = new TextEncoder().encode(data);
                const signature = Uint8Array.from(atob(signatureB64), function(c) { return c.charCodeAt(0); });
                return await crypto.subtle.verify(
                    { name: publicKey.algorithm.name || "Ed25519" },
                    publicKey,
                    signature,
                    encoded
                );
            } catch (e) {
                console.error('Verify signature error:', e.message);
                return false;
            }
        }
    };

    // ===================== SherwoodAudio =====================
    const SherwoodAudio = {
        _pool: {},
        _soundEnabled: true,

        setSoundEnabled: function(enabled) {
            this._soundEnabled = enabled;
        },

        getAudio: function(filename, volume) {
            const vol = (volume !== undefined) ? volume : 0.5;
            if (!this._pool[filename]) {
                const audio = new Audio('assets/sounds/' + filename);
                audio.preload = 'auto';
                this._pool[filename] = audio;
            }
            const a = this._pool[filename];
            a.volume = vol;
            a.currentTime = 0;
            return a;
        },

        playSound: function(filename, volume) {
            if (!this._soundEnabled) return;
            try {
                const audio = this.getAudio(filename, volume);
                audio.play().catch(function(e) {
                    console.warn('Audio play failed:', filename, e.message);
                });
            } catch (e) {
                console.error('Play sound error:', e.message);
            }
        },

        _ringtone: null,
        _ringback: null,

        playRingtone: function() {
            if (!this._soundEnabled) return;
            this.stopRingtone();
            try {
                this._ringtone = this.getAudio('melodi.mp3', 0.7);
                this._ringtone.loop = true;
                this._ringtone.play().catch(function() {});
            } catch (e) {
                console.error('Ringtone error:', e.message);
            }
        },

        stopRingtone: function() {
            if (this._ringtone) {
                try {
                    this._ringtone.pause();
                    this._ringtone.currentTime = 0;
                } catch (e) {}
                this._ringtone.loop = false;
                this._ringtone = null;
            }
        },

        playRingback: function() {
            if (!this._soundEnabled) return;
            this.stopRingback();
            try {
                this._ringback = this.getAudio('Welk.mp3', 0.5);
                this._ringback.loop = true;
                this._ringback.play().catch(function() {});
            } catch (e) {
                console.error('Ringback error:', e.message);
            }
        },

        stopRingback: function() {
            if (this._ringback) {
                try {
                    this._ringback.pause();
                    this._ringback.currentTime = 0;
                } catch (e) {}
                this._ringback.loop = false;
                this._ringback = null;
            }
        },

        playCallStart: function() {
            this.playSound('open.mp3', 0.7);
        },

        playCallEnd: function() {
            this.playSound('exet.mp3', 0.7);
        },

        // Очистка всех аудио ресурсов
        destroy: function() {
            this.stopRingtone();
            this.stopRingback();
            Object.keys(this._pool).forEach(function(key) {
                try {
                    const audio = this._pool[key];
                    audio.pause();
                    audio.src = '';
                    audio.load();
                } catch (e) {}
            }.bind(this));
            this._pool = {};
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
        this._incomingCall = false; // Флаг входящего звонка
        this._speakerOn = true;
        this._pendingIce = {};
        this._offerSdp = null;
        this._dataChannels = {};
        this._signingKey = null;
        this._meshPeers = {};
        this._config = {
            iceServers: opts.iceServers || this._getDefaultIceServers(),
            iceTransportPolicy: opts.iceTransportPolicy || 'all'
        };
    }

    SherwoodCall.prototype._getDefaultIceServers = function() {
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

    SherwoodCall.prototype._getIceServers = function() {
        return this._config.iceServers;
    };

    SherwoodCall.prototype._getUserMedia = async function() {
        try {
            const constraints = {
                audio: { 
                    echoCancellation: true, 
                    noiseSuppression: true, 
                    autoGainControl: true 
                },
                video: this._enableVideo ? {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 30 }
                } : false
            };
            
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            return stream;
        } catch (e) {
            this._onStatus('❌ Нет доступа к микрофону/камере');
            console.error('getUserMedia error:', e.message);
            return null;
        }
    };

    SherwoodCall.prototype._setupDataChannel = function(pc, callId) {
        const self = this;
        
        // Только создаём data channel если его ещё нет
        let dc;
        try {
            dc = pc.createDataChannel('sherwood', {
                ordered: true,
                maxRetransmits: 3
            });
        } catch (e) {
            console.error('Create data channel error:', e.message);
            return;
        }
        
        this._dataChannels[callId] = dc;
        
        dc.onopen = function() {
            console.log('Data channel opened for', callId);
        };
        
        dc.onclose = function() {
            console.log('Data channel closed for', callId);
            delete self._dataChannels[callId];
        };
        
        dc.onerror = function(e) {
            console.error('Data channel error for', callId, ':', e.message);
        };
        
        dc.onmessage = function(e) {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'file') {
                    self._onFile(msg);
                }
            } catch (err) {
                console.error('Data channel message parse error:', err.message);
            }
        };
        
        pc.ondatachannel = function(e) {
            const channel = e.channel;
            self._dataChannels[callId] = channel;
            
            channel.onopen = function() {
                console.log('Remote data channel opened for', callId);
            };
            
            channel.onclose = function() {
                console.log('Remote data channel closed for', callId);
                delete self._dataChannels[callId];
            };
            
            channel.onmessage = function(ev) {
                try {
                    const msg = JSON.parse(ev.data);
                    if (msg.type === 'file') {
                        self._onFile(msg);
                    }
                } catch (err) {
                    console.error('Remote data channel message parse error:', err.message);
                }
            };
        };
    };

    SherwoodCall.prototype._createPeerConn = function(stream, callId) {
        // Закрываем существующее соединение если есть
        if (this._peerConnections[callId]) {
            try {
                this._peerConnections[callId].close();
            } catch (e) {}
            delete this._peerConnections[callId];
        }
        
        const pc = new RTCPeerConnection({
            iceServers: this._getIceServers(),
            iceTransportPolicy: this._config.iceTransportPolicy
        });
        
        const self = this;

        if (stream) {
            stream.getTracks().forEach(function(t) {
                try {
                    pc.addTrack(t, stream);
                } catch (e) {
                    console.error('Add track error:', e.message);
                }
            });
        }

        pc.ontrack = function(e) {
            if (e.streams && e.streams[0]) {
                self._onTrack(e.streams[0], callId);
            }
        };

        pc.onicecandidate = function(e) {
            if (e.candidate) {
                try {
                    self._sendSignal('__ICE__' + JSON.stringify({ 
                        candidate: e.candidate, 
                        callId: callId 
                    }));
                } catch (err) {
                    console.error('Send ICE candidate error:', err.message);
                }
            }
        };

        pc.oniceconnectionstatechange = function() {
            const state = pc.iceConnectionState;
            console.log('ICE state for', callId, ':', state);
            
            if (state === 'connected' || state === 'completed') {
                self._onStatus('✅ Разговор');
            }
            if (state === 'disconnected' || state === 'failed') {
                console.warn('Connection', state, 'for', callId);
                self._cleanupPeer(callId);
                if (callId === 'main') self.hangup();
            }
        };

        pc.onconnectionstatechange = function() {
            console.log('Connection state for', callId, ':', pc.connectionState);
            
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                self._cleanupPeer(callId);
                if (callId === 'main') self.hangup();
            }
        };

        // Создаём data channel только для основного звонка
        if (callId === 'main' || this._meshPeers[callId]) {
            this._setupDataChannel(pc, callId);
        }
        
        this._peerConnections[callId] = pc;
        return pc;
    };

    SherwoodCall.prototype._cleanupPeer = function(callId) {
        if (this._peerConnections[callId]) {
            try {
                this._peerConnections[callId].close();
            } catch (e) {}
            delete this._peerConnections[callId];
        }
        if (this._localStreams[callId]) {
            try {
                this._localStreams[callId].getTracks().forEach(function(t) { 
                    t.stop(); 
                });
            } catch (e) {}
            delete this._localStreams[callId];
        }
        if (this._dataChannels[callId]) {
            try {
                this._dataChannels[callId].close();
            } catch (e) {}
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
        
        // Копируем массив и очищаем
        const toProcess = [...candidates];
        this._pendingIce[callId] = [];
        
        toProcess.forEach(function(c) {
            try {
                pc.addIceCandidate(new RTCIceCandidate(c)).catch(function(err) {
                    console.error('Add ICE candidate error:', err.message);
                    // Возвращаем кандидата в очередь если не удалось добавить
                    if (!self._pendingIce[callId]) self._pendingIce[callId] = [];
                    self._pendingIce[callId].push(c);
                });
            } catch (e) {
                console.error('Process ICE candidate error:', e.message);
            }
        });
    };

    SherwoodCall.prototype.addIceCandidate = function(candidateObj, callId) {
        const cId = callId || 'main';
        if (!this._pendingIce[cId]) this._pendingIce[cId] = [];
        this._pendingIce[cId].push(candidateObj);
        this._flushIce(cId);
    };

    // Начать звонок
    SherwoodCall.prototype.start = async function() {
        if (this._callActive) {
            console.warn('Call already active');
            return false;
        }
        
        SherwoodAudio.playRingback();
        const stream = await this._getUserMedia();
        if (!stream) {
            SherwoodAudio.stopRingback();
            return false;
        }
        
        this._localStreams['main'] = stream;
        this._createPeerConn(stream, 'main');
        const pc = this._peerConnections['main'];
        
        if (!pc) {
            SherwoodAudio.stopRingback();
            return false;
        }
        
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._sendSignal('__OFFER__' + JSON.stringify({ 
                sdp: offer, 
                video: this._enableVideo 
            }));
            this._callActive = true;
            this._incomingCall = false;
            this._onStatus(this._enableVideo ? '📹 Видеовызов...' : '📞 Вызов...');
            return true;
        } catch (e) {
            console.error('Start call error:', e.message);
            SherwoodAudio.stopRingback();
            this._cleanupPeer('main');
            return false;
        }
    };

    // Принять входящий
    SherwoodCall.prototype.accept = async function() {
        const sdp = this._offerSdp;
        if (!sdp) {
            console.error('No offer SDP to accept');
            return false;
        }
        this._offerSdp = null;
        
        SherwoodAudio.stopRingtone();
        SherwoodAudio.playCallStart();
        this._onStatus('📞 Соединение...');
        
        const stream = await this._getUserMedia();
        if (!stream) {
            this.hangup();
            return false;
        }
        
        this._localStreams['main'] = stream;
        this._createPeerConn(stream, 'main');
        const pc = this._peerConnections['main'];
        
        if (!pc) {
            this.hangup();
            return false;
        }
        
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this._sendSignal('__ANSWER__' + JSON.stringify(answer));
            this._callActive = true;
            this._incomingCall = true;
            this._flushIce('main');
            return true;
        } catch (e) {
            console.error('Accept call error:', e.message);
            this.hangup();
            return false;
        }
    };

    // Обработать ANSWER
    SherwoodCall.prototype.handleAnswer = function(answerSdp) {
        const pc = this._peerConnections['main'];
        if (!pc) {
            console.error('No peer connection for answer');
            return;
        }
        
        SherwoodAudio.stopRingback();
        this._onStatus('✅ Разговор');
        
        const self = this;
        pc.setRemoteDescription(new RTCSessionDescription(answerSdp))
            .then(function() { 
                self._flushIce('main'); 
            })
            .catch(function(err) {
                console.error('Handle answer error:', err.message);
                self.hangup();
            });
    };

    // Обработать входящий OFFER
    SherwoodCall.prototype.handleOffer = function(offerObj) {
        if (this._callActive) {
            console.warn('Call already active, cannot handle offer');
            return false;
        }
        
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
        const wasActive = this._callActive;
        this._callActive = false;
        this._incomingCall = false;
        
        SherwoodAudio.stopRingtone();
        SherwoodAudio.stopRingback();
        
        if (wasActive) {
            SherwoodAudio.playCallEnd();
        }
        
        this._sendSignal('__HANGUP__');
        
        const self = this;
        Object.keys(this._peerConnections).forEach(function(k) { 
            self._cleanupPeer(k); 
        });
        
        Object.keys(this._localStreams).forEach(function(k) {
            if (self._localStreams[k]) {
                try {
                    self._localStreams[k].getTracks().forEach(function(t) { 
                        t.stop(); 
                    });
                } catch (e) {}
            }
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
        if (!stream) {
            console.error('No local stream for mesh peer');
            return null;
        }
        
        const cId = meshId || ('mesh_' + Date.now());
        
        try {
            this._createPeerConn(stream, cId);
            const pc = this._peerConnections[cId];
            
            if (!pc) {
                throw new Error('Failed to create peer connection');
            }
            
            await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            
            this._sendSignal('__MESH_ANSWER__' + JSON.stringify({ 
                sdp: answer, 
                meshId: cId 
            }));
            
            this._flushIce(cId);
            this._meshPeers[cId] = true;
            
            return cId;
        } catch (e) {
            console.error('Add mesh peer error:', e.message);
            this._cleanupPeer(cId);
            return null;
        }
    };

    // Отправить файл
    SherwoodCall.prototype.sendFile = function(fileData, callId) {
        const cId = callId || 'main';
        const dc = this._dataChannels[cId];
        
        if (!dc || dc.readyState !== 'open') {
            console.error('Data channel not ready for', cId);
            return false;
        }
        
        try {
            dc.send(JSON.stringify(fileData));
            return true;
        } catch (e) {
            console.error('Send file error:', e.message);
            return false;
        }
    };

    SherwoodCall.prototype.toggleSpeaker = function() {
        this._speakerOn = !this._speakerOn;
        // Здесь можно добавить логику переключения динамика
        return this._speakerOn;
    };

    SherwoodCall.prototype.isActive = function() {
        return this._callActive;
    };

    SherwoodCall.prototype.isIncoming = function() {
        return this._incomingCall;
    };

    SherwoodCall.prototype.hasVideo = function() {
        return this._enableVideo;
    };

    SherwoodCall.prototype.setVideo = function(v) {
        this._enableVideo = !!v;
    };

    SherwoodCall.prototype.getLocalStream = function(callId) {
        return this._localStreams[callId || 'main'] || null;
    };

    SherwoodCall.prototype.getPeerConnection = function(callId) {
        return this._peerConnections[callId || 'main'] || null;
    };

    SherwoodCall.prototype.destroy = function() {
        this.hangup();
        this._onStatus = function() {};
        this._onTrack = function() {};
        this._onHangup = function() {};
        this._onFile = function() {};
    };

    // Экспорт
    global.SherwoodCrypto = SherwoodCrypto;
    global.SherwoodAudio = SherwoodAudio;
    global.SherwoodCall = SherwoodCall;

})(window);
