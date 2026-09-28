import { createClient, createConfig, type Client } from './gen/client/index.js';
import * as gen from './gen/sdk.gen.js';
import type {
  Balance,
  Call,
  CallDetail,
  CallerId,
  Contact,
  ListCallsData,
  Number as PhoneNumber,
  Rate,
  Transaction,
  User,
} from './gen/types.gen.js';
import { APIError, connectionError, PassthroughError, errorFromResponse, VoixCallError } from './errors.js';
import { PagePromise, type ListPage, type ListParams } from './pagination.js';
import { retryingFetch, type RetryDeps } from './retry.js';
import { API_VERSION, DEFAULT_BASE_URL } from './version.js';

/** A bearer credential, or a function returning one (e.g. to refresh an OAuth token). */
export type Credential = string | (() => string | Promise<string>);

export interface VoixCallOptions {
  /** Personal API key: `vc_live_...` or `vc_test_...`. */
  apiKey?: Credential;
  /** OAuth 2.1 access token (`vcat_...`) obtained by your app. */
  accessToken?: Credential;
  /** Defaults to https://api.voixcall.com/v1. */
  baseUrl?: string;
  /** `VoixCall-Version` sent on every request. Defaults to the version this SDK was generated for. */
  version?: string;
  /** Retries after the first attempt for 429, 503 and (GET only) network errors. Default 2. */
  maxRetries?: number;
  /** A Retry-After longer than this (seconds) is not waited out. Default 60. */
  maxRetryDelaySeconds?: number;
  /** Per-attempt timeout in milliseconds. Default 30000. 0 disables it. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** @internal test hooks */
  _retry?: RetryDeps;
}

/** Per-call options. */
export interface RequestOptions {
  signal?: AbortSignal;
  /** Overrides the client's VoixCall-Version for this call. */
  version?: string;
  /** Sent as Idempotency-Key on POST; generated when omitted. */
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

export interface CallsListParams extends ListParams {
  direction?: 'outbound' | 'inbound';
  /** Only calls started at or after this RFC 3339 time. */
  started_at_gte?: string;
  /** Only calls started at or before this RFC 3339 time. */
  started_at_lte?: string;
  /** Only calls to this E.164 number. */
  to?: string;
}

export interface ContactsSearchParams extends ListParams {
  /** 2 to 64 characters; matches name, company and number fragments. */
  q: string;
}

type GenResult = { data?: unknown; error?: unknown; response?: Response };

const HDR_VERSION = 'VoixCall-Version';
const HDR_IDEMPOTENCY = 'Idempotency-Key';

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  // randomUUID needs a secure context in browsers; getRandomValues does not.
  // RFC 4122 v4 layout from 16 random bytes.
  if (typeof c?.getRandomValues !== 'function') {
    throw new TypeError('VoixCall: Web Crypto (globalThis.crypto) is required to generate Idempotency-Key; pass idempotencyKey explicitly.');
  }
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** req's signal plus a per-attempt timeout (AbortSignal.any is Node 20.3+, so combine by hand). */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => {
    const err = new Error(`Request timed out after ${ms} ms.`);
    err.name = 'TimeoutError';
    ctl.abort(err);
  }, ms);
  // Do not keep a Node process alive for the timer.
  (t as { unref?: () => void }).unref?.();
  ctl.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ctl.signal;
}

function listQuery(p: ListParams): Record<string, string> {
  const q: Record<string, string> = {};
  if (p.limit !== undefined) q.limit = String(p.limit);
  if (p.starting_after !== undefined) q.starting_after = p.starting_after;
  if (p.ending_before !== undefined) q.ending_before = p.ending_before;
  return q;
}

function asPage<T>(raw: unknown): ListPage<T> {
  const r = raw as { data?: T[] | null; has_more?: boolean };
  return { object: 'list', data: r.data ?? [], has_more: r.has_more === true };
}

