/**
 * Paid, key-less access through the x402 endpoint: {@link createX402Fetch} builds the
 * x402-capable `fetch` to pass to a `GlassnodeAPI` created with `x402: true`. Requires the optional
 * peers `@x402/fetch`, `@x402/evm` and `viem`.
 *
 * @module glassnode-api/x402
 */
import { readErrorDetail } from './error-detail.js';
import {
  GlassnodeApiError,
  GlassnodeConfigError,
  GlassnodeInputError,
  GlassnodePaymentError,
} from './errors.js';
import { redactSecrets } from './redact.js';

/**
 * Minimal structural shape of the signer x402 needs: an EVM address and an EIP-712 typed-data
 * signer. A viem account (e.g. `privateKeyToAccount(pk)`) satisfies this — the method syntax keeps
 * viem's account assignable. Declared structurally so the public `./x402` types do not depend on
 * `viem` (an optional peer), which otherwise breaks `moduleResolution: node16` type-checking for
 * consumers with `skipLibCheck: false`.
 */
export interface X402SignerAccount {
  /** 0x-prefixed EVM address of the signer. */
  address: `0x${string}`;
  /**
   * Sign EIP-712 typed data; returns a 0x-prefixed signature. `unknown` (with method syntax, which
   * is bivariant) keeps viem's narrower `signTypedData` assignable while remaining callable by
   * anyone implementing a custom signer or test double.
   */
  signTypedData(parameters: unknown): Promise<`0x${string}`>;
}

/** Options for {@link createX402Fetch}. */
export interface X402FetchOptions {
  /** Account used to sign payment authorizations (e.g. a viem `privateKeyToAccount(pk)`). */
  account: X402SignerAccount;
  /** Per-call spend ceiling in USDC (decimal string). Default `'0.06'` (just above the $0.05 metric price). */
  maxPaymentPerCall?: string;
  /** Base fetch to wrap. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
}

const DEFAULT_MAX_PAYMENT_PER_CALL = '0.06';
const USDC_DECIMALS = 6;
// Base mainnet + Base Sepolia (CAIP-2). Registering both lets one wrapped fetch serve either host.
const X402_NETWORKS = ['eip155:8453', 'eip155:84532'] as const;

/**
 * Convert a USDC decimal string (e.g. `'0.06'`) to atomic units (6 decimals). Truncates extra decimals.
 *
 * @throws {GlassnodeInputError} `value` is not a non-negative decimal string (`argument: 'value'`).
 */
export function usdcDecimalToAtomic(value: string): bigint {
  return parseUsdc(value, 'value');
}

function parseUsdc(value: string, argument: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new GlassnodeInputError(`Invalid USDC amount: "${value}"`, { argument });
  }
  const [whole, frac = ''] = value.split('.');
  const fracPadded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || '0');
}

/** Build a payment policy that rejects any payment requirement above `maxAtomic` (atomic USDC units). */
export function createMaxAmountPolicy(maxAtomic: bigint) {
  return (_x402Version: number, requirements: { amount: string }[]): { amount: string }[] =>
    requirements.filter((r) => BigInt(r.amount) <= maxAtomic);
}

