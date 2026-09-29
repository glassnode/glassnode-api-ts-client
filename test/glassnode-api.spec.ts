import { describe, it, expect, expectTypeOf, vi, type Mock } from 'vitest';
import { GlassnodeAPI } from '../src/glassnode-api';
import { GlassnodeApiError, GlassnodeValidationError } from '../src/errors';
import { MetricMetadataSchema, type MetricMetadata } from '../src/types/metadata';
import {
  API_KEY,
  DEFAULT_API_URL,
  CUSTOM_API_URL,
  ASSETS_METADATA_ENDPOINT,
  METRICS_METADATA_ENDPOINT,
  METRICS_ENDPOINT,
  BAD_REQUEST_STATUS_TEXT,
  BAD_REQUEST_ERROR,
  STATUS_BAD_REQUEST,
  METRIC_METADATA_ENDPOINT,
  METRIC_STATS_ENDPOINT,
} from './constants';
import {
  mockAssetMetadataResponse,
  mockMetricMetadataResponse,
  mockRawMetricMetadataResponse,
  mockMetricListResponse,
  mockMetricStatsResponse,
} from './mocks/metadata.mock';

function createMockFetch(response: Partial<Response>) {
  return vi.fn().mockResolvedValue(response);
}

function createApi(fetchFn: Mock) {
  return new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn });
}

