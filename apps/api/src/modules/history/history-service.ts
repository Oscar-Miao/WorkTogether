import type { Database } from '@team-agent/database';
import {
  z,
  type Conversation,
  type SourceSummary,
  type Memory,
  type TaskSummary,
  type Message,
  type PageRequest,
  type TaskStats,
  type User,
} from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
import { createdPage, sequencePage } from '../../common/pagination.js';
import { iso, owner } from '../../common/security.js';
/** Polling/list endpoints never carry source bodies, snapshots or private artifacts. */
export class HistoryService {
  constructor(private readonly db: Database) {}
  async conversations(request: PageRequest, query?: unknown, user?: User) {
    const search = z.string().trim().max(100).default('').parse(query);
    const page = await createdPage<Conversation>(this.db, request, {
      scope: 'conversations:' + search.toLowerCase(),
      from: 'conversations',
      columns: '*',
      where:
        "(visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=conversations.id AND m.user_id=$1)) AND strpos(lower(title),lower($2))>0",
      params: [user?.id || '', search],
    });
    page.items = page.items.map((row) => ({ ...row, created_at: iso(row.created_at) }));
    return page;
  }
  async sources(user: User, request: PageRequest, visibility?: unknown) {
    const filter = z.enum(['shared', 'owner']).optional().parse(visibility);
    if (filter === 'owner') owner(user);
    return createdPage<SourceSummary>(this.db, request, {
      scope: 'sources:' + user.role + ':' + (filter || 'all'),
      from: 'sources s JOIN source_versions v ON v.source_id=s.id AND v.version=s.current_version',
      columns:
        's.id,s.name,s.visibility,v.version,v.content_hash,left(v.content,400) AS preview,char_length(v.content)::int AS character_count',
      where: "($1='OWNER' OR s.visibility='shared')" + (filter ? ' AND s.visibility=$2' : ''),
      params: filter ? [user.role, filter] : [user.role],
      id: 's.id',
      time: 's.created_at',
    });
  }
  async memories(request: PageRequest, status?: unknown) {
    const filter = z.enum(['candidate', 'confirmed', 'deprecated']).optional().parse(status);
    return createdPage<Memory>(this.db, request, {
      scope: 'memories:' + (filter || 'all'),
      from: 'memories',
      columns: '*',
      where: filter ? 'status=$1' : undefined,
      params: filter ? [filter] : [],
    });
  }
  async tasks(user: User, request: PageRequest, query: Record<string, unknown> = {}) {
    const filter = z.enum(['all', 'pending', 'running', 'done']).default('all').parse(query.state);
    const conversation = z
      .string()
      .regex(/^[a-z][a-z0-9_-]{2,100}$/)
      .optional()
      .parse(query.conversation_id);
    const states: Record<string, string[]> = {
      pending: ['PENDING_APPROVAL'],
      running: ['QUEUED', 'DISPATCHING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'],
      done: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'REJECTED', 'EXPIRED'],
    };
    const params: unknown[] = [],
      where: string[] = ['true'];
    if (states[filter]) {
      params.push(states[filter]);
      where.push('t.state=ANY($' + params.length + '::text[])');
    }
    if (conversation) {
      params.push(conversation);
      where.push('t.conversation_id=$' + params.length);
    }
    params.push(user.id);
    where.push(
      "(EXISTS(SELECT 1 FROM conversations c WHERE c.id=t.conversation_id AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$" +
        params.length +
        '))))',
    );
    const page = await createdPage<TaskSummary>(this.db, request, {
      scope: 'tasks:' + filter + ':' + (conversation || 'all'),
      from: 'tasks t JOIN users u ON u.id=t.creator_id',
      columns:
        't.id,t.creator_id,u.name AS creator_name,t.state,t.input_version,t.version,t.input,t.attempt_id,t.error_code,t.created_at,t.updated_at',
      where: where.join(' AND '),
      params,
      id: 't.id',
      time: 't.created_at',
    });
    page.items = page.items.map((row) => ({
      ...row,
      created_at: iso(row.created_at),
      updated_at: iso(row.updated_at),
    }));
    return page;
  }
  async messages(conversationId: string, request: PageRequest) {
    if (!(await this.db.query('SELECT id FROM conversations WHERE id=$1', [conversationId])).length)
      throw new DomainError('NOT_FOUND', '会话不存在', 404);
    const page = await sequencePage<Message>(this.db, request, {
      scope: 'messages:' + conversationId,
      from: 'messages m JOIN users u ON u.id=m.author_id',
      columns: 'm.*,u.name AS author_name',
      sequence: 'm.seq',
      where: 'm.conversation_id=$1',
      params: [conversationId],
    });
    page.items = page.items.reverse().map((row) => ({ ...row, created_at: iso(row.created_at) }));
    return page;
  }
  async audit(user: User, request: PageRequest) {
    owner(user);
    return sequencePage<Record<string, unknown>>(this.db, request, {
      scope: 'audit:owner',
      from: 'audit_logs',
      columns: '*',
      // 根审计兼存全站目录事件；项目维护者不得读取其他团队的身份和目录元信息。
      where: `NOT EXISTS(SELECT 1 FROM org_workspaces) OR (
        action NOT LIKE 'workspace.%' AND action NOT LIKE 'project.%' AND action NOT LIKE 'team.%'
        AND (action NOT IN ('account.registered','session.login') OR actor_id IN(SELECT id FROM project_users))
      ) OR (action LIKE 'team.invitation_%' AND detail->>'project_id'='project_default')`,
      sequence: 'id',
    });
  }
  async taskStats(user?: User): Promise<TaskStats> {
    const row = (
      await this.db.query(
        "SELECT count(*)::int AS total,count(*) FILTER(WHERE state='PENDING_APPROVAL')::int AS pending,count(*) FILTER(WHERE state IN ('QUEUED','DISPATCHING','RUNNING','CANCEL_REQUESTED','RECONCILING'))::int AS active,count(*) FILTER(WHERE state='SUCCEEDED')::int AS succeeded FROM tasks WHERE EXISTS(SELECT 1 FROM conversations c WHERE c.id=tasks.conversation_id AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)))",
        [user?.id || ''],
      )
    )[0];
    return row as TaskStats;
  }
}
