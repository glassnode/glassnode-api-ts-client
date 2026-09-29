# Glassnode API — TypeScript Client

[![npm version](https://img.shields.io/npm/v/glassnode-api.svg)](https://www.npmjs.com/package/glassnode-api)
[![npm downloads](https://img.shields.io/npm/dm/glassnode-api.svg)](https://www.npmjs.com/package/glassnode-api)
[![minzipped size](https://img.shields.io/bundlejs/size/glassnode-api)](https://bundlejs.com/?q=glassnode-api)
[![types included](https://img.shields.io/npm/types/glassnode-api.svg)](https://www.npmjs.com/package/glassnode-api)
[![CI](https://github.com/glassnode/glassnode-api-ts-client/actions/workflows/ci.yml/badge.svg)](https://github.com/glassnode/glassnode-api-ts-client/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/glassnode-api.svg)](./LICENSE)

A fully-typed **TypeScript client for the [Glassnode API](https://docs.glassnode.com/)** — on-chain and
market data for Bitcoin, Ethereum, and hundreds of crypto assets. Responses are runtime-validated with
[Zod](https://zod.dev/). It runs in **Node.js** and ships **browser** bundles (see
[Browser](#browser) for the CORS limits of calling Glassnode directly from a web page).

```typescript
import { GlassnodeAPI } from 'glassnode-api';

const api = new GlassnodeAPI({ apiKey: 'YOUR_API_KEY' });
const btcPrice = await api.callMetric('/market/price_usd_close', { a: 'BTC' });
```

Originally created by [Jordi Planadecursach](https://github.com/planadecu).

## Features

- 🧩 **Fully typed** — complete TypeScript definitions for every request and response
- ✅ **Runtime-validated** — responses parsed and validated with Zod, so bad data fails fast
- 🌐 **Universal** — Node.js (CJS + ESM) plus browser bundles (UMD + ESM); in web pages Glassnode's
  CORS policy applies — see [Browser](#browser)
- 🔁 **Built-in retries** — opt-in retry with exponential backoff and jitter for `429`, `5xx`,
  network failures and timeouts (honouring `Retry-After`)
- ⏹️ **Cancellable** — per-call `AbortSignal` and `timeout` on every method
- 📦 **Bulk endpoints** — fetch every asset in a single call with `callBulkMetric()`
- 🎯 **Typed errors** — every failure is a `GlassnodeError`; subclasses for HTTP, network/timeout,
  cancellation, response-validation, input, config and x402 payment errors
- 🪶 **Lightweight** — a single runtime dependency (`zod`)
- 🔌 **Pluggable** — inject a custom `fetch` implementation, a `logger` and structured
  [observability hooks](#observability) for metrics and tracing

## Table of Contents

- [API reference](https://glassnode.github.io/glassnode-api-ts-client/) (every export, generated
  from the source with TypeDoc)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Methods](#methods)
- [Query parameters](#query-parameters)
- [Validating `callMetric` results](#validating-callmetric-results)
- [Timestamps](#timestamps)
- [Error Handling](#error-handling)
- [Retries](#retries)
- [Cancellation and per-call timeouts](#cancellation-and-per-call-timeouts)
- [Observability](#observability)
- [Bulk Metrics](#bulk-metrics)
- [Paid calls with x402](#paid-calls-with-x402)
- [Browser](#browser)
- [Examples](#examples)
- [Development](#development)
- [License](#license)

## Installation

```bash
# pnpm
pnpm add glassnode-api

# npm
npm install glassnode-api

# yarn
yarn add glassnode-api
```

Requires Node.js >= 18 (it uses the global `fetch`), or a browser — see [Browser](#browser).
You'll need a Glassnode API key — create one from your
[Glassnode account](https://studio.glassnode.com/).

## Quick Start

```typescript
import { GlassnodeAPI } from 'glassnode-api';

const api = new GlassnodeAPI({
  apiKey: 'YOUR_API_KEY',
  // apiUrl: 'https://api.glassnode.com', // optional override
});

// Fetch metadata for all supported assets
const assets = await api.getAssetMetadata();

// Fetch metadata for a specific metric
const metric = await api.getMetricMetadata('/distribution/balance_exchanges', { a: 'BTC' });

// List every available metric path
const metrics = await api.getMetricList();

// Inspect a metric's current data lag (percentiles over the past 30d)
const stats = await api.getMetricStats('/institutions/us_spot_etf_balances_all');

// Call any metric endpoint directly
const data = await api.callMetric('/market/price_usd_close', {
  a: 'BTC',
  s: 1609459200, // since, unix seconds — or a Date: new Date('2021-01-01')
  i: '24h',
});
```

## Configuration

`new GlassnodeAPI(config)`

| Option           | Type                                            | Default                     | Description                                                                                                   |
| ---------------- | ----------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `apiKey`         | `string`                                        | — (required unless `x402`)  | Your Glassnode API key (non-empty)                                                                            |
| `apiUrl`         | `string` (URL)                                  | `https://api.glassnode.com` | Base URL for the API; with `x402` the default is `https://x402.glassnode.com` (an explicit value wins)        |
| `apiKeyLocation` | `'query' \| 'header'`                           | `'query'`                   | Send the key as the `api_key` query parameter or the `X-Api-Key` header (server-side only; see below)         |
| `x402`           | `boolean`                                       | `false`                     | Route through the paid x402 endpoint (see [Paid calls with x402](#paid-calls-with-x402))                      |
| `logger`         | `(message: string, ...args: unknown[]) => void` | —                           | Callback for debug logging (e.g. `console.log`); its failures are ignored                                     |
| `hooks`          | `GlassnodeHooks`                                | —                           | Structured `onRequest` / `onResponse` / `onRetry` / `onError` callbacks (see [Observability](#observability)) |
| `fetch`          | `GlassnodeFetch`                                | `globalThis.fetch`          | Custom fetch implementation (or an x402-wrapped fetch); required with `x402`                                  |
| `maxRetries`     | `number`                                        | `2` (`0` with `x402`)       | Retries for retryable failures (`429`, `5xx`, network errors, timeouts); a non-negative integer; `0` disables |
| `retryDelay`     | `number`                                        | `1000`                      | Base retry delay in ms (doubles each attempt, then full jitter)                                               |
| `maxRetryDelay`  | `number`                                        | `30000`                     | Upper bound in ms for a single retry wait (also caps a `Retry-After`)                                         |
| `timeout`        | `number`                                        | — (no timeout)              | Per-attempt timeout in ms; each attempt aborts via `AbortSignal.timeout()`                                    |

The config is validated at construction time — an invalid config throws a `GlassnodeConfigError`
immediately (e.g. an empty `apiKey`, a non-URL `apiUrl`, a misspelled hook name, or a
`timeout`/`retryDelay`/`maxRetryDelay` that is not a positive integer up to `2147483647` ms, the
largest timer delay). When `x402` is enabled, `apiKey` is optional but a payment-capable `fetch` is
required. A non-2xx response rejects with a `GlassnodeApiError` whose message includes the server's
error detail (also on `.detail`); see [Error Handling](#error-handling) for every failure type.

`GlassnodeFetch` is `(input: string, init?: RequestInit) => Promise<Response>`: the client only
calls a custom `fetch` with a string URL, as `fetch(url)` or `fetch(url, init)`. So
`globalThis.fetch`, `vi.fn()` mocks, the fetch from `createX402Fetch()` and string-only custom
fetches (`async (url: string, init?: RequestInit) => …`) all type-check.

### Keeping the API key out of URLs

By default the key is sent as the `api_key` query parameter, so it is part of every request URL —
visible to a custom `fetch`, tracing/instrumentation, proxies and access logs, and to any transport
error that quotes the URL. (The client's own `logger` output, hook events and error messages
always mask it.) On a server, set `apiKeyLocation: 'header'` to send it as the `X-Api-Key` header instead; the URL
then carries no key at all:

```typescript
const api = new GlassnodeAPI({ apiKey: process.env.GLASSNODE_API_KEY, apiKeyLocation: 'header' });
```

With `'header'`, a custom `fetch` is called as
`fetch(url, { headers: { 'X-Api-Key': key }, redirect: 'manual' })` (plus `signal` when a `timeout`
or a per-call `signal` is set) and must forward `init.headers` — the fetch returned by
`createX402Fetch()` does. No header is sent when there is no `apiKey` (e.g. `x402` mode).

**Redirects are not followed with `'header'`.** Node's `fetch` (undici), with its default
`redirect: 'follow'`, resends custom request headers such as `X-Api-Key` to whatever origin a
`3xx` `Location` names — including an `https` → `http` downgrade; only `Authorization`-style headers
are dropped on a cross-origin hop. So the client sends `redirect: 'manual'` along with the header,
and a `3xx` answer surfaces as a `GlassnodeApiError` with that status (not retried; its message
never contains the key or the `Location`). Point `apiUrl` at the final URL instead of relying on a
redirect. A custom `fetch` should honour `init.redirect` (or not follow redirects at all). With the
default `'query'`, redirects are still followed and the call shape is unchanged (`fetch(url)`):
fetch adds nothing to the redirected request, which goes to the URL the server's `Location` names —
only a server that already received the key can put it there.

`'header'` does **not** work in browsers: a custom header triggers a CORS preflight, and the
Glassnode API's `Access-Control-Allow-Headers` does not list `X-Api-Key`, so the browser blocks the
request. That is why `'query'` stays the default.

## Methods

| Method                                       | Returns                           | Description                                       |
| -------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| `getAssetMetadata(options?)`                 | `Promise<AssetMetadataResponse>`  | Metadata for all supported assets                 |
| `getMetricMetadata(path, params?, options?)` | `Promise<MetricMetadataResponse>` | Metadata for a specific metric                    |
| `getMetricList(options?)`                    | `Promise<MetricListResponse>`     | List of all available metric paths                |
| `getMetricStats(path, params?, options?)`    | `Promise<MetricStatsResponse>`    | Data-lag percentiles for a metric (trailing 30d)  |
| `callMetric<T>(path, params?, options?)`     | `Promise<T>`                      | Call any metric endpoint directly (unvalidated)   |
| `callMetric(path, params, { schema })`       | `Promise<z.output<schema>>`       | Call any metric endpoint, validated by `schema`   |
| `callBulkMetric(path, params?, options?)`    | `Promise<BulkResponse>`           | Call a bulk endpoint (all assets in one response) |

`options` is an optional `CallOptions` object, `{ signal?: AbortSignal; timeout?: number }`, to
cancel the call or give it its own per-attempt timeout — see
[Cancellation and per-call timeouts](#cancellation-and-per-call-timeouts). To pass `options`
without query parameters, use `undefined` (or `{}`) for `params`.

All response types (and their Zod schemas, e.g. `AssetMetadataResponseSchema`) are exported and
fully typed. `getMetricStats` percentiles are durations in seconds, not timestamps — see
[Timestamps](#timestamps).

Arguments are checked before any request is sent; invalid input rejects with a
`GlassnodeInputError` and no network call is made:

- **Metric paths** (`path` in every method above) must look like `/market/price_usd_close`: a
  leading `/`, and one or more non-empty segments of letters, digits, `_`, `-` and `.`. The client
  never rewrites a path — a missing leading slash, whitespace, `//` or a trailing `/`, `.`/`..`
  segments, a query string (`/market/price_usd_close?a=BTC`) or a full URL are all rejected
  (a missing slash gets a "did you mean" hint). Pass query parameters via `params`.
- **Parameter values** must be a string, finite number, boolean or valid `Date`, or a non-empty
  array of those for a repeated parameter (see [Query parameters](#query-parameters)); `null`,
  `NaN`/`Infinity`, unsafe integers, an invalid `Date`, objects, empty or nested arrays, arrays
  with `undefined`/`null` elements and arrays for the single-valued `s`, `u`, `i`, `c` and `f` are
  rejected (`argument` is `params.<name>`), and `params` itself must be an object.
- **Parameters the client sets itself** cannot be overridden: `api_key` is always rejected (set
  `apiKey` in the config), `f` is rejected unless it is `json` (case-insensitive) in
  `callMetric`, `callBulkMetric`, `getMetricMetadata` and `getMetricStats` (the client only parses
  JSON), and `path` is rejected in `getMetricMetadata`/`getMetricStats` (it comes from the `path`
  argument).
- **Per-call options** must be an object; `signal` must be an `AbortSignal` and `timeout` a
  positive integer number of ms up to `2147483647` (`argument` is `options`, `options.signal` or
  `options.timeout`). `callMetric`'s `schema` must be a Zod schema (`argument` `options.schema`).

## Query parameters

`params` (the second argument of `callMetric`, `callBulkMetric`, `getMetricMetadata` and
`getMetricStats`) is typed as `MetricParams`. The common Glassnode parameters are typed; any other
parameter a metric documents can be passed as well:

| Param  | Type                                     | Meaning                                                      |
| ------ | ---------------------------------------- | ------------------------------------------------------------ |
| `a`    | `string \| string[]`                     | Asset, e.g. `'BTC'` (`'*'` for all assets on bulk endpoints) |
| `s`    | `number \| string \| Date`               | Since — start of the range, unix **seconds**                 |
| `u`    | `number \| string \| Date`               | Until — end of the range, unix **seconds**                   |
| `i`    | `string`                                 | Interval, e.g. `'10m'`, `'1h'`, `'24h'`, `'1w'`, `'1month'`  |
| `c`    | `string`                                 | Currency, e.g. `'native'`, `'usd'`                           |
| `e`    | `string \| string[]`                     | Exchange, e.g. `'binance'`                                   |
| others | `MetricParamValue \| MetricParamValue[]` | `string \| number \| boolean \| Date`, or an array of them   |

Values are converted to query-string text before the request:

- **string** — sent unchanged (so existing string params produce exactly the same URLs).
- **number** — its shortest round-trip decimal form, independent of locale (`1609459200`, `0.1`;
  `-0` → `0`). `NaN`, `±Infinity`, integers beyond `Number.MAX_SAFE_INTEGER` and numbers that would
  print in exponent notation (e.g. `1e-7`) are rejected — pass those as a string.
- **boolean** — `'true'` / `'false'`.
- **Date** — unix **seconds**, floored to the whole second (milliseconds are dropped:
  `2021-01-01T00:00:00.999Z` → `1609459200`). An invalid `Date` is rejected.
- **undefined** — the parameter is omitted, so optional values can be passed directly
  (`{ a: 'BTC', s: since }` with `since?: number`). `null` is rejected.
- **array** — the parameter is sent **repeated**, once per element, in order:
  `{ a: ['BTC', 'ETH'] }` → `a=BTC&a=ETH`. This is how Glassnode takes several values for one
  parameter (e.g. an asset or exchange whitelist on bulk endpoints); a comma-joined string
  (`'BTC,ETH'`) is **not** equivalent — it is sent as one value, `a=BTC%2CETH`. Each element is
  converted like a single value. An empty array is rejected (omit the parameter instead), as are
  `undefined`/`null`/array/object elements and arrays for the single-valued `s`, `u`, `i`, `c`
  and `f`. `readonly` arrays are accepted.

Numbers are sent as-is: pass `s`/`u` in **seconds** (not `Date.now()` milliseconds) — or pass a
`Date` and let the client convert it.

```typescript
const oneWeekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
const recent = await api.callMetric('/market/price_usd_close', {
  a: 'BTC',
  s: oneWeekAgo,
  i: '1h',
});
```

Repeated parameters — e.g. market caps of just BTC and ETH from the bulk endpoint:

```typescript
// GET /v1/metrics/market/marketcap_usd/bulk?a=BTC&a=ETH&s=…&f=json
const btcAndEth = await api.callBulkMetric('/market/marketcap_usd', {
  a: ['BTC', 'ETH'],
  s: oneWeekAgo,
});
```

## Validating `callMetric` results

Without a schema, `callMetric<T>()` returns the parsed JSON body **unvalidated** and simply cast to
`T`. Pass a Zod schema as `options.schema` to validate the body and get a result typed from the
schema; a mismatch rejects with a `GlassnodeValidationError` (with `endpoint`), like every other
method. Schemas for the two common shapes are exported:

| Schema                           | Type                       | Shape                                                            |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `TimeSeriesResponseSchema`       | `TimeSeriesResponse`       | `{ t: number; v: number \| null }[]` — most metrics              |
| `TimeSeriesObjectResponseSchema` | `TimeSeriesObjectResponse` | `{ t: number; o: Record<string, number \| null> }[]` — e.g. OHLC |

They are lenient towards additive changes: extra fields on a point are ignored (stripped), `o`
accepts any keys, and a `null` value is accepted rather than failing the whole series.

```typescript
import { TimeSeriesResponseSchema, TimeSeriesObjectResponseSchema } from 'glassnode-api';

const btc = { a: 'BTC' };

const closes = await api.callMetric('/market/price_usd_close', btc, {
  schema: TimeSeriesResponseSchema,
}); // TimeSeriesResponse
const candles = await api.callMetric('/market/price_usd_ohlc', btc, {
  schema: TimeSeriesObjectResponseSchema,
}); // candles[0].o.c is number | null
```

Metrics with other shapes (e.g. an array `v`) can use any Zod schema of your own — its output type
(transforms included) becomes the result type. `schema` sits alongside `signal` and `timeout`.

## Timestamps

The API sends every point in time (timestamp) as unix **seconds**, and the client passes them
through as plain `number`s:

| Field                                                  | Type                              |
| ------------------------------------------------------ | --------------------------------- |
| `MetricMetadata.modified`                              | `number \| undefined` (unix secs) |
| `MetricMetadata.timerange.min` / `.max`                | `number` (unix secs)              |
| `BulkResponse[number].t`                               | `number` (unix secs)              |
| `t` in `callMetric()` results (raw JSON, typed by you) | `number` (unix secs)              |
| `TimeSeriesPoint.t` / `TimeSeriesObjectPoint.t`        | `number` (unix secs)              |

Convert any unix-second value with `new Date(t * 1000)`:

```typescript
const [latest] = (await api.callBulkMetric('/market/marketcap_usd')).slice(-1);
const when = new Date(latest.t * 1000);
```

**Durations are not timestamps.** The data-lag percentiles from `getMetricStats()` —
`lag[n].resolution[interval].p50` / `.p90` / `.p95` / `.p99`, with `lag[n].unit` (`"seconds"`) —
are **lengths of time** (how far a metric's data trails behind), not points in time. Don't pass them
to `new Date(p * 1000)`; convert by their `unit` instead:

```typescript
const { lag } = await api.getMetricStats('/market/price_usd_close', { a: 'BTC' });
const p50 = lag[0]?.resolution['24h']?.p50; // e.g. 3600 (seconds of lag), or undefined
if (p50 !== undefined && lag[0]?.unit === 'seconds') console.log(`${p50 / 3600} h behind`);
```

## Error Handling

Every error the client throws is an instance of `GlassnodeError`, so a single `instanceof` check
catches all of them. Branch on the subclasses to tell the kinds of failure apart — no message
matching needed.

### Error types

| Class                      | Thrown when                                                                                                                                                                                                                                         | Useful properties                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GlassnodeError`           | Base class of all the errors below — catch this to handle any library failure                                                                                                                                                                       | `message`, `cause`                                                                                                                                                             |
| `GlassnodeApiError`        | The API answered with a non-2xx HTTP status (e.g. `401`, `404`, `429`, `5xx`, or a `3xx` not followed; with x402, only before a payment was sent, or `402` after it)                                                                                | `status`, `statusText`, `detail` (server message), `isRetryable` (429 / 5xx)                                                                                                   |
| `GlassnodeNetworkError`    | No HTTP response: connection/DNS failure (in a browser also a CORS block), or the per-attempt `timeout` firing. Retried unless `maxRetries` is `0`                                                                                                  | `timedOut` (`true` when `timeout` fired), `cause` (the original fetch error)                                                                                                   |
| `GlassnodeAbortError`      | The call was cancelled through the per-call `signal` (already aborted, or aborted mid-request or during a retry wait). Never retried                                                                                                                | `cause` (the signal's `reason`, e.g. a `DOMException` named `AbortError`, or `TimeoutError` for `AbortSignal.timeout()`)                                                       |
| `GlassnodeValidationError` | A `2xx` response was unusable: the body was not valid JSON, or did not match the expected schema (or `callMetric`'s `schema`). Never retried                                                                                                        | `endpoint` (API path, e.g. `/v1/metadata/assets`), `cause` (`ZodError` / `SyntaxError`)                                                                                        |
| `GlassnodeConfigError`     | The options passed to `new GlassnodeAPI(...)` are invalid (e.g. empty `apiKey`, `x402` without `fetch`, an unknown hook name), or `createX402Fetch` cannot load its optional peer dependencies                                                      | `message` (lists the invalid fields), `cause` (`ZodError` / import error)                                                                                                      |
| `GlassnodeInputError`      | A method argument is invalid (malformed metric path, a param value that cannot be sent, `f` other than `json`, `api_key`/`path` in `params`, bad per-call options or `schema`, a bad `maxPaymentPerCall`). Raised before any request; never retried | `argument` (`metricPath`, `params`, `params.<name>`, `options`, `options.signal`, `options.timeout`, `options.schema`; from the x402 helpers `maxPaymentPerCall` or `value`)   |
| `GlassnodePaymentError`    | x402 only: the payment could not be made (price above `maxPaymentPerCall`, signer failed, unusable `402`), or the paid request failed in transit or got a non-2xx status other than `402` after the payment was sent. Never retried                 | `paymentMayHaveSettled` (`true`: a payment was sent and may have been charged; do not blindly retry), `status` (HTTP status of the paid response, if any), `timedOut`, `cause` |

**The API key never appears in an error's `message`, `detail`, `statusText` or other string
properties.** Text that comes from outside the library — a server or proxy error body or status
text, a transport error, an x402/signer message, a schema-issue path — is masked before it goes
into an error: every `api_key=<value>` is replaced with `api_key=***`, and every raw (or
URL-encoded) copy of the configured key with `***`. Raw copies are only masked for keys of at
least 8 characters (real Glassnode keys are much longer), so a very short placeholder key cannot
blank out unrelated text; the `api_key=` form is always masked. `createX402Fetch()` masks the key
it finds on each request (its `api_key` query value or `X-Api-Key` header) the same way.
**`.cause` is not redacted**: it holds the original object (the fetch error, the `ZodError`, the
x402 library error) unchanged, and it may quote the request URL or the key — log `err.message`
rather than `err.cause` (or a serializer that walks `.cause`) wherever the key must not appear.

```typescript
import {
  GlassnodeAPI,
  GlassnodeError,
  GlassnodeApiError,
  GlassnodeNetworkError,
  GlassnodeAbortError,
  GlassnodeValidationError,
  GlassnodeInputError,
  GlassnodePaymentError,
} from 'glassnode-api';

try {
  await api.callMetric('/market/price_usd_close', { a: 'BTC' });
} catch (err) {
  if (err instanceof GlassnodeApiError) {
    console.error(err.status); // e.g. 401
    console.error(err.statusText); // e.g. "Unauthorized"
    console.error(err.isRetryable); // true for 429 / 5xx
    console.error(err.message); // "API request failed (401): Invalid or missing API key"
  } else if (err instanceof GlassnodeNetworkError) {
    console.error(err.timedOut ? 'request timed out' : 'network failure', err.cause);
  } else if (err instanceof GlassnodeAbortError) {
    // cancelled by your own signal (reason on err.cause) — usually nothing to report
  } else if (err instanceof GlassnodeValidationError) {
    console.error(`unexpected response from ${err.endpoint}`, err.cause);
  } else if (err instanceof GlassnodeInputError) {
    console.error(`bad ${err.argument}: ${err.message}`); // fix the call; nothing was sent
  } else if (err instanceof GlassnodePaymentError) {
    if (err.paymentMayHaveSettled) {
      // In transit (err.cause, err.timedOut) or an HTTP error (err.status, err.cause.detail).
      console.error('x402 paid request failed; payment may have settled:', err.message);
    } else {
      console.error('x402 payment not made:', err.message); // e.g. price above maxPaymentPerCall
    }
  } else if (err instanceof GlassnodeError) {
    // any other library error
  }
}
```

## Retries

Retries are on by default: a call is retried up to **2** times (`maxRetries: 2`, so up to 3
attempts) on rate limits (`429`), server errors (`5xx`) and transport failures — connection/DNS
errors and a per-attempt `timeout` firing (`GlassnodeNetworkError`). Every client call is a `GET`,
so a retry never repeats a side effect. Tune the count and delays, or pass `maxRetries: 0` to make
a single attempt:

```typescript
const api = new GlassnodeAPI({
  apiKey: 'YOUR_API_KEY',
  maxRetries: 3, // retry up to 3 times (default 2; 0 disables retries)
  retryDelay: 1000, // base delay; the cap grows 1s → 2s → 4s …
  maxRetryDelay: 30000, // cap a single wait at 30s (default)
});
```

Each retry wait is the exponential delay (`retryDelay * 2^(n-1)` before retry `n`) capped at
`maxRetryDelay`, then **full-jittered** (a random value between 0 and that cap) to avoid synchronised
retries across clients. When a retried `429`/`5xx` response carries a `Retry-After` header (seconds or
an HTTP date), that value is used for the next wait instead — capped at `maxRetryDelay`, not
jittered. A malformed `200` body is **not** retried (it isn't a transient error) — it fails
immediately with a `GlassnodeValidationError`.

Non-retryable errors (e.g. `401`, `404`, a caller abort, invalid input) fail immediately without
retrying. When every attempt fails, the call rejects with the last attempt's error.

With [x402](#paid-calls-with-x402) (`x402: true`), the default is `maxRetries: 0`: the client
cannot tell whether the `fetch` it was given refuses to retry after a payment was sent, and a bare
x402 wrapper would sign a **new** payment on each retry of a paid `5xx` or timeout. The fetch from
`createX402Fetch` does refuse, so with it you can opt in (e.g. `maxRetries: 2`): a connection
failure, timeout, `429` or `5xx` is then retried only while no payment has been sent. Once a signed
payment has gone out, a failure — whatever the HTTP status — is **never** retried; see
[Errors](#x402-errors) below.

## Cancellation and per-call timeouts

Every method takes an optional last argument, `options: { signal?: AbortSignal; timeout?: number }`
(the exported `CallOptions` type):

```typescript
const controller = new AbortController();
const pending = api.callMetric(
  '/market/price_usd_close',
  { a: 'BTC' },
  { signal: controller.signal }
);
controller.abort(); // e.g. the user navigated away

try {
  await pending;
} catch (err) {
  if (err instanceof GlassnodeAbortError) {
    // cancelled; err.cause is the signal's reason
  }
}

// A slow endpoint gets more time than the config `timeout`, per attempt:
await api.getMetricList({ timeout: 60_000 });

// A deadline for the whole call, retries and waits included:
await api.callMetric('/market/mvrv', { a: 'BTC' }, { signal: AbortSignal.timeout(10_000) });
```

- **`signal`** cancels the call: the in-flight request, any retry wait (the client does not sleep
  through a backoff after an abort) and every further retry. The call rejects with a
  **`GlassnodeAbortError`**, never retried, with the signal's `reason` on `.cause`. A signal that is
  already aborted rejects before any request is sent (after argument validation). A cancellation is
  not a `GlassnodeNetworkError`, so it is never confused with a timeout or a connection failure.
- **`timeout`** overrides the config `timeout` for this call, with the same meaning: each attempt is
  aborted after that many ms, and the failure is a retryable `GlassnodeNetworkError` with
  `timedOut: true`. For a limit on the whole call, pass `signal: AbortSignal.timeout(ms)` instead
  (or as well).
- Both together: each attempt aborts on whichever comes first. The client combines the two signals
  itself (`AbortSignal.any()` needs Node 20.3+) and removes its listeners from your signal after
  every attempt, so one long-lived signal can be reused across many calls.
- A custom `fetch` receives the signal as `init.signal` and must honor it for an in-flight request
  to be cancelled. With no signal and no timeout (per-call or config) and the key in the query
  string, a custom `fetch` is called with the URL alone: `fetch(url)`.
- **x402:** the signal reaches the x402 fetch. Aborting before a payment was sent rejects with
  `GlassnodeAbortError` (nothing paid). Aborting after the paid request went out rejects with the
  `GlassnodePaymentError` (`paymentMayHaveSettled: true`) instead, since the payment may have settled;
  it is never retried either. See [Errors](#x402-errors).

## Observability

The `logger` option gets two free-text debug lines: `logger('API call:', url)` before each attempt
(the URL with `api_key=***`) and `logger('Retry n/m after Xms')` before each retry wait. It is
called synchronously and never awaited, and a logger that throws or returns a rejected promise is
ignored — silently, since there is nowhere left to report it — so it never changes a call's result,
retries or error. For metrics, tracing or structured logs, pass `hooks` instead (or as well) — each
receives one structured event object:

```typescript
const api = new GlassnodeAPI({
  apiKey: process.env.GLASSNODE_API_KEY,
  maxRetries: 3,
  hooks: {
    onRequest: (e) =>
      console.debug('glassnode →', e.callId, e.endpoint, `${e.attempt}/${e.maxAttempts}`),
    // `histogram` stands for your metrics library (e.g. a prom-client Histogram)
    onResponse: (e) => histogram.observe({ endpoint: e.endpoint, status: e.status }, e.durationMs),
    onRetry: (e) =>
      console.warn(`retry #${e.attempt} (${e.reason}) in ${e.delayMs}ms`, e.error.message),
    onError: (e) => console.error('glassnode call failed', e.callId, e.error.name, e.status),
  },
});
```

| Hook         | When                                                        | Event fields (besides the shared ones)                                                           |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `onRequest`  | before each attempt is sent                                 | —                                                                                                |
| `onResponse` | an attempt got an HTTP response (any status)                | `status`, `ok`, `durationMs` (until the response headers)                                        |
| `onRetry`    | an attempt failed retryably, before the backoff wait        | `reason` (`'status'` \| `'network'` \| `'timeout'`), `status?`, `error`, `delayMs`, `durationMs` |
| `onError`    | once, when the call fails (abort and validation errors too) | `error` (the `GlassnodeError` the call rejects with), `status?`, `durationMs?`, `elapsedMs`      |

Every event has `callId` (shared by all attempts of one call, so concurrent calls can be told
apart), `method` (`'GET'`), `endpoint` (path only), `url` (with the key masked as `api_key=***`),
`attempt` (1-based; `onRetry` names the attempt that failed, `onError` the last one, `0` if the call
was cancelled before sending anything) and `maxAttempts` (`maxRetries + 1`). A successful call is
an `onResponse` with `ok: true` and no `onError`; a `200` whose body fails validation is followed by
`onError`. An invalid argument (`GlassnodeInputError`) fires no hook — nothing was sent.

- **Hooks never break a call.** They run synchronously and are never awaited — an `async` hook does
  not delay the request. A hook that throws or returns a rejected promise is ignored (reported to
  the `logger`, if set, as `Hook <name> failed:`) and changes neither the result nor the retries.
  Keep hooks cheap; hand slow work (exporting telemetry) off asynchronously.
- **No secrets in events.** The URL is redacted and no request or response headers are exposed — so
  neither the `X-Api-Key` header nor x402 payment headers or signatures. `error` is the same object
  the call rejects with: its `message` and other string fields are masked, but, as for any
  `GlassnodeError`, its `.cause` is the original error and is not.
- **Treat events as read-only.** Each hook call gets a fresh event object, but `event.error` (in
  `onError` and `onRetry`) is the **live** error object: in `onError` it is the very object the
  caller's `await` rejects with. The client does not freeze or copy it, so a hook that assigns to
  it (e.g. rewrites `error.message` or deletes `.cause`) changes what the caller sees. Copy what you
  need instead of mutating it.
- The `logger` output is unchanged by `hooks`.

## Bulk Metrics

`callBulkMetric()` returns a value for every asset at each timestamp in a single request — ideal for
snapshots across the whole market:

```typescript
const marketcaps = await api.callBulkMetric('/market/marketcap_usd');
// [{ t: 1609459200, bulk: [{ a: 'BTC', v: 600000000000 }, { a: 'ETH', v: 100000000000 }] }]
```

Pass the **base** metric path: `callBulkMetric()` appends `/bulk` itself. The bulk variant path the
metadata advertises (`refs.metric_variant.bulk`, e.g. `/market/marketcap_usd/bulk`) is rejected
with a `GlassnodeInputError` before any request.

An entry's `v` is `number | null`: it can be `null` for an asset without data at that timestamp,
and the rest of the response still parses. Handle it before doing arithmetic, e.g. `v ?? 0`, or
filter the nulls out:

```typescript
const withData = marketcaps[0].bulk.filter(
  (entry): entry is typeof entry & { v: number } => entry.v !== null
);
```

## Paid calls with x402

Glassnode also serves a **paid, per-call API over the [x402 protocol](https://x402.org)** at
`https://x402.glassnode.com` — no API key required, you pay per request in USDC on Base
($0.01/metadata call, $0.05/metric call). This is **Node-first** and opt-in: the crypto stack
(`@x402/fetch`, `@x402/evm`, `viem`) is an **optional peer dependency**, installed only if you use it.

```bash
pnpm add glassnode-api @x402/fetch @x402/evm viem
```

```typescript
import { GlassnodeAPI } from 'glassnode-api';
import { createX402Fetch } from 'glassnode-api/x402';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const api = new GlassnodeAPI({
  x402: true, // → https://x402.glassnode.com
  fetch: await createX402Fetch({
    account,
    maxPaymentPerCall: '0.06', // USDC per-call ceiling (default)
  }),
  // Optional: retries default to 0 with x402. Safe with createX402Fetch, which never retries once
  // a payment was sent (only unpaid attempts are retried).
  maxRetries: 2,
});

// Pays $0.05 USDC on Base, transparently:
const mvrv = await api.callMetric('/market/mvrv', { a: 'BTC', i: '24h' });
```

**`createX402Fetch(options)`**

| Option              | Type                | Default            | Description                                                                        |
| ------------------- | ------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `account`           | `X402SignerAccount` | — (**required**)   | Signer (`address` + `signTypedData`); a viem account such as `privateKeyToAccount` |
| `maxPaymentPerCall` | `string`            | `'0.06'`           | Per-call USDC spend ceiling, a decimal string (e.g. `'0.06'`)                      |
| `fetch`             | `typeof fetch`      | `globalThis.fetch` | Base fetch to wrap                                                                 |

It returns a `Promise<typeof fetch>` that signs payments for Base mainnet (`eip155:8453`) and Base
Sepolia (`eip155:84532`). `glassnode-api/x402` also exports the `X402FetchOptions` and
`X402SignerAccount` types and two helpers: `usdcDecimalToAtomic(value)` (USDC decimal string →
6-decimal atomic `bigint`) and `createMaxAmountPolicy(maxAtomic)` (the x402 payment policy that
enforces the ceiling).

> **Spend safety:** `maxPaymentPerCall` caps a **single** request — it is **not** a cumulative budget, so
> an agent loop can still spend within that ceiling repeatedly. Use a **dedicated, funded-but-limited**
> wallet (never your primary key), and load the key from the environment — never hardcode it.

<a id="x402-errors"></a>**Errors**

> **One call never pays twice.** Every attempt at a paid call signs a **new** payment (fresh nonce).
> So once a signed payment has been sent, the client never retries the call, whatever `maxRetries`
> is. If the paid request then fails in transit (connection reset, or `timeout` firing after it was
> sent) or is answered with an error status (e.g. a gateway `502`/`504` after the origin settled, a
> `429`), the server may already have settled the payment. You get a `GlassnodePaymentError` with
> **`paymentMayHaveSettled: true`**. Before retrying it yourself, check the wallet's USDC transfers on
> Base. A retry pays again.

- The server's price is above `maxPaymentPerCall`, the signer throws, or the `402` carries no usable
  payment requirements → `GlassnodePaymentError` with `paymentMayHaveSettled: false` (x402's error on
  `.cause`; `true` only if a signed payment had already gone out earlier in the same call). **Never retried**, even with `maxRetries` > 0: nothing was paid, and the same request
  would fail again.
- The **paid** request fails in transit (connection error, `timeout`, or your per-call `signal`
  aborting it) → `GlassnodePaymentError` with `paymentMayHaveSettled: true`. The transport error (or
  the abort reason) is on `.cause`, and `timedOut` is `true` when the `timeout` fired. **Never
  retried**, see above.
- The **paid** request gets any non-2xx status other than `402` — `5xx`, `429`, or another `4xx`
  such as `400` → `GlassnodePaymentError` with `paymentMayHaveSettled: true` and `status` set; the
  equivalent `GlassnodeApiError` (`status`, `statusText`, server `detail`) is on `.cause`. **Never
  retried**, see above. Other `4xx` are included because whether a payment settles before the
  handler runs depends on the server (and any proxy in front of it), which the client cannot see.
- The **unpaid** first request fails in transit (connection error, `timeout`) or gets a `429`/`5xx`,
  before any payment is signed → `GlassnodeNetworkError` / `GlassnodeApiError`, retried as usual.
  Nothing was paid.
- **Redirects are never followed.** The fetch from `createX402Fetch()` sends every request with
  `redirect: 'manual'` (a `redirect: 'error'` you pass is kept; `'follow'` is overridden), so the
  signed `PAYMENT-SIGNATURE` / `X-PAYMENT` header is never resent to the origin a `3xx` names, and a
  redirect target never gets to price the request. A `3xx` to the **unpaid** request →
  `GlassnodeApiError` with that status, nothing signed; a `3xx` to the **paid** request →
  `GlassnodePaymentError` with `status` and `paymentMayHaveSettled: true`, never retried (see above).
- The server answers `402` even after payment (e.g. insufficient USDC balance, settlement refused)
  → `GlassnodeApiError` with `status` 402 (not retried). In x402 a `402` is the server's explicit
  "payment not accepted" answer, so it stays an API error.
- Invalid `maxPaymentPerCall` → `GlassnodeInputError` (`argument: 'maxPaymentPerCall'`);
  `@x402/fetch` / `@x402/evm` / `viem` not installed → `GlassnodeConfigError`. `createX402Fetch()`
  itself rejects with both, before any request.

```typescript
try {
  await api.callMetric('/market/mvrv', { a: 'BTC' });
} catch (err) {
  if (err instanceof GlassnodePaymentError && err.paymentMayHaveSettled) {
    // Possibly charged with no data returned. Check on-chain before retrying: a retry pays again.
  }
}
```

**Notes**

- **Bulk metrics are not available over x402** — `callBulkMetric()` only works against the free
  `api.glassnode.com`.
- **Other endpoints:** target a non-default x402 endpoint (e.g. a testnet) by passing its URL as
  `apiUrl`.
- **Browser** signing is not supported yet (planned); the browser bundles do not include
  `glassnode-api/x402`.

## Browser

The library ships prebuilt UMD and ESM bundles, but a web page usually **cannot call
`api.glassnode.com` directly**. As of September 2026, Glassnode's API only sends
`Access-Control-Allow-Origin` for `*.glassnode.com` origins, so for a page served from any other
origin (including `localhost`) the browser blocks access to the response and the call fails with
a network error (`GlassnodeNetworkError`).

Recommended pattern: call Glassnode from your server, or put a thin proxy in front of it that
injects the API key server-side, and point the browser at that proxy with `apiUrl`. Never ship
a Glassnode API key to a browser — anyone can read it from the page.

```html
<!-- UMD -->
<script src="https://unpkg.com/glassnode-api/dist/glassnode-api.umd.min.js"></script>
<script>
  // Your proxy forwards /v1/... to https://api.glassnode.com and adds the real key.
  const api = new GlassnodeAPI.GlassnodeAPI({
    apiKey: 'unused', // required by the client; the proxy should ignore/replace it
    apiUrl: 'https://your-app.example.com/glassnode',
  });
</script>
```

```html
<!-- ESM -->
<script type="module">
  import { GlassnodeAPI } from 'https://unpkg.com/glassnode-api/dist/glassnode-api.esm.min.js';

  const api = new GlassnodeAPI({
    apiKey: 'unused',
    apiUrl: 'https://your-app.example.com/glassnode',
  });
</script>
```

The bare package URL (`https://unpkg.com/glassnode-api`, `https://cdn.jsdelivr.net/npm/glassnode-api`)
serves the UMD bundle, via the package's `unpkg` and `jsdelivr` fields. Pin a version in production
(e.g. `glassnode-api@1.0.0`). Bundlers (webpack, Vite, esbuild, Rollup) do not use these bundles:
they resolve `glassnode-api` through `exports` to the tree-shakeable ESM build, which shares `zod`
with your app.

The bundles also work unchanged where CORS does not apply, such as browser extensions with host
permissions for `api.glassnode.com` (from the background script), or Deno, Bun and other non-browser
runtimes. If you do call Glassnode directly from a browser context, keep the default
`apiKeyLocation: 'query'`: `'header'` fails the CORS preflight (see
[Keeping the API key out of URLs](#keeping-the-api-key-out-of-urls)).

## Examples

See the [examples directory](./examples/README.md) for detailed usage patterns.

```bash
pnpm install          # in the repository root: the examples import the client from ../src (needs zod)
cd examples
npm install           # dotenv, ts-node and the x402 peers used by the examples
cp .env.example .env  # add GLASSNODE_API_KEY (or the X402_* variables for the x402 example)
npx ts-node ex.metadata.validation.ts
```

## Development

```bash
pnpm install                              # install dependencies
pnpm run build && pnpm run build:browser  # build Node.js (CJS + ESM) + browser bundles
pnpm test                                 # run tests (Vitest); test:coverage enforces thresholds
pnpm run lint                             # lint
pnpm run format                           # format
pnpm exec tsc -p tsconfig.test.json --noEmit  # type-check the tests
pnpm exec tsc -p tsconfig.examples.json       # type-check the examples
```

Developing needs Node.js 24 (see `.nvmrc`; Vitest needs Node >= 22.12). The published package
itself supports Node.js >= 18.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to open a pull request: the full local check list,
the version and changelog rules, and how releases work.

### Recording contract fixtures

`scripts/record-fixtures.mjs` records real API responses into `test/fixtures/contract/` so the
response schemas can be tested against what the API actually returns. It is only re-run to
refresh those fixtures, not as part of the normal workflow:

```bash
GLASSNODE_API_KEY=... node scripts/record-fixtures.mjs
```

- The key is read **only** from the `GLASSNODE_API_KEY` environment variable (there is no CLI flag
  for it) and sent only as the `X-Api-Key` header. Prefer loading it from a secret store rather
  than typing it inline, so it does not stay in your shell history — e.g. with 1Password:
  `GLASSNODE_API_KEY="$(op read 'op://<vault>/<item>/credential')" node scripts/record-fixtures.mjs`.
- It makes 10 calls, 1 s apart: asset metadata, the metric list, metric metadata and metric stats
  (with and without `a`) — which do not consume API quota — plus three short, fixed-window metric
  data calls (a `{t, v}` series, a `{t, o}` series and a bulk response), which do.
- It writes one pretty-printed `<name>.json` per response plus `manifest.json` (endpoint, params,
  HTTP status, capture date and client version for each fixture). A response over 2 MB is trimmed
  to a representative subset (the first entries of a top-level array, or of each top-level array
  property such as a bulk response's `data`), and the manifest says so. A response that cannot be
  trimmed below 2 MB aborts the run.
- Redirects are never followed, so the key is never resent to another host (or over plain http):
  any 3xx aborts with its status and target.
- Any HTTP or network error aborts with the status and endpoint, and the run also aborts if the key
  appears anywhere in the output; in all these cases nothing is written.
- `--base-url <url>` (or `GLASSNODE_API_URL`) points it at another server, e.g. a local mock;
  `--out-dir <dir>` writes somewhere other than `test/fixtures/contract/`.

Review the diff (`git diff test/fixtures/contract`) before committing the fixtures.

`test/contract.spec.ts` (part of `pnpm test`) serves each recorded response through a mocked
`fetch` to the client method that calls it, and checks that it passes the response schema, returns
the recorded values, and that the client builds the recorded request. It also pins the fields the
real responses carry that the schemas do not model (and so strip) — currently none. After a
re-recording, a new field fails that test until it is modelled or listed there, and a new fixture
fails until it has a case. The manifest and the files in the directory must match.

Most assertions compare results with the recorded body, but a few pin literal values from the
current recording that a legitimate re-recording can change; update them in
`test/contract.spec.ts` if they do: the metric `tier` values, the `parameters.a` / `parameters.e` /
`parameters.i` lists and `parameters_defaults` of the metric metadata cases, the stats resolution
sets, BTC's asset metadata (`external_ids`, `asset_type`, `default_network`, `categories`), the
metric paths expected in the metric list, and the bulk assets and their `network`.

## License

[Apache License 2.0](./LICENSE); see [NOTICE](./NOTICE) for attribution. Versions before 0.29.0
were published under the MIT License.
