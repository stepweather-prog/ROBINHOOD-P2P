export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', 'https://stepweather-prog.github.io');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const { keyHash, packet } = req.body || {};
    const key = req.query.key;

    if (req.method === 'POST' && keyHash && packet) {
        // Vercel не имеет встроенного хранилища — используем временное
        global._beacons = global._beacons || {};
        global._beacons[keyHash] = { packet, createdAt: Date.now() };
        return res.json({ status: 'stored' });
    }

    if (req.method === 'GET' && key) {
        global._beacons = global._beacons || {};
        const entry = global._beacons[key];
        if (entry) {
            if (key.startsWith('webrtc_')) delete global._beacons[key];
            return res.json({ status: 'found', packet: entry.packet });
        }
        return res.json({ status: 'empty' });
    }

    if (req.method === 'DELETE' && key) {
        global._beacons = global._beacons || {};
        delete global._beacons[key];
        return res.json({ status: 'deleted' });
    }

    return res.json({ status: 'ok' });
}