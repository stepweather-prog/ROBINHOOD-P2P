// httpr-core.js — v1.0.0
// HTTPR Protocol Core — транспортно-агностическое P2P-ядро
// Лицензия: MIT

const HTTPR_DEBUG = true;
function httprLog(msg, data) { if (HTTPR_DEBUG) console.log(`[HTTPR] ${msg}`, data || ''); }

// ============================================================
// 1. КОНСТАНТЫ И ТИПЫ ПАКЕТОВ
// ============================================================

const HTTPR_VERSION = 1;

const HTTPR_PACKET_TYPES = {
  // Фаза знакомства
  'beacon':           { ttl: 0, desc: 'Маяк создателя' },
  'beacon-resp':      { ttl: 0, desc: 'Ответ на маяк' },
  'beacon-ack':       { ttl: 0, desc: 'Подтверждение канала' },
  'verify-code':      { ttl: 0, desc: 'Код верификации' },

  // Общение
  'message':          { ttl: 5, desc: 'Текстовое сообщение' },
  'voice':            { ttl: 5, desc: 'Голосовое сообщение' },

  // Сигналинг WebRTC
  'webrtc-offer':     { ttl: 3, desc: 'SDP offer' },
  'webrtc-answer':    { ttl: 3, desc: 'SDP answer' },
  'webrtc-ice':       { ttl: 3, desc: 'ICE candidate' },

  // Системные
  'system':           { ttl: 5, desc: 'Системное сообщение' },
  'ping':             { ttl: 5, desc: 'Проверка живости канала' },
  'ratchet-resync':   { ttl: 0, desc: 'Ресинхронизация ratchet' },

  // Управление каналами
  'channel-close':    { ttl: 0, desc: 'Закрытие канала' },
  'beacon-close':     { ttl: 0, desc: 'Уничтожение маяка' },

  // Фрагментация
  'fragment':         { ttl: 5, desc: 'Фрагмент большого пакета' }
};

const HTTPR_DEFAULTS = {
  TTL: 5,
  MAX_PACKET_SIZE: 65536,
  FRAGMENT_CHUNK_SIZE: 50000,
  FRAGMENT_TIMEOUT: 30000,
  HEALTH_CHECK_INTERVAL: 30000,
  DEDUP_CACHE_SIZE: 1000,
  DEDUP_CACHE_TTL: 300000
};

// ============================================================
// 2. УТИЛИТЫ
// ============================================================

function httprGenId() {
  const arr = new Uint32Array(2);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(x => x.toString(16).padStart(8, '0')).join('');
}

function httprEncodeBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function httprDecodeBase64(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

async function httprAesGcmEncrypt(plaintext, key) {
  const enc = new TextEncoder();
  const keyBytes = typeof key === 'string' ? enc.encode(key).slice(0, 32) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, cryptoKey, data
  );
  const combined = new Uint8Array(iv.length + new Uint8Array(ciphertext).length);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return httprEncodeBase64(String.fromCharCode(...combined));
}

async function httprAesGcmDecrypt(cipherB64, key) {
  try {
    const enc = new TextEncoder();
    const keyBytes = typeof key === 'string' ? enc.encode(key).slice(0, 32) : key;
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']
    );
    const combined = new Uint8Array(
      httprDecodeBase64(cipherB64).split('').map(c => c.charCodeAt(0))
    );
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv }, cryptoKey, ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch(e) {
    return null;
  }
}

async function httprShaFingerprint(data) {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(data));
  const arr = Array.from(new Uint8Array(hash));
  return arr.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

// ============================================================
// 3. ИНТЕРФЕЙС ТРАНСПОРТА (IHTTPRTransport)
// ============================================================

/**
 * Абстрактный интерфейс транспортного адаптера.
 * Каждый транспорт должен реализовать все методы.
 */