/**
 * Create an x402-capable `fetch` for paid Glassnode calls (Node-first).
 *
 * Dynamically loads the optional peer deps `@x402/fetch` + `@x402/evm`; pass the result as the
 * `fetch` option of `GlassnodeAPI` together with `x402: true`.
 *
 * Errors:
 * - Invalid `maxPaymentPerCall` → rejects with `GlassnodeInputError` (`argument: 'maxPaymentPerCall'`).
 * - Optional peer deps not installed → rejects with `GlassnodeConfigError` (import error on `.cause`).
 *
 * The returned fetch rejects with a `GlassnodePaymentError` (surfaced as-is and never retried by
 * `GlassnodeAPI`) when:
 * - the payment layer fails before a paid request is sent — e.g. the server's price is above
 *   `maxPaymentPerCall`, the signer throws, or the `402` carries no usable payment requirements
 *   (`paymentMayHaveSettled: false`: nothing was paid);
 * - the call fails **after** a request carrying a signed payment was sent (`paymentMayHaveSettled:
 *   true`). The server may already have settled that payment and a retry would sign a new one,
 *   so it is never retried. Either the paid request failed in transit (connection reset,
 *   `timeout` abort: the transport error on `.cause`, `timedOut` set for a timeout), or it was
 *   answered with a non-2xx status other than `402` — e.g. a proxy `502`/`504` after the origin
 *   settled, a `429`, a `400` — (`status` set, the equivalent `GlassnodeApiError` on `.cause`).
 *
 * Redirects are never followed: the returned fetch passes `redirect: 'manual'` (a caller's
 * `redirect: 'error'` is kept; `'follow'` is overridden), because fetch's default `'follow'` resends
 * custom headers — the signed `PAYMENT-SIGNATURE` / `X-PAYMENT` — to whatever origin a 3xx names,
 * and a redirected unpaid request could be priced (and paid) by the redirect target. A 3xx to the
 * unpaid request is returned as-is (the client reports `GlassnodeApiError` with the 3xx status,
 * nothing signed); a 3xx to the paid request is a `GlassnodePaymentError` with `status` and
 * `paymentMayHaveSettled: true`, like any other non-2xx after payment.
 *
 * A rejection of, or a non-2xx answer to, the *unpaid* request (no payment signed yet) is passed
 * through unchanged, so the client still reports and retries it (`GlassnodeNetworkError`, or
 * `GlassnodeApiError` for `429`/`5xx`) when retries are enabled: in `x402` mode `maxRetries`
 * defaults to 0, and an explicit value is safe with this fetch because only unpaid attempts are
 * ever retried. A `402` the server returns to the paid request (it
 * refused the payment) is not an error here either; the client reports it as `GlassnodeApiError`
 * (status 402), which it never retries.
 */
export async function createX402Fetch(options: X402FetchOptions): Promise<typeof fetch> {
  const {
    account,
    maxPaymentPerCall = DEFAULT_MAX_PAYMENT_PER_CALL,
    fetch: baseFetch = globalThis.fetch,
  } = options;

  const maxAtomic = parseUsdc(maxPaymentPerCall, 'maxPaymentPerCall');

  const [x402fetchMod, evmMod] = await Promise.all([
    import('@x402/fetch'),
    import('@x402/evm'),
  ]).catch((err) => {
    throw new GlassnodeConfigError(
      "createX402Fetch requires the optional peer dependencies '@x402/fetch', '@x402/evm', and 'viem'. Install them: pnpm add @x402/fetch @x402/evm viem",
      { cause: err }
    );
  });
  const { wrapFetchWithPayment, x402Client } = x402fetchMod;
  const { ExactEvmScheme } = evmMod;

  let client = new x402Client();
  for (const network of X402_NETWORKS) {
    client = client.register(
      network,
      new ExactEvmScheme(account as ConstructorParameters<typeof ExactEvmScheme>[0])
    );
  }
  client = client.registerPolicy(
    createMaxAmountPolicy(maxAtomic) as unknown as Parameters<typeof client.registerPolicy>[0]
  );

  const paymentClient = client;

  return async (input, init) => {
    // Per-call state (the wrapper is built per call so concurrent calls never share it; it is
    // cheap — @x402/fetch only constructs a thin x402HTTPClient around the shared client):
    // - `baseFailure`: a rejection of the *base* fetch, so it can be told apart from failures
    //   raised by the payment layer (which @x402/fetch throws as plain `Error`s, without a cause).
    // - `paymentSent`: whether any request handed to the base fetch carried a signed payment.
    //   Once one did, the payment may settle server-side even if no response ever arrives, so a
    //   later failure must not look retryable: a retry would sign a *new* payment (fresh nonce)
    //   and could charge twice. Detected from the outgoing request itself, so it also covers
    //   @x402/fetch's internal "recovered" re-payment path.
    // - `keys`: the Glassnode API key(s) this call carries (the `api_key` query value and/or the
    //   `X-Api-Key` header), read from the request itself since this fetch is built separately
    //   from the client and never sees its config. Every error text raised below is masked with
    //   them (raw and `api_key=` forms), so a key echoed by x402, the signer or the server never
    //   reaches a message.
    const keys = requestApiKeys(input, init);
    let baseFailure: { error: unknown } | undefined;
    let paymentSent = false;
    const trackedBaseFetch: typeof fetch = async (...args) => {
      if (carriesPayment(args[0], args[1])) paymentSent = true;
      try {
        return await baseFetch(...args);
      } catch (error) {
        baseFailure = { error };
        throw error;
      }
    };
    const paidFetch = wrapFetchWithPayment(trackedBaseFetch, paymentClient) as typeof fetch;
    let response: Response;
    try {
      response = await paidFetch(input, withoutRedirectFollow(input, init));
    } catch (error) {
      if (baseFailure && baseFailure.error === error) {
        // Transport failure before any payment was sent: pass it through untouched (the client
        // reports it as a retryable GlassnodeNetworkError).
        if (!paymentSent) throw error;
        // Transport failure after a payment was sent: the payment may have settled; never retry.
        throw toPaidTransportError(error, keys);
      }
      throw toPaymentError(error, paymentSent, keys);
    }
    // A non-2xx answer once a payment was sent: never hand it back as a plain response, or the
    // client would retry a 429/5xx and sign a new payment. `402` is the exception — the x402
    // "payment refused" answer — so it passes through and the client reports it as a
    // (never-retried) GlassnodeApiError(402).
    if (paymentSent && !response.ok && response.status !== 402) {
      throw await toPaidHttpError(response, keys);
    }
    return response;
  };
}

