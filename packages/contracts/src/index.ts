import { z } from 'zod';
export * from './chat.js';
export * from './advanced.js';

export const taskStates = [
  'DRAFT',
  'PENDING_APPROVAL',
  'REJECTED',
  'QUEUED',
  'DISPATCHING',
  'RUNNING',
  'CANCEL_REQUESTED',
  'RECONCILING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;
export type TaskState = (typeof taskStates)[number];
export type Role = 'OWNER' | 'MEMBER';
export type Visibility = 'shared' | 'owner';
export type Capability = 'file_read' | 'file_search' | 'file_edit';
export type RuntimeKind = 'pi' | 'inspection';
export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}
export interface WorkspaceMember extends User {
  active: boolean;
}
export interface SessionUser extends User {
  csrf: string;
  session_id: string;
}
export interface Conversation {
  id: string;
  title: string;
  created_by: string;
  created_at: string;
}
export interface Message {
  id: string;
  conversation_id: string;
  seq: number;
  author_id: string;
  author_name: string;
  body: string;
  mentions?: import('./chat.js').Mention[];
  created_at: string;
}
export interface Source {
  id: string;
  name: string;
  visibility: Visibility;
  version: number;
  content: string;
  content_hash: string;
}
export interface SourceSummary extends Omit<Source, 'content'> {
  preview: string;
  character_count: number;
}
export interface PageRequest {
  limit: number;
  cursor?: string;
}
export interface PageInfo {
  limit: number;
  has_more: boolean;
  next_cursor: string | null;
}
export interface PageResult<T> {
  items: T[];
  pagination: PageInfo;
}
export interface TaskStats {
  total: number;
  pending: number;
  active: number;
  succeeded: number;
}
export type TaskSummary = Pick<
  Task,
  | 'id'
  | 'creator_id'
  | 'creator_name'
  | 'state'
  | 'input_version'
  | 'version'
  | 'input'
  | 'attempt_id'
  | 'error_code'
  | 'created_at'
  | 'updated_at'
