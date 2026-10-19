import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  bigserial,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
// Drizzle is the typed schema reference; versioned SQL migrations are the deployable history.
export const users = pgTable('users', {
  id: text().primaryKey(),
  email: text().notNull().unique(),
  name: text().notNull(),
  password_hash: text().notNull(),
  role: text().notNull(),
  active: boolean().notNull().default(true),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
});
export const tasks = pgTable('tasks', {
  id: text().primaryKey(),
  conversation_id: text().notNull(),
  creator_id: text().notNull(),
  state: text().notNull(),
  input_version: integer().notNull().default(1),
  version: integer().notNull().default(1),
  input: jsonb().notNull(),
  snapshot: jsonb().notNull(),
  approval: jsonb(),
  attempt_id: text(),
  error_code: text(),
  created_at: timestamp({ withTimezone: true }).defaultNow(),
  updated_at: timestamp({ withTimezone: true }).defaultNow(),
});
export const executionEvents = pgTable(
  'execution_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    task_id: text().notNull(),
    attempt_id: text(),
    seq: integer(),
    type: text().notNull(),
    visibility: text().notNull(),
    payload: jsonb().notNull(),
    occurred_at: timestamp({ withTimezone: true }).defaultNow(),
  },
  (table) => [uniqueIndex('execution_event_seq').on(table.attempt_id, table.seq)],
);