class IHTTPRTransport {
  get name() { throw new Error('Not implemented: name'); }
  get type() { throw new Error('Not implemented: type'); }       // 'relay' | 'mesh' | 'direct' | 'broadcast'
  get priority() { throw new Error('Not implemented: priority'); } // меньше = лучше
  get maxPacketSize() { throw new Error('Not implemented: maxPacketSize'); }

  async init(config) { throw new Error('Not implemented: init'); }
  async send(envelope, routingKey) { throw new Error('Not implemented: send'); }
  async subscribe(routingKey, callback) { throw new Error('Not implemented: subscribe'); }
  async unsubscribe(routingKey) { throw new Error('Not implemented: unsubscribe'); }
  async healthCheck() { throw new Error('Not implemented: healthCheck'); }
  async destroy() { throw new Error('Not implemented: destroy'); }

  onPacket(handler) { this._packetHandler = handler; }

  _emitPacket(envelope, routingKey) {
    if (this._packetHandler) {
      try { this._packetHandler(envelope, routingKey); } catch(e) {}
    }
  }
}

// ============================================================
// 4. БАЗОВЫЙ КЛАСС ТРАНСПОРТА
// ============================================================

class BaseHTTPRTransport extends IHTTPRTransport {
  constructor() {
    super();
    this._packetHandler = null;
    this._healthy = false;
    this._lastCheck = 0;
    this._name = 'base';
    this._type = 'relay';
    this._priority = 10;
    this._maxPacketSize = HTTPR_DEFAULTS.MAX_PACKET_SIZE;
  }

  get name() { return this._name; }
  get type() { return this._type; }
  get priority() { return this._priority; }
  get maxPacketSize() { return this._maxPacketSize; }
  get healthy() { return this._healthy; }

  async healthCheck() {
    try {
      const start = Date.now();
      const ok = await this._check();
      this._healthy = ok;
      this._lastCheck = Date.now();
      return { healthy: ok, latency: Date.now() - start };
    } catch(e) {
      this._healthy = false;
      return { healthy: false, latency: -1 };
    }
  }

  async _check() { return true; }
  async init(config) { throw new Error('Not implemented'); }
  async send(envelope, routingKey) { throw new Error('Not implemented'); }
  async subscribe(routingKey, callback) { throw new Error('Not implemented'); }
  async unsubscribe(routingKey) { throw new Error('Not implemented'); }

  async destroy() {
    this._packetHandler = null;
    this._healthy = false;
  }
}

// ============================================================
// 5. ВСТРОЕННЫЙ HTTP-RELAY ТРАНСПОРТ
// ============================================================

class HTTPRelayTransport extends BaseHTTPRTransport {
  constructor() {
    super();
    this._name = 'http-relay';
    this._type = 'relay';
    this._priority = 1;
    this._maxPacketSize = 100000;
    this._servers = [];
    this._activeServer = null;
    this._serverHealth = {};
    this._pollTimers = {};
    this._subscribedKeys = new Set();
  }

  async init(config) {
    this._servers = config.servers || [];
    if (this._servers.length === 0) {
      throw new Error('HTTPRelayTransport: нужен хотя бы один сервер');
    }
    await this._selectServer();
    this._healthy = true;
  }

  async _selectServer() {
    const now = Date.now();
    for (const server of this._servers) {
      try {
        const r = await fetch(server + '/health', {
          signal: AbortSignal.timeout(5000)
        });
        if (r.ok) {
          this._activeServer = server;
          this._serverHealth[server] = { healthy: true, lastCheck: now };
          return server;
        }
      } catch(e) {
        this._serverHealth[server] = { healthy: false, failed: true, lastCheck: now };
      }
    }
    this._activeServer = this._servers[0];
    return this._activeServer;
  }

