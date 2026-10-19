import { z } from 'zod';
import type {
  Device,
  Message,
  SessionUser,
  SourceSummary,
  Memory,
  Task,
  TaskState,
} from './index.js';
export interface Mention {
  type: 'agent' | 'member';
  target_id: string;
  start: number;
  end: number;
  label: string;
}
export interface Group {
  id: string;
  title: string;
  description: string;
  visibility: 'project' | 'public' | 'private';
  created_by: string;
  created_at: string;
  archived_at?: string | null;
  manager_id?: string | null;
  manager_active?: boolean;
  agent_policy?: import('./advanced.js').GroupAgentPolicy;
  unread_count?: number;
  observed_seq: number;
  joined: boolean;
  member_count: number;
  latest_message: string;
  latest_seq: number;
}
export interface GroupMember {
  id: string;
  name: string;
  role: string;
}
export type GoalState =
  | 'CANDIDATE'
  | 'CLARIFYING'
  | 'APPROVED'
  | 'CLAIMED'
  | 'REJECTED'
  | 'STOPPING'
  | 'STOPPED'
  | 'COMPLETED'
  | 'FAILED';
export interface Goal {
  id: string;
  conversation_id: string;
  message_id: string | null;
  title: string;
  constraints: string[];
  acceptance: string[];
  state: GoalState;
  decision: 'APPROVE' | 'REJECT' | 'STOP' | null;
  reason: string;
  related_goal_id: string | null;
  task_id: string | null;
  claimed_by: string | null;
  assignee_name: string | null;
  version: number;
  engine: 'rules' | 'model';
  created_at: string;
  updated_at: string;
  task_state: TaskState | null;
  related?: { id: string; title: string } | null;
  restricted_relation?: boolean;
}
export interface NodePolicy {
  enabled: boolean;
  repository_id: string;
  allow_edit: boolean;
  wall_time_seconds: number;
  max_model_calls: number;
}
export interface ChatBootstrap {
  user: SessionUser;
  project: { id: string; name: string; workspace: string; workspace_id?: string };
  groups: Group[];
  devices: Device[];
  policy: NodePolicy;
  policy_version: number;
  coordinator: { engine: 'rules' | 'model'; model_configured: boolean };
  leadership?: { node_id: string | null; epoch: number; lease_until: string | null };
  sources: SourceSummary[];
  memories: Memory[];
}
export interface GroupFeed {
  messages: Message[];
  next_before: number | null;
  goals: Goal[];
  members: GroupMember[];
  observed_seq: number;
  jobs_pending: number;
  jobs_failed: number;
}
export interface GoalDetail {
  goal: Goal;
  events: { id: number; kind: string; detail: Record<string, unknown>; created_at: string }[];
  task: Task | null;
}
export const groupSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).default(''),
    visibility: z.enum(['public', 'private']).default('public'),
  })
  .strict();
export const chatMessageSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1)
      .max(16000)
      .refine((v) => new TextEncoder().encode(v).byteLength <= 16384, '单条消息最多 16 KiB UTF-8'),
    client_message_id: z.string().min(8).max(100),
    mentions: z
      .array(
        z
          .object({
            type: z.enum(['agent', 'member']),
            target_id: z.string().max(100),
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            label: z.string().max(100),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    invoke_agent: z.boolean().default(false),
    source_refs: z
      .array(
        z.object({ source_id: z.string().max(100), version: z.number().int().positive() }).strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export const policySchema = z
  .object({
    enabled: z.boolean(),
    repository_id: z.string().max(100),
    allow_edit: z.boolean(),
    wall_time_seconds: z.number().int().min(10).max(900),
    max_model_calls: z.number().int().min(1).max(20),
    expected_version: z.number().int().positive(),
  })
  .strict();
export const goalReviewSchema = z
  .object({
    title: z.string().trim().min(4).max(2000),
    constraints: z.array(z.string().min(1).max(500)).max(20),
    acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
    reason: z.string().trim().min(1).max(1000),
    expected_version: z.number().int().positive(),
  })
  .strict();
