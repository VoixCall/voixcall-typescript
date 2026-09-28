/**
 * Typed errors for the VoixCall API error envelope (https://voixcall.com/developers/errors):
 *
 *   {"error": {"type", "code", "message", "param", "doc_url", "request_id", "billing_url"?}}
 *
 * Every failed request throws a VoixCallError subclass chosen by `type`.
 * Switch on `err.code` for the specific condition (for example
 * `invalid_token`, `insufficient_scope`, `invalid_limit`).
 */

/** Every `type` the API documents. Tolerate unknown values: new types are additive. */
export type VoixCallErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'insufficient_credits_error'
  | 'call_error'
  | 'idempotency_error'
  | 'rate_limit_error'
  | 'api_error'
  | 'connection_error'
  | (string & {});

export interface VoixCallErrorInit {
  type: VoixCallErrorType;
  code: string;
  message: string;
  param?: string | null;
  requestId?: string | null;
  status: number;
  docUrl?: string | null;
  billingUrl?: string | null;
  headers?: Headers;
  raw?: unknown;
  cause?: unknown;
}

export class VoixCallError extends Error {
  /** Error family, e.g. `authentication_error`. */
  readonly type: VoixCallErrorType;
  /** Specific condition, e.g. `invalid_token`. Listed at https://voixcall.com/developers/errors. */
  readonly code: string;
  /** The offending request parameter for validation errors, else null. */
  readonly param: string | null;
  /** `Request-Id` of the failed request (`req_...`); quote it to support. */
  readonly requestId: string | null;
  /** HTTP status; 0 when no response was received. */
  readonly status: number;
  /** Link to the error catalogue entry. */
  readonly docUrl: string | null;
  /** Where to add credits, on insufficient-credits errors. */
  readonly billingUrl: string | null;
  /** Response headers, when there was a response. */
  readonly headers: Headers | undefined;
  /** The parsed response body (or text), for debugging. */
  readonly raw: unknown;

  constructor(init: VoixCallErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.type = init.type;
    this.code = init.code;
    this.param = init.param ?? null;
    this.requestId = init.requestId ?? null;
    this.status = init.status;
    this.docUrl = init.docUrl ?? null;
    this.billingUrl = init.billingUrl ?? null;
    this.headers = init.headers;
    this.raw = init.raw;
  }
}

/** 400: validation, unknown version, bad cursor. `param` names the field. */
export class InvalidRequestError extends VoixCallError {}
/** 401: missing, invalid, expired or revoked key or token. */
export class AuthenticationError extends VoixCallError {}
/** 403: missing scope, policy, test key where live is required. */
export class PermissionError extends VoixCallError {}
/** 404: unknown object, or one that is not yours. */
export class NotFoundError extends VoixCallError {}
/** 402: not enough credit; see `billingUrl`. */
export class InsufficientCreditsError extends VoixCallError {}
/** 422: the destination was rejected. */
export class CallError extends VoixCallError {}
/** 409: Idempotency-Key reused with a different request, or still in progress. */
export class IdempotencyError extends VoixCallError {}
/** 429 after the SDK's retries. `retryAfter` is in seconds, when the server sent one. */
export class RateLimitError extends VoixCallError {
  readonly retryAfter: number | null;
  constructor(init: VoixCallErrorInit & { retryAfter?: number | null }) {
    super(init);
    this.retryAfter = init.retryAfter ?? null;
  }
}
/** 5xx or an unexpected response. */
export class APIError extends VoixCallError {}
/** No response: network failure, DNS, abort or timeout (after retries for GETs). */
export class APIConnectionError extends VoixCallError {}

const byType: Record<string, new (init: VoixCallErrorInit) => VoixCallError> = {
  invalid_request_error: InvalidRequestError,
  authentication_error: AuthenticationError,
  permission_error: PermissionError,
  not_found_error: NotFoundError,
  insufficient_credits_error: InsufficientCreditsError,
  call_error: CallError,
  idempotency_error: IdempotencyError,
  rate_limit_error: RateLimitError,
  api_error: APIError,
};

const typeByStatus: Record<number, VoixCallErrorType> = {
  400: 'invalid_request_error',
  401: 'authentication_error',
  402: 'insufficient_credits_error',
  403: 'permission_error',
  404: 'not_found_error',
  409: 'idempotency_error',
  422: 'call_error',
  429: 'rate_limit_error',
};

/**
 * Parses Retry-After (delta seconds or an HTTP date) into seconds, or null.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, (at - now) / 1000);
}

type Envelope = {
  error?: {
    type?: unknown;
    code?: unknown;
    message?: unknown;
    param?: unknown;
    doc_url?: unknown;
    request_id?: unknown;
    billing_url?: unknown;
  };
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Builds the typed error for a non-2xx response. `body` is the parsed JSON
 * (or raw text when the body was not JSON, e.g. a proxy error page).
 */
export function errorFromResponse(response: Response, body: unknown): VoixCallError {
  const status = response.status;
  const env = (body && typeof body === 'object' ? (body as Envelope).error : undefined) ?? undefined;
  const requestId = str(env?.request_id) ?? response.headers.get('Request-Id');
  const type: VoixCallErrorType =
    str(env?.type) ?? typeByStatus[status] ?? 'api_error';
  const code = str(env?.code) ?? (status >= 500 ? 'server_error' : `http_${status}`);
  const message =
    str(env?.message) ??
    `VoixCall API answered HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''} without an error envelope.`;
  const init: VoixCallErrorInit = {
    type,
    code,
    message,
    param: str(env?.param),
    requestId,
    status,
    docUrl: str(env?.doc_url),
    billingUrl: str(env?.billing_url),
    headers: response.headers,
    raw: body,
  };
  if (type === 'rate_limit_error' || status === 429) {
    return new RateLimitError({ ...init, retryAfter: parseRetryAfter(response.headers.get('Retry-After')) });
  }
  const Ctor = byType[type] ?? byType[typeByStatus[status] ?? 'api_error'] ?? APIError;
  return new Ctor(init);
}

/** Wraps a thrown fetch failure (no response). The original is `cause`; its text is never copied into `message`. */
export function connectionError(cause: unknown): APIConnectionError {
  const aborted = cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError');
  return new APIConnectionError({
    type: 'connection_error',
    code: aborted ? 'request_aborted' : 'connection_failed',
    message: aborted ? 'The request was aborted before VoixCall answered.' : 'Could not reach the VoixCall API.',
    status: 0,
    cause,
  });
}

/**
 * Internal marker for an error raised on the client side before any request
 * is sent (the apiKey/accessToken callback threw, or no Web Crypto for the
 * Idempotency-Key). The SDK rethrows `cause`, the original error, untouched
 * instead of turning it into an APIConnectionError.
 */
export class PassthroughError extends Error {
  constructor(cause: unknown) {
    super('client-side error before the request was sent', { cause });
    this.name = 'PassthroughError';
  }
}
