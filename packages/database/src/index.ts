import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import * as schema from './schema/index.js';
import { acquireLocalDatabaseLock } from './local-lock.js';

export type Row = Record<string, any>;
export interface SqlConnection {
  query<T extends Row = Row>(text: string, values?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
}
export interface Database extends SqlConnection {
  mode: 'postgresql' | 'pglite';
  transaction<T>(work: (tx: SqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

async function migrate(db: Database, projectRoot: string) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum TEXT)',
  );
  // Existing prototype databases predate checksums. Record their baseline once.
  await db.exec('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
  const directory = resolve(projectRoot, 'packages/database/migrations');
  const files = (await readdir(directory))
    .filter((name) => /^\d{4}-[a-z0-9-]+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    const version = file.slice(0, -4),
      sql = await readFile(resolve(directory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await db.transaction(async (tx) => {
      const applied = (
        await tx.query('SELECT checksum FROM schema_migrations WHERE version=$1 FOR UPDATE', [
          version,
        ])
      )[0];
      if (applied?.checksum && applied.checksum !== checksum)
        throw new Error('APPLIED_MIGRATION_CHANGED: ' + version);
      if (!applied) {
        // exec preserves SQL strings and procedural blocks containing semicolons.
        await tx.exec(sql);
        await tx.query(
          'INSERT INTO schema_migrations(version,checksum) VALUES($1,$2) ON CONFLICT(version) DO UPDATE SET checksum=excluded.checksum',
          [version, checksum],
        );
      } else if (!applied.checksum) {
        await tx.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
          checksum,
          version,
        ]);
      }
    });
  }
}

export async function createDatabase(options: {
  url?: string;
  dataDir: string;
  projectRoot: string;
  schema?: string;
}): Promise<Database> {
  let db: Database;
  if (options.url) {
    if (options.schema && !/^scope_prj_[a-zA-Z0-9]+$/.test(options.schema))
      throw new Error('INVALID_DATABASE_SCHEMA');
    if (options.schema) {
      const admin = new pg.Pool({ connectionString: options.url, max: 1 });
      try {
        await admin.query('CREATE SCHEMA IF NOT EXISTS "' + options.schema + '"');
      } finally {
        await admin.end();
      }
    }
    // 通过连接级 search_path 隔离项目，事务和普通查询都使用相同命名空间。
    const pool = new pg.Pool({
      connectionString: options.url,
      max: 5,
      ...(options.schema ? { options: '-c search_path=' + options.schema } : {}),
    });
    const connection = (client: pg.Pool | pg.PoolClient): SqlConnection => ({
      query: async <T extends Row>(text: string, values: unknown[] = []) =>
        (await client.query(text, values)).rows as T[],
      exec: async (text) => {
        await client.query(text);
      },
    });
    const orm = drizzlePg(pool, { schema });
    db = {
      ...connection(pool),
      mode: 'postgresql',
      transaction: async (work) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(connection(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
      close: async () => {
        await pool.end();
      },
    };
    void orm; // Explicit SQL locks express the authorization/state transactions; schema remains typed.
  } else {
    await mkdir(options.dataDir, { recursive: true });
    const release = acquireLocalDatabaseLock(options.dataDir);
    let client: PGlite;
    try {
      client = new PGlite(resolve(options.dataDir, 'postgres'));
      await client.waitReady;
    } catch (error) {
      release();
      throw error;
    }
    const orm = drizzlePglite(client, { schema });
    db = {
      mode: 'pglite',
      query: async <T extends Row>(text: string, values: unknown[] = []) =>
        (await client.query<T>(text, values)).rows,
      exec: async (text) => {
        await client.exec(text);
      },
      transaction: async (work) =>
        client.transaction(async (tx) =>
          work({
            query: async <T extends Row>(text: string, values: unknown[] = []) =>
              (await tx.query<T>(text, values)).rows,
            exec: async (text) => {
              await tx.exec(text);
            },
          }),
        ),
      close: async () => {
        try {
          await client.close();
        } finally {
          release();
        }
      },
    };
    void orm;
  }
  try {
    await migrate(db, options.projectRoot);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}

export { openInspectionDatabase } from './inspection.js';
