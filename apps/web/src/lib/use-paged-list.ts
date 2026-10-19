import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageInfo } from '@team-agent/contracts';
import { apiPage } from './api.js';

/** Reload the visible page span so filters and statuses remain authoritative while polling. */
export function usePagedList<T extends { id: string }>(
  path: string,
  enabled = true,
  prepend = false,
  pollMs = 4000,
) {
  const [items, setItems] = useState<T[]>([]),
    [page, setPage] = useState<PageInfo | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const depth = useRef(1),
    generation = useRef(0),
    pending = useRef<Promise<void> | null>(null);
  const fetchPages = useCallback(
    (pages: number): Promise<void> => {
      if (!enabled) return Promise.resolve();
      if (pending.current) return pending.current;
      const current = generation.current;
      setLoading(true);
      const operation = (async () => {
        try {
          let cursor: string | undefined,
            rows: T[] = [],
            info: PageInfo | null = null;
          for (let index = 0; index < pages; index++) {
            const result = await apiPage<T>(path, cursor);
            if (current !== generation.current) return;
            rows = prepend ? [...result.items, ...rows] : [...rows, ...result.items];
            info = result.pagination;
            if (!info.next_cursor) break;
            cursor = info.next_cursor;
          }
          if (current !== generation.current) return;
          setItems([...new Map(rows.map((row) => [row.id, row])).values()]);
          setPage(info);
          setError('');
        } catch (error: any) {
          if (current === generation.current) setError(error.message);
        } finally {
          if (current === generation.current) {
            setLoading(false);
            pending.current = null;
          }
        }
      })();
      pending.current = operation;
      return operation;
    },
    [path, enabled, prepend],
  );
  useEffect(() => {
    generation.current++;
    pending.current = null;
    depth.current = 1;
    setItems([]);
    setPage(null);
    setError('');
    if (enabled) void fetchPages(1);
    const timer =
      enabled && pollMs ? setInterval(() => void fetchPages(depth.current), pollMs) : undefined;
    return () => {
      generation.current++;
      if (timer) clearInterval(timer);
    };
  }, [fetchPages, enabled, pollMs]);
  const reload = useCallback(async () => {
    await pending.current;
    await fetchPages(depth.current);
  }, [fetchPages]);
  const more = useCallback(async () => {
    if (loading || !page?.has_more) return;
    depth.current++;
    await fetchPages(depth.current);
  }, [fetchPages, loading, page?.has_more]);
  return { items, page, loading, error, reload, more };
}
