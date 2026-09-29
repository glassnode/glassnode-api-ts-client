import { GlassnodeAPI } from '../src';
import 'dotenv/config';

const api = new GlassnodeAPI({
  apiKey: process.env.GLASSNODE_API_KEY || '',
  logger: console.log,
});

async function getAssetsByMarketCap() {
  console.log('Fetching bulk market cap data...\n');

  // Bulk endpoints require a=* for all assets and a bounded time range (max ~31 days)
  const oneDayAgo = Math.floor(Date.now() / 1000) - 86400;
  const result = await api.callBulkMetric('/market/marketcap_usd', {
    a: '*',
    s: oneDayAgo, // unix seconds — numbers and Dates are converted by the client
    i: '24h',
  });

  if (result.length === 0) {
    console.log('No data returned.');
    return;
  }

  // Get the latest timestamp entry
  const latest = result[result.length - 1];
  const date = new Date(latest.t * 1000).toISOString().split('T')[0];

  // Sort assets by market cap descending. `v` is null for an asset without data, so drop those
  // (and zero values) first; the type guard narrows `v` to `number` for the sort.
  const ranked = latest.bulk
    .filter((entry): entry is typeof entry & { v: number } => entry.v !== null && entry.v > 0)
    .sort((a, b) => b.v - a.v);

  console.log(`Top 20 assets by market cap (${date}):\n`);
  console.log('  #   Asset       Market Cap');
  console.log('  --- ----------- ----------------');

  ranked.slice(0, 20).forEach((entry, i) => {
    const rank = String(i + 1).padStart(3);
    const asset = entry.a.toUpperCase().padEnd(11);
    const mcap = formatUsd(entry.v);
    console.log(`  ${rank} ${asset} ${mcap}`);
  });

  console.log(`\n  Total assets with market cap data: ${ranked.length}`);
}

function formatUsd(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  return `$${value.toFixed(2)}`;
}

getAssetsByMarketCap().catch(console.error);