  async send(envelope, routingKey) {
    if (!this._activeServer) await this._selectServer();

    try {
      const r = await fetch(this._activeServer + '/beacon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyHash: routingKey, packet: envelope }),
        signal: AbortSignal.timeout(5000)
      });
      if (r.ok) return { success: true };
      if (r.status === 429) {
        await new Promise(res => setTimeout(res, 10000));
        return this.send(envelope, routingKey);
      }
      return { success: false, error: 'HTTP ' + r.status };
    } catch(e) {
      this._serverHealth[this._activeServer] = {
        healthy: false, failed: true, lastCheck: Date.now()
      };
      await this._selectServer();
      return { success: false, error: e.message };
    }
  }

  async subscribe(routingKey, callback) {
    if (this._subscribedKeys.has(routingKey)) return;
    this._subscribedKeys.add(routingKey);
    this._pollKey(routingKey, callback);
  }

  _pollKey(routingKey, callback) {
    const me = this;
    const poll = async () => {
      if (!me._subscribedKeys.has(routingKey)) return;

      try {
        const r = await fetch(me._activeServer + '/beacon?key=' + routingKey, {
          signal: AbortSignal.timeout(5000)
        });
        if (r.ok) {
          const d = await r.json();
          if (d && d.status === 'found' && d.packet) {
            me._emitPacket(d.packet, routingKey);
            if (callback) callback(d.packet);
          }
        }
      } catch(e) {}

      me._pollTimers[routingKey] = setTimeout(poll, 3000);
    };
    poll();
  }

  async unsubscribe(routingKey) {
    this._subscribedKeys.delete(routingKey);
    if (this._pollTimers[routingKey]) {
      clearTimeout(this._pollTimers[routingKey]);
      delete this._pollTimers[routingKey];
    }
  }

  async _check() {
    if (!this._activeServer) return false;
    try {
      const r = await fetch(this._activeServer + '/health', {
        signal: AbortSignal.timeout(5000)
      });
      return r.ok;
    } catch(e) {
      return false;
    }
  }

  async destroy() {
    for (const key of Object.keys(this._pollTimers)) {
      clearTimeout(this._pollTimers[key]);
    }
    this._pollTimers = {};
    this._subscribedKeys.clear();
    await super.destroy();
  }
}

// ============================================================
// 6. ЯДРО HTTPR
// ============================================================

class HTTPRCore {
  constructor() {
    // Транспорты
    this._transports = new Map();          // name → IHTTPRTransport
    this._activeTransport = null;
    this._transportKeys = new Map();       // kid → transportKey (для конвертного шифрования)

    // Маршрутизация
    this._routingTable = new Map();        // routingKey → { transports: Set, callbacks: Set }

    // Фрагментация
    this._fragmentBuffers = new Map();     // groupId → { chunks[], received, total, timer }

    // Дедупликация
    this._seenTids = new Map();            // tid → timestamp

    // Статистика
    this._stats = {
      packetsSent: 0,
      packetsReceived: 0,
      packetsDropped: 0,
      fragmentsReassembled: 0
    };

    // Колбэки
    this._onPacketReceived = null;
    this._onTransportSwitch = null;
    this._onError = null;

    // Health-check
    this._healthCheckTimer = null;
  }

  // ==========================================
  // ПУБЛИЧНЫЙ API
  // ==========================================

  /**
   * Зарегистрировать транспортный адаптер
   * @param {IHTTPRTransport} transport
   * @param {Object} config
   */
  async registerTransport(transport, config = {}) {
    if (this._transports.has(transport.name)) {
      throw new Error(`Транспорт "${transport.name}" уже зарегистрирован`);
    }

    await transport.init(config);

    transport.onPacket((envelope, routingKey) => {
      this._handleIncomingEnvelope(envelope, routingKey, transport.name);
    });

    this._transports.set(transport.name, transport);

    // Выбираем лучший транспорт
    if (!this._activeTransport || transport.priority < this._activeTransport.priority) {
      this._setActiveTransport(transport.name);
    }

    // Подписываем транспорт на все активные routingKey
    for (const [routingKey, entry] of this._routingTable) {
      if (!entry.transports.has(transport.name)) {
        try {
          await transport.subscribe(routingKey, null);
          entry.transports.add(transport.name);
        } catch(e) {
          this._emitError('subscribe-failed', {
            transport: transport.name,
            routingKey,
            error: e.message
          });
        }
      }
    }

    if (!this._healthCheckTimer) {
      this._startHealthCheck();
    }

    httprLog('transport-registered', { name: transport.name, priority: transport.priority });
  }

