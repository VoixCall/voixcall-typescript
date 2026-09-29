# @voixcall/sdk

The official TypeScript SDK for the [VoixCall API](https://voixcall.com/developers) (`https://api.voixcall.com/v1`): rates, credits, calls, contacts, numbers and caller ID.

- ESM with TypeScript types. Runs on Node 20 or later and in modern browsers.
- No runtime dependencies. The HTTP layer is generated with [Hey API](https://github.com/hey-api/openapi-ts) from the API's OpenAPI document and bundled in the package.
- Handles authentication, the `VoixCall-Version` header, retries that honour `Retry-After`, auto-pagination, automatic `Idempotency-Key`s on POST, and typed errors.

> **Personal account only.** API keys and OAuth tokens act on the personal account of the user who created them. Organization calls, transcripts and numbers are not reachable through the public API, even for organization admins.

## Install

```sh
npm install @voixcall/sdk
```

## Quickstart

### With an API key

API keys start with `vc_live_` (live data) or `vc_test_` (test mode, see below). Keep them on the server; never ship one in browser code.

```ts
import { VoixCall } from '@voixcall/sdk';

const voixcall = new VoixCall({ apiKey: process.env.VOIXCALL_API_KEY });

const me = await voixcall.me.get();
const balance = await voixcall.credits.balance();
console.log(me.email, balance.amount, balance.currency); // "12.50" "USD"

const rate = await voixcall.rates.get({ to: '+447700900123' });
console.log(rate.rate_per_minute); // "0.0130"
```

### With an OAuth access token

Apps that act for other VoixCall users get an access token (`vcat_...`) through OAuth 2.1 with PKCE (see the developer docs). Pass the token, or a function that returns a fresh one:

```ts
const voixcall = new VoixCall({ accessToken: async () => tokenStore.currentAccessToken() });
const numbers = await voixcall.numbers.list();
```

### Options

| Option | Default | Notes |
|---|---|---|
| `apiKey` / `accessToken` | required, exactly one | A string or a function returning a string (sync or async). Sent as `Authorization: Bearer ...`. |
| `baseUrl` | `https://api.voixcall.com/v1` | |
| `version` | the version this SDK was generated for (`2026-10-01`) | Sent as `VoixCall-Version`. Also overridable per request. |
| `maxRetries` | `2` | Retries after the first attempt. `0` disables retries. |
| `maxRetryDelaySeconds` | `60` | A longer `Retry-After` is not waited out; the error is thrown instead. |
| `timeoutMs` | `30000` | Per attempt. `0` disables it. |
| `fetch` | `globalThis.fetch` | A custom fetch implementation. |
| `headers` | none | Extra headers on every request. |

Every method takes an optional last argument `{ signal, version, idempotencyKey, headers }`.

## Resources

| Method | Endpoint |
|---|---|
| `me.get()` | `GET /v1/me` |
| `rates.get({ to })` | `GET /v1/rates` |
| `credits.balance()` | `GET /v1/credits/balance` |
| `credits.transactions.list(params)` | `GET /v1/credits/transactions` |
| `calls.list(params)` | `GET /v1/calls` (`direction`, `started_at_gte`, `started_at_lte`, `to`) |
| `calls.get(id)` | `GET /v1/calls/{id}` |
| `contacts.search({ q })` | `GET /v1/contacts` |
| `numbers.list(params)` | `GET /v1/numbers` |
| `callerId.get()` | `GET /v1/caller-id` |

Money is always a decimal string (`"12.50"`, rates `"0.0130"`) with a `currency`, never a float. Use a decimal library if you do arithmetic on it.

For an operation that has no wrapper yet, use `voixcall.get(path, query)` or `voixcall.post(path, body)`. They apply the same auth, retries and error handling. The generated functions are also available on `voixcall.client`.

## Pagination

List methods return a `PagePromise`. Await it to get one page (`{ object: 'list', data, has_more }`), or iterate it with `for await` to walk every page:

```ts
// One page
const page = await voixcall.calls.list({ limit: 20 });

// Every call, newest first; pages are fetched as you go
for await (const call of voixcall.calls.list({ direction: 'outbound', limit: 100 })) {
  console.log(call.id, call.to_number, call.cost);
}

// Collect up to 500 objects
const recent = await voixcall.credits.transactions.list().toArray(500);

// Page by page
for await (const page of voixcall.numbers.list().pages()) { /* ... */ }
```

Iteration continues with `starting_after` set to the last id of each page while `has_more` is true (or with `ending_before` set to the first id if you started with `ending_before`). A page can hold fewer than `limit` objects when the response hits the 32 KB cap; iteration picks up from the last object received, so nothing is skipped.

## Errors

Every failed request throws a subclass of `VoixCallError`, chosen by the `type` in the API's error envelope:

| Class | `type` | Typical status |
|---|---|---|
| `InvalidRequestError` | `invalid_request_error` | 400 |
| `AuthenticationError` | `authentication_error` | 401 |
| `InsufficientCreditsError` | `insufficient_credits_error` | 402 |
| `PermissionError` | `permission_error` | 403 |
| `NotFoundError` | `not_found_error` | 404 |
| `IdempotencyError` | `idempotency_error` | 409 |
| `CallError` | `call_error` | 422 |
| `RateLimitError` | `rate_limit_error` | 429 (has `retryAfter` in seconds) |
| `APIError` | `api_error` | 5xx |
| `APIConnectionError` | `connection_error` | no response (`status` 0) |

Every error carries `type`, `code`, `message`, `param`, `requestId`, `status`, `docUrl` and, for insufficient credits, `billingUrl`. The SDK adds two codes of its own, both on `APIError`: `invalid_response` for a 2xx whose body is not JSON, and `pagination_stalled` if the API ever returns the same cursor twice. If your `accessToken` or `apiKey` callback throws, the SDK rethrows your error unchanged. Branch on `code` for specific conditions. Messages are safe to show to end users. Quote `requestId` when you contact support.

```ts
import { AuthenticationError, RateLimitError, VoixCallError } from '@voixcall/sdk';

try {
  await voixcall.calls.get('call_123');
} catch (err) {
  if (err instanceof AuthenticationError) {
    // key revoked or token expired: re-authenticate
  } else if (err instanceof RateLimitError) {
    console.log(`retry in ${err.retryAfter}s`);
  } else if (err instanceof VoixCallError) {
    console.error(err.code, err.message, err.requestId, err.docUrl);
  } else {
    throw err;
  }
}
```

The full error catalogue is at https://voixcall.com/developers/errors.

## Retries

The SDK retries up to 2 times (configurable with `maxRetries`):

- `429` and `503` for any method, waiting for `Retry-After` when the server sends it, otherwise with exponential backoff from 0.5 s. Each wait gets up to 25% random jitter, and no wait is longer than `maxRetryDelaySeconds`.
- `502`, `504`, network failures and timeouts for `GET` only, because the request may already have run.

Other statuses (`400`, `401`, `403`, `404`, `409`, `500` and so on) are never retried.

## Idempotency

Every `POST` gets an `Idempotency-Key` (a random UUID v4) unless you pass one with `{ idempotencyKey }`. The same key is reused on retries, so a retried request cannot run twice. Pass your own key when you retry an operation yourself across process restarts.

## Test mode

Keys that start with `vc_test_` work on a separate test-mode partition: a test balance and no real calls. Objects carry `livemode: false`. Use them in development and CI. Test keys are rejected by the MCP endpoint.

## Versioning

The API is versioned by date with the `VoixCall-Version` header. The SDK sends the version it was generated for, so a new API version does not change behaviour until you upgrade the SDK or set `version` yourself. New fields and enum values are additive; code should tolerate them.

## Development

`openapi.json` is the API's own OpenAPI document, downloaded from https://api.voixcall.com/v1/openapi.json. `src/gen` is generated from it with Hey API. Neither is edited by hand; the hand-written wrapper is the rest of `src/`.

```sh
npm ci
npm run fetch-spec     # download and validate the live spec into openapi.json (deterministic formatting)
npm run generate       # regenerate src/gen from the committed openapi.json
npm run regen          # both
npm run typecheck && npm test && npm run build
npm run check:runtime  # exercises the built package offline
npm run smoke          # calls production with a fake key; expects AuthenticationError 401
                       # and checks the API's default version equals API_VERSION
```

### CI

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

- **Generated code is up to date**: regenerates `src/gen` from the committed `openapi.json` and fails on any diff. It never fetches the live spec, so pull requests do not depend on the network or on API deploys. Make it a required check.
- **Typecheck, test, build** on Node 22 and 24, the offline runtime check of the built package, and `npm pack --dry-run`.

Dependabot (`.github/dependabot.yml`) proposes weekly updates for the pinned GitHub Actions and for npm, with the dev dependencies grouped into one PR.

### How the spec sync works

`.github/workflows/spec-sync.yml` runs daily at 03:17 UTC and on demand (Actions -> spec-sync -> Run workflow). It has two jobs, so no npm, generator or test code runs with write access:

- `regen` (read-only) runs `npm run regen`, then typecheck and tests against the new spec (non-blocking), and checks that the live API's default `VoixCall-Version` equals the SDK's `API_VERSION` (reported as `unknown`, not a failure, if the API can't be reached). It uploads `openapi.json` and `src/gen` as an artifact.
- `pr` (the only job with `contents: write` and `pull-requests: write`) checks out, downloads that artifact to a temporary directory outside the workspace, refuses it if it holds a symlink or anything besides `openapi.json` and `src/gen`, copies exactly those two into place and, if anything changed, opens a pull request from the `spec-sync` branch or updates the one already open. It runs no npm or node steps.

The PR body reports the typecheck/test outcome and the version check.

That PR is opened with the built-in `GITHUB_TOKEN`, and **GitHub does not start other workflows for events caused by `GITHUB_TOKEN`**, so CI does not run on it by itself. Before merging a spec-sync PR, run the `ci` workflow on the `spec-sync` branch (Actions -> ci -> Run workflow -> `spec-sync`) or close and reopen the PR, and wait for the checks to pass. If the change is user-visible, update the wrapper and README in the same PR.

The workflow needs Settings -> Actions -> General -> **Allow GitHub Actions to create and approve pull requests** (on the repository, and on the organization if it is controlled there).

### Releasing

Releases are currently published **manually** by a maintainer:

1. Bump `version` in `package.json` and `SDK_VERSION` in `src/version.ts` (a test keeps them equal) in a pull request, and merge it.
2. From an up-to-date `main`: `npm publish`. The `prepublishOnly` script runs typecheck, tests and the build first, so a failing check stops the release.
3. Check it: `npm view @voixcall/sdk version`.

Do **not** push `v*` tags for now. `.github/workflows/release.yml` (tag-triggered CI publish from the protected `npm` environment, with `--ignore-scripts`) is kept for a later switch to npm Trusted Publishing, which needs no stored token: configure the trusted publisher on npmjs.com (repository `VoixCall/voixcall-typescript`, workflow `release.yml`, environment `npm`), give the publish job `id-token: write`, and publish with npm 11.5.1 or later.

### Going public

- [x] Repository made public (2026-09-29), with secret scanning, push protection, private vulnerability reporting, required CI checks on `main` and a required reviewer on the `npm` environment.
- [x] `repository` added to `package.json` (shows on npm from the next release).
- [x] First release published (0.1.0, 2026-09-29).
- [ ] npm provenance: only issued when publishing from CI. Switch on with Trusted Publishing (see Releasing): use the commented-out Publish step in `release.yml` (adds `--provenance`) and uncomment `id-token: write`.

## Links

- Developer docs: https://voixcall.com/developers
- OpenAPI document: https://api.voixcall.com/v1/openapi.json
- Support: support@voixcall.com
- Security: see [SECURITY.md](SECURITY.md)
