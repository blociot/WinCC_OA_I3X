'use strict';
// Developed by BlocIoT for educational purposes. Provided as-is, without warranty.
// Conduct your own tests before deploying this manager in a production environment.
// i3X 1.0 protocol layer (https://www.i3x.dev). Backend-agnostic: everything
// WinCC OA specific lives in oa-backend.js. Structure follows the CESMII
// reference mock (cesmii/i3X conformance-tests/mock/server.js).

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const nowIso = () => new Date().toISOString();
const notFound = (key, id, detail) => ({ success: false, [key]: id, responseDetail: { title: 'Not Found', status: 404, detail } });
const ok = (key, id, result = null) => ({ success: true, [key]: id, result });
const bulk = (results) => ({ success: results.every((r) => r.success), results });

function send(req, res, status, obj) {
  let payload = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json' };
  if (String(req.headers['accept-encoding'] || '').includes('gzip')) {
    payload = zlib.gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = payload.length;
  res.writeHead(status, headers);
  res.end(payload);
}
const sendError = (req, res, status, title, detail) => send(req, res, status, { success: false, responseDetail: { title, status, detail } });

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); }
    });
  });
}

/**
 * @param backend contract (see oa-backend.js):
 *   namespaces(), objectTypes(), relationshipTypes(), objects(), getObject(id),
 *   objectRecord(obj, includeMetadata), related(obj, relType?) -> [[rel, obj]],
 *   readValues(ids, maxDepth) -> Map id -> {isComposition,value,quality,timestamp,components?}
 *   history(ids, lo, hi, maxDepth) -> Map id -> {isComposition, values, components?}
 *   write(id, vqt) -> Promise<void>, watch(id, cb) -> unwatch fn
 * @param opts {token, tls:{cert,key}, readOnly, subTtlMs, serverName, serverVersion, log}
 */
