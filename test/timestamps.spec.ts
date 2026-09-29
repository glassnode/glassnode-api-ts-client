import { describe, it, expect } from 'vitest';
import { BulkResponseSchema, MetricMetadataSchema } from '../src/types/metadata';
import { mockRawMetricMetadataResponse } from './mocks/metadata.mock';

/**
 * Pins the documented timestamp representation (see README "Timestamps"):
 * every time field, `MetricMetadata.modified` included, stays unix seconds (a number).
 */
describe('timestamp representation', () => {
  describe('MetricMetadata.modified', () => {
    it('keeps unix seconds as a number', () => {
      const result = MetricMetadataSchema.parse({
        ...mockRawMetricMetadataResponse,
        modified: 1733829848,
      });
      expect(result.modified).toBe(1733829848);
      expect(typeof result.modified).toBe('number');
    });

    it('is undefined when the field is absent', () => {
      const raw: Record<string, unknown> = { ...mockRawMetricMetadataResponse };
      delete raw.modified;
      const result = MetricMetadataSchema.parse(raw);
      expect(result.modified).toBeUndefined();
    });

    it('passes 0 through as 0', () => {
      const result = MetricMetadataSchema.parse({ ...mockRawMetricMetadataResponse, modified: 0 });
      expect(result.modified).toBe(0);
    });
  });

  it('keeps MetricMetadata.timerange bounds as unix-second numbers', () => {
    const result = MetricMetadataSchema.parse({
      ...mockRawMetricMetadataResponse,
      timerange: { min: 1230940800, max: 1733788800 },
    });
    expect(result.timerange).toEqual({ min: 1230940800, max: 1733788800 });
    expect(typeof result.timerange!.min).toBe('number');
    expect(typeof result.timerange!.max).toBe('number');
  });

  it('keeps bulk entry timestamps as unix-second numbers', () => {
    const result = BulkResponseSchema.parse([{ t: 1609459200, bulk: [{ a: 'BTC', v: 1 }] }]);
    expect(result[0].t).toBe(1609459200);
    expect(typeof result[0].t).toBe('number');
  });
});
