// crypto-worker.js — Web Worker для криптографии (чистый base64, без бинарного паддинга)
const MAX_TIMEOUT = 30000;
const MAX_DECOMPRESSED_SIZE = 1024 * 1024; // 1 МБ максимум после распаковки (защита от zip-бомбы)
let isProcessing = false;

function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i] & 0xFF);
    }
    return btoa(binary);
}

function fromBase64(b64) {
    const clean = (b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
    if (!clean) return new Uint8Array(0);
    try {
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i) & 0xFF;
        }
        return bytes;
    } catch(e) {
        return new Uint8Array(0);
    }
}

self.onmessage = async function(e) {
    if (isProcessing) {
        self.postMessage({ id: e.data.id, error: 'Worker busy' });
        return;
    }
    isProcessing = true;
    const { id, action, payload } = e.data;
    const timeout = setTimeout(() => {
        isProcessing = false;
        self.postMessage({ id, error: 'Timeout' });
    }, MAX_TIMEOUT);

    try {
        let result;
        switch (action) {
            case 'SHA': result = await SHA(payload); break;
            case 'generateKeyPair': result = await generateKeyPair(); break;
            case 'exportPublicKey': result = await exportPublicKey(payload); break;
            case 'importPublicKey': result = await importPublicKey(payload); break;
            // ✅ CVE-2: deriveSecret в воркере
            case 'deriveSecret': result = await deriveSecret(payload.myPrivateKey, payload.theirPublicKey); break;
            case 'encryptAES': result = await encryptAES(payload.text, payload.secret); break;
            case 'decryptAES': result = await decryptAES(payload.enc, payload.secret); break;
            case 'computeHMAC': result = await computeHMAC(payload.data, payload.secret); break;
            case 'verifyHMAC': result = await verifyHMAC(payload.data, payload.sig, payload.secret); break;
            case 'packBlob': result = await packBlob(payload.jsonString, payload.ch); break;
            case 'unpackBlob': result = await unpackBlob(payload.blob, payload.ch); break;
            default: throw new Error('Unknown: ' + action);
        }
        clearTimeout(timeout);
        self.postMessage({ id, result });
    } catch(error) {
        clearTimeout(timeout);
        self.postMessage({ id, error: error.message });
    } finally {
        isProcessing = false;
    }
};

async function SHA(t) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeyPair() {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pubKey = await crypto.subtle.exportKey('raw', kp.publicKey);
    const privKey = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    return {
        publicKey: toBase64(new Uint8Array(pubKey)),
        privateKey: toBase64(new Uint8Array(privKey))
    };
}

