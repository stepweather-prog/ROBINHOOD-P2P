// robinhood-ui.js
let contacts = [],
    activeChannelId = null,
    activePeerId = null,
    selectedAvatar = 'icons/01icon.png';
let toggleSoundState = true,
    toggleAnimations = true,
    selfDestructMode = false;
let audioPool = {},
    robinDefaultText = 'Святые сокеты стабильны!',
    robinTimer = null;
let voiceRecorder = null,
    voiceChunks = [],
    voiceStream = null,
    voiceRecording = false,
    voiceSeconds = 0,
    voiceTimerInterval = null,
    voiceRecTimeout = null;
let archerAnimation, quiverAnim, bowAnim, currentArrowContainer;
let deferredPrompt = null;
let verificationModalShown = false,
    verificationDone = false;

let selfDestructBatchSize = 5,
    selfDestructIntervalTime = 20000,
    selfDestructIntervalId = null;

// Фоны: первая — картинка, дальше видео, потом опять картинка
const videoBackgrounds = [
    { type: 'image', src: 'assets/icons/background.webp', name: 'Статика' },
    { type: 'video', src: 'assets/icons/background.webm', name: 'Неон' },
    { type: 'video', src: 'assets/icons/background2.webm', name: 'Робин' },
    { type: 'video', src: 'assets/icons/background3.webm', name: 'Листва' },
    ];

let currentBgIndex = 0;

const MAX_CHAT_MESSAGES = 100;
const avatarList = ['002','004','006','007','023','025','028','031','033','037','045','051','053','056','057','059','062','064','066','075','076','080','082','092','094','097','098','110','112','114','119','128','129','132','146','150','153','154','156','159','161','166','167'];
const avatars = avatarList.map(id => 'assets/avatar/' + id + 'ava.png');
function isMobile() {
    return /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || window.innerWidth < 768;
}
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
                        if (key.includes(msgId)) { clearTimeout(P2PPong._dedupTimers[key]); delete P2PPong._dedupTimers[key]; }
                    }
                }
                el.style.transition = 'opacity 0.5s'; el.style.opacity = '0';
                setTimeout(() => { if (el.parentNode) el.remove(); }, 500);
            }
        }
        if (box.querySelectorAll('.message-row').length === 0) stopSelfDestruct();
    }, selfDestructIntervalTime);
    document.getElementById('leaves-container')?.classList.remove('sleeping');
}

function stopSelfDestruct() {
    if (selfDestructIntervalId) { clearInterval(selfDestructIntervalId); selfDestructIntervalId = null; }
    if (P2PPong._dedupTimers) { for (const key in P2PPong._dedupTimers) clearTimeout(P2PPong._dedupTimers[key]); P2PPong._dedupTimers = {}; }
    if (activeChannelId && P2PPong._channels[activeChannelId]) { P2PPong._channels[activeChannelId].blobs = []; }
    document.getElementById('leaves-container')?.classList.add('sleeping');
}

function showVoiceRecordingUI(show) { const old = document.getElementById('voice-recording-indicator'); if (old) old.remove(); if (!show) return; const btn = document.getElementById('btn-voice-input'); if (!btn) return; const container = document.createElement('div'); container.id = 'voice-recording-indicator'; container.className = 'voice-recording-indicator'; const timer = document.createElement('span'); timer.className = 'voice-timer-text'; timer.id = 'voice-timer-text'; timer.textContent = '🎤 0:00'; const wave = document.createElement('div'); wave.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:18px;'; for (let i = 0; i < 4; i++) { const bar = document.createElement('div'); bar.className = 'voice-wave-bar'; bar.style.cssText = `width:3px;animation:voiceWaveAnim 0.5s ease-in-out infinite;animation-delay:${i * 0.1}s;height:${6 + i * 3}px;`; wave.appendChild(bar); } container.appendChild(timer); container.appendChild(wave); btn.parentNode.insertBefore(container, btn); }

function startVoiceTimer() { voiceSeconds = 0; const vt = document.getElementById('voice-timer-text'); if (vt) vt.textContent = '🎤 0:00'; voiceTimerInterval = setInterval(() => { voiceSeconds++; const m = Math.floor(voiceSeconds / 60), s = (voiceSeconds % 60).toString().padStart(2, '0'); const vt = document.getElementById('voice-timer-text'); if (vt) vt.textContent = '🎤 ' + m + ':' + s; }, 1000); }
function stopVoiceTimer() { if (voiceTimerInterval) clearInterval(voiceTimerInterval); }
function toggleVoiceRecording() { voiceRecording ? stopVoiceRecording() : startVoiceRecording(); }
function startVoiceRecording() { if (voiceRecorder?.state === 'recording') return; const audioBits = isMobile() ? 8000 : 16000; navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(st => { voiceStream = st; voiceRecorder = new MediaRecorder(st, { mimeType: 'audio/webm; codecs=opus', audioBitsPerSecond: audioBits }); voiceChunks = []; voiceRecorder.ondataavailable = e => voiceChunks.push(e.data); voiceRecorder.onstop = () => { if (voiceRecTimeout) clearTimeout(voiceRecTimeout); const blob = new Blob(voiceChunks, { type: 'audio/webm' }); if (blob.size > 100 && blob.size < 500000 && activeChannelId) { const reader = new FileReader(); reader.onload = async () => { const b64 = reader.result.split(',')[1]; await P2PPong.sendVoiceMessage(activeChannelId, b64); playSound('open.mp3'); appendMessage('Вы', '🎤 Голосовое', selectedAvatar, b64, 'audio/webm'); }; reader.readAsDataURL(blob); } if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; } voiceRecorder = null; voiceRecording = false; stopVoiceTimer(); document.getElementById('btn-voice-input').style.background = ''; showVoiceRecordingUI(false); }; voiceRecorder.start(); voiceRecording = true; startVoiceTimer(); document.getElementById('btn-voice-input').style.background = '#f44336'; showVoiceRecordingUI(true); voiceRecTimeout = setTimeout(() => { if (voiceRecorder?.state === 'recording') { voiceRecorder.stop(); rMsg('⏰ Максимальная длина записи — 10 секунд', 3000); } }, 10000); }).catch(e => { voiceChunks = []; rMsg('❌ Микрофон недоступен или занят', 3000); }); }
function stopVoiceRecording() { if (voiceRecorder?.state === 'recording') voiceRecorder.stop(); }
function playVoiceBlob(b64) { const a = new Audio('data:audio/webm;base64,' + b64); a.load(); a.play().catch(e => {}); }

