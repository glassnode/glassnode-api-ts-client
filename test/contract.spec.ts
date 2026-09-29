/**
 * Contract tests: every real API response recorded by `scripts/record-fixtures.mjs` (see
 * `test/fixtures/contract/manifest.json`) is served through a mocked `fetch` to the client method
 * that calls that endpoint. Each test asserts that
 *
 * - the call succeeds, i.e. the recorded response passes the library's Zod schema;
 * - the result has the documented shape and the recorded values (timestamps stay unix seconds,
 *   except `MetricMetadata.modified`, which becomes a `Date`);
 * - the request URL the client builds matches the recorded endpoint and query, plus the `f=json`
 *   the client adds to metric data calls and the (query-string) API key;
 * - the fields the schemas strip from the real response are exactly the known, unmodelled ones
 *   (see `EXPECTED_STRIPPED` below; currently none), so a re-recorded fixture that brings a new
 *   field fails here and the field gets a conscious decision: model it, or list it there.
 *
 * The manifest, the fixture files and the cases below must match one to one: a fixture without a
 * case, a case without a fixture, or a file not listed in the manifest fails the suite.
 *
 * Re-recording: most assertions compare the result with the recorded body, but some pin literal
 * values that a legitimate re-recording can change, and then need updating by hand: the metric
 * `tier` values, the interval list (`parameters.i`) and asset/exchange lists (`parameters.a`,
 * `parameters.e`, and `parameters_defaults`) of the metric metadata cases, the stats resolution
 * sets (`['24h']`, `['10m', '1h', '24h', '1w']`), BTC's asset metadata (`external_ids`,
 * `asset_type`, `default_network`, `categories`), the metric paths expected in the metric list,
 * and the bulk assets and their `network`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { GlassnodeAPI } from '../src/glassnode-api';
import {
  TimeSeriesObjectResponseSchema,
  TimeSeriesResponseSchema,
  type AssetMetadataResponse,
  type BulkResponse,
  type MetricListResponse,
  type MetricMetadataResponse,
  type MetricStatsResponse,
  type TimeSeriesObjectResponse,
  type TimeSeriesResponse,
} from '../src/types/metadata';
import type { MetricParams } from '../src/types/params';
import { API_KEY } from './constants';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'contract');
const MANIFEST_FILE = 'manifest.json';

interface ManifestEntry {
  name: string;
  file: string;
  endpoint: string;
  params: { name: string; value: string }[];
  status: number;
  bytes: number;
  trimmed?: { originalCount: number; keptCount: number; originalBytes: number; policy: string };
}

interface Manifest {
  baseUrl: string;
  fixtures: ManifestEntry[];
}

const manifest = JSON.parse(
  readFileSync(path.join(FIXTURE_DIR, MANIFEST_FILE), 'utf8')
) as Manifest;

/** Raw text of a fixture file (served as the response body, byte for byte). */
const fixtureText = (entry: ManifestEntry) =>
  readFileSync(path.join(FIXTURE_DIR, entry.file), 'utf8');

/** The recorded window of the metric data calls: 2025-01-01T00:00Z .. 2025-01-03T00:00Z. */
const WINDOW_START = 1735689600;
const WINDOW_END = 1735862400;
const DAY = 86400;

/**
 * The call's arguments, rebuilt from the recorded query: `path` becomes the `metricPath` argument
 * (metadata endpoints), a repeated parameter becomes an array, and `s` / `u` are passed as `Date`s,
 * so the check on the built URL also pins the documented Date → unix-seconds conversion.
 */
function callArgs(entry: ManifestEntry): { metricPath?: string; params: MetricParams } {
  let metricPath: string | undefined;
  const params: Record<string, string | string[] | Date> = {};
  for (const { name, value } of entry.params) {
    if (name === 'path') metricPath = value;
    else if (name === 's' || name === 'u') params[name] = new Date(Number(value) * 1000);
    else if (name in params) params[name] = ([] as string[]).concat(params[name] as string, value);
    else params[name] = value;
  }
  return { metricPath, params };
}

