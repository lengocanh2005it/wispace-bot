import {
  fullPageAsMappingPage,
  iterateMappingPages,
  type MappingPage,
  type MappingPageSource,
} from './paging.utils';

type Row = { id: string; userId: number };

const row = (id: number): Row => ({ id: String(id), userId: id });

/** A source that hands back the given pages in order, then empty pages. */
const sourceOf = <TCursor>(
  pages: MappingPage<Row, TCursor>[],
): MappingPageSource<Row, TCursor> & {
  calls: Array<[TCursor | undefined, number]>;
} => {
  const queue = [...pages];
  const calls: Array<[TCursor | undefined, number]> = [];
  return {
    calls,
    fetch: jest.fn((cursor: TCursor | undefined, limit: number) => {
      calls.push([cursor, limit]);
      return Promise.resolve(queue.shift() ?? { items: [] });
    }),
  };
};

describe('iterateMappingPages', () => {
  it('does not invoke the page handler for an empty page', async () => {
    const source = sourceOf([{ items: [] }]);
    const onPage = jest.fn();

    await iterateMappingPages({ source, limit: 200, onPage });

    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(onPage).not.toHaveBeenCalled();
  });

  it('runs a single page that declares no continuation', async () => {
    const source = sourceOf([{ items: [row(1), row(2)] }]);
    const onPage = jest.fn();

    await iterateMappingPages({ source, limit: 200, onPage });

    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith([row(1), row(2)]);
  });

  it('resumes from the continuation the previous page declared', async () => {
    const source = sourceOf([
      { items: [row(1)], nextId: '1' },
      { items: [row(2)], nextId: '2' },
      { items: [row(3)] },
    ]);
    const onPage = jest.fn();

    await iterateMappingPages({ source, limit: 100, onPage });

    expect(source.calls).toEqual([
      [undefined, 100],
      ['1', 100],
      ['2', 100],
    ]);
    expect(onPage).toHaveBeenCalledTimes(3);
  });

  it('pays one confirming fetch when a source keeps declaring a continuation', async () => {
    // A source whose last full page still carries a continuation cannot prove
    // it was the last one, so the scan ends on the empty fetch instead.
    const source = sourceOf([
      { items: [row(1), row(2)], nextId: '2' },
      { items: [], nextId: undefined },
    ]);
    const onPage = jest.fn();

    await iterateMappingPages({ source, limit: 2, onPage });

    expect(source.fetch).toHaveBeenCalledTimes(2);
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it('stops as soon as the page handler asks to stop', async () => {
    const source = sourceOf([
      { items: [row(1)], nextId: '1' },
      { items: [row(2)], nextId: '2' },
      { items: [row(3)] },
    ]);
    const onPage = jest.fn().mockReturnValue('stop');

    await iterateMappingPages({ source, limit: 100, onPage });

    expect(source.fetch).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledTimes(1);
  });

  it('waits for an asynchronous page handler before fetching the next page', async () => {
    const order: string[] = [];
    const source: MappingPageSource<Row, string> = {
      fetch: jest.fn((cursor: string | undefined) => {
        order.push(cursor === undefined ? 'fetch-1' : 'fetch-2');
        return Promise.resolve(
          cursor === undefined
            ? { items: [row(1)], nextId: '1' }
            : { items: [row(2)] },
        );
      }),
    };

    await iterateMappingPages({
      source,
      limit: 100,
      onPage: async (items) => {
        order.push(`handle-start-${items[0]!.id}`);
        await Promise.resolve();
        order.push(`handle-end-${items[0]!.id}`);
      },
    });

    // The next page must not be requested while the current one is still
    // being handled, or a scan would overlap its own pages.
    expect(order).toEqual([
      'fetch-1',
      'handle-start-1',
      'handle-end-1',
      'fetch-2',
      'handle-start-2',
      'handle-end-2',
    ]);
  });

  it('propagates a rejected fetch instead of ending the scan quietly', async () => {
    const source = sourceOf([{ items: [row(1)], nextId: '1' }]);
    const onPage = jest.fn();
    source.fetch = jest.fn().mockRejectedValue(new Error('page unavailable'));

    await expect(
      iterateMappingPages({ source, limit: 100, onPage }),
    ).rejects.toThrow('page unavailable');

    expect(onPage).not.toHaveBeenCalled();
  });

  it('propagates a rejected page handler', async () => {
    const source = sourceOf([{ items: [row(1)], nextId: '1' }]);

    await expect(
      iterateMappingPages({
        source,
        limit: 100,
        onPage: () => {
          throw new Error('handler blew up');
        },
      }),
    ).rejects.toThrow('handler blew up');
  });

  it('keeps a numeric cursor numeric rather than parsing it', async () => {
    const source = sourceOf([
      { items: [row(1)], nextId: 500 },
      { items: [row(2)] },
    ]);
    const onPage = jest.fn();

    await iterateMappingPages({ source, limit: 500, onPage });

    expect(source.calls).toEqual([
      [undefined, 500],
      [500, 500],
    ]);
  });
});

describe('fullPageAsMappingPage', () => {
  it('declares a continuation when the page was filled to its limit', () => {
    const page = fullPageAsMappingPage([row(1), row(2)], 2);

    expect(page.nextId).toBe('2');
  });

  it('declares no continuation for a short page', () => {
    const page = fullPageAsMappingPage([row(1)], 2);

    // A short page proves the source is exhausted. That is a fact, not an
    // inference from a count.
    expect(page.nextId).toBeUndefined();
    expect('nextId' in page).toBe(false);
  });

  it('declares no continuation for an empty page', () => {
    expect(fullPageAsMappingPage([], 2).nextId).toBeUndefined();
  });

  it('keeps a numeric id numeric', () => {
    const page = fullPageAsMappingPage([{ id: 1 }, { id: 500 }], 2);

    expect(page.nextId).toBe(500);
  });
});
