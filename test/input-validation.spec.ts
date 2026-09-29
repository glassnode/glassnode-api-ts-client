import { describe, it, expect, vi } from 'vitest';
import * as pkg from '../src/index.js';
import { GlassnodeAPI } from '../src/glassnode-api.js';
import { GlassnodeError, GlassnodeInputError } from '../src/errors.js';
import { API_KEY, DEFAULT_API_URL } from './constants.js';

/** A fetch that must never be reached: records calls and would fail loudly if awaited. */
function neverFetch() {
  return vi.fn().mockRejectedValue(new Error('fetch must not be called'));
}

function client(fetchFn: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn as typeof fetch, ...extra });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject');
}

type PathMethod = 'callMetric' | 'callBulkMetric' | 'getMetricMetadata' | 'getMetricStats';
const PATH_METHODS: PathMethod[] = [
  'callMetric',
  'callBulkMetric',
  'getMetricMetadata',
  'getMetricStats',
];

function invoke(
  api: GlassnodeAPI,
  method: PathMethod,
  path: unknown,
  params?: Record<string, string>
): Promise<unknown> {
  return (api[method] as (p: unknown, q?: Record<string, string>) => Promise<unknown>)(
    path,
    params
  );
}

describe('GlassnodeInputError', () => {
  it('is exported, named, and part of the GlassnodeError hierarchy', () => {
    expect(pkg.GlassnodeInputError).toBe(GlassnodeInputError);
    const err = new GlassnodeInputError('bad', { argument: 'metricPath' });
    expect(err).toBeInstanceOf(GlassnodeInputError);
    expect(err).toBeInstanceOf(GlassnodeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GlassnodeInputError');
    expect(err.constructor.name).toBe('GlassnodeInputError');
    expect(err.argument).toBe('metricPath');
    expect(err.message).toBe('bad');
  });
});

describe('metric path validation', () => {
  const invalidPaths: [string, unknown, RegExp][] = [
    ['missing leading slash', 'market/price_usd_close', /must start with "\/"/],
    ['empty string', '', /must not be empty/],
    ['only a slash', '/', /empty segment/],
    ['leading whitespace', ' /market/price_usd_close', /whitespace/],
    ['trailing whitespace', '/market/price_usd_close ', /whitespace/],
    ['inner whitespace', '/market/price usd close', /whitespace/],
    ['double slash', '//market/price_usd_close', /empty segment/],
    ['inner double slash', '/market//price_usd_close', /empty segment/],
    ['trailing slash', '/market/price_usd_close/', /empty segment/],
    ['full URL', 'https://api.glassnode.com/v1/metrics/market/price_usd_close', /full URL/],
    ['query string', '/market/price_usd_close?a=BTC', /query string/],
    ['fragment', '/market/price_usd_close#x', /"#"/],
    ['dot-dot segment', '/../metadata/assets', /"\.\." segment/],
    ['dot segment', '/market/./price_usd_close', /"\." segment/],
    ['percent-encoded', '/market/price%20usd', /invalid character/],
    ['backslash', '/market\\price_usd_close', /invalid character/],
    ['non-string', 42, /must be a string/],
    ['undefined', undefined, /must be a string/],
  ];

  for (const method of PATH_METHODS) {
    describe(method, () => {
      for (const [label, path, message] of invalidPaths) {
        it(`rejects ${label} without calling fetch`, async () => {
          const fetchFn = neverFetch();
          const err = await caught(invoke(client(fetchFn), method, path));
          expect(err).toBeInstanceOf(GlassnodeInputError);
          expect(err).toBeInstanceOf(GlassnodeError);
          expect((err as GlassnodeInputError).argument).toBe('metricPath');
          expect((err as Error).message).toMatch(message);
          expect(fetchFn).not.toHaveBeenCalled();
        });
      }

      it('returns a rejected promise rather than throwing synchronously', () => {
        const fetchFn = neverFetch();
        let result: Promise<unknown> | undefined;
        expect(() => {
          result = invoke(client(fetchFn), method, 'market/price_usd_close');
        }).not.toThrow();
        expect(result).toBeInstanceOf(Promise);
        return expect(result).rejects.toBeInstanceOf(GlassnodeInputError);
      });
    });
  }

  it('suggests the corrected path when only the leading slash is missing', async () => {
    const err = await caught(client(neverFetch()).callMetric('market/price_usd_close'));
    expect((err as Error).message).toContain('"/market/price_usd_close"');
  });

  it('does not leak the API key into the error message for a full URL', async () => {
    const err = await caught(
      client(neverFetch()).callMetric(`https://api.glassnode.com/v1/metrics/x?api_key=${API_KEY}`)
    );
    expect((err as Error).message).not.toContain(API_KEY);
  });

  it('accepts dotted, hyphenated, digit and uppercase segments', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
    await client(fetchFn).callMetric('/supply/active_1d-1w.v2/Foo');
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metrics/supply/active_1d-1w.v2/Foo?f=json&api_key=${API_KEY}`
    );
  });
});

describe('callBulkMetric path suffix', () => {
  const okFetch = () =>
    vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: [] }) });

  it.each(['/market/marketcap_usd/bulk', '/bulk'])(
    'rejects %j (ending in /bulk) without calling fetch',
    async (path) => {
      const fetchFn = neverFetch();
      const err = await caught(client(fetchFn).callBulkMetric(path, { a: '*' }));
      expect(err).toBeInstanceOf(GlassnodeInputError);
      expect((err as GlassnodeInputError).argument).toBe('metricPath');
      expect((err as Error).message).toMatch(/^Invalid metricPath: /);
      expect((err as Error).message).toMatch(/must not end in "\/bulk"/);
      expect((err as Error).message).toContain('pass the base path');
      // No URL or query string (the "?" of "did you mean …?" is fine; "?a=" is not).
      expect((err as Error).message).not.toMatch(/https?:|\/v1\/|api_key|\?\w+=|&/);
      expect((err as Error).message).not.toContain(API_KEY);
      expect(fetchFn).not.toHaveBeenCalled();
    }
  );

  it('suggests the base path', async () => {
    const err = await caught(
      client(neverFetch()).callBulkMetric('/market/marketcap_usd/bulk', { a: '*' })
    );
    expect((err as Error).message).toContain('"/market/marketcap_usd"');
  });

  it('still requests .../bulk for the base path', async () => {
    const fetchFn = okFetch();
    await client(fetchFn).callBulkMetric('/market/marketcap_usd', { a: '*' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metrics/market/marketcap_usd/bulk?a=*&f=json&api_key=${API_KEY}`
    );
  });

  it('allows a segment that merely contains "bulk"', async () => {
    const fetchFn = okFetch();
    await client(fetchFn).callBulkMetric('/market/bulkiness');
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metrics/market/bulkiness/bulk?f=json&api_key=${API_KEY}`
    );
  });

  it('leaves callMetric with a /bulk path unaffected', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
    await client(fetchFn).callMetric('/market/marketcap_usd/bulk', { a: '*' });
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metrics/market/marketcap_usd/bulk?a=*&f=json&api_key=${API_KEY}`
    );
  });
});

