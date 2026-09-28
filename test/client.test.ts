import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  APIConnectionError,
  APIError,
  AuthenticationError,
  InsufficientCreditsError,
  InvalidRequestError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  SDK_VERSION,
  VoixCall,
  VoixCallError,
} from '../src/index.js';
import { caught, envelope, json, setup } from './helpers.js';

const me = { object: 'user', id: 'usr_1', email: 'a@b.c', display_name: null, country_code: null, time_zone: null, livemode: false };

describe('headers', () => {
  it('sends the API key as a bearer token and the default version', async () => {
    const { client, requests } = setup(() => json(200, me));
    await expect(client.me.get()).resolves.toEqual(me);
    const r = requests[0]!;
    expect(r.url).toBe('https://api.voixcall.com/v1/me');
    expect(r.method).toBe('GET');
    expect(r.headers.get('Authorization')).toBe('Bearer vc_test_abc');
    expect(r.headers.get('VoixCall-Version')).toBe(API_VERSION);
    expect(r.headers.get('Idempotency-Key')).toBeNull();
  });

  it('accepts an OAuth access token, possibly from a callback', async () => {
    let n = 0;
    const { client, requests } = setup(() => json(200, me), { apiKey: undefined, accessToken: () => `vcat_${++n}` });
    await client.me.get();
    await client.me.get();
    expect(requests.map((r) => r.headers.get('Authorization'))).toEqual(['Bearer vcat_1', 'Bearer vcat_2']);
  });

  it('honours version and baseUrl overrides, client-wide and per request', async () => {
    const { client, requests } = setup(() => json(200, me), { version: '2026-01-01', baseUrl: 'http://localhost:8080/v1/' });
    await client.me.get();
    await client.me.get({ version: '2027-01-01' });
    expect(requests[0]!.url).toBe('http://localhost:8080/v1/me');
    expect(requests[0]!.headers.get('VoixCall-Version')).toBe('2026-01-01');
    expect(requests[1]!.headers.get('VoixCall-Version')).toBe('2027-01-01');
  });

  it('requires exactly one credential', () => {
    expect(() => new VoixCall({})).toThrow(TypeError);
    expect(() => new VoixCall({ apiKey: 'vc_test_x', accessToken: 'vcat_x' })).toThrow(TypeError);
  });

  it('serializes resource parameters', async () => {
    const { client, requests } = setup(() => json(200, { object: 'list', data: [], has_more: false }));
    await client.rates.get({ to: '+447700900123' }).catch(() => {});
    await client.calls.list({ limit: 5, direction: 'outbound', started_at_gte: '2026-09-01T00:00:00Z', to: '+15005550006' });
    await client.contacts.search({ q: 'ann' });
    await client.calls.get('call_abc');
    const urls = requests.map((r) => decodeURIComponent(r.url));
    expect(urls[0]).toBe('https://api.voixcall.com/v1/rates?to=+447700900123');
    expect(urls[1]).toContain('/v1/calls?');
    expect(urls[1]).toContain('limit=5');
    expect(urls[1]).toContain('direction=outbound');
    expect(urls[1]).toContain('started_at[gte]=2026-09-01T00:00:00Z');
    expect(urls[1]).toContain('to=+15005550006');
    expect(urls[2]).toBe('https://api.voixcall.com/v1/contacts?q=ann');
    expect(urls[3]).toBe('https://api.voixcall.com/v1/calls/call_abc');
  });
});