function createI3xServer(backend, opts = {}) {
  const log = opts.log || console;
  const SUB_TTL = opts.subTtlMs || 3600_000;
  const MAX_BATCHES = 1000; // ponytail: per-subscription queue cap, oldest dropped + 206 on next sync
  const subs = new Map();

  const hasClient = (b) => b && typeof b.clientId === 'string' && b.clientId;
  const ownedSub = (b, id) => { const s = subs.get(id); return s && s.clientId === b.clientId ? s : null; };
  const needIds = (b) => b && Array.isArray(b.elementIds);
  const notFoundObj = (id) => notFound('elementId', id, `Element not found: ${id}`);
  const badItem = (id, detail, status = 400) => ({ success: false, elementId: id, responseDetail: { title: status === 400 ? 'Bad Request' : 'Internal Server Error', status, detail } });

  // --- subscriptions --------------------------------------------------------
  const touch = (sub) => { sub.lastActivity = Date.now(); };

  function pushBatch(sub, updates) {
    if (!updates.length) return;
    sub.batches.push({ sequenceNumber: sub.nextSeq++, updates });
    if (sub.batches.length > MAX_BATCHES) { sub.batches.shift(); sub.overflow = true; }
    if (sub.streamRes) {
      sub.streamRes.write(`data: ${JSON.stringify(updates)}\n\n`);
      sub.batches = [];
    }
  }

  // Coalesce OA change bursts (50 ms) into one batch per subscription.
  function markDirty(sub, elementId) {
    sub.dirty.add(elementId);
    if (sub.flushTimer) return;
    sub.flushTimer = setTimeout(async () => {
      sub.flushTimer = null;
      const ids = [...sub.dirty];
      sub.dirty.clear();
      try {
        const updates = [];
        for (const id of ids) {
          const cfg = sub.monitored.get(id);
          if (!cfg) continue;
          const v = (await backend.readValues([id], cfg.maxDepth)).get(id);
          if (!v) continue;
          updates.push({ elementId: id, value: v.value, quality: v.quality, timestamp: v.timestamp });
          for (const [cid, cv] of Object.entries(v.components || {})) updates.push({ elementId: cid, ...cv });
        }
        pushBatch(sub, updates);
      } catch (e) { log.error('subscription flush failed:', e); }
    }, 50);
  }

  function unregister(sub, id) {
    const cfg = sub.monitored.get(id);
    if (!cfg) return false;
    try { cfg.unwatch(); } catch (e) { log.error('unwatch failed:', e); }
    sub.monitored.delete(id);
    return true;
  }

  function deleteSub(id) {
    const sub = subs.get(id);
    if (!sub) return;
    for (const eid of [...sub.monitored.keys()]) unregister(sub, eid);
    if (sub.flushTimer) clearTimeout(sub.flushTimer);
    if (sub.streamRes) { try { sub.streamRes.end(); } catch { /* closed */ } }
    subs.delete(id);
  }

  const sweeper = setInterval(() => {
    for (const [id, sub] of subs) if (!sub.streamRes && Date.now() - sub.lastActivity > SUB_TTL) deleteSub(id);
  }, 60_000);
  sweeper.unref();

  // --- writes (PUT /objects/value and /history share the envelope) -----------
  async function putValues(req, res, historical) {
    if (opts.readOnly) return sendError(req, res, 501, 'Not Implemented', 'This server is read-only (update.current/history = false)');
    const body = await readJson(req);
    if (!body || !Array.isArray(body.updates)) return sendError(req, res, 400, 'Bad Request', 'updates array is required');
    const results = [];
    for (const u of body.updates) {
      const id = u && u.elementId;
      if (!backend.getObject(id)) { results.push(notFoundObj(id)); continue; }
      const v = u.value || {};
      if (!('value' in v)) { results.push(badItem(id, 'updates[].value.value is required')); continue; }
      if (historical && Number.isNaN(Date.parse(v.timestamp))) { results.push(badItem(id, 'value and RFC 3339 timestamp are required for historical writes')); continue; }
      try {
        await backend.write(id, { value: v.value, quality: v.quality || 'Good', timestamp: v.timestamp || nowIso() }, historical);
        results.push(ok('elementId', id));
      } catch (e) { results.push(badItem(id, String(e.message || e))); }
    }
    send(req, res, 200, bulk(results));
  }

  // --- routes ----------------------------------------------------------------
  const routes = {
    'GET /info': (req, res) => send(req, res, 200, {
      success: true,
      result: {
        specVersion: '1.0',
        serverVersion: opts.serverVersion || '1.0.0',
        serverName: opts.serverName || 'WinCC OA i3X Manager',
        capabilities: {
          query: { history: true },
          update: { current: !opts.readOnly, history: !opts.readOnly },
          subscribe: { stream: true }
        }
      }
    }),

    'GET /namespaces': (req, res) => send(req, res, 200, { success: true, result: backend.namespaces() }),

    'GET /objecttypes': (req, res, url) => {
      const ns = url.searchParams.get('namespaceUri');
      send(req, res, 200, { success: true, result: backend.objectTypes().filter((t) => !ns || t.namespaceUri === ns) });
    },

    'POST /objecttypes/query': async (req, res) => {
      const body = await readJson(req);
      if (!needIds(body)) return sendError(req, res, 400, 'Bad Request', 'elementIds array is required');
      const byId = new Map(backend.objectTypes().map((t) => [t.elementId, t]));
      send(req, res, 200, bulk(body.elementIds.map((id) => byId.has(id)
        ? ok('elementId', id, byId.get(id))
        : notFound('elementId', id, `Object type not found: ${id}`))));
    },

    'GET /relationshiptypes': (req, res, url) => {
      const ns = url.searchParams.get('namespaceUri');
      send(req, res, 200, { success: true, result: backend.relationshipTypes().filter((t) => !ns || t.namespaceUri === ns) });
    },

    'POST /relationshiptypes/query': async (req, res) => {
      const body = await readJson(req);
      if (!needIds(body)) return sendError(req, res, 400, 'Bad Request', 'elementIds array is required');
      const byId = new Map(backend.relationshipTypes().map((t) => [t.elementId, t]));
      send(req, res, 200, bulk(body.elementIds.map((id) => byId.has(id)
        ? ok('elementId', id, byId.get(id))
        : notFound('elementId', id, `Relationship type not found: ${id}`))));
    },

    'GET /objects': (req, res, url) => {
      const typeId = url.searchParams.get('typeElementId');
      const root = url.searchParams.get('root') === 'true';
      const meta = url.searchParams.get('includeMetadata') === 'true';
      let list = backend.objects();
      if (typeId) list = list.filter((o) => o.typeElementId === typeId);
      if (root) list = list.filter((o) => o.parentId === null);
      send(req, res, 200, { success: true, result: list.map((o) => backend.objectRecord(o, meta)) });
    },

    'POST /objects/list': async (req, res) => {
      const body = await readJson(req);
      if (!needIds(body)) return sendError(req, res, 400, 'Bad Request', 'elementIds array is required');
      send(req, res, 200, bulk(body.elementIds.map((id) => {
        const o = backend.getObject(id);
        return o ? ok('elementId', id, backend.objectRecord(o, body.includeMetadata === true)) : notFoundObj(id);
      })));
    },

    'POST /objects/related': async (req, res) => {
      const body = await readJson(req);
      if (!needIds(body)) return sendError(req, res, 400, 'Bad Request', 'elementIds array is required');
      send(req, res, 200, bulk(body.elementIds.map((id) => {
        const o = backend.getObject(id);
        if (!o) return notFoundObj(id);
        return ok('elementId', id, backend.related(o, body.relationshipType).map(([rel, target]) => ({
          sourceRelationship: rel, object: backend.objectRecord(target, body.includeMetadata === true)
        })));
      })));
    },

    'POST /objects/value': async (req, res) => {
      const body = await readJson(req);
      if (!needIds(body)) return sendError(req, res, 400, 'Bad Request', 'elementIds array is required');
      const maxDepth = body.maxDepth === undefined ? 1 : body.maxDepth;
      const vals = await backend.readValues(body.elementIds.filter((id) => backend.getObject(id)), maxDepth);
      send(req, res, 200, bulk(body.elementIds.map((id) => vals.has(id) ? ok('elementId', id, vals.get(id)) : notFoundObj(id))));
    },

    'PUT /objects/value': (req, res) => putValues(req, res, false),
    'PUT /objects/history': (req, res) => putValues(req, res, true),

    'POST /objects/history': async (req, res) => {
      const body = await readJson(req);
      if (!needIds(body)) return sendError(req, res, 400, 'Bad Request', 'elementIds array is required');
      if (!body.startTime || !body.endTime) return sendError(req, res, 400, 'Bad Request', 'startTime and endTime are required');
      const a = Date.parse(body.startTime), b = Date.parse(body.endTime);
      if (Number.isNaN(a) || Number.isNaN(b)) return sendError(req, res, 400, 'Bad Request', 'startTime and endTime must be valid RFC 3339 timestamps');
      const maxDepth = body.maxDepth === undefined ? 1 : body.maxDepth;
      const hist = await backend.history(body.elementIds.filter((id) => backend.getObject(id)), Math.min(a, b), Math.max(a, b), maxDepth);
      send(req, res, 200, bulk(body.elementIds.map((id) => hist.has(id) ? ok('elementId', id, hist.get(id)) : notFoundObj(id))));
    },

    'POST /subscriptions': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      const subscriptionId = crypto.randomBytes(18).toString('base64url');
      subs.set(subscriptionId, {
        subscriptionId, clientId: body.clientId, displayName: body.displayName || null,
        monitored: new Map(), batches: [], nextSeq: 1, streamRes: null, dirty: new Set(), flushTimer: null,
        overflow: false, lastActivity: Date.now()
      });
      send(req, res, 200, { success: true, result: { clientId: body.clientId, subscriptionId, displayName: body.displayName || null } });
    },

    'POST /subscriptions/list': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      if (!Array.isArray(body.subscriptionIds)) return sendError(req, res, 400, 'Bad Request', 'subscriptionIds array is required');
      send(req, res, 200, bulk(body.subscriptionIds.map((id) => {
        const sub = ownedSub(body, id);
        if (!sub) return notFound('subscriptionId', id, `Subscription not found: ${id}`);
        return ok('subscriptionId', id, {
          subscriptionId: id, displayName: sub.displayName,
          monitoredObjects: [...sub.monitored].map(([elementId, cfg]) => ({ elementId, maxDepth: cfg.maxDepth }))
        });
      })));
    },

    'POST /subscriptions/delete': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      if (!Array.isArray(body.subscriptionIds)) return sendError(req, res, 400, 'Bad Request', 'subscriptionIds array is required');
      send(req, res, 200, bulk(body.subscriptionIds.map((id) => {
        if (!ownedSub(body, id)) return notFound('subscriptionId', id, `Subscription not found: ${id}`);
        deleteSub(id);
        return ok('subscriptionId', id);
      })));
    },

    'POST /subscriptions/register': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      if (!body.subscriptionId || !Array.isArray(body.elementIds)) return sendError(req, res, 400, 'Bad Request', 'subscriptionId and elementIds are required');
      const sub = ownedSub(body, body.subscriptionId);
      if (!sub) return sendError(req, res, 404, 'Not Found', `Subscription not found: ${body.subscriptionId}`);
      touch(sub);
      const maxDepth = body.maxDepth === undefined ? 1 : body.maxDepth;
      send(req, res, 200, bulk(body.elementIds.map((id) => {
        if (!backend.getObject(id)) return notFoundObj(id);
        unregister(sub, id); // re-register = update depth
        try {
          const unwatch = backend.watch(id, () => markDirty(sub, id));
          sub.monitored.set(id, { maxDepth, unwatch });
          return ok('elementId', id);
        } catch (e) { return badItem(id, String(e.message || e), 500); }
      })));
    },

    'POST /subscriptions/unregister': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      if (!body.subscriptionId || !Array.isArray(body.elementIds)) return sendError(req, res, 400, 'Bad Request', 'subscriptionId and elementIds are required');
      const sub = ownedSub(body, body.subscriptionId);
      if (!sub) return sendError(req, res, 404, 'Not Found', `Subscription not found: ${body.subscriptionId}`);
      touch(sub);
      send(req, res, 200, bulk(body.elementIds.map((id) => unregister(sub, id)
        ? ok('elementId', id)
        : notFound('elementId', id, `Element not registered: ${id}`))));
    },

    'POST /subscriptions/sync': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      if (!body.subscriptionId) return sendError(req, res, 400, 'Bad Request', 'subscriptionId is required');
      const sub = ownedSub(body, body.subscriptionId);
      if (!sub) return sendError(req, res, 404, 'Not Found', `Subscription not found: ${body.subscriptionId}`);
      if (sub.streamRes) return sendError(req, res, 400, 'Bad Request', 'Subscription has an open SSE stream; close it before calling sync');
      touch(sub);
      const last = body.lastSequenceNumber;
      if (last === -1) sub.batches = [];
      else if (typeof last === 'number' && last >= 0) sub.batches = sub.batches.filter((b) => b.sequenceNumber > last);
      const resp = { success: true, result: sub.batches };
      if (sub.overflow) {
        sub.overflow = false;
        resp.responseDetail = { title: 'Partial Content', status: 206, detail: `Update queue overflowed; batches beyond ${MAX_BATCHES} were dropped` };
        return send(req, res, 206, resp);
      }
      send(req, res, 200, resp);
    },

    'POST /subscriptions/stream': async (req, res) => {
      const body = await readJson(req);
      if (!hasClient(body)) return sendError(req, res, 400, 'Bad Request', 'clientId is required');
      if (!body.subscriptionId) return sendError(req, res, 400, 'Bad Request', 'subscriptionId is required');
      const sub = ownedSub(body, body.subscriptionId);
      if (!sub) return sendError(req, res, 404, 'Not Found', `Subscription not found: ${body.subscriptionId}`);
      if (sub.streamRes) { try { sub.streamRes.end(); } catch { /* prior stream */ } sub.streamRes = null; }
      touch(sub);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      sub.streamRes = res;
      const pending = sub.batches.flatMap((b) => b.updates);
      sub.batches = [];
      res.write(pending.length ? `data: ${JSON.stringify(pending)}\n\n` : ': connected\n\n');
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(heartbeat);
        if (sub.streamRes === res) { sub.streamRes = null; touch(sub); }
      });
    }
  };

  const handler = (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/v1/')) return sendError(req, res, 404, 'Not Found', `Unknown path ${url.pathname}; endpoints are prefixed with /v1`);
    const route = `${req.method} ${url.pathname.slice(3).replace(/\/$/, '')}`;
    const fn = routes[route];
    if (!fn) return sendError(req, res, 404, 'Not Found', `No such endpoint: ${route}`);
    if (opts.token && route !== 'GET /info' && req.headers.authorization !== `Bearer ${opts.token}`) {
      return sendError(req, res, 401, 'Unauthorized', 'Missing or invalid bearer token');
    }
    Promise.resolve(fn(req, res, url)).catch((e) => {
      log.error(`${route} failed:`, e);
      if (!res.headersSent) sendError(req, res, 500, 'Internal Server Error', String(e.message || e));
    });
  };

  const server = opts.tls ? https.createServer(opts.tls, handler) : http.createServer(handler);
  server.on('close', () => { clearInterval(sweeper); for (const id of [...subs.keys()]) deleteSub(id); });
  return server;
}

module.exports = { createI3xServer };