describe('reserved query parameters', () => {
  for (const method of PATH_METHODS) {
    it.each(['csv', 'CSV', 'xml', ''])(`${method} rejects f=%j`, async (f) => {
      const fetchFn = neverFetch();
      const err = await caught(
        invoke(client(fetchFn), method, '/market/price_usd_close', { a: 'BTC', f })
      );
      expect(err).toBeInstanceOf(GlassnodeInputError);
      expect((err as GlassnodeInputError).argument).toBe('params.f');
      expect((err as Error).message).toMatch(/only supports JSON/);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each(['json', 'JSON'])(`${method} does not reject an explicit f=%j`, async (f) => {
      const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
      // The canned `[]` body may fail response validation for some methods; only the input
      // check matters here: the request must be sent and must not be a GlassnodeInputError.
      const err = await invoke(client(fetchFn), method, '/market/price_usd_close', { f }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).not.toBeInstanceOf(GlassnodeInputError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  }

  it.each(['json', 'JSON'])('callMetric still accepts an explicit f=%j', async (f) => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
    await client(fetchFn).callMetric('/market/price_usd_close', { a: 'BTC', f });
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metrics/market/price_usd_close?a=BTC&f=json&api_key=${API_KEY}`
    );
  });

  for (const method of PATH_METHODS) {
    it(`${method} rejects api_key in params`, async () => {
      const fetchFn = neverFetch();
      const err = await caught(
        invoke(client(fetchFn), method, '/market/price_usd_close', { api_key: 'other' })
      );
      expect(err).toBeInstanceOf(GlassnodeInputError);
      expect((err as GlassnodeInputError).argument).toBe('params.api_key');
      expect((err as Error).message).toMatch(/apiKey/);
      expect((err as Error).message).not.toContain('other');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  it('rejects api_key in params in x402 mode too (no apiKey configured)', async () => {
    const fetchFn = neverFetch();
    const api = new GlassnodeAPI({ x402: true, fetch: fetchFn as typeof fetch });
    const err = await caught(
      // @ts-expect-error — api_key is typed `never` in MetricParams (also a compile-time error)
      api.callMetric('/market/price_usd_close', { api_key: 'k' })
    );
    expect(err).toBeInstanceOf(GlassnodeInputError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  for (const method of ['getMetricMetadata', 'getMetricStats'] as const) {
    it(`${method} rejects path in params (it would override the metricPath argument)`, async () => {
      const fetchFn = neverFetch();
      const err = await caught(
        client(fetchFn)[method]('/market/price_usd_close', { path: '/market/mvrv' })
      );
      expect(err).toBeInstanceOf(GlassnodeInputError);
      expect((err as GlassnodeInputError).argument).toBe('params.path');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  it('callMetric still passes an unrelated "path" param through unchanged', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue([]) });
    await client(fetchFn).callMetric('/market/price_usd_close', { path: 'x' });
    expect(fetchFn).toHaveBeenCalledWith(
      `${DEFAULT_API_URL}/v1/metrics/market/price_usd_close?path=x&f=json&api_key=${API_KEY}`
    );
  });
});
