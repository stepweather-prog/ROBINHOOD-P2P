// ==================== RobinHood UI ====================
// Чистый интерфейс. Ядро: P2PPong.

let contacts = [],
    activeChannelId = null,
    activePeerId = null,
    selectedAvatar = '001';
let toggleSoundState = true,
    selfDestructMode = false;
let pc = null,
    localStream = null,
    callActive = false,
    incomingOffer = null,
    ringtoneAudio = null,
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
let deferredPrompt = null,
    speakerOn = true,
    micOn = true,
    iceBuffer = [],
    iceFlushTimer = null,
    iceRestartTimer = null,
    iceRestartInProgress = false;
let hangInProgress = false;
let verificationModalShown = false;
let verificationDone = false;

const avatars = [];
for (let i = 1; i <= 168; i++) avatars.push('assets/avatar/' + String(i).padStart(3, '0') + 'ava.png');

function safeHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function rMsg(t, d = 4000) { const rt = document.getElementById('robin-text'); if (!rt) return; clearTimeout(robinTimer); rt.textContent = t; if (d > 0) robinTimer = setTimeout(() => { rt.textContent = robinDefaultText; }, d); }
function setConnectionStatus(s) { const ic = document.getElementById('connection-icon'); if (ic) ic.src = s === 'online' ? 'assets/icons/06icon.png' : 'assets/icons/05icon.png'; }
function playSound(f) { if (!toggleSoundState) return; if (!audioPool[f]) { audioPool[f] = new Audio('assets/sounds/' + f); audioPool[f].volume = 0.5; audioPool[f].load(); } const a = audioPool[f]; a.currentTime = 0; a.play().catch(e => {}); }
function closeSheets() { document.getElementById('avatar-selector')?.classList.remove('show'); document.getElementById('settings-sheet')?.classList.remove('open'); document.getElementById('overlay')?.classList.remove('show'); }

function playSmokeAnimation() { const smoke = document.createElement('div'); smoke.className = 'smoke-anim'; document.body.appendChild(smoke); if (typeof lottie !== 'undefined') { try { lottie.loadAnimation({ container: smoke, renderer: 'canvas', loop: false, autoplay: true, path: 'assets/smoke.json' }); } catch (e) {} } setTimeout(() => { if (smoke.parentNode) smoke.remove(); }, 5000); }
function playArcherAnimation() { const rt = document.getElementById('robin-text'); if (!rt) return; if (currentArrowContainer?.parentNode) currentArrowContainer.remove(); if (archerAnimation) { archerAnimation.destroy(); archerAnimation = null; } const wrapper = document.createElement('span'); wrapper.className = 'robin-arrow-container'; wrapper.style.cssText = 'width:80px;height:40px;display:inline-block;vertical-align:middle;'; currentArrowContainer = wrapper; rt.textContent = ''; rt.appendChild(wrapper); if (typeof lottie !== 'undefined') { try { archerAnimation = lottie.loadAnimation({ container: wrapper, renderer: 'canvas', loop: false, autoplay: true, path: 'assets/Archer.json' }); archerAnimation.addEventListener('complete', () => { if (wrapper.parentNode) wrapper.remove(); currentArrowContainer = null; archerAnimation = null; rt.textContent = robinDefaultText; }); } catch (e) { wrapper.textContent = '🏹'; setTimeout(() => { if (wrapper.parentNode) wrapper.remove(); currentArrowContainer = null; rt.textContent = robinDefaultText; }, 1500); } } else { wrapper.textContent = '🏹'; setTimeout(() => { if (wrapper.parentNode) wrapper.remove(); currentArrowContainer = null; rt.textContent = robinDefaultText; }, 1500); } }
function playBowAnimation() { const bc = document.getElementById('bow-above-send'); if (!bc) return; if (bowAnim) { bowAnim.destroy(); bowAnim = null; } bc.style.display = 'block'; if (typeof lottie !== 'undefined') { try { bowAnim = lottie.loadAnimation({ container: bc, renderer: 'canvas', loop: false, autoplay: true, path: 'assets/bow.json' }); bowAnim.addEventListener('complete', () => { bc.style.display = 'none'; bowAnim = null; }); } catch (e) { bc.textContent = '🏹'; setTimeout(() => { bc.style.display = 'none'; bc.textContent = ''; }, 800); } } else { bc.textContent = '🏹'; setTimeout(() => { bc.style.display = 'none'; bc.textContent = ''; }, 800); } const sb = document.getElementById('send-btn'); if (sb) { sb.classList.add('shooting'); setTimeout(() => sb.classList.remove('shooting'), 400); } }
function playQuiverAnimation() {
    const quiver = document.createElement('div');
    quiver.className = 'quiver-anim';
    const img = document.createElement('img');
    img.src = 'assets/docking.gif?t=' + Date.now();
    img.style.cssText = 'width:150px;height:150px;object-fit:contain;';
    img.onerror = () => { quiver.innerHTML = '<div style="font-size:80px;">🏹</div>'; };
    quiver.appendChild(img);
    document.body.appendChild(quiver);
    setTimeout(() => { quiver.style.opacity = '0'; quiver.style.transition = 'opacity 0.5s'; setTimeout(() => quiver.remove(), 500); }, 3500);
}

function showCallWave(show) { const cw = document.getElementById('call-wave'); if (!cw) return; if (show) { cw.innerHTML = ''; cw.style.display = 'flex'; for (let i = 0; i < 8; i++) { const bar = document.createElement('div'); bar.className = 'voice-wave-bar'; bar.style.animation = 'wave 1s ease-in-out infinite'; bar.style.animationDelay = `${i * 0.1}s`; cw.appendChild(bar); } } else { cw.style.display = 'none'; cw.innerHTML = ''; } }
function showVoiceRecordingUI(show) { const old = document.getElementById('voice-recording-indicator'); if (old) old.remove(); if (!show) return; const btn = document.getElementById('btn-voice-input'); if (!btn) return; const container = document.createElement('div'); container.id = 'voice-recording-indicator'; container.className = 'voice-recording-indicator'; const timer = document.createElement('span'); timer.className = 'voice-timer-text'; timer.id = 'voice-timer-text'; timer.textContent = '🎤 0:00'; const wave = document.createElement('div'); wave.style.cssText = 'display:flex;align-items:flex-end;gap:2px;height:18px;'; for (let i = 0; i < 6; i++) { const bar = document.createElement('div'); bar.className = 'voice-wave-bar'; bar.style.cssText = `width:3px;animation:wave 1s ease-in-out infinite;animation-delay:${i * 0.08}s;height:${6 + i * 3}px;`; wave.appendChild(bar); } container.appendChild(timer); container.appendChild(wave); btn.parentNode.insertBefore(container, btn); }
function showIncomingControls(show) { const ic = document.getElementById('incoming-call-controls'); if (ic) ic.style.display = show ? 'flex' : 'none'; }
function showActiveControls(show) { const ac = document.getElementById('active-call-controls'); if (ac) ac.style.display = show ? 'flex' : 'none'; }
function updateCallButtonState() { const btn = document.getElementById('btn-call'); if (!btn) return; btn.classList.remove('calling', 'ringing'); if (callActive) btn.classList.add('calling'); else if (incomingOffer) btn.classList.add('ringing'); }
function playRingtone() { stopRingtone(); ringtoneAudio = new Audio('assets/sounds/melodi.mp3'); ringtoneAudio.loop = true; ringtoneAudio.volume = 0.5; ringtoneAudio.load(); ringtoneAudio.play().catch(e => {}); }
function stopRingtone() { if (ringtoneAudio) { ringtoneAudio.pause(); ringtoneAudio.loop = false; ringtoneAudio = null; } }
function playRingback() { stopRingback(); ringbackAudio = new Audio('assets/sounds/Welk.mp3'); ringbackAudio.loop = true; ringbackAudio.volume = 0.5; ringbackAudio.load(); ringbackAudio.play().catch(e => {}); }
function stopRingback() { if (ringbackAudio) { ringbackAudio.pause(); ringbackAudio.loop = false; ringbackAudio = null; } }

