const STATUS_MESSAGES: Record<number, string> = {
  400: 'Bad request',
  401: 'Invalid or missing API key',
  402: 'Payment required — either the fetch is not x402-capable (use createX402Fetch from glassnode-api/x402) or the server refused the payment (e.g. insufficient USDC on Base); a price above maxPaymentPerCall raises GlassnodePaymentError instead',
  403: 'Access forbidden — check your API tier',
  404: 'Endpoint or metric not found',
  429: 'Rate limit exceeded',
};

/**
 * Base class for every error raised by this library. Catch this to handle any failure from
 * `GlassnodeAPI`; branch on the subclasses to tell the kinds apart.
 *
 * `name` is set explicitly on each class (rather than from `constructor.name`) so it survives
 * minification of the browser bundle.
 *
 * The API key never appears in the `message` or any other string property (`detail`,
 * `statusText`, ...) of an error this library builds: text from outside (server bodies, status
 * texts, transport and x402 errors) is masked first — `api_key=<value>` always, raw copies of the
 * key when it has at least 8 characters. **`.cause` is not redacted**: it keeps the original
 * object, which may quote the request URL or the key, so do not log `.cause` where the key must
 * not appear.
 */
export class GlassnodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GlassnodeError';
  }
}

/** The API answered with a non-2xx HTTP status. */
export class GlassnodeApiError extends GlassnodeError {
  /** HTTP status code of the response (e.g. `429`, `503`). */
  readonly status: number;
  /** HTTP status text of the response as received (may be empty, e.g. over HTTP/2). */
  readonly statusText: string;
  /** Server-provided error detail parsed from the response body, if any. */
  readonly detail?: string;

  constructor(status: number, statusText: string, detail?: string) {
    const base =
      STATUS_MESSAGES[status] ??
      (status >= 300 && status < 400
        ? `Redirect not followed${statusText ? ` (${statusText})` : ''} — the client never sends the X-Api-Key header or an x402 payment to a redirect target; point apiUrl at the final URL`
        : statusText);
    super(`API request failed (${status}): ${base}${detail ? ` — ${detail}` : ''}`);
    this.name = 'GlassnodeApiError';
    this.status = status;
    this.statusText = statusText;
    this.detail = detail;
  }

  /** True for 429 and 5xx — the statuses the client retries (when `maxRetries` > 0). */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * The request or response body failed in transit: DNS/connection failure, reset, or the per-request
 * `timeout` firing (also an abort that did not come from the caller's per-call `signal`). The
 * original error is on `.cause`. Retried when `maxRetries` > 0. A cancellation through the
 * per-call `signal` is a {@link GlassnodeAbortError} instead.
 */
export class GlassnodeNetworkError extends GlassnodeError {
  /** True when the failure was the per-request `timeout` (an `AbortSignal.timeout()` abort). */
  readonly timedOut: boolean;

  constructor(message: string, options: { cause?: unknown; timedOut: boolean }) {
    super(message, { cause: options.cause });
    this.name = 'GlassnodeNetworkError';
    this.timedOut = options.timedOut;
  }
}

/**
 * The call was cancelled through the `signal` passed in its per-call options (see `CallOptions`):
 * the signal was already aborted when the method was called, or it aborted during a request or a
 * retry wait. The signal's `reason` is on `.cause` (by default a `DOMException` named
 * `AbortError`; a `TimeoutError` when the signal was `AbortSignal.timeout()`). Never retried.
 *
 * A separate class from {@link GlassnodeNetworkError} on purpose: a cancellation is the caller's
 * own decision, not a failure, so code that retries network errors must not retry it, and a
 * per-attempt `timeout` (`GlassnodeNetworkError` with `timedOut: true`) stays distinguishable.
 */
export class GlassnodeAbortError extends GlassnodeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GlassnodeAbortError';
  }
}

/**
 * A successful (2xx) response could not be used: the body was not valid JSON, or it did not
 * match the expected schema. The underlying `SyntaxError` / `ZodError` is on `.cause`. Never
 * retried — it is not a transient error.
 */
export class GlassnodeValidationError extends GlassnodeError {
  /** API endpoint path (no host or query string) whose response failed validation. */
  readonly endpoint: string;

