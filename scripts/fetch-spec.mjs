// Download the live /v1 OpenAPI document and write it to openapi.json.
//
// Output is deterministic: JSON.parse keeps the key order as served, and the
// file is JSON.stringify with a 2-space indent plus a trailing newline. The
// same served document always produces the same bytes, so a diff means the
// API changed. Everything is validated and rendered before the file is
// written, so a failure never leaves a partial or bogus openapi.json.
//
// Usage: node scripts/fetch-spec.mjs [url] [outPath]
import { writeFile } from 'node:fs/promises';

const url = process.argv[2] || process.env.VOIXCALL_OPENAPI_URL || 'https://api.voixcall.com/v1/openapi.json';
const out = process.argv[3] ?? new URL('../openapi.json', import.meta.url);

const fail = (msg) => {
  console.error(`fetch-spec: ${msg}`);
  process.exit(1);
};
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

let res;
try {
  res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
} catch (err) {
  fail(`could not reach ${url}: ${err.message}`);
}
if (!res.ok) fail(`${url} answered ${res.status} (request id ${res.headers.get('Request-Id') ?? 'none'})`);

let doc;
try {
  doc = JSON.parse(await res.text());
} catch (err) {
  fail(`${url} did not return JSON: ${err.message}`);
}
if (!isObject(doc) || typeof doc.openapi !== 'string') fail(`${url} did not return an OpenAPI document`);
if (!isObject(doc.paths) || Object.keys(doc.paths).length === 0) fail(`${url}: "paths" must be an object with at least one path`);
if (!isObject(doc.components?.schemas)) fail(`${url}: "components.schemas" must be an object`);

const body = JSON.stringify(doc, null, 2) + '\n';
const summary = `fetch-spec: wrote openapi.json (OpenAPI ${doc.openapi}, ${Object.keys(doc.paths).length} paths, ${Object.keys(doc.components.schemas).length} schemas) from ${url}`;

await writeFile(out, body);
console.log(summary);