function startVoiceTimer() { voiceSeconds = 0; const vt = document.getElementById('voice-timer-text'); if (vt) vt.textContent = '🎤 0:00'; voiceTimerInterval = setInterval(() => { voiceSeconds++; const m = Math.floor(voiceSeconds / 60), s = (voiceSeconds % 60).toString().padStart(2, '0'); const vt = document.getElementById('voice-timer-text'); if (vt) vt.textContent = '🎤 ' + m + ':' + s; }, 1000); }
function stopVoiceTimer() { if (voiceTimerInterval) clearInterval(voiceTimerInterval); }
function toggleVoiceRecording() { voiceRecording ? stopVoiceRecording() : startVoiceRecording(); }
function startVoiceRecording() { if (voiceRecorder?.state === 'recording') return; navigator.mediaDevices.getUserMedia({ audio: true }).then(st => { voiceStream = st; voiceRecorder = new MediaRecorder(st, { mimeType: 'audio/webm; codecs=opus', audioBitsPerSecond: 16000 }); voiceChunks = []; voiceRecorder.ondataavailable = e => voiceChunks.push(e.data); voiceRecorder.onstop = () => { if (voiceRecTimeout) clearTimeout(voiceRecTimeout); const blob = new Blob(voiceChunks, { type: 'audio/webm' }); if (blob.size > 100 && blob.size < 300000 && activeChannelId) { const reader = new FileReader(); reader.onload = async () => { const b64 = reader.result.split(',')[1]; await P2PPong.sendVoiceMessage(activeChannelId, b64); appendMessage('Вы', '🎤 Голосовое', selectedAvatar, b64, 'audio/webm'); }; reader.readAsDataURL(blob); } if (voiceStream) { voiceStream.getTracks().forEach(t => t.stop()); voiceStream = null; } voiceRecorder = null; voiceRecording = false; stopVoiceTimer(); document.getElementById('btn-voice-input').style.background = ''; showVoiceRecordingUI(false); }; voiceRecorder.start(); voiceRecording = true; startVoiceTimer(); document.getElementById('btn-voice-input').style.background = '#f44336'; showVoiceRecordingUI(true); voiceRecTimeout = setTimeout(() => { if (voiceRecorder?.state === 'recording') { voiceRecorder.stop(); rMsg('⏰ Максимальная длина записи — 10 секунд', 3000); } }, 10000); }).catch(e => { voiceChunks = []; rMsg('❌ Микрофон недоступен или занят', 3000); }); }
function stopVoiceRecording() { if (voiceRecorder?.state === 'recording') voiceRecorder.stop(); }
function playVoiceBlob(b64) { const a = new Audio('data:audio/webm;base64,' + b64); a.load(); a.play().catch(e => {}); }

function appendMessage(sender, text, avatarSrc, audioData, audioMime) { const box = document.getElementById('chat-box'); const row = document.createElement('div'); row.className = 'message-row'; const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); const av = getAvatarUrl(avatarSrc); if (audioData && audioMime && audioMime.startsWith('audio/')) { const player = createAudioPlayer(audioData, audioMime); row.innerHTML = `<img src="${av}" class="avatar" onerror="this.src='assets/avatar/001ava.png'"><div class="msg-body"><div class="msg-sender">${safeHtml(sender)}</div></div>`; row.querySelector('.msg-body').appendChild(player); const ts = document.createElement('div'); ts.className = 'msg-status'; ts.textContent = time; row.querySelector('.msg-body').appendChild(ts); } else { row.innerHTML = `<img src="${av}" class="avatar" onerror="this.src='assets/avatar/001ava.png'"><div class="msg-body"><div class="msg-sender">${safeHtml(sender)}</div><div>${safeHtml(text)}</div><div class="msg-status">${time}</div></div>`; } const msgId = 'msg_' + Date.now() + Math.random(); row.dataset.msgId = msgId; box.insertBefore(row, document.getElementById('typing-indicator')); box.scrollTop = box.scrollHeight; if (selfDestructMode) { setTimeout(() => { const el = document.querySelector(`[data-msg-id="${msgId}"]`); if (el) { el.style.transition = 'opacity 0.5s'; el.style.opacity = '0'; setTimeout(() => { if (el.parentNode) el.remove(); }, 500); } }, 30000); } }
function createAudioPlayer(audioData, audioMime) { const container = document.createElement('div'); container.className = 'audio-player audio-paused'; const audio = new Audio('data:' + audioMime + ';base64,' + audioData); audio.load(); let isPlaying = false; const playBtn = document.createElement('button'); playBtn.className = 'audio-play-btn'; playBtn.textContent = '▶'; const waveDiv = document.createElement('div'); waveDiv.className = 'audio-wave'; for (let i = 0; i < 8; i++) { const bar = document.createElement('div'); bar.className = 'audio-wave-bar'; waveDiv.appendChild(bar); } const timeSpan = document.createElement('span'); timeSpan.className = 'audio-time'; timeSpan.textContent = '0:00'; playBtn.addEventListener('click', () => { if (isPlaying) { audio.pause(); container.classList.remove('audio-playing'); container.classList.add('audio-paused'); playBtn.textContent = '▶'; } else { audio.play(); container.classList.remove('audio-paused'); container.classList.add('audio-playing'); playBtn.textContent = '⏸'; } isPlaying = !isPlaying; }); audio.addEventListener('timeupdate', () => { const m = Math.floor(audio.currentTime / 60); const s = Math.floor(audio.currentTime % 60).toString().padStart(2, '0'); timeSpan.textContent = m + ':' + s; }); audio.addEventListener('ended', () => { container.classList.remove('audio-playing'); container.classList.add('audio-paused'); playBtn.textContent = '▶'; isPlaying = false; }); container.appendChild(playBtn); container.appendChild(waveDiv); container.appendChild(timeSpan); return container; }
function showChatForChannel(channelId) { activeChannelId = channelId; const ct = contacts.find(c => c.channelId === channelId); if (ct) { activePeerId = ct.peerId; document.getElementById('robin-bar-sender').textContent = ct.name || 'Лучник'; } const box = document.getElementById('chat-box'); box.innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; const ch = P2PPong._channels[channelId]; if (ch && ch.blobs) { ch.blobs.forEach(b => { const im = b.from === 'me'; const ct2 = contacts.find(c => c.channelId === channelId); appendMessage(im ? 'Вы' : (ct2?.name || 'Друг'), b.d || b.text || '', im ? selectedAvatar : (ct2?.avatar || '001')); }); } updateCupIndicator(); updateRatchetIndicator(); }

