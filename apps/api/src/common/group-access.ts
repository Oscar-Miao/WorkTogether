import type { SqlConnection } from '@team-agent/database';
import type { User } from '@team-agent/contracts';
import { DomainError } from '@team-agent/domain';
export async function requireGroupAccess(db: SqlConnection, user: User, id: string) {
  const rows = await db.query(
    "SELECT c.* FROM conversations c WHERE c.id=$1 AND (c.visibility='project' OR EXISTS(SELECT 1 FROM group_members gm WHERE gm.conversation_id=c.id AND gm.user_id=$2))",
    [id, user.id],
  );
  if (!rows.length) throw new DomainError('GROUP_UNAVAILABLE', '群聊不存在或尚未加入', 404);
  return rows[0];
}
export async function requireTaskAccess(db: SqlConnection, user: User, id: string) {
  const row = (await db.query('SELECT conversation_id FROM tasks WHERE id=$1', [id]))[0];
  if (!row) throw new DomainError('NOT_FOUND', '工作不存在', 404);
  await requireGroupAccess(db, user, row.conversation_id);
}