describe('idempotency', () => {
  it('adds one Idempotency-Key per POST and keeps it across retries', async () => {
    const { client, requests } = setup((_, n) => (n === 1 ? json(429, envelope('rate_limit_error', 'rate_limited'), { 'Retry-After': '1' }) : json(200, { ok: true })));
    await client.post('/quotes', { to: '+15005550006' });
    expect(requests).toHaveLength(2);
    const k1 = requests[0]!.headers.get('Idempotency-Key');
    expect(k1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(requests[1]!.headers.get('Idempotency-Key')).toBe(k1);
    expect(await requests[1]!.json()).toEqual({ to: '+15005550006' });

    await client.post('/quotes', {});
    expect(requests[2]!.headers.get('Idempotency-Key')).not.toBe(k1);
  });

  it('uses a caller-provided key', async () => {
    const { client, requests } = setup(() => json(200, {}));
    await client.post('/calls', { quote_id: 'q_1' }, { idempotencyKey: 'my-key-1' });
    expect(requests[0]!.headers.get('Idempotency-Key')).toBe('my-key-1');
    expect(requests[0]!.headers.get('Content-Type')).toBe('application/json');
  });
});

describe('retries', () => {
  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const { client, requests, sleeps } = setup((_, n) =>
      n < 3 ? json(429, envelope('rate_limit_error', 'rate_limited'), { 'Retry-After': '2' }) : json(200, me),
    );
    await expect(client.me.get()).resolves.toEqual(me);
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('jitters the wait upwards by at most 25%', async () => {
    const { client, sleeps } = setup((_, n) => (n === 1 ? json(503, envelope('api_error', 'rate_limiter_unavailable')) : json(200, me)), {
      _retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.999 },
    });
    await client.me.get();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThanOrEqual(625);
  });

  it('stops after 2 retries and throws RateLimitError with retryAfter', async () => {
    const { client, requests } = setup(() => json(429, envelope('rate_limit_error', 'rate_limited'), { 'Retry-After': '7' }));
    const err = await caught(client.me.get());
    expect(requests).toHaveLength(3);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err).toBeInstanceOf(VoixCallError);
    expect(err.retryAfter).toBe(7);
    expect(err.status).toBe(429);
  });

  it('retries 503 for POST too', async () => {
    const { client, requests } = setup((_, n) => (n === 1 ? json(503, envelope('api_error', 'unavailable')) : json(200, {})));
    await client.post('/quotes', {});
    expect(requests).toHaveLength(2);
  });

  it('does not wait out a Retry-After above the cap', async () => {
    const { client, requests } = setup(() => json(429, envelope('rate_limit_error', 'rate_limited'), { 'Retry-After': '3600' }));
    await expect(client.me.get()).rejects.toBeInstanceOf(RateLimitError);
    expect(requests).toHaveLength(1);
  });

  it('respects maxRetries: 0', async () => {
    const { client, requests } = setup(() => json(503, envelope('api_error', 'unavailable')), { maxRetries: 0 });
    await expect(client.me.get()).rejects.toBeInstanceOf(APIError);
    expect(requests).toHaveLength(1);
  });

  it.each([
    [400, 'invalid_request_error', 'invalid_limit', InvalidRequestError],
    [401, 'authentication_error', 'invalid_token', AuthenticationError],
    [403, 'permission_error', 'insufficient_scope', PermissionError],
    [404, 'not_found_error', 'resource_missing', NotFoundError],
    [500, 'api_error', 'internal_error', APIError],
  ])('does not retry %i', async (status, type, code, Cls) => {
    const { client, requests } = setup(() => json(status, envelope(type, code)));
    const err = await caught(client.me.get());
    expect(requests).toHaveLength(1);
    expect(err).toBeInstanceOf(Cls);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  });

  it('retries a GET after a network error', async () => {
    const { client, requests } = setup((_, n) => {
      if (n === 1) throw new TypeError('fetch failed');
      return json(200, me);
    });
    await expect(client.me.get()).resolves.toEqual(me);
    expect(requests).toHaveLength(2);
  });

  it('does not retry a POST after a network error', async () => {
    const { client, requests } = setup(() => {
      throw new TypeError('fetch failed');
    });
    const err = await caught(client.post('/quotes', {}));
    expect(requests).toHaveLength(1);
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('connection_failed');
  });

  it('gives up on a GET after 2 retries of network errors', async () => {
    const { client, requests } = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(client.me.get()).rejects.toBeInstanceOf(APIConnectionError);
    expect(requests).toHaveLength(3);
  });
});

describe('errors', () => {
  it('maps every field of the §4.3 envelope', async () => {
    const { client } = setup(() =>
      json(402, envelope('insufficient_credits_error', 'insufficient_credits', { billing_url: 'https://voixcall.com/get?to=credits', param: 'to' })),
    );
    const err = await caught(client.me.get());
    expect(err).toBeInstanceOf(InsufficientCreditsError);
    expect(err).toMatchObject({
      name: 'InsufficientCreditsError',
      type: 'insufficient_credits_error',
      code: 'insufficient_credits',
      message: 'msg insufficient_credits',
      param: 'to',
      requestId: 'req_body',
      status: 402,
      docUrl: 'https://voixcall.com/developers/errors#insufficient_credits',
      billingUrl: 'https://voixcall.com/get?to=credits',
    });
  });

  it('falls back to status and the Request-Id header for a non-envelope body', async () => {
    const { client } = setup(() => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'Request-Id': 'req_proxy' } }));
    const err = await caught(client.me.get());
    expect(err).toBeInstanceOf(APIError);
    expect(err.requestId).toBe('req_proxy');
    expect(err.status).toBe(502);
    expect(err.raw).toBe('<html>Bad Gateway</html>');
  });

  it('keeps an unknown type as a VoixCallError with that type', async () => {
    const { client } = setup(() => json(409, envelope('brand_new_error', 'something')));
    const err = await caught(client.me.get());
    expect(err).toBeInstanceOf(VoixCallError);
    expect(err.type).toBe('brand_new_error');
  });
});

