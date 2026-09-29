import {
  GlassnodeConfig,
  GlassnodeConfigSchema,
  Logger,
  GlassnodeFetch,
  DEFAULT_API_URL,
  X402_API_URL,
} from './types/config.js';
import type { z, ZodType, ZodError } from 'zod';
import {
  GlassnodeError,
  GlassnodeAbortError,
  GlassnodeApiError,
  GlassnodeConfigError,
  GlassnodeInputError,
  GlassnodeNetworkError,
  GlassnodeValidationError,
} from './errors.js';
import { readErrorDetail } from './error-detail.js';
import { redactApiKey, redactSecrets } from './redact.js';
import {
  AssetMetadataResponse,
  MetricMetadataResponse,
  AssetMetadataResponseSchema,
  MetricMetadataResponseSchema,
  MetricListResponse,
  MetricListResponseSchema,
  MetricStatsResponse,
  MetricStatsResponseSchema,
  BulkResponse,
  BulkResponseSchema,
} from './types/metadata.js';
import type { MetricParams } from './types/params.js';
import type { CallOptions, CallMetricOptions } from './types/call-options.js';
import type {
  GlassnodeHooks,
  GlassnodeHookEventBase,
  GlassnodeRetryReason,
} from './types/hooks.js';

/** `name`s of the abort rejections fetch produces: `AbortSignal.timeout()` and a plain abort. */
const ABORT_NAMES = new Set(['TimeoutError', 'AbortError']);

/**
 * Classify a fetch rejection by its *shape*, not `instanceof Error`: a DOMException from another
 * realm, a polyfill or a custom fetch may reject with a non-Error object that still has a `name`.
 * Returns undefined when the rejection is neither an Error nor a TimeoutError/AbortError-named
 * object (e.g. a string) — that case stays "Unknown error occurred" and is not retried.
 */
function describeTransportFailure(
  error: unknown
): { message: string; timedOut: boolean } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, message } = error as { name?: unknown; message?: unknown };
  const isAbort = typeof name === 'string' && ABORT_NAMES.has(name);
  if (!(error instanceof Error) && !isAbort) return undefined;
  return {
    // AbortSignal.timeout() rejects with a DOMException named 'TimeoutError'.
    timedOut: name === 'TimeoutError',
    // A real Error keeps its message verbatim (as before); a bare object falls back to its name.
    message:
      error instanceof Error
        ? error.message
        : typeof message === 'string' && message
          ? message
          : String(name),
  };
}

/** Summarise Zod issues as `path: message` pairs (first few only) for an error message. */
function summarizeIssues(error: ZodError, max = 3): string {
  const parts = error.issues
    .slice(0, max)
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
  const more = error.issues.length - parts.length;
  return parts.join('; ') + (more > 0 ? ` (+${more} more)` : '');
}

/**
 * Validate an API response against its schema, raising a GlassnodeValidationError on mismatch.
 * `redact` masks the API key in the issue summary: issue paths carry keys of the server's
 * response (e.g. record keys), which is text from outside the library.
 */
function validateResponse<T>(
  schema: ZodType<T>,
  data: unknown,
  endpoint: string,
  redact: (text: string) => string
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw new GlassnodeValidationError(
    `Glassnode API error: response from ${endpoint} did not match the expected schema — ${redact(summarizeIssues(result.error))}`,
    { cause: result.error, endpoint }
  );
}

/** One metric path segment: URL-safe characters only, so the path never needs encoding. */
const METRIC_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Return why `path` is not a valid metric path, or undefined if it is valid. */
function metricPathProblem(path: string): string | undefined {
  if (path === '') return 'must not be empty';
  if (/\s/.test(path)) return 'must not contain whitespace';
  if (!path.startsWith('/')) {
    const fixed = '/' + path;
    return metricPathProblem(fixed) === undefined
      ? `must start with "/" (did you mean "${fixed}"?)`
      : 'must start with "/"';
  }
  for (const segment of path.slice(1).split('/')) {
    if (segment === '') return 'must not contain an empty segment ("//" or a trailing "/")';
    if (segment === '.' || segment === '..') return `must not contain a "${segment}" segment`;
    if (!METRIC_PATH_SEGMENT.test(segment)) {
      return 'contains an invalid character (allowed: letters, digits, "_", "-", "." and "/")';
    }
  }
  return undefined;
}

/**
 * Validate a caller-supplied metric path (e.g. `/market/price_usd_close`). Malformed paths are
 * rejected — never silently rewritten — with a GlassnodeInputError, before any request is made.
 * Messages never echo a full URL or a query string, which could carry an API key.
 */
