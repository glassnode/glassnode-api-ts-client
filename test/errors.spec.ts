import { describe, it, expect, vi } from 'vitest';
import { ZodError } from 'zod';
import * as pkg from '../src/index.js';
import { GlassnodeAPI } from '../src/glassnode-api.js';
import {
  GlassnodeError,
  GlassnodeApiError,
  GlassnodeNetworkError,
  GlassnodeValidationError,
  GlassnodeConfigError,
  GlassnodePaymentError,
} from '../src/errors.js';
import { API_KEY, BAD_REQUEST_ERROR } from './constants.js';
import { mockMetricListResponse } from './mocks/metadata.mock.js';

function api(fetchFn: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn as typeof fetch, ...extra });
}

function okJson(body: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(body) });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject');
}

describe('error hierarchy', () => {
  it('exports every error class from the package entry', () => {
    expect(pkg.GlassnodeError).toBe(GlassnodeError);
    expect(pkg.GlassnodeApiError).toBe(GlassnodeApiError);
    expect(pkg.GlassnodeNetworkError).toBe(GlassnodeNetworkError);
    expect(pkg.GlassnodeValidationError).toBe(GlassnodeValidationError);
    expect(pkg.GlassnodeConfigError).toBe(GlassnodeConfigError);
    expect(pkg.GlassnodePaymentError).toBe(GlassnodePaymentError);
  });

  it('sets name and prototype chain on each class', () => {
    const cases: [Error, string][] = [
      [new GlassnodeError('x'), 'GlassnodeError'],
      [new GlassnodeApiError(500, 'Internal Server Error'), 'GlassnodeApiError'],
      [new GlassnodeNetworkError('x', { timedOut: false }), 'GlassnodeNetworkError'],
      [new GlassnodeValidationError('x', { endpoint: '/e' }), 'GlassnodeValidationError'],
      [new GlassnodeConfigError('x'), 'GlassnodeConfigError'],
      [new GlassnodePaymentError('x'), 'GlassnodePaymentError'],
    ];
    for (const [err, name] of cases) {
      expect(err.name).toBe(name);
      expect(err).toBeInstanceOf(GlassnodeError);
      expect(err).toBeInstanceOf(Error);
      expect(err.constructor.name).toBe(name);
    }
  });

  it('keeps GlassnodeApiError backward compatible', () => {
    const err = new GlassnodeApiError(400, 'Bad Request', 'Resolution 1h is not allowed');
    expect(err).toBeInstanceOf(GlassnodeError);
    expect(err.message).toBe(`${BAD_REQUEST_ERROR} — Resolution 1h is not allowed`);
    expect(err.status).toBe(400);
    expect(err.statusText).toBe('Bad Request');
    expect(err.detail).toBe('Resolution 1h is not allowed');
    expect(err.isRetryable).toBe(false);
    expect(new GlassnodeApiError(429, 'Too Many Requests').isRetryable).toBe(true);
    expect(new GlassnodeApiError(503, 'Service Unavailable').isRetryable).toBe(true);
    expect(new GlassnodeApiError(418, 'Teapot').message).toBe('API request failed (418): Teapot');
  });
});

