// robinhood-ui.js 
let contacts = [],
    activeChannelId = null,
    activePeerId = null,
    selectedAvatar = '001';
let toggleSoundState = true,
    toggleAnimations = true,
    selfDestructMode = false;
let ringtoneAudio = null,
    ringbackAudio = null;
let audioPool = {},
    robinDefaultText = 'Слепой Улей активирован! Святые сокеты стабильны!',
    robinTimer = null;
let voiceRecorder = null,
    voiceChunks = [],
    voiceStream = null,
    voiceRecording = false,
    voiceSeconds = 0,
    voiceTimerInterval = null,
    voiceRecTimeout = null;
let archerAnimation, quiverAnim, bowAnim, currentArrowContainer;
let callArcherAnimation, callArrowContainer;
let deferredPrompt = null;
let hangInProgress = false;
let verificationModalShown = false;
let verificationDone = false;
let verifyInProgress = false;

let selfDestructBatchSize = 5;
let selfDestructIntervalTime = 20000;
let selfDestructIntervalId = null;

let bands = [];
let activeBandId = null;
let pendingBandData = null;

const MAX_CHAT_MESSAGES = 100;

let sharedAudioContext = null;
function getAudioContext() {
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
        sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (sharedAudioContext.state === 'suspended') {
        sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
}

function isMobile() {
    return /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || window.innerWidth < 768;
}

const avatars = [];
for (let i = 1; i <= 168; i++) avatars.push('assets/avatar/' + String(i).padStart(3, '0') + 'ava.png');

function throttle(fn, delay) { let last = 0; return function(...args) { const now = Date.now(); if (now - last >= delay) { last = now; fn.apply(this, args); } }; }
function safeHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function rMsg(t, d = 4000) { const rt = document.getElementById('robin-text'); if (!rt) return; clearTimeout(robinTimer); rt.textContent = t; if (d > 0) robinTimer = setTimeout(() => { rt.textContent = robinDefaultText; }, d); }
function setConnectionStatus(s) { const ic = document.getElementById('connection-icon'); if (ic) ic.src = s === 'online' ? 'assets/icons/06icon.png' : 'assets/icons/05icon.png'; }
function playSound(f) { if (!toggleSoundState) return; if (!audioPool[f]) { audioPool[f] = new Audio('assets/sounds/' + f); audioPool[f].volume = 0.5; audioPool[f].preload = 'auto'; } const a = audioPool[f]; a.currentTime = 0; a.play().catch(e => {}); }
function closeSheets() { document.getElementById('avatar-selector')?.classList.remove('show'); document.getElementById('settings-sheet')?.classList.remove('open'); document.getElementById('overlay')?.classList.remove('show'); }

function playSmokeAnimation() { if (!toggleAnimations) return; const smoke = document.createElement('div'); smoke.className = 'smoke-anim'; document.body.appendChild(smoke); if (typeof lottie !== 'undefined') { try { lottie.loadAnimation({ container: smoke, renderer: 'canvas', loop: false, autoplay: true, path: 'assets/smoke.json' }); } catch (e) {} } setTimeout(() => { if (smoke.parentNode) smoke.remove(); }, 5000); }

function playArcherAnimation() {
    if (!toggleAnimations) return;
    const rt = document.getElementById('robin-text');
    if (!rt) return;
    if (currentArrowContainer?.parentNode) currentArrowContainer.remove();
    if (archerAnimation) { archerAnimation.destroy(); archerAnimation = null; }
    const wrapper = document.createElement('span');
    wrapper.className = 'robin-arrow-container';
    wrapper.style.cssText = 'width:120px;height:60px;display:inline-block;vertical-align:middle;';
    currentArrowContainer = wrapper;
    rt.textContent = '';
    rt.appendChild(wrapper);
    if (typeof lottie !== 'undefined') {
        try { archerAnimation = lottie.loadAnimation({ container: wrapper, renderer: 'canvas', loop: false, autoplay: true, path: 'assets/Archer.json' });
            archerAnimation.addEventListener('complete', () => { if (wrapper.parentNode) wrapper.remove(); currentArrowContainer = null; archerAnimation = null; rt.textContent = robinDefaultText; });
        } catch (e) { wrapper.textContent = '🏹'; wrapper.style.fontSize = '40px'; setTimeout(() => { if (wrapper.parentNode) wrapper.remove(); currentArrowContainer = null; rt.textContent = robinDefaultText; }, 1500); }
    } else { wrapper.textContent = '🏹'; wrapper.style.fontSize = '40px'; setTimeout(() => { if (wrapper.parentNode) wrapper.remove(); currentArrowContainer = null; rt.textContent = robinDefaultText; }, 1500); }
}

function playCallArcherAnimation() { if (!toggleAnimations) return; const callPanel = document.getElementById('call-panel'); if (!callPanel) return; stopCallArcherAnimation(); const wrapper = document.createElement('div'); wrapper.style.cssText = 'width:200px;height:100px;margin:0 auto;position:relative;z-index:1;'; callArrowContainer = wrapper; const statusEl = document.getElementById('call-status'); if (statusEl) { statusEl.parentNode.insertBefore(wrapper, statusEl); } else { callPanel.appendChild(wrapper); } if (typeof lottie !== 'undefined') { try { callArcherAnimation = lottie.loadAnimation({ container: wrapper, renderer: 'canvas', loop: true, autoplay: true, path: 'assets/Archer.json' }); } catch (e) { wrapper.textContent = '🏹'; wrapper.style.cssText += 'font-size:60px;display:flex;align-items:center;justify-content:center;'; } } else { wrapper.textContent = '🏹'; wrapper.style.cssText += 'font-size:60px;display:flex;align-items:center;justify-content:center;'; } }
function stopCallArcherAnimation() { if (callArrowContainer?.parentNode) callArrowContainer.remove(); callArrowContainer = null; if (callArcherAnimation) { callArcherAnimation.destroy(); callArcherAnimation = null; } }

function playQuiverAnimation() { 
    if (!toggleAnimations) return; 
    const quiver = document.createElement('div'); 
    quiver.className = 'quiver-anim'; 
    const img = document.createElement('img'); 
    img.src = 'assets/docking.gif?t=' + Date.now(); 
    img.style.cssText = 'width:min(200px,40vw);height:min(200px,40vw);object-fit:contain;filter:drop-shadow(0 0 20px rgba(255,215,0,0.8));'; 
    img.loading = 'lazy'; 
    img.onerror = () => { quiver.innerHTML = '<div style="font-size:min(120px,25vw);animation:quiverPulse 0.5s ease-in-out 7;">🏹</div>'; }; 
    quiver.appendChild(img); 
    document.body.appendChild(quiver); 
    setTimeout(() => { quiver.style.opacity = '0'; quiver.style.transition = 'opacity 0.5s ease'; setTimeout(() => quiver.remove(), 500); }, 3500); 
}

function showInput(title, placeholder = '') { return new Promise((resolve) => { document.getElementById('input-modal-title').textContent = title; document.getElementById('input-modal-field').value = ''; document.getElementById('input-modal-field').placeholder = placeholder; document.getElementById('input-modal')?.classList.add('active'); const ok = () => { const val = document.getElementById('input-modal-field').value.trim(); document.getElementById('input-modal')?.classList.remove('active'); cleanup(); resolve(val); }; const cancel = () => { document.getElementById('input-modal')?.classList.remove('active'); cleanup(); resolve(null); }; const cleanup = () => { document.getElementById('input-modal-ok').removeEventListener('click', ok); document.getElementById('input-modal-cancel').removeEventListener('click', cancel); document.getElementById('input-modal-field').removeEventListener('keypress', onKey); }; const onKey = (e) => { if (e.key === 'Enter') ok(); }; document.getElementById('input-modal-ok').addEventListener('click', ok); document.getElementById('input-modal-cancel').addEventListener('click', cancel); document.getElementById('input-modal-field').addEventListener('keypress', onKey); document.getElementById('input-modal-field').focus(); }); }
function showConfirm(title, text) { return new Promise((resolve) => { document.getElementById('confirm-modal-title').textContent = title; document.getElementById('confirm-modal-text').textContent = text; document.getElementById('confirm-modal')?.classList.add('active'); const yes = () => { document.getElementById('confirm-modal')?.classList.remove('active'); cleanup(); resolve(true); }; const no = () => { document.getElementById('confirm-modal')?.classList.remove('active'); cleanup(); resolve(false); }; const cleanup = () => { document.getElementById('confirm-modal-yes').removeEventListener('click', yes); document.getElementById('confirm-modal-no').removeEventListener('click', no); }; document.getElementById('confirm-modal-yes').addEventListener('click', yes); document.getElementById('confirm-modal-no').addEventListener('click', no); }); }

function startSelfDestruct() {
    stopSelfDestruct();
    selfDestructIntervalId = setInterval(() => {
        const box = document.getElementById('chat-box');
        if (!box) return;
        const allMessages = box.querySelectorAll('.message-row');
        const totalMessages = allMessages.length;
        if (totalMessages === 0) { stopSelfDestruct(); return; }
        const deleteCount = Math.min(selfDestructBatchSize, totalMessages);
        const startIndex = totalMessages - deleteCount;
        for (let i = startIndex; i < totalMessages; i++) {
            const el = allMessages[i];
            if (el && el.parentNode) {
                const msgId = el.dataset.msgId;
                if (msgId && P2PPong._dedupTimers) {
                    for (const key in P2PPong._dedupTimers) {
                        if (key.includes(msgId)) {
                            clearTimeout(P2PPong._dedupTimers[key]);
                            delete P2PPong._dedupTimers[key];
                        }
                    }
                }
                el.style.transition = 'opacity 0.5s';
                el.style.opacity = '0';
                setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
            }
        }
        if (box.querySelectorAll('.message-row').length === 0) stopSelfDestruct();
    }, selfDestructIntervalTime);
    document.getElementById('leaves-container')?.classList.remove('sleeping');
}

function stopSelfDestruct() {
    if (selfDestructIntervalId) {
        clearInterval(selfDestructIntervalId);
        selfDestructIntervalId = null;
    }
    if (P2PPong._dedupTimers) {
        for (const key in P2PPong._dedupTimers) {
            clearTimeout(P2PPong._dedupTimers[key]);
        }
        P2PPong._dedupTimers = {};
    }
    if (activeChannelId && P2PPong._channels[activeChannelId]) {
        P2PPong._channels[activeChannelId].blobs = [];
    }
    document.getElementById('leaves-container')?.classList.add('sleeping');
}

function showCallWave(show) { const cw = document.getElementById('call-wave'); if (!cw) return; if (show) { cw.innerHTML = ''; cw.style.display = 'flex'; for (let i = 0; i < 4; i++) { const bar = document.createElement('div'); bar.className = 'voice-wave-bar'; bar.style.cssText = `animation:voiceWaveAnim 0.5s ease-in-out infinite;animation-delay:${i * 0.15}s;`; cw.appendChild(bar); } } else { cw.style.display = 'none'; cw.innerHTML = ''; } }
function showVoiceRecordingUI(show) { const old = document.getElementById('voice-recording-indicator'); if (old) old.remove(); if (!show) return; const btn = document.getElementById('btn-voice-input'); if (!btn) return; const container = document.createElement('div'); container.id = 'voice-recording-indicator'; container.className = 'voice-recording-indicator'; const timer = document.createElement('span'); timer.className = 'voice-timer-text'; timer.id = 'voice-timer-text'; timer.textContent = '🎤 0:00'; const wave = document.createElement('div'); wave.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:18px;'; for (let i = 0; i < 4; i++) { const bar = document.createElement('div'); bar.className = 'voice-wave-bar'; bar.style.cssText = `width:3px;animation:voiceWaveAnim 0.5s ease-in-out infinite;animation-delay:${i * 0.1}s;height:${6 + i * 3}px;`; wave.appendChild(bar); } container.appendChild(timer); container.appendChild(wave); btn.parentNode.insertBefore(container, btn); }
function showIncomingControls(show) { const ic = document.getElementById('incoming-call-controls'); if (ic) ic.style.display = show ? 'flex' : 'none'; }
function showActiveControls(show) { const ac = document.getElementById('active-call-controls'); if (ac) ac.style.display = show ? 'flex' : 'none'; }
function updateCallButtonState() { const btn = document.getElementById('btn-call'); if (!btn) return; btn.classList.remove('calling', 'ringing'); const callState = P2PPong.getCallState(); if (callState === 'active' || callState === 'calling') btn.classList.add('calling'); else if (callState === 'ringing') btn.classList.add('ringing'); }
function playRingtone() { stopRingtone(); ringtoneAudio = new Audio('assets/sounds/melodi.mp3'); ringtoneAudio.loop = true; ringtoneAudio.volume = 0.5; ringtoneAudio.play().catch(e => {}); }
function stopRingtone() { if (ringtoneAudio) { ringtoneAudio.pause(); ringtoneAudio.loop = false; ringtoneAudio = null; } }
function playRingback() { stopRingback(); ringbackAudio = new Audio('assets/sounds/Welk.mp3'); ringbackAudio.loop = true; ringbackAudio.volume = 0.5; ringbackAudio.play().catch(e => {}); }
function stopRingback() { if (ringbackAudio) { ringbackAudio.pause(); ringbackAudio.loop = false; ringbackAudio = null; } }

function startVoiceTimer() { voiceSeconds = 0; const vt = document.getElementById('voice-timer-text'); if (vt) vt.textContent = '🎤 0:00'; voiceTimerInterval = setInterval(() => { voiceSeconds++; const m = Math.floor(voiceSeconds / 60), s = (voiceSeconds % 60).toString().padStart(2, '0'); const vt = document.getElementById('voice-timer-text'); if (vt) vt.textContent = '🎤 ' + m + ':' + s; }, 1000); }
function stopVoiceTimer() { if (voiceTimerInterval) clearInterval(voiceTimerInterval); }
function toggleVoiceRecording() { voiceRecording ? stopVoiceRecording() : startVoiceRecording(); }

function startVoiceRecording() {
    if (voiceRecorder?.state === 'recording') return;
    
    navigator.mediaDevices.getUserMedia({ 
        audio: { 
            echoCancellation: true, 
            noiseSuppression: true
        } 
    }).then(st => {
        voiceStream = st;
        
        let mimeType = 'audio/webm; codecs=opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
            mimeType = 'audio/webm';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'audio/mp4';
                if (!MediaRecorder.isTypeSupported(mimeType)) {
                    mimeType = '';
                }
            }
        }
        
        const recorderOptions = mimeType ? { mimeType } : {};
        voiceRecorder = new MediaRecorder(st, recorderOptions);
        voiceChunks = [];
        
        voiceRecorder.ondataavailable = e => {
            if (e.data.size > 0) voiceChunks.push(e.data);
        };
        
        voiceRecorder.onstop = () => {
            if (voiceRecTimeout) clearTimeout(voiceRecTimeout);
            
            const blob = new Blob(voiceChunks, { type: mimeType || 'audio/webm' });
            
            if (blob.size > 100 && blob.size < 100000 && (activeChannelId || Object.keys(P2PPong._channels).length > 0)) {
                const reader = new FileReader();
                reader.onload = async () => {
                    const b64 = reader.result.split(',')[1];
                    const chId = activeChannelId || Object.keys(P2PPong._channels)[0];
                    const sent = await P2PPong.sendVoiceMessage(chId, b64);
                    if (sent) {
                        appendMessage('Вы', '🎤 Голосовое', selectedAvatar, b64, 'audio/webm');
                    }
                };
                reader.readAsDataURL(blob);
            }
            
            if (voiceStream) {
                voiceStream.getTracks().forEach(t => t.stop());
                voiceStream = null;
            }
            voiceRecorder = null;
            voiceRecording = false;
            stopVoiceTimer();
            const voiceBtn = document.getElementById('btn-voice-input');
            if (voiceBtn) voiceBtn.style.background = '';
            showVoiceRecordingUI(false);
        };
        
        voiceRecorder.start();
        voiceRecording = true;
        startVoiceTimer();
        
        const voiceBtn = document.getElementById('btn-voice-input');
        if (voiceBtn) voiceBtn.style.background = '#f44336';
        showVoiceRecordingUI(true);
        
        voiceRecTimeout = setTimeout(() => {
            if (voiceRecorder?.state === 'recording') {
                voiceRecorder.stop();
                rMsg('⏰ Максимальная длина записи — 10 секунд', 3000);
            }
        }, 10000);
        
    }).catch(e => {
        voiceChunks = [];
        rMsg('❌ Микрофон недоступен или занят', 3000);
    });
}