function assertMetricPath(path: unknown): asserts path is string {
  const fail = (reason: string): never => {
    throw new GlassnodeInputError(`Invalid metricPath: ${reason}`, { argument: 'metricPath' });
  };
  if (typeof path !== 'string') return fail(`must be a string, got ${typeof path}`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return fail('pass only the metric path (e.g. "/market/price_usd_close"), not a full URL');
  }
  if (path.includes('?')) {
    return fail('must not include a query string — pass query parameters via `params` instead');
  }
  if (path.includes('#')) return fail('must not contain "#"');
  const problem = metricPathProblem(path);
  if (problem) fail(`${JSON.stringify(path)} ${problem}`);
}

/**
 * Validate a metric path for callBulkMetric, which appends `/bulk` itself: on top of
 * assertMetricPath, a path that already ends in a `/bulk` segment (e.g. the metadata's
 * `refs.metric_variant.bulk`) is rejected rather than silently rewritten, since it would request
 * `…/bulk/bulk`. The message suggests the base path and never echoes a URL or a query string.
 */
function assertBulkMetricPath(path: unknown): asserts path is string {
  assertMetricPath(path);
  if (!path.endsWith('/bulk')) return;
  const base = path.slice(0, -'/bulk'.length);
  const hint = base === '' ? '' : ` (did you mean ${JSON.stringify(base)}?)`;
  throw new GlassnodeInputError(
    `Invalid metricPath: ${JSON.stringify(path)} must not end in "/bulk" — callBulkMetric ` +
      `appends it; pass the base path${hint}`,
    { argument: 'metricPath' }
  );
}

/**
 * The epoch-ms time of a Date (NaN for an invalid one), or undefined if `value` is not a Date.
 * A brand check rather than `instanceof`, so a Date from another realm (iframe, `vm`) counts too.
 */
function dateTime(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Date.prototype.getTime.call(value);
  } catch {
    return undefined;
  }
}

/** The string form of a caller-supplied param value, or why it cannot be sent. */
function formatParamValue(value: unknown): { value: string } | { problem: string } {
  if (typeof value === 'string') return { value };
  if (typeof value === 'boolean') return { value: value ? 'true' : 'false' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { problem: `must be a finite number, got ${value}` };
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return {
        problem: `${value} is outside the safe integer range (±${Number.MAX_SAFE_INTEGER}) and may have lost precision — pass it as a string`,
      };
    }
    // Number#toString is locale-independent and gives the shortest round-trip form; -0 → "0".
    const text = String(value);
    if (/e/i.test(text)) {
      return { problem: `${text} would be sent in exponent notation — pass it as a string` };
    }
    return { value: text };
  }
  const ms = dateTime(value);
  if (ms !== undefined) {
    if (Number.isNaN(ms)) return { problem: 'is an invalid Date' };
    // Unix seconds, floored to the second the instant falls in (also for pre-1970 dates).
    return { value: String(Math.floor(ms / 1000)) };
  }
  if (value === null) {
    return { problem: 'must not be null — omit the parameter (or pass undefined) instead' };
  }
  const kind = Array.isArray(value) ? 'array' : typeof value;
  return { problem: `must be a string, number, boolean or Date, got ${kind}` };
}

/**
 * Query parameters ready to send: each value is one string, or (from an array) the strings the
 * parameter is repeated with, in order.
 */
type NormalizedParams = Record<string, string | string[]>;

/**
 * Validate caller-supplied query parameters and convert them to the strings that are sent (see
 * `MetricParamValue`): `undefined` values are dropped, invalid values are rejected, and a
 * non-empty array becomes the parameter repeated once per element (each converted the same way).
 * Also rejects parameters the client sets itself, instead of silently overriding them: `api_key`
 * always (configure `apiKey` instead), `f` unless it asks for JSON (the client only parses JSON),
 * and any extra names in `reserved` (e.g. `path` for the metadata endpoints). Keeps key order,
 * so string-only params produce exactly the same URL as before.
 */