  /**
   * Удалить транспорт
   * @param {string} name
   */
  async unregisterTransport(name) {
    const transport = this._transports.get(name);
    if (!transport) return;

    for (const [routingKey, entry] of this._routingTable) {
      if (entry.transports.has(name)) {
        try {
          await transport.unsubscribe(routingKey);
        } catch(e) {}
        entry.transports.delete(name);
      }
    }

    await transport.destroy();
    this._transports.delete(name);

    if (this._activeTransport?.name === name) {
      const sorted = this._getHealthyTransports();
      this._setActiveTransport(sorted.length > 0 ? sorted[0].name : null);
    }

    httprLog('transport-unregistered', { name });
  }

  /**
   * Отправить пакет
   * @param {Object} payload - объект payload (type, from, to, ch, ri, dh, data)
   * @param {string} routingKey - ключ маршрутизации
   * @param {Object} options
   * @returns {Promise<{success: boolean, transport?: string, fragmented?: boolean}>}
   */
  async send(payload, routingKey, options = {}) {
    const envelope = await this._buildEnvelope(payload, options);
    const packetSize = envelope.length;

    // Находим транспорты, способные передать пакет
    const capable = this._getHealthyTransports()
      .filter(t => t.maxPacketSize >= packetSize)
      .sort((a, b) => a.priority - b.priority);

    if (capable.length > 0) {
      for (const transport of capable) {
        const result = await transport.send(envelope, routingKey);
        if (result.success) {
          this._stats.packetsSent++;
          return { success: true, transport: transport.name };
        }
      }
    }

    // Если ни один транспорт не может — фрагментируем
    if (options.fragment !== false) {
      return this._sendFragmented(payload, routingKey, options);
    }

    this._stats.packetsDropped++;
    return { success: false };
  }

  /**
   * Подписаться на входящие пакеты по routingKey
   * @param {string} routingKey
   * @param {Function} callback - (payload, meta) => void
   */
  async subscribe(routingKey, callback) {
    if (!this._routingTable.has(routingKey)) {
      this._routingTable.set(routingKey, {
        transports: new Set(),
        callbacks: new Set()
      });
    }

    const entry = this._routingTable.get(routingKey);
    entry.callbacks.add(callback);

    for (const transport of this._getHealthyTransports()) {
      if (!entry.transports.has(transport.name)) {
        try {
          await transport.subscribe(routingKey, null);
          entry.transports.add(transport.name);
        } catch(e) {
          this._emitError('subscribe-failed', {
            transport: transport.name,
            routingKey,
            error: e.message
          });
        }
      }
    }
  }

  /**
   * Отписаться от routingKey
   * @param {string} routingKey
   * @param {Function} [callback] - если не указан, удаляются все колбэки
   */
  async unsubscribe(routingKey, callback) {
    const entry = this._routingTable.get(routingKey);
    if (!entry) return;

    if (callback) {
      entry.callbacks.delete(callback);
    }

    if (entry.callbacks.size === 0 || !callback) {
      for (const transportName of entry.transports) {
        const transport = this._transports.get(transportName);
        if (transport) {
          try {
            await transport.unsubscribe(routingKey);
          } catch(e) {}
        }
      }
      this._routingTable.delete(routingKey);
    }
  }

  /**
   * Установить транспортный ключ для конвертного шифрования
   * @param {string} key - ключ
   * @returns {string} kid - идентификатор ключа
   */
  async setTransportKey(key) {
    const kid = await httprShaFingerprint(key);
    this._transportKeys.set(kid, key);
    return kid;
  }

