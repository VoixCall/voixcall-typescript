import { describe, expect, it } from 'vitest';
import { APIError, NotFoundError } from '../src/index.js';
import { envelope, json, setup } from './helpers.js';

const call = (i: number) => ({ id: `call_${i}`, object: 'call' });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

/** Serves 1..total newest first, honouring limit and starting_after / ending_before. */
function server(total: number, trimTo?: number) {
  return (req: Request) => {
    const u = new URL(req.url);
    const limit = Number(u.searchParams.get('limit') ?? 10);
    const after = u.searchParams.get('starting_after');
    const before = u.searchParams.get('ending_before');
    const all = Array.from({ length: total }, (_, i) => call(total - i)); // newest first
    let slice: ReturnType<typeof call>[];
    let hasMore: boolean;
    if (before) {
      const idx = all.findIndex((c) => c.id === before);
      const newer = all.slice(0, idx);
      slice = newer.slice(Math.max(0, newer.length - limit));
      hasMore = newer.length > limit;
    } else {
      const start = after ? all.findIndex((c) => c.id === after) + 1 : 0;
      slice = all.slice(start, start + limit);
      hasMore = start + limit < all.length;
    }
    // Emulate the 32 KB cap: fewer objects than asked, has_more forced true.
    if (trimTo !== undefined && slice.length > trimTo) {
      slice = slice.slice(0, trimTo);
      hasMore = true;
    }
    return json(200, { object: 'list', data: slice, has_more: hasMore });
  };
}

describe('pagination', () => {
  it('awaiting a list returns one page', async () => {
    const { client, requests } = setup(server(25));
    const page = await client.calls.list({ limit: 10 });
    expect(page.object).toBe('list');
    expect(page.data).toHaveLength(10);
    expect(page.has_more).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('for await walks every page with starting_after', async () => {
    const { client, requests } = setup(server(25));
    const got: string[] = [];
    for await (const c of client.calls.list({ limit: 10, direction: 'outbound' })) got.push(c.id);
    expect(got).toEqual(Array.from({ length: 25 }, (_, i) => `call_${25 - i}`));
    expect(requests).toHaveLength(3);
    const q = requests.map((r) => new URL(r.url).searchParams);
    expect(q[1]!.get('starting_after')).toBe('call_16');
    expect(q[2]!.get('starting_after')).toBe('call_6');
    expect(q.every((p) => p.get('direction') === 'outbound')).toBe(true);
  });

  it('continues correctly when a 32 KB-trimmed page returns fewer items with has_more', async () => {
    const { client, requests } = setup(server(12, 3));
    const got = await client.calls.list({ limit: 10 }).toArray();
    expect(ids(got)).toEqual(Array.from({ length: 12 }, (_, i) => `call_${12 - i}`));
    // 3 per page because of the trim; the last page is trimmed too (3 of 3) and says has_more, then an empty page ends it.
    expect(new URL(requests[1]!.url).searchParams.get('starting_after')).toBe('call_10');
    expect(new Set(got.map((c) => c.id)).size).toBe(12);
  });

  it('walks backwards from ending_before', async () => {
    const { client, requests } = setup(server(10));
    const got = await client.calls.list({ limit: 3, ending_before: 'call_3' }).toArray();
    expect(ids(got)).toEqual(['call_6', 'call_5', 'call_4', 'call_9', 'call_8', 'call_7', 'call_10']);
    expect(new URL(requests[1]!.url).searchParams.get('ending_before')).toBe('call_6');
    expect(new URL(requests[1]!.url).searchParams.get('starting_after')).toBeNull();
  });

  it('stops on an empty page even if has_more is true, and on null data', async () => {
    const { client, requests } = setup(() => json(200, { object: 'list', data: null, has_more: true }));
    expect(await client.numbers.list().toArray()).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('toArray respects max', async () => {
    const { client, requests } = setup(server(50));
    const got = await client.credits.transactions.list({ limit: 10 }).toArray(15);
    expect(got).toHaveLength(15);
    expect(requests).toHaveLength(2);
  });

  it('keeps the search query across pages', async () => {
    const { client, requests } = setup(server(4));
    await client.contacts.search({ q: 'ann', limit: 2 }).toArray();
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => new URL(r.url).searchParams.get('q') === 'ann')).toBe(true);
  });

  it('throws a typed error mid-iteration', async () => {
    const { client } = setup((req) =>
      new URL(req.url).searchParams.get('starting_after') ? json(404, envelope('not_found_error', 'resource_missing')) : server(20)(req),
    );
    const it = client.calls.list({ limit: 10 })[Symbol.asyncIterator]();
    for (let i = 0; i < 10; i++) await it.next();
    await expect(it.next()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws instead of looping when the server repeats the cursor', async () => {
    const { client, requests } = setup(() => json(200, { object: 'list', data: [call(5)], has_more: true }));
    const err = await client.calls.list().toArray().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).code).toBe('pagination_stalled');
    expect(requests).toHaveLength(2);
  });

  it('throws when the first page ends on the cursor it started from', async () => {
    const { client, requests } = setup(() => json(200, { object: 'list', data: [call(5)], has_more: true }));
    await expect(client.calls.list({ starting_after: 'call_5' }).toArray()).rejects.toBeInstanceOf(APIError);
    expect(requests).toHaveLength(1);
  });

  it('throws on a two-page cycle (A -> B -> A)', async () => {
    const { client, requests } = setup((req) => {
      const after = new URL(req.url).searchParams.get('starting_after');
      // Page 1 ends at call_a; after call_a the server returns call_b; after call_b it returns call_a again.
      const data = after === 'call_a' ? [{ id: 'call_b' }] : [{ id: 'call_a' }];
      return json(200, { object: 'list', data, has_more: true });
    });
    const err = await client.calls.list().toArray().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect((err as APIError).code).toBe('pagination_stalled');
    expect(requests).toHaveLength(3);
  });
});
