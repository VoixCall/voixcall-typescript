import { vi } from 'vitest';
import { VoixCall, type VoixCallOptions } from '../src/index.js';

export type Handler = (req: Request, n: number) => Response | Promise<Response>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Request-Id': 'req_hdr', ...headers },
  });

export const envelope = (type: string, code: string, extra: Record<string, unknown> = {}) => ({
  error: {
    type,
    code,
    message: `msg ${code}`,
    param: null,
    doc_url: `https://voixcall.com/developers/errors#${code}`,
    request_id: 'req_body',
    ...extra,
  },
});

/** A client with a mocked fetch that records every request, and no real sleeping. */
export function setup(handler: Handler, opts: Partial<VoixCallOptions> = {}) {
  const requests: Request[] = [];
  const sleeps: number[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push(req);
    return handler(req, requests.length);
  });
  const client = new VoixCall({
    apiKey: 'vc_test_abc',
    fetch: fetch as unknown as typeof globalThis.fetch,
    _retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 0 },
    ...opts,
  });
  return { client, requests, sleeps, fetch };
}

/** Awaits p, expecting it to reject; returns the rejection (typed loosely for field checks). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function caught(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected a rejection');
}
