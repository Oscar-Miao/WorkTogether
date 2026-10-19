import type { Database } from '@team-agent/database';
import { DomainError } from '@team-agent/domain';
import { sha } from '../../common/security.js';
/** 在密码哈希前限流；窗口跨进程共享，不保存原始 IP 或邀请码。 */
export async function identityRateLimit(
  db: Database,
  action: string,
  subject: string,
  limit: number,
) {
  await db.query('DELETE FROM identity_rate_limits WHERE reset_at<now()');
  const row = (
    await db.query(
      `INSERT INTO identity_rate_limits(bucket,count,reset_at) VALUES($1,1,now()+interval '15 minutes')
     ON CONFLICT(bucket) DO UPDATE SET count=identity_rate_limits.count+1 RETURNING count`,
      [action + ':' + sha(subject)],
    )
  )[0];
  if (row.count > limit)
    throw new DomainError('RATE_LIMITED', '操作过于频繁，请 15 分钟后再试', 429);
}
