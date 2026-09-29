import { z } from 'zod';
import type { GlassnodeHooks } from './hooks.js';

/**
 * Logger function type for API call logging. It is never awaited, and a logger that throws or
 * returns a rejected promise is ignored: it cannot change a call's result, retries or errors.
 */
export type Logger = (message: string, ...args: unknown[]) => void;

/**
 * Type of the `fetch` config option: the call the client makes. It is only ever called with a
 * string URL, as `fetch(url)` or `fetch(url, init)`, and must resolve to a standard `Response`.
 * When `init` carries the `X-Api-Key` header it also sets `redirect: 'manual'`; a custom fetch
 * should honour it (or not follow redirects at all) so the key never reaches another origin.
 * `globalThis.fetch`, `vi.fn()` mocks, the fetch from `createX402Fetch()` and string-only custom
 * fetches (`(url: string, init?: RequestInit) => Promise<Response>`) all fit.
 */
export type GlassnodeFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Default free Glassnode API base URL. */
export const DEFAULT_API_URL = 'https://api.glassnode.com';
/** x402 (paid) Glassnode API base URL — Base mainnet. */
export const X402_API_URL = 'https://x402.glassnode.com';
// A testnet/staging x402 endpoint is not hardcoded here — pass its URL via the `apiUrl` config option.

/**
 * Default `maxRetries` when `x402` is off: up to 3 attempts for a `429`/`5xx` or a transport
 * failure. Applied by the `GlassnodeAPI` constructor when `maxRetries` is not set;
 * {@link GlassnodeConfigSchema} leaves an unset `maxRetries` as `undefined`.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * Default `maxRetries` when `x402` is on: no retries. The client cannot tell whether a
 * caller-supplied payment fetch refuses to retry after a signed payment was sent, so it never
 * retries a paid call unless the caller opts in with an explicit `maxRetries` (safe with the
 * fetch from `createX402Fetch`, which only lets unpaid attempts be retried).
 */
export const DEFAULT_X402_MAX_RETRIES = 0;

/**
 * Largest timer delay (ms) every runtime supports: 2^31 - 1 (~24.8 days). Larger delays overflow
 * `setTimeout` (Node fires them after 1 ms) and make `AbortSignal.timeout()` throw a RangeError.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** A positive integer delay in ms that fits in a timer. */
const timerMs = () =>
  z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_MS, `must be at most ${MAX_TIMER_MS} ms (the largest timer delay)`);

/**
 * A function option, checked with `typeof v === 'function'` and kept as given: `z.custom`, unlike
 * `z.function()` (which replaces the value with a wrapper), so the client calls the very function
 * that was passed. `T` is the option's public type, which gives callbacks contextual types in
 * `GlassnodeConfig`.
 */
const fn = <T>() => z.custom<T>((v) => typeof v === 'function', 'must be a function');

/** One optional hook, typed with its event. */
const hook = <K extends keyof GlassnodeHooks>() => fn<NonNullable<GlassnodeHooks[K]>>().optional();

/** The `hooks` option. Strict, so a misspelled hook name fails instead of never firing. */
const HooksSchema = z.strictObject({
  onRequest: hook<'onRequest'>(),
  onResponse: hook<'onResponse'>(),
  onRetry: hook<'onRetry'>(),
  onError: hook<'onError'>(),
});

/**
 * Zod schema for Glassnode API configuration
 */
export const GlassnodeConfigSchema = z
  .object({
    /** API key for authentication. Required unless `x402` is enabled. */
    apiKey: z.string().min(1, 'API key is required').optional(),

    /**
     * Where the API key is sent: `'query'` (default) as the `api_key` query parameter, or
     * `'header'` as the `X-Api-Key` request header, which keeps the key out of URLs (and so out
     * of access logs, proxies, tracing and transport errors). `'header'` is for server-side use:
     * the Glassnode API's CORS preflight does not allow `X-Api-Key`, so browsers block it.
     *
     * With `'header'`, redirects are not followed (the request is sent with `redirect: 'manual'`):
     * fetch would otherwise resend `X-Api-Key` to whatever origin a 3xx names. A 3xx surfaces as
     * a non-retried `GlassnodeApiError` with that status; point `apiUrl` at the final URL.
     * `'query'` keeps fetch's default redirect handling (the URL, key included, goes wherever the
     * server's `Location` says, which only the server that already received the key controls).
     */
    apiKeyLocation: z.enum(['query', 'header']).default('query'),

    /**
     * Base URL for the Glassnode API. Default `https://api.glassnode.com`, or
     * `https://x402.glassnode.com` when `x402` is set. An explicit value always wins over the
     * `x402` preset.
     */
    apiUrl: z.string().url().optional(),

    /** Route requests through the x402 paid endpoint (`https://x402.glassnode.com`). */
    x402: z.boolean().default(false),

    /** Optional logger for API call debugging; its own failures (throw/rejection) are ignored. */
    logger: fn<Logger>().optional(),

    /**
     * Optional structured observability hooks (`onRequest`, `onResponse`, `onRetry`, `onError`),
     * called synchronously and never awaited; a failing hook never affects the call. See
     * {@link GlassnodeHooks}.
     */
    hooks: HooksSchema.optional(),

    /**
     * Optional custom fetch function (e.g. an x402-wrapped fetch, or for testing). Called with a
     * string URL as `fetch(url)` or `fetch(url, init)`; see {@link GlassnodeFetch}.
     */
    fetch: fn<GlassnodeFetch>().optional(),

    /**
     * Maximum number of retries for retryable failures: a `429`/`5xx` response, or a transport
     * failure (`GlassnodeNetworkError`, including a per-attempt `timeout`). Default 2
     * ({@link DEFAULT_MAX_RETRIES}, up to 3 attempts); `0` disables retries. The schema leaves an
     * unset value `undefined`; the `GlassnodeAPI` constructor applies the default, which depends
     * on `x402`.
     *
     * In `x402` mode the default is 0 ({@link DEFAULT_X402_MAX_RETRIES}): the client cannot tell
     * whether the `fetch` it was given refuses to retry after a signed payment was sent. The fetch from `createX402Fetch` does
     * (such a failure becomes a never-retried `GlassnodePaymentError`), so with it an explicit
     * `maxRetries` only ever retries unpaid requests; with a bare x402 wrapper, a retry after a
     * paid `5xx` or a timeout would sign a new payment and could pay twice.
     */
    maxRetries: z.number().int().nonnegative().optional(),

    /** Base delay in milliseconds between retries (doubles each attempt, then full jitter). */
    retryDelay: timerMs().default(1000),

    /** Upper bound (ms) for a single retry wait, after exponential growth. */
    maxRetryDelay: timerMs().default(30000),

    /**
     * Per-request timeout in milliseconds. When set, each attempt is aborted via
     * `AbortSignal.timeout()` after this many ms (a fresh signal per retry). Unset = no timeout.
     */
    timeout: timerMs().optional(),
  })
  .refine((c) => c.x402 || (c.apiKey !== undefined && c.apiKey.length > 0), {
    message: 'apiKey is required unless x402 is enabled',
    path: ['apiKey'],
  })
  .refine((c) => !c.x402 || c.fetch !== undefined, {
    message:
      'fetch is required when x402 is enabled — pass an x402-capable fetch (see glassnode-api/x402)',
    path: ['fetch'],
  });

/**
 * Configuration for the Glassnode API client
 */
export type GlassnodeConfig = z.input<typeof GlassnodeConfigSchema>;
