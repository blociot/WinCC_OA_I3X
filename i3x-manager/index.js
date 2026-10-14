'use strict';
// Developed by BlocIoT for educational purposes. Provided as-is, without warranty.
// Conduct your own tests before deploying this manager in a production environment.
// WinCC OA JavaScript manager exposing PARA data over the i3X 1.0 REST API.
// Run inside a project: JavaScript manager with option `i3x-manager/index.js`.
// Run standalone for development: I3X_MOCK=1 node index.js

const fs = require('node:fs');
const path = require('node:path');
const { createOaBackend } = require('./lib/oa-backend');
const { createI3xServer } = require('./lib/i3x-server');

// config.json next to this file (optional), env vars override.
let file = {};
try { file = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { /* none */ }
const env = process.env;
const cfg = {
  port: Number(env.I3X_PORT || file.port || 8089),
  host: env.I3X_HOST || file.host || '0.0.0.0',
  token: env.I3X_TOKEN || file.token || '',
  tlsCert: env.I3X_TLS_CERT || file.tlsCert || '',
  tlsKey: env.I3X_TLS_KEY || file.tlsKey || '',
  readOnly: (env.I3X_READONLY ?? file.readOnly ?? '0') == 1,
  dpPattern: env.I3X_DP_PATTERN || file.dpPattern || '*',
  includeInternal: (env.I3X_INCLUDE_INTERNAL ?? file.includeInternal ?? '0') == 1,
  modelTtlMs: Number(env.I3X_MODEL_TTL_MS || file.modelTtlMs || 30_000),
  subTtlMs: Number(env.I3X_SUB_TTL_MS || file.subTtlMs || 3_600_000)
};

let winccoa, Sec = {};
if (env.I3X_MOCK == 1) {
  winccoa = require('./dev/mock-winccoa');
} else {
  const oa = require('winccoa-manager');
  winccoa = new oa.WinccoaManager();
  winccoa.setOptions({ timeFormat: 0 /* Date */, langStringFormat: 0 /* active language string */ });
  Sec = oa.WinccoaSecurityEventId || {};
}

const backend = createOaBackend(winccoa, cfg);
const tls = cfg.tlsCert && cfg.tlsKey ? { cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey) } : null;
const server = createI3xServer(backend, {
  token: cfg.token, tls, readOnly: cfg.readOnly, subTtlMs: cfg.subTtlMs,
  serverName: `WinCC OA i3X Manager (${winccoa.getSystemName().replace(/:$/, '')})`,
  serverVersion: require('./package.json').version
});

server.listen(cfg.port, cfg.host, () => {
  const scheme = tls ? 'https' : 'http';
  console.log(`i3X API listening on ${scheme}://${cfg.host}:${cfg.port}/v1 ${cfg.token ? '(bearer auth)' : '(no auth)'}${cfg.readOnly ? ' read-only' : ''}`);
  if (winccoa.securityEvent && Sec.PortOpened !== undefined) winccoa.securityEvent(Sec.PortOpened, cfg.port, `${scheme}://`);
});

const stop = () => server.close(() => { if (!env.I3X_MOCK) winccoa.exit(); process.exit(0); });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
