import type { Database, SqlConnection } from '@team-agent/database';
import type { Group, GroupFeed, GroupMember, User, Mention } from '@team-agent/contracts';
import { DomainError, extractMentions, canonical } from '@team-agent/domain';
import { ids, iso, sha, opaque, audit, idempotent } from '../../common/security.js';
import { requireGroupAccess } from '../../common/group-access.js';
import type { CoordinatorService } from './coordinator-service.js';
export class GroupService {
  constructor(
    private db: Database,
    private coordinator: CoordinatorService,
  ) {}
  async list(user: User, discover = false, offset = 0, q = ''): Promise<Group[]> {
    const rows = await this.db.query(
      `SELECT c.*, coalesce((SELECT active FROM users WHERE id=coalesce(c.manager_id,c.created_by)),false) AS manager_active, (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1)) AS joined,
  (SELECT count(*)::int FROM users u WHERE u.active AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=u.id))) AS member_count,
  coalesce((SELECT left(body,80) FROM messages WHERE conversation_id=c.id ORDER BY seq DESC LIMIT 1),'') AS latest_message,
  greatest(0,coalesce((SELECT max(seq) FROM messages WHERE conversation_id=c.id),0)-coalesce((SELECT seq FROM group_read_watermarks WHERE conversation_id=c.id AND user_id=$1),0))::int AS unread_count,
  coalesce((SELECT max(seq) FROM messages WHERE conversation_id=c.id),0) AS latest_seq
  FROM conversations c WHERE (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=c.id AND m.user_id=$1) OR ($2 AND c.visibility='public')) AND strpos(lower(c.title),lower($4))>0
  ORDER BY c.created_at DESC,c.id LIMIT 100 OFFSET $3`,
      [user.id, discover, offset, q],
    );
    return rows.map((r) => ({ ...r, created_at: iso(r.created_at) }) as Group);
  }
  async members(user: User, id: string, tx: SqlConnection = this.db): Promise<GroupMember[]> {
    const g = await requireGroupAccess(tx, user, id);
    return tx.query(
      "SELECT u.id,u.name,u.role FROM users u WHERE u.active AND ($2='project' OR EXISTS(SELECT 1 FROM group_members m WHERE m.conversation_id=$1 AND m.user_id=u.id)) ORDER BY u.created_at,u.id",
      [id, g.visibility],
    ) as Promise<GroupMember[]>;
  }
  async create(
    user: User,
    input: { title: string; description: string; visibility: string },
    key?: string,
  ) {
    return idempotent(this.db, 'group:' + user.id, key, input, async (tx) => {
      const id = ids('conv');
      await tx.query(
        'INSERT INTO conversations(id,title,description,visibility,created_by) VALUES($1,$2,$3,$4,$5)',
        [id, input.title, input.description, input.visibility, user.id],
      );
      await tx.query('INSERT INTO group_members(conversation_id,user_id) VALUES($1,$2)', [
        id,
        user.id,
      ]);
      await audit(tx, user.id, 'group.create', id, { visibility: input.visibility });
      return { id };
    });
  }
  async join(user: User, id: string) {
    return this.db.transaction(async (tx) => {
      const g = (
        await tx.query(
          "SELECT id FROM conversations WHERE id=$1 AND visibility IN ('project','public')",
          [id],
        )
      )[0];
      if (!g) throw new DomainError('GROUP_UNAVAILABLE', '群聊不可直接加入', 404);
      await tx.query(
        'INSERT INTO group_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [id, user.id],
      );
      return { id };
    });
  }
  async invite(user: User, id: string) {
    await requireGroupAccess(this.db, user, id);
    const token = opaque(),
      expires = new Date(Date.now() + 86400000);
    await this.db.query(
      'INSERT INTO group_invites(token_hash,conversation_id,created_by,expires_at) VALUES($1,$2,$3,$4)',
      [sha(token), id, user.id, expires],
    );
    await audit(this.db, user.id, 'group.invite', id);
    return { token, expires_at: expires.toISOString() };
  }
  async joinInvite(user: User, token: string) {
    return this.db.transaction(async (tx) => {
      const row = (
        await tx.query(
          'SELECT * FROM group_invites WHERE token_hash=$1 AND NOT revoked AND expires_at>now() FOR UPDATE',
          [sha(token)],
        )
      )[0];
      if (!row) throw new DomainError('INVITE_UNAVAILABLE', '邀请码不存在或已过期', 404);
      await tx.query(
        'INSERT INTO group_members(conversation_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [row.conversation_id, user.id],
      );
      await audit(tx, user.id, 'group.join', row.conversation_id);
      return { id: row.conversation_id };
    });
  }
  async post(
    user: User,
    id: string,
    input: {
      body: string;
      client_message_id: string;
      mentions: Mention[];
      invoke_agent: boolean;
      source_refs: { source_id: string; version: number }[];
    },
  ) {
    const result = await this.db.transaction(async (tx) => {
      const group = await requireGroupAccess(tx, user, id);
      if (group.archived_at)
        throw new DomainError('GROUP_ARCHIVED', '群已归档，恢复后才能发消息', 409);
      // 同一群的序号与幂等判断串行完成，重试同一消息不会新增观察作业。
      await tx.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [id]);
      const existing = (
        await tx.query(
          'SELECT * FROM messages WHERE conversation_id=$1 AND author_id=$2 AND client_message_id=$3',
          [id, user.id, input.client_message_id],
        )
      )[0];
      if (existing) {
        if (existing.body !== input.body)
          throw new DomainError('MESSAGE_CONFLICT', '相同消息标识不能用于不同正文');
        return existing;
      }
      // 服务端按当前群成员重新解析，不能相信浏览器提交的提及对象和文本范围。
      const mentions = extractMentions(input.body, await this.members(user, id, tx));
      for (const m of input.mentions)
        if (!mentions.some((v) => canonical(v) === canonical(m)))
          throw new DomainError('INVALID_MENTION', '提及对象或文本范围无效', 400);
      for (const ref of input.source_refs)
        if (
          !(
            await tx.query(
              "SELECT id FROM sources WHERE id=$1 AND current_version=$2 AND visibility='shared'",
              [ref.source_id, ref.version],
            )
          ).length
        )
          throw new DomainError('SOURCE_UNAVAILABLE', '引用资料已变更或不可共享', 400);
      const seq = (
        await tx.query(
          'SELECT coalesce(max(seq),0)::int+1 AS seq FROM messages WHERE conversation_id=$1',
          [id],
        )
      )[0].seq;
      const row = (
        await tx.query(
          'INSERT INTO messages(id,conversation_id,seq,author_id,body,client_message_id,mentions) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
          [
            ids('msg'),
            id,
            seq,
            user.id,
            input.body,
            input.client_message_id,
            JSON.stringify(mentions),
          ],
        )
      )[0];
      if (
        group.agent_policy.observe ||
        input.invoke_agent ||
        mentions.some((m) => m.type === 'agent')
      )
        await tx.query(
          'INSERT INTO observation_jobs(id,conversation_id,message_id,actor_id,payload) VALUES($1,$2,$3,$4,$5)',
          [
            ids('job'),
            id,
            row.id,
            user.id,
            JSON.stringify({
              explicit: input.invoke_agent || mentions.some((m) => m.type === 'agent'),
              source_refs: input.source_refs,
            }),
          ],
        );
      return row;
    });
    this.coordinator.wake();
    return { ...result, created_at: iso(result.created_at), author_name: user.name };
  }
  async feed(user: User, id: string, before?: number): Promise<GroupFeed> {
    const g = await requireGroupAccess(this.db, user, id);
    const rows = await this.db.query(
      'SELECT m.*,u.name AS author_name FROM messages m JOIN users u ON u.id=m.author_id WHERE conversation_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT 51',
      [id, before ?? 2147483647],
    );
    const more = rows.length > 50,
      messages = rows
        .slice(0, 50)
        .reverse()
        .map((r) => ({ ...r, created_at: iso(r.created_at) }));
    const jobs = (
      await this.db.query(
        "SELECT count(*) FILTER(WHERE status IN ('pending','processing'))::int AS pending,count(*) FILTER(WHERE status='error')::int AS failed FROM observation_jobs WHERE conversation_id=$1",
        [id],
      )
    )[0];
    return {
      messages: messages as GroupFeed['messages'],
      next_before: more ? Number(rows[49].seq) : null,
      goals: await this.coordinator.goals(user, id),
      members: await this.members(user, id),
      observed_seq: g.observed_seq,
      jobs_pending: jobs.pending,
      jobs_failed: jobs.failed,
    };
  }
}