/**
 * `init` with redirects not followed, so neither the signed payment (`PAYMENT-SIGNATURE` /
 * `X-PAYMENT`) nor an `X-Api-Key` header is ever resent to another origin: fetch's default
 * `redirect: 'follow'` resends custom headers on a cross-origin 3xx (including https→http). A
 * caller's `'error'` or `'manual'` (on `init`, else on a `Request` input) is kept; anything else,
 * including an explicit `'follow'`, becomes `'manual'`. @x402/fetch builds both the unpaid and the
 * paid request from this `init`, so a 3xx to either comes back as a plain response instead.
 */
function withoutRedirectFollow(input: unknown, init: RequestInit | undefined): RequestInit {
  const requested =
    init?.redirect ??
    (typeof input === 'object' && input !== null && 'redirect' in input
      ? (input as { redirect?: unknown }).redirect
      : undefined);
  return { ...init, redirect: requested === 'error' ? 'error' : 'manual' };
}

/**
 * The API key(s) a request carries: its `api_key` query value and its `X-Api-Key` header (from a
 * `Request` input and/or `init.headers`). Best-effort and never throws: an unparsable URL or
 * header object just contributes nothing (the `api_key=` query form is still always masked).
 */
function requestApiKeys(input: unknown, init: RequestInit | undefined): string[] {
  const keys: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value) keys.push(value);
  };
  try {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : typeof input === 'object' && input !== null && 'url' in input
            ? String((input as { url: unknown }).url)
            : undefined;
    if (url) add(new URL(url).searchParams.get('api_key'));
  } catch {
    // Not an absolute URL: nothing to read.
  }
  for (const headers of [
    typeof input === 'object' && input !== null && 'headers' in input
      ? (input as { headers?: HeadersInit }).headers
      : undefined,
    init?.headers,
  ]) {
    try {
      if (headers) add(new Headers(headers).get('X-Api-Key'));
    } catch {
      // Malformed headers: nothing to read.
    }
  }
  return keys;
}

/**
 * Request headers that carry a signed x402 payment (protocol v2 and v1 respectively).
 *
 * Money-safety depends on this list: it MUST track the header names `@x402/core`'s
 * `x402HTTPClient.encodePaymentSignatureHeader` emits (source `src/http/x402HTTPClient.ts`;
 * verified in `@x402/core@2.25.0`, built into `dist/esm/chunk-RAWLCYSQ.mjs`: v2 →
 * `PAYMENT-SIGNATURE`, v1 → `X-PAYMENT`). A header missing here would make a paid request look
 * unpaid, so a failure after payment could be retried and pay twice. `test/x402.spec.ts` fails
 * if the installed library emits a header this list does not recognise.
 */