function getAvatarUrl(avatarSrc) { if (!avatarSrc || avatarSrc === '001') return 'assets/avatar/001ava.png'; if (avatarSrc.startsWith('assets/')) return avatarSrc.endsWith('.png') ? avatarSrc : avatarSrc + 'ava.png'; if (avatarSrc.includes('/')) return avatarSrc.endsWith('.png') ? avatarSrc : avatarSrc + 'ava.png'; return 'assets/avatar/' + avatarSrc + 'ava.png'; }
function addContact(c) { if (!contacts.find(x => x.peerId === c.peerId)) { contacts.push(c); saveContacts(); } else { const existing = contacts.find(x => x.peerId === c.peerId); if (c.name && c.name !== 'Лучник') existing.name = c.name; if (c.avatar && c.avatar !== '001') existing.avatar = c.avatar; if (c.channelId) existing.channelId = c.channelId; saveContacts(); } }
function saveContacts() { try { localStorage.setItem('rh_contacts', JSON.stringify(contacts)); } catch (e) {} }
function loadContacts() { try { const r = localStorage.getItem('rh_contacts'); if (r) contacts = JSON.parse(r); } catch (e) {} }

function updateCupIndicator() { const chId = activeChannelId || Object.keys(P2PPong._channels)[0]; const ch = chId ? P2PPong._channels[chId] : null; const ind = document.getElementById('cup-indicator'); if (!ch || !ind) { if (ind) ind.style.display = 'none'; return; } ind.style.display = 'inline-flex'; const bc = ch.blobs ? ch.blobs.length : 0; const be = document.getElementById('cup-blobs'); if (be) { be.textContent = bc + '/10'; be.className = bc >= 10 ? 'full' : bc >= 7 ? 'ok' : ''; } const totalSec = Math.max(0, Math.round((ch.expires - Date.now()) / 1000)); const min = Math.floor(totalSec / 60); const sec = totalSec % 60; const te = document.getElementById('cup-timer'); if (te) { te.textContent = min + ':' + sec.toString().padStart(2, '0'); te.className = min <= 2 ? 'low' : min <= 5 ? 'ok' : ''; } }
function updateRatchetIndicator() { const chId = activeChannelId || Object.keys(P2PPong._channels)[0]; const ch = chId ? P2PPong._channels[chId] : null; const indicator = document.getElementById('ratchet-indicator'); if (!indicator) return; if (!ch || !ch.ratchetKey) { indicator.style.display = 'none'; return; } indicator.style.display = 'inline'; const ri = ch.ratchetIndex || 0; let color, icon; if (ri === 0) { color = 'var(--danger)'; icon = '⚠️'; } else if (ri < 10) { color = 'orange'; icon = '🔄'; } else if (ri < 50) { color = 'var(--accent)'; icon = '🔒'; } else { color = 'var(--seeding-color)'; icon = '🔐'; } indicator.style.color = color; indicator.style.background = 'rgba(0,0,0,0.3)'; indicator.textContent = icon + ' ' + ri; indicator.title = 'Ratchet: ' + ri + ' оборотов'; }

const themes = [{ id: 'forest', name: 'Лес' }, { id: 'sunset', name: 'Закат' }, { id: 'ocean', name: 'Океан' }, { id: 'rose', name: 'Роза' }, { id: 'amber', name: 'Янтарь' }, { id: 'mint', name: 'Мята' }, { id: 'lavender', name: 'Лаванда' }, { id: 'cherry', name: 'Вишня' }, { id: 'emerald', name: 'Изумруд' }, { id: 'slate', name: 'Сланец' }, { id: 'coral', name: 'Коралл' }, { id: 'plum', name: 'Слива' }];
function applyTheme(id) { document.documentElement.setAttribute('data-theme', id); try { localStorage.setItem('robinhood_theme', id); } catch (e) {} const tn = document.getElementById('theme-name'); if (tn) tn.textContent = (themes.find(t => t.id === id) || themes[0]).name; }
function generateRandomTheme() { const hue = Math.floor(Math.random() * 360), sat = 40 + Math.floor(Math.random() * 50), bgLight = 5 + Math.floor(Math.random() * 15), bgDark = 2 + Math.floor(Math.random() * 8), id = 'random_' + Date.now(); const s = `[data-theme="${id}"]{--bg-primary:hsl(${hue},${sat}%,${bgLight}%);--bg-secondary:hsl(${hue},${sat-10}%,${bgDark}%);--accent:hsl(${(hue+30)%360},${sat+10}%,50%);--accent-light:hsl(${(hue+30)%360},${sat+20}%,70%);--text:hsl(${hue},20%,85%);--text-bright:hsl(${hue},25%,92%);--text-dim:hsl(${hue},15%,60%);--border:hsl(${(hue+30)%360},${sat+10}%,50%);--btn-bg:hsla(${(hue+30)%360},${sat+10}%,50%,0.1);--btn-border:hsla(${(hue+30)%360},${sat+10}%,50%,0.3);--btn-hover:hsla(${(hue+30)%360},${sat+10}%,50%,0.25);--sheet-bg:linear-gradient(145deg,hsl(${hue},${sat}%,${bgLight}%)0%,hsl(${hue},${sat-10}%,${bgDark}%)100%);--input-bg:hsla(${hue},${sat-10}%,${bgLight+2}%,0.9);--msg-bg:hsla(${hue},${sat-5}%,${bgLight+3}%,0.85);--msg-accent:hsl(${(hue+30)%360},${sat+10}%,50%);--robin-bg:hsla(${hue},${sat}%,${bgLight+8}%,0.9);--robin-accent:hsl(${(hue+30)%360},${sat+20}%,65%);--overlay-bg:rgba(0,0,0,0.6);--call-bg:linear-gradient(180deg,hsl(${hue},${sat}%,${bgLight}%)0%,hsl(${hue},${sat-10}%,${bgDark}%)100%);--call-btn-bg:hsla(${(hue+30)%360},${sat+10}%,50%,0.1);--call-btn-border:hsla(${(hue+30)%360},${sat+10}%,50%,0.3);--input-text:hsl(${hue},20%,85%)}`; let el = document.getElementById('gen-theme'); if (!el) { el = document.createElement('style'); el.id = 'gen-theme'; document.head.appendChild(el); } el.textContent = s; document.documentElement.setAttribute('data-theme', id); const tn = document.getElementById('theme-name'); if (tn) tn.textContent = 'Авто'; try { localStorage.setItem('robinhood_theme', id); } catch (e) {} }
function loadAvatars() { const list = document.getElementById('avatar-list'); if (!list) return; list.innerHTML = ''; avatars.forEach(src => { const img = document.createElement('img'); img.src = src; img.className = 'avatar-option'; img.onerror = () => img.src = 'assets/avatar/001ava.png'; img.onclick = () => { const pas = document.getElementById('profile-avatar-small'); if (pas) pas.src = src; document.getElementById('robin-avatar').src = src; selectedAvatar = src.includes('/') ? src.split('/').pop()?.replace('ava.png', '') || '001' : src; try { localStorage.setItem('robinhood_avatar', src); } catch (e) {} const savedNick = document.getElementById('nick-label')?.textContent || 'Лучник'; P2PPong.setMyProfile(savedNick, selectedAvatar); closeSheets(); rMsg('🖼 Аватар обновлён'); }; list.appendChild(img); }); }

