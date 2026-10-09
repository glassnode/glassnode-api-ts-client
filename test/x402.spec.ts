import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vm from 'node:vm';
import { x402Client, x402HTTPClient } from '@x402/fetch';
import { usdcDecimalToAtomic, createMaxAmountPolicy, createX402Fetch } from '../src/x402';
import { GlassnodeAPI } from '../src/glassnode-api';
import {
  GlassnodeAbortError,
  GlassnodeError,
  GlassnodeApiError,
  GlassnodeInputError,
  GlassnodeNetworkError,
  GlassnodePaymentError,
} from '../src/errors';

/**
 * `@x402/fetch` is the real library everywhere, except in tests that set `x402Stub.wrap`: then
 * `wrapFetchWithPayment` is replaced by that stand-in. The real library always hands the base
 * fetch one same-realm `Request` (no `init`), so the `init.headers` and cross-realm branches of
 * the payment detection are only reachable through a stand-in that forwards other shapes — the
 * detection itself is still exercised end to end through the public `createX402Fetch` wrapper.
 */
const x402Stub = vi.hoisted(() => ({
  wrap: undefined as undefined | ((base: typeof fetch) => typeof fetch),
}));
vi.mock('@x402/fetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@x402/fetch')>();
  return {
    ...actual,
    wrapFetchWithPayment: (...args: Parameters<typeof actual.wrapFetchWithPayment>) =>
      x402Stub.wrap ? x402Stub.wrap(args[0] as typeof fetch) : actual.wrapFetchWithPayment(...args),
  };
});
afterEach(() => {
  x402Stub.wrap = undefined;
});

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected promise to reject');
}

describe('usdcDecimalToAtomic', () => {
  it('converts USDC decimals to 6-decimal atomic units', () => {
    expect(usdcDecimalToAtomic('0.06')).toBe(60000n);
    expect(usdcDecimalToAtomic('0.05')).toBe(50000n);
    expect(usdcDecimalToAtomic('0.01')).toBe(10000n);
    expect(usdcDecimalToAtomic('1')).toBe(1000000n);
    expect(usdcDecimalToAtomic('0')).toBe(0n);
  });

  it('truncates beyond 6 decimals and rejects bad input', () => {
    expect(usdcDecimalToAtomic('0.1234567')).toBe(123456n);
    expect(() => usdcDecimalToAtomic('abc')).toThrow(/Invalid USDC amount/);
    expect(() => usdcDecimalToAtomic('-1')).toThrow(/Invalid USDC amount/);
  });

  it('rejects bad input with a GlassnodeInputError', () => {
    let err: unknown;
    try {
      usdcDecimalToAtomic('1e3');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GlassnodeInputError);
    expect(err).toBeInstanceOf(GlassnodeError);
    expect((err as GlassnodeInputError).argument).toBe('value');
  });
});

describe('createMaxAmountPolicy', () => {
  it('keeps only requirements at or below the cap', () => {
    const policy = createMaxAmountPolicy(60000n);
    const reqs = [{ amount: '50000' }, { amount: '60000' }, { amount: '70000' }];
    expect(policy(2, reqs)).toEqual([{ amount: '50000' }, { amount: '60000' }]);
  });
});

// A signer that never touches a real key. Returns a syntactically valid (fake) signature.
const FAKE_SIGNATURE = `0x${'ab'.repeat(65)}` as const;
function fakeAccount(signTypedData: () => Promise<`0x${string}`> = async () => FAKE_SIGNATURE) {
  return { address: '0x0000000000000000000000000000000000000001' as const, signTypedData };
}

// Base Sepolia USDC — a default asset, so x402's built-in spend controls accept it.
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

function paymentRequired(amount: string, overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: 'https://x402.glassnode.com/v1/metadata/metrics' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount,
        asset: BASE_SEPOLIA_USDC,
        payTo: '0x0000000000000000000000000000000000000002',
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
        ...overrides,
      },
    ],
  };
}

function response402(body = paymentRequired('50000')): Response {
  return new Response('{}', {
    status: 402,
    statusText: 'Payment Required',
    headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(body)).toString('base64') },
  });
}

function paidApi(paidFetch: typeof fetch, extra: Record<string, unknown> = {}) {
  return new GlassnodeAPI({ x402: true, fetch: paidFetch, retryDelay: 1, ...extra });
}

