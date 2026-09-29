import { describe, it, expect, expectTypeOf, vi } from 'vitest';
import {
  GlassnodeConfigSchema,
  DEFAULT_API_URL,
  X402_API_URL,
  type GlassnodeConfig,
  type GlassnodeFetch,
  type Logger,
} from '../src/types/config';
import type { createX402Fetch } from '../src/x402';
import { mockMetricListResponse } from './mocks/metadata.mock';
import { GlassnodeAPI } from '../src/glassnode-api';
import { GlassnodeConfigError } from '../src/errors';

describe('GlassnodeConfigSchema', () => {
  it('exposes the URL constants', () => {
    expect(DEFAULT_API_URL).toBe('https://api.glassnode.com');
    expect(X402_API_URL).toBe('https://x402.glassnode.com');
  });

  it('requires apiKey when x402 is not enabled', () => {
    expect(() => GlassnodeConfigSchema.parse({})).toThrow(/apiKey/);
    expect(GlassnodeConfigSchema.parse({ apiKey: 'k' }).apiKey).toBe('k');
  });

  it('allows omitting apiKey when x402 is enabled, but then requires fetch', () => {
    const fetchFn = (async () => new Response()) as unknown as typeof fetch;
    expect(() => GlassnodeConfigSchema.parse({ x402: true })).toThrow(/fetch/);
    const parsed = GlassnodeConfigSchema.parse({ x402: true, fetch: fetchFn });
    expect(parsed.x402).toBe(true);
    expect(parsed.apiKey).toBeUndefined();
  });

  it('defaults x402 to false and apiUrl to undefined', () => {
    const parsed = GlassnodeConfigSchema.parse({ apiKey: 'k' });
    expect(parsed.x402).toBe(false);
    expect(parsed.apiUrl).toBeUndefined();
  });

  describe('timer bounds (timeout, retryDelay, maxRetryDelay)', () => {
    // Timers only take a 32-bit signed delay; larger values overflow (Node fires them after 1 ms)
    // and `AbortSignal.timeout()` throws a RangeError above 2^32 - 1.
    const MAX_TIMER_MS = 2_147_483_647;
    const fields = ['timeout', 'retryDelay', 'maxRetryDelay'] as const;

    it.each(fields)('accepts %s at the largest timer delay (2^31 - 1 ms)', (field) => {
      const parsed = GlassnodeConfigSchema.parse({ apiKey: 'k', [field]: MAX_TIMER_MS });
      expect(parsed[field]).toBe(MAX_TIMER_MS);
    });

    it.each(fields)('rejects %s above the largest timer delay', (field) => {
      for (const value of [MAX_TIMER_MS + 1, 5_000_000_000]) {
        const result = GlassnodeConfigSchema.safeParse({ apiKey: 'k', [field]: value });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toEqual([field]);
        expect(result.error?.issues[0].message).toMatch(/2147483647/);
      }
    });

    it.each(fields)(
      'surfaces an oversized %s as a GlassnodeConfigError at construction',
      (field) => {
        let err: unknown;
        try {
          new GlassnodeAPI({ apiKey: 'k', [field]: 5_000_000_000 });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(GlassnodeConfigError);
        expect((err as Error).message).toContain(field);
        expect((err as Error).message).toContain('2147483647');
      }
    );
  });
});

describe('logger and fetch options', () => {
  const ok = () => new Response('[]', { status: 200 });

  it('types logger as Logger and fetch as GlassnodeFetch (the call the client makes)', () => {
    expectTypeOf<GlassnodeConfig['logger']>().toEqualTypeOf<Logger | undefined>();
    expectTypeOf<GlassnodeConfig['fetch']>().toEqualTypeOf<GlassnodeFetch | undefined>();
    expectTypeOf<GlassnodeFetch>().toEqualTypeOf<
      (input: string, init?: RequestInit) => Promise<Response>
    >();
    // The standard `fetch` type still fits the option.
    expectTypeOf<typeof fetch>().toExtend<GlassnodeFetch>();
  });

  it('contextually types inline logger and fetch callbacks', () => {
    const config: GlassnodeConfig = {
      apiKey: 'k',
      logger: (message, ...args) => {
        message satisfies string;
        expectTypeOf(message).toEqualTypeOf<string>();
        expectTypeOf(args).toEqualTypeOf<unknown[]>();
      },
      fetch: async (input, init) => {
        expectTypeOf(input).toEqualTypeOf<string>();
        expectTypeOf(init).toEqualTypeOf<RequestInit | undefined>();
        return ok();
      },
    };
    expect(() => new GlassnodeAPI(config)).not.toThrow();
  });

  it('accepts common logger and fetch implementations', () => {
    const stringOnly = async (url: string, init?: RequestInit): Promise<Response> => (
      void url,
      void init,
      ok()
    );
    const undiciLike = async (
      input: string | URL | Request,
      init?: RequestInit
    ): Promise<Response> => (void input, void init, ok());
    const configs: GlassnodeConfig[] = [
      { apiKey: 'k', logger: console.log, fetch: globalThis.fetch },
      { apiKey: 'k', logger: console.error, fetch: vi.fn() },
      { apiKey: 'k', logger: vi.fn(), fetch: vi.fn<typeof fetch>().mockResolvedValue(ok()) },
      { apiKey: 'k', logger: () => {}, fetch: undiciLike },
      // A string-only custom fetch or mock: the client only ever calls `fetch(url[, init])`.
      { apiKey: 'k', fetch: stringOnly },
      { apiKey: 'k', fetch: async (url: string) => (void url, ok()) },
      { apiKey: 'k', fetch: vi.fn((url: string) => (void url, Promise.resolve(ok()))) },
      {
        apiKey: 'k',
        logger: (m: string) => void m,
        fetch: async (url: unknown) => (void url, ok()),
      },
    ];
    expect(configs).toHaveLength(8);
    for (const config of configs) expect(() => new GlassnodeAPI(config)).not.toThrow();
  });

  it('accepts the fetch returned by createX402Fetch() as the fetch option', () => {
    // A value of exactly the type `createX402Fetch()` resolves to, passed as the option (checked
    // by the compiler; the x402 runtime path is covered in x402.spec.ts).
    const paidConfig = (
      paidFetch: Awaited<ReturnType<typeof createX402Fetch>>
    ): GlassnodeConfig => ({
      x402: true,
      fetch: paidFetch,
    });
    const config = paidConfig(async () => ok());
    expect(() => new GlassnodeAPI(config)).not.toThrow();
  });

  it('rejects mistyped logger and fetch at compile time', () => {
    const bad: GlassnodeConfig[] = [
      // @ts-expect-error -- not a function
      { apiKey: 'k', logger: 'nope' },
      // @ts-expect-error -- not a function
      { apiKey: 'k', fetch: 42 },
      // @ts-expect-error -- the message is a string, not a number
      { apiKey: 'k', logger: (m: number) => void m },
      // @ts-expect-error -- fetch must resolve to a Response
      { apiKey: 'k', fetch: async () => 'body' },
      // @ts-expect-error -- fetch must return a Promise, not a bare Response
      { apiKey: 'k', fetch: (url: string) => (void url, ok()) },
      // @ts-expect-error -- the client passes a string URL, not a number
      { apiKey: 'k', fetch: async (url: number) => (void url, ok()) },
    ];
    expect(bad).toHaveLength(6);
  });

  it.each(['logger', 'fetch'] as const)(
    'rejects a non-function %s as a GlassnodeConfigError',
    (field) => {
      let err: unknown;
      try {
        new GlassnodeAPI({ apiKey: 'k', [field]: 'nope' } as never);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(GlassnodeConfigError);
      expect((err as Error).message).toContain(field);
      expect((err as Error).message).toContain('must be a function');
    }
  );

  it('keeps logger and fetch as given (not wrapped) when parsing', () => {
    const logger: Logger = () => {};
    const fetchFn: GlassnodeFetch = async () => ok();
    const parsed = GlassnodeConfigSchema.parse({ apiKey: 'k', logger, fetch: fetchFn });
    expect(parsed.logger).toBe(logger);
    expect(parsed.fetch).toBe(fetchFn);
  });

  it('calls exactly the logger and fetch that were passed', async () => {
    const calls: string[] = [];
    // Plain functions (not spies), so the check is on identity, not on a spy's bookkeeping.
    const logger: Logger = () => {
      calls.push('logger');
    };
    const fetchFn: GlassnodeFetch = async () => {
      calls.push('fetch');
      return new Response(JSON.stringify(mockMetricListResponse), { status: 200 });
    };
    const api = new GlassnodeAPI({ apiKey: 'k', logger, fetch: fetchFn });
    const internals = api as unknown as { logger: unknown; fetchFn: unknown };
    expect(internals.logger).toBe(logger);
    expect(internals.fetchFn).toBe(fetchFn);
    await api.getMetricList();
    expect(calls).toEqual(['logger', 'fetch']);
  });
});