/**
 * VoixCall API client. Acts on the personal account of the key or token
 * owner only; organization data is not reachable through the public API.
 *
 *   const voixcall = new VoixCall({ apiKey: process.env.VOIXCALL_API_KEY });
 *   const me = await voixcall.me.get();
 */
export class VoixCall {
  /** The underlying generated Hey API client, for operations without a wrapper. */
  readonly client: Client;
  readonly version: string;
  readonly baseUrl: string;
  readonly #credential: Credential;

  constructor(options: VoixCallOptions = {}) {
    if (options.apiKey && options.accessToken) {
      throw new TypeError('VoixCall: pass apiKey or accessToken, not both.');
    }
    const credential = options.apiKey ?? options.accessToken;
    if (credential === undefined || credential === '') {
      throw new TypeError('VoixCall: apiKey (vc_live_/vc_test_) or accessToken is required.');
    }
    this.#credential = credential;
    this.version = options.version ?? API_VERSION;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = options.timeoutMs ?? 30_000;
    const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timed: typeof fetch =
      timeoutMs > 0
        ? (input, init) => {
            const req = new Request(input, init);
            return baseFetch(new Request(req, { signal: withTimeout(req.signal, timeoutMs) }));
          }
        : baseFetch;

    this.client = createClient(
      createConfig({
        baseUrl: this.baseUrl,
        fetch: retryingFetch(
          timed,
          { maxRetries: options.maxRetries, maxRetryDelaySeconds: options.maxRetryDelaySeconds },
          options._retry,
        ),
        headers: options.headers,
        // Every /v1 response is JSON. Never fall back to text: a 2xx that is
        // not JSON (a proxy page) must fail, not resolve to a string.
        parseAs: 'json',
        throwOnError: false,
      }),
    );

    // Headers every request carries. Runs once per logical request, before
    // retries, so a POST keeps one Idempotency-Key across attempts.
    this.client.interceptors.request.use(async (request) => {
      let token: string;
      try {
        token = typeof this.#credential === 'function' ? await this.#credential() : this.#credential;
      } catch (err) {
        // Your callback's error, passed through untouched by request().
        throw new PassthroughError(err);
      }
      request.headers.set('Authorization', `Bearer ${token}`);
      if (!request.headers.has(HDR_VERSION)) request.headers.set(HDR_VERSION, this.version);
      if (request.method.toUpperCase() === 'POST' && !request.headers.has(HDR_IDEMPOTENCY)) {
        let key: string;
        try {
          key = uuid();
        } catch (err) {
          throw new PassthroughError(err);
        }
        request.headers.set(HDR_IDEMPOTENCY, key);
      }
      return request;
    });
  }

  /** Runs a generated operation and returns its data or throws a typed error. */
  async request<T>(op: (opts: { client: Client; signal?: AbortSignal; headers: Record<string, string> }) => Promise<GenResult>, ro: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { ...ro.headers };
    if (ro.version) headers[HDR_VERSION] = ro.version;
    if (ro.idempotencyKey) headers[HDR_IDEMPOTENCY] = ro.idempotencyKey;
    const res = await op({ client: this.client, signal: ro.signal, headers });
    if (res.error instanceof PassthroughError) throw res.error.cause;
    if (res.response?.ok) {
      if (res.error === undefined) return res.data as T;
      // 2xx whose body could not be parsed as JSON.
      throw new APIError({
        type: 'api_error',
        code: 'invalid_response',
        message: 'VoixCall answered with an unreadable body.',
        status: res.response.status,
        requestId: res.response.headers.get('Request-Id'),
        headers: res.response.headers,
        cause: res.error,
      });
    }
    if (res.response) throw errorFromResponse(res.response, res.error);
    if (res.error instanceof VoixCallError) throw res.error;
    throw connectionError(res.error);
  }

