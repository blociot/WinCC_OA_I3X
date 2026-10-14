'use strict';
// Developed by BlocIoT for educational purposes. Provided as-is, without warranty.
// Conduct your own tests before deploying this manager in a production environment.
// WinCC OA -> i3X mapping. Namespace = OA system, object types = DP types,
// objects = DPs and their elements, values/history/writes/subscriptions via
// the winccoa-manager API.

// WinccoaElementType numeric ids -> base kind (Struct variants folded in).
const KIND = {};
const def = (kind, ...ids) => ids.forEach((i) => { KIND[i] = kind; });
def('Struct', 1, 41);
def('Float', 22, 14); def('Int', 21, 13); def('UInt', 20, 12); def('Long', 54, 56); def('ULong', 58, 60);
def('Bit32', 24, 16); def('Bit64', 50, 52); def('Bool', 23, 15); def('String', 25, 17); def('Char', 19, 11);
def('Time', 26, 18); def('LangString', 42, 43); def('Blob', 46, 47); def('Dpid', 27, 39);
def('DynFloat', 6); def('DynInt', 5); def('DynUInt', 4); def('DynBool', 7); def('DynString', 9); def('DynTime', 10);
def('DynChar', 3); def('DynBit32', 8); def('DynBit64', 51); def('DynBlob', 48); def('DynDpid', 29);
def('DynLangString', 44); def('DynLong', 55); def('DynULong', 59);
// ponytail: Dyn*Struct ids (30-38,45,49,53,57,61) fall through to 'Dyn' = array of anything
const kindOf = (t) => KIND[t] || (t >= 30 ? 'Dyn' : 'Any');

const NUMERIC = new Set(['Float', 'Int', 'UInt', 'Long', 'ULong', 'Bit32', 'Bit64']);
function leafSchema(kind) {
  if (kind.startsWith('Dyn')) return { type: 'array', items: kind === 'Dyn' ? {} : leafSchema(kind.slice(3)) };
  if (NUMERIC.has(kind)) return { type: 'number' };
  if (kind === 'Bool') return { type: 'boolean' };
  if (kind === 'Time') return { type: 'string', format: 'date-time' };
  if (kind === 'Any') return {};
  return { type: 'string' };
}

function toJson(v) {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (Array.isArray(v)) return v.map(toJson);
  return v;
}
function fromJson(v, kind) {
  if (kind.startsWith('Dyn')) return Array.isArray(v) ? v.map((x) => fromJson(x, kind.slice(3))) : [fromJson(v, kind.slice(3))];
  if (kind === 'Time') return new Date(v);
  if (kind === 'Blob') return Buffer.from(String(v), 'base64');
  return v;
}
const iso = (t) => (t instanceof Date ? t : new Date(t || Date.now())).toISOString();
const str = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v)[0] : v) ?? '';

const REL = [
  ['HasParent', 'HasChildren'], ['HasChildren', 'HasParent'],
  ['HasComponent', 'ComponentOf'], ['ComponentOf', 'HasComponent']
];
const CHILD_REL = new Set(['HasChildren', 'HasComponent']);
const PARENT_REL = new Set(['HasParent', 'ComponentOf']);

/**
 * @param winccoa WinccoaManager instance (or dev/mock-winccoa.js)
 * @param cfg {dpPattern:'*', includeInternal:false, modelTtlMs:30000, log}
 */