/** `metricPath` for a metric data endpoint: `/v1/metrics/<path>[/bulk]` → `/<path>`. */
function metricDataPath(entry: ManifestEntry): string {
  const match = /^\/v1\/metrics(\/.+?)(\/bulk)?$/.exec(entry.endpoint);
  if (!match) throw new Error(`${entry.name}: ${entry.endpoint} is not a metric data endpoint`);
  return match[1];
}

/** `metricPath` for a metadata endpoint, taken from the recorded `path` parameter. */
function metadataPath(entry: ManifestEntry): string {
  const { metricPath } = callArgs(entry);
  if (!metricPath) throw new Error(`${entry.name}: the recording has no \`path\` parameter`);
  return metricPath;
}

/**
 * Paths of the object keys present in `raw` but absent from `parsed` — the fields the schema
 * stripped. Array indices are collapsed to `[]`, so one path stands for every element.
 */
function strippedKeys(raw: unknown, parsed: unknown, at = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed)) {
    return raw.flatMap((element, i) => strippedKeys(element, parsed[i], `${at}[]`));
  }
  if (
    raw === null ||
    typeof raw !== 'object' ||
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed instanceof Date
  ) {
    return [];
  }
  const rawRecord = raw as Record<string, unknown>;
  const parsedRecord = parsed as Record<string, unknown>;
  return Object.keys(rawRecord).flatMap((key) => {
    const keyPath = at ? `${at}.${key}` : key;
    return Object.prototype.hasOwnProperty.call(parsedRecord, key)
      ? strippedKeys(rawRecord[key], parsedRecord[key], keyPath)
      : [keyPath];
  });
}

const unique = (paths: string[]) => [...new Set(paths)].sort();

/** Percentiles in increasing order: a stats entry must be monotone in them. */
const PERCENTILES = ['p50', 'p90', 'p95', 'p99'] as const;

/**
 * One case per recorded fixture, keyed by its manifest `name`. A case makes the real client call
 * (typed, so `tsc -p tsconfig.test.json` checks the result type) and asserts on the result; `raw`
 * is the recorded body. The request URL and the stripped fields are checked for every case in the
 * generic test below.
 */
type Case = (api: GlassnodeAPI, entry: ManifestEntry, raw: unknown) => Promise<unknown>;

async function metricMetadataCase(
  api: GlassnodeAPI,
  entry: ManifestEntry,
  raw: unknown
): Promise<MetricMetadataResponse> {
  const { params } = callArgs(entry);
  const result = await api.getMetricMetadata(metadataPath(entry), params);
  expectTypeOf(result).toEqualTypeOf<MetricMetadataResponse>();
  const body = raw as Record<string, unknown> & { modified: number };

  expect(result.path).toBe(metadataPath(entry));
  expect(Number.isInteger(result.tier)).toBe(true);
  expect(result.tier).toBe(body.tier);
  // The one converted time field: unix seconds → Date.
  expect(result.modified).toBeInstanceOf(Date);
  expect(result.modified!.getTime()).toBe(body.modified * 1000);
  // `timerange` stays unix seconds (numbers).
  expect(result.timerange).toEqual(body.timerange);
  expect(typeof result.timerange!.min).toBe('number');
  expect(result.timerange!.min).toBeLessThan(result.timerange!.max);
  expect(result.bulk_supported).toBe(body.bulk_supported);
  // `refs`, `queried` and `parameters` are optional in the schema, but the recorded responses
  // all carry them. Checked before any dereference below, so a re-recorded response without them
  // fails with a clear assertion: that is a change in the recorded API response, not a schema bug.
  expect(result.refs).toBeDefined();
  expect(result.queried).toBeDefined();
  expect(result.parameters).toBeDefined();
  expect(result.parameters).toEqual(body.parameters);
  // Only sent for a metric with a defaulted parameter; `undefined` (not `{}`) otherwise.
  expect(result.parameters_defaults).toEqual(body.parameters_defaults);
  expect(result.queried).toEqual(body.queried);
  expect(result.queried!.path).toBe(metadataPath(entry));
  expect(result.refs).toEqual(body.refs);
  expect(result.descriptors).toEqual(body.descriptors);
  expect(result.descriptors?.name).toEqual(expect.any(String));
  expect(result.parameters!.f).toContain('json');
  return result;
}