describe('client failure paths', () => {
  it('HTTP error status -> GlassnodeApiError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' });
    const err = await caught(api(fetchFn).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeApiError);
    expect(err).toBeInstanceOf(GlassnodeError);
  });

  it('network failure -> GlassnodeNetworkError with timedOut=false and cause', async () => {
    const cause = new TypeError('Failed to fetch');
    const err = await caught(
      api(vi.fn().mockRejectedValue(cause), { maxRetries: 0 }).getMetricList()
    );
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect(err).toBeInstanceOf(GlassnodeError);
    const e = err as GlassnodeNetworkError;
    expect(e.timedOut).toBe(false);
    expect(e.cause).toBe(cause);
    expect(e.message).toBe('Glassnode API error: Failed to fetch');
  });

  it('timeout -> GlassnodeNetworkError with timedOut=true', async () => {
    const cause = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const err = await caught(
      api(vi.fn().mockRejectedValue(cause), { timeout: 10, maxRetries: 0 }).getMetricList()
    );
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
    expect((err as GlassnodeNetworkError).cause).toBe(cause);
  });

  it('a real AbortSignal.timeout() firing sets timedOut=true', async () => {
    // A fetch that never resolves on its own and rejects with the signal's reason when aborted.
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })
    );
    const err = await caught(api(fetchFn, { timeout: 5, maxRetries: 0 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
  });

  it('a non-timeout abort is not reported as timedOut', async () => {
    const cause = new DOMException('The operation was aborted', 'AbortError');
    const err = await caught(
      api(vi.fn().mockRejectedValue(cause), { maxRetries: 0 }).getMetricList()
    );
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(false);
  });

  it('a non-Error rejection -> GlassnodeNetworkError', async () => {
    const err = await caught(api(vi.fn().mockRejectedValue('boom')).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).cause).toBe('boom');
  });

  it('a GlassnodeError rejected by fetch is rethrown unchanged and not retried', async () => {
    const paymentError = new GlassnodePaymentError('x402 payment failed: declined');
    const fetchFn = vi.fn().mockRejectedValue(paymentError);
    const err = await caught(api(fetchFn, { maxRetries: 3, retryDelay: 1 }).getMetricList());
    expect(err).toBe(paymentError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('network errors are still retried, and the final one is a GlassnodeNetworkError', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await caught(api(fetchFn, { maxRetries: 2, retryDelay: 1 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('unparseable 200 body -> GlassnodeValidationError (not retried)', async () => {
    const cause = new SyntaxError('Unexpected token < in JSON');
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: vi.fn().mockRejectedValue(cause) });
    const err = await caught(api(fetchFn, { maxRetries: 3, retryDelay: 1 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeValidationError);
    expect(err).toBeInstanceOf(GlassnodeError);
    const e = err as GlassnodeValidationError;
    expect(e.cause).toBe(cause);
    expect(e.endpoint).toBe('/v1/metadata/metrics');
    expect(e.message).toBe('Glassnode API error: failed to parse response body as JSON');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('never puts the API key in a validation error endpoint', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockRejectedValue(new SyntaxError('bad')),
    });
    const err = (await caught(
      api(fetchFn).callMetric('/market/price_usd_close', { a: 'BTC' })
    )) as GlassnodeValidationError;
    expect(err).toBeInstanceOf(GlassnodeValidationError);
    expect(err.endpoint).toBe('/v1/metrics/market/price_usd_close');
    expect(err.message).not.toContain(API_KEY);
  });

  const schemaCases: [string, (a: GlassnodeAPI) => Promise<unknown>, unknown, string][] = [
    ['getAssetMetadata', (a) => a.getAssetMetadata(), { data: [{ id: 1 }] }, '/v1/metadata/assets'],
    [
      'getMetricMetadata',
      (a) => a.getMetricMetadata('/market/price_usd_close'),
      { nope: true },
      '/v1/metadata/metric',
    ],
    [
      'getMetricStats',
      (a) => a.getMetricStats('/market/price_usd_close'),
      { nope: true },
      '/v1/metadata/metric/stats',
    ],
    ['getMetricList', (a) => a.getMetricList(), { nope: true }, '/v1/metadata/metrics'],
    [
      'callBulkMetric',
      (a) => a.callBulkMetric('/market/marketcap_usd'),
      { data: 'nope' },
      '/v1/metrics/market/marketcap_usd/bulk',
    ],
  ];

  for (const [name, call, body, endpoint] of schemaCases) {
    it(`${name}: schema mismatch -> GlassnodeValidationError with endpoint and ZodError cause`, async () => {
      const err = await caught(call(api(okJson(body), { maxRetries: 3, retryDelay: 1 })));
      expect(err).toBeInstanceOf(GlassnodeValidationError);
      expect(err).toBeInstanceOf(GlassnodeError);
      expect(err).not.toBeInstanceOf(ZodError);
      const e = err as GlassnodeValidationError;
      expect(e.endpoint).toBe(endpoint);
      expect(e.cause).toBeInstanceOf(ZodError);
      expect(e.message).toContain(endpoint);
    });
  }

  it('does not retry schema validation failures', async () => {
    const fetchFn = okJson({ nope: true });
    await caught(api(fetchFn, { maxRetries: 3, retryDelay: 1 }).getMetricList());
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('valid responses still parse', async () => {
    await expect(api(okJson(mockMetricListResponse)).getMetricList()).resolves.toEqual(
      mockMetricListResponse
    );
  });
});

describe('config errors', () => {
  it('invalid constructor config -> GlassnodeConfigError with ZodError cause', () => {
    let err: unknown;
    try {
      new GlassnodeAPI({ apiKey: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GlassnodeConfigError);
    expect(err).toBeInstanceOf(GlassnodeError);
    expect(err).not.toBeInstanceOf(ZodError);
    const e = err as GlassnodeConfigError;
    expect(e.cause).toBeInstanceOf(ZodError);
    expect(e.message).toMatch(/apiKey/);
  });

  it('x402 without fetch -> GlassnodeConfigError mentioning fetch', () => {
    expect(() => new GlassnodeAPI({ x402: true })).toThrow(GlassnodeConfigError);
    expect(() => new GlassnodeAPI({ x402: true })).toThrow(/fetch/);
  });

  it('bad numeric option -> GlassnodeConfigError', () => {
    expect(() => new GlassnodeAPI({ apiKey: API_KEY, timeout: -1 })).toThrow(GlassnodeConfigError);
  });
});

// Classification is by the rejection's *shape* (its `name`), not `instanceof Error`: a DOMException
// from another realm, a polyfill or a custom fetch may reject with something that is not an Error.
describe('transport rejection classification', () => {
  it('a non-Error object named TimeoutError -> timedOut=true, message and cause kept', async () => {
    const cause = { name: 'TimeoutError', message: 'The operation timed out' };
    const err = await caught(
      api(vi.fn().mockRejectedValue(cause), { timeout: 10, maxRetries: 0 }).getMetricList()
    );
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    const e = err as GlassnodeNetworkError;
    expect(e.timedOut).toBe(true);
    expect(e.cause).toBe(cause);
    expect(e.message).toBe('Glassnode API error: The operation timed out');
  });

  it('a non-Error TimeoutError without a message falls back to its name', async () => {
    const err = await caught(
      api(vi.fn().mockRejectedValue({ name: 'TimeoutError' }), { maxRetries: 0 }).getMetricList()
    );
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
    expect((err as GlassnodeNetworkError).message).toBe('Glassnode API error: TimeoutError');
  });

  it('a non-Error TimeoutError is retried like other network errors', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce({ name: 'TimeoutError', message: 'timed out' })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue(mockMetricListResponse) });
    const result = await api(fetchFn, { maxRetries: 1, retryDelay: 1 }).getMetricList();
    expect(result).toEqual(mockMetricListResponse);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a persistent non-Error TimeoutError exhausts retries and ends timedOut=true', async () => {
    const fetchFn = vi.fn().mockRejectedValue({ name: 'TimeoutError' });
    const err = await caught(api(fetchFn, { maxRetries: 2, retryDelay: 1 }).getMetricList());
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
  });

  it('a non-Error object named AbortError -> retried network error, timedOut=false', async () => {
    const cause = { name: 'AbortError', message: 'aborted' };
    const fetchFn = vi.fn().mockRejectedValue(cause);
    const err = await caught(api(fetchFn, { maxRetries: 1, retryDelay: 1 }).getMetricList());
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    const e = err as GlassnodeNetworkError;
    expect(e.timedOut).toBe(false);
    expect(e.cause).toBe(cause);
    expect(e.message).toBe('Glassnode API error: aborted');
  });

  it('a DOMException TimeoutError is retried and ends timedOut=true', async () => {
    const cause = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fetchFn = vi.fn().mockRejectedValue(cause);
    const err = await caught(
      api(fetchFn, { maxRetries: 1, retryDelay: 1, timeout: 10 }).getMetricList()
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
    expect((err as GlassnodeNetworkError).cause).toBe(cause);
  });

  it('a real AbortSignal.timeout() firing is retried with a fresh signal per attempt', async () => {
    const signals: AbortSignal[] = [];
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          signals.push(init!.signal!);
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
        })
    );
    const err = await caught(
      api(fetchFn, { timeout: 5, maxRetries: 1, retryDelay: 1 }).getMetricList()
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
  });

  it('a non-Error rejection that is not shaped like an error stays "Unknown", not retried', async () => {
    for (const cause of ['boom', { code: 'ECONNRESET' }, null, undefined, 42]) {
      const fetchFn = vi.fn().mockRejectedValue(cause);
      const err = await caught(api(fetchFn, { maxRetries: 2, retryDelay: 1 }).getMetricList());
      expect(err).toBeInstanceOf(GlassnodeNetworkError);
      const e = err as GlassnodeNetworkError;
      expect(e.message).toBe('Unknown error occurred');
      expect(e.timedOut).toBe(false);
      expect(e.cause).toBe(cause);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  });

  it('never puts the API key in the error message', async () => {
    const leaky = `request to https://api.glassnode.com/v1/x?api_key=${API_KEY}&a=BTC failed`;
    for (const cause of [new TypeError(leaky), { name: 'TimeoutError', message: leaky }]) {
      const err = await caught(
        api(vi.fn().mockRejectedValue(cause), { maxRetries: 0 }).getMetricList()
      );
      expect((err as Error).message).not.toContain(API_KEY);
      expect((err as Error).message).toContain('api_key=***');
    }
  });
});
