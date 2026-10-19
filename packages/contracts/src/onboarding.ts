import { z } from 'zod';
import type { ProjectScope } from './advanced.js';
import type { SessionUser } from './index.js';
// 协议允许内测下限；生产环境的更高要求由服务端再次检查，并通过 options 下发给页面。
export const INTERNAL_PASSWORD_MIN = 6;
export const PRODUCTION_PASSWORD_MIN = 12;
export const changePasswordSchema = z
  .object({
    email: z.email().max(254),
    current_password: z.string().min(1, '请输入当前密码').max(200),
    new_password: z.string().min(INTERNAL_PASSWORD_MIN, '新密码至少 6 位').max(200),
  })
  .strict();
export const registerSchema = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1, '请输入你的名字').max(60),
    password: z.string().min(INTERNAL_PASSWORD_MIN, '密码至少 6 位').max(200),
  })
  .strict();
export const teamCreateSchema = z
  .object({
    name: z.string().trim().min(1, '请输入团队名称').max(100),
    project_name: z.string().trim().min(1, '请输入首个项目名称').max(100),
  })
  .strict();
export const teamTokenSchema = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, '请输入完整的团队邀请码或邀请链接'),
  })
  .strict();
export const teamInvitationSchema = z
  .object({
    email: z.email().max(254).optional(),
    expires_hours: z.number().int().min(1).max(168).default(24),
    max_uses: z.number().int().min(1).max(100).default(1),
  })
  .strict();
export interface AccountOverview {
  user: SessionUser;
  projects: ProjectScope[];
  workspaces: { id: string; name: string; role: string }[];
}
export interface TeamInvitationPreview {
  workspace: string;
  project: string;
  project_id: string;
  expires_at: string;
  remaining_uses: number;
  email_required: boolean;
}
export interface TeamInvitationRecord {
  id: string;
  email: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string;
  revoked_at: string | null;
}
