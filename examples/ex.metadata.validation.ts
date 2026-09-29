import { GlassnodeAPI } from '../src';
import { z } from 'zod';
import 'dotenv/config';

// Create an instance of the API client
const api = new GlassnodeAPI({
  apiKey: process.env.GLASSNODE_API_KEY || '', // Get API key from .env file
});

async function fetchAssetMetadata() {
  try {
    // Get asset metadata
    console.log('Fetching asset metadata...');

    const assetMetadata = await api.getAssetMetadata();

    // Show total number of assets
    console.log(`Found ${assetMetadata.length} assets in total`);

    // Custom validation: Check if USDC is present in the response
    const USDCSchema = z.object({
      symbol: z.literal('USDC'),
      name: z.literal('USDC'),
      asset_type: z.literal('TOKEN'),
    });

    // Create a refine function that looks for USDC
    const usdc = assetMetadata.find((asset) => asset.symbol === 'USDC');
    if (usdc) {
      try {
        USDCSchema.parse(usdc);
        console.log('✅ USDC validation successful');
        // Print 3 first blockchains for USDC
        console.log('First 3 blockchains for USDC:');
        usdc.blockchains.slice(0, 3).forEach((blockchain) => {
          console.log(`  - ${blockchain.blockchain} - ${blockchain.address}`);
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          console.error('❌ Schema validation failed:', error.issues);
        } else {
          throw error;
        }
      }
    } else {
      console.log('❌ USDC not found in response');
    }
  } catch (error) {
    console.error('Error fetching asset metadata:', error);
  }
}

async function fetchMetricList() {
  try {
    console.log('\nFetching metric list...');

    const metricList = await api.getMetricList();

    // Display basic metrics information
    console.log(`Found ${metricList.length} metrics in total`);

    // Check for market metrics
    const marketMetrics = metricList.filter((metric) => metric.startsWith('/market/'));

    if (marketMetrics.length > 0) {
      console.log(`✅ Found ${marketMetrics.length} market metrics`);
      console.log(`First 3 market metrics:`);
      marketMetrics.slice(0, 3).forEach((metric) => console.log(`  - ${metric}`));
    } else {
      console.log('❌ No market metrics found');
    }
  } catch (error) {
    console.error('Error fetching metric list:', error);
  }
}

async function fetchExchangeBalanceMetadata() {
  try {
    console.log('\nFetching exchange balance metadata...');

    const metricPath = '/distribution/balance_exchanges';
    const metadata = await api.getMetricMetadata(metricPath);

    console.log('✅ Exchange balance metadata:');
    console.log(`  Path: ${metadata.path}`);
    console.log(`  Tier: ${metadata.tier}`);
    console.log(`  Modified: ${metadata.modified?.toISOString()}`);
    console.log(`  Bulk supported: ${metadata.bulk_supported ?? 'N/A'}`);

    // Display time range
    if (metadata.timerange) {
      const min = new Date(metadata.timerange.min * 1000).toISOString().split('T')[0];
      const max = new Date(metadata.timerange.max * 1000).toISOString().split('T')[0];
      console.log(`  Time range: ${min} to ${max}`);
    }

    // Display available parameters
    console.log('\nAvailable parameters:');
    // Only print the first 3 values per parameter
    Object.entries(metadata.parameters ?? {}).forEach(([key, values]) => {
      console.log(`  ${key}: ${values.slice(0, 3).join(', ')}`);
    });

    // Display documentation links and metric variants
    if (metadata.refs?.docs) {
      console.log(`\nDocumentation: ${metadata.refs.docs}`);
    }
    if (metadata.refs?.studio) {
      console.log(`Studio: ${metadata.refs.studio}`);
    }
    if (metadata.refs?.metric_variant) {
      console.log('Metric variants:');
      Object.entries(metadata.refs.metric_variant).forEach(([key, value]) => {
        if (value) console.log(`  ${key}: ${value}`);
      });
    }
  } catch (error) {
    console.error('Error fetching exchange balance metadata:', error);
  }
}

async function fetchExchangeBalanceWithParams() {
  try {
    console.log('\nFetching exchange balance metadata with specific parameters...');

    const metricPath = '/distribution/balance_exchanges';
    const params = { a: 'BTC' };

    const metadata = await api.getMetricMetadata(metricPath, params);

    console.log('✅ Exchange balance metadata for BTC:');
    console.log(`  Path: ${metadata.path}`);
    console.log(`  Tier: ${metadata.tier}`);

    // Display queried parameters
    console.log('\nQueried parameters:');
    Object.entries(metadata.queried ?? {}).forEach(([key, value]) => {
      console.log(`  ${key}: ${value}`);
    });
  } catch (error) {
    console.error('Error fetching exchange balance metadata with parameters:', error);
  }
}

// Execute the examples
async function runExamples() {
  await fetchAssetMetadata();
  await fetchMetricList();
  await fetchExchangeBalanceMetadata();
  await fetchExchangeBalanceWithParams();
}

runExamples();