>;
export interface SourceRef {
  source_id: string;
  version: number;
}
export interface Memory {
  id: string;
  title: string;
  content: string;
  status: 'candidate' | 'confirmed' | 'deprecated';
  source_refs: SourceRef[];
  created_by: string;
  confirmed_by: string | null;
  version: number;
}
export interface RepositoryBinding {
  id: string;
  name: string;
  base_commit: string;
  branch: string;
  capabilities: Capability[];
  write_prefixes?: string[];
}
export interface Device {
  id: string;
  name: string;
  status: 'online' | 'offline' | 'revoked';
  last_seen: string | null;
  runtime: RuntimeKind;
  adapter_version: string;
  repositories: RepositoryBinding[];
}
export interface ContextEvidence {
  is_excerpt?: boolean;
  id: string;
  kind: 'message' | 'source' | 'memory' | 'artifact';
  version: number;
  content: string;
  hash: string;
}
export interface ContextSnapshot {
  id: string;
  conversation_id: string;
  cutoff_seq: number;
  goal: string;
  constraints: string[];
  acceptance: string[];
  evidence: ContextEvidence[];
  recent_messages: Message[];
  historical_excerpts: { message_id: string; author_name: string; excerpt: string }[];
  compacted: boolean;
  omitted_message_ids: string[];
  model_input: string;
  hash: string;
}
export interface Budget {
  wall_time_seconds: number;
  max_model_calls: number;
}
export interface TaskInput {
  dependency_artifact_refs?: string[];
  allowed_write_prefixes?: string[];
  conversation_id: string;
  conversation_cutoff_seq?: number;
  goal: string;
  constraints: string[];
  acceptance: string[];
  source_refs: SourceRef[];
  memory_refs: { memory_id: string; version: number }[];
  repository_binding_id: string;
  base_commit: string;
  execution_profile: 'code_review' | 'code_edit';
  budget: Budget;
}
export interface Approval {
  policy_version?: number;
  id: string;
  approver_id: string;
  input_version: number;
  snapshot_hash: string;
  descriptor_hash: string;
  expires_at: string;
}
export interface Artifact {
  id: string;
  task_id: string;
  attempt_id: string;
  kind: 'report' | 'diff';
  title: string;
  content: string;
  published: boolean;
  created_at: string;
  purged_at?: string | null;
  content_hash?: string | null;
  content_bytes?: number | null;
}
export interface RetentionPreview {
  task_id: string;
  version: number;
  state: TaskState;
  enabled: boolean;
  retention_hold: boolean;
  retention_hold_reason: string | null;
  can_clean: boolean;
  raw_events: number;
  raw_event_bytes: number;
  private_artifacts: { id: string; title: string; kind: string; bytes: number }[];
  scope: string;
}
export interface Task {
  id: string;
  creator_id: string;
  creator_name: string;
  state: TaskState;
  input_version: number;
  version: number;
  input: TaskInput;
  snapshot: ContextSnapshot;
  approval: Approval | null;
  attempt_id: string | null;
  created_at: string;
  updated_at: string;
  artifacts: Artifact[];
  error_code: string | null;
  cancel_requested_by?: string;
  content_revision?: number;
  retention_hold?: boolean;
  retention_hold_reason?: string | null;
  approval_purged_at?: string | null;
}
export interface TaskEvent {
  id: number;
  task_id: string;
  attempt_id: string | null;
  seq: number | null;
  type: string;
  visibility: Visibility;
  payload: Record<string, unknown>;
  occurred_at: string;
}
export interface ExecutionDescriptor {
  leadership_epoch?: number;
  allowed_write_prefixes?: string[];
  task_id: string;
  attempt_id: string;
  device_id: string;
  input_version: number;
  repository_binding_id: string;
  base_commit: string;
  execution_profile: 'code_review' | 'code_edit';
  capabilities: Capability[];
  snapshot: ContextSnapshot;
  budget: Budget;
  result_audience: string;
}
export interface RuntimeEvent {
  type: string;
  visibility: Visibility;
  payload: Record<string, unknown>;
}
export interface ExecutionEvent extends RuntimeEvent {
  seq: number;
  occurred_at: string;
}
export interface ExecutionResult {
  status: 'succeeded' | 'cancelled' | 'failed';
  report: string;
  diff: string;
  error_code?: string;
  verification: 'not_run';
}
export interface Dispatch {
  type: 'dispatch';
  protocol_version: '1';
  descriptor: ExecutionDescriptor;
  descriptor_hash: string;
  start_permit: string;
}
export interface DeviceHello {
  type: 'hello';
  protocol_version: '1';
  runtime: RuntimeKind;
  adapter_version: string;
  active_attempts: { attempt_id: string; status: 'running' | 'uncertain' | 'stopped' }[];
}
export type BridgeToServer =
  | DeviceHello
  | { type: 'heartbeat' }
  | { type: 'started'; attempt_id: string }
  | { type: 'event_batch'; attempt_id: string; events: ExecutionEvent[] }
  | { type: 'finished'; attempt_id: string; result: ExecutionResult; stop_evidence: string }
  | { type: 'uncertain'; attempt_id: string; reason: string };
export type ServerToBridge =
  | Dispatch
  | { type: 'hello_ack'; device_id: string }
  | { type: 'ack'; attempt_id: string; seq: number }
  | { type: 'cancel'; attempt_id: string; reason: string }
  | { type: 'error'; code: string; message: string };
export interface Bootstrap {
  user: SessionUser;
  project: { id: string; name: string; workspace: string; database_mode: string };
  conversations: Conversation[];
  tasks: TaskSummary[];
  sources: SourceSummary[];
  pages: Record<'conversations' | 'tasks' | 'sources' | 'memories', PageInfo>;
  task_stats: TaskStats;
  memories: Memory[];
  devices: Device[];
}

export const idSchema = z.string().regex(/^[a-z][a-z0-9_-]{2,100}$/);
const text = z
  .string()
  .trim()
  .min(1)
  .max(16384)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 16384,
    '单条文本最多 16 KiB UTF-8',
  );
export const loginSchema = z
  .object({ email: z.email().max(254), password: z.string().min(1).max(200) })
  .strict();
export const inviteSchema = z.object({ email: z.email().max(254) }).strict();
export const acceptInviteSchema = z
  .object({
    token: z.string().min(32).max(200),
    name: z.string().trim().min(1).max(60),
    password: z.string().min(6, '密码至少 6 位').max(200),
  })
  .strict();
export const messageSchema = z
  .object({ body: text, client_message_id: z.string().min(8).max(100) })
  .strict();
