/** Version of this package. Kept in step with package.json by a test. */
export const SDK_VERSION = '0.1.0';

/**
 * The dated API version this SDK was generated against, sent as
 * `VoixCall-Version` unless overridden. It must equal the API's default
 * version, which `npm run smoke` checks against the live API.
 */
export const API_VERSION = '2026-10-01';

/** Production base URL of the /v1 API. */
export const DEFAULT_BASE_URL = 'https://api.voixcall.com/v1';