function stopVoiceRecording() { 
    if (voiceRecorder?.state === 'recording') voiceRecorder.stop(); 
}

function playVoiceBlob(b64) { 
    const a = new Audio('data:audio/webm;base64,' + b64); 
    a.load(); 
    a.play().catch(e => {}); 
}

function appendMessage(sender, text, avatarSrc, audioData, audioMime) { 
    const box = document.getElementById('chat-box'); 
    const row = document.createElement('div'); 
    row.className = 'message-row'; 
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); 
    const av = getAvatarUrl(avatarSrc); 
    const safeSender = safeHtml(sender); 
    
    if (audioData && audioMime && audioMime.startsWith('audio/')) { 
        const player = createAudioPlayer(audioData, audioMime); 
        row.innerHTML = `<img src="${av}" class="avatar" onerror="this.src='assets/avatar/001ava.png'" loading="lazy"><div class="msg-body"><div class="msg-sender">${safeSender}</div></div>`; 
        row.querySelector('.msg-body').appendChild(player); 
        const ts = document.createElement('div'); 
        ts.className = 'msg-status'; 
        ts.textContent = time; 
        row.querySelector('.msg-body').appendChild(ts); 
    } else { 
        row.innerHTML = `<img src="${av}" class="avatar" onerror="this.src='assets/avatar/001ava.png'" loading="lazy"><div class="msg-body"><div class="msg-sender">${safeSender}</div><div style="word-break:break-word;white-space:pre-wrap;">${safeHtml(text)}</div><div class="msg-status">${time}</div></div>`; 
    } 
    
    const msgId = 'msg_' + Date.now() + Math.random(); 
    row.dataset.msgId = msgId; 
    box.insertBefore(row, document.getElementById('typing-indicator')); 
    const allRows = box.querySelectorAll('.message-row'); 
    while (allRows.length > MAX_CHAT_MESSAGES) { 
        const firstRow = allRows[0]; 
        if (firstRow && firstRow.parentNode) firstRow.remove(); 
    } 
    box.scrollTop = box.scrollHeight; 
}

