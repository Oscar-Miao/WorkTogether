import { z } from 'zod';

export interface ProjectScope {
  id: string;
  name: string;
  workspace_id: string;
  workspace: string;
  role: 'admin' | 'operator' | 'member';
}
export interface GroupAgentPolicy {
  observe: boolean;
  muted: boolean;
  mode: 'passive' | 'observe';
}
export interface GoalRelation {
  id: string;
  source_id: string;
  target_id: string;
  kind: 'depends_on' | 'overlap' | 'same' | 'port' | 'supersedes';
  evidence: string;
  title: string;
  state: string;
}
export const relationSchema = z
  .object({
    target_id: z.string().min(1).max(100),
    kind: z.enum(['depends_on', 'overlap', 'same', 'port', 'supersedes']),
    evidence: z.string().trim().min(4).max(2000),
    expected_version: z.number().int().positive(),
    target_version: z.number().int().positive(),
  })
  .strict();
export const groupAgentPolicySchema = z
  .object({
    observe: z.boolean(),
    muted: z.boolean(),
    mode: z.enum(['passive', 'observe']),
  })
  .strict();
export const revisionSchema = z
  .object({
    title: z.string().trim().min(4).max(2000),
    constraints: z.array(z.string().min(1).max(500)).max(20),
    acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
    reason: z.string().trim().min(4).max(2000),
    expected_version: z.number().int().positive(),
  })
  .strict();
export const planSchema = z
  .object({
    expected_version: z.number().int().positive(),
    steps: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
            goal: z.string().min(4).max(2000),
            repository_id: z.string().min(1).max(100),
            dependencies: z.array(z.string().max(60)).max(20),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
