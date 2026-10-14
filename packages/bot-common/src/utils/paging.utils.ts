/**
 * One bounded walk over platform mappings, shared by every keyset-paged scan.
 *
 * A scan continues while a mapping page declares a continuation. It never
 * infers the last page from a page's length: `CONTEXT.md` names has-more
 * inference under `_Avoid_` for result completeness, and a page filled to its
 * limit is not thereby the last one. See docs/adr/0049-mapping-page-source-port.md.
 */

export type MappingPage<TItem, TCursor> = {
  items: TItem[];
  nextId?: TCursor;
};

export type MappingPageSource<TItem, TCursor> = {
  fetch(
    cursor: TCursor | undefined,
    limit: number,
  ): Promise<MappingPage<TItem, TCursor>>;
};

export type MappingPageHandler<TItem> = (
  items: TItem[],
) => void | Promise<void | 'stop'>;

/**
 * Wraps a bare `LIMIT n` read as a mapping page.
 *
 * A short page proves the source is exhausted, so it declares no continuation. A
 * full page proves nothing either way, so it declares one — which is a refusal
 * to claim exhaustion, not a claim that further records exist. The scan then
 * asks, and a full page that was in fact the last one costs one confirming
 * fetch.
 *
 * Size the page before any filtering: a page that filtering shortens is still
 * the page the source returned. See docs/adr/0049-mapping-page-source-port.md.
 */
export function fullPageAsMappingPage<TItem extends { id: unknown }>(
  items: TItem[],
  limit: number,
): MappingPage<TItem, TItem['id']> {
  return items.length === limit
    ? { items, nextId: items[items.length - 1]!.id }
    : { items };
}

export async function iterateMappingPages<TItem, TCursor>(options: {
  source: MappingPageSource<TItem, TCursor>;
  limit: number;
  onPage: MappingPageHandler<TItem>;
}): Promise<void> {
  const { source, limit, onPage } = options;
  let cursor: TCursor | undefined;

  for (;;) {
    const page = await source.fetch(cursor, limit);
    if (page.items.length === 0) {
      return;
    }
    if ((await onPage(page.items)) === 'stop') {
      return;
    }
    if (page.nextId === undefined) {
      return;
    }
    cursor = page.nextId;
  }
}