function createAudioPlayer(audioData, audioMime) { 
    const container = document.createElement('div'); 
    container.className = 'audio-player audio-paused'; 
    const audio = new Audio('data:' + audioMime + ';base64,' + audioData); 
    audio.load(); 
    let isPlaying = false; 
    
    const playBtn = document.createElement('button'); 
    playBtn.className = 'audio-play-btn'; 
    playBtn.textContent = '▶'; 
    
    const waveDiv = document.createElement('div'); 
    waveDiv.className = 'audio-wave'; 
    for (let i = 0; i < 4; i++) { 
        const bar = document.createElement('div'); 
        bar.className = 'audio-wave-bar'; 
        waveDiv.appendChild(bar); 
    } 
    
    const timeSpan = document.createElement('span'); 
    timeSpan.className = 'audio-time'; 
    timeSpan.textContent = '0:00'; 
    
    playBtn.addEventListener('click', () => { 
        if (isPlaying) { 
            audio.pause(); 
            container.classList.remove('audio-playing'); 
            container.classList.add('audio-paused'); 
            playBtn.textContent = '▶'; 
        } else { 
            audio.play(); 
            container.classList.remove('audio-paused'); 
            container.classList.add('audio-playing'); 
            playBtn.textContent = '⏸'; 
        } 
        isPlaying = !isPlaying; 
    }); 
    
    audio.addEventListener('timeupdate', () => { 
        const m = Math.floor(audio.currentTime / 60); 
        const s = Math.floor(audio.currentTime % 60).toString().padStart(2, '0'); 
        timeSpan.textContent = m + ':' + s; 
    }); 
    
    audio.addEventListener('ended', () => { 
        container.classList.remove('audio-playing'); 
        container.classList.add('audio-paused'); 
        playBtn.textContent = '▶'; 
        isPlaying = false; 
    }); 
    
    container.appendChild(playBtn); 
    container.appendChild(waveDiv); 
    container.appendChild(timeSpan); 
    return container; 
}

