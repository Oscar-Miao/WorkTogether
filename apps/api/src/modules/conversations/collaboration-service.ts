import type { Database, SqlConnection } from '@team-agent/database';
import type { Conversation, Memory, Message, Source, User } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
import { audit, ids, iso, owner, sha } from '../../common/security.js';

export class CollaborationService {
  constructor(private readonly db: Database) {}
  async conversations(): Promise<Conversation[]> {
    return (await this.db.query('SELECT * FROM conversations ORDER BY created_at')).map(
      (r) => ({ ...r, created_at: iso(r.created_at) }) as Conversation,
    );
  }
  async requireConversation(id: string, tx: SqlConnection = this.db): Promise<void> {
    if (!(await tx.query('SELECT id FROM conversations WHERE id=$1', [id])).length)
      throw new DomainError('NOT_FOUND', '会话不存在', 404);
  }
  async createConversation(user: User, title: string): Promise<Conversation> {
    const id = ids('conv');
    const rows = await this.db.query(
      'INSERT INTO conversations(id,title,created_by) VALUES($1,$2,$3) RETURNING *',
      [id, title, user.id],
    );
    return { ...rows[0], created_at: iso(rows[0].created_at) } as Conversation;
  }
  async messages(id: string, tx: SqlConnection = this.db, cutoff = 2147483647): Promise<Message[]> {
    await this.requireConversation(id, tx);
    return (
      await tx.query(
        'SELECT m.*,u.name AS author_name FROM messages m JOIN users u ON u.id=m.author_id WHERE conversation_id=$1 AND seq<=$2 ORDER BY seq',
        [id, cutoff],
      )
    ).map((r) => ({ ...r, created_at: iso(r.created_at) }) as Message);
  }
  async postMessage(user: User, id: string, body: string, clientId: string): Promise<Message> {
    return this.db.transaction(async (tx) => {
      // The conversation row serializes sequence allocation and duplicate client submissions.
      await this.requireConversation(id, tx);
      await tx.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [id]);
      const existing = await tx.query(
        'SELECT m.*,u.name AS author_name FROM messages m JOIN users u ON u.id=m.author_id WHERE conversation_id=$1 AND author_id=$2 AND client_message_id=$3',
        [id, user.id, clientId],
      );
      if (existing.length)
        return { ...existing[0], created_at: iso(existing[0].created_at) } as Message;
      const seq = (
        await tx.query(
          'SELECT coalesce(max(seq),0)::int+1 AS n FROM messages WHERE conversation_id=$1',
          [id],
        )
      )[0].n;
      const rows = await tx.query(
        'INSERT INTO messages(id,conversation_id,seq,author_id,body,client_message_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [ids('msg'), id, seq, user.id, body, clientId],
      );
      return { ...rows[0], author_name: user.name, created_at: iso(rows[0].created_at) } as Message;
    });
  }
  async sources(user: User, tx: SqlConnection = this.db): Promise<Source[]> {
    const rows = await tx.query(
      "SELECT s.id,s.name,s.visibility,v.version,v.content,v.content_hash FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.version=s.current_version WHERE ($1='OWNER' OR s.visibility='shared') ORDER BY s.created_at",
      [user.role],
    );
    return rows as unknown as Source[];
  }
  async source(
    user: User,
    id: string,
    version: number,
    tx: SqlConnection = this.db,
  ): Promise<Source> {
    const rows = await tx.query(
      "SELECT s.id,s.name,s.visibility,v.version,v.content,v.content_hash FROM sources s JOIN source_versions v ON v.source_id=s.id WHERE s.id=$1 AND v.version=$2 AND ($3='OWNER' OR s.visibility='shared')",
      [id, version, user.role],
    );
    if (!rows.length)
      throw new DomainError('CONTEXT_SOURCE_UNAVAILABLE', '资料不存在或没有访问权限', 404);
    return rows[0] as Source;
  }
  async createSource(
    user: User,
    input: { name: string; content: string; visibility: string },
  ): Promise<Source> {
    owner(user);
    const id = ids('src');
    return this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO sources(id,name,visibility,created_by) VALUES($1,$2,$3,$4)', [
        id,
        input.name,
        input.visibility,
        user.id,
      ]);
      await tx.query(
        'INSERT INTO source_versions(source_id,version,content,content_hash) VALUES($1,1,$2,$3)',
        [id, input.content, sha(input.content)],
      );
      await audit(tx, user.id, 'source.create', id, { visibility: input.visibility });
      return this.source(user, id, 1, tx);
    });
  }
  async reviseSource(
    user: User,
    id: string,
    content: string,
    expectedVersion: number,
  ): Promise<Source> {
    owner(user);
    return this.db.transaction(async (tx) => {
      const rows = await tx.query('SELECT * FROM sources WHERE id=$1 FOR UPDATE', [id]);
      if (!rows.length) throw new DomainError('NOT_FOUND', '资料不存在', 404);
      if (rows[0].current_version !== expectedVersion)
        throw new DomainError('SOURCE_VERSION_CONFLICT', '资料已被其他操作更新，请重新读取后修改');
      const version = rows[0].current_version + 1;
      await tx.query(
        'INSERT INTO source_versions(source_id,version,content,content_hash) VALUES($1,$2,$3,$4)',
        [id, version, content, sha(content)],
      );
      await tx.query('UPDATE sources SET current_version=$1 WHERE id=$2', [version, id]);
      // A queued approval cannot silently keep executing after its referenced source changes.
      await tx.query(
        "UPDATE tasks SET state='PENDING_APPROVAL',approval=NULL,version=version+1,updated_at=now() WHERE state IN ('QUEUED','PENDING_APPROVAL') AND input->'source_refs' @> $1::jsonb",
        [JSON.stringify([{ source_id: id }])],
      );
      await audit(tx, user.id, 'source.revise', id, { version });
      return this.source(user, id, version, tx);
    });
  }
  async memories(tx: SqlConnection = this.db): Promise<Memory[]> {
    return (await tx.query(
      'SELECT * FROM memories ORDER BY created_at DESC',
    )) as unknown as Memory[];
  }
  async createMemory(
    user: User,
    input: {
      title: string;
      content: string;
      source_refs: { source_id: string; version: number }[];
    },
  ): Promise<Memory> {
    return this.db.transaction(async (tx) => {
      for (const ref of input.source_refs) {
        const source = await this.source(user, ref.source_id, ref.version, tx);
        if (source.visibility !== 'shared')
          throw new DomainError('PRIVATE_SOURCE', '私有资料不能直接提升为共享记忆', 403);
      }
      const rows = await tx.query(
        'INSERT INTO memories(id,title,content,source_refs,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [ids('mem'), input.title, input.content, JSON.stringify(input.source_refs), user.id],
      );
      return rows[0] as Memory;
    });
  }
  async confirmMemory(user: User, id: string): Promise<Memory> {
    owner(user);
    const rows = await this.db.query(
      "UPDATE memories SET status='confirmed',confirmed_by=$1 WHERE id=$2 AND status='candidate' RETURNING *",
      [user.id, id],
    );
    if (!rows.length) throw new DomainError('MEMORY_CONFLICT', '候选结论已变化或不存在');
    await audit(this.db, user.id, 'memory.confirm', id);
    return rows[0] as Memory;
  }
}