describe('createX402Fetch', () => {
  it('returns a callable fetch using the real x402 client', async () => {
    const wrapped = await createX402Fetch({ account: fakeAccount(), maxPaymentPerCall: '0.06' });
    expect(typeof wrapped).toBe('function');
  });

  it('rejects an invalid maxPaymentPerCall with a GlassnodeInputError', async () => {
    const err = await caught(
      createX402Fetch({ account: fakeAccount(), maxPaymentPerCall: 'lots' })
    );
    expect(err).toBeInstanceOf(GlassnodeInputError);
    expect((err as GlassnodeInputError).argument).toBe('maxPaymentPerCall');
    expect((err as Error).message).toMatch(/Invalid USDC amount/);
  });

  it('price above maxPaymentPerCall -> GlassnodePaymentError, not retried', async () => {
    const baseFetch = vi.fn(async () => response402(paymentRequired('70000')));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      maxPaymentPerCall: '0.06',
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 3 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err).toBeInstanceOf(GlassnodeError);
    expect(err).not.toBeInstanceOf(GlassnodeNetworkError);
    const e = err as GlassnodePaymentError;
    expect(e.name).toBe('GlassnodePaymentError');
    expect(e.message).toMatch(/filtered out by policies/);
    expect(e.message).toMatch(/maxPaymentPerCall/);
    expect(e.cause).toBeInstanceOf(Error);
    // One unpaid request, no payment attempt, no retry.
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('signer failure -> GlassnodePaymentError, not retried, cause preserved', async () => {
    const baseFetch = vi.fn(async () => response402());
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => {
      throw new Error('hardware wallet disconnected');
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect((err as Error).message).toMatch(/hardware wallet disconnected/);
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('a malformed 402 (no payment requirements) -> GlassnodePaymentError', async () => {
    const baseFetch = vi.fn(async () => new Response('{}', { status: 402 }));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('redacts api_key query values from payment error messages', async () => {
    // x402 dumps the offered requirements into some messages; one echoing a URL must not leak a key.
    const body = paymentRequired('50000', {
      network: 'eip155:1',
      extra: { resource: 'https://x402.glassnode.com/v1?api_key=SECRET-KEY' },
    });
    const baseFetch = vi.fn(async () => response402(body));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(paidApi(paidFetch).getMetricList())) as Error;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.message).toMatch(/No network\/scheme registered/);
    expect(err.message).not.toContain('SECRET-KEY');
  });

  it('passes repeated query params (array values) through to the base fetch unchanged', async () => {
    const baseFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ t: 1, bulk: [] }] })
    );
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch,
    });
    await paidApi(paidFetch).callBulkMetric('/market/marketcap_usd', {
      a: ['BTC', 'ETH'],
      s: 1609459200,
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    const input = baseFetch.mock.calls[0][0];
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe(
      'https://x402.glassnode.com/v1/metrics/market/marketcap_usd/bulk?a=BTC&a=ETH&s=1609459200&f=json'
    );
  });

  it('base-fetch transport failure stays a retried GlassnodeNetworkError', async () => {
    const cause = new TypeError('fetch failed');
    const baseFetch = vi.fn(async () => {
      throw cause;
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect(err).not.toBeInstanceOf(GlassnodePaymentError);
    expect((err as GlassnodeNetworkError).cause).toBe(cause);
    expect((err as GlassnodeNetworkError).timedOut).toBe(false);
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });

  it('payment errors raised before anything was sent have paymentMayHaveSettled = false', async () => {
    const baseFetch = vi.fn(async () => response402(paymentRequired('70000')));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(paidApi(paidFetch).getMetricList())) as GlassnodePaymentError;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.paymentMayHaveSettled).toBe(false);
    expect(err.timedOut).toBe(false);
    expect(err.status).toBeUndefined();
  });
});

/** Whether a base-fetch call carried an x402 payment header (v2 or v1). */
function isPaidCall(call: unknown[]): boolean {
  const req = call[0];
  return (
    req instanceof Request && (req.headers.has('PAYMENT-SIGNATURE') || req.headers.has('X-PAYMENT'))
  );
}