function createOaBackend(winccoa, cfg = {}) {
  const log = cfg.log || console;
  const pattern = cfg.dpPattern || '*';
  const skipInternal = !cfg.includeInternal;
  const ttl = cfg.modelTtlMs ?? 30_000;
  const sys = winccoa.getSystemName().replace(/:$/, '');
  const nsUri = `urn:winccoa:${sys}`;
  const qualify = (dp) => (dp.includes(':') ? dp : `${sys}:${dp}`).replace(/\.$/, '');

  let model = null, builtAt = 0;

  function build() {
    const types = new Map(), objects = new Map();
    const isStruct = (node) => (node.children || []).length > 0 || kindOf(node.type) === 'Struct';
    const structTypeId = (node, pathId) => (node.refName ? `dpt:${node.refName}` : pathId);

    const addType = (node, elementId, dptName) => {
      if (types.has(elementId)) return elementId;
      types.set(elementId, null); // reserve (recursive refs)
      const kids = node.children || [];
      const schema = isStruct(node)
        ? { type: 'object', properties: Object.fromEntries(kids.map((c) => [c.name, typeSchema(c, `${elementId}/${c.name}`, dptName)])) }
        : leafSchema(kindOf(node.type));
      types.set(elementId, { elementId, displayName: node.refName || elementId.slice(4) /* ANALOG2/alert */, namespaceUri: nsUri, sourceTypeId: dptName, schema });
      return elementId;
    };
    // ponytail: inner structs become their own types so composition children have a typeElementId
    const typeSchema = (node, pathId, dptName) => {
      if (!isStruct(node)) return leafSchema(kindOf(node.type));
      return { $ref: addType(node, structTypeId(node, pathId), node.refName || dptName) };
    };
    const leafType = (kind) => {
      const id = `elt:${kind}`;
      if (!types.has(id)) types.set(id, { elementId: id, displayName: kind, namespaceUri: nsUri, sourceTypeId: kind, schema: leafSchema(kind) });
      return id;
    };
    const addObject = (node, elementId, parent, dptName, pathId) => {
      const kind = kindOf(node.type);
      const isComposition = isStruct(node);
      const obj = {
        elementId, displayName: parent ? node.name : elementId.slice(sys.length + 1),
        typeElementId: isComposition ? structTypeId(node, pathId) : leafType(kind),
        parentId: parent ? parent.elementId : null, isComposition, kind, dpt: dptName,
        addr: isComposition ? null : parent ? elementId : `${elementId}.`, children: [], leaves: [], meta: null
      };
      objects.set(elementId, obj);
      if (parent) parent.children.push(obj);
      for (const c of node.children || []) addObject(c, `${elementId}.${c.name}`, obj, dptName, `${pathId}/${c.name}`);
      obj.leaves = isComposition ? obj.children.flatMap((c) => c.leaves) : [obj];
      return obj;
    };

    for (const dpt of winccoa.dpTypes()) {
      if (skipInternal && dpt.startsWith('_')) continue;
      let tree;
      try { tree = winccoa.dpTypeGet(dpt, true); } catch (e) { log.warn(`dpTypeGet(${dpt}) failed: ${e.message || e}`); continue; }
      const typeId = addType(tree, `dpt:${dpt}`, dpt);
      for (const dp of winccoa.dpNames(pattern, dpt)) {
        const id = qualify(dp);
        if (skipInternal && id.slice(sys.length + 1).startsWith('_')) continue;
        addObject(tree, id, null, dpt, typeId).typeElementId = typeId;
      }
    }
    return { types, objects, list: [...objects.values()] };
  }

  // ponytail: whole model rebuilt every ttl; hook dpTypeChange/dpCreate if PARA edits must show instantly
  function m() {
    if (!model || Date.now() - builtAt > ttl) {
      const t = Date.now();
      model = build(); builtAt = Date.now();
      log.info(`i3X model: ${model.types.size} types, ${model.objects.size} objects (${builtAt - t} ms)`);
    }
    return model;
  }

  // --- values ---------------------------------------------------------------
  async function readLeaves(leaves) {
    const out = new Map();
    if (!leaves.length) return out;
    const names = leaves.flatMap((l) => [`${l.addr}:_online.._value`, `${l.addr}:_online.._stime`, `${l.addr}:_online.._invalid`]);
    const raw = await winccoa.dpGet(names);
    leaves.forEach((l, i) => {
      const value = toJson(raw[i * 3]);
      out.set(l.elementId, {
        isComposition: false, value,
        quality: raw[i * 3 + 2] ? 'Uncertain' : value === null ? 'GoodNoData' : 'Good',
        timestamp: iso(raw[i * 3 + 1])
      });
    });
    return out;
  }

  function compose(obj, leafVals) {
    if (!obj.isComposition) return leafVals.get(obj.elementId);
    const value = {};
    let ts = 0, bad = false;
    for (const c of obj.children) {
      const v = compose(c, leafVals);
      value[c.displayName] = v.value;
      ts = Math.max(ts, Date.parse(v.timestamp) || 0);
      bad = bad || v.quality === 'Bad';
    }
    return { isComposition: true, value, quality: bad ? 'Bad' : 'Good', timestamp: ts ? new Date(ts).toISOString() : iso() };
  }

  function descendants(obj, maxDepth) { // maxDepth 0 = unlimited, 1 = none, n = n-1 levels
    const out = [];
    const walk = (o, budget) => {
      for (const c of o.children) { out.push(c); if (budget !== 1) walk(c, budget - 1); }
    };
    walk(obj, maxDepth === 0 ? 0 : maxDepth - 1);
    return out;
  }

  async function readValues(ids, maxDepth) {
    const { objects } = m();
    const objs = ids.map((id) => objects.get(id)).filter(Boolean);
    const leafVals = await readLeaves([...new Set(objs.flatMap((o) => o.leaves))]);
    const out = new Map();
    for (const o of objs) {
      const v = compose(o, leafVals);
      if (o.isComposition && maxDepth !== 1) {
        v.components = Object.fromEntries(descendants(o, maxDepth).map((d) => [d.elementId, compose(d, leafVals)]));
      }
      out.set(o.elementId, v);
    }
    return out;
  }

  async function history(ids, lo, hi, maxDepth) {
    const { objects } = m();
    const objs = ids.map((id) => objects.get(id)).filter(Boolean);
    const leaves = [...new Set(objs.flatMap((o) => (o.isComposition && maxDepth === 1 ? [] : o.leaves)))];
    const series = new Map();
    if (leaves.length) {
      const res = await winccoa.dpGetPeriod(new Date(lo), new Date(hi), leaves.map((l) => l.addr));
      leaves.forEach((l, i) => {
        const s = res[i] || { times: [], values: [] };
        series.set(l.elementId, s.values.map((v, k) => ({ value: toJson(v), quality: 'Good', timestamp: iso(s.times[k]) })));
      });
    }
    const out = new Map();
    for (const o of objs) {
      const r = { isComposition: o.isComposition, values: o.isComposition ? [] : series.get(o.elementId) || [] };
      if (o.isComposition && maxDepth !== 1) {
        // ponytail: composition history = per-leaf series only; struct snapshots would need time alignment
        r.components = Object.fromEntries(descendants(o, maxDepth).map((d) => [d.elementId, { isComposition: d.isComposition, values: d.isComposition ? [] : series.get(d.elementId) || [] }]));
      }
      out.set(o.elementId, r);
    }
    return out;
  }

  // historical=true -> dpSetTimedWait with the VQT timestamp as source time (archived under that time).
  async function write(id, vqt, historical) {
    const obj = m().objects.get(id);
    const names = [], values = [];
    const collect = (o, v) => {
      if (!o.isComposition) { names.push(`${o.addr}:_original.._value`); values.push(fromJson(v, o.kind)); return; }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`Composition ${o.elementId} expects an object value`);
      for (const [k, cv] of Object.entries(v)) {
        const c = o.children.find((x) => x.displayName === k);
        if (!c) throw new Error(`Unknown element '${k}' in ${o.elementId}`);
        collect(c, cv);
      }
    };
    collect(obj, vqt.value);
    if (!names.length) return;
    // ponytail: OA has no pure archive insert; dpSetTimed stores under the given source time (also becomes online value)
    const okw = historical ? await winccoa.dpSetTimedWait(new Date(vqt.timestamp), names, values) : await winccoa.dpSetWait(names, values);
    if (!okw) throw new Error(`dpSet failed for ${id}`);
  }

  function watch(id, cb) {
    const obj = m().objects.get(id);
    if (!obj.leaves.length) return () => {};
    const cid = winccoa.dpConnect((_names, _values, type) => { if (type !== 1 /* Answer */) cb(); },
      obj.leaves.map((l) => `${l.addr}:_online.._value`), false);
    return () => winccoa.dpDisconnect(cid);
  }

  function objectRecord(o, includeMetadata) {
    const rec = { elementId: o.elementId, displayName: o.displayName, typeElementId: o.typeElementId, parentId: o.parentId, isComposition: o.isComposition, isExtended: false };
    if (!includeMetadata) return rec;
    if (!o.meta) {
      const q = o.addr || `${o.elementId}.`;
      const safe = (fn) => { try { return str(fn()); } catch { return ''; } };
      o.meta = {
        description: safe(() => winccoa.dpGetDescription(q)),
        typeNamespaceUri: nsUri, sourceTypeId: o.dpt,
        relationships: { HasParent: o.parentId ? [o.parentId] : [], HasChildren: o.children.map((c) => c.elementId) },
        schemaExtensions: {},
        system: { dpType: o.dpt, elementType: o.kind, address: o.addr, unit: o.addr ? safe(() => winccoa.dpGetUnit(q)) : '', format: o.addr ? safe(() => winccoa.dpGetFormat(q)) : '' }
      };
    }
    rec.metadata = o.meta;
    return rec;
  }

  return {
    namespaces: () => [{ uri: nsUri, displayName: `WinCC OA ${sys}` }],
    objectTypes: () => [...m().types.values()],
    relationshipTypes: () => REL.map(([id, rev]) => ({ elementId: id, displayName: id, namespaceUri: nsUri, relationshipId: id, reverseOf: rev })),
    objects: () => m().list,
    getObject: (id) => m().objects.get(id),
    objectRecord,
    related(o, rel) {
      const out = [];
      if (!rel || CHILD_REL.has(rel)) out.push(...o.children.map((c) => [rel || 'HasChildren', c]));
      if (o.parentId && (!rel || PARENT_REL.has(rel))) out.push([rel || 'HasParent', m().objects.get(o.parentId)]);
      return out;
    },
    readValues, history, write, watch,
    refresh: () => { model = null; }
  };
}

module.exports = { createOaBackend, toJson, kindOf };