const LOCK_KEY = 'robinhood_lock_v2'; let lockType = null, lockPinHash = '', pinInput = '', isSettingLock = false, failedAttempts = 0;
const lockScreen = document.getElementById('lock-screen'), appContainer = document.getElementById('app-container');
async function pbkdf2Hash(text, salt) { try { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(text), 'PBKDF2', false, ['deriveBits']); const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256); return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join(''); } catch (e) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text + salt)); return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join(''); } }
async function loadLockSettings() { let saved; try { saved = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null'); } catch (e) {} if (saved) { lockType = saved.type; lockPinHash = saved.pinHash || ''; } failedAttempts = 0; if (!lockType) { lockScreen.style.display = 'none'; appContainer.style.display = 'flex'; P2PPong.init(); } else { lockScreen.style.display = 'flex'; appContainer.style.display = 'none'; setupLockUI(); } }
function setupLockUI() { const pinSection = document.getElementById('lock-pin-section'); const subtitle = document.getElementById('lock-subtitle'); const error = document.getElementById('lock-error'); if (pinSection) pinSection.style.display = ''; if (subtitle) subtitle.textContent = isSettingLock ? 'Задайте пин-код (5 цифр)' : 'Введите пин-код'; if (error) error.textContent = ''; pinInput = ''; drawNumpad(); updatePinDots(); }
function drawNumpad() { const np = document.getElementById('lock-numpad'); if (!np) return; np.innerHTML = ''; for (let i = 1; i <= 9; i++) { const btn = document.createElement('button'); btn.className = 'lock-num'; btn.textContent = i; btn.onclick = () => addPinDigit(i.toString()); np.appendChild(btn); } const btn0 = document.createElement('button'); btn0.className = 'lock-num zero'; btn0.textContent = '0'; btn0.onclick = () => addPinDigit('0'); np.appendChild(btn0); const btnDel = document.createElement('button'); btnDel.className = 'lock-num'; btnDel.textContent = '⌫'; btnDel.onclick = () => { pinInput = pinInput.slice(0, -1); updatePinDots(); }; np.appendChild(btnDel); }
function addPinDigit(d) { if (pinInput.length >= 5) return; pinInput += d; updatePinDots(); if (pinInput.length === 5) setTimeout(() => verifyPin(), 200); }
function updatePinDots() { const dots = document.querySelectorAll('.lock-pin-dot'); dots.forEach((d, i) => d.classList.toggle('filled', i < pinInput.length)); }
async function verifyPin() { if (isSettingLock) { if (!lockPinHash) { lockPinHash = pinInput; pinInput = ''; updatePinDots(); if (document.getElementById('lock-subtitle')) document.getElementById('lock-subtitle').textContent = 'Повторите пин-код'; return; } if (pinInput === lockPinHash) { const hash = await pbkdf2Hash(pinInput, 'robinhood_lock_salt'); try { localStorage.setItem(LOCK_KEY, JSON.stringify({ type: 'pin', pinHash: hash })); } catch (e) {} lockType = 'pin'; lockPinHash = hash; isSettingLock = false; pinInput = ''; updatePinDots(); const ls = document.getElementById('lock-status'); if (ls) ls.textContent = 'Пин-код'; unlockApp(); } else { const err = document.getElementById('lock-error'); if (err) err.textContent = 'Не совпадают. Попробуйте снова.'; lockPinHash = ''; pinInput = ''; updatePinDots(); const sub = document.getElementById('lock-subtitle'); if (sub) sub.textContent = 'Задайте пин-код (5 цифр)'; } } else { const hash = await pbkdf2Hash(pinInput, 'robinhood_lock_salt'); if (hash === lockPinHash) { failedAttempts = 0; unlockApp(); } else { failedAttempts++; pinInput = ''; updatePinDots(); if (failedAttempts >= 3) { document.querySelectorAll('.lock-num').forEach(b => b.disabled = true); const err = document.getElementById('lock-error'); if (err) err.textContent = 'Заблокировано. Обновите страницу.'; } else { const err = document.getElementById('lock-error'); if (err) err.textContent = 'Неверно. Осталось попыток: ' + (3 - failedAttempts); } } } }
function unlockApp() { lockScreen.style.display = 'none'; appContainer.style.display = 'flex'; P2PPong.init(); }

async function getMediaStream(video = false) { try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' } : false }); } catch (e) { return null; } }
function createPC() { if (pc) { pc.onconnectionstatechange = null; pc.ontrack = null; pc.onicecandidate = null; pc.close(); pc = null; } iceBuffer = []; if (iceFlushTimer) clearTimeout(iceFlushTimer); try { pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'turn:robinhoodp2p.metered.live:80?transport=tcp', username: '466624d8364bb4660ed45c7d', credential: 'mpODzmBDhwG/b+VL' }, { urls: 'turn:robinhoodp2p.metered.live:443?transport=tcp', username: '466624d8364bb4660ed45c7d', credential: 'mpODzmBDhwG/b+VL' }] }); } catch (e) { return null; } if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream)); pc.ontrack = e => { if (e.streams[0]) { const a = new Audio(); a.srcObject = e.streams[0]; a.load(); a.play().catch(er => {}); } }; pc.onicecandidate = e => { if (e.candidate) { iceBuffer.push(e.candidate); } else { iceFlushTimer = setTimeout(() => { iceBuffer.forEach(c => sendWebRTCMsg('webrtc-ice', JSON.stringify(c))); iceBuffer = []; }, 100); } }; pc.onconnectionstatechange = () => { if (pc.connectionState == 'connected') { callActive = true; stopRingback(); stopRingtone(); document.getElementById('call-status').textContent = '✅ Разговор'; showIncomingControls(false); showActiveControls(true); showCallWave(true); playSound('open.mp3'); updateCallButtonState(); playArcherAnimation(); if (iceRestartTimer) clearTimeout(iceRestartTimer); iceRestartInProgress = false; } if (pc.connectionState == 'disconnected' && callActive && !iceRestartInProgress) { if (iceRestartTimer) clearTimeout(iceRestartTimer); iceRestartInProgress = true; iceRestartTimer = setTimeout(async () => { if (pc && pc.connectionState === 'disconnected') { try { await restartICE(); } catch (e) { hang(false); } finally { iceRestartInProgress = false; } } }, 15000); } if (pc.connectionState == 'failed') { if (iceRestartTimer) clearTimeout(iceRestartTimer); iceRestartInProgress = false; hang(false); } }; return pc; }
async function restartICE() { if (!pc || pc.connectionState === 'closed') return; const offer = await pc.createOffer({ iceRestart: true }); await pc.setLocalDescription(offer); sendWebRTCMsg('webrtc-offer', JSON.stringify(pc.localDescription)); }
async function sendWebRTCMsg(type, sdp) { if (!activeChannelId) return; await P2PPong.sendMessage(activeChannelId, JSON.stringify({ webrtc: type, sdp })); }
async function startCall() { if (callActive || !activeChannelId) { rMsg('❌ Нет канала', 3000); return; } const s = await getMediaStream(false); if (!s) { rMsg('❌ Нет микрофона', 3000); return; } localStream = s; createPC(); const cp = document.getElementById('call-panel'); if (cp) cp.style.display = 'flex'; const ct = contacts.find(c => c.channelId === activeChannelId); document.getElementById('call-avatar').src = 'assets/avatar/' + (ct?.avatar || selectedAvatar) + 'ava.png'; document.getElementById('call-contact-name').textContent = ct?.name || document.getElementById('nick-label')?.textContent || 'Лучник'; document.getElementById('call-status').textContent = '📞 Вызов...'; showIncomingControls(false); showActiveControls(true); showCallWave(false); playRingback(); playArcherAnimation(); try { const o = await pc.createOffer(); await pc.setLocalDescription(o); sendWebRTCMsg('webrtc-offer', JSON.stringify(o)); setTimeout(() => { if (!callActive && pc && pc.signalingState === 'have-local-offer') { sendWebRTCMsg('webrtc-offer', JSON.stringify(o)); } }, 3000); } catch (e) { hang(false); } updateCallButtonState(); }
async function acceptCall() { if (!incomingOffer || !activeChannelId) return; stopRingtone(); stopRingback(); const s = await getMediaStream(false); if (!s) return; localStream = s; createPC(); const cp = document.getElementById('call-panel'); if (cp) cp.style.display = 'flex'; const ct = contacts.find(c => c.channelId === activeChannelId); document.getElementById('call-avatar').src = 'assets/avatar/' + (ct?.avatar || selectedAvatar) + 'ava.png'; document.getElementById('call-contact-name').textContent = ct?.name || document.getElementById('nick-label')?.textContent || 'Лучник'; document.getElementById('call-status').textContent = '✅ Разговор'; showIncomingControls(false); showActiveControls(true); showCallWave(true); playSound('open.mp3'); playArcherAnimation(); try { const offerSdp = typeof incomingOffer === 'string' ? JSON.parse(incomingOffer) : incomingOffer; await pc.setRemoteDescription(new RTCSessionDescription(offerSdp)); iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(er => {})); iceBuffer = []; const a = await pc.createAnswer(); await pc.setLocalDescription(a); sendWebRTCMsg('webrtc-answer', JSON.stringify(a)); incomingOffer = null; callActive = true; } catch (e) { incomingOffer = null; hang(false); } updateCallButtonState(); }
function hang(sig = true) { if (hangInProgress) return; hangInProgress = true; callActive = false; stopRingtone(); stopRingback(); if (sig && activeChannelId) sendWebRTCMsg('webrtc-hangup', ''); if (pc) { pc.onconnectionstatechange = null; pc.ontrack = null; pc.onicecandidate = null; pc.close(); pc = null; } if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; } incomingOffer = null; iceBuffer = []; if (iceFlushTimer) clearTimeout(iceFlushTimer); if (iceRestartTimer) clearTimeout(iceRestartTimer); iceRestartInProgress = false; const cp = document.getElementById('call-panel'); if (cp) cp.style.display = 'none'; showIncomingControls(false); showActiveControls(false); showCallWave(false); playSound('exet.mp3'); updateCallButtonState(); hangInProgress = false; }

