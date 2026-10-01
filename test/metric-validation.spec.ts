import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import { z } from 'zod';
import {
  GlassnodeAPI,
  GlassnodeInputError,
  GlassnodeValidationError,
  TimeSeriesPointSchema,
  TimeSeriesResponseSchema,
  TimeSeriesObjectPointSchema,
  TimeSeriesObjectResponseSchema,
  type TimeSeriesPoint,
  type TimeSeriesResponse,
  type TimeSeriesObjectPoint,
  type TimeSeriesObjectResponse,
  type CallMetricOptions,
} from '../src';
import { API_KEY } from './constants';

const ENDPOINT = '/v1/metrics/market/price_usd_close';

function apiReturning(body: unknown) {
  const fetchFn = vi
    .fn()
    .mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue(JSON.stringify(body)) });
  return { api: new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn }), fetchFn };
}

describe('time-series schemas', () => {
  it('accept a numeric or null `v` and reject a missing/non-numeric one', () => {
    expect(TimeSeriesPointSchema.parse({ t: 1, v: 2.5 })).toEqual({ t: 1, v: 2.5 });
    expect(TimeSeriesPointSchema.parse({ t: 1, v: null })).toEqual({ t: 1, v: null });
    expect(TimeSeriesPointSchema.safeParse({ t: 1 }).success).toBe(false);
    expect(TimeSeriesPointSchema.safeParse({ t: 1, v: '2' }).success).toBe(false);
    expect(TimeSeriesPointSchema.safeParse({ t: '1', v: 2 }).success).toBe(false);
  });

  it('accept an object `o` of numbers or nulls, with any keys', () => {
    const point = { t: 1, o: { o: 1, h: 2, l: 0.5, c: null } };
    expect(TimeSeriesObjectPointSchema.parse(point)).toEqual(point);
    expect(TimeSeriesObjectPointSchema.parse({ t: 1, o: { binance: 3 } })).toEqual({
      t: 1,
      o: { binance: 3 },
    });
    expect(TimeSeriesObjectPointSchema.safeParse({ t: 1, o: { c: 'x' } }).success).toBe(false);
    expect(TimeSeriesObjectPointSchema.safeParse({ t: 1, v: 2 }).success).toBe(false);
  });

  it('tolerate extra fields on a point (additive server changes)', () => {
    expect(TimeSeriesPointSchema.safeParse({ t: 1, v: 2, extra: 'x' }).success).toBe(true);
    expect(TimeSeriesObjectPointSchema.safeParse({ t: 1, o: {}, extra: 'x' }).success).toBe(true);
  });

  it('response schemas are arrays of points', () => {
    expect(TimeSeriesResponseSchema.parse([])).toEqual([]);
    expect(TimeSeriesObjectResponseSchema.parse([{ t: 1, o: { c: 2 } }])).toEqual([
      { t: 1, o: { c: 2 } },
    ]);
    expect(TimeSeriesResponseSchema.safeParse({ t: 1, v: 2 }).success).toBe(false);
  });

  it('infer the documented types', () => {
    expectTypeOf<TimeSeriesPoint>().toEqualTypeOf<{ t: number; v: number | null }>();
    expectTypeOf<TimeSeriesResponse>().toEqualTypeOf<TimeSeriesPoint[]>();
    expectTypeOf<TimeSeriesObjectPoint>().toEqualTypeOf<{
      t: number;
      o: Record<string, number | null>;
    }>();
    expectTypeOf<TimeSeriesObjectResponse>().toEqualTypeOf<TimeSeriesObjectPoint[]>();
  });
});