  constructor(message: string, options: { cause?: unknown; endpoint: string }) {
    super(message, { cause: options.cause });
    this.name = 'GlassnodeValidationError';
    this.endpoint = options.endpoint;
  }
}

/**
 * The configuration passed to the `GlassnodeAPI` constructor is invalid (the `ZodError` is on
 * `.cause`), or `createX402Fetch` could not load its optional peer dependencies (the import error
 * is on `.cause`).
 */
export class GlassnodeConfigError extends GlassnodeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'GlassnodeConfigError';
  }
}

/**
 * An argument passed to a client method is invalid (e.g. a malformed metric path, or a query
 * parameter the client controls itself such as `f` or `api_key`). Raised before any request is
 * sent — no network call is made. Never retried.
 */
export class GlassnodeInputError extends GlassnodeError {
  /**
   * Which argument was rejected: `metricPath`, `params.<name>` for a query parameter, or
   * `options` / `options.signal` / `options.timeout` for the per-call options. From the
   * x402 helpers: `maxPaymentPerCall` (`createX402Fetch`) or `value` (`usdcDecimalToAtomic`).
   */
  readonly argument: string;

  constructor(message: string, options: { argument: string; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = 'GlassnodeInputError';
    this.argument = options.argument;
  }
}

/**
 * An x402 paid call failed in the payment layer. Only raised by a fetch built with
 * `createX402Fetch` (from `glassnode-api/x402`), and **never retried** by the client. Two cases,
 * told apart by {@link GlassnodePaymentError.paymentMayHaveSettled}:
 *
 * - `false` — nothing was paid: the payment layer (`@x402/fetch`) failed before a paid request was
 *   sent, e.g. every payment requirement the server offered was above `maxPaymentPerCall` (or
 *   x402's own spend controls), the signer failed, or the server's `402` carried no usable payment
 *   requirements. The same request would fail the same way.
 * - `true` — a request carrying a signed payment was sent, and the call then failed: either the
 *   paid request failed in transit (connection reset, or the `timeout` abort), or it was answered
 *   with a non-2xx HTTP status other than `402` (e.g. a gateway `502`/`504`, a `429`, a `400`).
 *   The server (or the origin behind a proxy) may already have received the payment and settled
 *   it on-chain, so a retry would sign a **new** payment and could charge twice. Check the
 *   payer's on-chain transfers before retrying. For a transport failure the original error is on
 *   `.cause` and {@link GlassnodePaymentError.timedOut} says whether it was the per-request
 *   `timeout`; for an HTTP failure {@link GlassnodePaymentError.status} is set and `.cause` is the
 *   {@link GlassnodeApiError} (with `status`, `statusText`, `detail`) the response amounts to.
 *
 * The original error is on `.cause`. A transport failure or `429`/`5xx` of the *unpaid* request
 * (before any payment was signed) stays a retryable {@link GlassnodeNetworkError} /
 * {@link GlassnodeApiError}; a `402` answer to the paid request (the server refused the payment,
 * e.g. insufficient USDC) stays a {@link GlassnodeApiError} with `status` 402, which is never
 * retried either.
 */
export class GlassnodePaymentError extends GlassnodeError {
  /**
   * True when a signed payment had already been sent to the server when the call failed, so the
   * payment may have settled even though no usable response was received. Do not blindly retry.
   */
  readonly paymentMayHaveSettled: boolean;
  /**
   * True when the failure was the per-request `timeout` (an `AbortSignal.timeout()` abort) firing
   * on the paid request. Always false when `paymentMayHaveSettled` is false.
   */
  readonly timedOut: boolean;
  /**
   * HTTP status of the response to the paid request, when the call failed because that response
   * was not 2xx (the matching {@link GlassnodeApiError} is on `.cause`). `undefined` when no such
   * response was received (a payment-layer or transport failure).
   */
  readonly status?: number;

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      paymentMayHaveSettled?: boolean;
      timedOut?: boolean;
      status?: number;
    }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'GlassnodePaymentError';
    this.paymentMayHaveSettled = options?.paymentMayHaveSettled ?? false;
    this.timedOut = options?.timedOut ?? false;
    this.status = options?.status;
  }
}