function normalizeParams(
  params: unknown,
  options: { format?: boolean; reserved?: string[] } = {}
): NormalizedParams {
  // A null-prototype record, so a "__proto__" param stays an ordinary key.
  const out: NormalizedParams = Object.create(null);
  if (params === undefined || params === null) return out;
  if (typeof params !== 'object' || Array.isArray(params) || dateTime(params) !== undefined) {
    throw new GlassnodeInputError(
      `Invalid params: must be an object of query parameters (e.g. { a: 'BTC' }), got ${Array.isArray(params) ? 'array' : typeof params}`,
      { argument: 'params' }
    );
  }
  const record = params as Record<string, unknown>;
  // Only defined values count: `{ api_key: undefined }` is the same as omitting it.
  const has = (name: string) =>
    Object.prototype.hasOwnProperty.call(record, name) && record[name] !== undefined;
  if (has('api_key')) {
    throw new GlassnodeInputError(
      'Invalid params: `api_key` must not be passed as a query parameter — set `apiKey` in the GlassnodeAPI config instead',
      { argument: 'params.api_key' }
    );
  }
  if (options.format && has('f')) {
    const f = record.f;
    if (typeof f !== 'string' || f.toLowerCase() !== 'json') {
      throw new GlassnodeInputError(
        `Invalid params: f=${formatForMessage(f)} is not supported — this client only supports JSON responses (omit \`f\`)`,
        { argument: 'params.f' }
      );
    }
  }
  for (const name of options.reserved ?? []) {
    if (has(name)) {
      throw new GlassnodeInputError(
        `Invalid params: \`${name}\` is set by the client from the metricPath argument and must not be passed in params`,
        { argument: `params.${name}` }
      );
    }
  }
  for (const name of Object.keys(record)) {
    const raw = record[name];
    if (raw === undefined) continue;
    const fail = (subject: string, problem: string): never => {
      throw new GlassnodeInputError(`Invalid params: \`${subject}\` ${problem}`, {
        argument: `params.${name}`,
      });
    };
    if (!Array.isArray(raw)) {
      const result = formatParamValue(raw);
      if ('problem' in result) fail(name, result.problem);
      else out[name] = result.value;
      continue;
    }
    // An array is sent as the parameter repeated once per element (`a=BTC&a=ETH`), in order.
    if (SINGLE_VALUED_PARAMS.has(name)) {
      fail(name, 'takes a single value, got an array');
    }
    if (raw.length === 0) {
      // Omitting it would silently widen the request to the server default (e.g. every asset).
      fail(name, 'must not be an empty array — omit the parameter (or pass undefined) instead');
    }
    const values: string[] = [];
    // An index loop (not for…of / map) so holes in a sparse array are seen as undefined.
    for (let index = 0; index < raw.length; index++) {
      const element: unknown = raw[index];
      const subject = `${name}[${index}]`;
      if (element === undefined) fail(subject, 'must not be undefined');
      const result = formatParamValue(element);
      if ('problem' in result) fail(subject, result.problem);
      else values.push(result.value);
    }
    out[name] = values;
  }
  return out;
}

/**
 * Parameters Glassnode only ever takes one value for (the bulk-metrics docs list `s`, `u`, `i`,
 * `c` and `f` as fixed per request), so an array for them is rejected rather than repeated.
 * `f` never reaches this check: a non-string `f` is already rejected as non-JSON.
 */
const SINGLE_VALUED_PARAMS: ReadonlySet<string> = new Set(['s', 'u', 'i', 'c', 'f']);

/**
 * Build the query string from normalized params, in key order: a string value is one
 * `name=value` pair, a string array is the name repeated once per element (never comma-joined).
 * Byte-identical to `new URLSearchParams(record)` when every value is a string.
 */
function buildQuery(params: NormalizedParams): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string') query.append(name, value);
    else for (const element of value) query.append(name, element);
  }
  return query;
}

/** Render a rejected value for an error message without throwing (e.g. on a symbol or bigint). */
function formatForMessage(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (dateTime(value) !== undefined) return 'a Date';
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

/** Largest per-call `timeout` (ms): the maximum timer delay every runtime supports (2^31 - 1). */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Per-call options after validation. */
interface ResolvedCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Whether `value` looks like an AbortSignal. Duck-typed rather than `instanceof AbortSignal`, so a
 * signal from another realm or a spec-compliant polyfill is accepted too.
 */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<AbortSignal>;
  return (
    typeof s.aborted === 'boolean' &&
    typeof s.addEventListener === 'function' &&
    typeof s.removeEventListener === 'function'
  );
}

/**
 * Validate the per-call options argument (see {@link CallOptions}). `undefined`/`null` and
 * `undefined` fields mean "not set". Invalid values reject with a GlassnodeInputError before any
 * request is made.
 */
function normalizeCallOptions(options: unknown): ResolvedCallOptions {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new GlassnodeInputError(
      `Invalid options: must be an object such as { signal, timeout }, got ${Array.isArray(options) ? 'array' : typeof options}`,
      { argument: 'options' }
    );
  }
  const { signal, timeout } = options as { signal?: unknown; timeout?: unknown };
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new GlassnodeInputError(
      `Invalid options: \`signal\` must be an AbortSignal, got ${formatForMessage(signal)}`,
      { argument: 'options.signal' }
    );
  }
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout <= 0 ||
      timeout > MAX_TIMEOUT_MS)
  ) {
    throw new GlassnodeInputError(
      `Invalid options: \`timeout\` must be a positive integer number of milliseconds (at most ${MAX_TIMEOUT_MS}), got ${formatForMessage(timeout)}`,
      { argument: 'options.timeout' }
    );
  }
  return { signal, timeout };
}

/**
 * The `schema` of callMetric's options (already checked to be an object or nullish by
 * normalizeCallOptions), or undefined when none is set. Anything that is not a Zod schema
 * (duck-typed on `safeParse`, so a schema from another copy of zod works too) rejects with a
 * GlassnodeInputError before any request is made.
 */