function appendMessage(sender, text, avatarSrc, audioData, audioMime) { const box = document.getElementById('chat-box'); const row = document.createElement('div'); row.className = 'message-row'; const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); const av = getAvatarUrl(avatarSrc); const safeSender = safeHtml(sender); if (audioData && audioMime && audioMime.startsWith('audio/')) { const player = createAudioPlayer(audioData, audioMime); row.innerHTML = `<img src="${av}" class="avatar" onerror="this.src='assets/icons/01icon.png'" loading="lazy"><div class="msg-body"><div class="msg-sender">${safeSender}</div></div>`; row.querySelector('.msg-body').appendChild(player); const ts = document.createElement('div'); ts.className = 'msg-status'; ts.textContent = time; row.querySelector('.msg-body').appendChild(ts); } else { row.innerHTML = `<img src="${av}" class="avatar" onerror="this.src='assets/icons/01icon.png'" loading="lazy"><div class="msg-body"><div class="msg-sender">${safeSender}</div><div style="word-break:break-word;white-space:pre-wrap;">${safeHtml(text)}</div><div class="msg-status">${time}</div></div>`; } const msgId = 'msg_' + Date.now() + Math.random(); row.dataset.msgId = msgId; box.insertBefore(row, document.getElementById('typing-indicator')); const allRows = box.querySelectorAll('.message-row'); while (allRows.length > MAX_CHAT_MESSAGES) { const firstRow = allRows[0]; if (firstRow && firstRow.parentNode) firstRow.remove(); } box.scrollTop = box.scrollHeight; }
function createAudioPlayer(audioData, audioMime) { const container = document.createElement('div'); container.className = 'audio-player audio-paused'; const audio = new Audio('data:' + audioMime + ';base64,' + audioData); audio.load(); let isPlaying = false; const playBtn = document.createElement('button'); playBtn.className = 'audio-play-btn'; playBtn.textContent = '▶'; const waveDiv = document.createElement('div'); waveDiv.className = 'audio-wave'; for (let i = 0; i < 4; i++) { const bar = document.createElement('div'); bar.className = 'audio-wave-bar'; waveDiv.appendChild(bar); } const timeSpan = document.createElement('span'); timeSpan.className = 'audio-time'; timeSpan.textContent = '0:00'; playBtn.addEventListener('click', () => { if (isPlaying) { audio.pause(); container.classList.remove('audio-playing'); container.classList.add('audio-paused'); playBtn.textContent = '▶'; } else { audio.play(); container.classList.remove('audio-paused'); container.classList.add('audio-playing'); playBtn.textContent = '⏸'; } isPlaying = !isPlaying; }); audio.addEventListener('timeupdate', () => { const m = Math.floor(audio.currentTime / 60); const s = Math.floor(audio.currentTime % 60).toString().padStart(2, '0'); timeSpan.textContent = m + ':' + s; }); audio.addEventListener('ended', () => { container.classList.remove('audio-playing'); container.classList.add('audio-paused'); playBtn.textContent = '▶'; isPlaying = false; }); container.appendChild(playBtn); container.appendChild(waveDiv); container.appendChild(timeSpan); return container; }
function showChatForChannel(channelId) { activeChannelId = channelId; const box = document.getElementById('chat-box'); box.innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; const ch = P2PPong._channels[channelId]; if (ch && ch.blobs) { ch.blobs.forEach(b => { const im = b.from === 'me'; appendMessage(im ? 'Вы' : 'Лучник', b.d || b.text || '', im ? selectedAvatar : 'icons/01icon.png'); }); }  }

