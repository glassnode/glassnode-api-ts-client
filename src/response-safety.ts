import type { GlassnodeError } from './errors.js';

// Global symbols survive multiple installed copies and separate CJS/ESM entries.
const SAFE_BODY_RETRY = Symbol.for('glassnode-api.x402.safe-body-retry');

/** Only createX402Fetch knows that a response arrived before any payment was sent. */
export function markUnpaidResponse(response: Response): Response {
  Object.defineProperty(response, SAFE_BODY_RETRY, { value: true });
  return response;
}

export function isUnpaidResponse(response: Response): boolean {
  return (response as Response & { [SAFE_BODY_RETRY]?: boolean })[SAFE_BODY_RETRY] === true;
}

const ERROR_NAMES = new Set([
  'GlassnodeError',
  'GlassnodeApiError',
  'GlassnodeNetworkError',
  'GlassnodeAbortError',
  'GlassnodeValidationError',
  'GlassnodeConfigError',
  'GlassnodeInputError',
  'GlassnodePaymentError',
]);

/** Preserve library classifications even when an error comes from another package copy. */
export function isGlassnodeError(error: unknown): error is GlassnodeError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string' &&
    ERROR_NAMES.has(error.name)
  );
}
