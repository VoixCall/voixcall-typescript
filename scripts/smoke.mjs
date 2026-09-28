// Smoke test against a live API with a deliberately invalid credential:
// the built SDK must throw AuthenticationError (401) carrying the request id,
// and the API's default version (sent back when a request names none) must
// equal the SDK's API_VERSION.
// Uses no real key or token.  Usage: node scripts/smoke.mjs [baseUrl]
import assert from 'node:assert/strict';
import { API_VERSION, AuthenticationError, VoixCall } from '../dist/index.js';

const baseUrl = process.argv[2] ?? 'https://api.voixcall.com/v1';
const client = new VoixCall({ apiKey: 'vc_test_not_a_real_key', baseUrl });
try {
  await client.me.get();
  assert.fail('expected AuthenticationError');
} catch (err) {
  assert.ok(err instanceof AuthenticationError, `got ${err?.name}: ${err?.message}`);
  assert.equal(err.status, 401);
  assert.equal(err.type, 'authentication_error');
  assert.match(err.requestId ?? '', /^req_/);
  assert.equal(err.headers?.get('VoixCall-Version'), client.version);
  console.log(`ok: ${err.name} ${err.status} ${err.code} request_id=${err.requestId} doc_url=${err.docUrl}`);
}

// No VoixCall-Version header: the API answers with its default version.
const res = await fetch(`${baseUrl}/me`, { headers: { Authorization: 'Bearer vc_test_not_a_real_key' } });
const serverDefault = res.headers.get('VoixCall-Version');
assert.equal(serverDefault, API_VERSION, `API default version ${serverDefault} != SDK API_VERSION ${API_VERSION}`);
console.log(`ok: API default version ${serverDefault} == API_VERSION`);