function getAvatarUrl(avatarSrc) {
    if (!avatarSrc || avatarSrc === 'icons/01icon.png') return 'assets/icons/01icon.png';
    if (avatarSrc === '001') return 'assets/avatar/001ava.png';
    if (avatarSrc.startsWith('assets/')) return avatarSrc.endsWith('.png') ? avatarSrc : avatarSrc + 'ava.png';
    if (avatarSrc.includes('/')) return avatarSrc.endsWith('.png') ? avatarSrc : avatarSrc + 'ava.png';
    return 'assets/avatar/' + avatarSrc + 'ava.png';
}
function addContact(c) { if (!contacts.find(x => x.peerId === c.peerId)) { contacts.push(c); } else { const existing = contacts.find(x => x.peerId === c.peerId); if (c.name && c.name !== 'Лучник') existing.name = c.name; if (c.avatar && c.avatar !== '001') existing.avatar = c.avatar; if (c.channelId) existing.channelId = c.channelId; } }

const themes = [{ id: 'forest', name: 'Лес' }, { id: 'sunset', name: 'Закат' }, { id: 'ocean', name: 'Океан' }, { id: 'rose', name: 'Роза' }, { id: 'amber', name: 'Янтарь' }, { id: 'mint', name: 'Мята' }, { id: 'lavender', name: 'Лаванда' }, { id: 'cherry', name: 'Вишня' }, { id: 'emerald', name: 'Изумруд' }, { id: 'slate', name: 'Сланец' }, { id: 'coral', name: 'Коралл' }, { id: 'plum', name: 'Слива' }];
function applyTheme(id) { document.documentElement.setAttribute('data-theme', id); try { localStorage.setItem('robinhood_theme', id); } catch (e) {} const tn = document.getElementById('theme-name'); if (tn) tn.textContent = (themes.find(t => t.id === id) || themes[0]).name; }
function generateRandomTheme() { const hue = Math.floor(Math.random() * 360), sat = 40 + Math.floor(Math.random() * 50), bgLight = 5 + Math.floor(Math.random() * 15), bgDark = 2 + Math.floor(Math.random() * 8), id = 'random_' + Date.now(); const s = `[data-theme="${id}"]{--bg-primary:hsl(${hue},${sat}%,${bgLight}%);--bg-secondary:hsl(${hue},${sat-10}%,${bgDark}%);--accent:hsl(${(hue+30)%360},${sat+10}%,50%);--accent-light:hsl(${(hue+30)%360},${sat+20}%,70%);--text:hsl(${hue},20%,85%);--text-bright:hsl(${hue},25%,92%);--text-dim:hsl(${hue},15%,60%);--border:hsl(${(hue+30)%360},${sat+10}%,50%);--btn-bg:hsla(${(hue+30)%360},${sat+10}%,50%,0.1);--btn-border:hsla(${(hue+30)%360},${sat+10}%,50%,0.3);--btn-hover:hsla(${(hue+30)%360},${sat+10}%,50%,0.25);--sheet-bg:linear-gradient(145deg,hsl(${hue},${sat}%,${bgLight}%)0%,hsl(${hue},${sat-10}%,${bgDark}%)100%);--input-bg:hsla(${hue},${sat-10}%,${bgLight+2}%,0.9);--msg-bg:hsla(${hue},${sat-5}%,${bgLight+3}%,0.85);--msg-accent:hsl(${(hue+30)%360},${sat+10}%,50%);--robin-bg:hsla(${hue},${sat}%,${bgLight+8}%,0.9);--robin-accent:hsl(${(hue+30)%360},${sat+20}%,65%);--overlay-bg:rgba(0,0,0,0.6);--call-bg:linear-gradient(180deg,hsl(${hue},${sat}%,${bgLight}%)0%,hsl(${hue},${sat-10}%,${bgDark}%)100%);--call-btn-bg:hsla(${(hue+30)%360},${sat+10}%,50%,0.1);--call-btn-border:hsla(${(hue+30)%360},${sat+10}%,50%,0.3);--input-text:hsl(${hue},20%,85%)}`; let el = document.getElementById('gen-theme'); if (!el) { el = document.createElement('style'); el.id = 'gen-theme'; document.head.appendChild(el); } el.textContent = s; document.documentElement.setAttribute('data-theme', id); const tn = document.getElementById('theme-name'); if (tn) tn.textContent = 'Авто'; try { localStorage.setItem('robinhood_theme', id); } catch (e) {} }

function applyBackground(index) {
    const vbg = document.querySelector('.video-bg');
    if (!vbg) return;
    
    const bg = videoBackgrounds[index];
    document.getElementById('videobg-name').textContent = bg.name;
    
    if (bg.type === 'image') {
        vbg.pause();
        vbg.removeAttribute('src');
        vbg.querySelector('source')?.removeAttribute('src');
        vbg.load();
        
        vbg.style.backgroundImage = `url('${bg.src}')`;
        vbg.style.backgroundSize = 'cover';
        vbg.style.backgroundPosition = 'center';
        vbg.style.display = 'block';
        vbg.style.opacity = '1';
    } else {
        vbg.style.backgroundImage = '';
        vbg.style.backgroundSize = '';
        vbg.style.backgroundPosition = '';
        
        vbg.querySelector('source').src = bg.src;
        vbg.load();
        vbg.play();
        vbg.style.display = '';
        vbg.style.opacity = '0.35';
    }
}

