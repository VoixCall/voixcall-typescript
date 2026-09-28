// Download the live /v1 OpenAPI document and write it to openapi.json.
//
// Output is deterministic: JSON.parse keeps the key order as served, and the
// file is JSON.stringify with a 2-space indent plus a trailing newline. The
// same served document always produces the same bytes, so a diff means the
// API changed.  Usage: node scripts/fetch-spec.mjs [url]
import { writeFile } from 'node:fs/promises';

const url = process.argv[2] ?? process.env.VOIXCALL_OPENAPI_URL ?? 'https://api.voixcall.com/v1/openapi.json';
const out = new URL('../openapi.json', import.meta.url);

const res = await fetch(url, {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(30_000),
});
if (!res.ok) {
  console.error(`fetch-spec: ${url} answered ${res.status} (request id ${res.headers.get('Request-Id') ?? 'none'})`);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(await res.text());
} catch (err) {
  console.error(`fetch-spec: ${url} did not return JSON: ${err.message}`);
  process.exit(1);
}
if (typeof doc !== 'object' || doc === null || typeof doc.openapi !== 'string' || typeof doc.paths !== 'object') {
  console.error(`fetch-spec: ${url} did not return an OpenAPI document`);
  process.exit(1);
}

await writeFile(out, JSON.stringify(doc, null, 2) + '\n');
console.log(`fetch-spec: wrote openapi.json (OpenAPI ${doc.openapi}, ${Object.keys(doc.paths).length} paths) from ${url}`);
