// crypto-worker.js — v2.0 с DH Ratchet
function bufferToHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuffer(hex) {
    return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))).buffer;
}

async function generateKeyPair() {
    const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits']
    );
    const pubKey = await crypto.subtle.exportKey('raw', kp.publicKey);
    const privKey = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    return {
        publicKey: bufferToHex(pubKey),
        privateKey: bufferToHex(privKey)
    };
}

async function deriveSecret(privateKeyHex, publicKeyHex) {
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        hexToBuffer(privateKeyHex),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits']
    );
    const publicKey = await crypto.subtle.importKey(
        'raw',
        hexToBuffer(publicKeyHex),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        []
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: publicKey },
        privateKey,
        256
    );
    return bufferToHex(bits);
}

async function SHA(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return bufferToHex(hash);
}

async function HKDF(secret, salt, info) {
    const secretKey = await crypto.subtle.importKey(
        'raw',
        hexToBuffer(secret),
        { name: 'HKDF' },
        false,
        ['deriveBits']
    );
    const infoBuffer = new TextEncoder().encode(info);
    const saltBuffer = salt ? hexToBuffer(salt) : new Uint8Array(32);
    const bits = await crypto.subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: saltBuffer, info: infoBuffer },
        secretKey,
        256
    );
    return bufferToHex(bits);
}

async function encryptAES(plaintext, keyHex) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey(
        'raw',
        hexToBuffer(keyHex),
        { name: 'AES-GCM' },
        false,
        ['encrypt']
    );
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        data
    );
    const combined = new Uint8Array(iv.length + encrypted.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(encrypted), iv.length);
    return bufferToHex(combined.buffer);
}

async function decryptAES(encryptedHex, keyHex) {
    const combined = new Uint8Array(hexToBuffer(encryptedHex));
    const iv = combined.slice(0, 12);
    const data = combined.slice(12);
    const key = await crypto.subtle.importKey(
        'raw',
        hexToBuffer(keyHex),
        { name: 'AES-GCM' },
        false,
        ['decrypt']
    );
    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            data
        );
        return new TextDecoder().decode(decrypted);
    } catch(e) {
        return null;
    }
}

async function computeHMAC(data, keyHex) {
    const key = await crypto.subtle.importKey(
        'raw',
        hexToBuffer(keyHex),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(data)
    );
    return bufferToHex(signature);
}

async function verifyHMAC(data, sigHex, keyHex) {
    const key = await crypto.subtle.importKey(
        'raw',
        hexToBuffer(keyHex),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );
    return await crypto.subtle.verify(
        'HMAC',
        key,
        hexToBuffer(sigHex),
        new TextEncoder().encode(data)
    );
}

async function packBlob(jsonString, ch) {
    const messageKey = await HKDF(ch.sendKey, null, 'message-key-' + ch.sendIndex);
    const encrypted = await encryptAES(jsonString, messageKey);
    const hmac = await computeHMAC(encrypted, ch.sendKey);
    
    const newSendKey = await HKDF(ch.sendKey, null, 'chain-key-' + ch.sendIndex);
    const newSendIndex = ch.sendIndex + 1;
    
    const blob = JSON.stringify({
        d: encrypted,
        h: hmac,
        _ri: ch.sendIndex,
        _t: Date.now()
    });
    
    return {
        packed: blob,
        newSendKey: newSendKey,
        newSendIndex: newSendIndex,
        messageKey: messageKey
    };
}

async function unpackBlob(blob, ch) {
    try {
        const parsed = JSON.parse(blob);
        if (!parsed.d || !parsed.h) return null;
        
        const hmacValid = await verifyHMAC(parsed.d, parsed.h, ch.recvKey);
        if (!hmacValid) return null;
        
        const ri = parseInt(parsed._ri) || 0;
        const messageKey = await HKDF(ch.recvKey, null, 'message-key-' + ri);
        const decrypted = await decryptAES(parsed.d, messageKey);
        
        if (!decrypted) return null;
        
        const newRecvKey = await HKDF(ch.recvKey, null, 'chain-key-' + ri);
        const newRecvIndex = ri + 1;
        
        const result = JSON.parse(decrypted);
        result._ri = parsed._ri;
        result._t = parsed._t;
        
        return {
            data: result,
            newRecvKey: newRecvKey,
            newRecvIndex: newRecvIndex
        };
    } catch(e) {
        return null;
    }
}