function initUI() {
    P2PPong.on('ready', () => { setConnectionStatus('online'); rMsg('🏹 Слепой Улей готов', 0); });
    P2PPong.on('state-change', (data) => { if (data.state === 'online') setConnectionStatus('online'); else if (data.state === 'offline') setConnectionStatus('offline'); });
    P2PPong.on('peer-connected', () => { rMsg('🔗 Прямой канал установлен', 3000); });
    P2PPong.on('message-received', (data) => { handleIncomingMessage(data); });
    P2PPong.on('message-sent', () => { updateCupIndicator(); updateRatchetIndicator(); });
    P2PPong.on('beacon-taken', () => { rMsg('👀 Маяк забрали...', 3000); });

    P2PPong.on('verification-needed', (data) => {
        if (verificationModalShown) return;
        verificationModalShown = true;
        verificationDone = false;
        document.getElementById('verify-instruction').textContent = 'Выбери 5 знаков в правильном порядке';
        document.getElementById('verify-error').style.display = 'none';
        document.getElementById('verify-selected').textContent = '';
        window._verifyCorrect = P2PPong.getVerificationEmoji();
        window._verifySelected = [];
        const grid = document.getElementById('verify-emoji-grid'); grid.innerHTML = '';
        const allEmoji = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😇','🤠','🫡','🤔','😏','😤','🥺','😱','💀','👽','🤖'];
        const correct = [...window._verifyCorrect]; const fake = [];
        while (fake.length < 5) { const e = allEmoji[Math.floor(Math.random()*allEmoji.length)]; if (!correct.includes(e) && !fake.includes(e)) fake.push(e); }
        const all = [...correct, ...fake].sort(() => Math.random()-0.5);
        all.forEach(e => { const btn = document.createElement('button'); btn.textContent = e; btn.className = 'verify-emoji-btn'; btn.onclick = () => { if (window._verifySelected.length >= 5) return; window._verifySelected.push(e); document.getElementById('verify-selected').textContent = window._verifySelected.join(''); }; grid.appendChild(btn); });
        document.getElementById('btn-verify-reset').onclick = () => { window._verifySelected = []; document.getElementById('verify-selected').textContent = ''; };
        document.getElementById('verify-modal')?.classList.add('active');
    });

    P2PPong.on('verification-received', (data) => {
        if (verificationModalShown) return;
        verificationModalShown = true;
        verificationDone = false;
        document.getElementById('verify-instruction').textContent = 'Пир Б ввёл эти эмодзи. Подтверди:';
        document.getElementById('verify-emoji-display') && (document.getElementById('verify-emoji-display').textContent = Array.isArray(data.emoji) ? data.emoji.join(' ') : data.emoji);
        document.getElementById('verify-error').style.display = 'none';
        document.getElementById('verify-modal')?.classList.add('active');
    });

    P2PPong.on('channel-opened', (data) => { 
        if (!verificationDone) return;
        document.getElementById('verify-modal')?.classList.remove('active');
        verificationModalShown = false; 
        verificationDone = false;
        playQuiverAnimation(); 
        rMsg('✅ Колчан открыт! Тетива натянута!', 3000); 
        addContact({ peerId: data.peerId, name: data.nick || 'Лучник', channelId: data.channelId, verified: false, avatar: data.avatar || '001' }); 
        showChatForChannel(data.channelId); 
    });
    P2PPong.on('channel-expired', (data) => { if (data.channelId === activeChannelId) { activeChannelId = null; activePeerId = null; document.getElementById('robin-bar-sender').textContent = 'RobinHood P2P'; document.getElementById('chat-box').innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; } });
    P2PPong.on('error', (data) => { rMsg('❌ ' + data.message, 5000); });
    P2PPong.on('destroyed', () => { document.getElementById('chat-box').innerHTML = '<div class="typing-indicator" id="typing-indicator"></div>'; setConnectionStatus('offline'); if (lockScreen) lockScreen.style.display = 'none'; if (appContainer) appContainer.style.display = 'flex'; });
}