describe('GlassnodeAPI', () => {
  describe('constructor', () => {
    it('should create an instance with default API URL', () => {
      const api = new GlassnodeAPI({ apiKey: API_KEY });

      // @ts-expect-error: Testing private property
      expect(api.apiKey).toBe(API_KEY);
      // @ts-expect-error: Testing private property
      expect(api.apiUrl).toBe(DEFAULT_API_URL);
    });

    it('should create an instance with custom API URL', () => {
      const api = new GlassnodeAPI({ apiKey: API_KEY, apiUrl: CUSTOM_API_URL });

      // @ts-expect-error: Testing private property
      expect(api.apiKey).toBe(API_KEY);
      // @ts-expect-error: Testing private property
      expect(api.apiUrl).toBe(CUSTOM_API_URL);
    });

    it('should accept an optional logger', async () => {
      const logger = vi.fn();
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

      const api = new GlassnodeAPI({ apiKey: API_KEY, logger, fetch: fetchFn });
      await api.getMetricList();

      expect(logger).toHaveBeenCalledWith('API call:', expect.stringContaining(DEFAULT_API_URL));
    });

    it('redacts the api_key in logged URLs', async () => {
      const logger = vi.fn();
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

      const api = new GlassnodeAPI({ apiKey: API_KEY, logger, fetch: fetchFn });
      await api.getMetricList();

      const logged = logger.mock.calls.find((c) => c[0] === 'API call:')?.[1] as string;
      expect(logged).toContain('api_key=***');
      expect(logged).not.toContain(API_KEY);
    });

    it('should use custom fetch when provided', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

      const api = createApi(fetchFn);
      await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining(`${DEFAULT_API_URL}/v1/metadata/metrics`)
      );
    });
  });

  describe('timeout', () => {
    it('does not pass a second fetch argument when no timeout is set', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

      const api = createApi(fetchFn);
      await api.getMetricList();

      // Single-argument call preserved for the default (no-timeout) path.
      expect(fetchFn).toHaveBeenCalledWith(expect.any(String));
      expect(fetchFn.mock.calls[0]).toHaveLength(1);
    });

    it('passes an AbortSignal to fetch when timeout is set', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

      const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, timeout: 5000 });
      await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('/v1/metadata/metrics'),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('surfaces a timeout/abort rejection', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
        );

      const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, timeout: 10 });

      await expect(api.getMetricList()).rejects.toThrow(
        'Glassnode API error: The operation was aborted'
      );
    });
  });

  describe('apiKeyLocation', () => {
    const okFetch = () =>
      createMockFetch({ ok: true, json: vi.fn().mockResolvedValue(mockMetricListResponse) });

    it('defaults to the api_key query parameter, with no fetch init (unchanged)', async () => {
      const fetchFn = okFetch();
      await createApi(fetchFn).getMetricList();

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRICS_METADATA_ENDPOINT}?api_key=${API_KEY}`
      );
      expect(fetchFn.mock.calls[0]).toHaveLength(1);
    });

    it("'query' is the same as the default", async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, apiKeyLocation: 'query' });
      await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRICS_METADATA_ENDPOINT}?api_key=${API_KEY}`
      );
      expect(fetchFn.mock.calls[0]).toHaveLength(1);
    });

    it("'header' sends X-Api-Key and keeps the key out of the URL", async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, apiKeyLocation: 'header' });
      await api.getMetricList();

      const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${DEFAULT_API_URL}${METRICS_METADATA_ENDPOINT}?`);
      expect(url).not.toContain(API_KEY);
      expect(init).toEqual({ headers: { 'X-Api-Key': API_KEY }, redirect: 'manual' });
    });

    it("'header' keeps other query params in the URL", async () => {
      const fetchFn = createMockFetch({ ok: true, json: vi.fn().mockResolvedValue([]) });
      const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, apiKeyLocation: 'header' });
      await api.callMetric('/market/price_usd_close', { a: 'BTC' });

      expect(fetchFn.mock.calls[0][0]).toBe(
        `${DEFAULT_API_URL}${METRICS_ENDPOINT}/market/price_usd_close?a=BTC&f=json`
      );
    });

    it("'header' merges the header with the timeout signal", async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        apiKeyLocation: 'header',
        timeout: 5000,
      });
      await api.getMetricList();

      const init = fetchFn.mock.calls[0][1] as RequestInit;
      expect(init.headers).toEqual({ 'X-Api-Key': API_KEY });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("'header' sends a fresh init on every retry attempt", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue(mockMetricListResponse) });
      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        apiKeyLocation: 'header',
        maxRetries: 1,
        retryDelay: 1,
      });
      await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledTimes(2);
      for (const [, init] of fetchFn.mock.calls as [string, RequestInit][]) {
        expect(init.headers).toEqual({ 'X-Api-Key': API_KEY });
      }
    });

    it("'header' with no key (x402) sends no header and no init", async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({ x402: true, fetch: fetchFn, apiKeyLocation: 'header' });
      await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledWith(
        `https://x402.glassnode.com${METRICS_METADATA_ENDPOINT}?`
      );
      expect(fetchFn.mock.calls[0]).toHaveLength(1);
    });

    it("'header' with no key and a timeout passes only the signal", async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({
        x402: true,
        fetch: fetchFn,
        apiKeyLocation: 'header',
        timeout: 5000,
      });
      await api.getMetricList();

      const init = fetchFn.mock.calls[0][1] as RequestInit;
      expect(init).not.toHaveProperty('headers');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("'header' keeps the key out of logs", async () => {
      const logger = vi.fn();
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        logger,
        apiKeyLocation: 'header',
      });
      await api.getMetricList();

      expect(logger).toHaveBeenCalledWith(
        'API call:',
        `${DEFAULT_API_URL}${METRICS_METADATA_ENDPOINT}?`
      );
      expect(JSON.stringify(logger.mock.calls)).not.toContain(API_KEY);
    });

    it('redacts a raw key echoed by a transport error message, in either mode', async () => {
      for (const apiKeyLocation of ['query', 'header'] as const) {
        const fetchFn = vi
          .fn()
          .mockRejectedValue(new Error(`connect failed (X-Api-Key: ${API_KEY})`));
        const api = new GlassnodeAPI({ apiKey: API_KEY, fetch: fetchFn, apiKeyLocation });

        const err = await api.getMetricList().catch((e: unknown) => e);
        expect((err as Error).message).toBe('Glassnode API error: connect failed (X-Api-Key: ***)');
      }
    });

    it('rejects an unknown apiKeyLocation', () => {
      expect(
        () =>
          new GlassnodeAPI({
            apiKey: API_KEY,
            // @ts-expect-error: invalid value on purpose
            apiKeyLocation: 'cookie',
          })
      ).toThrow(/apiKeyLocation/);
    });
  });

  describe('getAssetMetadata', () => {
    it('should fetch asset metadata', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: mockAssetMetadataResponse }),
      });

      const api = createApi(fetchFn);
      const result = await api.getAssetMetadata();

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${ASSETS_METADATA_ENDPOINT}?api_key=${API_KEY}`
      );
      expect(result).toEqual(mockAssetMetadataResponse);
      expect(result[0].id).toBe('bitcoin');
      expect(result[0].symbol).toBe('BTC');
    });

    it('accepts external_ids from sources the client does not know yet', async () => {
      const response = {
        data: [
          {
            ...mockAssetMetadataResponse[0],
            external_ids: { coingecko: 'bitcoin', defillama: 'bitcoin-dl' },
          },
        ],
      };
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(response),
      });

      const api = createApi(fetchFn);
      const result = await api.getAssetMetadata();

      expect(result[0].external_ids.coingecko).toBe('bitcoin');
      // unknown sources are preserved, not stripped
      expect(result[0].external_ids['defillama']).toBe('bitcoin-dl');
    });

    it('leaves the optional descriptive fields undefined when the API omits them', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: mockAssetMetadataResponse }),
      });

      const [asset] = await createApi(fetchFn).getAssetMetadata();

      expect(asset).not.toHaveProperty('categories');
      expect(asset.categories).toBeUndefined();
      expect(asset.logo_url).toBeUndefined();
      expect(asset.semantic_tags).toBeUndefined();
      expect(asset.default_network).toBeUndefined();
    });

    it('keeps the descriptive fields, including empty values, when present', async () => {
      const response = {
        data: [
          {
            ...mockAssetMetadataResponse[0],
            categories: ['on-chain', 'spot'],
            logo_url: 'https://cdn.example.com/btc.webp',
            semantic_tags: [],
            default_network: '',
          },
        ],
      };
      const fetchFn = createMockFetch({ ok: true, json: vi.fn().mockResolvedValue(response) });

      const [asset] = await createApi(fetchFn).getAssetMetadata();

      expect(asset.categories).toEqual(['on-chain', 'spot']);
      expect(asset.logo_url).toBe('https://cdn.example.com/btc.webp');
      expect(asset.semantic_tags).toEqual([]);
      expect(asset.default_network).toBe('');
    });

    it('rejects a descriptive field of the wrong type', async () => {
      const response = { data: [{ ...mockAssetMetadataResponse[0], categories: 'spot' }] };
      const fetchFn = createMockFetch({ ok: true, json: vi.fn().mockResolvedValue(response) });

      await expect(createApi(fetchFn).getAssetMetadata()).rejects.toThrow();
    });

    it('still rejects a non-string external id', async () => {
      const response = {
        data: [
          {
            ...mockAssetMetadataResponse[0],
            external_ids: { coingecko: 'bitcoin', defillama: 42 },
          },
        ],
      };
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(response),
      });

      const api = createApi(fetchFn);

      await expect(api.getAssetMetadata()).rejects.toThrow();
    });

    it('should handle API errors', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: STATUS_BAD_REQUEST,
        statusText: BAD_REQUEST_STATUS_TEXT,
      });

      const api = createApi(fetchFn);

      await expect(api.getAssetMetadata()).rejects.toThrow(BAD_REQUEST_ERROR);
    });
  });

  describe('getMetricMetadata', () => {
    it('should fetch metric metadata', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockRawMetricMetadataResponse),
      });

      const api = createApi(fetchFn);
      const result = await api.getMetricMetadata('/distribution/balance_exchanges');

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRIC_METADATA_ENDPOINT}?path=%2Fdistribution%2Fbalance_exchanges&api_key=${API_KEY}`
      );
      expect(result).toEqual(mockMetricMetadataResponse);
      expect(result.path).toBe('/distribution/balance_exchanges');
      expect(result.tier).toBe(2);
      expect(result.modified).toBe(mockRawMetricMetadataResponse.modified);
    });

    it('leaves parameters_defaults undefined when the API omits it', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockRawMetricMetadataResponse),
      });

      const result = await createApi(fetchFn).getMetricMetadata('/distribution/balance_exchanges');

      expect(result).not.toHaveProperty('parameters_defaults');
      expect(result.parameters_defaults).toBeUndefined();
    });

    it('keeps parameters_defaults, including an empty record, when present', async () => {
      for (const parametersDefaults of [{ e: ['aggregated'] }, {}]) {
        const fetchFn = createMockFetch({
          ok: true,
          json: vi.fn().mockResolvedValue({
            ...mockRawMetricMetadataResponse,
            parameters_defaults: parametersDefaults,
          }),
        });

        const result = await createApi(fetchFn).getMetricMetadata(
          '/distribution/balance_exchanges'
        );

        expect(result.parameters_defaults).toEqual(parametersDefaults);
      }
    });

    it('requires only path and tier: refs, queried and parameters are optional', () => {
      const result = MetricMetadataSchema.safeParse({ path: '/x', tier: 1 });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ path: '/x', tier: 1 });
      // The fields' types admit `undefined` (read them with `?.`).
      expectTypeOf<undefined>().toExtend<MetricMetadata['refs']>();
      expectTypeOf<undefined>().toExtend<MetricMetadata['queried']>();
      expectTypeOf<MetricMetadata['parameters']>().toEqualTypeOf<
        Record<string, string[]> | undefined
      >();

      const missing = MetricMetadataSchema.safeParse({});
      expect(missing.success).toBe(false);
      expect(missing.error!.issues.map((i) => i.path.join('.')).sort()).toEqual(['path', 'tier']);
    });

    it('leaves refs, queried and parameters undefined (not {}) when the API omits them', async () => {
      const raw: Record<string, unknown> = { ...mockRawMetricMetadataResponse };
      delete raw.refs;
      delete raw.queried;
      delete raw.parameters;
      const fetchFn = createMockFetch({ ok: true, json: vi.fn().mockResolvedValue(raw) });

      const result = await createApi(fetchFn).getMetricMetadata('/distribution/balance_exchanges');

      expect(result.path).toBe('/distribution/balance_exchanges');
      expect(result).not.toHaveProperty('refs');
      expect(result).not.toHaveProperty('queried');
      expect(result).not.toHaveProperty('parameters');
    });

    it('rejects parameters_defaults whose values are not string arrays', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({
          ...mockRawMetricMetadataResponse,
          parameters_defaults: { e: 'aggregated' },
        }),
      });

      await expect(
        createApi(fetchFn).getMetricMetadata('/distribution/balance_exchanges')
      ).rejects.toThrow();
    });

    it('should handle optional params', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockRawMetricMetadataResponse),
      });

      const api = createApi(fetchFn);
      const result = await api.getMetricMetadata('/distribution/balance_exchanges', { a: 'BTC' });

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRIC_METADATA_ENDPOINT}?path=%2Fdistribution%2Fbalance_exchanges&a=BTC&api_key=${API_KEY}`
      );
      expect(result).toEqual(mockMetricMetadataResponse);
    });

    it('should handle API errors', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: STATUS_BAD_REQUEST,
        statusText: BAD_REQUEST_STATUS_TEXT,
      });

      const api = createApi(fetchFn);

      await expect(api.getMetricMetadata('/distribution/balance_exchanges')).rejects.toThrow(
        BAD_REQUEST_ERROR
      );
    });
  });

  describe('getMetricStats', () => {
    it('should fetch metric stats', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricStatsResponse),
      });

      const api = createApi(fetchFn);
      const result = await api.getMetricStats('/institutions/us_spot_etf_balances_all');

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRIC_STATS_ENDPOINT}?path=%2Finstitutions%2Fus_spot_etf_balances_all&api_key=${API_KEY}`
      );
      expect(result).toEqual(mockMetricStatsResponse);
      expect(result.lag[0].resolution['10m'].p50).toBe(620);
    });

    it('should handle optional params', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricStatsResponse),
      });

      const api = createApi(fetchFn);
      const result = await api.getMetricStats('/institutions/us_spot_etf_balances_all', {
        a: 'BTC',
      });

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRIC_STATS_ENDPOINT}?path=%2Finstitutions%2Fus_spot_etf_balances_all&a=BTC&api_key=${API_KEY}`
      );
      expect(result).toEqual(mockMetricStatsResponse);
    });

    it('accepts a resolution with a missing percentile', async () => {
      const response = {
        lag: [
          {
            unit: 'seconds',
            window: '30d',
            resolution: { '1h': { p50: 3700, p90: 4200, p99: 6000 } },
          },
        ],
      };
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(response),
      });

      const api = createApi(fetchFn);
      const result = await api.getMetricStats('/institutions/us_spot_etf_balances_all');

      expect(result.lag[0].resolution['1h'].p50).toBe(3700);
      expect(result.lag[0].resolution['1h'].p95).toBeUndefined();
    });

    it('should reject a malformed response', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ lag: [{ unit: 'seconds', window: '30d' }] }),
      });

      const api = createApi(fetchFn);

      await expect(api.getMetricStats('/institutions/us_spot_etf_balances_all')).rejects.toThrow();
    });

    it('should handle API errors', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: STATUS_BAD_REQUEST,
        statusText: BAD_REQUEST_STATUS_TEXT,
      });

      const api = createApi(fetchFn);

      await expect(api.getMetricStats('/institutions/us_spot_etf_balances_all')).rejects.toThrow(
        BAD_REQUEST_ERROR
      );
    });
  });

  describe('getMetricList', () => {
    it('should fetch metric list', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

      const api = createApi(fetchFn);
      const result = await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRICS_METADATA_ENDPOINT}?api_key=${API_KEY}`
      );
      expect(result).toEqual(mockMetricListResponse);
      expect(result[0]).toBe('/distribution/balance_exchanges');
      expect(result.length).toBe(4);
    });

    it('should handle API errors', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: STATUS_BAD_REQUEST,
        statusText: BAD_REQUEST_STATUS_TEXT,
      });

      const api = createApi(fetchFn);

      await expect(api.getMetricList()).rejects.toThrow(BAD_REQUEST_ERROR);
    });
  });

  describe('callMetric', () => {
    it('should call a metric endpoint and return data', async () => {
      const mockData = [{ t: 1609459200, v: 29000 }];
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue(mockData),
      });

      const api = createApi(fetchFn);
      const result = await api.callMetric<{ t: number; v: number }[]>('/market/price_usd_close', {
        a: 'BTC',
      });

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}${METRICS_ENDPOINT}/market/price_usd_close?a=BTC&f=json&api_key=${API_KEY}`
      );
      expect(result).toEqual(mockData);
      expect(result[0].v).toBe(29000);
    });

    it('should handle API errors', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const api = createApi(fetchFn);

      await expect(api.callMetric('/market/price_usd_close', { a: 'BTC' })).rejects.toThrow(
        'API request failed (500)'
      );
    });
  });

  describe('callBulkMetric', () => {
    it('should call a bulk metric endpoint and return validated data', async () => {
      const mockData = [
        {
          t: 1609459200,
          bulk: [
            { a: 'BTC', v: 600000000000 },
            { a: 'ETH', v: 100000000000, network: 'ethereum' },
          ],
        },
      ];
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: mockData }),
      });

      const api = createApi(fetchFn);
      const result = await api.callBulkMetric('/market/marketcap_usd');

      expect(fetchFn).toHaveBeenCalledWith(
        `${DEFAULT_API_URL}/v1/metrics/market/marketcap_usd/bulk?f=json&api_key=${API_KEY}`
      );
      expect(result).toHaveLength(1);
      expect(result[0].bulk).toHaveLength(2);
      expect(result[0].bulk[0].a).toBe('BTC');
      expect(result[0].bulk[1].network).toBe('ethereum');
    });

    it('accepts a null value for one asset and keeps the other entries intact', async () => {
      const mockData = [
        {
          t: 1,
          bulk: [
            { a: 'BTC', v: 1 },
            { a: 'XYZ', v: null },
            { a: 'ETH', v: 2, network: 'ethereum' },
          ],
        },
      ];
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: mockData }),
      });

      const api = createApi(fetchFn);
      const result = await api.callBulkMetric('/market/marketcap_usd');

      expect(result).toEqual(mockData);
      expect(result[0].bulk[1].v).toBeNull();
    });

    it('still rejects a non-numeric, non-null value', async () => {
      const fetchFn = createMockFetch({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ t: 1, bulk: [{ a: 'BTC', v: '1' }] }] }),
      });

      const api = createApi(fetchFn);

      await expect(api.callBulkMetric('/market/marketcap_usd')).rejects.toThrow(
        GlassnodeValidationError
      );
    });

    it('should handle API errors', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      const api = createApi(fetchFn);

      await expect(api.callBulkMetric('/market/marketcap_usd')).rejects.toThrow(
        'API request failed (403)'
      );
    });
  });

  describe('error handling', () => {
    it('should reject with empty API key', () => {
      expect(() => new GlassnodeAPI({ apiKey: '' })).toThrow();
    });

    it('should throw GlassnodeApiError with status and statusText', async () => {
      const fetchFn = createMockFetch({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const api = createApi(fetchFn);

      try {
        await api.getMetricList();
        expect.fail('Expected GlassnodeApiError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(GlassnodeApiError);
        const apiError = error as GlassnodeApiError;
        expect(apiError.status).toBe(401);
        expect(apiError.statusText).toBe('Unauthorized');
        expect(apiError.name).toBe('GlassnodeApiError');
        expect(apiError.message).toContain('Invalid or missing API key');
      }
    });

    it('should use specific messages for known status codes', async () => {
      const cases = [
        { status: 403, expected: 'Access forbidden' },
        { status: 404, expected: 'not found' },
        { status: 429, expected: 'Rate limit exceeded' },
      ];

      for (const { status, expected } of cases) {
        const fetchFn = createMockFetch({ ok: false, status, statusText: 'Error' });
        const api = createApi(fetchFn);

        try {
          await api.getMetricList();
          expect.fail(`Expected error for status ${status}`);
        } catch (error) {
          expect((error as GlassnodeApiError).message).toContain(expected);
        }
      }
    });

    it('should mark 429 and 5xx errors as retryable', () => {
      expect(new GlassnodeApiError(429, 'Too Many Requests').isRetryable).toBe(true);
      expect(new GlassnodeApiError(500, 'Internal Server Error').isRetryable).toBe(true);
      expect(new GlassnodeApiError(503, 'Service Unavailable').isRetryable).toBe(true);
      expect(new GlassnodeApiError(400, 'Bad Request').isRetryable).toBe(false);
      expect(new GlassnodeApiError(401, 'Unauthorized').isRetryable).toBe(false);
    });

    it('gives a helpful 402 message and marks it non-retryable', () => {
      const err = new GlassnodeApiError(402, 'Payment Required');
      expect(err.message).toContain('Payment required');
      // Case (a): a plain fetch against a paid endpoint -> point at the x402 helper
      expect(err.message).toContain('glassnode-api/x402');
      // Case (b): payment attempted but the server still answered 402 (e.g. not enough USDC)
      expect(err.message).toContain('USDC');
      // An over-ceiling price never reaches a 402 any more: createX402Fetch rejects first with
      // GlassnodePaymentError, so the message must not advise checking maxPaymentPerCall here.
      expect(err.message).toContain('GlassnodePaymentError');
      expect(err.message).not.toMatch(/within maxPaymentPerCall/);
      expect(err.isRetryable).toBe(false);
    });

    it('appends a server detail to the message and exposes it on .detail', () => {
      const err = new GlassnodeApiError(403, 'Forbidden', 'Resolution 1h is not allowed');
      expect(err.message).toContain('Access forbidden');
      expect(err.message).toContain('Resolution 1h is not allowed');
      expect(err.detail).toBe('Resolution 1h is not allowed');
    });

    it('surfaces the JSON error-body message from the server', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: vi.fn().mockResolvedValue(
          JSON.stringify({
            message: 'Resolution 1h is not allowed. Allowed resolutions: [24h, 1w, 1month]',
          })
        ),
      });
      const api = createApi(fetchFn);

      await expect(
        api.callMetric('/addresses/active_count', { a: 'ETH', i: '1h' })
      ).rejects.toThrow('Resolution 1h is not allowed');
    });

    it('surfaces a plain-text error body when it is not JSON', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('unexpected parameter "foo"'),
      });
      const api = createApi(fetchFn);

      await expect(api.getMetricList()).rejects.toThrow('unexpected parameter "foo"');
    });

    it('does not append raw JSON when the body has no message/error field', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        statusText: 'Payment Required',
        text: vi.fn().mockResolvedValue('null'),
      });
      const api = createApi(fetchFn);

      const err = (await api.callMetric('/market/mvrv', { a: 'BTC' }).catch((e) => e)) as Error;
      expect(err.message).toContain('Payment required');
      expect(err.message).not.toContain('null');
    });

    it('should handle network errors', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const api = createApi(fetchFn);

      await expect(api.getMetricList()).rejects.toThrow('Glassnode API error: Failed to fetch');
    });

    it('should preserve error cause', async () => {
      const networkError = new TypeError('Failed to fetch');
      const fetchFn = vi.fn().mockRejectedValue(networkError);
      const api = createApi(fetchFn);

      try {
        await api.getMetricList();
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).cause).toBe(networkError);
      }
    });
  });

  describe('retry logic', () => {
    it('should retry on 429 and succeed', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests' })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockMetricListResponse),
        });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 2,
        retryDelay: 1,
      });
      const result = await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockMetricListResponse);
    });

    it('should retry on 500 and succeed', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockMetricListResponse),
        });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 1,
        retryDelay: 1,
      });
      const result = await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockMetricListResponse);
    });

    it('should throw after exhausting retries', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 2,
        retryDelay: 1,
      });

      await expect(api.getMetricList()).rejects.toThrow(GlassnodeApiError);
      expect(fetchFn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should not retry on 401', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 2,
        retryDelay: 1,
      });

      await expect(api.getMetricList()).rejects.toThrow(GlassnodeApiError);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on network errors', async () => {
      const fetchFn = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockMetricListResponse),
        });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 1,
        retryDelay: 1,
      });
      const result = await api.getMetricList();

      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(result).toEqual(mockMetricListResponse);
    });

    it('does not retry a 200 response with an unparseable body', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
      });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 3,
        retryDelay: 1,
      });

      // A malformed 200 body is not a transient error — it must fail immediately, not retry.
      await expect(api.getMetricList()).rejects.toThrow(/JSON/i);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('honors a Retry-After header on 429 and still retries to success', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          headers: new Headers({ 'retry-after': '0' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: vi.fn().mockResolvedValue(mockMetricListResponse),
        });

      const api = new GlassnodeAPI({
        apiKey: API_KEY,
        fetch: fetchFn,
        maxRetries: 1,
        retryDelay: 1,
      });
      const result = await api.getMetricList();

      expect(result).toEqual(mockMetricListResponse);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('x402 mode', () => {
    const okFetch = () =>
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue(mockMetricListResponse),
      });

    it('routes to the x402 host when x402 is true', async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({ x402: true, fetch: fetchFn });
      await api.getMetricList();
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('https://x402.glassnode.com/v1/metadata/metrics')
      );
    });

    it('omits api_key when no apiKey is set', async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({ x402: true, fetch: fetchFn });
      await api.getMetricList();
      const calledUrl = fetchFn.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('api_key');
    });

    it('an explicit apiUrl overrides the x402 preset', async () => {
      const fetchFn = okFetch();
      const api = new GlassnodeAPI({
        x402: true,
        apiUrl: 'https://x402.example.test',
        fetch: fetchFn,
      });
      await api.getMetricList();
      expect(fetchFn).toHaveBeenCalledWith(
        expect.stringContaining('https://x402.example.test/v1/metadata/metrics')
      );
    });
  });
});