function metricSchema(options: unknown): ZodType | undefined {
  if (options === undefined || options === null) return undefined;
  const { schema } = options as { schema?: unknown };
  if (schema === undefined) return undefined;
  if (
    typeof schema !== 'object' ||
    schema === null ||
    typeof (schema as { safeParse?: unknown }).safeParse !== 'function'
  ) {
    throw new GlassnodeInputError(
      `Invalid options: \`schema\` must be a Zod schema (e.g. TimeSeriesResponseSchema), got ${formatForMessage(schema)}`,
      { argument: 'options.schema' }
    );
  }
  return schema as ZodType;
}

/**
 * An AbortSignal that aborts (with the same `reason`) as soon as either input signal aborts, and a
 * `dispose` that removes the listeners it added. A small stand-in for `AbortSignal.any()`, which
 * only exists from Node 20.3 (this package supports Node >= 18). Calling `dispose` once the
 * attempt is over keeps a long-lived caller signal from accumulating listeners across calls.
 */
function combineSignals(
  a: AbortSignal,
  b: AbortSignal
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const listeners: [AbortSignal, () => void][] = [];
  const dispose = () => {
    for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
    listeners.length = 0;
  };
  for (const source of [a, b]) {
    if (source.aborted) {
      controller.abort(source.reason);
      dispose();
      break;
    }
    const listener = () => {
      controller.abort(source.reason);
      dispose();
    };
    source.addEventListener('abort', listener);
    listeners.push([source, listener]);
  }
  return { signal: controller.signal, dispose };
}

/**
 * Wait `ms` before a retry. Resolves early (without waiting out the delay) when `signal` aborts;
 * the caller checks `signal.aborted` afterwards. The timer and the listener are always cleaned up.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(resolve, ms);
      return;
    }
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Next per-call correlation id (see `GlassnodeHookEventBase.callId`); process-local. */
let nextCallId = 1;

/** Per-call state behind the hook events of one call. */
interface CallTrace {
  callId: number;
  endpoint: string;
  /** Request URL with the API key masked. */
  url: string;
  maxAttempts: number;
  /** `performance.now()` when the call started. */
  startedAt: number;
  /** 1-based number of the current (or last) attempt; 0 before the first one is sent. */
  attempt: number;
  /** Duration (ms) of the last attempt that settled, if any. */
  lastDurationMs?: number;
}

/** The hook event of a hook `K`. */
type HookEvent<K extends keyof GlassnodeHooks> = Parameters<NonNullable<GlassnodeHooks[K]>>[0];

/** Why a retryable error is retried, for `onRetry`. */
function retryCause(error: GlassnodeError | undefined): {
  reason: GlassnodeRetryReason;
  status?: number;
} {
  if (error instanceof GlassnodeApiError) return { reason: 'status', status: error.status };
  return {
    reason: error instanceof GlassnodeNetworkError && error.timedOut ? 'timeout' : 'network',
  };
}

/** The HTTP status behind an error, if any (`GlassnodeApiError`, `GlassnodePaymentError`). */
function errorStatus(error: GlassnodeError): number | undefined {
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * If `value` is a thenable (e.g. the promise an `async` callback returns), attach `handler` for its
 * rejection so it never becomes an unhandled rejection. May throw (a throwing `then` getter or
 * `then` call); callers wrap it in `try`.
 */
function onRejected(value: unknown, handler: (error: unknown) => void): void {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    const then = (value as PromiseLike<unknown>).then;
    if (typeof then === 'function') then.call(value, undefined, handler);
  }
}

/**
 * Glassnode API client
 */
export class GlassnodeAPI {
  private apiKey: string | undefined;
  private apiKeyLocation: 'query' | 'header';
  private apiUrl: string;
  private logger?: Logger;
  private hooks?: GlassnodeHooks;
  private fetchFn: GlassnodeFetch;
  private maxRetries: number;
  private retryDelay: number;
  private maxRetryDelay: number;
  private timeout?: number;

  /**
   * Create a new Glassnode API client
   * @param config Configuration object
   */
  constructor(config: GlassnodeConfig) {
    // Validate config with Zod; surface failures as a GlassnodeConfigError (ZodError on `.cause`).
    const parsed = GlassnodeConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new GlassnodeConfigError(
        `Invalid GlassnodeAPI config: ${summarizeIssues(parsed.error, Infinity)}`,
        { cause: parsed.error }
      );
    }
    const validatedConfig = parsed.data;