function showChatForChannel(channelId) { 
    activeChannelId = channelId; 
    activeBandId = null; 
    const ct = contacts.find(c => c.channelId === channelId); 
    if (ct) { activePeerId = ct.peerId; } 
    const box = document.getElementById('chat-box'); 
    box.innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; 
    const ch = P2PPong._channels[channelId]; 
    if (ch && ch.blobs) { 
        ch.blobs.forEach(b => { 
            const im = b.from === 'me'; 
            const ct2 = contacts.find(c => c.channelId === channelId); 
            const senderName = im ? 'Вы' : (ct2?.name || 'Лучник'); 
            const avatar = im ? selectedAvatar : (ct2?.avatar || '001'); 
            
            if (b.voiceData) {
                appendMessage(senderName, '🎤 Голосовое', avatar, b.voiceData, 'audio/webm');
            } else {
                appendMessage(senderName, b.d || b.text || '', avatar);
            }
        }); 
    } 
    updateCupIndicator(); 
    updateRatchetIndicator(); 
}

function getAvatarUrl(avatarSrc) { 
    if (!avatarSrc || avatarSrc === '001') return 'assets/avatar/001ava.png'; 
    if (avatarSrc.startsWith('assets/')) return avatarSrc.endsWith('.png') ? avatarSrc : avatarSrc + 'ava.png'; 
    if (avatarSrc.includes('/')) return avatarSrc.endsWith('.png') ? avatarSrc : avatarSrc + 'ava.png'; 
    return 'assets/avatar/' + avatarSrc + 'ava.png'; 
}