  /**
   * Удалить транспортный ключ
   */
  removeTransportKey(kid) {
    this._transportKeys.delete(kid);
  }

  // ==========================================
  // ОБРАБОТЧИКИ СОБЫТИЙ
  // ==========================================

  /**
   * Глобальный обработчик входящих пакетов
   * @param {Function} handler - (payload, meta) => void
   *   meta: { routingKey, transport, tid, hop, ttl, timestamp, kid, reconstructed? }
   */
  onPacket(handler) {
    this._onPacketReceived = handler;
  }

  /**
   * Обработчик смены активного транспорта
   * @param {Function} handler - ({ from, to, transport }) => void
   */
  onTransportSwitch(handler) {
    this._onTransportSwitch = handler;
  }

  /**
   * Обработчик ошибок
   * @param {Function} handler - ({ code, message, details }) => void
   */
  onError(handler) {
    this._onError = handler;
  }

  // ==========================================
  // СТАТИСТИКА И ДИАГНОСТИКА
  // ==========================================

  getStats() {
    return {
      ...this._stats,
      transports: this._transports.size,
      activeTransport: this._activeTransport?.name || null,
      routingKeys: this._routingTable.size,
      transportKeys: this._transportKeys.size,
      fragmentBuffers: this._fragmentBuffers.size,
      transportsDetail: Array.from(this._transports.values()).map(t => ({
        name: t.name,
        type: t.type,
        priority: t.priority,
        healthy: t.healthy,
        maxPacketSize: t.maxPacketSize
      }))
    };
  }

  getActiveTransport() {
    return this._activeTransport?.name || null;
  }

  getTransports() {
    return Array.from(this._transports.values()).map(t => ({
      name: t.name,
      type: t.type,
      priority: t.priority,
      healthy: t.healthy
    }));
  }

  // ==========================================
  // УНИЧТОЖЕНИЕ
  // ==========================================