describe('money', () => {
  it('keeps decimal strings as strings', async () => {
    const bal = { object: 'balance', amount: '12.50', currency: 'USD', low_balance: false, billing_url: 'https://voixcall.com/get?to=credits', livemode: true };
    const { client } = setup(() => json(200, bal));
    const got = await client.credits.balance();
    expect(got.amount).toBe('12.50');
    expect(typeof got.amount).toBe('string');
  });
});

describe('versions stay in step', () => {
  it('API_VERSION is a dated version (the live server default is checked by npm run smoke)', () => {
    expect(API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(`${API_VERSION}T00:00:00Z`).toISOString().slice(0, 10)).toBe(API_VERSION);
  });

  it('SDK_VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SDK_VERSION).toBe(pkg.version);
  });
});

describe('idempotency key fallback', () => {
  it('builds a v4 UUID from getRandomValues when randomUUID is missing (insecure browser context)', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: (b: Uint8Array) => real.getRandomValues(b) },
      configurable: true,
      writable: true,
    });
    try {
      const { client, requests } = setup(() => json(200, {}));
      await client.post('/quotes', {});
      expect(requests[0]!.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
  });
});

describe('missing Web Crypto', () => {
  it('rethrows the Idempotency-Key error untouched, not as APIConnectionError', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      const { client, requests } = setup(() => json(200, {}));
      const err = await caught(client.post('/quotes', {}));
      expect(err).toBeInstanceOf(TypeError);
      expect(err).not.toBeInstanceOf(VoixCallError);
      expect(err.message).toContain('Web Crypto');
      expect(requests).toHaveLength(0);
      // A caller-provided key needs no Web Crypto.
      await client.post('/quotes', {}, { idempotencyKey: 'k-1' });
      expect(requests[0]!.headers.get('Idempotency-Key')).toBe('k-1');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
  });
});

describe('unreadable 2xx bodies', () => {
  it.each([
    ['text/html', '<html>maintenance</html>'],
    ['application/json', '{"object": "user", '],
  ])('a 200 %s body that is not JSON throws APIError invalid_response', async (type, body) => {
    const { client } = setup(() => new Response(body, { status: 200, headers: { 'Content-Type': type, 'Request-Id': 'req_bad' } }));
    const err = await caught(client.me.get());
    expect(err).toBeInstanceOf(APIError);
    expect(err).toMatchObject({
      type: 'api_error',
      code: 'invalid_response',
      message: 'VoixCall answered with an unreadable body.',
      status: 200,
      requestId: 'req_bad',
    });
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });
});

describe('credential callback errors', () => {
  it('rethrows the callback error untouched and never copies it into an SDK error', async () => {
    const secret = 'refresh_token=vcrt_fake-secret-123';
    const original = new Error(`token refresh failed: ${secret}`);
    const { client, requests } = setup(() => json(200, me), {
      apiKey: undefined,
      accessToken: async () => {
        throw original;
      },
    });
    const err = await caught(client.me.get());
    expect(err).toBe(original);
    expect(err).not.toBeInstanceOf(VoixCallError);
    expect(requests).toHaveLength(0);
  });

  it('no VoixCallError message ever carries the text of an underlying error', async () => {
    const secret = 'vcat_fake-secret-456';
    const { client } = setup(() => {
      throw new TypeError(`fetch failed: ${secret}`);
    });
    const err = await caught(client.me.get());
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message).not.toContain(secret);
    expect(String(err)).not.toContain(secret);
  });
});

describe('retry: gateway errors and the delay cap', () => {
  it.each([502, 504])('retries %i for GET', async (status) => {
    const { client, requests } = setup((_, n) => (n === 1 ? json(status, envelope('api_error', 'bad_gateway')) : json(200, me)));
    await expect(client.me.get()).resolves.toEqual(me);
    expect(requests).toHaveLength(2);
  });

  it.each([502, 504])('does not retry %i for POST', async (status) => {
    const { client, requests } = setup(() => json(status, envelope('api_error', 'bad_gateway')));
    await expect(client.post('/quotes', {})).rejects.toBeInstanceOf(APIError);
    expect(requests).toHaveLength(1);
  });

  it('caps the jittered wait at maxRetryDelaySeconds', async () => {
    const sleeps: number[] = [];
    const { client } = setup((_, n) => (n === 1 ? json(429, envelope('rate_limit_error', 'rate_limited'), { 'Retry-After': '10' }) : json(200, me)), {
      maxRetryDelaySeconds: 10,
      _retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0.999 },
    });
    await client.me.get();
    expect(sleeps).toEqual([10_000]);
  });
});
