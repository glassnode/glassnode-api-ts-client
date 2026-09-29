/**
 * Metadata response types
 *
 * Timestamps: the API sends every point in time as unix **seconds** (a number). The schemas
 * pass them through unchanged — with one exception, `MetricMetadata.modified`, which is
 * converted to a JS `Date`. Convert the others yourself with `new Date(seconds * 1000)`.
 * Durations are not timestamps: the lag percentiles of {@link MetricStatsResponse} are lengths of
 * time in their entry's `unit` (e.g. seconds) and must not be passed to `new Date()`.
 */
import { z } from 'zod';

/**
 * Known external identifier sources schema.
 *
 * Not a closed set: the API may return other sources, which `ExternalIdsSchema` accepts.
 */
export const ExternalIdSourceSchema = z.enum(['ccdata', 'coinmarketcap', 'coingecko']);

/**
 * Known external identifier sources type
 */
export type ExternalIdSource = z.infer<typeof ExternalIdSourceSchema>;

/**
 * External identifiers for an asset schema.
 *
 * Known sources are typed as optional properties; any other source the API adds is
 * accepted and preserved (as a string) instead of failing validation.
 */
export const ExternalIdsSchema = z
  .object({
    ccdata: z.string().optional(),
    coinmarketcap: z.string().optional(),
    coingecko: z.string().optional(),
  } satisfies Record<ExternalIdSource, z.ZodType>)
  .catchall(z.string());

/**
 * External identifiers for an asset type
 */
export type ExternalIds = z.infer<typeof ExternalIdsSchema>;

/**
 * Blockchain information for an asset schema
 */
export const AssetBlockchainSchema = z.object({
  /**
   * Blockchain name
   */
  blockchain: z.string(),

  /**
   * Token address on the blockchain
   */
  address: z.string(),

  /**
   * Number of decimal places
   */
  decimals: z.number().int().nonnegative(),

  /**
   * Whether on-chain metrics are supported
   */
  on_chain_support: z.boolean(),
});

/**
 * Blockchain information for an asset type
 */
export type AssetBlockchain = z.infer<typeof AssetBlockchainSchema>;

/**
 * Asset metadata schema
 */
export const AssetMetadataSchema = z.object({
  /**
   * Asset identifier
   */
  id: z.string(),

  /**
   * Asset symbol (e.g., "BTC", "ETH")
   */
  symbol: z.string(),

  /**
   * Asset name (e.g., "Bitcoin", "Ethereum")
   */
  name: z.string(),

  /**
   * Type of asset: `"BLOCKCHAIN"` for a chain's native asset (e.g. BTC, ETH) or `"TOKEN"` for a
   * token deployed on one or more blockchains (see `blockchains`). Typed as a plain string, not an
   * enum, so a new asset type the API adds does not fail validation.
   */
  asset_type: z.string(),

  /**
   * External identifiers for this asset
   */
  external_ids: ExternalIdsSchema,

  /**
   * Blockchain information for this asset
   */
  blockchains: z.array(AssetBlockchainSchema),

  /**
   * Data categories available for this asset (e.g. `["exchanges", "on-chain", "spot"]`).
   * Open-ended strings, not an enum. Optional: `undefined` when the API omits the field.
   */
  categories: z.array(z.string()).optional(),

  /**
   * URL of the asset's logo image. Optional: `undefined` when the API omits the field.
   */
  logo_url: z.string().optional(),

  /**
   * Descriptive tags for the asset (e.g. `["layer1Token", "proofOfWork"]`); may be empty.
   * Open-ended strings, not an enum. Optional: `undefined` when the API omits the field.
   */
  semantic_tags: z.array(z.string()).optional(),

  /**
   * The network a token's data is served for by default, e.g. `"eth"`, `"sol"` or `"ton"`. An
   * empty string `""` for native assets (`asset_type` `"BLOCKCHAIN"`, e.g. BTC and ETH) and some
   * tokens. Optional: `undefined` when the API omits the field.
   */
  default_network: z.string().optional(),
});

/**
 * Asset metadata type
 */
export type AssetMetadata = z.infer<typeof AssetMetadataSchema>;

/**
 * Asset metadata response schema
 */
export const AssetMetadataResponseSchema = z.array(AssetMetadataSchema);

/**
 * Asset metadata response type
 */
export type AssetMetadataResponse = z.infer<typeof AssetMetadataResponseSchema>;

/**
 * Metric descriptors schema (human-readable names, tags, descriptions)
 */
export const MetricDescriptorsSchema = z.object({
  name: z.string().optional(),
  short_name: z.string().optional(),
  group: z.string().optional(),
  tags: z.array(z.string()).optional(),
  description: z.record(z.string(), z.string()).optional(),
  data_sharing_group: z.string().optional(),
});