  /** Raw request for an operation the SDK does not wrap yet, e.g. a new POST. */
  async post<T>(path: string, body: unknown, ro: RequestOptions = {}): Promise<T> {
    return this.request<T>(
      (o) => this.client.post({ url: path, body, ...o, headers: { 'Content-Type': 'application/json', ...o.headers } }) as Promise<GenResult>,
      ro,
    );
  }

  /** Raw GET for an operation the SDK does not wrap yet. */
  async get<T>(path: string, query?: Record<string, unknown>, ro: RequestOptions = {}): Promise<T> {
    return this.request<T>((o) => this.client.get({ url: path, query, ...o }) as Promise<GenResult>, ro);
  }

  #list<T extends { id: string }, P extends ListParams>(
    run: (p: P, o: { client: Client; signal?: AbortSignal; headers: Record<string, string> }) => Promise<GenResult>,
    params: P,
    ro?: RequestOptions,
  ): PagePromise<T, P> {
    return new PagePromise<T, P>(async (p) => asPage<T>(await this.request((o) => run(p, o), ro)), params);
  }

  readonly me = {
    /** The account the key or token acts for. */
    get: (ro?: RequestOptions): Promise<User> => this.request<User>((o) => gen.getMe(o), ro),
  };

  readonly rates = {
    /** Per-minute rate to an E.164 number. Money is a decimal string. */
    get: (params: { to: string }, ro?: RequestOptions): Promise<Rate> =>
      this.request<Rate>((o) => gen.getRate({ ...o, query: { to: params.to } }), ro),
  };

  readonly credits = {
    /** Current balance (decimal string, USD). */
    balance: (ro?: RequestOptions): Promise<Balance> => this.request<Balance>((o) => gen.getBalance(o), ro),
    transactions: {
      /** Credit transactions, newest first. Await for one page or `for await` for all. */
      list: (params: ListParams = {}, ro?: RequestOptions): PagePromise<Transaction, ListParams> =>
        this.#list<Transaction, ListParams>((p, o) => gen.listTransactions({ ...o, query: listQuery(p) }), params, ro),
    },
  };

  readonly calls = {
    /** Calls on the personal account, newest first. Await for one page or `for await` for all. */
    list: (params: CallsListParams = {}, ro?: RequestOptions): PagePromise<Call, CallsListParams> =>
      this.#list<Call, CallsListParams>((p, o) => {
        const query: NonNullable<ListCallsData['query']> = listQuery(p);
        if (p.direction !== undefined) query.direction = p.direction;
        if (p.started_at_gte !== undefined) query['started_at[gte]'] = p.started_at_gte;
        if (p.started_at_lte !== undefined) query['started_at[lte]'] = p.started_at_lte;
        if (p.to !== undefined) query.to = p.to;
        return gen.listCalls({ ...o, query });
      }, params, ro),
    /** One call by id (`call_...`). */
    get: (id: string, ro?: RequestOptions): Promise<CallDetail> =>
      this.request<CallDetail>((o) => gen.getCall({ ...o, path: { id } }), ro),
  };

  readonly contacts = {
    /** Search contacts by name, company or number fragment. Await for one page or `for await` for all. */
    search: (params: ContactsSearchParams, ro?: RequestOptions): PagePromise<Contact, ContactsSearchParams> =>
      this.#list<Contact, ContactsSearchParams>((p, o) => gen.searchContacts({ ...o, query: { ...listQuery(p), q: p.q } }), params, ro),
  };

  readonly numbers = {
    /** Numbers on the personal account. Await for one page or `for await` for all. */
    list: (params: ListParams = {}, ro?: RequestOptions): PagePromise<PhoneNumber, ListParams> =>
      this.#list<PhoneNumber, ListParams>((p, o) => gen.listNumbers({ ...o, query: listQuery(p) }), params, ro),
  };

  readonly callerId = {
    /** Current caller ID, the options and verified personal numbers. */
    get: (ro?: RequestOptions): Promise<CallerId> => this.request<CallerId>((o) => gen.getCallerId(o), ro),
  };
}