function handleIncomingMessage(data) {
    if (!data || !data.text) return;
    if (data.voiceData) { const ct = contacts.find(c => c.channelId === data.channelId); const nick = data.nick || ct?.name || 'Друг'; const avatar = data.avatar || ct?.avatar || '001'; if (data.channelId === activeChannelId) { appendMessage(nick, '🎤 Голосовое', avatar, data.voiceData, 'audio/webm'); } else { rMsg('🎤 Голосовое от ' + nick, 3000); playVoiceBlob(data.voiceData); } updateCupIndicator(); return; }
    try { const parsed = JSON.parse(data.text); if (parsed.webrtc) { handleWebRTCSignal(parsed.webrtc, parsed.sdp, data.channelId); return; } if (parsed.voice) { const ct = contacts.find(c => c.channelId === data.channelId); const nick = ct?.name || 'Друг'; const avatar = ct?.avatar || '001'; if (data.channelId === activeChannelId) { appendMessage(nick, '🎤 Голосовое', avatar, parsed.data, 'audio/webm'); } else { rMsg('🎤 Голосовое от ' + nick, 3000); playVoiceBlob(parsed.data); } updateCupIndicator(); return; } if (parsed.d === '__SMOKE__') { selfDestructMode = true; const sd = document.getElementById('toggle-selfdestruct'); if (sd) sd.checked = true; rMsg('🍁 Собеседник включил режим самоуничтожения', 3000); return; } } catch (e) {}
    const ct = contacts.find(c => c.channelId === data.channelId); const nick = data.nick || ct?.name || 'Лучник'; const avatar = data.avatar || ct?.avatar || '001';
    if (data.channelId === activeChannelId) { appendMessage(nick, data.text, avatar); } else { rMsg('Новое от ' + nick, 3000); }
    updateCupIndicator(); updateRatchetIndicator(); playSound('arrow_hit.wav');
}

function handleWebRTCSignal(type, sdp, channelId) {
    if (channelId && activeChannelId && channelId !== activeChannelId) return;
    if (type === 'webrtc-offer' && !callActive) { try { incomingOffer = typeof sdp === 'string' ? JSON.parse(sdp) : sdp; } catch(e) { incomingOffer = sdp; } playRingtone(); const cp = document.getElementById('call-panel'); if (cp) cp.style.display = 'flex'; const ct = contacts.find(c => c.channelId === activeChannelId); document.getElementById('call-avatar').src = 'assets/avatar/' + (ct?.avatar || selectedAvatar) + 'ava.png'; document.getElementById('call-contact-name').textContent = ct?.name || 'Лучник'; document.getElementById('call-status').textContent = '📞 Входящий...'; showIncomingControls(true); showActiveControls(false); updateCallButtonState(); playArcherAnimation(); return; }
    if (!pc) return;
    try {
        if (type === 'webrtc-answer') { if (pc.signalingState === 'have-local-offer') { const answerSdp = typeof sdp === 'string' ? JSON.parse(sdp) : sdp; pc.setRemoteDescription(new RTCSessionDescription(answerSdp)).then(() => { callActive = true; stopRingback(); document.getElementById('call-status').textContent = '✅ Разговор'; showIncomingControls(false); showActiveControls(true); showCallWave(true); playSound('open.mp3'); updateCallButtonState(); playArcherAnimation(); }).catch(e => {}); } }
        else if (type === 'webrtc-ice') { if (pc.remoteDescription) { const candidate = typeof sdp === 'string' ? JSON.parse(sdp) : sdp; pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => {}); } }
        else if (type === 'webrtc-hangup') { hang(false); }
    } catch (e) {}
}