function addContact(c) { 
    if (!contacts.find(x => x.peerId === c.peerId)) { 
        contacts.push(c); 
        saveContacts(); 
    } else { 
        const existing = contacts.find(x => x.peerId === c.peerId); 
        if (c.name && c.name !== 'Лучник') existing.name = c.name; 
        if (c.avatar && c.avatar !== '001') existing.avatar = c.avatar; 
        if (c.channelId) existing.channelId = c.channelId; 
        saveContacts(); 
    } 
}

function saveContacts() { try { localStorage.setItem('rh_contacts', JSON.stringify(contacts)); } catch (e) {} }
function loadContacts() { try { const r = localStorage.getItem('rh_contacts'); if (r) contacts = JSON.parse(r); } catch (e) {} }

// Bands functions — оставлены без изменений
function createBand(bandId, name, password = null) { /* без изменений */ }
function joinBand(bandId, password = null) { /* без изменений */ }
function showBandChat(bandId) { /* без изменений */ }
function showBandsList() { /* без изменений */ }
function updateCupIndicator() { /* без изменений */ }
function updateRatchetIndicator() { /* без изменений */ }

// Themes — без изменений
const themes = [/* ... */];
function applyTheme(id) { /* без изменений */ }
function generateRandomTheme() { /* без изменений */ }
function loadAvatars() { /* без изменений */ }