describe('createX402Fetch — never pays twice for one call', () => {
  it('transport failure on the paid request -> GlassnodePaymentError, one payment, not retried', async () => {
    const cause = new TypeError('fetch failed');
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (isPaidCall([input])) throw cause;
      return response402();
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());

    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err).toBeInstanceOf(GlassnodeError);
    expect(err).not.toBeInstanceOf(GlassnodeNetworkError);
    const e = err as GlassnodePaymentError;
    expect(e.paymentMayHaveSettled).toBe(true);
    expect(e.timedOut).toBe(false);
    expect(e.cause).toBe(cause);
    expect(e.message).toMatch(/may have settled/);
    expect(e.status).toBeUndefined();
    expect(e.message).toMatch(/fetch failed/);
    // Exactly one payment signed and one paid request sent; the call was not retried.
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('a non-Error rejection of the paid request is still flagged, not retried', async () => {
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (isPaidCall([input])) throw 'socket hang up';
      return response402();
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidApi(paidFetch, { maxRetries: 2 }).getMetricList()
    )) as GlassnodePaymentError;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.paymentMayHaveSettled).toBe(true);
    expect(err.cause).toBe('socket hang up');
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('a timeout abort on the paid request -> flagged payment error with timedOut, not retried', async () => {
    // The paid request hangs until the per-request timeout (AbortSignal.timeout) aborts it.
    const baseFetch = vi.fn((input: RequestInfo | URL) => {
      if (!isPaidCall([input])) return Promise.resolve(response402());
      const signal = (input as Request).signal;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2, timeout: 50 }).getMetricList());

    expect(err).toBeInstanceOf(GlassnodePaymentError);
    const e = err as GlassnodePaymentError;
    expect(e.paymentMayHaveSettled).toBe(true);
    expect(e.timedOut).toBe(true);
    expect((e.cause as { name?: string }).name).toBe('TimeoutError');
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('a mocked TimeoutError rejection on the paid request is reported as timedOut', async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(response402())
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as unknown as typeof fetch,
    });
    const err = (await caught(
      paidApi(paidFetch, { maxRetries: 2 }).getMetricList()
    )) as GlassnodePaymentError;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.paymentMayHaveSettled).toBe(true);
    expect(err.timedOut).toBe(true);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('transport failures of the unpaid probe are retried; payment is signed only once a probe succeeds', async () => {
    const events: string[] = [];
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      const paid = isPaidCall([input]);
      events.push(paid ? 'paid' : 'probe');
      if (paid) {
        return new Response(JSON.stringify(['/market/price_usd_close']), { status: 200 });
      }
      if (events.length <= 2) throw new TypeError('fetch failed');
      return response402();
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => {
      events.push('sign');
      return FAKE_SIGNATURE;
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const result = await paidApi(paidFetch, { maxRetries: 2 }).getMetricList();

    expect(result).toEqual(['/market/price_usd_close']);
    expect(events).toEqual(['probe', 'probe', 'probe', 'sign', 'paid']);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('probe transport failures exhausting retries stay a GlassnodeNetworkError; nothing signed', async () => {
    const baseFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeNetworkError);
    expect(err).not.toBeInstanceOf(GlassnodePaymentError);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });

  it('separate calls on the same wrapped fetch are tracked independently', async () => {
    // Call 1: paid request fails in transit (flagged). Call 2: probe fails in transit (network
    // error) — the earlier call's paid state must not leak into it.
    let n = 0;
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      n++;
      if (n === 1) return response402();
      if (isPaidCall([input])) throw new TypeError('reset');
      throw new TypeError('probe down');
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const api = paidApi(paidFetch);
    const first = (await caught(api.getMetricList())) as GlassnodePaymentError;
    expect(first).toBeInstanceOf(GlassnodePaymentError);
    expect(first.paymentMayHaveSettled).toBe(true);
    const second = await caught(api.getMetricList());
    expect(second).toBeInstanceOf(GlassnodeNetworkError);
  });

  it('a 402 after payment is still a GlassnodeApiError(402)', async () => {
    const baseFetch = vi.fn(async () => response402());
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeApiError);
    expect((err as GlassnodeApiError).status).toBe(402);
    expect((err as GlassnodeApiError).isRetryable).toBe(false);
    // Unpaid request + paid request; 402 is not retried.
    expect(baseFetch).toHaveBeenCalledTimes(2);
    const paid = baseFetch.mock.calls[1] as unknown as [Request];
    expect(paid[0].headers.get('PAYMENT-SIGNATURE')).toBeTruthy();
  });

  it('never puts signature material into a payment error message', async () => {
    // Paid request carries a signature; make the payment layer fail afterwards by sending the
    // signed request back through the wrapper ("Payment already attempted").
    const baseFetch = vi.fn(async () => response402());
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidFetch('https://x402.glassnode.com/v1/metadata/metrics', {
        headers: { 'PAYMENT-SIGNATURE': 'already-signed' },
      })
    )) as Error;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.message).not.toContain('ab'.repeat(65));
  });
});

