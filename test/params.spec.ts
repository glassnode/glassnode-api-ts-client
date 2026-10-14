import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { GlassnodeAPI } from '../src/glassnode-api.js';
import { GlassnodeInputError } from '../src/errors.js';
import type { MetricParams, MetricParamValue, MetricTime, MetricInterval } from '../src/index.js';
import { API_KEY, DEFAULT_API_URL } from './constants.js';

const PRICE = `${DEFAULT_API_URL}/v1/metrics/market/price_usd_close`;

function okFetch(body: unknown = []) {
  return vi
    .fn()
    .mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(body)) });
}

function neverFetch() {
  return vi.fn().mockRejectedValue(new Error('fetch must not be called'));
}

function client(fetchFn: ReturnType<typeof vi.fn>) {
  return new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn as typeof fetch });
}

/** The URL of the single request `params` produce via callMetric. */
async function urlFor(params: unknown): Promise<string> {
  const fetchFn = okFetch();
  await client(fetchFn).callMetric('/market/price_usd_close', params as MetricParams);
  expect(fetchFn).toHaveBeenCalledTimes(1);
  return fetchFn.mock.calls[0][0] as string;
}

async function rejection(params: unknown, method: PathMethod = 'callMetric') {
  const fetchFn = neverFetch();
  const api = client(fetchFn);
  const err = await (api[method] as (p: string, q: unknown) => Promise<unknown>)(
    '/market/price_usd_close',
    params
  ).then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(GlassnodeInputError);
  expect(fetchFn).not.toHaveBeenCalled();
  return err as GlassnodeInputError;
}

type PathMethod = 'callMetric' | 'callBulkMetric' | 'getMetricMetadata' | 'getMetricStats';
const PATH_METHODS: PathMethod[] = [
  'callMetric',
  'callBulkMetric',
  'getMetricMetadata',
  'getMetricStats',
];