async function metricStatsCase(
  api: GlassnodeAPI,
  entry: ManifestEntry,
  raw: unknown,
  resolutions: string[]
): Promise<MetricStatsResponse> {
  const { params } = callArgs(entry);
  const result = await api.getMetricStats(metadataPath(entry), params);
  expectTypeOf(result).toEqualTypeOf<MetricStatsResponse>();

  expect(result).toEqual(raw);
  expect(result.lag).toHaveLength(1);
  const [lag] = result.lag;
  expect(lag.unit).toBe('seconds');
  expect(lag.window).toBe('30d');
  expect(Object.keys(lag.resolution).sort()).toEqual([...resolutions].sort());
  for (const percentiles of Object.values(lag.resolution)) {
    // Every percentile is present, a non-negative duration (not a timestamp), and monotone.
    const values = PERCENTILES.map((p) => percentiles[p]);
    for (const value of values) {
      expect(typeof value).toBe('number');
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(WINDOW_START); // a lag in seconds, nowhere near a unix time
    }
    const sorted = [...(values as number[])].sort((x, y) => x - y);
    expect(values).toEqual(sorted);
  }
  return result;
}

const CASES: Record<string, Case> = {
  'asset-metadata': async (api, entry, raw) => {
    const result = await api.getAssetMetadata();
    expectTypeOf(result).toEqualTypeOf<AssetMetadataResponse>();
    const body = (raw as { data: Record<string, unknown>[] }).data;

    expect(result).toHaveLength(entry.trimmed?.keptCount ?? body.length);
    // Every entry is the recorded one: nothing converted or dropped.
    result.forEach((asset, i) => {
      expect(asset).toEqual(body[i]);
    });
    expect(new Set(result.map((a) => a.id)).size).toBe(result.length);

    const btc = result.find((a) => a.id === 'BTC');
    expect(btc).toMatchObject({
      symbol: 'BTC',
      name: 'Bitcoin',
      asset_type: 'BLOCKCHAIN',
      external_ids: { ccdata: '1', coinmarketcap: '1', coingecko: 'bitcoin' },
      blockchains: [],
      default_network: '',
    });
    expect(btc!.categories).toEqual(expect.arrayContaining(['exchanges', 'on-chain', 'spot']));
    expect(btc!.logo_url).toMatch(/^https:\/\//);
    // The typed fields, on every entry of this recording (all optional in the schema).
    for (const asset of result) {
      for (const list of [asset.categories, asset.semantic_tags]) {
        expect(Array.isArray(list)).toBe(true);
        for (const item of list!) expect(typeof item).toBe('string');
      }
      expect(typeof asset.logo_url).toBe('string');
      expect(typeof asset.default_network).toBe('string');
    }
    expectTypeOf(btc!.categories).toEqualTypeOf<string[] | undefined>();
    expectTypeOf(btc!.default_network).toEqualTypeOf<string | undefined>();
    // `semantic_tags` may be empty; tokens carry a non-empty `default_network` (e.g. "eth").
    expect(result.some((a) => a.semantic_tags!.length === 0)).toBe(true);
    expect(result.some((a) => a.asset_type === 'TOKEN' && a.default_network === 'eth')).toBe(true);
    // Tokens carry their contract deployments; decimals are non-negative integers.
    const chains = result.flatMap((a) => a.blockchains);
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(Number.isInteger(chain.decimals)).toBe(true);
      expect(typeof chain.on_chain_support).toBe('boolean');
    }
    expect(result.some((a) => a.asset_type === 'TOKEN' && a.blockchains.length > 1)).toBe(true);
    return result;
  },

  'metric-list': async (api, _entry, raw) => {
    const result = await api.getMetricList();
    expectTypeOf(result).toEqualTypeOf<MetricListResponse>();

    expect(result).toEqual(raw);
    expect(new Set(result).size).toBe(result.length);
    // Every metric the other fixtures call is listed.
    for (const metric of [
      '/market/price_usd_close',
      '/market/price_usd_ohlc',
      '/market/marketcap_usd',
      '/distribution/balance_exchanges',
      '/institutions/us_spot_etf_balances_all',
      '/addresses/active_count',
    ]) {
      expect(result).toContain(metric);
    }
    return result;
  },

  // Without `a`: `parameters.a` lists every supported asset, `queried` only the path.
  'metric-metadata-price-usd-close': async (api, entry, raw) => {
    const result = await metricMetadataCase(api, entry, raw);
    expect(result.tier).toBe(1);
    expect(result.parameters!.a).toEqual(expect.arrayContaining(['BTC', 'ETH', 'SOL']));
    expect(result.parameters!.a.length).toBeGreaterThan(100);
    expect(result.queried).toEqual({ path: '/market/price_usd_close' });
    expect(result.parameters_defaults).toBeUndefined();
    return result;
  },

  // With `a`: the asset-scoped shape; `queried` carries the asset.
  'metric-metadata-balance-exchanges-btc': async (api, entry, raw) => {
    const result = await metricMetadataCase(api, entry, raw);
    expect(result.tier).toBe(2);
    expect(result.parameters!.a).toEqual(['BTC']);
    expect(result.parameters!.e).toEqual(expect.arrayContaining(['aggregated', 'binance']));
    expect(result.parameters_defaults).toEqual({ e: ['aggregated'] });
    expectTypeOf(result.parameters_defaults).toEqualTypeOf<Record<string, string[]> | undefined>();
    expect(result.queried).toEqual({ a: 'BTC', path: '/distribution/balance_exchanges' });
    return result;
  },

  // An institutional (ETF) metric, without `a`.
  'metric-metadata-us-spot-etf-balances-all': async (api, entry, raw) => {
    const result = await metricMetadataCase(api, entry, raw);
    expect(result.tier).toBe(1);
    expect(result.parameters!.a).toEqual(expect.arrayContaining(['BTC', 'ETH']));
    expect(result.parameters!.i).toEqual(['24h', '1w', '1month']);
    expect(result.queried).toEqual({ path: '/institutions/us_spot_etf_balances_all' });
    return result;
  },

  'metric-stats-us-spot-etf-balances-all': (api, entry, raw) =>
    metricStatsCase(api, entry, raw, ['24h']),

  'metric-stats-active-count-btc': (api, entry, raw) =>
    metricStatsCase(api, entry, raw, ['10m', '1h', '24h', '1w']),

  'timeseries-price-usd-close-btc': async (api, entry, raw) => {
    const result = await api.callMetric(metricDataPath(entry), callArgs(entry).params, {
      schema: TimeSeriesResponseSchema,
    });
    expectTypeOf(result).toEqualTypeOf<TimeSeriesResponse>();

    expect(result).toEqual(raw);
    // Daily points inside the recorded window [s, u); `t` stays unix seconds (a number).
    expect(result.map((p) => p.t)).toEqual([WINDOW_START, WINDOW_START + DAY]);
    for (const point of result) {
      expect(typeof point.t).toBe('number');
      expect(point.t).toBeLessThan(WINDOW_END);
      expect(point.v).toBeGreaterThan(0);
    }
    return result;
  },

  'timeseries-price-usd-ohlc-btc': async (api, entry, raw) => {
    const result = await api.callMetric(metricDataPath(entry), callArgs(entry).params, {
      schema: TimeSeriesObjectResponseSchema,
    });
    expectTypeOf(result).toEqualTypeOf<TimeSeriesObjectResponse>();

    expect(result).toEqual(raw);
    expect(result.map((p) => p.t)).toEqual([WINDOW_START, WINDOW_START + DAY]);
    for (const { o } of result) {
      expect(Object.keys(o).sort()).toEqual(['c', 'h', 'l', 'o']);
      const { o: open, h, l, c } = o as Record<'o' | 'h' | 'l' | 'c', number>;
      expect(l).toBeLessThanOrEqual(Math.min(open, c));
      expect(h).toBeGreaterThanOrEqual(Math.max(open, c));
    }
    // Same asset, interval and window as the `{ t, v }` fixture: its closes are this `c`.
    const closes = manifest.fixtures.find((f) => f.name === 'timeseries-price-usd-close-btc');
    expect(closes, 'the `{ t, v }` close fixture is missing').toBeDefined();
    expect(result.map((p) => ({ t: p.t, v: p.o.c }))).toEqual(JSON.parse(fixtureText(closes!)));
    return result;
  },

  'bulk-marketcap-usd': async (api, entry, raw) => {
    const result = await api.callBulkMetric(metricDataPath(entry), callArgs(entry).params);
    expectTypeOf(result).toEqualTypeOf<BulkResponse>();

    // The client unwraps `data`; `t` stays unix seconds, `network` is kept where sent.
    expect(result).toEqual((raw as { data: unknown }).data);
    expect(result.map((p) => p.t)).toEqual([WINDOW_START, WINDOW_START + DAY]);
    for (const point of result) {
      expect(point.bulk.map((b) => b.a)).toEqual(['BTC', 'ETH', 'SOL']);
      for (const value of point.bulk) expect(value.v).toBeGreaterThan(0);
      expect(point.bulk.find((b) => b.a === 'ETH')?.network).toBe('eth');
      expect(point.bulk.find((b) => b.a === 'BTC')?.network).toBeUndefined();
    }
    return result;
  },
};