function cycleBackground() {
    currentBgIndex = (currentBgIndex + 1) % videoBackgrounds.length;
    applyBackground(currentBgIndex);
}

function loadAvatars() { const list = document.getElementById('avatar-list'); if (!list) return; list.innerHTML = ''; const fragment = document.createDocumentFragment(); avatars.forEach(src => { const img = document.createElement('img'); img.src = src; img.className = 'avatar-option'; img.loading = 'lazy'; img.onerror = () => img.src = 'assets/icons/01icon.png'; img.onclick = () => { const pas = document.getElementById('profile-avatar-small'); if (pas) pas.src = src; document.getElementById('robin-avatar').src = src; selectedAvatar = src.includes('/') ? src.split('/').pop()?.replace('ava.png', '') || 'icons/01icon.png' : src; try { localStorage.setItem('robinhood_avatar', src); } catch (e) {} const savedNick = document.getElementById('nick-label')?.textContent || 'Лучник'; P2PPong.setMyProfile(savedNick, selectedAvatar); closeSheets(); rMsg('🖼 Аватар обновлён'); }; fragment.appendChild(img); }); list.appendChild(fragment); }

async function performDestruction(channelId, source = 'local') {
    playSmokeAnimation();
    playSound('clear cache.mp3');
    const msg = '👀 Робин Гуд пустил все письма на самокрутки!';
    rMsg(msg, 5000);
    const delay = source === 'local' ? 6000 : 3000;
    await new Promise(resolve => setTimeout(resolve, delay));
    if (P2PPong._webRTC[channelId]) { try { P2PPong._webRTC[channelId].pc.close(); } catch(e) {} delete P2PPong._webRTC[channelId]; }
    P2PPong._stopMsgPoll(channelId); P2PPong._stopWebRTCPoll(channelId); delete P2PPong._channels[channelId];
    for (const key in P2PPong._dedupTimers) { if (key.startsWith(channelId + '_')) { clearTimeout(P2PPong._dedupTimers[key]); delete P2PPong._dedupTimers[key]; } }
    contacts = []; resetChatUI();
    localStorage.clear(); sessionStorage.clear();
    if ('caches' in window) { caches.keys().then(names => names.forEach(name => caches.delete(name))); }
    if (window.indexedDB) { indexedDB.databases().then(dbs => dbs.forEach(db => indexedDB.deleteDatabase(db.name))).catch(() => {}); }
    P2PPong._emit('channel-destroyed', { channelId, source });
    await P2PPong.destroy();
    window.location.reload(true);
}

function initUI() {
    P2PPong.on('ready', () => { setConnectionStatus('online'); rMsg('🏹 Свяьые сокеты стабильны!', 0); });
    P2PPong.on('state-change', (data) => { if (data.state === 'online') setConnectionStatus('online'); else if (data.state === 'offline') setConnectionStatus('offline'); });
    P2PPong.on('peer-connected', () => { rMsg('🔗 Прямой канал установлен', 3000); });
    P2PPong.on('message-received', (data) => { handleIncomingMessage(data); });
    
    P2PPong.on('beacon-taken', () => { rMsg('👀 Метку забрали...', 3000); });
    P2PPong.on('verification-needed', (data) => {
        if (verificationModalShown) return;
        verificationModalShown = true; verificationDone = false;
        window._verifyCode = data.code || P2PPong.getVerificationCode(); window._verifyInput = '';
        document.getElementById('verify-instruction').textContent = 'Введи 7-значный код';
        document.getElementById('verify-error').style.display = 'none';
        document.getElementById('verify-code-display').textContent = '_______';
        const grid = document.getElementById('verify-code-grid'); grid.innerHTML = '';
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:240px;margin:12px auto;';
        for (let i = 1; i <= 9; i++) { const btn = document.createElement('button'); btn.textContent = i; btn.className = 'lock-num'; btn.style.cssText = 'width:65px;height:65px;font-size:1.8em;'; btn.onclick = () => addVerifyDigit(i.toString()); grid.appendChild(btn); }
        const btn0 = document.createElement('button'); btn0.textContent = '0'; btn0.className = 'lock-num'; btn0.style.cssText = 'width:65px;height:65px;font-size:1.8em;'; btn0.onclick = () => addVerifyDigit('0'); grid.appendChild(btn0);
        const btnDel = document.createElement('button'); btnDel.textContent = '⌫'; btnDel.className = 'lock-num'; btnDel.style.cssText = 'width:65px;height:65px;font-size:1.5em;background:rgba(244,67,54,0.3);'; btnDel.onclick = () => { window._verifyInput = window._verifyInput.slice(0, -1); document.getElementById('verify-code-display').textContent = window._verifyInput.padEnd(7, '_'); }; grid.appendChild(btnDel);
        document.getElementById('btn-verify-reset').onclick = () => { window._verifyInput = ''; document.getElementById('verify-code-display').textContent = '_______'; };
        const modalDialog = document.getElementById('verify-modal')?.querySelector('.modal-dialog');
        if (modalDialog && !document.getElementById('speak-code-btn')) { const speakBtn = document.createElement('button'); speakBtn.id = 'speak-code-btn'; speakBtn.textContent = '🔊 Произнести код'; speakBtn.className = 'btn-dark'; speakBtn.style.cssText = 'width:auto;display:inline-block;margin:8px auto;'; speakBtn.onclick = () => { const code = window._verifyCode || P2PPong.getVerificationCode(); if (code && 'speechSynthesis' in window) { const utterance = new SpeechSynthesisUtterance(code.split('').join(' ')); utterance.lang = 'ru-RU'; utterance.rate = 0.8; speechSynthesis.speak(utterance); } }; modalDialog.appendChild(speakBtn); }
        document.getElementById('verify-modal')?.classList.add('active');
    });
    P2PPong.on('channel-opened', (data) => {
        document.getElementById('verify-modal')?.classList.remove('active'); verificationModalShown = false; verificationDone = false;
        setTimeout(() => { playQuiverAnimation(); }, 300);
        rMsg('✅ Колчан открыт! Тетива натянута!', 3000);
        addContact({ peerId: data.peerId, name: data.nick || 'Лучник', channelId: data.channelId, verified: false, avatar: data.avatar || 'icons/01icon.png' });
        showChatForChannel(data.channelId);
    });
    P2PPong.on('channel-expired', (data) => { if (data.channelId === activeChannelId) { activeChannelId = null; activePeerId = null; document.getElementById('chat-box').innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; } });
    P2PPong.on('error', (data) => { rMsg('❌ ' + data.message, 5000); });
    P2PPong.on('destroyed', () => { document.getElementById('chat-box').innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; setConnectionStatus('offline'); });
    P2PPong.on('beacon-timeout', () => { document.getElementById('verify-modal')?.classList.remove('active'); document.getElementById('craft-modal')?.classList.remove('active'); verificationModalShown = false; verificationDone = false; rMsg('⏰ Время ожидания истекло. Попробуй снова.', 5000); });
}