// === Call system — теперь использует P2PPong ===

async function startCall() {
    const callState = P2PPong.getCallState();
    if (callState !== 'idle') {
        if (callState === 'active') {
            P2PPong.endCall(true);
        }
        return;
    }
    
    if (!activeChannelId && Object.keys(P2PPong._channels).length === 0) {
        rMsg('❌ Нет канала', 3000);
        return;
    }
    
    const callPanel = document.getElementById('call-panel');
    if (callPanel) callPanel.style.display = 'flex';
    
    const ct = contacts.find(c => c.channelId === (activeChannelId || Object.keys(P2PPong._channels)[0]));
    const contactName = ct?.name || 'Лучник';
    const contactAvatar = ct?.avatar || selectedAvatar;
    document.getElementById('call-avatar').src = 'assets/avatar/' + contactAvatar + 'ava.png';
    document.getElementById('call-contact-name').textContent = contactName;
    document.getElementById('call-status').textContent = '📞 Вызов...';
    showIncomingControls(false);
    showActiveControls(true);
    showCallWave(false);
    playRingback();
    playCallArcherAnimation();
    
    const success = await P2PPong.startCall();
    if (!success) {
        stopRingback();
        stopCallArcherAnimation();
        if (callPanel) callPanel.style.display = 'none';
        rMsg('❌ Не удалось начать звонок', 3000);
    }
    
    updateCallButtonState();
}

async function acceptCall() {
    stopRingtone();
    stopRingback();
    
    const callPanel = document.getElementById('call-panel');
    if (callPanel) callPanel.style.display = 'flex';
    
    const ct = contacts.find(c => c.channelId === (activeChannelId || Object.keys(P2PPong._channels)[0]));
    const contactName = ct?.name || 'Лучник';
    const contactAvatar = ct?.avatar || selectedAvatar;
    document.getElementById('call-avatar').src = 'assets/avatar/' + contactAvatar + 'ava.png';
    document.getElementById('call-contact-name').textContent = contactName;
    document.getElementById('call-status').textContent = '📞 Соединение...';
    showIncomingControls(false);
    showActiveControls(true);
    showCallWave(false);
    
    const success = await P2PPong.acceptCall();
    if (!success) {
        stopCallArcherAnimation();
        if (callPanel) callPanel.style.display = 'none';
        rMsg('❌ Не удалось принять звонок', 3000);
    }
    
    updateCallButtonState();
}

function hang(sendSignal = true) {
    if (hangInProgress) return;
    hangInProgress = true;
    
    stopRingtone();
    stopRingback();
    stopCallArcherAnimation();
    
    P2PPong.endCall(sendSignal);
    
    const callPanel = document.getElementById('call-panel');
    if (callPanel) callPanel.style.display = 'none';
    showIncomingControls(false);
    showActiveControls(false);
    showCallWave(false);
    playSound('exet.mp3');
    updateCallButtonState();
    
    hangInProgress = false;
}

// === End Call System ===