const PAYMENT_HEADERS = ['PAYMENT-SIGNATURE', 'X-PAYMENT'];

/** Whether a base-fetch call carries an x402 payment header, in its `Request` or its `init`. */
function carriesPayment(input: unknown, init: RequestInit | undefined): boolean {
  const has = (headers: HeadersInit | undefined): boolean => {
    if (!headers) return false;
    const h = new Headers(headers);
    return PAYMENT_HEADERS.some((name) => h.has(name));
  };
  // Duck-typed rather than `instanceof Request`, so a Request from another realm still counts.
  const requestHeaders =
    typeof input === 'object' && input !== null && 'headers' in input
      ? (input as { headers?: HeadersInit }).headers
      : undefined;
  return has(requestHeaders) || has(init?.headers);
}

/**
 * Wrap a transport failure of a request that carried a signed payment. The payment may have
 * settled, so it becomes a `GlassnodePaymentError` (never retried) with `paymentMayHaveSettled`,
 * the transport error on `.cause`, and `timedOut` set when it was the `AbortSignal.timeout()` abort.
 */
function toPaidTransportError(error: unknown, keys: string[]): GlassnodePaymentError {
  const { name, message } =
    typeof error === 'object' && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : { name: undefined, message: undefined };
  const detail =
    typeof message === 'string' && message
      ? redactSecrets(message, keys)
      : typeof error === 'string' && error
        ? redactSecrets(error, keys)
        : typeof name === 'string' && name
          ? redactSecrets(name, keys)
          : 'unknown error';
  return new GlassnodePaymentError(
    `x402 paid request failed after the payment was sent (${detail}) — the payment may have settled; not retried to avoid paying twice`,
    { cause: error, paymentMayHaveSettled: true, timedOut: name === 'TimeoutError' }
  );
}

/**
 * Turn a non-2xx response to a request that carried a signed payment into a `GlassnodePaymentError`
 * (never retried) with `paymentMayHaveSettled`, the `status`, and the equivalent
 * `GlassnodeApiError` (status, statusText, server detail) on `.cause`. The detail is the response
 * body's message and the status text with the API key masked (`api_key` query values and the
 * request's own key, see `redactSecrets`); no request header (signature) is used.
 */
async function toPaidHttpError(response: Response, keys: string[]): Promise<GlassnodePaymentError> {
  const detail = await readErrorDetail(response, keys);
  const statusText = redactSecrets(response.statusText, keys);
  const apiError = new GlassnodeApiError(response.status, statusText, detail);
  const label = [statusText, detail].filter(Boolean).join(' — ');
  return new GlassnodePaymentError(
    `x402 paid request failed with HTTP ${response.status}${label ? ` (${label})` : ''} after the payment was sent — the payment may have settled; not retried to avoid paying twice`,
    { cause: apiError, paymentMayHaveSettled: true, status: response.status }
  );
}

/**
 * Wrap a payment-layer failure. The message is x402's own (which names the failing step, e.g.
 * "Failed to create payment payload: …"), with the API key masked (`api_key` query values and the
 * request's own key, see `redactSecrets`): x402 dumps the server's payment requirements into some
 * messages, and a signer's error text is included verbatim. The raw error stays on `.cause`.
 */
function toPaymentError(
  error: unknown,
  paymentSent: boolean,
  keys: string[]
): GlassnodePaymentError {
  const detail =
    error instanceof Error && error.message ? redactSecrets(error.message, keys) : 'unknown error';
  const hint = /filtered out by policies/.test(detail)
    ? ' (the price exceeds maxPaymentPerCall)'
    : '';
  const sent = paymentSent ? ' (a payment was already sent and may have settled)' : '';
  return new GlassnodePaymentError(`x402 payment failed: ${detail}${hint}${sent}`, {
    cause: error,
    paymentMayHaveSettled: paymentSent,
  });
}