describe('param value conversion', () => {
  it('passes strings through unchanged (byte-identical to before)', async () => {
    expect(await urlFor({ a: 'BTC', s: '1609459200', i: '24h' })).toBe(
      `${PRICE}?a=BTC&s=1609459200&i=24h&f=json&api_key=${API_KEY}`
    );
  });

  it.each<[string, number, string]>([
    ['an integer timestamp', 1609459200, '1609459200'],
    ['zero', 0, '0'],
    ['negative zero (as 0)', -0, '0'],
    ['a negative integer', -5, '-5'],
    ['a float (shortest round-trip form)', 0.1, '0.1'],
    ['a float with many digits', 1.2345678901234567, '1.2345678901234567'],
    ['a large safe integer', Number.MAX_SAFE_INTEGER, '9007199254740991'],
    ['a small float above the exponent threshold', 0.000001, '0.000001'],
  ])('converts %s', async (_label, value, expected) => {
    expect(await urlFor({ s: value })).toBe(`${PRICE}?s=${expected}&f=json&api_key=${API_KEY}`);
  });

  it('formats numbers independently of the locale', async () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString').mockReturnValue('1.609.459.200');
    try {
      expect(await urlFor({ s: 1609459200 })).toBe(
        `${PRICE}?s=1609459200&f=json&api_key=${API_KEY}`
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('converts booleans to "true"/"false"', async () => {
    expect(await urlFor({ x: true, y: false })).toBe(
      `${PRICE}?x=true&y=false&f=json&api_key=${API_KEY}`
    );
  });

  it('converts a Date to unix seconds', async () => {
    expect(await urlFor({ s: new Date('2021-01-01T00:00:00Z') })).toBe(
      `${PRICE}?s=1609459200&f=json&api_key=${API_KEY}`
    );
  });

  it('floors a Date with milliseconds to the whole second it falls in', async () => {
    expect(
      await urlFor({ s: new Date('2021-01-01T00:00:00.999Z'), u: new Date(1609459201001) })
    ).toBe(`${PRICE}?s=1609459200&u=1609459201&f=json&api_key=${API_KEY}`);
  });

  it('recognises a Date from another realm (e.g. an iframe or vm context)', async () => {
    const foreign = runInNewContext('new Date(1609459200000)') as Date;
    expect(foreign instanceof Date).toBe(false);
    expect(await urlFor({ s: foreign })).toBe(`${PRICE}?s=1609459200&f=json&api_key=${API_KEY}`);
  });

  it('floors pre-1970 Dates towards -Infinity (not towards zero)', async () => {
    expect(await urlFor({ s: new Date(-500) })).toBe(`${PRICE}?s=-1&f=json&api_key=${API_KEY}`);
    expect(await urlFor({ s: new Date(0) })).toBe(`${PRICE}?s=0&f=json&api_key=${API_KEY}`);
  });

  it('omits params whose value is undefined', async () => {
    expect(await urlFor({ a: 'BTC', s: undefined, i: '24h' })).toBe(
      `${PRICE}?a=BTC&i=24h&f=json&api_key=${API_KEY}`
    );
  });

  it('treats an undefined reserved param as absent (api_key, f)', async () => {
    expect(await urlFor({ a: 'BTC', api_key: undefined, f: undefined })).toBe(
      `${PRICE}?a=BTC&f=json&api_key=${API_KEY}`
    );
  });

  it('keeps an undefined `path` from overriding the metric path in the metadata endpoints', async () => {
    const fetchFn = okFetch({ path: '/market/price_usd_close' });
    await client(fetchFn)
      .getMetricMetadata('/market/price_usd_close', { a: 'BTC', path: undefined })
      .catch(() => undefined);
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metadata/metric?path=%2Fmarket%2Fprice_usd_close&a=BTC&api_key=${API_KEY}`
    );
  });

  it('keeps the caller key order, and places converted values in it', async () => {
    expect(await urlFor({ u: new Date(1609545600000), a: 'ETH', s: 1609459200, x: false })).toBe(
      `${PRICE}?u=1609545600&a=ETH&s=1609459200&x=false&f=json&api_key=${API_KEY}`
    );
  });

  it('does not mutate the caller params object', async () => {
    const params = { a: 'BTC', s: new Date(1609459200000), u: undefined };
    await urlFor(params);
    expect(params).toEqual({ a: 'BTC', s: new Date(1609459200000), u: undefined });
  });

  it('treats a "__proto__" key as an ordinary param, not a prototype', async () => {
    const params = JSON.parse('{"__proto__": "x", "a": "BTC"}');
    expect(await urlFor(params)).toBe(`${PRICE}?__proto__=x&a=BTC&f=json&api_key=${API_KEY}`);
  });

  for (const method of PATH_METHODS) {
    it(`${method} converts numbers, booleans and Dates the same way`, async () => {
      const fetchFn = okFetch();
      await (client(fetchFn)[method] as (p: string, q: MetricParams) => Promise<unknown>)(
        '/market/price_usd_close',
        { a: 'BTC', s: new Date(1609459200500), u: 1609545600, x: true }
      ).catch(() => undefined);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0][0]).toContain('a=BTC&s=1609459200&u=1609545600&x=true');
    });
  }
});

describe('invalid param values', () => {
  it.each<[string, unknown, RegExp]>([
    ['NaN', NaN, /finite number/],
    ['Infinity', Infinity, /finite number/],
    ['-Infinity', -Infinity, /finite number/],
    ['an unsafe integer', 2 ** 53, /safe integer range/],
    ['a huge number (exponent form)', 1e21, /safe integer range/],
    ['a tiny number (exponent form)', 1e-7, /exponent notation/],
    ['an invalid Date', new Date('nope'), /invalid Date/],
    ['null', null, /must not be null/],
    ['an object', { v: 1 }, /must be a string, number, boolean or Date/],
    // `s` is single-valued; arrays for multi-value params are covered under 'repeated params'.
    ['an array', [1609459200, 1609545600], /takes a single value, got an array/],
    ['a bigint', 10n, /must be a string, number, boolean or Date/],
    ['a symbol', Symbol('x'), /must be a string, number, boolean or Date/],
    ['a function', () => 1, /must be a string, number, boolean or Date/],
  ])('rejects %s before any request', async (_label, value, message) => {
    for (const method of PATH_METHODS) {
      const err = await rejection({ a: 'BTC', s: value }, method);
      expect(err.argument).toBe('params.s');
      expect(err.message).toMatch(message);
    }
  });

  it('names the offending param in the error', async () => {
    const err = await rejection({ a: 'BTC', some_flag: NaN });
    expect(err.argument).toBe('params.some_flag');
    expect(err.message).toContain('some_flag');
  });

  it.each<[string, unknown]>([
    ['a string', 'a=BTC'],
    ['an array', [['a', 'BTC']]],
    ['a number', 42],
  ])('rejects params that is %s', async (_label, params) => {
    for (const method of PATH_METHODS) {
      const err = await rejection(params, method);
      expect(err.argument).toBe('params');
    }
  });

  it('still accepts null or undefined params as "no params"', async () => {
    expect(await urlFor(undefined)).toBe(`${PRICE}?f=json&api_key=${API_KEY}`);
    expect(await urlFor(null)).toBe(`${PRICE}?f=json&api_key=${API_KEY}`);
  });

  it('rejects a non-string f (e.g. true) as non-JSON', async () => {
    const err = await rejection({ f: true });
    expect(err.argument).toBe('params.f');
    expect(err.message).toMatch(/only supports JSON/);
  });

  it('rejects api_key regardless of its value type', async () => {
    for (const value of [1, true, new Date(), null]) {
      const err = await rejection({ api_key: value });
      expect(err.argument).toBe('params.api_key');
    }
  });

  it('rejects a numeric path in the metadata endpoints', async () => {
    const err = await rejection({ path: 1 }, 'getMetricMetadata');
    expect(err.argument).toBe('params.path');
  });
});

describe('MetricParams types', () => {
  it('accepts numbers, booleans and Dates at compile time', async () => {
    const fetchFn = okFetch();
    const api = client(fetchFn);
    // These must compile (tsc -p tsconfig.test.json type-checks this file).
    await api.callMetric('/market/price_usd_close', { a: 'BTC', s: 1609459200 });
    await api.callMetric('/market/price_usd_close', { a: 'BTC', s: new Date(), u: new Date() });
    await api.callMetric('/market/price_usd_close', { a: 'BTC', i: '24h', c: 'usd', e: 'binance' });
    await api.callMetric('/market/price_usd_close', { a: 'BTC', some_flag: true, n: 3 });
    await api.callBulkMetric('/market/marketcap_usd', { a: '*', s: 1609459200 }).catch(() => {});
    await api.getMetricMetadata('/market/price_usd_close', { a: 'BTC', s: 1 }).catch(() => {});
    await api
      .getMetricStats('/market/price_usd_close', { a: 'BTC', u: new Date() })
      .catch(() => {});

    // Existing string-typed callers keep compiling.
    const legacy: Record<string, string> = { a: 'BTC', s: '1609459200' };
    await api.callMetric('/market/price_usd_close', legacy);
    // Optional values may be undefined.
    const since: number | undefined = undefined;
    await api.callMetric('/market/price_usd_close', { a: 'BTC', s: since });

    // The exported helper types.
    const value: MetricParamValue = new Date();
    const time: MetricTime = 1609459200;
    const interval: MetricInterval = '1h';
    const custom: MetricInterval = '3h';
    const params: MetricParams = { a: 'ETH', s: time, i: interval, x: value };
    expect([custom, params]).toHaveLength(2);

    // @ts-expect-error — the asset is a string
    await api.callMetric('/market/price_usd_close', { a: 1 }).catch(() => {});
    // @ts-expect-error — null is not a value (omit the param, or pass undefined)
    await api.callMetric('/market/price_usd_close', { s: null }).catch(() => {});
    // @ts-expect-error — objects are not param values
    await api.callMetric('/market/price_usd_close', { x: { y: 1 } }).catch(() => {});
    // @ts-expect-error — api_key is set by the client (configure apiKey)
    await api.callMetric('/market/price_usd_close', { api_key: 'k' }).catch(() => {});
  });
});

describe('repeated params (array values)', () => {
  const BULK = `${DEFAULT_API_URL}/v1/metrics/market/marketcap_usd/bulk`;

  async function bulkUrlFor(params: unknown, config: Record<string, unknown> = {}) {
    const fetchFn = okFetch({ data: [] });
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn as typeof fetch, ...config });
    await api.callBulkMetric('/market/marketcap_usd', params as MetricParams);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    return fetchFn.mock.calls[0] as [string, RequestInit?];
  }

  it('sends an array as the same param repeated, in the given order', async () => {
    expect(await urlFor({ a: ['BTC', 'ETH', 'SOL'] })).toBe(
      `${PRICE}?a=BTC&a=ETH&a=SOL&f=json&api_key=${API_KEY}`
    );
    expect(await urlFor({ a: ['ETH', 'BTC'] })).toBe(
      `${PRICE}?a=ETH&a=BTC&f=json&api_key=${API_KEY}`
    );
  });

  it('never comma-joins the values', async () => {
    const url = await urlFor({ a: ['BTC', 'ETH'] });
    expect(url).not.toContain('%2C');
    expect(url).not.toContain('BTC,ETH');
  });

  it('keeps the key order when mixed with scalar params (api_key in the query)', async () => {
    const [url, init] = await bulkUrlFor({
      s: 1609459200,
      a: ['BTC', 'ETH'],
      i: '24h',
      e: ['binance', 'kraken'],
    });
    expect(url).toBe(
      `${BULK}?s=1609459200&a=BTC&a=ETH&i=24h&e=binance&e=kraken&f=json&api_key=${API_KEY}`
    );
    expect(init).toBeUndefined();
  });

  it("keeps the key out of the URL with apiKeyLocation 'header'", async () => {
    const [url, init] = await bulkUrlFor(
      { a: ['BTC', 'ETH'], s: 1609459200 },
      { apiKeyLocation: 'header' }
    );
    expect(url).toBe(`${BULK}?a=BTC&a=ETH&s=1609459200&f=json`);
    expect(init).toEqual({ headers: { 'X-Api-Key': API_KEY }, redirect: 'manual' });
  });

  it('sends a one-element array as a single param (same URL as the scalar)', async () => {
    expect(await urlFor({ a: ['BTC'] })).toBe(await urlFor({ a: 'BTC' }));
  });

  it('sends duplicate elements as given', async () => {
    expect(await urlFor({ a: ['BTC', 'BTC'] })).toBe(
      `${PRICE}?a=BTC&a=BTC&f=json&api_key=${API_KEY}`
    );
  });

  it('URL-encodes each element on its own', async () => {
    expect(await urlFor({ x: ['a b', 'c&d', 'e,f'] })).toBe(
      `${PRICE}?x=a+b&x=c%26d&x=e%2Cf&f=json&api_key=${API_KEY}`
    );
  });

  it('converts each element with the scalar rules (number, boolean, Date)', async () => {
    const d = new Date('2021-01-01T00:00:00.999Z');
    expect(await urlFor({ x: [1, 0.5, -0, true, false, d, 'raw'] })).toBe(
      `${PRICE}?x=1&x=0.5&x=0&x=true&x=false&x=1609459200&x=raw&f=json&api_key=${API_KEY}`
    );
  });

  it('accepts a readonly (frozen) array', async () => {
    const assets = Object.freeze(['BTC', 'ETH'] as const);
    expect(await urlFor({ a: assets })).toBe(`${PRICE}?a=BTC&a=ETH&f=json&api_key=${API_KEY}`);
  });

  it('accepts an array from another realm', async () => {
    const assets = runInNewContext('["BTC", "ETH"]') as string[];
    expect(await urlFor({ a: assets })).toBe(`${PRICE}?a=BTC&a=ETH&f=json&api_key=${API_KEY}`);
  });

  it('does not mutate the caller array', async () => {
    const assets = ['BTC', 'ETH'];
    const params = { a: assets };
    await urlFor(params);
    expect(params.a).toBe(assets);
    expect(assets).toEqual(['BTC', 'ETH']);
  });

  it('works in every public method, after `path` in the metadata endpoints', async () => {
    const fetchFn = okFetch({ data: [] });
    const api = client(fetchFn);
    const params = { a: ['BTC', 'ETH'] };
    await api.callMetric('/m/x', params);
    await api.callBulkMetric('/m/x', params);
    await api.getMetricMetadata('/m/x', params).catch(() => undefined);
    await api.getMetricStats('/m/x', params).catch(() => undefined);
    const urls = fetchFn.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual([
      `${DEFAULT_API_URL}/v1/metrics/m/x?a=BTC&a=ETH&f=json&api_key=${API_KEY}`,
      `${DEFAULT_API_URL}/v1/metrics/m/x/bulk?a=BTC&a=ETH&f=json&api_key=${API_KEY}`,
      `${DEFAULT_API_URL}/v1/metadata/metric?path=%2Fm%2Fx&a=BTC&a=ETH&api_key=${API_KEY}`,
      `${DEFAULT_API_URL}/v1/metadata/metric/stats?path=%2Fm%2Fx&a=BTC&a=ETH&api_key=${API_KEY}`,
    ]);
  });

  it('sends repeated params to the x402 endpoint without a key', async () => {
    const fetchFn = okFetch({ data: [] });
    const api = new GlassnodeAPI({ x402: true, fetch: fetchFn as typeof fetch });
    await api.callBulkMetric('/market/marketcap_usd', { a: ['BTC', 'ETH'], s: 1609459200 });
    expect(fetchFn.mock.calls[0][0]).toBe(
      'https://x402.glassnode.com/v1/metrics/market/marketcap_usd/bulk?a=BTC&a=ETH&s=1609459200&f=json'
    );
  });

  it('masks the key in logger output and hook URLs that carry repeated params', async () => {
    const fetchFn = okFetch({ data: [] });
    const logger = vi.fn();
    const onRequest = vi.fn();
    const api = new GlassnodeAPI({
      apiKey: API_KEY,
      fetch: fetchFn as typeof fetch,
      logger,
      hooks: { onRequest },
    });
    await api.callBulkMetric('/market/marketcap_usd', { a: ['BTC', 'ETH'] });
    const hookUrl = (onRequest.mock.calls[0][0] as { url: string }).url;
    expect(hookUrl).toMatch(/\/bulk\?a=BTC&a=ETH&f=json&api_key=/);
    expect(hookUrl).not.toContain(API_KEY);
    const logged = JSON.stringify(logger.mock.calls);
    expect(logged).toContain('a=BTC&a=ETH');
    expect(logged).not.toContain(API_KEY);
  });

  it.each<[string, unknown, RegExp]>([
    ['an empty array', [], /must not be an empty array/],
    ['an array containing undefined', ['BTC', undefined], /`a\[1\]` must not be undefined/],
    [
      'a sparse array (hole)',
      Object.assign(['BTC'], { 2: 'ETH' }),
      /`a\[1\]` must not be undefined/,
    ],
    ['an array containing null', [null, 'BTC'], /`a\[0\]` must not be null/],
    [
      'a nested array',
      ['BTC', ['ETH']],
      /`a\[1\]` must be a string, number, boolean or Date, got array/,
    ],
    [
      'an array containing an object',
      [{ v: 1 }],
      /`a\[0\]` must be a string, number, boolean or Date, got object/,
    ],
    ['an array containing NaN', ['BTC', NaN], /`a\[1\]` must be a finite number/],
    ['an array containing an invalid Date', [new Date('nope')], /`a\[0\]` is an invalid Date/],
  ])('rejects %s before any request', async (_label, value, message) => {
    for (const method of PATH_METHODS) {
      const err = await rejection({ s: 1, a: value }, method);
      expect(err.argument).toBe('params.a');
      expect(err.message).toMatch(message);
    }
  });

  it.each(['s', 'u', 'i', 'c'])(
    'rejects an array for the single-valued `%s` before any request',
    async (name) => {
      for (const method of PATH_METHODS) {
        const err = await rejection({ a: 'BTC', [name]: ['1', '2'] }, method);
        expect(err.argument).toBe(`params.${name}`);
        expect(err.message).toMatch(/takes a single value/);
      }
    }
  );

  it('rejects arrays for the reserved params (f, api_key, path) before any request', async () => {
    for (const method of PATH_METHODS) {
      const f = await rejection({ f: ['json'] }, method);
      expect(f.argument).toBe('params.f');
      const key = await rejection({ api_key: ['k1', 'k2'] }, method);
      expect(key.argument).toBe('params.api_key');
    }
    for (const method of ['getMetricMetadata', 'getMetricStats'] as const) {
      const path = await rejection({ path: ['/a/b', '/c/d'] }, method);
      expect(path.argument).toBe('params.path');
    }
  });

  it('accepts arrays at compile time for a, e and custom params (but not s, u, i, c, f)', async () => {
    const fetchFn = okFetch({ data: [] });
    const api = client(fetchFn);
    // These must compile (tsc -p tsconfig.test.json type-checks this file).
    await api.callBulkMetric('/market/marketcap_usd', { a: ['BTC', 'ETH'], s: 1609459200 });
    await api.callBulkMetric('/m/x', { a: ['BTC'], e: ['binance', 'kraken'], network: ['a', 'b'] });
    const assets: readonly string[] = ['BTC', 'ETH'];
    await api.callMetric('/m/x', { a: assets, x: [1, true, new Date()] });
    const params: MetricParams = { a: ['BTC', 'ETH'] as const };
    expect(params.a).toHaveLength(2);

    // @ts-expect-error — asset arrays hold strings
    await api.callMetric('/m/x', { a: ['BTC', 1] }).catch(() => {});
    // @ts-expect-error — s takes a single value
    await api.callMetric('/m/x', { s: [1, 2] }).catch(() => {});
    // @ts-expect-error — u takes a single value
    await api.callMetric('/m/x', { u: [1, 2] }).catch(() => {});
    // @ts-expect-error — i takes a single value
    await api.callMetric('/m/x', { i: ['1h', '24h'] }).catch(() => {});
    // @ts-expect-error — c takes a single value
    await api.callMetric('/m/x', { c: ['usd', 'native'] }).catch(() => {});
    // @ts-expect-error — f takes a single value
    await api.callMetric('/m/x', { f: ['json'] }).catch(() => {});
    // @ts-expect-error — no null elements
    await api.callMetric('/m/x', { x: ['a', null] }).catch(() => {});
    // @ts-expect-error — no nested arrays
    await api.callMetric('/m/x', { x: [['a']] }).catch(() => {});
  });
});