function handleIncomingMessage(data) {
    if (!data || !data.text) return;
    
    try {
        const parsed = JSON.parse(data.text);
        
        if (parsed.type === 'channel-destroyed') {
            playSmokeAnimation();
            playSound('clear cache.mp3');
            rMsg('🔥 Создатель скурил колчан! Связь потеряна.', 5000);
            if (parsed.channelId) delete P2PPong._channels[parsed.channelId];
            resetChatUI();
            return;
        }
        
        if (parsed.band === 'band-destroyed') {
            playSmokeAnimation();
            playSound('clear cache.mp3');
            rMsg('🔥 Соколиный Глаз скурил шайку! Все разбежались!', 5000);
            bands = bands.filter(b => b.id !== parsed.bandId);
            resetChatUI();
            return;
        }
        
        if (parsed.band) { handleBandMessage(parsed, data); return; }
        
        // Call signals are handled by P2PPong
        if (parsed.type?.startsWith('call-')) return;
        
        if (parsed.d === '__SMOKE__') {
            selfDestructMode = true;
            const sd = document.getElementById('toggle-selfdestruct');
            if (sd) sd.checked = true;
            startSelfDestruct();
            rMsg('🍁 Собеседник включил листопад', 3000);
            return;
        }
    } catch(e) {}
    
    // Voice message handling — voiceData приходит в событии
    if (data.type === 'voice' && data.voiceData) {
        const ct = contacts.find(c => c.channelId === data.channelId);
        const nick = safeHtml(data.nick || ct?.name || 'Друг');
        const avatar = data.avatar || ct?.avatar || '001';
        if (data.channelId === activeChannelId) {
            appendMessage(nick, '🎤 Голосовое', avatar, data.voiceData, 'audio/webm');
        } else {
            rMsg('🎤 Голосовое от ' + nick, 3000);
            playVoiceBlob(data.voiceData);
        }
        updateCupIndicator();
        return;
    }
    
    // Обычное текстовое сообщение
    const ct = contacts.find(c => c.channelId === data.channelId);
    const nick = safeHtml(data.nick || ct?.name || 'Лучник');
    const avatar = data.avatar || ct?.avatar || '001';
    if (data.channelId === activeChannelId) {
        appendMessage(nick, data.text, avatar);
    } else {
        rMsg('Новое от ' + nick, 3000);
    }
    updateCupIndicator();
    updateRatchetIndicator();
    playSound('arrow_hit.wav');
}

function handleBandMessage(parsed, data) {
    // Без изменений
}

function handleWebRTCSignal(type, sdp, channelId) {
    // Больше не используется — call signaling через P2PPong
}

function resetChatUI() { 
    activeChannelId = null; 
    activePeerId = null; 
    activeBandId = null; 
    document.getElementById('robin-bar-sender').textContent = 'RobinHood P2P'; 
    document.getElementById('chat-box').innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; 
    contacts = []; 
    saveContacts(); 
}

function initUI() {
    P2PPong.on('ready', () => { setConnectionStatus('online'); rMsg('🏹 Слепой Улей готов', 0); });
    P2PPong.on('state-change', (data) => { if (data.state === 'online') setConnectionStatus('online'); else if (data.state === 'offline') setConnectionStatus('offline'); });
    P2PPong.on('peer-connected', () => { rMsg('🔗 Прямой канал установлен', 3000); });
    P2PPong.on('message-received', (data) => { handleIncomingMessage(data); });
    P2PPong.on('message-sent', () => { updateCupIndicator(); updateRatchetIndicator(); });
    P2PPong.on('beacon-taken', () => { rMsg('👀 Маяк забрали...', 3000); });

    // Call events
    P2PPong.on('call-incoming', (data) => {
        playRingtone();
        const callPanel = document.getElementById('call-panel');
        if (callPanel) callPanel.style.display = 'flex';
        const ct = contacts.find(c => c.channelId === (activeChannelId || Object.keys(P2PPong._channels)[0]));
        document.getElementById('call-avatar').src = 'assets/avatar/' + (ct?.avatar || selectedAvatar) + 'ava.png';
        document.getElementById('call-contact-name').textContent = ct?.name || 'Лучник';
        document.getElementById('call-status').textContent = '📞 Входящий...';
        showIncomingControls(true);
        showActiveControls(false);
        updateCallButtonState();
        playCallArcherAnimation();
    });

    P2PPong.on('call-connected', () => {
        stopRingtone();
        stopRingback();
        stopCallArcherAnimation();
        document.getElementById('call-status').textContent = '✅ Разговор';
        showIncomingControls(false);
        showActiveControls(true);
        showCallWave(true);
        playSound('open.mp3');
        playArcherAnimation();
        updateCallButtonState();
    });

    P2PPong.on('call-ended', () => {
        stopRingtone();
        stopRingback();
        stopCallArcherAnimation();
        const callPanel = document.getElementById('call-panel');
        if (callPanel) callPanel.style.display = 'none';
        showIncomingControls(false);
        showActiveControls(false);
        showCallWave(false);
        playSound('exet.mp3');
        updateCallButtonState();
    });

    P2PPong.on('verification-needed', (data) => {
        // Без изменений
    });

    P2PPong.on('channel-opened', (data) => {
        // Без изменений
    });
    
    P2PPong.on('channel-expired', (data) => { /* без изменений */ });
    P2PPong.on('error', (data) => { rMsg('❌ ' + data.message, 5000); });
    P2PPong.on('destroyed', () => { /* без изменений */ });
    P2PPong.on('beacon-timeout', () => { /* без изменений */ });
}

