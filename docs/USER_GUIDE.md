# User Guide: Exposing WinCC OA Data over i3X

This guide walks a WinCC OA engineer through adding the i3X manager to an existing project,
checking it with an i3X client, and configuring it for a secured deployment.

> Developed by BlocIoT for educational purposes and provided as-is. Conduct your own tests
> before deploying in a production environment.

Contents

1. [What is i3X](#1-what-is-i3x)
2. [Prerequisites](#2-prerequisites)
3. [Install the manager](#3-install-the-manager)
4. [First check](#4-first-check)
5. [Configuration](#5-configuration)
6. [Security](#6-security)
7. [How your PARA data appears in i3X](#7-how-your-para-data-appears-in-i3x)
8. [Using the API](#8-using-the-api)
9. [Running the conformance suite](#9-running-the-conformance-suite)
10. [Troubleshooting](#10-troubleshooting)
11. [Known limits](#11-known-limits)

---

## 1. What is i3X

i3X (Industrial Information Interoperability eXchange) is an open REST API specification
from CESMII for contextualised manufacturing information. A server exposes:

- **Namespaces** and **Object Types** (what kinds of things exist, with a JSON Schema each)
- **Objects** (instances) and the **relationships** between them
- **Values** (current and historical), **writes**, and **subscriptions** (polling or
  Server-Sent Events)

This manager turns a WinCC OA system into such a server. Clients such as the i3X Explorer,
MES/analytics tools or your own scripts can then discover and read your data points without
knowing anything about WinCC OA.

## 2. Prerequisites

| Requirement | Notes |
|-------------|-------|
| WinCC OA 3.20 or newer | Tested on 3.21. The JavaScript manager and `winccoa-manager` addon ship with the product. |
| Node.js | Bundled with WinCC OA; nothing to install. |
| A running project | Event and Data managers must be up. |
| Network | One free TCP port (default 8089) reachable by your clients. |

No npm packages are required.

## 3. Install the manager

### 3.1 Copy the files

Copy the `i3x-manager` folder from this repository into the `javascript` folder of your
project:

```
<project>/javascript/i3x-manager/
    index.js
    package.json
    lib/i3x-server.js
    lib/oa-backend.js
    dev/mock-winccoa.js
    test.js
```

Example for a project in `C:\WinCC_OA_Proj\MyProject`:

```
C:\WinCC_OA_Proj\MyProject\javascript\i3x-manager\
```

### 3.2 Add the manager to the project

**Option A - WinCC OA Console (recommended)**

1. Open the Console and click *Append a new manager*.
2. Manager: **JavaScript Manager** (`node`).
3. Start mode: `manual` for the first test, `always` later.
4. Options: `i3x-manager/index.js`
5. Confirm and start the manager.

**Option B - edit `config/progs`**

Append this line (script path is relative to `<project>/javascript`):

```
node | always | 30 | 3 | 1 | i3x-manager/index.js
```

Restart the project or start the new manager from the Console.

### 3.3 Manager number

If the project already runs other JavaScript managers, give each one a distinct `-num`
option as you would for any manager, for example `-num 2 i3x-manager/index.js`.

## 4. First check

When the manager starts, its log shows:

```
i3X model: 142 types, 2381 objects (38 ms)
i3X API listening on http://0.0.0.0:8089/v1 (no auth)
```

From any machine that can reach the host:

```sh
curl http://<host>:8089/v1/info
```

```json
{
  "success": true,
  "result": {
    "specVersion": "1.0",
    "serverName": "WinCC OA i3X Manager (System1)",
    "capabilities": { "query": { "history": true }, "update": { "current": true, "history": true }, "subscribe": { "stream": true } }
  }
}
```

Then open an i3X client (for example the i3X Explorer from https://www.i3x.dev/) and point
it at `http://<host>:8089/v1`.

## 5. Configuration

Settings come from an optional `config.json` placed next to `index.js`, and can be overridden
by environment variables set on the manager. Environment variables win.

| config.json key | Environment variable | Default | Meaning |
|-----------------|----------------------|---------|---------|
| `port` | `I3X_PORT` | `8089` | TCP port to listen on |
| `host` | `I3X_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost. |
| `token` | `I3X_TOKEN` | *(none)* | Bearer token. When set, every endpoint except `GET /info` requires `Authorization: Bearer <token>`. |
| `tlsCert`, `tlsKey` | `I3X_TLS_CERT`, `I3X_TLS_KEY` | *(none)* | Paths to PEM certificate and key. Both set enables HTTPS. |
| `readOnly` | `I3X_READONLY` | `0` | `1` disables `PUT /objects/value` and `PUT /objects/history` and advertises them as unsupported. |
| `dpPattern` | `I3X_DP_PATTERN` | `*` | `dpNames` pattern restricting which data points are exposed, e.g. `Plant1_*`. |
| `includeInternal` | `I3X_INCLUDE_INTERNAL` | `0` | `1` also exposes internal data points and types whose names begin with `_` (master DPs, `_Managers`, ...). |
| `modelTtlMs` | `I3X_MODEL_TTL_MS` | `30000` | How often the type/object model is rebuilt. New DPs appear after at most this delay. |
| `subTtlMs` | `I3X_SUB_TTL_MS` | `3600000` | Idle time after which a subscription is dropped. |

Example `config.json`:

```json
{
  "port": 8443,
  "token": "change-me",
  "tlsCert": "C:/certs/oa-i3x.crt",
  "tlsKey": "C:/certs/oa-i3x.key",
  "readOnly": true,
  "dpPattern": "Plant1_*"
}
```

Setting environment variables for one manager in the Console is not possible directly; use
`config.json`, or set the variables system-wide / in the Pmon service environment.

## 6. Security

The i3X implementation guide requires HTTPS and authentication in production. The manager
supports both; the defaults are open for easy first tests.

Recommended production baseline:

1. **Read-only** unless clients really need to write: `"readOnly": true`.
2. **Bearer token**: `"token": "<long random string>"`. Generate one, for example
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. **TLS**: provide a certificate and key. You can reuse the certificate of the WinCC OA
   HTTP server or issue one from your PKI.
4. **Scope** the exposed data with `dpPattern` and keep `includeInternal` off.
5. **Bind** to an internal interface and firewall the port.

Writes go through the normal `dpSet` path with the rights of the JavaScript manager's user.
If you enable writes, make sure that user has only the permissions you intend.

The manager raises a WinCC OA `PortOpened` security event at start, so the opened port shows
up in the system's security log.

## 7. How your PARA data appears in i3X

Everything is discovered at runtime from the running system. Nothing is project specific.

### Types (Namespaces view)

| WinCC OA | i3X object type | Example |
|----------|-----------------|---------|
| Data point type | `dpt:<DPT>` | `dpt:ANALOG1` |
| Struct element with a type reference | `dpt:<refName>` | `dpt:Motor` |
| Anonymous struct element | `dpt:<DPT>/<path>` | `dpt:ANALOG1/C1` |
| Leaf element kind | `elt:<Kind>` | `elt:Float`, `elt:Bool`, `elt:String` |

Every type carries a JSON Schema. A struct type lists its children as properties; leaf kinds
map to `number`, `boolean`, `string`, arrays for `dyn_*`, and `date-time` strings for `time`.

### Objects (Objects and Hierarchy views)

| WinCC OA | i3X object | `isComposition` |
|----------|------------|-----------------|
| Data point | `System1:TT101` | true if the DPT is a struct |
| Struct element | `System1:TT101.C1` | true |
| Leaf element | `System1:TT101.C1.AVG_WT0` | false |

The hierarchy follows PARA: data point, then struct elements, then leaves. Relationships
`HasParent`/`HasChildren` and `HasComponent`/`ComponentOf` are available.

Things to be aware of:

- Type nodes appear only in the Namespaces view. The Hierarchy and Objects views list
  **instances**. A data point type with no data point has nothing to show there.
- Master data points (`_mp_<DPT>`) start with an underscore and are hidden unless
  `includeInternal` is on.
- Config attributes such as `_common`, `_lock`, `_archive` are not elements and are not
  exposed. Values are read from `_online.._value`.

### Values

| i3X field | WinCC OA source |
|-----------|-----------------|
| `value` | `_online.._value`; compositions return a nested object of their children |
| `timestamp` | `_online.._stime`; compositions use the newest child |
| `quality` | `Uncertain` if `_online.._invalid`, `GoodNoData` for null, otherwise `Good` |

History comes from `dpGetPeriod`, so an element must have an archive config (`_archive`) to
return historical values.

## 8. Using the API

Base URL: `http://<host>:8089/v1`. All responses are JSON. Add
`-H "Authorization: Bearer <token>"` when a token is configured.

Browse:

```sh
curl $B/namespaces
curl $B/objecttypes
curl "$B/objects?root=true"
curl "$B/objects?typeElementId=dpt:ANALOG1"
curl -X POST $B/objects/related -H 'content-type: application/json' \
     -d '{"elementIds":["System1:TT101"],"relationshipType":"HasChildren"}'
```

Read current values (a composition with all descendants):

```sh
curl -X POST $B/objects/value -H 'content-type: application/json' \
     -d '{"elementIds":["System1:TT101"],"maxDepth":0}'
```

Read history:

```sh
curl -X POST $B/objects/history -H 'content-type: application/json' \
     -d '{"elementIds":["System1:TT101.value"],"startTime":"2026-10-14T00:00:00Z","endTime":"2026-10-15T00:00:00Z"}'
```

Write (if not read-only):

```sh
curl -X PUT $B/objects/value -H 'content-type: application/json' \
     -d '{"updates":[{"elementId":"System1:TT101.value","value":{"value":12.5}}]}'
```

Subscribe and stream (Server-Sent Events):

```sh
curl -X POST $B/subscriptions -H 'content-type: application/json' \
     -d '{"clientId":"demo","displayName":"demo"}'
# -> {"result":{"subscriptionId":"..."}}
curl -X POST $B/subscriptions/register -H 'content-type: application/json' \
     -d '{"clientId":"demo","subscriptionId":"<id>","elementIds":["System1:TT101.value"]}'
curl -N -X POST $B/subscriptions/stream -H 'content-type: application/json' \
     -d '{"clientId":"demo","subscriptionId":"<id>"}'
```

Polling clients use `POST /subscriptions/sync` with `lastSequenceNumber` to acknowledge
batches. See the i3X specification for the complete request and response formats.

## 9. Running the conformance suite

```sh
git clone https://github.com/cesmii/i3X
cd i3X/conformance-tests
node bin/i3x-test.js run http://<host>:8089/v1            # add --token <t> if configured
node bin/i3x-test.js run http://<host>:8089/v1 --no-writes # do not touch DP values
node bin/i3x-test.js serve                                 # web dashboard on http://localhost:8330
```

The suite writes test values to real data points unless `--no-writes` is given. Run it
against a test system.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Manager stops immediately, log says `Cannot find module 'winccoa-manager'` | The script is not running inside a WinCC OA JavaScript manager, or the path in the manager options is wrong. The option must be relative to `<project>/javascript`. |
| `EADDRINUSE` in the log | Port already in use. Change `port`. |
| `/v1/info` works but other calls return 401 | A token is configured. Send `Authorization: Bearer <token>`. |
| A new data point does not appear | Wait up to `modelTtlMs` (30 s by default). |
| A data point type shows no instances | Only master DPs (`_mp_*`) exist for that type. Create a real DP or enable `includeInternal`. |
| History is empty | The element has no archive config, or the time window is outside the archived range. |
| Writes return 501 | `readOnly` is enabled. |
| Values stop updating in a subscription | The subscription expired after `subTtlMs` idle. Create a new one. |

## 11. Known limits

These are deliberate simplifications; extend them if your use case requires.

- `GET /objects` returns the whole address space without pagination. Fine for tens of
  thousands of elements; filter with `dpPattern` on very large systems.
- Composition history returns the per-leaf series under `components`; there are no
  time-aligned struct snapshots.
- `PUT /objects/history` uses `dpSetTimedWait`, which also updates the online value.
- Only `_online` values are exposed. Alert handling, DPE configs and user bits are not.
- Writes go through the normal `dpSet` path, so the model's value conversion assumes the
  DPE kinds documented above; exotic types fall back to string.
