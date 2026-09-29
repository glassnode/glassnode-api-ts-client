import { describe, it, expect, vi, afterEach } from 'vitest';
import { GlassnodeAPI } from '../src/glassnode-api';
import {
  GlassnodeAbortError,
  GlassnodeApiError,
  GlassnodeConfigError,
  GlassnodeError,
  GlassnodeInputError,
  GlassnodeNetworkError,
  GlassnodePaymentError,
  GlassnodeValidationError,
} from '../src/errors';
import type { GlassnodeConfig } from '../src/types/config';
import type { GlassnodeHooks } from '../src/types/hooks';
import { mockMetricListResponse } from './mocks/metadata.mock';

// Long enough to be raw-masked; contains characters that URL-encoding changes.
const KEY = 'sk-live/abc+def 123';
const KEY_FORMS = [
  KEY,
  encodeURIComponent(KEY),
  new URLSearchParams({ k: KEY }).toString().slice(2),
];
const ENDPOINT = '/v1/metadata/metrics';
const HOOK_NAMES = ['onRequest', 'onResponse', 'onRetry', 'onError'] as const;

type HookName = (typeof HOOK_NAMES)[number];
type Recorded = { hook: HookName; event: Record<string, unknown> };

afterEach(() => {
  vi.restoreAllMocks();
});

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

