# WinCC OA i3X Manager

> Developed by BlocIoT for educational purposes. Provided as-is, without warranty.
> Conduct your own tests before deploying this manager in a production environment.

A WinCC OA JavaScript manager that exposes PARA data (DP types, DPs, DPEs, values, history,
writes, subscriptions) over the [CESMII i3X 1.0 REST API](https://www.i3x.dev/).
No npm dependencies; Node 18.17+ (WinCC OA 3.21 ships Node 22).

Conformance: **Full 1.0 Compliance** against `cesmii/i3X` conformance-tests (commit 97027a5)
using the bundled mock backend.

## Layout

| File | Purpose |
|------|---------|
| `index.js` | Entry point: config, OA addon, server start |
| `lib/oa-backend.js` | WinCC OA model/value/history/write/subscribe mapping |
| `lib/i3x-server.js` | Protocol layer: routes, envelopes, gzip, auth, subscriptions, SSE |
| `dev/mock-winccoa.js` | Fake addon for running outside OA (`I3X_MOCK=1`) |
| `test.js` | Self-check (`npm test`) |

## Deploy into a project (example: BlocSim_OA)

1. Copy this folder to `<project>/javascript/i3x-manager`
   (e.g. `C:\WinCC_OA_Proj\BlocSim_OA\javascript\i3x-manager`).
2. Add a manager. Either in the Console: *Append manager* → **JavaScript Manager**,
   option `i3x-manager/index.js`; or append to `<project>/config/progs`:

   ```
   node | manual | 30 | 3 | 1 | i3x-manager/index.js
   ```

   Set start mode to `always` once you are happy with it.
3. Optional settings: create `i3x-manager/config.json` or set env vars on the manager
   (env vars win).

   | config.json | env | default | meaning |
   |-------------|-----|---------|---------|
   | `port` | `I3X_PORT` | `8089` | listen port |
   | `host` | `I3X_HOST` | `0.0.0.0` | bind address |
   | `token` | `I3X_TOKEN` | *(none)* | if set, all endpoints except `GET /info` need `Authorization: Bearer <token>` |
   | `tlsCert`,`tlsKey` | `I3X_TLS_CERT`,`I3X_TLS_KEY` | *(none)* | PEM files; enables HTTPS |
   | `readOnly` | `I3X_READONLY` | `0` | `1` disables PUT value/history (advertised as 501) |
   | `dpPattern` | `I3X_DP_PATTERN` | `*` | `dpNames` pattern limiting exposed DPs |
   | `includeInternal` | `I3X_INCLUDE_INTERNAL` | `0` | `1` also exposes `_`-prefixed internal DPs/DPTs |
   | `modelTtlMs` | `I3X_MODEL_TTL_MS` | `30000` | model cache lifetime (new DPs show up after this) |
   | `subTtlMs` | `I3X_SUB_TTL_MS` | `3600000` | idle subscription expiry |

   For production set a token and TLS: the i3X implementation guide requires both.

4. Start the manager and check the log: `i3X API listening on http://0.0.0.0:8089/v1`.

## Try it

```sh
B=http://localhost:8089/v1
curl $B/info
curl $B/objecttypes
curl "$B/objects?typeId=dpt:ExampleDP_Float"
curl -X POST $B/objects/value -H 'content-type: application/json' \
     -d '{"elementIds":["System1:ExampleDP_Arg1"]}'
curl -X PUT $B/objects/value -H 'content-type: application/json' \
     -d '{"updates":[{"elementId":"System1:ExampleDP_Arg1","value":{"value":12.5}}]}'
curl -X POST $B/objects/history -H 'content-type: application/json' \
     -d '{"elementIds":["System1:ExampleDP_Arg1"],"startTime":"2026-10-14T00:00:00Z","endTime":"2026-10-15T00:00:00Z"}'
```

## Mapping

| i3X | WinCC OA |
|-----|----------|
| namespace | `urn:winccoa:<System>` |
| object type | `dpt:<DPT>`; typeref structs `dpt:<refName>`; anonymous inner structs `dpt:<DPT>/<path>`; leaves `elt:<Kind>` |
| object | `System1:Dp` (DP) or `System1:Dp.a.b` (DPE); `isComposition` for structs |
| relationships | `HasParent/HasChildren`, `HasComponent/ComponentOf` |
| value | `_online.._value`, timestamp `_stime`, quality `Uncertain` if `_invalid`, `GoodNoData` if null |
| composition value | nested object of children; timestamp = newest child |
| history | `dpGetPeriod` per leaf; compositions return `values: []` plus per-leaf `components` |
| write | `dpSetWait` on `_original.._value`; historical write uses `dpSetTimedWait` (also updates the online value) |
| subscription | one `dpConnect` per registered element, 50 ms debounce, batches capped at 1000 (206 on overflow) |

## Develop without OA

```sh
I3X_MOCK=1 node index.js
npm test
# conformance
cd C:/MosData/Code_Proj/i3X/conformance-tests
node bin/i3x-test.js run http://localhost:8089/v1   # add --token t when I3X_TOKEN is set
```

## Known limits (deliberate)

- No pagination on `GET /objects`; the whole model is cached and rebuilt every `modelTtlMs`.
- Composition history is per-leaf series, not aligned struct snapshots.
- Historical writes go through `dpSetTimedWait`, so the online value changes too.
- Alert/DPE config attributes are not exposed; only `_online` values.
