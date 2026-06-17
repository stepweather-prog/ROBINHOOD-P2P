// joinBeacon — пир Б маякует пиру А что получил его маяк
async joinBeacon(targetPeerId) {
    if (!targetPeerId) return false;
    
    // Сначала забираем маяк пира А из его ячейки
    const keyHash = 'waiting_' + targetPeerId;
    let beaconData = null;
    
    try {
        const res = await fetch(`https://robincall.stephanclaps-491.workers.dev/beacon?key=${keyHash}`);
        const data = await res.json();
        if (data.status === 'found' && data.packet) {
            beaconData = JSON.parse(data.packet);
        }
    } catch(e) {}
    
    if (!beaconData || !beaconData.pubKey || !beaconData.inner) return false;
    
    // Генерируем свой ключ и отправляем ответ пиру А
    if (!this._peerId) this._peerId = await generateHardwarePeerId();
    
    const remotePubKey = await importPublicKey(beaconData.pubKey);
    const kp = await generateKeyPair();
    const myPubKey = await exportPublicKey(kp);
    const ss = await deriveSecret(kp, remotePubKey);
    const chId = RND();
    
    // Создаём канал
    this._channels[chId] = {
        secret: ss, ratchetKey: ss, ratchetIndex: 0, oldKeys: [], lastReceivedRi: -1,
        peerId: beaconData.peerId, type: 'cup', blobs: [],
        expires: Date.now() + 600000, createdAt: Date.now()
    };
    
    // Отправляем beacon-response в ячейку пира А
    const response = JSON.stringify({
        type: 'beacon-response',
        pubKey: myPubKey,
        peerId: this._peerId,
        inner: beaconData.inner,
        nick: '',
        avatar: ''
    });
    
    const responseKeyHash = 'waiting_' + targetPeerId;
    
    try {
        await fetch(`https://robincall.stephanclaps-491.workers.dev/beacon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keyHash: responseKeyHash, packet: response })
        });
    } catch(e) {}
    
    this._stats.channelsOpened++;
    await this._saveChannels();
    this._emit('channel-opened', {
        channelId: chId,
        peerId: beaconData.peerId,
        nick: 'Лучник',
        avatar: '001'
    });
    
    return true;
},