describe('createX402Fetch — an HTTP error after payment is never retried', () => {
  /** A base fetch whose probe answers `probe()` and whose paid request answers `paid()`. */
  function scripted(paid: () => Response, probe: () => Response = () => response402()) {
    return vi.fn(async (input: RequestInfo | URL) => (isPaidCall([input]) ? paid() : probe()));
  }

  it('paid request -> 502: GlassnodePaymentError with status, one payment, not retried', async () => {
    const baseFetch = scripted(
      () =>
        new Response(JSON.stringify({ message: 'upstream timed out' }), {
          status: 502,
          statusText: 'Bad Gateway',
        })
    );
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());

    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err).not.toBeInstanceOf(GlassnodeApiError);
    const e = err as GlassnodePaymentError;
    expect(e.paymentMayHaveSettled).toBe(true);
    expect(e.timedOut).toBe(false);
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/502/);
    expect(e.message).toMatch(/upstream timed out/);
    expect(e.message).toMatch(/may have settled/);
    // The HTTP failure is kept on .cause as the GlassnodeApiError the client would have raised.
    expect(e.cause).toBeInstanceOf(GlassnodeApiError);
    const cause = e.cause as GlassnodeApiError;
    expect(cause.status).toBe(502);
    expect(cause.statusText).toBe('Bad Gateway');
    expect(cause.detail).toBe('upstream timed out');
    expect(e.message).not.toContain('ab'.repeat(65));
    // Exactly one payment signed and one paid request sent; the call was not retried.
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('paid request -> 429 with Retry-After: not retried', async () => {
    const baseFetch = scripted(
      () =>
        new Response('', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'Retry-After': '0' },
        })
    );
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidApi(paidFetch, { maxRetries: 2 }).getMetricList()
    )) as GlassnodePaymentError;

    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.paymentMayHaveSettled).toBe(true);
    expect(err.status).toBe(429);
    expect((err.cause as GlassnodeApiError).status).toBe(429);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('paid request -> 400: GlassnodePaymentError (a signed payment was sent), not retried', async () => {
    const baseFetch = scripted(
      () =>
        new Response(JSON.stringify({ message: 'Resolution 1h is not allowed' }), {
          status: 400,
          statusText: 'Bad Request',
        })
    );
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidApi(paidFetch, { maxRetries: 2 }).getMetricList()
    )) as GlassnodePaymentError;

    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.paymentMayHaveSettled).toBe(true);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Resolution 1h is not allowed/);
    expect((err.cause as GlassnodeApiError).detail).toBe('Resolution 1h is not allowed');
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('redacts api_key values echoed in the paid error body', async () => {
    const baseFetch = scripted(
      () =>
        new Response('proxy error for /v1?api_key=SECRET-KEY', {
          status: 500,
          statusText: 'Internal Server Error',
        })
    );
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidApi(paidFetch, { maxRetries: 2 }).getMetricList()
    )) as GlassnodePaymentError;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.status).toBe(500);
    expect(err.message).not.toContain('SECRET-KEY');
    expect((err.cause as GlassnodeApiError).message).not.toContain('SECRET-KEY');
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('the wrapped fetch itself rejects on an HTTP error after payment (used without GlassnodeAPI)', async () => {
    const baseFetch = scripted(() => new Response('', { status: 503 }));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidFetch('https://x402.glassnode.com/v1/metadata/metrics')
    )) as GlassnodePaymentError;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.status).toBe(503);
    expect(err.paymentMayHaveSettled).toBe(true);
  });

  it('unpaid probe -> 503 then 402 -> paid 200: probe retried, one payment, success', async () => {
    const events: string[] = [];
    let probes = 0;
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (isPaidCall([input])) {
        events.push('paid');
        return new Response(JSON.stringify(['/market/price_usd_close']), { status: 200 });
      }
      events.push('probe');
      probes++;
      return probes === 1
        ? new Response('', { status: 503, statusText: 'Service Unavailable' })
        : response402();
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => {
      events.push('sign');
      return FAKE_SIGNATURE;
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const result = await paidApi(paidFetch, { maxRetries: 2 }).getMetricList();

    expect(result).toEqual(['/market/price_usd_close']);
    expect(events).toEqual(['probe', 'probe', 'sign', 'paid']);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('unpaid probe -> 503 exhausting retries stays a GlassnodeApiError(503); nothing signed', async () => {
    const baseFetch = vi.fn(async () => new Response('', { status: 503 }));
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeApiError);
    expect(err).not.toBeInstanceOf(GlassnodePaymentError);
    expect((err as GlassnodeApiError).status).toBe(503);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(3);
  });

  it('paid request -> 200: success unchanged, one payment', async () => {
    const baseFetch = scripted(
      () => new Response(JSON.stringify(['/market/price_usd_close']), { status: 200 })
    );
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const result = await paidApi(paidFetch, { maxRetries: 2 }).getMetricList();
    expect(result).toEqual(['/market/price_usd_close']);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('paid request -> 402 (payment refused) stays a GlassnodeApiError(402), one payment, not retried', async () => {
    const baseFetch = vi.fn(async () => response402());
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidApi(paidFetch, { maxRetries: 2 }).getMetricList());
    expect(err).toBeInstanceOf(GlassnodeApiError);
    expect(err).not.toBeInstanceOf(GlassnodePaymentError);
    expect((err as GlassnodeApiError).status).toBe(402);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
});

describe('createX402Fetch — per-call signal', () => {
  /** A base fetch whose paid (or unpaid) request hangs until its Request signal aborts. */
  function hangOn(paid: boolean) {
    return vi.fn((input: RequestInfo | URL) => {
      if (isPaidCall([input]) !== paid) return Promise.resolve(response402());
      const signal = (input as Request).signal;
      return new Promise<Response>((_, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
  }

  it('the wrapped fetch receives the per-call signal in init', async () => {
    const baseFetch = vi.fn(async () => new Response('[]', { status: 200 }));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const spy = vi.fn(paidFetch);
    const controller = new AbortController();
    await paidApi(spy as typeof fetch).getMetricList({ signal: controller.signal });
    expect(spy.mock.calls[0][1]).toEqual({ signal: controller.signal });
    // ...and @x402/fetch builds its Request from that init, so the base fetch sees it too.
    controller.abort();
    expect((baseFetch.mock.calls[0] as unknown[])[0]).toBeInstanceOf(Request);
    expect(((baseFetch.mock.calls[0] as unknown[])[0] as Request).signal.aborted).toBe(true);
  });

  it('abort on the unpaid probe -> GlassnodeAbortError, nothing signed, not retried', async () => {
    const baseFetch = hangOn(false);
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const controller = new AbortController();
    const pending = caught(
      paidApi(paidFetch, { maxRetries: 2 }).getMetricList({ signal: controller.signal })
    );
    await vi.waitFor(() => expect(baseFetch).toHaveBeenCalledTimes(1));
    controller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(GlassnodeAbortError);
    expect(signTypedData).not.toHaveBeenCalled();
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('abort after the payment was sent -> GlassnodePaymentError (may have settled), one payment, not retried', async () => {
    const baseFetch = hangOn(true);
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const controller = new AbortController();
    const pending = caught(
      paidApi(paidFetch, { maxRetries: 2, timeout: 60_000 }).getMetricList({
        signal: controller.signal,
      })
    );
    await vi.waitFor(() => expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1));
    const reason = new Error('user cancelled');
    controller.abort(reason);
    const err = await pending;

    // The money-safety signal wins over the abort classification.
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err).not.toBeInstanceOf(GlassnodeAbortError);
    const e = err as GlassnodePaymentError;
    expect(e.paymentMayHaveSettled).toBe(true);
    expect(e.timedOut).toBe(false);
    expect(e.cause).toBe(reason);
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
});

const METRICS_URL = 'https://x402.glassnode.com/v1/metadata/metrics';

/**
 * Route every base-fetch call straight through with the exact `(input, init)` it is given (the
 * stand-in for `wrapFetchWithPayment`, see `x402Stub`), so a test controls the shape the
 * payment detection sees.
 */
function passThroughWrapper() {
  x402Stub.wrap = (base) => (input, init) => base(input, init);
}

/**
 * Whether the public wrapper treats a base-fetch call as carrying a payment: a paid request's
 * non-2xx answer rejects with `GlassnodePaymentError { paymentMayHaveSettled: true }`, while an
 * unpaid one's is returned as a plain `Response`.
 */
async function detectedAsPaid(input: unknown, init?: RequestInit): Promise<boolean> {
  passThroughWrapper();
  const baseFetch = vi.fn(async () => new Response('', { status: 503 }));
  try {
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    let result: boolean;
    try {
      const response = await paidFetch(input as RequestInfo, init);
      expect(response.status).toBe(503);
      result = false;
    } catch (err) {
      expect(err).toBeInstanceOf(GlassnodePaymentError);
      expect((err as GlassnodePaymentError).paymentMayHaveSettled).toBe(true);
      expect((err as GlassnodePaymentError).status).toBe(503);
      result = true;
    }
    // The stand-in was in effect: the base fetch saw exactly the shape under test (plus the
    // `redirect: 'manual'` createX402Fetch always adds so a payment is never sent to a redirect).
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls[0]).toEqual([input, { ...init, redirect: 'manual' }]);
    expect((baseFetch.mock.calls[0] as unknown[])[0]).toBe(input);
    return result;
  } finally {
    x402Stub.wrap = undefined;
  }
}

describe('createX402Fetch — payment detection on init.headers', () => {
  const NAMES = [
    'PAYMENT-SIGNATURE',
    'payment-signature',
    'Payment-Signature',
    'X-PAYMENT',
    'x-payment',
    'X-Payment',
  ];
  const FORMS: [string, (name: string) => HeadersInit][] = [
    ['plain object', (name) => ({ [name]: 'signed', Accept: 'application/json' })],
    ['Headers instance', (name) => new Headers({ [name]: 'signed' })],
    [
      'array of tuples',
      (name) => [
        ['Accept', 'application/json'],
        [name, 'signed'],
      ],
    ],
  ];

  for (const [form, build] of FORMS) {
    it.each(NAMES)(`detects %s as a ${form}`, async (name) => {
      expect(await detectedAsPaid(METRICS_URL, { headers: build(name) })).toBe(true);
    });

    it(`a ${form} without a payment header is not a paid request`, async () => {
      expect(await detectedAsPaid(METRICS_URL, { headers: build('X-Api-Key') })).toBe(false);
    });
  }

  it('a header whose name merely contains "payment" is not a paid request', async () => {
    const headers = { 'PAYMENT-RESPONSE': 'x', 'X-PAYMENT-RESPONSE': 'x' };
    expect(await detectedAsPaid(METRICS_URL, { headers })).toBe(false);
  });

  it('a transport failure of a request paid via init.headers is flagged', async () => {
    passThroughWrapper();
    const cause = new TypeError('socket reset');
    const baseFetch = vi.fn(async () => {
      throw cause;
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = (await caught(
      paidFetch(METRICS_URL, { headers: [['x-payment', 'signed']] })
    )) as GlassnodePaymentError;
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect(err.paymentMayHaveSettled).toBe(true);
    expect(err.cause).toBe(cause);
  });

  it('the real @x402/fetch moves init headers onto its Request; still detected', async () => {
    const baseFetch = vi.fn(async () => new Response('', { status: 503 }));
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const err = await caught(paidFetch(METRICS_URL, { headers: { 'payment-signature': 's' } }));
    // The base fetch got a lone Request (no init) — the Request branch did the detecting.
    expect(baseFetch.mock.calls[0]).toHaveLength(1);
    expect(err).toBeInstanceOf(GlassnodePaymentError);
    expect((err as GlassnodePaymentError).paymentMayHaveSettled).toBe(true);
  });
});

describe('createX402Fetch — cross-realm Headers / Request', () => {
  /**
   * Objects built in a separate V8 realm (`node:vm`). Node exposes no `fetch` globals in a fresh
   * context, so the realm defines its own spec-shaped `Headers` (iterable of `[name, value]`
   * pairs, case-insensitive) and `Request` (`url` + `headers`) — which is exactly what the
   * duck-typed detection must accept: none of them is an instance of this realm's classes.
   */
  const realm = vm.runInNewContext(`
    class Headers {
      constructor(init) {
        this.map = new Map();
        for (const [k, v] of Object.entries(init)) this.map.set(k.toLowerCase(), String(v));
      }
      has(name) { return this.map.has(String(name).toLowerCase()); }
      get(name) { return this.map.get(String(name).toLowerCase()) ?? null; }
      *[Symbol.iterator]() { yield* this.map.entries(); }
    }
    class Request {
      constructor(url, headers) { this.url = url; this.headers = headers; }
    }
    ({
      headers: (init) => new Headers(init),
      plain: (init) => Object.assign({}, init),
      tuples: (init) => Object.entries(init),
      request: (url, headers) => new Request(url, headers),
    })
  `) as {
    headers: (init: Record<string, string>) => HeadersInit;
    plain: (init: Record<string, string>) => HeadersInit;
    tuples: (init: Record<string, string>) => HeadersInit;
    request: (url: string, headers: HeadersInit) => unknown;
  };

  it('the realm objects really are foreign', () => {
    const h = realm.headers({ a: 'b' });
    expect(h).not.toBeInstanceOf(Headers);
    expect(h).not.toBeInstanceOf(Object);
    expect(realm.request(METRICS_URL, h)).not.toBeInstanceOf(Request);
    expect(realm.tuples({ a: 'b' })).not.toBeInstanceOf(Array);
  });

  const FORMS = ['headers', 'plain', 'tuples'] as const;

  it.each(FORMS)('detects a payment header in a foreign-realm %s on init.headers', async (form) => {
    const v2 = realm[form]({ 'Payment-Signature': 'signed' });
    expect(await detectedAsPaid(METRICS_URL, { headers: v2 })).toBe(true);
    const v1 = realm[form]({ 'x-payment': 'signed' });
    expect(await detectedAsPaid(METRICS_URL, { headers: v1 })).toBe(true);
    const none = realm[form]({ Accept: 'application/json' });
    expect(await detectedAsPaid(METRICS_URL, { headers: none })).toBe(false);
  });

  it.each(FORMS)('detects a payment header on a foreign-realm Request (%s)', async (form) => {
    const paid = realm.request(METRICS_URL, realm[form]({ 'PAYMENT-SIGNATURE': 'signed' }));
    expect(await detectedAsPaid(paid)).toBe(true);
    const unpaid = realm.request(METRICS_URL, realm[form]({ Accept: 'application/json' }));
    expect(await detectedAsPaid(unpaid)).toBe(false);
  });
});

describe('createX402Fetch — concurrent calls on one wrapped fetch', () => {
  it("a paid call failing in transit does not taint another in-flight call's probe failure", async () => {
    // Call A (/metrics) pays and its paid request hangs; meanwhile call B (/assets) has its
    // unpaid probe fail in transit. B must stay a retried GlassnodeNetworkError with nothing
    // signed; only then does A's paid request fail, which must be flagged as possibly settled.
    let releaseA: ((error: unknown) => void) | undefined;
    const aFailure = new TypeError('A reset');
    const bFailure = new TypeError('B probe down');
    const isB = (call: unknown[]) => (call[0] as Request).url.includes('/v1/metadata/assets');
    const baseFetch = vi.fn((input: RequestInfo | URL) => {
      if (isB([input])) return Promise.reject(bFailure);
      if (!isPaidCall([input])) return Promise.resolve(response402());
      return new Promise<Response>((_, reject) => {
        releaseA = reject;
      });
    });
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const api = paidApi(paidFetch, { maxRetries: 2 });

    const a = caught(api.getMetricList());
    await vi.waitFor(() => expect(releaseA).toBeDefined());

    const b = await caught(api.getAssetMetadata());
    expect(b).toBeInstanceOf(GlassnodeNetworkError);
    expect(b).not.toBeInstanceOf(GlassnodePaymentError);
    expect((b as GlassnodeNetworkError).cause).toBe(bFailure);
    const bCalls = baseFetch.mock.calls.filter(isB);
    expect(bCalls).toHaveLength(3); // retried: 1 + maxRetries
    expect(bCalls.filter(isPaidCall)).toHaveLength(0);

    releaseA!(aFailure);
    const aErr = (await a) as GlassnodePaymentError;
    expect(aErr).toBeInstanceOf(GlassnodePaymentError);
    expect(aErr.paymentMayHaveSettled).toBe(true);
    expect(aErr.cause).toBe(aFailure);
    // Only A signed, once.
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(baseFetch.mock.calls.filter(isPaidCall)).toHaveLength(1);
  });

  it("an unpaid probe 503 stays a plain response while another call's payment is in flight", async () => {
    let releaseA: ((response: Response) => void) | undefined;
    const baseFetch = vi.fn((input: RequestInfo | URL) => {
      if ((input as Request).url.endsWith('/b')) {
        return Promise.resolve(new Response('', { status: 503 }));
      }
      if (!isPaidCall([input])) return Promise.resolve(response402());
      return new Promise<Response>((resolve) => {
        releaseA = resolve;
      });
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    const a = caught(paidFetch('https://x402.glassnode.com/a'));
    await vi.waitFor(() => expect(releaseA).toBeDefined());

    const b = await paidFetch('https://x402.glassnode.com/b');
    expect(b.status).toBe(503);

    releaseA!(new Response('', { status: 502 }));
    const aErr = (await a) as GlassnodePaymentError;
    expect(aErr).toBeInstanceOf(GlassnodePaymentError);
    expect(aErr.status).toBe(502);
    expect(aErr.paymentMayHaveSettled).toBe(true);
  });
});

describe('createX402Fetch — 3xx on the paid request', () => {
  it.each([301, 302, 303, 307, 308])(
    "paid request -> %i (redirect: 'manual') is a GlassnodePaymentError with the status",
    async (status) => {
      const baseFetch = vi.fn(async (input: RequestInfo | URL) =>
        isPaidCall([input])
          ? new Response(null, { status, headers: { Location: 'https://example.invalid/' } })
          : response402()
      );
      const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
      const paidFetch = await createX402Fetch({
        account: fakeAccount(signTypedData),
        fetch: baseFetch as typeof fetch,
      });
      const err = (await caught(
        paidFetch(METRICS_URL, { redirect: 'manual' })
      )) as GlassnodePaymentError;

      expect(err).toBeInstanceOf(GlassnodePaymentError);
      expect(err.paymentMayHaveSettled).toBe(true);
      expect(err.status).toBe(status);
      expect((err.cause as GlassnodeApiError).status).toBe(status);
      // The redirect mode reached the base fetch on the paid request.
      const paid = baseFetch.mock.calls.filter(isPaidCall)[0] as unknown as [Request];
      expect(paid[0].redirect).toBe('manual');
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    }
  );

  it('a 3xx on the unpaid probe is passed through unchanged (nothing signed)', async () => {
    const baseFetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { Location: 'https://x.invalid/' } })
    );
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const paidFetch = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch as typeof fetch,
    });
    const response = await paidFetch(METRICS_URL, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});

describe('createX402Fetch — maxRetries: 0', () => {
  it.each([
    [503, 'Service Unavailable'],
    [500, 'Internal Server Error'],
    [429, 'Too Many Requests'],
    [400, 'Bad Request'],
  ])(
    'paid request -> %i is classified as GlassnodePaymentError, not GlassnodeApiError',
    async (status, statusText) => {
      const baseFetch = vi.fn(async (input: RequestInfo | URL) =>
        isPaidCall([input]) ? new Response('', { status, statusText }) : response402()
      );
      const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
      const paidFetch = await createX402Fetch({
        account: fakeAccount(signTypedData),
        fetch: baseFetch as typeof fetch,
      });
      const err = await caught(paidApi(paidFetch, { maxRetries: 0 }).getMetricList());

      expect(err).toBeInstanceOf(GlassnodePaymentError);
      expect(err).not.toBeInstanceOf(GlassnodeApiError);
      const e = err as GlassnodePaymentError;
      expect(e.paymentMayHaveSettled).toBe(true);
      expect(e.status).toBe(status);
      expect(e.cause).toBeInstanceOf(GlassnodeApiError);
      expect((e.cause as GlassnodeApiError).statusText).toBe(statusText);
      expect(signTypedData).toHaveBeenCalledTimes(1);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    }
  );
});

describe('createX402Fetch — PAYMENT_HEADERS tracks @x402/core', () => {
  /** Headers the real @x402/fetch adds to the paid request that carry no payment. */
  const NON_PAYMENT_HEADERS = new Set(['access-control-expose-headers']);

  it('every header the real wrapFetchWithPayment adds to the paid request is recognised', async () => {
    const requests: Request[] = [];
    const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(input as Request);
      return requests.length === 1 ? response402() : new Response('[]', { status: 200 });
    });
    const paidFetch = await createX402Fetch({
      account: fakeAccount(),
      fetch: baseFetch as typeof fetch,
    });
    await paidFetch(METRICS_URL);
    expect(requests).toHaveLength(2);

    const probeNames = new Set(requests[0].headers.keys());
    const added = [...requests[1].headers.keys()].filter(
      (name) => !probeNames.has(name) && !NON_PAYMENT_HEADERS.has(name)
    );
    // Sanity: the paid request does carry something beyond the probe's headers.
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      const value = requests[1].headers.get(name) as string;
      expect(await detectedAsPaid(METRICS_URL, { headers: { [name]: value } }), name).toBe(true);
    }
  });

  it.each([1, 2])(
    'every header encodePaymentSignatureHeader emits for x402 v%i is recognised',
    async (x402Version) => {
      const httpClient = new x402HTTPClient(new x402Client());
      const headers = httpClient.encodePaymentSignatureHeader({
        x402Version,
      } as Parameters<typeof httpClient.encodePaymentSignatureHeader>[0]);
      const names = Object.keys(headers);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const value = headers[name];
        expect(await detectedAsPaid(METRICS_URL, { headers: { [name]: value } }), name).toBe(true);
      }
    }
  );
});

describe('paid successful response body failures', () => {
  it('uses a Request input timeout reason when a paid body reports AbortError', async () => {
    const reason = new DOMException('deadline', 'TimeoutError');
    const cause = new DOMException('body aborted', 'AbortError');
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const baseFetch = vi.fn(async (input: RequestInfo | URL) =>
      isPaidCall([input])
        ? new Response(
            new ReadableStream({
              start(c) {
                c.error(cause);
              },
            })
          )
        : response402()
    );
    const wrapped = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch,
    });
    const response = await wrapped(new Request(METRICS_URL, { signal: AbortSignal.abort(reason) }));
    const error = await caught(response.text());
    expect(error).toBeInstanceOf(GlassnodePaymentError);
    expect(error).toMatchObject({ timedOut: true, paymentMayHaveSettled: true, cause });
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('still retries a failed successful unpaid body when retries are enabled', async () => {
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new TypeError('terminated'));
            },
          })
        )
      )
      .mockResolvedValueOnce(new Response('[]'));
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const wrapped = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch,
    });
    await expect(paidApi(wrapped, { maxRetries: 2 }).getMetricList()).resolves.toEqual([]);
    expect(baseFetch).toHaveBeenCalledTimes(2);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'caller abort', 'connection reset'])(
    '%s remains a payment error with one signed payment, even with retries enabled',
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
      const baseFetch = vi.fn(async (input: RequestInfo | URL) => {
        if (!isPaidCall([input])) return response402();
        const signal = (input as Request).signal;
        return new Response(
          new ReadableStream({
            start(body) {
              body.enqueue(new TextEncoder().encode('['));
              signal.addEventListener('abort', () => body.error(signal.reason), { once: true });
              if (kind === 'caller abort') setTimeout(() => controller.abort(reason), 10);
              if (kind === 'connection reset')
                setTimeout(() => body.error(new TypeError('terminated')), 10);
            },
          })
        );
      });
      const wrapped = await createX402Fetch({
        account: fakeAccount(signTypedData),
        fetch: baseFetch,
      });
      const api = paidApi(wrapped, {
        maxRetries: 2,
        ...(kind === 'timeout' ? { timeout: 100 } : {}),
      });
      const error = await caught(api.getMetricList({ signal: controller.signal }));
      expect(error).toBeInstanceOf(GlassnodePaymentError);
      expect((error as GlassnodePaymentError).paymentMayHaveSettled).toBe(true);
      expect((error as GlassnodePaymentError).timedOut).toBe(kind === 'timeout');
      if (kind === 'caller abort') expect((error as Error).cause).toBe(reason);
      expect(signTypedData).toHaveBeenCalledOnce();
      expect(baseFetch).toHaveBeenCalledTimes(2);
    }
  );

  it('invalid paid JSON is still a non-retried validation failure', async () => {
    const signTypedData = vi.fn(async (): Promise<`0x${string}`> => FAKE_SIGNATURE);
    const baseFetch = vi.fn(async (input: RequestInfo | URL) =>
      isPaidCall([input]) ? new Response('not JSON') : response402()
    );
    const wrapped = await createX402Fetch({
      account: fakeAccount(signTypedData),
      fetch: baseFetch,
    });
    const error = await caught(paidApi(wrapped, { maxRetries: 2 }).getMetricList());
    expect((error as Error).name).toBe('GlassnodeValidationError');
    expect(signTypedData).toHaveBeenCalledOnce();
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });
});

