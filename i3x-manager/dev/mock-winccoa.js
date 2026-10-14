'use strict';
// Developed by BlocIoT for educational purposes. Provided as-is, without warranty.
// Conduct your own tests before deploying this manager in a production environment.
// ponytail: tiny in-process stand-in for the winccoa-manager addon so the server
// and the i3X conformance suite run outside a WinCC OA project (I3X_MOCK=1).

const T = { Struct: 1, Float: 22, Int: 21, Bool: 23, String: 25, Time: 26, DynFloat: 6 };
const leaf = (name, type) => ({ name, type, refName: '', children: [] });
const TYPES = {
  ExampleDP_Float: leaf('ExampleDP_Float', T.Float),
  Pump: {
    name: 'Pump', type: T.Struct, refName: '', children: [
      leaf('state', T.Bool), leaf('speed', T.Float),
      { name: 'motor', type: T.Struct, refName: 'Motor', children: [leaf('current', T.Float), leaf('temp', T.Float)] },
      { name: 'alarm', type: T.Struct, refName: '', children: [leaf('active', T.Bool), leaf('text', T.String)] }
    ]
  },
  _Internal: leaf('_Internal', T.Int)
};
const DPS = { ExampleDP_Float: ['ExampleDP_Arg1', 'ExampleDP_Arg2'], Pump: ['Pump1', 'Pump2'], _Internal: ['_Hidden'] };

const vals = new Map(); // "System1:dp.elem" -> {v, t}
const hist = new Map(); // addr -> [{t, v}]
const conns = new Map(); // id -> {names, cb}
let nextConn = 1;

const now = () => new Date();
function init(addr, node) {
  if (node.children.length) return node.children.forEach((c) => init(`${addr}.${c.name}`, c));
  const v = node.type === T.Bool ? false : node.type === T.String ? '' : node.type === T.Time ? now() : 0;
  vals.set(addr.replace(/\.$/, ''), { v, t: now() });
}
for (const [dpt, dps] of Object.entries(DPS)) for (const dp of dps) init(`System1:${dp}`, TYPES[dpt]);
const key = (name) => name.split(':_')[0].replace(/\.$/, '');

function set(name, v) {
  const k = key(name);
  if (!vals.has(k)) throw new Error(`DPE does not exist: ${name}`);
  vals.set(k, { v, t: now() });
  if (!hist.has(k)) hist.set(k, []);
  hist.get(k).push({ t: now(), v });
  for (const c of conns.values()) {
    if (c.names.some((n) => key(n) === k)) setImmediate(() => c.cb([`${k}:_online.._value`], [v], 0));
  }
}
// simulate the field: bump floats every second
setInterval(() => {
  for (const k of vals.keys()) if (k.endsWith('.speed') || k.endsWith('Arg1')) set(k, Math.round(Math.random() * 1000) / 10);
}, 1000).unref();

module.exports = {
  getSystemName: () => 'System1:',
  getSystemId: () => 1,
  setOptions() {},
  securityEvent() {},
  exit() {},
  dpTypes: () => Object.keys(TYPES),
  dpTypeGet: (dpt) => { if (!TYPES[dpt]) throw new Error(`DP type does not exist: ${dpt}`); return TYPES[dpt]; },
  dpNames: (pattern, dpt) => (dpt ? DPS[dpt] || [] : Object.values(DPS).flat()).map((d) => `System1:${d}`),
  dpExists: (n) => vals.has(key(n)),
  dpGetDescription: (n) => `Description of ${key(n)}`,
  dpGetUnit: () => '',
  dpGetFormat: () => '%6.2f',
  async dpGet(names) {
    const one = (n) => {
      const e = vals.get(key(n));
      if (!e) throw new Error(`DPE does not exist: ${n}`);
      if (n.endsWith('_stime')) return e.t;
      if (n.endsWith('_invalid')) return false;
      return e.v;
    };
    return Array.isArray(names) ? names.map(one) : one(names);
  },
  async dpSetWait(names, values) {
    [].concat(names).forEach((n, i) => set(n, Array.isArray(names) ? values[i] : values));
    return true;
  },
  dpSet(names, values) { return this.dpSetWait(names, values), true; },
  async dpSetTimedWait(time, names, values) {
    [].concat(names).forEach((n, i) => {
      const k = key(n), v = Array.isArray(names) ? values[i] : values;
      if (!vals.has(k)) throw new Error(`DPE does not exist: ${n}`);
      vals.set(k, { v, t: new Date(time) });
      if (!hist.has(k)) hist.set(k, []);
      hist.get(k).push({ t: new Date(time), v });
      hist.get(k).sort((a, b) => a.t - b.t);
    });
    return true;
  },
  async dpGetPeriod(start, end, dpes) {
    return dpes.map((d) => {
      const rows = (hist.get(key(d)) || []).filter((r) => r.t >= start && r.t <= end);
      return { times: rows.map((r) => r.t), values: rows.map((r) => r.v) };
    });
  },
  dpConnect(cb, names, answer) {
    const id = nextConn++;
    names = [].concat(names);
    conns.set(id, { names, cb });
    if (answer) setImmediate(() => cb(names, names.map((n) => vals.get(key(n)).v), 1));
    return id;
  },
  dpDisconnect(id) { return conns.delete(id); }
};