    this.apiKey = validatedConfig.apiKey;
    this.apiKeyLocation = validatedConfig.apiKeyLocation;
    this.apiUrl = validatedConfig.apiUrl ?? (validatedConfig.x402 ? X402_API_URL : DEFAULT_API_URL);
    this.logger = validatedConfig.logger;
    this.hooks = validatedConfig.hooks;
    this.fetchFn = validatedConfig.fetch ?? globalThis.fetch;
    this.maxRetries = validatedConfig.maxRetries;
    this.retryDelay = validatedConfig.retryDelay;
    this.maxRetryDelay = validatedConfig.maxRetryDelay;
    this.timeout = validatedConfig.timeout;
  }

  /**
   * Mask the API key in text from outside the library before it goes into an error: any
   * `api_key=` query value, plus any raw (or URL-encoded) occurrence of the configured key when
   * it is long enough to mask safely (see `redactSecrets`). Applied to server error bodies and
   * status texts, transport error messages and schema-issue summaries.
   */
  private redact(text: string): string {
    return redactSecrets(text, [this.apiKey]);
  }

  /**
   * Call hook `name` with the event `build()` makes, if the hook is set. Synchronous and never
   * awaited; a throw or a rejected promise is swallowed (and reported to the logger), so a hook
   * can never change a call's outcome or its retries.
   */
  private emit<K extends keyof GlassnodeHooks>(name: K, build: () => HookEvent<K>): void {
    const hook = this.hooks?.[name] as ((event: HookEvent<K>) => unknown) | undefined;
    if (!hook) return;
    try {
      onRejected(hook(build()), (error) => this.reportHookFailure(name, error));
    } catch (error) {
      this.reportHookFailure(name, error);
    }
  }

  /** Pass a hook's failure to the logger (which is itself guarded, see `log`). */
  private reportHookFailure(name: keyof GlassnodeHooks, error: unknown): void {
    this.log(`Hook ${name} failed:`, error);
  }

  /**
   * Call the configured `logger`, if any. Never awaited; a throw or a rejected promise from it is
   * swallowed silently — it cannot be reported to the logger that just failed, and hooks are for
   * the call's own events — so a logger can never change a call's outcome, retries or timing,
   * nor cause an unhandled rejection. Every logger call in the library goes through here.
   */
  private log(message: string, ...args: unknown[]): void {
    if (!this.logger) return;
    try {
      onRejected(this.logger(message, ...args), () => {});
    } catch {
      // Ignored: a debug-logging callback must never break a call.
    }
  }

  /** The fields every hook event of the call shares, for its current attempt. */
  private static eventBase(trace: CallTrace): GlassnodeHookEventBase {
    return {
      callId: trace.callId,
      method: 'GET',
      endpoint: trace.endpoint,
      url: trace.url,
      attempt: trace.attempt,
      maxAttempts: trace.maxAttempts,
    };
  }

  /**
   * Make an API request and turn its JSON body into the result with `finish` (e.g. schema
   * validation). A failure of either — after argument validation, which the public methods do
   * before calling this — is reported to the `onError` hook once, then rethrown unchanged.
   * @param endpoint API endpoint path
   * @param params Query parameters
   * @param options Validated per-call options (`signal`, `timeout` overriding the config one)
   * @param finish Maps the parsed JSON body to the result (identity when omitted)
   * @returns Promise resolving to the result
   */
  private async request<T>(
    endpoint: string,
    params: NormalizedParams = {},
    options: ResolvedCallOptions = {},
    finish: (body: unknown) => T = (body) => body as T
  ): Promise<T> {
    // The key goes in the query string (default) or the X-Api-Key header — never both, and
    // neither when there is no key (e.g. x402 mode).
    const keyInHeader = this.apiKeyLocation === 'header' && this.apiKey !== undefined;
    const queryParams = buildQuery(params);
    // Always last; `api_key` is never among `params` (normalizeParams rejects it).
    if (this.apiKey && !keyInHeader) queryParams.append('api_key', this.apiKey);
    const url = `${this.apiUrl}${endpoint}?${queryParams}`;
    const trace: CallTrace = {
      callId: nextCallId++,
      endpoint,
      url: this.redact(url),
      maxAttempts: this.maxRetries + 1,
      startedAt: performance.now(),
      attempt: 0,
    };
    try {
      return finish(await this.send(url, keyInHeader, options, trace));
    } catch (error) {
      if (error instanceof GlassnodeError) {
        const status = errorStatus(error);
        const durationMs = trace.lastDurationMs;
        this.emit('onError', () => ({
          ...GlassnodeAPI.eventBase(trace),
          error,
          ...(status !== undefined ? { status } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          elapsedMs: performance.now() - trace.startedAt,
        }));
      }
      throw error;
    }
  }

  /**
   * Send the request, with retries, and return its parsed JSON body.
   * @param url Full request URL (with the key when it goes in the query string)
   * @param keyInHeader Whether the key is sent as the X-Api-Key header
   * @param options Validated per-call options (`signal`, `timeout` overriding the config one)
   * @param trace The call's hook state; updated with each attempt
   */
  private async send(
    url: string,
    keyInHeader: boolean,
    options: ResolvedCallOptions,
    trace: CallTrace
  ): Promise<unknown> {
    const { endpoint } = trace;
    const { signal } = options;
    const timeout = options.timeout ?? this.timeout;
    // A caller abort is never retried; its reason stays on `.cause`.
    const aborted = () =>
      new GlassnodeAbortError('Glassnode API error: the request was aborted by the caller', {
        cause: signal?.reason,
      });
    const headers = keyInHeader ? { 'X-Api-Key': this.apiKey as string } : undefined;
    let lastError: GlassnodeError | undefined;
    // Server-requested wait (from a Retry-After header) to use for the *next* attempt, if any.
    let retryAfterMs: number | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = this.nextRetryDelay(attempt, retryAfterMs);
        this.log(`Retry ${attempt}/${this.maxRetries} after ${delay}ms`);
        const failed = lastError;
        this.emit('onRetry', () => ({
          ...GlassnodeAPI.eventBase(trace),
          ...retryCause(failed),
          error: failed as GlassnodeError,
          delayMs: delay,
          durationMs: trace.lastDurationMs ?? 0,
        }));
        // Cut short by a caller abort (checked right below).
        await sleep(delay, signal);
      }
      // Covers an already-aborted signal (before any request) and an abort during the wait.
      if (signal?.aborted) throw aborted();

      this.log('API call:', redactApiKey(url));
      trace.attempt = attempt + 1;
      this.emit('onRequest', () => GlassnodeAPI.eventBase(trace));

      // This attempt's signal: the caller's `signal` and/or a fresh `AbortSignal.timeout()` (a
      // new one per attempt), combined when both are set. `dispose` detaches the combiner's
      // listeners once the attempt is over (including reading the body).
      const attemptSignal =
        timeout === undefined
          ? { signal, dispose: () => {} }
          : signal
            ? combineSignals(signal, AbortSignal.timeout(timeout))
            : { signal: AbortSignal.timeout(timeout), dispose: () => {} };
      try {
        // Transport step — the only part that is retried on failure.
        let response: Response;
        const sentAt = performance.now();
        try {
          // Pass an `init` only when there is something to put in it (the key header and/or a
          // signal), so with the defaults a custom `fetch` still sees a single-argument call with
          // exactly the URL.
          // With the key in a header, redirects are not followed (`redirect: 'manual'`): fetch
          // would resend `X-Api-Key` to whatever origin a 3xx names (only `Authorization`-style
          // headers are dropped cross-origin), including an https→http downgrade. The 3xx then
          // surfaces as a non-retried GlassnodeApiError. In the query-string mode the redirect
          // target is whatever the server put in `Location`, so nothing is added there.
          const init: RequestInit = {
            ...(headers ? { headers, redirect: 'manual' as const } : {}),
            ...(attemptSignal.signal ? { signal: attemptSignal.signal } : {}),
          };
          response =
            Object.keys(init).length > 0 ? await this.fetchFn(url, init) : await this.fetchFn(url);
        } catch (error) {
          trace.lastDurationMs = performance.now() - sentAt;
          // Already classified by a library-aware fetch (e.g. a GlassnodePaymentError from
          // createX402Fetch, which also covers an abort after a payment was sent): surface it
          // unchanged and never retry it.
          if (error instanceof GlassnodeError) throw error;
          // Cancelled by the caller: never retried, whatever the fetch rejected with.
          if (signal?.aborted) throw aborted();
          // Network/transport failure (including a timeout abort) — retryable.
          retryAfterMs = undefined;
          const failure = describeTransportFailure(error);
          if (failure) {
            lastError = new GlassnodeNetworkError(
              `Glassnode API error: ${this.redact(failure.message)}`,
              { cause: error, timedOut: failure.timedOut }
            );
            if (attempt < this.maxRetries) continue;
            throw lastError;
          }
          // Not recognisably an error (e.g. a string) from a custom fetch — not retried, as before.
          throw new GlassnodeNetworkError('Unknown error occurred', {
            cause: error,
            timedOut: false,
          });
        }

        const durationMs = performance.now() - sentAt;
        trace.lastDurationMs = durationMs;
        this.emit('onResponse', () => ({
          ...GlassnodeAPI.eventBase(trace),
          status: response.status,
          ok: response.ok,
          durationMs,
        }));

        if (!response.ok) {
          // The status text comes from the server (or a proxy) too, so it is redacted as well.
          const statusText = this.redact(response.statusText);
          const error = new GlassnodeApiError(response.status, statusText);
          if (error.isRetryable && attempt < this.maxRetries) {
            lastError = error;
            // Honour the server's Retry-After (e.g. on 429) for the next wait, if present.
            retryAfterMs = this.parseRetryAfter(response);
            continue;
          }
          // Surface the server's error body (e.g. "Resolution 1h is not allowed") in the message,
          // with the API key masked: a server or proxy may echo the request URL or the key.
          const detail = await readErrorDetail(response, [this.apiKey]);
          throw detail ? new GlassnodeApiError(response.status, statusText, detail) : error;
        }

        // Success. Parsing a 200 body is NOT a transient error, so it is thrown, never retried.
        try {
          return (await response.json()) as unknown;
        } catch (parseError) {
          // Reading the body was cut off by the caller's abort: that is not a malformed body.
          if (signal?.aborted) throw aborted();
          throw new GlassnodeValidationError(
            'Glassnode API error: failed to parse response body as JSON',
            { cause: parseError, endpoint }
          );
        }
      } finally {
        attemptSignal.dispose();
      }
    }

    // Unreachable in practice (the loop always returns or throws), but keep the throw definitive.
    throw lastError ?? new GlassnodeError('Glassnode API request failed');
  }

  /**
   * Delay (ms) before the given retry attempt: a server-supplied Retry-After if present,
   * otherwise exponential backoff (`retryDelay * 2^(attempt-1)`) capped at `maxRetryDelay` and
   * then full-jittered to avoid synchronised retries across clients.
   */
  private nextRetryDelay(attempt: number, retryAfterMs: number | undefined): number {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, this.maxRetryDelay);
    const base = Math.min(this.retryDelay * 2 ** (attempt - 1), this.maxRetryDelay);
    return Math.round(Math.random() * base);
  }

  /**
   * Parse a `Retry-After` header into milliseconds. Supports both the delay-seconds form and an
   * HTTP-date. Returns undefined when the header is absent or unparseable.
   */
  private parseRetryAfter(response: Response): number | undefined {
    const raw = response.headers?.get?.('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(raw);
    return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
  }

  /**
   * Get metadata for all assets
   * @param options Per-call options: `signal` to cancel, `timeout` to override the config one
   *   (see {@link CallOptions})
   * @returns Promise resolving to validated asset metadata
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `options` is invalid
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async getAssetMetadata(options?: CallOptions): Promise<AssetMetadataResponse> {
    const callOptions = normalizeCallOptions(options);
    const endpoint = '/v1/metadata/assets';
    return this.request(endpoint, {}, callOptions, (body) =>
      validateResponse(
        AssetMetadataResponseSchema,
        (body as { data?: unknown } | null)?.data,
        endpoint,
        (t) => this.redact(t)
      )
    );
  }

  /**
   * Get metadata for a specific metric
   * @param metricPath Path of the metric
   * @param params Query parameters for the metric (see {@link MetricParams}); numbers, booleans
   *   and Dates are converted (a Date → unix seconds), `undefined` values are omitted
   * @param options Per-call options: `signal` to cancel, `timeout` to override the config one
   *   (see {@link CallOptions})
   * @returns Promise resolving to validated metric metadata
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `metricPath` is
   *   malformed, `params.f` is anything but `json`, `params` contains `path` or `api_key`, a
   *   param value cannot be converted (see `MetricParamValue`), or `options` is invalid
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async getMetricMetadata(
    metricPath: string,
    params: MetricParams = {},
    options?: CallOptions
  ): Promise<MetricMetadataResponse> {
    assertMetricPath(metricPath);
    const query = normalizeParams(params, { format: true, reserved: ['path'] });
    const callOptions = normalizeCallOptions(options);
    const endpoint = '/v1/metadata/metric';
    return this.request(endpoint, { path: metricPath, ...query }, callOptions, (body) =>
      validateResponse(MetricMetadataResponseSchema, body, endpoint, (t) => this.redact(t))
    );
  }

  /**
   * Get data-lag statistics for a specific metric.
   * Returns the current data lag as aggregated percentiles over the past 30 days.
   * @param metricPath Path of the metric (e.g. /institutions/us_spot_etf_balances_all)
   * @param params Optional query parameters (e.g. `a` to scope stats to an asset; see
   *   {@link MetricParams} for value conversion)
   * @param options Per-call options: `signal` to cancel, `timeout` to override the config one
   *   (see {@link CallOptions})
   * @returns Promise resolving to validated metric stats
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `metricPath` is
   *   malformed, `params.f` is anything but `json`, `params` contains `path` or `api_key`, a
   *   param value cannot be converted (see `MetricParamValue`), or `options` is invalid
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async getMetricStats(
    metricPath: string,
    params: MetricParams = {},
    options?: CallOptions
  ): Promise<MetricStatsResponse> {
    assertMetricPath(metricPath);
    const query = normalizeParams(params, { format: true, reserved: ['path'] });
    const callOptions = normalizeCallOptions(options);
    const endpoint = '/v1/metadata/metric/stats';
    return this.request(endpoint, { path: metricPath, ...query }, callOptions, (body) =>
      validateResponse(MetricStatsResponseSchema, body, endpoint, (t) => this.redact(t))
    );
  }

  /**
   * Get a list of all metrics
   * @param options Per-call options: `signal` to cancel, `timeout` to override the config one
   *   (see {@link CallOptions})
   * @returns Promise resolving to validated metric metadata
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `options` is invalid
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async getMetricList(options?: CallOptions): Promise<MetricListResponse> {
    const callOptions = normalizeCallOptions(options);
    const endpoint = '/v1/metadata/metrics';
    return this.request(endpoint, {}, callOptions, (body) =>
      validateResponse(MetricListResponseSchema, body, endpoint, (t) => this.redact(t))
    );
  }

  /**
   * Call a generic metric, validating the response against a Zod schema.
   *
   * @example
   * const series = await api.callMetric('/market/price_usd_close', { a: 'BTC' }, {
   *   schema: TimeSeriesResponseSchema,
   * }); // TimeSeriesResponse — { t: number; v: number | null }[]
   *
   * @param metricPath Path of the metric (e.g. /market/price_usd_close)
   * @param params Query parameters for the metric (see {@link MetricParams}); pass `undefined` or
   *   `{}` for none
   * @param options Per-call options plus `schema`: the Zod schema the response body must match
   *   (see {@link CallMetricOptions}), e.g. `TimeSeriesResponseSchema` for `{ t, v }` metrics or
   *   `TimeSeriesObjectResponseSchema` for `{ t, o }` metrics
   * @returns Promise resolving to the validated response, typed as the schema's output
   * @throws GlassnodeValidationError (with `endpoint`) if the response does not match `schema`
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `metricPath` is
   *   malformed, `params.f` is anything but `json`, `params` contains `api_key`, a param value
   *   cannot be converted (see `MetricParamValue`), `options` is invalid, or `options.schema` is
   *   not a Zod schema
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async callMetric<S extends ZodType>(
    metricPath: string,
    params: MetricParams | undefined,
    options: CallMetricOptions<S>
  ): Promise<z.output<S>>;
  /**
   * Call a generic metric. The response body is returned **unvalidated** and cast to `T` — pass
   * `{ schema }` in `options` (see the other overload) for a validated, typed result.
   * @param metricPath Path of the metric (e.g. /accumulation_balance)
   * @param params Query parameters for the metric, e.g. `{ a: 'BTC', s: 1609459200, i: '24h' }`
   *   or `{ a: 'BTC', s: new Date('2021-01-01') }` (see {@link MetricParams})
   * @param options Per-call options: `signal` to cancel, `timeout` to override the config one
   *   (see {@link CallOptions})
   * @returns Promise resolving to the response data (not validated)
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `metricPath` is
   *   malformed, `params.f` is anything but `json`, `params` contains `api_key`, a param value
   *   cannot be converted (see `MetricParamValue`), or `options` is invalid
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async callMetric<T>(metricPath: string, params?: MetricParams, options?: CallOptions): Promise<T>;
  async callMetric(
    metricPath: string,
    params: MetricParams = {},
    options?: CallOptions | CallMetricOptions
  ): Promise<unknown> {
    assertMetricPath(metricPath);
    const query = normalizeParams(params, { format: true });
    const callOptions = normalizeCallOptions(options);
    const schema = metricSchema(options);
    const endpoint = '/v1/metrics' + metricPath;
    return this.request(endpoint, { ...query, f: 'json' }, callOptions, (body) =>
      schema === undefined ? body : validateResponse(schema, body, endpoint, (t) => this.redact(t))
    );
  }

  /**
   * Call a bulk metric endpoint (returns data for all assets at once). `/bulk` is appended to
   * `metricPath`, so pass the base path (e.g. `/market/marketcap_usd`), not the bulk variant path
   * from the metadata's `refs.metric_variant.bulk` (e.g. `/market/marketcap_usd/bulk`).
   * @param metricPath Base path of the metric (e.g. /market/marketcap_usd), without `/bulk`
   * @param params Query parameters (see {@link MetricParams})
   * @param options Per-call options: `signal` to cancel, `timeout` to override the config one
   *   (see {@link CallOptions})
   * @returns Promise resolving to validated bulk response
   * @throws GlassnodeInputError (as a rejected promise, before any request) if `metricPath` is
   *   malformed or ends in `/bulk`, `params.f` is anything but `json`, `params` contains
   *   `api_key`, a param value cannot be converted (see `MetricParamValue`), or `options` is
   *   invalid
   * @throws GlassnodeAbortError if `options.signal` aborts (or was already aborted)
   */
  async callBulkMetric(
    metricPath: string,
    params: MetricParams = {},
    options?: CallOptions
  ): Promise<BulkResponse> {
    assertBulkMetricPath(metricPath);
    const query = normalizeParams(params, { format: true });
    const callOptions = normalizeCallOptions(options);
    const endpoint = '/v1/metrics' + metricPath + '/bulk';
    return this.request(endpoint, { ...query, f: 'json' }, callOptions, (body) =>
      validateResponse(
        BulkResponseSchema,
        (body as { data?: unknown } | null)?.data,
        endpoint,
        (t) => this.redact(t)
      )
    );
  }
}
