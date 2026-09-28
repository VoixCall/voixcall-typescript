import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/fetch-spec.mjs', import.meta.url));
const valid = { openapi: '3.1.0', info: { title: 't', version: '1' }, paths: { '/me': { get: {} } }, components: { schemas: { Me: { type: 'object' } } } };

let body = '';
let status = 200;
let server: Server;
let url = '';

beforeAll(async () => {
  server = createServer((_, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openapi.json`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(served: string, code = 200): Promise<{ exit: number; file: string; stderr: string }> {
  body = served;
  status = code;
  const out = join(mkdtempSync(join(tmpdir(), 'fetch-spec-')), 'openapi.json');
  writeFileSync(out, 'SENTINEL');
  return new Promise((resolve) => {
    execFile(process.execPath, [script, url, out], (err, _stdout, stderr) => {
      resolve({ exit: err ? ((err as { code?: number }).code ?? 1) : 0, file: readFileSync(out, 'utf8'), stderr });
    });
  });
}

describe('scripts/fetch-spec.mjs', () => {
  it('writes the document with a 2-space indent and a trailing newline, keys in served order', async () => {
    const r = await run(JSON.stringify(valid));
    expect(r.exit).toBe(0);
    expect(r.file).toBe(JSON.stringify(valid, null, 2) + '\n');
  });

  it.each([
    ['paths is null', { ...valid, paths: null }],
    ['paths is an array', { ...valid, paths: [] }],
    ['paths is empty', { ...valid, paths: {} }],
    ['components.schemas is missing', { ...valid, components: {} }],
    ['openapi is missing', { paths: valid.paths, components: valid.components }],
  ])('rejects a document where %s and leaves the file untouched', async (_, doc) => {
    const r = await run(JSON.stringify(doc));
    expect(r.exit).toBe(1);
    expect(r.file).toBe('SENTINEL');
  });

  it('rejects a non-JSON body and an error status, leaving the file untouched', async () => {
    expect((await run('<html>')).file).toBe('SENTINEL');
    const r = await run(JSON.stringify(valid), 503);
    expect(r.exit).toBe(1);
    expect(r.file).toBe('SENTINEL');
  });
});