describe('paid response stream compatibility', () => {
  it('preserves status, headers, metadata and cloning', async () => {
    const response = new Response('[]', { status: 201, headers: { 'X-Audit': 'ok' } });
    Object.defineProperties(response, {
      url: { value: 'https://x402.glassnode.com/v1/metadata/metrics' },
      type: { value: 'basic' },
    });
    const wrapped = await createX402Fetch({
      account: fakeAccount(),
      fetch: async (input) => (isPaidCall([input]) ? response : response402()),
    });
    const result = await wrapped('https://x402.glassnode.com/v1/metadata/metrics');
    const clone = result.clone();
    expect(result.status).toBe(201);
    expect(result.headers.get('X-Audit')).toBe('ok');
    expect(clone.url).toBe(response.url);
    expect(clone.type).toBe('basic');
    expect(clone.redirected).toBe(response.redirected);
    await expect(Promise.all([result.json(), clone.json()])).resolves.toEqual([[], []]);
  });

  it('cancelling a paid response body cancels its original stream', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const wrapped = await createX402Fetch({
      account: fakeAccount(),
      fetch: async (input) => (isPaidCall([input]) ? response : response402()),
    });
    const result = await wrapped('https://x402.glassnode.com/v1/metadata/metrics');
    await result.body!.cancel();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