function addVerifyDigit(d) { if (window._verifyInput.length >= 7) return; window._verifyInput += d; document.getElementById('verify-code-display').textContent = window._verifyInput.padEnd(7, '_'); if (window._verifyInput.length === 7) { setTimeout(() => document.getElementById('btn-verify-confirm')?.click(), 300); } }

function handleIncomingMessage(data) {
    if (!data) return;
    if (data.voiceData) { playSound('open.mp3'); const nick = safeHtml(data.nick || 'Лучник'); const avatar = data.avatar || 'icons/01icon.png'; if (data.channelId === activeChannelId) { appendMessage(nick, '🎤 Голосовое', avatar, data.voiceData, 'audio/webm'); } else { rMsg('🎤 Голосовое от ' + nick, 3000); playVoiceBlob(data.voiceData); } return; }
    if (!data.text) return;
    try {
        const parsed = JSON.parse(data.text);
        if (parsed.type === 'channel-destroyed') { performDestruction(parsed.channelId, 'remote'); return; }
        if (parsed.voice) { const nick = safeHtml(data.nick || 'Лучник'); const avatar = data.avatar || 'icons/01icon.png'; if (data.channelId === activeChannelId) { appendMessage(nick, '🎤 Голосовое', avatar, parsed.data, 'audio/webm'); } else { rMsg('🎤 Голосовое от ' + nick, 3000); playVoiceBlob(parsed.data); } return; }
        if (parsed.d === '__SMOKE__') { selfDestructMode = true; const sd = document.getElementById('toggle-selfdestruct'); if (sd) sd.checked = true; startSelfDestruct(); rMsg('🍁 Собеседник включил листопад', 3000); return; }
    } catch (e) {}
    const nick = safeHtml(data.nick || 'Лучник'); const avatar = data.avatar || 'icons/01icon.png';
    if (data.channelId === activeChannelId) { appendMessage(nick, data.text, avatar); } else { rMsg('Новое от ' + nick, 3000); }
    playSound('arrow_hit.wav');
}

let inactivityTimer;
function resetInactivityTimer() { clearTimeout(inactivityTimer); const lc = document.getElementById('leaves-container'); if (lc) { lc.classList.remove('sleeping'); lc.style.opacity = '1'; } inactivityTimer = setTimeout(() => { const lc = document.getElementById('leaves-container'); if (lc) lc.classList.add('sleeping'); }, 90000); }
document.addEventListener('pointermove', throttle(resetInactivityTimer, 5000)); document.addEventListener('pointerdown', resetInactivityTimer); document.addEventListener('keypress', resetInactivityTimer);
window.addEventListener('blur', () => { clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => { const lc = document.getElementById('leaves-container'); if (lc) lc.classList.add('sleeping'); }, 5000); });
window.addEventListener('focus', () => { clearTimeout(inactivityTimer); const lc = document.getElementById('leaves-container'); if (lc) { lc.classList.remove('sleeping'); lc.style.opacity = '1'; } resetInactivityTimer(); });
window.addEventListener('visibilitychange', () => { if (document.hidden) { stopSelfDestruct(); } else { if (selfDestructMode) startSelfDestruct(); } });

