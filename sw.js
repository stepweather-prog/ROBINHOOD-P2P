// ==================== WORKERS.JS — CLOUDFLARE WORKERS СЕРВЕР ====================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    try {
      let result;
      switch (path) {
        case '/ping':
          result = { ok: true, time: Date.now() };
          break;
        case '/beacon':
          if (request.method === 'POST') result = await handleBeacon(body, env);
          else result = await checkBeacon(url.searchParams.get('id'), env);
          break;
        case '/find':
          result = await handleFind(body, env);
          break;
        case '/message':
          if (request.method === 'POST') result = await postMessage(body, env);
          else result = await getMessages(url.searchParams.get('id'), parseInt(url.searchParams.get('since')) || 0, env);
          break;
        default:
          result = { error: 'Not found' };
      }
      return new Response(JSON.stringify(result), { headers: { ...headers, 'Content-Type': 'application/json' } });
    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } });
    }
  }
};

async function handleBeacon(body, env) {
  const sessionId = crypto.randomUUID();
  const keyToStore = body.tempKeyHash || body.tempKey || '';
  const beaconData = { key: keyToStore, status: 'waiting', created: Date.now(), matched: false };
  await env.ROBINHOOD_KV.put('beacon_' + sessionId, JSON.stringify(beaconData), { expirationTtl: 1200 });
  await env.ROBINHOOD_KV.put('find_' + keyToStore, sessionId, { expirationTtl: 1200 });
  await env.ROBINHOOD_KV.put('msgs_' + sessionId, JSON.stringify([]), { expirationTtl: 1800 });
  return { sessionId, status: 'waiting' };
}

async function checkBeacon(id, env) {
  if (!id) return { matched: false };
  const data = await env.ROBINHOOD_KV.get('beacon_' + id, 'json');
  if (!data) return { matched: false };
  return { matched: data.matched || data.status === 'found', sessionId: id };
}

async function handleFind(body, env) {
  const searchKey = body.tempKeyHash || body.tempKey || '';
  if (!searchKey) return { status: 'not_found' };
  const sessionId = await env.ROBINHOOD_KV.get('find_' + searchKey);
  if (!sessionId) return { status: 'not_found' };
  const data = await env.ROBINHOOD_KV.get('beacon_' + sessionId, 'json');
  if (!data) return { status: 'not_found' };
  data.status = 'found';
  data.matched = true;
  await env.ROBINHOOD_KV.put('beacon_' + sessionId, JSON.stringify(data), { expirationTtl: 1200 });
  return { status: 'matched', sessionId: sessionId };
}

async function postMessage(body, env) {
  if (!body.sessionId || !body.packet) throw new Error('sessionId and packet required');
  let msgs = await env.ROBINHOOD_KV.get('msgs_' + body.sessionId, 'json');
  if (!msgs) msgs = [];
  msgs.push({ packet: body.packet, time: Date.now() });
  await env.ROBINHOOD_KV.put('msgs_' + body.sessionId, JSON.stringify(msgs.slice(-50)), { expirationTtl: 1800 });
  return { ok: true };
}

async function getMessages(id, since, env) {
  if (!id) return { messages: [] };
  const msgs = await env.ROBINHOOD_KV.get('msgs_' + id, 'json') || [];
  return { messages: msgs.filter(m => m.time > since) };
}
