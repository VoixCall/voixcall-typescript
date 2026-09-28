// Offline check of the BUILT package (dist/, as published) on the running
// Node version. Mocked fetch only; no network.  Usage: npm run build && node scripts/runtime-check.mjs
import assert from 'node:assert/strict';
import { API_VERSION, NotFoundError, RateLimitError, VoixCall } from '../dist/index.js';

const seen = [];
let calls = 0;
const fetch = async (input, init) => {
  const req = new Request(input, init);
  seen.push(req);
  calls++;
  const u = new URL(req.url);
  const h = { 'Content-Type': 'application/json', 'Request-Id': 'req_x' };
  if (u.pathname.endsWith('/me') && calls === 1) {
    return new Response(JSON.stringify({ error: { type: 'rate_limit_error', code: 'rate_limited', message: 'slow', param: null, doc_url: 'd', request_id: 'req_rl' } }), { status: 429, headers: { ...h, 'Retry-After': '0' } });
  }
  if (u.pathname.endsWith('/me')) return new Response(JSON.stringify({ object: 'user', id: 'usr_1' }), { status: 200, headers: h });
  if (u.pathname.endsWith('/calls')) {
    const after = u.searchParams.get('starting_after');
    const data = after ? [{ id: 'call_1' }] : [{ id: 'call_3' }, { id: 'call_2' }];
    return new Response(JSON.stringify({ object: 'list', data, has_more: !after }), { status: 200, headers: h });
  }
  if (u.pathname.endsWith('/quotes')) return new Response('{}', { status: 200, headers: h });
  return new Response(JSON.stringify({ error: { type: 'not_found_error', code: 'resource_missing', message: 'nope', param: null, doc_url: 'd', request_id: 'req_nf' } }), { status: 404, headers: h });
};

const client = new VoixCall({ apiKey: 'vc_test_x', fetch });
assert.equal((await client.me.get()).id, 'usr_1');
assert.equal(seen.length, 2, '429 retried once');
assert.equal(seen[1].headers.get('Authorization'), 'Bearer vc_test_x');
assert.equal(seen[1].headers.get('VoixCall-Version'), API_VERSION);

const ids = [];
for await (const c of client.calls.list({ limit: 2 })) ids.push(c.id);
assert.deepEqual(ids, ['call_3', 'call_2', 'call_1']);

await client.post('/quotes', {});
assert.match(seen.at(-1).headers.get('Idempotency-Key'), /^[0-9a-f-]{36}$/);

await assert.rejects(client.calls.get('call_missing'), (e) => e instanceof NotFoundError && e.requestId === 'req_nf');
assert.ok(new RateLimitError({ type: 'rate_limit_error', code: 'x', message: 'm', status: 429, retryAfter: 3 }).retryAfter === 3);

console.log(`runtime check ok on Node ${process.versions.node}`);
