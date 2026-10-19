import type { SqlConnection, Row } from '@team-agent/database';
import { z, type PageInfo, type PageRequest, type PageResult } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
export function pageRequest(query: Record<string, unknown>): PageRequest {
  return z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().min(1).max(2048).optional(),
    })
    .parse(query);
}
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string(),
    id: z.string().min(1).max(100),
    at: z.iso.datetime({ precision: 6 }).optional(),
  })
  .strict();
function cursor(value: string | undefined, scope: string) {
  if (!value) return undefined;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const result = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (result.scope !== scope) throw new Error();
    return result;
  } catch {
    throw new DomainError('INVALID_CURSOR', '分页位置无效或不属于当前查询', 400);
  }
}
function result<T>(
  rows: Row[],
  request: PageRequest,
  scope: string,
  idKey: string,
  hasTime: boolean,
): PageResult<T> {
  const hasMore = rows.length > request.limit,
    items = rows.slice(0, request.limit);
  const last = items.at(-1),
    pagination: PageInfo = {
      limit: request.limit,
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                scope,
                id: String(last[idKey]),
                ...(hasTime ? { at: last._cursor_at } : {}),
              }),
            ).toString('base64url')
          : null,
    };
  return { items: items.map(({ _cursor_at, ...row }) => row as T), pagination };
}
/** SQL fragments are server-owned query definitions, never request fields. */
export async function createdPage<T>(
  db: SqlConnection,
  request: PageRequest,
  spec: {
    scope: string;
    from: string;
    columns: string;
    where?: string;
    params?: unknown[];
    id?: string;
    time?: string;
  },
): Promise<PageResult<T>> {
  const position = cursor(request.cursor, spec.scope),
    params = [...(spec.params || [])];
  const id = spec.id || 'id',
    time = spec.time || 'created_at';
  let boundary = '';
  if (position) {
    if (!position.at) throw new DomainError('INVALID_CURSOR', '分页位置缺少时间', 400);
    params.push(position.at, position.id);
    boundary =
      ' AND (' +
      time +
      ',' +
      id +
      ') < ($' +
      (params.length - 1) +
      '::timestamptz,$' +
      params.length +
      ')';
  }
  params.push(request.limit + 1);
  // JS Date loses PostgreSQL microseconds; cursor timestamps retain the database precision.
  const rows = await db.query(
    'SELECT ' +
      spec.columns +
      ',to_char(' +
      time +
      ' AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS _cursor_at FROM ' +
      spec.from +
      ' WHERE ' +
      (spec.where || 'true') +
      boundary +
      ' ORDER BY ' +
      time +
      ' DESC,' +
      id +
      ' DESC LIMIT $' +
      params.length,
    params,
  );
  return result<T>(rows, request, spec.scope, 'id', true);
}
export async function sequencePage<T>(
  db: SqlConnection,
  request: PageRequest,
  spec: {
    scope: string;
    from: string;
    columns: string;
    sequence: string;
    where?: string;
    params?: unknown[];
  },
): Promise<PageResult<T>> {
  const position = cursor(request.cursor, spec.scope),
    params = [...(spec.params || [])];
  if (
    position &&
    (!/^\d+$/.test(position.id) || BigInt(position.id) > 9223372036854775807n || position.at)
  )
    throw new DomainError('INVALID_CURSOR', '分页序号无效', 400);
  let boundary = '';
  if (position) {
    params.push(position.id);
    boundary = ' AND ' + spec.sequence + ' < $' + params.length + '::bigint';
  }
  params.push(request.limit + 1);
  const rows = await db.query(
    'SELECT ' +
      spec.columns +
      ',' +
      spec.sequence +
      '::text AS _sequence_cursor FROM ' +
      spec.from +
      ' WHERE ' +
      (spec.where || 'true') +
      boundary +
      ' ORDER BY ' +
      spec.sequence +
      ' DESC LIMIT $' +
      params.length,
    params,
  );
  const page = result<T>(rows, request, spec.scope, '_sequence_cursor', false);
  page.items = page.items.map(({ _sequence_cursor, ...row }: any) => row as T);
  return page;
}