function addVerifyDigit(d) { /* без изменений */ }

function initApp() {
    document.addEventListener('click', function unlockAudio() { 
        if (sharedAudioContext && sharedAudioContext.state === 'suspended') { 
            sharedAudioContext.resume().catch(() => {}); 
        }
        getAudioContext();
        if (P2PPong._callAudioContext && P2PPong._callAudioContext.state === 'suspended') {
            P2PPong._callAudioContext.resume().catch(() => {});
        }
    }, { once: true });
    
    initLeaves();
    generateRandomTheme();
    // ... остальная инициализация без изменений ...

    // Кнопка звонка
    document.getElementById('btn-call')?.addEventListener('click', () => { 
        const callState = P2PPong.getCallState();
        if (callState === 'active' || callState === 'calling') {
            hang(true);
        } else if (callState === 'ringing') {
            acceptCall();
        } else {
            startCall();
        }
    });
    
    // Принять звонок
    document.getElementById('call-accept')?.addEventListener('click', acceptCall);
    
    // Отклонить звонок
    document.getElementById('call-reject')?.addEventListener('click', () => { 
        hang(true);
    });
    
    // Завершить звонок
    document.getElementById('call-end')?.addEventListener('click', () => hang(true));
    
    // Спикер
    document.getElementById('call-speaker')?.addEventListener('click', () => { 
        const enabled = P2PPong.toggleCallSpeaker();
        const s = document.getElementById('call-speaker'); 
        if (s) { 
            s.classList.toggle('active', enabled); 
            s.textContent = enabled ? '🔊' : '🔇'; 
        } 
    });
    
    // Микрофон
    document.getElementById('call-mic')?.addEventListener('click', () => { 
        const enabled = P2PPong.toggleCallMic(); 
        const m = document.getElementById('call-mic'); 
        if (m) { 
            m.classList.toggle('muted', !enabled); 
            m.textContent = enabled ? '🎤' : '🚫'; 
        } 
    });
    
    // Громкость микрофона
    document.getElementById('mic-volume')?.addEventListener('input', function() { 
        P2PPong.setCallMicVolume(this.value / 100); 
        document.getElementById('mic-volume-value').textContent = this.value + '%'; 
    });
    
    // Громкость динамика
    document.getElementById('speaker-volume')?.addEventListener('input', function() { 
        P2PPong.setCallSpeakerVolume(this.value / 100); 
        document.getElementById('speaker-volume-value').textContent = this.value + '%'; 
    });
    
    // Голосовые сообщения
    document.getElementById('btn-voice-input')?.addEventListener('click', toggleVoiceRecording);
    
    // Отправка сообщений
    document.getElementById('send-btn')?.addEventListener('click', async () => {
        const mi = document.getElementById('msg-input'); 
        const t = mi?.value.trim();
        if (t) {
            if (activeBandId) {
                // Band message logic
                const band = bands.find(b => b.id === activeBandId); 
                if (band) { 
                    band.blobs.push({ text: t, from: P2PPong._peerId, nick: document.getElementById('nick-label')?.textContent || 'Лучник', avatar: selectedAvatar, time: Date.now() }); 
                    appendMessage('Вы', t, selectedAvatar); 
                    if (mi) mi.value = ''; 
                    playArcherAnimation(); 
                    if (toggleSoundState) playSound('shot.mp3'); 
                    if (activeChannelId) { 
                        P2PPong.sendMessage(activeChannelId, JSON.stringify({ band: 'band-message', bandId: activeBandId, text: t, from: P2PPong._peerId, nick: document.getElementById('nick-label')?.textContent || 'Лучник', avatar: selectedAvatar })); 
                    } 
                }
                return; 
            }
            
            if (!activeChannelId) { 
                const chIds = Object.keys(P2PPong._channels); 
                if (!chIds.length) return; 
                activeChannelId = chIds[0]; 
            }
            const sent = await P2PPong.sendMessage(activeChannelId, t);
            if (sent) { 
                appendMessage('Вы', t, selectedAvatar); 
                updateCupIndicator(); 
                updateRatchetIndicator(); 
                if (mi) mi.value = ''; 
                playArcherAnimation(); 
                if (toggleSoundState) playSound('shot.mp3'); 
            }
        }
    });
    
    // ... остальная инициализация кнопок без изменений ...
    
    setConnectionStatus('online');
}

// Инициализация
P2PPong.on('ready', () => { 
    initUI(); 
    initApp(); 
});
P2PPong.init();
