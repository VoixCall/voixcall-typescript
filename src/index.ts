export { VoixCall } from './client.js';
export type { VoixCallOptions, RequestOptions, Credential, CallsListParams, ContactsSearchParams } from './client.js';
export {
  VoixCallError,
  InvalidRequestError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  InsufficientCreditsError,
  CallError,
  IdempotencyError,
  RateLimitError,
  APIError,
  APIConnectionError,
  parseRetryAfter,
} from './errors.js';
export type { VoixCallErrorType, VoixCallErrorInit } from './errors.js';
export { PagePromise } from './pagination.js';
export type { ListPage, ListParams } from './pagination.js';
export { API_VERSION, SDK_VERSION, DEFAULT_BASE_URL } from './version.js';
export type {
  Balance,
  Call,
  CallDetail,
  CallSession,
  CallerId,
  CallerIdOption,
  Contact,
  Number as PhoneNumber,
  Rate,
  ReferenceNumber,
  Transaction,
  Transcript,
  User,
  VerifiedNumber,
  ApiError as ErrorEnvelope,
  Detail as ErrorDetail,
} from './gen/types.gen.js';
