import { parseRetryAfter } from './errors.js';

export interface RetryOptions {
  /** Retries after the first attempt. Default 2. 0 disables retries. */
  maxRetries?: number;
  /** Longest single wait in seconds. A longer Retry-After is not waited out: the error is thrown. Default 60. */
  maxRetryDelaySeconds?: number;
}

/** Statuses retried for every method (a POST carries a stable Idempotency-Key). */
const RETRY_STATUSES = new Set([429, 503]);
/** Gateway failures: the request may have run, so only idempotent methods retry. */
const RETRY_STATUSES_IDEMPOTENT = new Set([502, 504]);
/** Methods that are safe to resend after a network failure. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface RetryDeps {
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  random?: () => number;
}

export const defaultSleep = (ms: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Delay before retry number `attempt` (1-based). Retry-After wins when
 * present; otherwise exponential backoff from 0.5 s. Both get up to 25%
 * positive jitter so clients that were limited together do not return
 * together.
 */
export function retryDelayMs(attempt: number, retryAfterSeconds: number | null, random: () => number): number {
  const base = retryAfterSeconds != null ? retryAfterSeconds * 1000 : Math.min(8000, 500 * 2 ** (attempt - 1));
  return Math.round(base * (1 + 0.25 * random()));
}

/**
 * Wraps fetch with the SDK retry policy: 429 and 503 are retried for any
 * method, honouring Retry-After; 502, 504 and network failures are retried
 * only for idempotent methods. Everything else (400, 401, 403, 404, 409,
 * 500, ...) is returned as is on the first attempt.
 */
export function retryingFetch(inner: typeof fetch, opts: RetryOptions = {}, deps: RetryDeps = {}): typeof fetch {
  const maxRetries = Math.max(0, opts.maxRetries ?? 2);
  const maxDelayS = opts.maxRetryDelaySeconds ?? 60;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const original = input instanceof Request && init === undefined ? input : new Request(input, init);
    const method = original.method.toUpperCase();
    for (let attempt = 0; ; attempt++) {
      // Keep an unread copy for the next attempt (a body can be read once).
      const req = attempt < maxRetries ? original.clone() : original;
      let response: Response;
      try {
        response = await inner(req);
      } catch (err) {
        if (attempt >= maxRetries || !IDEMPOTENT_METHODS.has(method) || original.signal?.aborted) throw err;
        await sleep(Math.min(retryDelayMs(attempt + 1, null, random), maxDelayS * 1000), original.signal);
        continue;
      }
      const retryable =
        RETRY_STATUSES.has(response.status) || (RETRY_STATUSES_IDEMPOTENT.has(response.status) && IDEMPOTENT_METHODS.has(method));
      if (attempt >= maxRetries || !retryable) return response;
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      if (retryAfter != null && retryAfter > maxDelayS) return response;
      // Cap after jitter: never wait longer than maxRetryDelaySeconds (and,
      // since retryAfter <= the cap, never shorter than Retry-After).
      const delay = Math.min(retryDelayMs(attempt + 1, retryAfter, random), maxDelayS * 1000);
      // Free the connection before waiting.
      await response.body?.cancel().catch(() => {});
      await sleep(delay, original.signal);
    }
  };
}