/**
 * Metric descriptors type
 */
export type MetricDescriptors = z.infer<typeof MetricDescriptorsSchema>;

/**
 * Metric metadata schema
 */
export const MetricMetadataSchema = z.object({
  /**
   * Metric path
   */
  path: z.string(),

  /**
   * Access tier required for this metric, as a non-negative integer (e.g. `2`).
   * Type it as `MetricMetadata['tier']`.
   */
  tier: z.number().int().nonnegative(),

  /**
   * When the metric's metadata was last updated, as a JS `Date`.
   *
   * The API sends unix seconds; the schema converts them to a `Date` (the only time field
   * that is converted — see `timerange` and the time series/bulk `t`, which stay numbers).
   * `undefined` when the field is absent **or `0`**: `0` is treated as "no modification time
   * recorded", not as 1970-01-01.
   */
  modified: z
    .number()
    .optional()
    .transform((val) => (val ? new Date(val * 1000) : undefined)),

  /**
   * Whether this is a point-in-time metric
   */
  is_pit: z.boolean().optional(),

  /**
   * Whether bulk queries are supported for this metric
   */
  bulk_supported: z.boolean().optional(),

  /**
   * Available time range for this metric. Both bounds are unix timestamps in **seconds**
   * (numbers, not `Date`s) — convert with `new Date(min * 1000)`.
   */
  timerange: z
    .object({
      /**
       * Earliest available data point, in unix seconds (number)
       */
      min: z.number(),
      /**
       * Latest available data point, in unix seconds (number)
       */
      max: z.number(),
    })
    .optional(),

  /**
   * Reference links for this metric (docs, Studio, variant paths). Optional: `undefined` when the
   * API omits it, so read it with `?.` (e.g. `meta.refs?.docs`).
   */
  refs: z
    .object({
      docs: z.string().optional(),
      studio: z.string().optional(),
      metric_variant: z
        .object({
          base: z.string().optional(),
          bulk: z.string().optional(),
          pit: z.string().optional(),
        })
        .optional(),
    })
    .optional(),

  /**
   * The request's parameters as the API echoes them back (e.g. `{ path: '/market/price_usd_close' }`,
   * plus `a` when an asset was passed). Optional: `undefined` when the API omits it, so read it
   * with `?.`.
   */
  queried: z.record(z.string(), z.any()).optional(),

  /**
   * All allowed parameters of the metric and their values, keyed by parameter name (e.g.
   * `{ a: ['BTC', 'ETH', …], i: ['24h', …] }`). Optional, with no `{}` default: `undefined` when
   * the API omits it, so read it with `?.` (e.g. `meta.parameters?.a ?? []`).
   */
  parameters: z.record(z.string(), z.array(z.string())).optional(),

  /**
   * Default values of the parameters that have one, keyed by parameter name (e.g.
   * `{ e: ['aggregated'] }`: without `e`, the metric is served for `aggregated`). Only sent for
   * metrics with a defaulted parameter, so `undefined` for most metrics.
   */
  parameters_defaults: z.record(z.string(), z.array(z.string())).optional(),

  /**
   * Human-readable descriptors (name, tags, description)
   */
  descriptors: MetricDescriptorsSchema.optional(),
});

/**
 * Metric metadata type
 */
export type MetricMetadata = z.infer<typeof MetricMetadataSchema>;

/**
 * Metric metadata response schema
 */
export const MetricMetadataResponseSchema = MetricMetadataSchema;

/**
 * Metric list response schema
 */
export const MetricListResponseSchema = z.array(z.string().startsWith('/'));

/**
 * Metric metadata response type
 */
export type MetricMetadataResponse = z.infer<typeof MetricMetadataResponseSchema>;

/**
 * Metric list response type
 */
export type MetricListResponse = z.infer<typeof MetricListResponseSchema>;

/**
 * Lag percentiles schema (p50/p90/p95/p99 for one resolution).
 *
 * Each value is a **duration** — how far the metric's data lags behind — in the `unit` of the
 * enclosing {@link MetricLagEntrySchema} entry (e.g. `"seconds"`), not a unix timestamp: do not
 * convert it with `new Date(p * 1000)`.
 *
 * Each percentile is optional: if the API omits one for a resolution, the rest of the
 * stats still parse and the missing percentile is `undefined`.
 */
export const LagPercentilesSchema = z.object({
  p50: z.number().optional(),
  p90: z.number().optional(),
  p95: z.number().optional(),
  p99: z.number().optional(),
});

/**
 * Lag percentiles type
 */
export type LagPercentiles = z.infer<typeof LagPercentilesSchema>;

