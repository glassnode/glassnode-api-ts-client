import { describe, it, expect, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { GlassnodeAPI } from '../src/glassnode-api';
import {
  GlassnodeAbortError,
  GlassnodeError,
  GlassnodeInputError,
  GlassnodeNetworkError,
  GlassnodeValidationError,
} from '../src/errors';
import type { CallOptions } from '../src/types/call-options';
import * as pkg from '../src/index.js';
import { API_KEY } from './constants';
import { mockMetricListResponse } from './mocks/metadata.mock';

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject');
}

function okResponse(body: unknown = mockMetricListResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that never settles on its own: it rejects with the signal's reason once aborted. */
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
}

/** Every public method, called with the given per-call options. */
function everyMethod(api: GlassnodeAPI, options: CallOptions) {
  return {
    getAssetMetadata: () => api.getAssetMetadata(options),
    getMetricList: () => api.getMetricList(options),
    getMetricMetadata: () => api.getMetricMetadata('/market/price_usd_close', {}, options),
    getMetricStats: () => api.getMetricStats('/market/price_usd_close', {}, options),
    callMetric: () => api.callMetric('/market/price_usd_close', { a: 'BTC' }, options),
    callBulkMetric: () => api.callBulkMetric('/market/price_usd_close', { a: '*' }, options),
  };
}

describe('per-call options: signal', () => {
  it('exports GlassnodeAbortError from the package entry', () => {
    expect(pkg.GlassnodeAbortError).toBe(GlassnodeAbortError);
    const err = new GlassnodeAbortError('x');
    expect(err.name).toBe('GlassnodeAbortError');
    expect(err).toBeInstanceOf(GlassnodeError);
    expect(err).not.toBeInstanceOf(GlassnodeNetworkError);
  });

  it('an already-aborted signal rejects every method before any request', async () => {
    const fetchFn = vi.fn();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, maxRetries: 3 });
    const reason = new Error('user navigated away');
    const controller = new AbortController();
    controller.abort(reason);

    for (const [name, call] of Object.entries(everyMethod(api, { signal: controller.signal }))) {
      const err = await caught(call());
      expect(err, name).toBeInstanceOf(GlassnodeAbortError);
      expect((err as GlassnodeAbortError).cause, name).toBe(reason);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('input validation still wins over an already-aborted signal', async () => {
    const fetchFn = vi.fn();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
    const signal = AbortSignal.abort();
    const err = await caught(api.callMetric('no-slash', {}, { signal }));
    expect(err).toBeInstanceOf(GlassnodeInputError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('aborting mid-request cancels the in-flight attempt and is never retried', async () => {
    const fetchFn = hangingFetch();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, maxRetries: 3, retryDelay: 1 });
    const controller = new AbortController();
    const pending = caught(api.getMetricList({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));

    const reason = new Error('cancelled');
    controller.abort(reason);
    const err = await pending;

    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(err).not.toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeAbortError).cause).toBe(reason);
    // Not retried, although the fetch rejected with the abort reason and maxRetries is 3.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a fetch rejecting with a DOMException AbortError after a caller abort is not retried', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      controller.abort();
      throw new DOMException('This operation was aborted', 'AbortError');
    });
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, maxRetries: 3, retryDelay: 1 });
    const err = await caught(api.getMetricList({ signal: controller.signal }));
    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(((err as GlassnodeAbortError).cause as DOMException).name).toBe('AbortError');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('aborting during a retry backoff rejects promptly and makes no further attempt', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 503 }));
    const api = new GlassnodeAPI({
      apiKey: API_KEY,
      fetch: fetchFn,
      maxRetries: 3,
      retryDelay: 60_000,
      maxRetryDelay: 60_000,
    });
    // Force a long backoff (Math.random() * 60s would otherwise often be short).
    const random = vi.spyOn(Math, 'random').mockReturnValue(1);
    const controller = new AbortController();
    const started = Date.now();
    const pending = caught(api.getMetricList({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10)); // now sleeping in the backoff

    controller.abort();
    const err = await pending;
    random.mockRestore();

    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The backoff listener was removed from the caller's signal.
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('a caller abort while a response body is being read is an abort, not a validation error', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(async () => {
      return {
        ok: true,
        text: async () => {
          controller.abort();
          throw new DOMException('This operation was aborted', 'AbortError');
        },
      } as unknown as Response;
    });
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
    const err = await caught(api.getMetricList({ signal: controller.signal }));
    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(err).not.toBeInstanceOf(GlassnodeValidationError);
  });

  it('a caller abort is distinguishable from a timeout', async () => {
    const api = new GlassnodeAPI({
      apiKey: API_KEY,
      fetch: hangingFetch(),
      timeout: 20,
      maxRetries: 0,
    });

    const timeoutErr = await caught(api.getMetricList());
    expect(timeoutErr).toBeInstanceOf(GlassnodeNetworkError);
    expect((timeoutErr as GlassnodeNetworkError).timedOut).toBe(true);

    const controller = new AbortController();
    const pending = caught(api.getMetricList({ signal: controller.signal }));
    controller.abort();
    const abortErr = await pending;
    expect(abortErr).toBeInstanceOf(GlassnodeAbortError);
    expect(abortErr).not.toBeInstanceOf(GlassnodeNetworkError);
  });

  it('a caller AbortSignal.timeout() is a whole-call deadline: GlassnodeAbortError, TimeoutError on .cause', async () => {
    const fetchFn = hangingFetch();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, maxRetries: 3 });
    const err = await caught(api.getMetricList({ signal: AbortSignal.timeout(20) }));
    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(((err as GlassnodeAbortError).cause as DOMException).name).toBe('TimeoutError');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('with only a signal, fetch gets exactly the caller signal', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
    const controller = new AbortController();
    await api.getMetricList({ signal: controller.signal });
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), { signal: controller.signal });
  });
});

