// crypto-worker.js — Web Worker для криптографии (чистый base64, без бинарного паддинга)
const MAX_TIMEOUT = 30000;
let isProcessing = false;

function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i] & 0xFF);
    }
    return btoa(binary);
}

function fromBase64(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i) & 0xFF;
    }
    return bytes;
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
            case 'deriveSecret': result = await deriveSecret(payload.kp, payload.remotePubKey); break;
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

async function exportPublicKey(kp) {
    const r = await crypto.subtle.exportKey('raw', kp);
    return toBase64(new Uint8Array(r));
}

async function importPublicKey(b64) {
    const r = fromBase64(b64);
    return await crypto.subtle.importKey('raw', r, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

async function deriveSecret(kp, remotePubKey) {
    const b = await crypto.subtle.deriveBits({ name: 'ECDH', public: remotePubKey }, kp, 256);
    return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('');
}

async function encryptAES(text, secret) {
    const keyData = new TextEncoder().encode(secret.substring(0, 32));
    const k = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text));
    const combined = new Uint8Array(iv.length + new Uint8Array(ct).length);
    combined.set(iv);
    combined.set(new Uint8Array(ct), iv.length);
    return toBase64(combined);
}

async function decryptAES(enc, secret) {
    const keyData = new TextEncoder().encode(secret.substring(0, 32));
    const k = await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM' }, false, ['decrypt']);
    const c = fromBase64(enc);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: c.slice(0, 12) }, k, c.slice(12)));
}

async function computeHMAC(data, secret) {
    const keyData = new TextEncoder().encode(secret.substring(0, 32));
    const k = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
    return toBase64(new Uint8Array(sig));
}

async function verifyHMAC(data, sig, secret) {
    const keyData = new TextEncoder().encode(secret.substring(0, 32));
    const k = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sigBytes = fromBase64(sig);
    return await crypto.subtle.verify('HMAC', k, sigBytes, new TextEncoder().encode(data));
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

async function decompressData(b64) {
    const bytes = fromBase64(b64);
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) { const r = await reader.read(); if (r.done) break; chunks.push(r.value); }
    const total = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
    let offset = 0;
    chunks.forEach(chunk => { total.set(chunk, offset); offset += chunk.length; });
    return new TextDecoder().decode(total);
}

async function advanceRatchet(ch) {
    const oldKey = ch.ratchetKey || ch.secret;
    const salt = (ch.ratchetIndex || 0).toString(16).padStart(16, '0');
    const newKey = await SHA(oldKey + salt);
    return { newKey, index: (ch.ratchetIndex || 0) + 1, oldKey };
}

async function packBlob(jsonString, ch) {
    const compressed = await compressData(jsonString);
    const nonce = Array.from(crypto.getRandomValues(new Uint32Array(4))).map(x => x.toString(16).padStart(8, '0')).join('');
    const ri = ch.ratchetIndex || 0;
    const data = JSON.stringify({ z: compressed, t: Date.now(), n: nonce, ri });
    const currentKey = ch.ratchetKey || ch.secret;
    const hmac = await computeHMAC(data, currentKey);
    const padded = hmac + '|' + data;
    const { newKey, index } = await advanceRatchet(ch);
    const encrypted = await encryptAES(padded, ch.secret);
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

async function tryDecryptWithKey(decrypted, key) {
    const separatorIndex = decrypted.indexOf('|');
    if (separatorIndex === -1) return null;
    const hmac = decrypted.substring(0, separatorIndex);
    const data = decrypted.substring(separatorIndex + 1);
    if (!await verifyHMAC(data, hmac, key)) return null;
    const parsed = JSON.parse(data);
    if (parsed.z) {
        const inner = JSON.parse(await decompressData(parsed.z));
        inner._t = parsed.t;
        inner._ri = parsed.ri;
        return inner;
    }
    return parsed;
}