async function advanceRecvRatchet(ch, targetRi) {
    let currentKey = ch.recvKey;
    let currentIndex = ch.recvIndex || 0;
    const oldKeys = [];
    
    while (currentIndex < targetRi) {
        oldKeys.push({ key: currentKey, index: currentIndex });
        currentKey = await HKDF(currentKey, null, 'chain-key-' + currentIndex);
        currentIndex++;
        
        if (oldKeys.length > 10) oldKeys.shift();
    }
    
    if (currentIndex === targetRi) {
        oldKeys.push({ key: currentKey, index: currentIndex });
        currentKey = await HKDF(currentKey, null, 'chain-key-' + currentIndex);
        currentIndex++;
    }
    
    return {
        finalKey: currentKey,
        index: currentIndex,
        oldKeys: oldKeys.slice(-10)
    };
}

// ===== DH Ratchet =====

async function dhRatchetStep(rootKey, myPrivKey, theirPubKey) {
    // Генерируем новую DH пару
    const newKp = await generateKeyPair();
    
    // Вычисляем новый общий секрет
    const dhSecret = await deriveSecret(myPrivKey, theirPubKey);
    
    // Новый корневой ключ = HKDF(старый корень, новый DH секрет)
    const newRootKey = await HKDF(rootKey, dhSecret, 'osprp-dh-ratchet');
    
    // Новые цепочки из корневого ключа
    const newSendKey = await HKDF(newRootKey, null, 'send-chain');
    const newRecvKey = await HKDF(newRootKey, null, 'recv-chain');
    
    return {
        newRootKey: newRootKey,
        newSendKey: newSendKey,
        newRecvKey: newRecvKey,
        newPubKey: newKp.publicKey,
        newPrivKey: newKp.privateKey,
        sendIndex: 0,
        recvIndex: 0
    };
}

async function dhRatchetReceive(rootKey, myPrivKey, theirNewPubKey) {
    // Вычисляем новый общий секрет с новым ключом собеседника
    const dhSecret = await deriveSecret(myPrivKey, theirNewPubKey);
    
    // Новый корневой ключ
    const newRootKey = await HKDF(rootKey, dhSecret, 'osprp-dh-ratchet');
    
    // Новые цепочки
    const newSendKey = await HKDF(newRootKey, null, 'send-chain');
    const newRecvKey = await HKDF(newRootKey, null, 'recv-chain');
    
    return {
        newRootKey: newRootKey,
        newSendKey: newSendKey,
        newRecvKey: newRecvKey,
        sendIndex: 0,
        recvIndex: 0
    };
}

// ===== Обработчик сообщений =====

self.onmessage = async function(e) {
    const { id, action, payload } = e.data;
    
    try {
        let result;
        
        switch (action) {
            case 'SHA':
                result = await SHA(payload);
                break;
                
            case 'generateKeyPair':
                result = await generateKeyPair();
                break;
                
            case 'deriveSecret':
                result = await deriveSecret(payload.myPrivateKey, payload.theirPublicKey);
                break;
                
            case 'encryptAES':
                result = await encryptAES(payload.text, payload.secret);
                break;
                
            case 'decryptAES':
                result = await decryptAES(payload.enc, payload.secret);
                break;
                
            case 'computeHMAC':
                result = await computeHMAC(payload.data, payload.secret);
                break;
                
            case 'verifyHMAC':
                result = await verifyHMAC(payload.data, payload.sig, payload.secret);
                break;
                
            case 'packBlob':
                const packResult = await packBlob(payload.jsonString, payload.ch);
                result = {
                    packed: packResult.packed,
                    newSendKey: packResult.newSendKey,
                    newSendIndex: packResult.newSendIndex
                };
                break;
                
            case 'unpackBlob':
                result = await unpackBlob(payload.blob, payload.ch);
                break;
                
            case 'advanceRecvRatchet':
                result = await advanceRecvRatchet(payload.ch, payload.targetRi);
                break;
                
            case 'dhRatchetStep':
                result = await dhRatchetStep(payload.rootKey, payload.myPrivKey, payload.theirPubKey);
                break;
                
            case 'dhRatchetReceive':
                result = await dhRatchetReceive(payload.rootKey, payload.myPrivKey, payload.theirNewPubKey);
                break;
                
            default:
                throw new Error('Unknown action: ' + action);
        }
        
        self.postMessage({ id, result });
    } catch(e) {
        self.postMessage({ id, error: e.message });
    }
};