/**
 * Fields present in the real responses that no schema models, so they are stripped from results:
 * the expected stripped field paths per fixture (e.g. `'asset-metadata': ['data[].some_field']`);
 * a fixture not listed strips none. Currently every recorded field is modelled. Pinned so a new
 * field in a re-recorded fixture fails the matching test (see the file comment).
 */
const EXPECTED_STRIPPED: Record<string, string[]> = {};

describe('contract fixtures', () => {
  describe('manifest', () => {
    it('lists exactly the fixture files on disk', () => {
      const onDisk = readdirSync(FIXTURE_DIR)
        .filter((file) => file !== MANIFEST_FILE)
        .sort();
      expect(onDisk).toEqual(manifest.fixtures.map((entry) => entry.file).sort());
    });

    it('has exactly one contract case per fixture', () => {
      const names = manifest.fixtures.map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names.slice().sort()).toEqual(Object.keys(CASES).sort());
    });

    it.each(manifest.fixtures.map((entry) => [entry.name, entry] as const))(
      '%s: file matches its manifest entry',
      (_name, entry) => {
        expect(entry.status).toBe(200);
        expect(Buffer.byteLength(fixtureText(entry))).toBe(entry.bytes);
        // The key is never recorded (the script sends it as a header).
        expect(entry.params.map((p) => p.name)).not.toContain('api_key');
        expect(manifest.baseUrl).toBe('https://api.glassnode.com');
      }
    );
  });

  describe('client', () => {
    it.each(manifest.fixtures.map((entry) => [entry.name, entry] as const))(
      '%s: validates, returns the recorded values and builds the recorded request',
      async (name, entry) => {
        const run = CASES[name];
        expect(run, `no contract case for fixture ${name}`).toBeDefined();
        const text = fixtureText(entry);
        const raw: unknown = JSON.parse(text);
        const fetchFn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
          async () =>
            new Response(text, {
              status: entry.status,
              headers: { 'content-type': 'application/json' },
            })
        );
        const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });

        const result = await run(api, entry, raw);

        // The request: recorded endpoint and query, in order, then what the client adds.
        expect(fetchFn).toHaveBeenCalledTimes(1);
        const url = new URL(fetchFn.mock.calls[0][0]);
        expect(url.origin).toBe(manifest.baseUrl);
        expect(url.pathname).toBe(entry.endpoint);
        const expectedQuery = [
          ...entry.params.map(({ name: key, value }) => [key, value]),
          ...(entry.endpoint.startsWith('/v1/metrics/') ? [['f', 'json']] : []),
          ['api_key', API_KEY],
        ];
        expect([...url.searchParams]).toEqual(expectedQuery);

        // The fields the schema strips from the real response are the known unmodelled ones.
        const body = name === 'bulk-marketcap-usd' ? (raw as { data: unknown }).data : raw;
        const wrapped = name === 'asset-metadata' ? { data: result } : result;
        expect(unique(strippedKeys(body, wrapped))).toEqual(EXPECTED_STRIPPED[name] ?? []);
      }
    );
  });
});