/**
 * Metric lag entry schema (one measurement window of data-lag stats).
 * `resolution` is keyed by interval (e.g. "10m", "1h", "24h") — kept open
 * as a record so new resolutions don't break validation.
 */
export const MetricLagEntrySchema = z.object({
  /**
   * Unit of the lag percentile durations in `resolution` (e.g. "seconds")
   */
  unit: z.string(),

  /**
   * Time window over which the stats are computed (e.g. "30d")
   */
  window: z.string(),

  /**
   * Lag percentiles keyed by resolution interval
   */
  resolution: z.record(z.string(), LagPercentilesSchema),
});

/**
 * Metric lag entry type
 */
export type MetricLagEntry = z.infer<typeof MetricLagEntrySchema>;

/**
 * Metric stats response schema (data-lag percentiles over the trailing 30d)
 */
export const MetricStatsResponseSchema = z.object({
  lag: z.array(MetricLagEntrySchema),
});

/**
 * Metric stats response type
 */
export type MetricStatsResponse = z.infer<typeof MetricStatsResponseSchema>;

/**
 * Bulk entry schema (one asset's value in a bulk response)
 */
export const BulkEntrySchema = z.object({
  a: z.string(),
  v: z.number(),
  network: z.string().optional(),
});

/**
 * Bulk entry type
 */
export type BulkEntry = z.infer<typeof BulkEntrySchema>;

/**
 * Bulk response schema (array of timestamped bulk entries)
 */
export const BulkResponseSchema = z.array(
  z.object({
    /**
     * Timestamp of this entry, in unix seconds (number, not a `Date`) — convert with
     * `new Date(t * 1000)`
     */
    t: z.number(),
    bulk: z.array(BulkEntrySchema),
  })
);

/**
 * Bulk response type
 */
export type BulkResponse = z.infer<typeof BulkResponseSchema>;

/**
 * One point of a single-valued metric time series, as returned by most metric endpoints via
 * `callMetric` (e.g. `/market/price_usd_close`): `{ t, v }`.
 *
 * - `t` — timestamp in unix **seconds** (a number, not a `Date`); convert with `new Date(t * 1000)`.
 * - `v` — the value. `null` is accepted: the docs do not promise that `v` is never null, and a
 *   response schema is lenient by design, so a gap in the data does not fail the whole series.
 *
 * Extra fields on a point are tolerated (stripped from the result), so an additive server change
 * does not fail validation. Metrics whose `v` is an array or object, or that return `o` instead,
 * need {@link TimeSeriesObjectPointSchema} or a schema of your own.
 */
export const TimeSeriesPointSchema = z.object({
  t: z.number(),
  v: z.number().nullable(),
});

/**
 * One point of a single-valued metric time series (`{ t, v }`)
 */
export type TimeSeriesPoint = z.infer<typeof TimeSeriesPointSchema>;

/**
 * Response schema of a single-valued metric (array of `{ t, v }` points). Pass it to
 * `callMetric(path, params, { schema: TimeSeriesResponseSchema })` for a validated result.
 */
export const TimeSeriesResponseSchema = z.array(TimeSeriesPointSchema);

/**
 * Response type of a single-valued metric (array of `{ t, v }` points)
 */
export type TimeSeriesResponse = z.infer<typeof TimeSeriesResponseSchema>;

/**
 * One point of an object-valued metric time series: `{ t, o }`, where `o` maps names to numbers —
 * e.g. `{ o, h, l, c }` for `/market/price_usd_ohlc`, or one entry per exchange/cohort for
 * breakdown metrics.
 *
 * - `t` — timestamp in unix **seconds** (see {@link TimeSeriesPointSchema}).
 * - `o` — any keys (new keys never fail validation), each a number or `null`.
 *
 * Extra fields on a point are tolerated (stripped from the result). Metrics whose `o` values are
 * nested objects or arrays need a schema of your own.
 */
export const TimeSeriesObjectPointSchema = z.object({
  t: z.number(),
  o: z.record(z.string(), z.number().nullable()),
});

/**
 * One point of an object-valued metric time series (`{ t, o }`)
 */
export type TimeSeriesObjectPoint = z.infer<typeof TimeSeriesObjectPointSchema>;

/**
 * Response schema of an object-valued metric (array of `{ t, o }` points). Pass it to
 * `callMetric(path, params, { schema: TimeSeriesObjectResponseSchema })` for a validated result.
 */
export const TimeSeriesObjectResponseSchema = z.array(TimeSeriesObjectPointSchema);

/**
 * Response type of an object-valued metric (array of `{ t, o }` points)
 */
export type TimeSeriesObjectResponse = z.infer<typeof TimeSeriesObjectResponseSchema>;
