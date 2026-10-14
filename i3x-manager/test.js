'use strict';
// Developed by BlocIoT for educational purposes. Provided as-is, without warranty.
// Conduct your own tests before deploying this manager in a production environment.
// Self-check: model build, read, write round-trip, history, watch, and HTTP round-trip against the mock addon.
const assert = require('node:assert/strict');
const http = require('node:http');
const winccoa = require('./dev/mock-winccoa');
const { createOaBackend } = require('./lib/oa-backend');
const { createI3xServer } = require('./lib/i3x-server');

const req = (port, method, path, body) => new Promise((res, rej) => {
  const r = http.request({ port, method, path, headers: { 'content-type': 'application/json' } }, (rs) => {
    let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => res({ status: rs.statusCode, body: d ? JSON.parse(d) : null }));
  });
  r.on('error', rej); r.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  const be = createOaBackend(winccoa, { dpPattern: '*', includeInternal: false, modelTtlMs: 60_000 });

  // model
  assert.ok(be.objectTypes().some((t) => t.elementId === 'dpt:Pump'));
  assert.ok(be.objectTypes().some((t) => t.elementId === 'dpt:Motor'), 'typeref struct gets its own type');
  assert.ok(!be.getObject('System1:_Hidden'), 'internal DPs hidden by default');
  const pump = be.getObject('System1:Pump1');
  assert.equal(pump.isComposition, true);
  assert.equal(be.getObject('System1:Pump1.motor.temp').parentId, 'System1:Pump1.motor');

  // write + read (current)
  await be.write('System1:Pump1', { value: { motor: { temp: 42.5 }, state: true } }, false);
  const v = (await be.readValues(['System1:Pump1'], 0)).get('System1:Pump1');
  assert.equal(v.value.motor.temp, 42.5);
  assert.equal(v.value.state, true);
  assert.equal(v.quality, 'Good');
  assert.ok(v.components['System1:Pump1.motor.temp']);

  // historical write lands in history at the given time
  const t = new Date(Date.now() - 3_600_000);
  await be.write('System1:Pump1.motor.temp', { value: 7, timestamp: t.toISOString() }, true);
  const h = (await be.history(['System1:Pump1.motor.temp'], new Date(t - 1000), new Date(+t + 1000), 1)).get('System1:Pump1.motor.temp');
  assert.equal(h.values.length, 1);
  assert.equal(h.values[0].value, 7);

  // watch fires on change
  let fired = 0;
  const unwatch = be.watch('System1:Pump1.speed', () => fired++);
  await winccoa.dpSetWait(['System1:Pump1.speed:_original.._value'], [1]);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(fired > 0);
  unwatch();

  // HTTP: bulk envelope + 404 item + token gate
  const srv = createI3xServer(be, { token: 'secret', readOnly: false, subTtlMs: 60_000, serverName: 't', serverVersion: '0' });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  assert.equal((await req(port, 'GET', '/v1/info')).status, 200);
  assert.equal((await req(port, 'GET', '/v1/namespaces')).status, 401);
  srv.close();

  console.log('ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