describe('per-call options: timeout', () => {
  it('a per-call timeout applies without a config timeout, per attempt, and is retried', async () => {
    const fetchFn = hangingFetch();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, maxRetries: 1, retryDelay: 1 });
    const err = await caught(api.getMetricList({ timeout: 20 }));
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a shorter per-call timeout overrides a long config timeout', async () => {
    const api = new GlassnodeAPI({
      apiKey: API_KEY,
      fetch: hangingFetch(),
      timeout: 60_000,
      maxRetries: 0,
    });
    const started = Date.now();
    const err = await caught(api.getMetricList({ timeout: 20 }));
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a longer per-call timeout overrides a short config timeout', async () => {
    // Answers after 80 ms, unless aborted first.
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(okResponse()), 80);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal!.reason);
          });
        })
    );
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, timeout: 20, maxRetries: 0 });
    await expect(api.getMetricList()).rejects.toBeInstanceOf(GlassnodeNetworkError);
    await expect(api.getMetricList({ timeout: 5_000 })).resolves.toEqual(mockMetricListResponse);
  });
});

describe('per-call options: signal + timeout', () => {
  it('fetch gets one combined signal that follows the caller signal', async () => {
    const fetchFn = hangingFetch();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, timeout: 60_000 });
    const controller = new AbortController();
    const pending = caught(api.getMetricList({ signal: controller.signal }));
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    const passed = fetchFn.mock.calls[0][1]!.signal!;
    expect(passed).not.toBe(controller.signal);
    expect(passed.aborted).toBe(false);

    const reason = new Error('stop');
    controller.abort(reason);
    expect(passed.aborted).toBe(true);
    expect(passed.reason).toBe(reason);
    const err = await pending;
    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect((err as GlassnodeAbortError).cause).toBe(reason);
  });

  it('the timeout still fires through the combined signal as timedOut', async () => {
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: hangingFetch(), maxRetries: 0 });
    const controller = new AbortController();
    const err = await caught(api.getMetricList({ signal: controller.signal, timeout: 20 }));
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect((err as GlassnodeNetworkError).timedOut).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('leaves no listener on a long-lived caller signal across many calls', async () => {
    let n = 0;
    const fetchFn = vi.fn(async () => {
      n++;
      if (n % 3 === 0) throw new TypeError('fetch failed');
      if (n % 3 === 1) return new Response('', { status: 503 });
      return okResponse();
    });
    const api = new GlassnodeAPI({
      apiKey: API_KEY,
      fetch: fetchFn,
      timeout: 60_000,
      maxRetries: 1,
      retryDelay: 1,
    });
    const controller = new AbortController();
    for (let i = 0; i < 200; i++) {
      await api.getMetricList({ signal: controller.signal }).catch(() => undefined);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
    expect(fetchFn.mock.calls.length).toBeGreaterThan(200);
  });
});

describe('per-call options: default path unchanged', () => {
  it('no options, or empty options: a single-argument fetch call with the same URL', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
    await api.getMetricList();
    await api.getMetricList({});
    await api.getMetricList(undefined);
    await api.callMetric('/market/price_usd_close', { a: 'BTC' });
    await api.callMetric('/market/price_usd_close', { a: 'BTC' }, {});
    for (const call of fetchFn.mock.calls) expect(call).toHaveLength(1);
    expect(fetchFn.mock.calls[0]).toEqual(fetchFn.mock.calls[1]);
    expect(fetchFn.mock.calls[3]).toEqual(fetchFn.mock.calls[4]);
  });

  it('config timeout and no options: init still holds only the signal (plus the key header and redirect: manual)', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const api = new GlassnodeAPI({
      apiKey: API_KEY,
      apiKeyLocation: 'header',
      fetch: fetchFn,
      timeout: 5000,
    });
    await api.getMetricList();
    const init = (fetchFn.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(Object.keys(init).sort()).toEqual(['headers', 'redirect', 'signal']);
  });
});

describe('per-call options: validation', () => {
  const bad: [unknown, string][] = [
    ['fast', 'options'],
    [5, 'options'],
    [[], 'options'],
    [{ timeout: 0 }, 'options.timeout'],
    [{ timeout: -1 }, 'options.timeout'],
    [{ timeout: 1.5 }, 'options.timeout'],
    [{ timeout: NaN }, 'options.timeout'],
    [{ timeout: Infinity }, 'options.timeout'],
    [{ timeout: '100' }, 'options.timeout'],
    [{ timeout: 2 ** 31 }, 'options.timeout'],
    [{ signal: {} }, 'options.signal'],
    [{ signal: 'abort' }, 'options.signal'],
    [{ signal: true }, 'options.signal'],
    [{ signal: null }, 'options.signal'],
  ];

  it.each(bad)('rejects %j with argument %s before any request', async (options, argument) => {
    const fetchFn = vi.fn();
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
    const methods = everyMethod(api, options as CallOptions);
    for (const [name, call] of Object.entries(methods)) {
      const err = await caught(call());
      expect(err, name).toBeInstanceOf(GlassnodeInputError);
      expect((err as GlassnodeInputError).argument, name).toBe(argument);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('accepts null options and undefined fields as "no options"', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
    await api.getMetricList(null as unknown as CallOptions);
    await api.getMetricList({ signal: undefined, timeout: undefined });
    for (const call of fetchFn.mock.calls) expect(call).toHaveLength(1);
  });
});
