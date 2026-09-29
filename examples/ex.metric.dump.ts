import { GlassnodeAPI } from '../src';
import 'dotenv/config';

// Create an instance of the API client
const api = new GlassnodeAPI({
  apiKey: process.env.GLASSNODE_API_KEY || '', // Get API key from .env file
});

// Execute the examples
async function runExamples() {
  //const assetMetadata = await api.getAssetMetadata();
  const metricList = await api.getMetricList();
  for (const metric of metricList.slice(0, 10)) {
    const metricMetadata = await api.getMetricMetadata(metric);
    const params = metricMetadata.parameters ?? {};
    // create params object from params array
    const paramsObject: Record<string, string> = {};
    for (const param of Object.keys(params)) {
      // Fix: params[param] is an array of strings, not an object with values property
      if (Array.isArray(params[param]) && params[param].length > 0) {
        paramsObject[param] = params[param][0];
      }
    }

    const result = await api.callMetric<Record<string, unknown>[]>(metric, paramsObject);
    console.log(result[0]);
  }
}

runExamples();
