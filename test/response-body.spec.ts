import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlassnodeAPI } from '../src/glassnode-api';
import {
  GlassnodeAbortError,
  GlassnodeNetworkError,
  GlassnodeValidationError,
} from '../src/errors';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })
  );
});

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return `http://127.0.0.1:${address.port}`;
}

describe('response body transport and cancellation', () => {
  it('parses text independently of a polyfill json() that wraps malformed JSON in FetchError', async () => {
    const response = new Response('not json');
    const json = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('invalid JSON'), { name: 'FetchError' }));
    response.json = json;
    const fetchFn = vi.fn().mockResolvedValue(response);
    const onRetry = vi.fn();
    const api = new GlassnodeAPI({ apiKey: 'unused', fetch: fetchFn, hooks: { onRetry } });
    const error = await api.getMetricList().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlassnodeValidationError);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'reset'])(
    'does not repeat a plain payment fetch after a paid 200 body %s',
    async (kind) => {
      const apiUrl = await serve((_req, res) => {
        res.writeHead(200);
        res.write('[');
        if (kind === 'reset') setTimeout(() => res.destroy(), 20);
      });
      const payment = vi.fn();
      const fetchFn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        payment();
        return fetch(input, init);
      });
      const onResponse = vi.fn();
      const onRetry = vi.fn();
      const api = new GlassnodeAPI({
        x402: true,
        apiUrl,
        fetch: fetchFn,
        maxRetries: 2,
        timeout: 1000,
        retryDelay: 1,
        hooks: { onResponse, onRetry },
      });
      const error = await api.getMetricList().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GlassnodeNetworkError);
      expect((error as GlassnodeNetworkError).timedOut).toBe(kind === 'timeout');
      expect(payment).toHaveBeenCalledOnce();
      expect(onResponse).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
    }
  );

  it.each(['fetch', 'body'])(
    'preserves payment errors from another package copy in the %s path',
    async (path) => {
      const error = Object.assign(new Error('payment may have settled'), {
        name: 'GlassnodePaymentError',
        paymentMayHaveSettled: true,
      });
      const fetchFn =
        path === 'fetch'
          ? vi.fn().mockRejectedValue(error)
          : vi.fn().mockResolvedValue(
              new Response(
                new ReadableStream({
                  start(c) {
                    c.error(error);
                  },
                })
              )
            );
      const api = new GlassnodeAPI({ x402: true, fetch: fetchFn, maxRetries: 2, retryDelay: 1 });
      await expect(api.getMetricList()).rejects.toBe(error);
      expect(fetchFn).toHaveBeenCalledOnce();
    }
  );

  it('does not wait for a discarded body cancellation that never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
      .mockResolvedValueOnce(new Response('[]'));
    const api = new GlassnodeAPI({ apiKey: 'unused', fetch: fetchFn, retryDelay: 1 });
    await expect(api.getMetricList()).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each(['consumed', 'locked', 'missing text', 'custom text'])(
    'does not retry a deterministic response failure: %s',
    async (kind) => {
      const response = new Response('[]');
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cause = new Error('custom parser failed');
      if (kind === 'consumed') await response.json();
      if (kind === 'locked') reader = response.body!.getReader();
      if (kind === 'missing text') Object.defineProperty(response, 'text', { value: undefined });
      if (kind === 'custom text') {
        response.text = vi.fn().mockRejectedValue(cause);
      }
      const fetchFn = vi.fn().mockResolvedValue(response);
      const onRetry = vi.fn();
      const api = new GlassnodeAPI({
        apiKey: 'unused',
        fetch: fetchFn,
        retryDelay: 1,
        hooks: { onRetry },
      });
      try {
        const error = await api.getMetricList().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GlassnodeValidationError);
        expect((error as Error).cause).toBeInstanceOf(Error);
        if (kind === 'custom text') expect((error as Error).cause).toBe(cause);
        expect(fetchFn).toHaveBeenCalledOnce();
        expect(onRetry).not.toHaveBeenCalled();
      } finally {
        reader?.releaseLock();
      }
    }
  );

  it('retries an arbitrary error raised by a response body stream', async () => {
    const cause = new Error('stream failed');
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.error(cause);
        },
      })
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response('[]'));
    const onRetry = vi.fn();
    const api = new GlassnodeAPI({
      apiKey: 'unused',
      fetch: fetchFn,
      retryDelay: 1,
      hooks: { onRetry },
    });
    await expect(api.getMetricList()).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0].error).toMatchObject({ cause });
    expect(onRetry.mock.calls[0][0].reason).toBe('network');
  });

  it('retries timeouts after real 200 headers with fresh attempt signals and timeout hooks', async () => {
    const apiUrl = await serve((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
    });
    const onRetry = vi.fn();
    const signals: (AbortSignal | null | undefined)[] = [];
    const api = new GlassnodeAPI({
      apiKey: 'unused',
      apiUrl,
      timeout: 1000,
      retryDelay: 1,
      hooks: { onRetry },
      fetch: (url, init) => {
        signals.push(init?.signal);
        return fetch(url, init);
      },
    });
    const error = await api.getMetricList().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlassnodeNetworkError);
    expect((error as GlassnodeNetworkError).timedOut).toBe(true);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(3);
    expect(onRetry.mock.calls.map(([event]) => event.reason)).toEqual(['timeout', 'timeout']);
  });

  it('retries a real connection reset during a 200 body and then succeeds', async () => {
    let requests = 0;
    const apiUrl = await serve((_req, res) => {
      requests++;
      if (requests > 1) {
        res.end('[]');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
      setTimeout(() => res.destroy(), 20);
    });
    const onRetry = vi.fn();
    const api = new GlassnodeAPI({ apiKey: 'unused', apiUrl, retryDelay: 1, hooks: { onRetry } });
    await expect(api.getMetricList()).resolves.toEqual([]);
    expect(requests).toBe(2);
    expect(onRetry.mock.calls[0][0].reason).toBe('network');
  });

  it.each([200, 400, 503])('preserves caller cancellation after %i headers', async (status) => {
    let requests = 0;
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const apiUrl = await serve((_req, res) => {
      requests++;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.write(status === 200 ? '[' : '{"message":"');
    });
    const onError = vi.fn();
    const onResponse = vi.fn(() => queueMicrotask(() => controller.abort(reason)));
    const api = new GlassnodeAPI({
      apiKey: 'unused',
      apiUrl,
      maxRetries: 0,
      hooks: { onError, onResponse },
    });
    const error = await api.getMetricList({ signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlassnodeAbortError);
    expect((error as Error).cause).toBe(reason);
    expect(requests).toBe(1);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0].error).toBe(error);
  });

  it('preserves a whole-call deadline on the final retry error body', async () => {
    let requests = 0;
    const apiUrl = await serve((_req, res) => {
      requests++;
      res.writeHead(503);
      if (requests === 1) res.end('busy');
      else res.write('busy');
    });
    const controller = new AbortController();
    const reason = new DOMException('whole-call deadline', 'TimeoutError');
    const onResponse = vi.fn(() => {
      if (onResponse.mock.calls.length === 2) controller.abort(reason);
    });
    const fetchFn = vi.fn(fetch);
    const api = new GlassnodeAPI({
      apiKey: 'unused',
      apiUrl,
      maxRetries: 1,
      retryDelay: 1,
      fetch: fetchFn,
      hooks: { onResponse },
    });
    const signal = controller.signal;
    const error = await api.getMetricList({ signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlassnodeAbortError);
    expect((error as Error).cause).toBe(signal.reason);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(onResponse).toHaveBeenCalledTimes(2);
  });

  it.each([429, 503])('cancels discarded %i streams and preserves Retry-After', async (status) => {
    const cancel = vi.fn();
    const onRetry = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
      { status, headers: { 'Retry-After': '0' } }
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response('[]'));
    const api = new GlassnodeAPI({ apiKey: 'unused', fetch: fetchFn, hooks: { onRetry } });
    await expect(api.getMetricList()).resolves.toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(onRetry.mock.calls[0][0]).toMatchObject({ reason: 'status', status, delayMs: 0 });
  });

  it('a rejected cleanup does not mask the status failure or prevent retry', async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error('cleanup failed');
        },
      }),
      { status: 503 }
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(new Response('[]'));
    const api = new GlassnodeAPI({ apiKey: 'unused', fetch: fetchFn, retryDelay: 1 });
    await expect(api.getMetricList()).resolves.toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
