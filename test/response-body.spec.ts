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
  it.each(['consumed', 'locked', 'missing json', 'custom json'])(
    'does not retry a deterministic response failure: %s',
    async (kind) => {
      const response = new Response('[]');
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const cause = new Error('custom parser failed');
      if (kind === 'consumed') await response.json();
      if (kind === 'locked') reader = response.body!.getReader();
      if (kind === 'missing json') Object.defineProperty(response, 'json', { value: undefined });
      if (kind === 'custom json') {
        response.json = vi.fn().mockRejectedValue(cause);
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
        if (kind === 'custom json') expect((error as Error).cause).toBe(cause);
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
    let requests = 0;
    const apiUrl = await serve((_req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('[');
    });
    const onRetry = vi.fn();
    const signals: (AbortSignal | null | undefined)[] = [];
    const api = new GlassnodeAPI({
      apiKey: 'unused',
      apiUrl,
      timeout: 150,
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
    expect(requests).toBe(3);
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
      setTimeout(() => controller.abort(reason), 20);
    });
    const onError = vi.fn();
    const api = new GlassnodeAPI({ apiKey: 'unused', apiUrl, maxRetries: 0, hooks: { onError } });
    const error = await api.getMetricList({ signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlassnodeAbortError);
    expect((error as Error).cause).toBe(reason);
    expect(requests).toBe(1);
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
    const api = new GlassnodeAPI({ apiKey: 'unused', apiUrl, maxRetries: 1, retryDelay: 1 });
    const signal = AbortSignal.timeout(100);
    const error = await api.getMetricList({ signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GlassnodeAbortError);
    expect((error as Error).cause).toBe(signal.reason);
    expect(requests).toBe(2);
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
