// api/beacon.js
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).end();

    const url = new URL(req.url, 'http://localhost');
    const key = url.searchParams.get('key');
    const path = url.pathname;

    if (path === '/api/health') return res.json({ status: 'ok' });

    if (req.method === 'DELETE' && key) {
        global._beacons = global._beacons || {};
        delete global._beacons[key];
        return res.json({ status: 'deleted' });
    }

    const { keyHash, packet } = req.body || {};

    if (req.method === 'POST' && keyHash && packet) {
        if (keyHash.length > 128 || packet.length > 500000) {
            return res.status(400).json({ error: 'too_large' });
        }
        global._beacons = global._beacons || {};
        global._beacons[keyHash] = { packet, createdAt: Date.now() };
        return res.json({ status: 'stored' });
    }

    if (req.method === 'GET' && key) {
        global._beacons = global._beacons || {};
        const entry = global._beacons[key];
        if (entry) {
            return res.json({ status: 'found', packet: entry.packet });
        }
        return res.json({ status: 'empty' });
    }

    return res.json({ status: 'ok' });
}