function initLeaves() { const c = document.getElementById('leaves-container'); if (!c || c.children.length > 0) return; const emojis = ['🍁','🍂','🌿','🍃','🌰']; const fragment = document.createDocumentFragment(); for (let i = 0; i < 7; i++) { const el = document.createElement('span'); el.className = i % 3 == 0 ? 'feather' : 'leaf'; el.textContent = emojis[i % emojis.length]; el.style.left = Math.random() * 100 + '%'; el.style.animationDelay = Math.random() * 15 + 's'; el.style.animationDuration = (16 + Math.random() * 18) + 's'; fragment.appendChild(el); } c.appendChild(fragment); c.classList.add('sleeping'); resetInactivityTimer(); }

function generateQR(text, size) { const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const ctx = canvas.getContext('2d'); const bytes = new TextEncoder().encode(text); const moduleCount = 21; const moduleSize = Math.floor(size / (moduleCount + 8)); const offset = Math.floor((size - moduleCount * moduleSize) / 2); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, size, size); ctx.fillStyle = '#000000'; function drawModule(row, col) { ctx.fillRect(offset + col * moduleSize, offset + row * moduleSize, moduleSize, moduleSize); } function drawFinderPattern(startRow, startCol) { for (let r = 0; r < 7; r++) { for (let c = 0; c < 7; c++) { if (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) { drawModule(startRow + r, startCol + c); } } } } drawFinderPattern(0, 0); drawFinderPattern(0, moduleCount - 7); drawFinderPattern(moduleCount - 7, 0); let bitIndex = 0; const totalBits = bytes.length * 8; for (let row = 0; row < moduleCount && bitIndex < totalBits; row++) { for (let col = 0; col < moduleCount && bitIndex < totalBits; col++) { if ((row < 7 && col < 7) || (row < 7 && col >= moduleCount - 7) || (row >= moduleCount - 7 && col < 7)) continue; const byteIndex = Math.floor(bitIndex / 8); const bitInByte = 7 - (bitIndex % 8); const bit = (bytes[byteIndex] >> bitInByte) & 1; if (bit === 1) drawModule(row, col); bitIndex++; } } return canvas.toDataURL('image/png'); }

function resetChatUI() { activeChannelId = null; activePeerId = null; document.getElementById('robin-bar-sender').textContent = 'RobinHood P2P'; document.getElementById('chat-box').innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; contacts = []; }