function updateDateTime() { const now = new Date(); const de = document.getElementById('header-date'); const te = document.getElementById('header-time'); if (de) de.textContent = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }); if (te) te.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function resetInactivityTimer() { clearTimeout(inactivityTimer); document.getElementById('leaves-container')?.classList.remove('sleeping'); inactivityTimer = setTimeout(() => { document.getElementById('leaves-container')?.classList.add('sleeping'); }, 90000); }
let inactivityTimer;
document.addEventListener('pointermove', resetInactivityTimer); document.addEventListener('pointerdown', resetInactivityTimer); document.addEventListener('keypress', resetInactivityTimer);
window.addEventListener('blur', () => { clearTimeout(inactivityTimer); inactivityTimer = setTimeout(() => { document.getElementById('leaves-container')?.classList.add('sleeping'); }, 90000); });
window.addEventListener('focus', () => { clearTimeout(inactivityTimer); document.getElementById('leaves-container')?.classList.remove('sleeping'); resetInactivityTimer(); });
function initLeaves() { const c = document.getElementById('leaves-container'); if (!c || c.children.length > 0) return; const emojis = ['🍁','🍂','🌿','🍃','🪶','🍁','🍂','🌿','🍃','🪶','🍁','🌿']; for (let i = 0; i < 14; i++) { const el = document.createElement('span'); el.className = i % 3 == 0 ? 'feather' : 'leaf'; el.textContent = emojis[i]; el.style.left = Math.random() * 100 + '%'; el.style.animationDelay = Math.random() * 15 + 's'; el.style.animationDuration = (16 + Math.random() * 18) + 's'; c.appendChild(el); } resetInactivityTimer(); }