function statusResponse(status: number, statusText = '', body = '', retryAfter?: string) {
  return new Response(body, {
    status,
    statusText,
    headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
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

/** Hooks that record every event, in order. */
function recorder() {
  const events: Recorded[] = [];
  const hooks: GlassnodeHooks = {
    onRequest: (event) => void events.push({ hook: 'onRequest', event: { ...event } }),
    onResponse: (event) => void events.push({ hook: 'onResponse', event: { ...event } }),
    onRetry: (event) => void events.push({ hook: 'onRetry', event: { ...event } }),
    onError: (event) => void events.push({ hook: 'onError', event: { ...event } }),
  };
  return { events, hooks, sequence: () => events.map((e) => `${e.hook}#${e.event.attempt}`) };
}

function makeApi(fetchFn: unknown, extra: Partial<GlassnodeConfig> = {}) {
  const rec = recorder();
  const api = new GlassnodeAPI({
    apiKey: KEY,
    fetch: fetchFn as typeof fetch,
    hooks: rec.hooks,
    ...extra,
  });
  return { api, ...rec };
}

describe('observability hooks: event sequence and payloads', () => {
  it('success: onRequest then onResponse, with the attempt, status and duration', async () => {
    const { api, events, sequence } = makeApi(vi.fn().mockResolvedValue(okResponse()));
    await api.getMetricList();

    expect(sequence()).toEqual(['onRequest#1', 'onResponse#1']);
    const [req, res] = events.map((e) => e.event);
    expect(req).toEqual({
      callId: expect.any(Number),
      method: 'GET',
      endpoint: ENDPOINT,
      url: 'https://api.glassnode.com/v1/metadata/metrics?api_key=***',
      attempt: 1,
      // The default maxRetries (2): up to 3 attempts, even though the first one succeeds.
      maxAttempts: 3,
    });
    expect(res).toEqual({
      ...req,
      status: 200,
      ok: true,
      durationMs: expect.any(Number),
    });
    expect(res.durationMs as number).toBeGreaterThanOrEqual(0);
  });

  it('retry on 503 then success: onRetry carries reason, status, delay and the error', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(statusResponse(503, 'Service Unavailable', '', '0'))
      .mockResolvedValueOnce(okResponse());
    const logger = vi.fn();
    const { api, events, sequence } = makeApi(fetchFn, { maxRetries: 2, logger });
    await api.getMetricList();

    expect(sequence()).toEqual([
      'onRequest#1',
      'onResponse#1',
      'onRetry#1',
      'onRequest#2',
      'onResponse#2',
    ]);
    const callIds = new Set(events.map((e) => e.event.callId));
    expect(callIds.size).toBe(1);
    expect(events.every((e) => e.event.maxAttempts === 3)).toBe(true);
    expect(events[1].event).toMatchObject({ status: 503, ok: false });
    const retry = events[2].event;
    expect(retry).toMatchObject({
      endpoint: ENDPOINT,
      attempt: 1,
      maxAttempts: 3,
      reason: 'status',
      status: 503,
      delayMs: 0,
      durationMs: expect.any(Number),
    });
    expect(retry.error).toBeInstanceOf(GlassnodeApiError);
    expect((retry.error as GlassnodeApiError).status).toBe(503);
    // Same wait as the logger reports.
    expect(logger).toHaveBeenCalledWith('Retry 1/2 after 0ms');
    expect(events[4].event).toMatchObject({ status: 200, ok: true, attempt: 2 });
  });

  it('network error retry: reason "network", no status, a GlassnodeNetworkError', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse());
    const { api, events, sequence } = makeApi(fetchFn, { maxRetries: 1, retryDelay: 1 });
    await api.getMetricList();

    expect(sequence()).toEqual(['onRequest#1', 'onRetry#1', 'onRequest#2', 'onResponse#2']);
    const retry = events[1].event;
    expect(retry.reason).toBe('network');
    expect(retry).not.toHaveProperty('status');
    expect(retry.error).toBeInstanceOf(GlassnodeNetworkError);
    expect((retry.error as GlassnodeNetworkError).timedOut).toBe(false);
    expect(typeof retry.delayMs).toBe('number');
    expect(retry.delayMs as number).toBeGreaterThanOrEqual(0);
    expect(retry.delayMs as number).toBeLessThanOrEqual(1);
  });

  it('timeout: reason "timeout" on retry, then onError with the timed-out error', async () => {
    const { api, events, sequence } = makeApi(hangingFetch(), {
      maxRetries: 1,
      retryDelay: 1,
      timeout: 20,
    });
    const err = await caught(api.getMetricList());

    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect(sequence()).toEqual(['onRequest#1', 'onRetry#1', 'onRequest#2', 'onError#2']);
    expect(events[1].event.reason).toBe('timeout');
    const onError = events[3].event;
    expect(onError.error).toBe(err);
    expect((onError.error as GlassnodeNetworkError).timedOut).toBe(true);
    expect(onError).toMatchObject({ endpoint: ENDPOINT, attempt: 2, maxAttempts: 2 });
    expect(onError.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(onError.elapsedMs as number).toBeGreaterThanOrEqual(onError.durationMs as number);
    expect(onError).not.toHaveProperty('status');
  });

  it('abort in flight: onError with the GlassnodeAbortError, no retry', async () => {
    const { api, events, sequence } = makeApi(hangingFetch(), { maxRetries: 3 });
    const controller = new AbortController();
    const pending = api.getMetricList({ signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const err = await caught(pending);

    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(sequence()).toEqual(['onRequest#1', 'onError#1']);
    expect(events[1].event.error).toBe(err);
  });

  it('abort during a retry wait: onRetry then onError, no further request', async () => {
    const fetchFn = vi.fn().mockResolvedValue(statusResponse(503));
    const { api, events, sequence } = makeApi(fetchFn, {
      maxRetries: 3,
      retryDelay: 60_000,
      maxRetryDelay: 60_000,
    });
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const controller = new AbortController();
    const pending = api.getMetricList({ signal: controller.signal });
    await vi.waitFor(() => expect(events.some((e) => e.hook === 'onRetry')).toBe(true));
    controller.abort();
    const err = await caught(pending);

    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(sequence()).toEqual(['onRequest#1', 'onResponse#1', 'onRetry#1', 'onError#1']);
    expect(events[2].event.delayMs).toBe(60_000);
  });

  it('already-aborted signal: only onError, with attempt 0 and no duration', async () => {
    const fetchFn = vi.fn();
    const { api, events, sequence } = makeApi(fetchFn);
    const controller = new AbortController();
    controller.abort();
    const err = await caught(api.getMetricList({ signal: controller.signal }));

    expect(fetchFn).not.toHaveBeenCalled();
    expect(sequence()).toEqual(['onError#0']);
    expect(events[0].event.error).toBe(err);
    expect(events[0].event).not.toHaveProperty('durationMs');
    expect(events[0].event.elapsedMs).toEqual(expect.any(Number));
  });

  it('non-retryable status: onResponse then onError with the status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(statusResponse(404, 'Not Found'));
    const { api, events, sequence } = makeApi(fetchFn, { maxRetries: 3 });
    const err = await caught(api.getMetricList());

    expect(err).toBeInstanceOf(GlassnodeApiError);
    expect(sequence()).toEqual(['onRequest#1', 'onResponse#1', 'onError#1']);
    expect(events[2].event).toMatchObject({ status: 404, error: err });
  });

  it('retries exhausted on 503: onError carries the final status', async () => {
    const fetchFn = vi.fn().mockResolvedValue(statusResponse(503, '', '', '0'));
    const { api, events, sequence } = makeApi(fetchFn, { maxRetries: 1 });
    await caught(api.getMetricList());
    expect(sequence()).toEqual([
      'onRequest#1',
      'onResponse#1',
      'onRetry#1',
      'onRequest#2',
      'onResponse#2',
      'onError#2',
    ]);
    expect(events[5].event.status).toBe(503);
  });

  it('schema validation error of a 200: onResponse (ok) then onError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ not: 'a list' }));
    const { api, events, sequence } = makeApi(fetchFn);
    const err = await caught(api.getMetricList());

    expect(err).toBeInstanceOf(GlassnodeValidationError);
    expect(sequence()).toEqual(['onRequest#1', 'onResponse#1', 'onError#1']);
    expect(events[1].event).toMatchObject({ status: 200, ok: true });
    expect(events[2].event.error).toBe(err);
    expect(events[2].event).not.toHaveProperty('status');
  });

  it('unparseable 200 body and callMetric schema mismatch also reach onError', async () => {
    const bad = new Response('<html>', { status: 200 });
    const { api, sequence } = makeApi(
      vi
        .fn()
        .mockResolvedValueOnce(bad)
        .mockResolvedValueOnce(okResponse({ x: 1 }))
    );
    const { z } = await import('zod');
    expect(await caught(api.callMetric('/market/price_usd_close'))).toBeInstanceOf(
      GlassnodeValidationError
    );
    expect(
      await caught(api.callMetric('/market/price_usd_close', {}, { schema: z.array(z.number()) }))
    ).toBeInstanceOf(GlassnodeValidationError);
    expect(sequence()).toEqual([
      'onRequest#1',
      'onResponse#1',
      'onError#1',
      'onRequest#1',
      'onResponse#1',
      'onError#1',
    ]);
  });

  it('input errors fire no hooks: nothing was sent', async () => {
    const fetchFn = vi.fn();
    const { api, events } = makeApi(fetchFn);
    const inputs = [
      api.callMetric('market/price_usd_close'),
      api.callMetric('/market/price_usd_close', { api_key: 'x' } as never),
      api.getMetricList({ timeout: -1 }),
      api.callMetric('/m', {}, { schema: 'nope' } as never),
    ];
    for (const p of inputs) expect(await caught(p)).toBeInstanceOf(GlassnodeInputError);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('gives each call its own callId, shared by its attempts', async () => {
    const fetchFn = vi.fn(async () => okResponse());
    const { api, events } = makeApi(fetchFn);
    await Promise.all([api.getMetricList(), api.getMetricList(), api.getMetricList()]);
    const ids = events.filter((e) => e.hook === 'onRequest').map((e) => e.event.callId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(events.filter((e) => e.event.callId === id).map((e) => e.hook)).toEqual([
        'onRequest',
        'onResponse',
      ]);
    }
  });

  it('each hook is optional', async () => {
    const onResponse = vi.fn();
    const api = new GlassnodeAPI({
      apiKey: KEY,
      fetch: vi.fn().mockResolvedValue(okResponse()),
      hooks: { onResponse },
    });
    await api.getMetricList();
    expect(onResponse).toHaveBeenCalledTimes(1);
  });
});

describe('observability hooks: a failing hook never breaks a call', () => {
  function throwingHooks(kind: 'throw' | 'reject') {
    const calls: string[] = [];
    const make = (name: HookName) =>
      vi.fn(() => {
        calls.push(name);
        if (kind === 'throw') throw new Error(`boom from ${name}`);
        return Promise.reject(new Error(`boom from ${name}`));
      });
    const hooks = Object.fromEntries(HOOK_NAMES.map((n) => [n, make(n)])) as GlassnodeHooks;
    return { hooks, calls };
  }

  for (const kind of ['throw', 'reject'] as const) {
    it(`hooks that ${kind}: success with a retry is unchanged`, async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(statusResponse(503, '', '', '0'))
        .mockResolvedValueOnce(okResponse());
      const { hooks, calls } = throwingHooks(kind);
      const api = new GlassnodeAPI({ apiKey: KEY, fetch: fetchFn, maxRetries: 1, hooks });
      await expect(api.getMetricList()).resolves.toEqual(mockMetricListResponse);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(['onRequest', 'onResponse', 'onRetry', 'onRequest', 'onResponse']);
      // Let any rejection handlers run; an unhandled rejection would fail the test run.
      await new Promise((r) => setTimeout(r, 0));
    });

    it(`hooks that ${kind}: the failure is the same error as without hooks`, async () => {
      const fetchFn = vi.fn().mockResolvedValue(statusResponse(400, 'Bad Request'));
      const { hooks, calls } = throwingHooks(kind);
      const api = new GlassnodeAPI({ apiKey: KEY, fetch: fetchFn, maxRetries: 3, hooks });
      const err = await caught(api.getMetricList());
      expect(err).toBeInstanceOf(GlassnodeApiError);
      expect((err as GlassnodeApiError).status).toBe(400);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['onRequest', 'onResponse', 'onError']);
      await new Promise((r) => setTimeout(r, 0));
    });

    it(`hooks that ${kind} are reported through the logger`, async () => {
      const logger = vi.fn();
      const { hooks } = throwingHooks(kind);
      const api = new GlassnodeAPI({
        apiKey: KEY,
        fetch: vi.fn().mockResolvedValue(okResponse()),
        hooks,
        logger,
      });
      await api.getMetricList();
      await new Promise((r) => setTimeout(r, 0));
      const failures = logger.mock.calls.filter(([m]) => String(m).startsWith('Hook '));
      expect(failures.map(([m]) => m)).toEqual([
        'Hook onRequest failed:',
        'Hook onResponse failed:',
      ]);
      expect(failures[0][1]).toBeInstanceOf(Error);
    });
  }

  it('a logger that throws while reporting a hook failure is swallowed too', async () => {
    const logger = vi.fn((message: string) => {
      if (message.startsWith('Hook ')) throw new Error('logger down');
    });
    const api = new GlassnodeAPI({
      apiKey: KEY,
      fetch: vi.fn().mockResolvedValue(okResponse()),
      logger,
      hooks: {
        onRequest: () => {
          throw new Error('boom');
        },
      },
    });
    await expect(api.getMetricList()).resolves.toEqual(mockMetricListResponse);
  });

  it('a slow async hook is not awaited', async () => {
    const never = new Promise<void>(() => {});
    const onRequest = vi.fn(() => never);
    const onResponse = vi.fn(() => never);
    const api = new GlassnodeAPI({
      apiKey: KEY,
      fetch: vi.fn().mockResolvedValue(okResponse()),
      hooks: { onRequest, onResponse },
    });
    await expect(api.getMetricList()).resolves.toEqual(mockMetricListResponse);
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledTimes(1);
  });
});

describe('observability hooks: the API key never appears in a payload', () => {
  /** Every string reachable in an event: its own fields and the error's string fields. */
  function payloadStrings(event: Record<string, unknown>): string[] {
    const out: string[] = [];
    for (const value of Object.values(event)) {
      if (typeof value === 'string') out.push(value);
      if (value instanceof GlassnodeError) {
        const e = value as unknown as Record<string, unknown>;
        for (const name of new Set([...Object.getOwnPropertyNames(e), 'message', 'name'])) {
          if (typeof e[name] === 'string') out.push(e[name] as string);
        }
      }
    }
    out.push(JSON.stringify(event));
    return out;
  }

  for (const location of ['query', 'header'] as const) {
    it(`apiKeyLocation "${location}": no key in any event of a retried, failing call`, async () => {
      const fetchFn = vi
        .fn()
        // A transport error that quotes the key, a 503 whose status text echoes it, and a
        // terminal 400 whose body echoes it.
        .mockRejectedValueOnce(new TypeError(`connect failed for api_key=${KEY} (${KEY})`))
        .mockResolvedValueOnce(statusResponse(503, `busy ${KEY}`, '', '0'))
        .mockResolvedValueOnce(
          statusResponse(400, `bad ${KEY}`, JSON.stringify({ message: `bad key ${KEY}` }))
        );
      const { api, events } = makeApi(fetchFn, {
        apiKeyLocation: location,
        maxRetries: 2,
        retryDelay: 1,
      });
      await caught(api.callMetric('/market/price_usd_close', { a: 'BTC' }));

      expect(events.map((e) => e.hook)).toEqual([
        'onRequest',
        'onRetry',
        'onRequest',
        'onResponse',
        'onRetry',
        'onRequest',
        'onResponse',
        'onError',
      ]);
      for (const { event } of events) {
        for (const text of payloadStrings(event)) {
          for (const form of KEY_FORMS) expect(text).not.toContain(form);
        }
      }
      const url = events[0].event.url as string;
      if (location === 'query') expect(url).toContain('api_key=***');
      else expect(url).not.toContain('api_key');
    });
  }

  it('x402: events carry no headers — only the documented fields', async () => {
    const x402Fetch = vi.fn(async () => {
      throw new GlassnodePaymentError('paid request failed', {
        paymentMayHaveSettled: true,
        status: 502,
      });
    });
    const rec = recorder();
    const api = new GlassnodeAPI({ x402: true, fetch: x402Fetch, hooks: rec.hooks });
    const err = await caught(api.getMetricList());
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(rec.sequence()).toEqual(['onRequest#1', 'onError#1']);

    const allowed = new Set([
      'callId',
      'method',
      'endpoint',
      'url',
      'attempt',
      'maxAttempts',
      'status',
      'ok',
      'durationMs',
      'elapsedMs',
      'reason',
      'delayMs',
      'error',
    ]);
    for (const { event } of rec.events) {
      for (const key of Object.keys(event)) expect(allowed.has(key), key).toBe(true);
    }
    expect(rec.events[1].event).toMatchObject({ status: 502, error: err });
    expect(rec.events[0].event.url).toBe('https://x402.glassnode.com/v1/metadata/metrics?');
  });
});

describe('observability hooks: the logger is unchanged', () => {
  it('logs exactly the same messages with and without hooks', async () => {
    const run = async (withHooks: boolean) => {
      const logger = vi.fn();
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce(statusResponse(503, '', '', '0'))
        .mockResolvedValueOnce(okResponse());
      const api = new GlassnodeAPI({
        apiKey: KEY,
        fetch: fetchFn,
        maxRetries: 1,
        logger,
        ...(withHooks ? { hooks: recorder().hooks } : {}),
      });
      await api.getMetricList();
      return logger.mock.calls;
    };
    const without = await run(false);
    expect(without).toEqual([
      ['API call:', 'https://api.glassnode.com/v1/metadata/metrics?api_key=***'],
      ['Retry 1/1 after 0ms'],
      ['API call:', 'https://api.glassnode.com/v1/metadata/metrics?api_key=***'],
    ]);
    expect(await run(true)).toEqual(without);
  });
});

describe('observability hooks: config validation', () => {
  const fetchFn = vi.fn() as unknown as typeof fetch;

  it('accepts an empty hooks object and omitted hooks', () => {
    expect(() => new GlassnodeAPI({ apiKey: KEY, fetch: fetchFn, hooks: {} })).not.toThrow();
    expect(() => new GlassnodeAPI({ apiKey: KEY, fetch: fetchFn })).not.toThrow();
  });

  it.each([
    ['hooks is not an object', 'nope'],
    ['a hook is not a function', { onRequest: 'nope' }],
    ['an unknown hook name', { onReqeust: () => {} }],
  ])('rejects the config when %s', (_label, hooks) => {
    expect(() => new GlassnodeAPI({ apiKey: KEY, fetch: fetchFn, hooks } as never)).toThrow(
      GlassnodeConfigError
    );
  });

  it('keeps the hook functions as given (not wrapped)', async () => {
    const hooks = { onRequest: vi.fn() };
    const api = new GlassnodeAPI({
      apiKey: KEY,
      fetch: vi.fn().mockResolvedValue(okResponse()),
      hooks,
    });
    await api.getMetricList();
    expect(hooks.onRequest).toHaveBeenCalledTimes(1);
    expect(hooks.onRequest.mock.calls[0]).toHaveLength(1);
  });
});