export const sourceSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    content: z
      .string()
      .min(1)
      .max(10485760)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= 10485760,
        '资料最多 10 MiB UTF-8',
      ),
    visibility: z.enum(['shared', 'owner']).default('shared'),
  })
  .strict();
export const taskInputSchema: z.ZodType<TaskInput> = z
  .object({
    dependency_artifact_refs: z.array(idSchema).max(40).optional(),
    allowed_write_prefixes: z
      .array(
        z
          .string()
          .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
          .max(200),
      )
      .max(20)
      .optional(),
    conversation_id: idSchema,
    conversation_cutoff_seq: z.number().int().nonnegative().optional(),
    goal: z.string().trim().min(4).max(8000),
    constraints: z.array(z.string().min(1).max(2000)).max(30).default([]),
    acceptance: z.array(z.string().min(1).max(1000)).max(20).default([]),
    source_refs: z
      .array(z.object({ source_id: idSchema, version: z.number().int().positive() }).strict())
      .max(20)
      .default([]),
    memory_refs: z
      .array(z.object({ memory_id: idSchema, version: z.number().int().positive() }).strict())
      .max(20)
      .default([]),
    repository_binding_id: idSchema,
    base_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    execution_profile: z.enum(['code_review', 'code_edit']),
    budget: z
      .object({
        wall_time_seconds: z.number().int().min(10).max(1800),
        max_model_calls: z.number().int().min(1).max(60),
      })
      .strict()
      .default({ wall_time_seconds: 900, max_model_calls: 60 }),
  })
  .strict();
export const approveSchema = z
  .object({
    input_version: z.number().int().positive(),
    version: z.number().int().positive(),
    snapshot_hash: z.string().length(64),
  })
  .strict();
export const reasonSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export const memorySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    content: text,
    source_refs: z
      .array(z.object({ source_id: idSchema, version: z.number().int().positive() }))
      .max(20)
      .default([]),
  })
  .strict();
export const pairSchema = z
  .object({
    code: z.string().min(16).max(200),
    name: z.string().min(1).max(100),
    public_key: z.string().min(50).max(2000),
    runtime: z.enum(['pi', 'inspection']),
    adapter_version: z.string().max(80),
  })
  .strict();
export const repositoriesSchema = z
  .object({
    repositories: z
      .array(
        z
          .object({
            id: idSchema,
            name: z.string().min(1).max(100),
            base_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
            branch: z.string().max(200),
            capabilities: z.array(z.enum(['file_read', 'file_search', 'file_edit'])).max(3),
            write_prefixes: z
              .array(
                z
                  .string()
                  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
                  .max(200),
              )
              .max(20)
              .default([]),
          })
          .strict(),
      )
      .max(5),
  })
  .strict();
export const executionResultSchema = z
  .object({
    status: z.enum(['succeeded', 'cancelled', 'failed']),
    report: z.string().max(200000),
    diff: z.string().max(2000000),
    error_code: z.string().max(100).optional(),
    verification: z.literal('not_run'),
  })
  .strict();
export const bridgeMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocol_version: z.literal('1'),
      runtime: z.enum(['pi', 'inspection']),
      adapter_version: z.string().max(80),
      active_attempts: z
        .array(
          z.object({ attempt_id: idSchema, status: z.enum(['running', 'uncertain', 'stopped']) }),
        )
        .max(20),
    })
    .strict(),
  z.object({ type: z.literal('heartbeat') }).strict(),
  z.object({ type: z.literal('started'), attempt_id: idSchema }).strict(),
  z
    .object({
      type: z.literal('event_batch'),
      attempt_id: idSchema,
      events: z
        .array(
          z
            .object({
              seq: z.number().int().positive(),
              type: z.string().min(1).max(100),
              visibility: z.enum(['shared', 'owner']),
              payload: z.record(z.string(), z.unknown()),
              occurred_at: z.iso.datetime(),
            })
            .strict(),
        )
        .min(1)
        .max(40),
    })
    .strict(),
  z
    .object({
      type: z.literal('finished'),
      attempt_id: idSchema,
      result: executionResultSchema,
      stop_evidence: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({ type: z.literal('uncertain'), attempt_id: idSchema, reason: z.string().max(1000) })
    .strict(),
]);

export { z };

export * from './onboarding.js';