function initApp() {
    initLeaves(); applyTheme(localStorage.getItem('robinhood_theme') || 'slate');
    const savedAvatar = localStorage.getItem('robinhood_avatar'); if (savedAvatar) { selectedAvatar = savedAvatar.includes('/') ? savedAvatar.split('/').pop()?.replace('ava.png', '') || '001' : savedAvatar; const pas = document.getElementById('profile-avatar-small'); if (pas) pas.src = 'assets/avatar/' + selectedAvatar + 'ava.png'; document.getElementById('robin-avatar').src = 'assets/avatar/' + selectedAvatar + 'ava.png'; }
    const savedNick = localStorage.getItem('robinhood_nick'); const nl = document.getElementById('nick-label'); if (savedNick && nl) nl.textContent = savedNick.substring(0, 12);
    P2PPong.setMyProfile(savedNick || 'Лучник', selectedAvatar);
    toggleSoundState = localStorage.getItem('robinhood_sound') !== 'false'; const ts = document.getElementById('toggle-sound'); if (ts) ts.checked = toggleSoundState;
    selfDestructMode = localStorage.getItem('robinhood_selfdestruct') === 'true'; const sd = document.getElementById('toggle-selfdestruct'); if (sd) sd.checked = selfDestructMode;
    const ls = document.getElementById('lock-status'); if (ls) ls.textContent = lockType === 'pin' ? 'Пин-код' : 'Не задан';
    const isPWA = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone || false; const si = document.getElementById('setting-install'); if (!isPWA && si) si.classList.remove('hidden');

    document.getElementById('btn-craft')?.addEventListener('click', () => { document.getElementById('craft-modal')?.classList.add('active'); const pid = P2PPong._peerId; const display = document.getElementById('craft-peer-id-display'); if (display) display.textContent = pid || 'Не создана'; });
    document.getElementById('btn-craft-arrow')?.addEventListener('click', async () => { try { const peerId = await P2PPong.craftArrow(); const display = document.getElementById('craft-peer-id-display'); if (display) display.textContent = peerId; const emoji = P2PPong.getVerificationEmoji(); if (emoji && emoji.length) { const emojiDisplay = document.getElementById('craft-emoji-display'); if (emojiDisplay) { emojiDisplay.textContent = emoji.join(' '); emojiDisplay.style.display = 'block'; } } rMsg('🏹 Стрела изготовлена!', 3000); } catch(e) {} });
    document.getElementById('btn-copy-peer-id')?.addEventListener('click', () => { const pid = P2PPong._peerId; if (pid) { navigator.clipboard.writeText(pid).then(() => rMsg('⎘ Стрела скопирована!')).catch(() => {}); } });
    document.getElementById('close-craft-modal')?.addEventListener('click', () => { document.getElementById('craft-modal')?.classList.remove('active'); });
    document.getElementById('craft-modal')?.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });
    document.getElementById('btn-create-beacon')?.addEventListener('click', async () => { const targetId = document.getElementById('peer-id-input')?.value.trim(); if (targetId) { const ok = await P2PPong.joinBeacon(targetId); if (ok) { rMsg('🏹 Тетива натянута...', 3000); document.getElementById('craft-modal')?.classList.remove('active'); } } });

    document.getElementById('btn-verify-confirm')?.addEventListener('click', async () => {
        const selected = window._verifySelected || []; const expected = window._verifyCorrect || []; const errEl = document.getElementById('verify-error');
        if (selected.length !== expected.length) { if (errEl) { errEl.textContent = 'Выбери ровно 5 знаков'; errEl.style.display = 'block'; } return; }
        if (selected.join('') === expected.join('')) { if (errEl) errEl.style.display = 'none'; await P2PPong.confirmVerification(); document.getElementById('verify-modal')?.classList.remove('active'); verificationModalShown = false; verificationDone = true; rMsg('✅ Подтверждено!', 3000); }
        else { if (errEl) { errEl.textContent = '❌ Неверный порядок. Попробуй снова.'; errEl.style.display = 'block'; } window._verifySelected = []; document.getElementById('verify-selected').textContent = ''; }
    });

    document.getElementById('close-verify-modal')?.addEventListener('click', () => { document.getElementById('verify-modal')?.classList.remove('active'); verificationModalShown = false; });
    document.getElementById('verify-modal')?.addEventListener('click', function(e) { if (e.target === this) { this.classList.remove('active'); verificationModalShown = false; } });
    document.getElementById('btn-clear')?.addEventListener('click', () => { 
        const box = document.getElementById('chat-box'); if (box) box.querySelectorAll('.message-row').forEach(m => m.remove()); 
        playSmokeAnimation(); playSound('clear cache.mp3'); rMsg('🔥 Робин Гуд пустил все письма на самокрутки!', 5000); 
        contacts = []; saveContacts(); 
        setTimeout(() => {
            P2PPong.destroy().then(() => { 
                localStorage.clear(); 
                if ('caches' in window) { caches.keys().then(names => { names.forEach(name => caches.delete(name)); }); }
                if (window.indexedDB) { indexedDB.databases().then(dbs => { dbs.forEach(db => { indexedDB.deleteDatabase(db.name); }); }).catch(() => {}); }
                sessionStorage.clear();
                window.location.reload(true);
            });
        }, 6000);
    });
    document.getElementById('btn-settings')?.addEventListener('click', () => { closeSheets(); document.getElementById('settings-sheet')?.classList.add('open'); document.getElementById('overlay')?.classList.add('show'); });
    document.getElementById('settings-close')?.addEventListener('click', closeSheets);
    document.getElementById('overlay')?.addEventListener('click', closeSheets);
    document.getElementById('btn-avatar')?.addEventListener('click', () => { closeSheets(); loadAvatars(); document.getElementById('avatar-selector')?.classList.add('show'); document.getElementById('overlay')?.classList.add('show'); });
    document.getElementById('nick-label')?.addEventListener('click', () => { const modal = document.getElementById('nick-modal'); const input = document.getElementById('nick-input'); if (modal && input) { input.value = document.getElementById('nick-label')?.textContent || ''; modal.classList.add('active'); } });
    document.getElementById('btn-save-nick')?.addEventListener('click', () => { const n = document.getElementById('nick-input')?.value.trim(); if (n) { const nl2 = document.getElementById('nick-label'); if (nl2) nl2.textContent = n.substring(0, 12); try { localStorage.setItem('robinhood_nick', n.substring(0, 12)); } catch (e) {} P2PPong.setMyProfile(n.substring(0, 12), selectedAvatar); } document.getElementById('nick-modal')?.classList.remove('active'); });
    document.getElementById('close-nick-modal')?.addEventListener('click', () => { document.getElementById('nick-modal')?.classList.remove('active'); });
    document.getElementById('setting-theme')?.addEventListener('click', () => { const ct = localStorage.getItem('robinhood_theme') || 'slate'; const idx = themes.findIndex(t => t.id === ct); applyTheme(themes[(idx + 1) % themes.length].id); });
    document.getElementById('setting-theme-random')?.addEventListener('click', generateRandomTheme);
    document.getElementById('setting-terms')?.addEventListener('click', () => { window.open('https://github.com/stepweather-prog/ROBINHOOD-P2P/blob/main/README.md', '_blank'); });
    si?.addEventListener('click', () => { if (deferredPrompt) deferredPrompt.prompt().catch(() => {}); else rMsg('📲 Меню браузера → Добавить на экран', 4000); document.getElementById('settings-sheet')?.classList.remove('open'); document.getElementById('overlay')?.classList.remove('show'); });
    window.addEventListener('beforeinstallprompt', e => { deferredPrompt = e; });
    document.getElementById('btn-call')?.addEventListener('click', () => { callActive ? hang(true) : startCall(); });
    document.getElementById('call-accept')?.addEventListener('click', acceptCall);
    document.getElementById('call-reject')?.addEventListener('click', () => { if (incomingOffer) { stopRingtone(); sendWebRTCMsg('webrtc-hangup', ''); incomingOffer = null; const cp2 = document.getElementById('call-panel'); if (cp2) cp2.style.display = 'none'; updateCallButtonState(); } });
    document.getElementById('call-end')?.addEventListener('click', () => hang(true));
    document.getElementById('call-speaker')?.addEventListener('click', () => { speakerOn = !speakerOn; const s = document.getElementById('call-speaker'); if (s) { s.classList.toggle('active', speakerOn); s.textContent = speakerOn ? '🔊' : '🔇'; } });
    document.getElementById('call-mic')?.addEventListener('click', () => { if (!localStream) return; micOn = !micOn; localStream.getAudioTracks().forEach(t => t.enabled = micOn); const m = document.getElementById('call-mic'); if (m) { m.classList.toggle('muted', !micOn); m.textContent = micOn ? '🎤' : '🚫'; } });
    if (ts) ts.addEventListener('change', function() { toggleSoundState = this.checked; try { localStorage.setItem('robinhood_sound', toggleSoundState); } catch (e) {} });
    if (sd) sd.addEventListener('change', function() { selfDestructMode = this.checked; try { localStorage.setItem('robinhood_selfdestruct', selfDestructMode); } catch (e) {} if (selfDestructMode && activeChannelId) { P2PPong.sendMessage(activeChannelId, JSON.stringify({ d: '__SMOKE__' })); rMsg('🍁 Листопад включён. Сообщения будут исчезать.', 3000); } });
    document.getElementById('btn-voice-input')?.addEventListener('click', toggleVoiceRecording);
    document.getElementById('setting-lock')?.addEventListener('click', () => { if (lockType) { if (confirm('Сбросить блокировку?')) { try { localStorage.removeItem(LOCK_KEY); } catch (e) {} lockType = null; lockPinHash = ''; const ls3 = document.getElementById('lock-status'); if (ls3) ls3.textContent = 'Не задан'; } } else { isSettingLock = true; lockPinHash = ''; pinInput = ''; lockScreen.style.display = 'flex'; appContainer.style.display = 'none'; setupLockUI(); } });
    const emojis = ['😀','😂','🤣','😍','😘','😜','😎','🤩','🥳','😢','😡','👍','👎','❤️','🔥','🎉','💀','🏹','🌲','🏰','🦊','🐺','✨','⚔️','🛡️','🍺','🍗','🏕️','🌙','☀️','🌟','💪','🤝','🙏','👑','💰','🎯','📞','💬','🔔','❌','✅','🎵','📜','⚜️'];
    const eg = document.getElementById('emoji-grid'); if (eg) emojis.forEach(e => { const span = document.createElement('span'); span.textContent = e; span.addEventListener('click', () => { const mi = document.getElementById('msg-input'); if (mi) { mi.value += e; mi.focus(); } }); eg.appendChild(span); });
    const be = document.getElementById('btn-emoji'); if (be) be.addEventListener('click', () => { const ep = document.getElementById('emoji-panel'); if (ep) ep.style.display = ep.style.display === 'block' ? 'none' : 'block'; });
    document.addEventListener('click', e => { const ep = document.getElementById('emoji-panel'); if (ep && !ep.contains(e.target) && e.target !== be) ep.style.display = 'none'; });
    document.getElementById('send-btn')?.addEventListener('click', async () => { const mi = document.getElementById('msg-input'); const t = mi?.value.trim(); if (t) { if (!activeChannelId) { const chIds = Object.keys(P2PPong._channels); if (!chIds.length) return; activeChannelId = chIds[0]; } const sent = await P2PPong.sendMessage(activeChannelId, t); if (sent) { appendMessage('Вы', t, selectedAvatar); updateCupIndicator(); updateRatchetIndicator(); if (mi) mi.value = ''; playArcherAnimation(); playBowAnimation(); if (toggleSoundState) playSound('shot.mp3'); } } });
    document.getElementById('msg-input')?.addEventListener('keypress', e => { if (e.key == 'Enter') document.getElementById('send-btn')?.click(); });
    setConnectionStatus('online'); updateDateTime(); setInterval(updateDateTime, 1000);
}

window.addEventListener('beforeunload', () => { if (callActive) hang(false); if (voiceTimerInterval) clearInterval(voiceTimerInterval); P2PPong.destroy(); });
P2PPong.on('ready', () => { initUI(); initApp(); });
loadLockSettings();