// ✅ CVE-2: deriveSecret в crypto-worker, использует fromBase64
async function deriveSecret(myPrivateKeyB64, theirPublicKeyB64) {
    const myPrivKey = await crypto.subtle.importKey('pkcs8',
        fromBase64(myPrivateKeyB64),
        { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const theirPubKey = await crypto.subtle.importKey('raw',
        fromBase64(theirPublicKeyB64),
        { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPubKey }, myPrivKey, 256);
    return Array.from(new Uint8Array(bits)).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function exportPublicKey(kp) {
    const r = await crypto.subtle.exportKey('raw', kp);
    return toBase64(new Uint8Array(r));
}

async function importPublicKey(b64) {
    const r = fromBase64(b64);
    return await crypto.subtle.importKey('raw', r, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

// ✅ Исправлено: секрет хешируется для получения ключа нужной длины
async function deriveKey(secret) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return await crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function deriveHMACKey(secret) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return await crypto.subtle.importKey('raw', hash, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function encryptAES(text, secret) {
    const k = await deriveKey(secret);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text));
    const combined = new Uint8Array(iv.length + new Uint8Array(ct).length);
    combined.set(iv);
    combined.set(new Uint8Array(ct), iv.length);
    return toBase64(combined);
}

async function decryptAES(enc, secret) {
    const k = await deriveKey(secret);
    const c = fromBase64(enc);
    if (!c || c.length === 0) return null;
    try {
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, k, c.slice(12)));
    } catch(e) {
        return null;
    }
}

async function computeHMAC(data, secret) {
    const k = await deriveHMACKey(secret);
    const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
    return toBase64(new Uint8Array(sig));
}

async function verifyHMAC(data, sig, secret) {
    try {
        const k = await deriveHMACKey(secret);
        const sigBytes = fromBase64(sig);
        return await crypto.subtle.verify('HMAC', k, sigBytes, new TextEncoder().encode(data));
    } catch(e) {
        return false;
    }
}

async function compressData(str) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
    const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let offset = 0;
    chunks.forEach(chunk => { total.set(chunk, offset); offset += chunk.length; });
    return toBase64(total);
}

// ✅ Исправлено: защита от zip-бомбы — проверка размера после распаковки
async function decompressData(b64) {
    const bytes = fromBase64(b64);
    if (!bytes || bytes.length === 0) return null;
    try {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        let totalSize = 0;
        while (true) { 
            const r = await reader.read(); 
            if (r.done) break; 
            totalSize += r.value.length;
            // Защита от zip-бомбы
            if (totalSize > MAX_DECOMPRESSED_SIZE) {
                reader.cancel();
                return null;
            }
            chunks.push(r.value); 
        }
        const total = new Uint8Array(totalSize);
        let offset = 0;
        chunks.forEach(chunk => { total.set(chunk, offset); offset += chunk.length; });
        return new TextDecoder().decode(total);
    } catch(e) {
        return null;
    }
}

async function advanceRatchet(ch) {
    const oldKey = ch.ratchetKey || ch.secret;
    const salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0');
    const newKey = await SHA(oldKey + salt);
    return { newKey, index: (ch.ratchetIndex || 0) + 1, oldKey };
}

// ✅ Исправлено: разделитель | заменён на неиспользуемый в base64 символ
const SEPARATOR = '\x00'; // Нулевой байт — не встречается в base64

async function packBlob(jsonString, ch) {
    const compressed = await compressData(jsonString);
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4))).map(x => x.toString(16).padStart(8, '0')).join('');
    const ri = ch.ratchetIndex || 0;
    const data = JSON.stringify({ z: compressed, t: Date.now(), n: nonce, ri });
    const currentKey = ch.ratchetKey || ch.secret;
    const hmac = await computeHMAC(data, currentKey);
    const payload = hmac + SEPARATOR + data;
    const { newKey, index } = await advanceRatchet(ch);
    const encrypted = await encryptAES(payload, ch.secret);
    return { packed: encrypted, newRatchetKey: newKey, newRatchetIndex: index };
}

async function unpackBlob(blob, ch) {
    const dec = await decryptAES(blob, ch.secret);
    if (!dec) return null;
    let result = await tryDecryptWithKey(dec, ch.ratchetKey || ch.secret);
    if (result) return result;
    if (ch.oldKeys) {
        for (let i = ch.oldKeys.length - 1; i >= 0; i--) {
            result = await tryDecryptWithKey(dec, ch.oldKeys[i].key);
            if (result) return result;
        }
    }
    return null;
}

// ✅ Исправлено: поиск разделителя \x00 вместо |
async function tryDecryptWithKey(decrypted, key) {
    const separatorIndex = decrypted.indexOf(SEPARATOR);
    if (separatorIndex === -1) return null;
    const hmac = decrypted.substring(0, separatorIndex);
    const data = decrypted.substring(separatorIndex + 1);
    if (!await verifyHMAC(data, hmac, key)) return null;
    try {
        const parsed = JSON.parse(data);
        if (parsed.z) {
            const inner = JSON.parse(await decompressData(parsed.z));
            if (inner) {
                inner._t = parsed.t;
                inner._ri = parsed.ri;
                return inner;
            }
        }
        return parsed;
    } catch(e) {
        return null;
    }
}