function initApp() {
    //initLeaves();
    const savedTheme = localStorage.getItem('robinhood_theme'); if (savedTheme) { applyTheme(savedTheme); } else { applyTheme('forest'); }
    // Фон всегда начинается с картинки
    currentBgIndex = 0;
    applyBackground(currentBgIndex);
    const savedAvatar = localStorage.getItem('robinhood_avatar'); if (savedAvatar) { selectedAvatar = savedAvatar.includes('/') ? savedAvatar.split('/').pop()?.replace('ava.png', '') || 'icons/01icon.png' : savedAvatar; const pas = document.getElementById('profile-avatar-small'); if (pas) pas.src = getAvatarUrl(selectedAvatar); document.getElementById('robin-avatar').src = getAvatarUrl(selectedAvatar); }
    const savedNick = localStorage.getItem('robinhood_nick'); const nl = document.getElementById('nick-label'); if (savedNick && nl) nl.textContent = savedNick.substring(0, 12);
    P2PPong.setMyProfile(savedNick || 'Лучник', selectedAvatar);
    toggleSoundState = localStorage.getItem('robinhood_sound') !== 'false'; const ts = document.getElementById('toggle-sound'); if (ts) ts.checked = toggleSoundState;
    toggleAnimations = localStorage.getItem('robinhood_animations') !== 'false'; const ta = document.getElementById('toggle-animations'); if (ta) ta.checked = toggleAnimations;
    selfDestructMode = localStorage.getItem('robinhood_selfdestruct') === 'true'; const sd = document.getElementById('toggle-selfdestruct'); if (sd) sd.checked = selfDestructMode; if (selfDestructMode) startSelfDestruct();
    if (!toggleAnimations) {
        document.getElementById('leaves-container')?.classList.add('sleeping');
    } else {
        document.getElementById('leaves-container')?.classList.remove('sleeping');
    }
    const isPWA = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone || false; const si = document.getElementById('setting-install'); if (!isPWA && si) si.classList.remove('hidden');

    let headerVisible = true;
    document.getElementById('robin-bar')?.addEventListener('click', () => { const h1 = document.querySelector('.header-row-1'); const h2 = document.querySelector('.header-row-2'); const h3 = document.querySelector('.header-row-3'); if (headerVisible) { h1.style.display = 'none'; h2.style.display = 'none'; h3.style.display = 'none'; headerVisible = false; } else { h1.style.display = ''; h2.style.display = ''; h3.style.display = ''; headerVisible = true; } });

    document.getElementById('btn-craft')?.addEventListener('click', () => { document.getElementById('craft-modal')?.classList.add('active'); const bid = P2PPong._beaconId; const display = document.getElementById('craft-peer-id-display'); if (display) display.textContent = bid || 'Не создана'; });
    document.getElementById('btn-craft-arrow')?.addEventListener('click', async () => { try { const beaconId = await P2PPong.craftArrow(); const display = document.getElementById('craft-peer-id-display'); if (display) display.textContent = beaconId; const code = P2PPong.getVerificationCode(); const pubKey = P2PPong.getPubKey(); if (code) { const codeDisplay = document.getElementById('craft-code-display'); if (codeDisplay) { codeDisplay.textContent = code; codeDisplay.style.display = 'block'; } const qrContainer = document.getElementById('craft-qr-code'); if (qrContainer) { qrContainer.innerHTML = ''; const qrDataUrl = generateQR(JSON.stringify({ beaconId, code, pubKey }), 200); const img = document.createElement('img'); img.src = qrDataUrl; img.style.cssText = 'width:200px;height:200px;margin:8px auto;display:block;'; img.loading = 'lazy'; qrContainer.appendChild(img); qrContainer.style.display = 'block'; } } window._verifyCode = code; rMsg('🏹 Стрела изготовлена!', 3000); } catch(e) {} });
    document.getElementById('btn-copy-peer-id')?.addEventListener('click', () => { const bid = P2PPong._beaconId; const code = P2PPong.getVerificationCode(); let copyText = bid || ''; if (code) copyText += '\n' + code; if (bid) { navigator.clipboard.writeText(copyText).then(() => rMsg('⎘ Скопировано!')).catch(() => {}); } });
    document.getElementById('close-craft-modal')?.addEventListener('click', () => { document.getElementById('craft-modal')?.classList.remove('active'); });
    document.getElementById('craft-modal')?.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });
    document.getElementById('btn-scan-qr')?.addEventListener('click', async () => { const text = await showInput('Вставь данные из QR', ''); if (text) { try { const qrData = JSON.parse(text); window._expectedPubKey = qrData.pubKey; const ok = await P2PPong.joinBeacon(qrData.beaconId); if (ok) { rMsg('📷 QR принят!', 3000); document.getElementById('craft-modal')?.classList.remove('active'); } } catch(e) { rMsg('❌ Неверный формат', 3000); } } });
    document.getElementById('btn-create-beacon')?.addEventListener('click', async () => { const targetId = document.getElementById('peer-id-input')?.value.trim(); if (targetId) { const ok = await P2PPong.joinBeacon(targetId); if (ok) { rMsg('🏹 Тетива натянута...', 3000); document.getElementById('craft-modal')?.classList.remove('active'); } } });
    document.getElementById('btn-verify-confirm')?.addEventListener('click', async () => { const inputCode = window._verifyInput || ''; const expectedCode = window._verifyCode || ''; const errEl = document.getElementById('verify-error'); if (inputCode.length !== 7) { if (errEl) { errEl.textContent = 'Введи ровно 7 цифр'; errEl.style.display = 'block'; } return; } if (inputCode === expectedCode) { if (errEl) errEl.style.display = 'none'; verificationModalShown = false; verificationDone = true; document.getElementById('verify-modal')?.classList.remove('active'); await P2PPong.confirmVerification(); rMsg('✅ Подтверждено!', 3000); } else { if (errEl) { errEl.textContent = '❌ Неверный код.'; errEl.style.display = 'block'; } window._verifyInput = ''; document.getElementById('verify-code-display').textContent = '_______'; } });
    document.getElementById('close-verify-modal')?.addEventListener('click', () => { document.getElementById('verify-modal')?.classList.remove('active'); verificationModalShown = false; });
    document.getElementById('verify-modal')?.addEventListener('click', function(e) { if (e.target === this) { this.classList.remove('active'); verificationModalShown = false; } });
    document.getElementById('btn-clear')?.addEventListener('click', async () => { const confirmed = await showConfirm('🔥 Скурить колчан?', 'Вся переписка будет уничтожена безвозвратно. Собеседник потеряет доступ.'); if (!confirmed) return; const box = document.getElementById('chat-box'); if (box) box.querySelectorAll('.message-row').forEach(m => m.remove()); if (activeChannelId) { P2PPong.sendMessage(activeChannelId, JSON.stringify({ type: 'channel-destroyed', channelId: activeChannelId })); performDestruction(activeChannelId, 'local'); } });
    document.getElementById('btn-settings')?.addEventListener('click', () => { closeSheets(); document.getElementById('settings-sheet')?.classList.add('open'); document.getElementById('overlay')?.classList.add('show'); });
    document.getElementById('settings-close')?.addEventListener('click', closeSheets); document.getElementById('overlay')?.addEventListener('click', closeSheets);
    document.getElementById('btn-avatar')?.addEventListener('click', () => { closeSheets(); loadAvatars(); document.getElementById('avatar-selector')?.classList.add('show'); document.getElementById('overlay')?.classList.add('show'); });
    document.getElementById('nick-label')?.addEventListener('click', () => { document.getElementById('nick-modal')?.classList.add('active'); document.getElementById('nick-input').value = document.getElementById('nick-label')?.textContent || ''; });
    document.getElementById('btn-save-nick')?.addEventListener('click', () => { const n = document.getElementById('nick-input')?.value.trim(); if (n) { const nl2 = document.getElementById('nick-label'); if (nl2) nl2.textContent = n.substring(0, 12); try { localStorage.setItem('robinhood_nick', n.substring(0, 12)); } catch (e) {} P2PPong.setMyProfile(n.substring(0, 12), selectedAvatar); } document.getElementById('nick-modal')?.classList.remove('active'); });
    document.getElementById('close-nick-modal')?.addEventListener('click', () => { document.getElementById('nick-modal')?.classList.remove('active'); });
    document.getElementById('setting-theme')?.addEventListener('click', generateRandomTheme);
    document.getElementById('setting-videobg')?.addEventListener('click', () => {
        cycleBackground();
        playSound('shot.mp3');
        rMsg('🎬 Фон: ' + videoBackgrounds[currentBgIndex].name, 2000);
    });
    document.getElementById('setting-terms')?.addEventListener('click', () => { window.open('https://github.com/stepweather-prog/ROBINHOOD-P2P/blob/main/README.md', '_blank'); });
    si?.addEventListener('click', () => { if (deferredPrompt) deferredPrompt.prompt().catch(() => {}); else rMsg('📲 Меню браузера → Добавить на экран', 4000); document.getElementById('settings-sheet')?.classList.remove('open'); document.getElementById('overlay')?.classList.remove('show'); });
    window.addEventListener('beforeinstallprompt', e => { deferredPrompt = e; });
    if (ts) ts.addEventListener('change', function() { toggleSoundState = this.checked; try { localStorage.setItem('robinhood_sound', toggleSoundState); } catch (e) {} });
    if (ta) ta.addEventListener('change', function() { 
        toggleAnimations = this.checked; 
        try { localStorage.setItem('robinhood_animations', toggleAnimations); } catch (e) {}
        
        if (!this.checked) {
            stopSelfDestruct();
            document.getElementById('leaves-container')?.classList.add('sleeping');
        } else {
            if (selfDestructMode) startSelfDestruct();
            document.getElementById('leaves-container')?.classList.remove('sleeping');
        }
    });
    if (sd) sd.addEventListener('change', function() { selfDestructMode = this.checked; try { localStorage.setItem('robinhood_selfdestruct', selfDestructMode); } catch (e) {} if (selfDestructMode) { startSelfDestruct(); if (activeChannelId) P2PPong.sendMessage(activeChannelId, JSON.stringify({ d: '__SMOKE__' })); rMsg('🍁 Листопад включён!', 3000); } else { stopSelfDestruct(); rMsg('🍂 Листопад остановлен.', 3000); } });
    document.getElementById('btn-voice-input')?.addEventListener('click', toggleVoiceRecording);

    const emojis = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😢','😡','👍','👎','❤️','🔥','🎉','💀','🏹','🌲','🏰','🦊','🐺','✨','⚔️','🛡️','🍺','🍗','🏕️','🌙','☀️','🌟','💪','🤝','🙏','👑','💰','🎯','📞','💬','🔔','❌','✅','🎵','📜','⚜️'];
    const eg = document.getElementById('emoji-grid'); if (eg) emojis.forEach(e => { const span = document.createElement('span'); span.textContent = e; span.addEventListener('click', () => { const mi = document.getElementById('msg-input'); if (mi) { mi.value += e; mi.focus(); } }); eg.appendChild(span); });
    const be = document.getElementById('btn-emoji'); if (be) be.addEventListener('click', () => { const ep = document.getElementById('emoji-panel'); if (ep) ep.style.display = ep.style.display === 'block' ? 'none' : 'block'; });
    document.addEventListener('click', e => { const ep = document.getElementById('emoji-panel'); if (ep && !ep.contains(e.target) && e.target !== be) ep.style.display = 'none'; });

    document.getElementById('send-btn')?.addEventListener('click', async () => { const mi = document.getElementById('msg-input'); const t = mi?.value.trim(); if (t) { if (!activeChannelId) { const chIds = Object.keys(P2PPong._channels); if (!chIds.length) return; activeChannelId = chIds[0]; } const sent = await P2PPong.sendMessage(activeChannelId, t); if (sent) { appendMessage('Вы', t, selectedAvatar);  if (mi) mi.value = ''; playArcherAnimation(); if (toggleSoundState) playSound('shot.mp3'); } } });
    document.getElementById('msg-input')?.addEventListener('keypress', e => { if (e.key == 'Enter') document.getElementById('send-btn')?.click(); });
    setConnectionStatus('online');
}

window.addEventListener('beforeunload', () => { if (voiceTimerInterval) clearInterval(voiceTimerInterval); stopSelfDestruct(); P2PPong.destroy(); });

P2PPong.on('ready', () => {
    initUI();
    initApp();
    const loadingVideo = document.getElementById('loading-video');
    if (loadingVideo) {
        loadingVideo.onended = function() {
            const loadingScreen = document.getElementById('loading-screen');
            if (loadingScreen) {
                loadingScreen.style.transition = 'opacity 0.5s';
                loadingScreen.style.opacity = '0';
                setTimeout(() => { loadingScreen.style.display = 'none'; }, 500);
            }
        };
    } else {
        const loadingScreen = document.getElementById('loading-screen');
        if (loadingScreen) loadingScreen.style.display = 'none';
    }
});
P2PPong.init();
