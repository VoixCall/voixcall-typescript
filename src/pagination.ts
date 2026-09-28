import { APIError } from './errors.js';

/** A list page as the API returns it: `{ object: "list", data, has_more }`. */
export interface ListPage<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

/** Cursor parameters every list operation accepts. */
export interface ListParams {
  /** Page size, 1 to 100. Default 10. */
  limit?: number;
  /** Return objects older than this id. */
  starting_after?: string;
  /** Return objects newer than this id. */
  ending_before?: string;
}

type Fetcher<T, P> = (params: P) => Promise<ListPage<T>>;

/**
 * The result of a `list()` call. Await it for one page, or iterate it with
 * `for await` to walk every page:
 *
 *   const page = await client.calls.list({ limit: 20 });
 *   for await (const call of client.calls.list({ direction: 'outbound' })) { ... }
 *
 * Iteration follows `has_more` with `starting_after` = the last id of each
 * page (or `ending_before` = the first id when you started with
 * `ending_before`). The server may return fewer than `limit` objects with
 * `has_more: true` (pages are trimmed to 32 KB); iteration continues from
 * the last object it received, so nothing is skipped.
 */
export class PagePromise<T extends { id: string }, P extends ListParams>
  implements PromiseLike<ListPage<T>>, AsyncIterable<T>
{
  #first: Promise<ListPage<T>> | undefined;

  constructor(
    private readonly fetchPage: Fetcher<T, P>,
    private readonly params: P,
  ) {}

  #firstPage(): Promise<ListPage<T>> {
    this.#first ??= this.fetchPage(this.params);
    return this.#first;
  }

  then<R1 = ListPage<T>, R2 = never>(
    onfulfilled?: ((value: ListPage<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.#firstPage().then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<ListPage<T> | R> {
    return this.#firstPage().catch(onrejected);
  }

  /** Every page in turn, starting with the first. */
  async *pages(): AsyncGenerator<ListPage<T>, void, undefined> {
    const backwards = this.params.ending_before !== undefined;
    let page = await this.#firstPage();
    // Every cursor followed so far, including the one we started from. A
    // repeat (adjacent or an A -> B -> A cycle) would page forever.
    const seen = new Set<string>();
    const start = backwards ? this.params.ending_before : this.params.starting_after;
    if (start !== undefined) seen.add(start);
    for (;;) {
      yield page;
      if (!page.has_more || page.data.length === 0) return;
      const next: P = { ...this.params };
      const cursor = backwards ? page.data[0]!.id : page.data[page.data.length - 1]!.id;
      if (seen.has(cursor)) {
        throw new APIError({
          type: 'api_error',
          code: 'pagination_stalled',
          message: 'Pagination stopped: the API returned a cursor it had already returned.',
          status: 0,
        });
      }
      seen.add(cursor);
      if (backwards) {
        delete next.starting_after;
        next.ending_before = cursor;
      } else {
        delete next.ending_before;
        next.starting_after = cursor;
      }
      page = await this.fetchPage(next);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
    for await (const page of this.pages()) {
      yield* page.data;
    }
  }

  /** Collects up to `max` objects across pages (default 1000) into an array. */
  async toArray(max = 1000): Promise<T[]> {
    const out: T[] = [];
    if (max <= 0) return out;
    for await (const item of this) {
      out.push(item);
      if (out.length >= max) break;
    }
    return out;
  }
}