describe('callMetric with a schema', () => {
  it('returns the validated `v` series, typed from the schema', async () => {
    const { api } = apiReturning([
      { t: 1609459200, v: 29000.5 },
      { t: 1609545600, v: null },
    ]);
    const result = await api.callMetric(
      '/market/price_usd_close',
      { a: 'BTC' },
      { schema: TimeSeriesResponseSchema }
    );
    expectTypeOf(result).toEqualTypeOf<TimeSeriesResponse>();
    expect(result).toEqual([
      { t: 1609459200, v: 29000.5 },
      { t: 1609545600, v: null },
    ]);
  });

  it('returns the validated `o` series (OHLC)', async () => {
    const body = [{ t: 1609459200, o: { o: 28923.6, h: 29600.6, l: 28624.6, c: 29331.7 } }];
    const { api } = apiReturning(body);
    const result = await api.callMetric(
      '/market/price_usd_ohlc',
      { a: 'BTC' },
      { schema: TimeSeriesObjectResponseSchema }
    );
    expectTypeOf(result).toEqualTypeOf<TimeSeriesObjectResponse>();
    expect(result).toEqual(body);
  });

  it('tolerates extra fields in the response', async () => {
    const { api } = apiReturning([{ t: 1, v: 2, unexpected: true }]);
    await expect(
      api.callMetric('/market/price_usd_close', {}, { schema: TimeSeriesResponseSchema })
    ).resolves.toEqual([{ t: 1, v: 2 }]);
  });

  it('rejects a mismatching response with a GlassnodeValidationError carrying the endpoint', async () => {
    const { api } = apiReturning([{ t: 1, v: 'oops' }]);
    const err = await api
      .callMetric('/market/price_usd_close', { a: 'BTC' }, { schema: TimeSeriesResponseSchema })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlassnodeValidationError);
    const v = err as GlassnodeValidationError;
    expect(v.endpoint).toBe(ENDPOINT);
    expect(v.message).toContain(ENDPOINT);
    expect(v.message).toContain('0.v');
    expect(v.cause).toBeInstanceOf(z.ZodError);
  });

  it('rejects an `o` response validated as a `v` series', async () => {
    const { api } = apiReturning([{ t: 1, o: { c: 2 } }]);
    await expect(
      api.callMetric('/market/price_usd_ohlc', {}, { schema: TimeSeriesResponseSchema })
    ).rejects.toBeInstanceOf(GlassnodeValidationError);
  });

  it('accepts a caller-defined schema and infers its output type (transforms included)', async () => {
    const { api } = apiReturning([{ t: 1609459200, v: [1, 2] }]);
    const schema = z.array(
      z.object({ t: z.number().transform((s) => new Date(s * 1000)), v: z.array(z.number()) })
    );
    const result = await api.callMetric('/distribution/some_array_metric', undefined, { schema });
    expectTypeOf(result).toEqualTypeOf<{ t: Date; v: number[] }[]>();
    expect(result).toEqual([{ t: new Date(1609459200 * 1000), v: [1, 2] }]);
  });

  it('keeps signal/timeout working alongside `schema`', async () => {
    const { api, fetchFn } = apiReturning([{ t: 1, v: 2 }]);
    const controller = new AbortController();
    const options: CallMetricOptions<typeof TimeSeriesResponseSchema> = {
      schema: TimeSeriesResponseSchema,
      signal: controller.signal,
      timeout: 5000,
    };
    await expect(api.callMetric('/market/price_usd_close', {}, options)).resolves.toEqual([
      { t: 1, v: 2 },
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects a `schema` that is not a Zod schema before any request', async () => {
    const { api, fetchFn } = apiReturning([]);
    const bogus = { parse: () => [] } as unknown as z.ZodType;
    const err = await api
      .callMetric('/market/price_usd_close', {}, { schema: bogus })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GlassnodeInputError);
    expect((err as GlassnodeInputError).argument).toBe('options.schema');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('treats `schema: undefined` as no schema', async () => {
    const { api } = apiReturning({ anything: 'goes' });
    // Runtime-only case (e.g. a JS caller or a spread of optional config).
    const opts = { schema: undefined } as unknown as { timeout?: number };
    await expect(api.callMetric('/market/price_usd_close', {}, opts)).resolves.toEqual({
      anything: 'goes',
    });
  });
});

describe('callMetric without a schema (unchanged)', () => {
  it('returns the body as-is, unvalidated', async () => {
    const body = { not: 'a series' };
    const { api } = apiReturning(body);
    const result = await api.callMetric('/market/price_usd_close', { a: 'BTC' });
    expect(result).toEqual(body);
  });

  it('keeps the `callMetric<T>` cast typing', async () => {
    const { api } = apiReturning([{ t: 1, v: 2 }]);
    const typed = await api.callMetric<{ t: number; v: number }[]>('/market/price_usd_close');
    expectTypeOf(typed).toEqualTypeOf<{ t: number; v: number }[]>();
    const withOptions = await api.callMetric<string>(
      '/market/price_usd_close',
      {},
      {
        timeout: 1000,
      }
    );
    expectTypeOf(withOptions).toEqualTypeOf<string>();
    const untyped = await api.callMetric('/market/price_usd_close');
    expectTypeOf(untyped).toEqualTypeOf<unknown>();
  });

  it('does not accept `schema` on methods other than callMetric (type level)', () => {
    const { api } = apiReturning([]);
    // @ts-expect-error — `schema` is a callMetric-only option
    void api.getMetricList({ schema: TimeSeriesResponseSchema }).catch(() => undefined);
  });
});