  async destroy() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }

    for (const transport of this._transports.values()) {
      try {
        await transport.destroy();
      } catch(e) {}
    }

    for (const [, buffer] of this._fragmentBuffers) {
      if (buffer.timer) clearTimeout(buffer.timer);
    }

    this._transports.clear();
    this._routingTable.clear();
    this._transportKeys.clear();
    this._fragmentBuffers.clear();
    this._seenTids.clear();
    this._activeTransport = null;
    this._onPacketReceived = null;
    this._onTransportSwitch = null;
    this._onError = null;

    httprLog('core-destroyed');
  }

  // ==========================================
  // ПРИВАТНЫЕ МЕТОДЫ
  // ==========================================

  async _buildEnvelope(payload, options = {}) {
    const kid = options.kid || null;
    const transportKey = kid ? this._transportKeys.get(kid) : null;

    let pl;
    if (transportKey) {
      const plaintext = JSON.stringify(payload);
      pl = await httprAesGcmEncrypt(plaintext, transportKey);
    } else {
      pl = httprEncodeBase64(JSON.stringify(payload));
    }

    return JSON.stringify({
      v: options.version || HTTPR_VERSION,
      tid: options.tid || httprGenId(),
      hop: options.hop || 0,
      ttl: options.ttl ?? HTTPR_DEFAULTS.TTL,
      ts: Date.now(),
      kid: kid,
      pl: pl
    });
  }

  async _handleIncomingEnvelope(envelope, routingKey, transportName) {
    let env;
    try {
      env = JSON.parse(envelope);
    } catch(e) {
      this._stats.packetsDropped++;
      return;
    }

    // Проверка версии
    if (!env.v || env.v < 1) {
      this._stats.packetsDropped++;
      return;
    }

    // Проверка TTL
    if (env.hop >= env.ttl) {
      this._stats.packetsDropped++;
      return;
    }

    // Дедупликация по tid
    if (env.tid) {
      if (this._seenTids.has(env.tid)) {
        return; // Дубликат, молча игнорируем
      }
      this._seenTids.set(env.tid, Date.now());
      // Очистка старых tid
      if (this._seenTids.size > HTTPR_DEFAULTS.DEDUP_CACHE_SIZE) {
        const cutoff = Date.now() - HTTPR_DEFAULTS.DEDUP_CACHE_TTL;
        for (const [tid, ts] of this._seenTids) {
          if (ts < cutoff) this._seenTids.delete(tid);
        }
      }
    }

    // Расшифровка конверта
    let payload;
    if (env.kid && this._transportKeys.has(env.kid)) {
      const transportKey = this._transportKeys.get(env.kid);
      const decrypted = await httprAesGcmDecrypt(env.pl, transportKey);
      if (!decrypted) {
        this._stats.packetsDropped++;
        this._emitError('decrypt-failed', { tid: env.tid, kid: env.kid });
        return;
      }
      try {
        payload = JSON.parse(decrypted);
      } catch(e) {
        this._stats.packetsDropped++;
        return;
      }
    } else {
      try {
        payload = JSON.parse(httprDecodeBase64(env.pl));
      } catch(e) {
        this._stats.packetsDropped++;
        return;
      }
    }

    // Проверка типа пакета
    const ptype = HTTPR_PACKET_TYPES[payload.type];
    if (!ptype) {
      this._stats.packetsDropped++;
      this._emitError('unknown-packet-type', { type: payload.type });
      return;
    }

    // Обработка фрагментов
    if (payload.type === 'fragment') {
      this._handleFragment(payload, {
        routingKey,
        transport: transportName,
        tid: env.tid,
        hop: env.hop,
        ttl: env.ttl,
        timestamp: env.ts,
        kid: env.kid
      });
      return;
    }

    this._stats.packetsReceived++;

    // Доставка глобальному обработчику
    if (this._onPacketReceived) {
      try {
        this._onPacketReceived(payload, {
          routingKey,
          transport: transportName,
          tid: env.tid,
          hop: env.hop,
          ttl: env.ttl,
          timestamp: env.ts,
          kid: env.kid
        });
      } catch(e) {}
    }

    // Доставка подписчикам routingKey
    const entry = this._routingTable.get(routingKey);
    if (entry) {
      for (const callback of entry.callbacks) {
        try {
          callback(payload, {
            routingKey,
            transport: transportName,
            tid: env.tid,
            hop: env.hop,
            ttl: env.ttl,
            timestamp: env.ts,
            kid: env.kid
          });
        } catch(e) {}
      }
    }
  }

  _handleFragment(fragmentPayload, meta) {
    const { groupId, index, total, data } = fragmentPayload;

    if (!this._fragmentBuffers.has(groupId)) {
      const timer = setTimeout(() => {
        this._fragmentBuffers.delete(groupId);
        this._stats.packetsDropped += total;
        this._emitError('fragment-timeout', { groupId });
      }, HTTPR_DEFAULTS.FRAGMENT_TIMEOUT);

      this._fragmentBuffers.set(groupId, {
        chunks: new Array(total),
        received: 0,
        total,
        timer,
        meta
      });
    }

    const buffer = this._fragmentBuffers.get(groupId);

    if (!buffer.chunks[index]) {
      buffer.chunks[index] = data;
      buffer.received++;
    }

    if (buffer.received === buffer.total) {
      clearTimeout(buffer.timer);

      // Собираем полный payload
      const fullData = buffer.chunks.map(c => httprDecodeBase64(c)).join('');
      this._fragmentBuffers.delete(groupId);

      let payload;
      try {
        payload = JSON.parse(fullData);
      } catch(e) {
        this._stats.packetsDropped += buffer.total;
        return;
      }

      this._stats.packetsReceived++;
      this._stats.fragmentsReassembled++;

      // Доставляем собранный пакет
      if (this._onPacketReceived) {
        try {
          this._onPacketReceived(payload, {
            ...buffer.meta,
            reconstructed: true,
            groupId
          });
        } catch(e) {}
      }

      const entry = this._routingTable.get(buffer.meta.routingKey);
      if (entry) {
        for (const callback of entry.callbacks) {
          try {
            callback(payload, {
              ...buffer.meta,
              reconstructed: true,
              groupId
            });
          } catch(e) {}
        }
      }
    }
  }

  async _sendFragmented(payload, routingKey, options = {}) {
    const serialized = JSON.stringify(payload);
    const chunkSize = HTTPR_DEFAULTS.FRAGMENT_CHUNK_SIZE;
    const totalChunks = Math.ceil(serialized.length / chunkSize);
    const groupId = httprGenId();

    for (let i = 0; i < totalChunks; i++) {
      const chunk = serialized.slice(i * chunkSize, (i + 1) * chunkSize);
      const fragmentPayload = {
        type: 'fragment',
        groupId,
        index: i,
        total: totalChunks,
        data: httprEncodeBase64(chunk)
      };

      const envelope = await this._buildEnvelope(fragmentPayload, {
        ...options,
        fragment: false
      });

      await this._sendRaw(envelope, routingKey);
    }

    return { success: true, fragmented: true, groupId, totalChunks };
  }

  async _sendRaw(envelope, routingKey) {
    const capable = this._getHealthyTransports()
      .filter(t => t.maxPacketSize >= envelope.length)
      .sort((a, b) => a.priority - b.priority);

    for (const transport of capable) {
      const result = await transport.send(envelope, routingKey);
      if (result.success) {
        this._stats.packetsSent++;
        return { success: true, transport: transport.name };
      }
    }

    this._stats.packetsDropped++;
    return { success: false };
  }

  _setActiveTransport(name) {
    const oldName = this._activeTransport?.name || null;
    this._activeTransport = name ? this._transports.get(name) || null : null;

    if (oldName !== name && this._onTransportSwitch) {
      try {
        this._onTransportSwitch({
          from: oldName,
          to: name,
          transport: this._activeTransport
        });
      } catch(e) {}
    }

    httprLog('active-transport', { from: oldName, to: name });
  }

  _getHealthyTransports() {
    const result = [];
    for (const transport of this._transports.values()) {
      if (transport.healthy) {
        result.push(transport);
      }
    }
    return result.sort((a, b) => a.priority - b.priority);
  }

  _startHealthCheck() {
    this._healthCheckTimer = setInterval(async () => {
      for (const transport of this._transports.values()) {
        const health = await transport.healthCheck();

        if (this._activeTransport === transport && !health.healthy) {
          const sorted = this._getHealthyTransports();
          if (sorted.length > 0 && sorted[0] !== transport) {
            this._setActiveTransport(sorted[0].name);
          }
        }
      }
    }, HTTPR_DEFAULTS.HEALTH_CHECK_INTERVAL);
  }

  _emitError(code, details = {}) {
    if (this._onError) {
      try {
        this._onError({ code, message: `HTTPR error: ${code}`, details });
      } catch(e) {}
    }
  }
}

// ============================================================
// 7. ЭКСПОРТ
// ============================================================

if (typeof window !== 'undefined') {
  window.HTTPRCore = HTTPRCore;
  window.HTTPRelayTransport = HTTPRelayTransport;
  window.BaseHTTPRTransport = BaseHTTPRTransport;
  window.IHTTPRTransport = IHTTPRTransport;
  window.HTTPR_PACKET_TYPES = HTTPR_PACKET_TYPES;
  window.HTTPR_VERSION = HTTPR_VERSION;
  window.HTTPR_DEFAULTS = HTTPR_DEFAULTS;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    HTTPRCore,
    HTTPRelayTransport,
    BaseHTTPRTransport,
    IHTTPRTransport,
    HTTPR_PACKET_TYPES,
    HTTPR_VERSION,
    HTTPR_DEFAULTS,
    httprAesGcmEncrypt,
    httprAesGcmDecrypt,
    httprShaFingerprint,
    httprGenId
  };
}
