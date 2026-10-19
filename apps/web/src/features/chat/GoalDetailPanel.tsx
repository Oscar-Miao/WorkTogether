import { useEffect, useState } from 'react';
import { AdvancedGoalPanel } from './AdvancedGoalPanel.js';
import type { GroupMember, RepositoryBinding, GoalDetail } from '@team-agent/contracts';
import { chatApi } from '../../lib/chat-api.js';
import { GoalCard, type GoalAction } from './GoalCard.js';
export function GoalDetailPanel({
  id,
  onAction,
  userId = '',
  members = [],
  repositories = [],
  isAdmin = false,
}: {
  id: string;
  userId?: string;
  members?: GroupMember[];
  repositories?: RepositoryBinding[];
  isAdmin?: boolean;
  onAction: (g: GoalDetail['goal'], a: GoalAction) => void;
}) {
  const [data, setData] = useState<GoalDetail | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    async function load() {
      try {
        const value = await chatApi<GoalDetail>('/goals/' + id);
        if (!cancelled) setData(value);
      } catch (e: any) {
        if (!cancelled) {
          setError(e.message);
          setData(null);
        }
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);
  if (error) return <p role="alert">{error}</p>;
  if (!data) return <p className="c-muted">正在读取目标依据…</p>;
  const { goal, task } = data;
  return (
    <div>
      <GoalCard goal={goal} onAction={onAction} />
      <AdvancedGoalPanel
        goal={goal}
        userId={userId}
        members={members}
        repositories={repositories}
        isAdmin={isAdmin}
      />
      <h3>目标版本 v{goal.version}</h3>
      <p className="c-muted">
        {goal.engine === 'model'
          ? '模型提取目标，服务器校验执行策略'
          : '规则识别目标；语义判断需配置模型并进行团队评测'}
      </p>
      <h3>限制</h3>
      {goal.constraints.length ? (
        <ul>
          {goal.constraints.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : (
        <p className="c-muted">尚未补充明确限制。</p>
      )}
      <h3>验收条件</h3>
      <ul>
        {goal.acceptance.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      {task && (
        <>
          <h3>真实执行</h3>
          <p className="c-muted">
            状态：{task.state} · 基线 {task.input.base_commit.slice(0, 10)} · 最长{' '}
            {task.input.budget.wall_time_seconds} 秒
          </p>
          <p className="c-muted">
            允许目录：{task.input.allowed_write_prefixes?.join('、') || '只读，无文件写入'}
          </p>
          <h3>执行成果</h3>
          {task.artifacts.length ? (
            task.artifacts.map((a) => (
              <details key={a.id} open={a.kind === 'report'}>
                <summary>
                  {a.title}
                  {a.purged_at ? '（正文已清理）' : ''}
                </summary>
                <pre className="c-code">{a.content || '正文不可用，保留来源元信息。'}</pre>
              </details>
            ))
          ) : (
            <p className="c-muted">尚无可展示的执行成果；不会用模拟结果代替。</p>
          )}
          <details>
            <summary>上下文快照与来源</summary>
            <p>
              消息截止 #{task.snapshot.cutoff_seq} ·{' '}
              {task.snapshot.compacted ? '保留原文来源的历史摘录' : '近期原文'} ·{' '}
              {task.snapshot.hash.slice(0, 12)}
            </p>
            <pre className="c-code">{task.snapshot.model_input}</pre>
          </details>
        </>
      )}
      <h3>判断与纠正记录</h3>
      {data.events.map((e) => (
        <div className="c-audit" key={e.id}>
          <strong>{e.kind}</strong>
          <small>{new Date(e.created_at).toLocaleString()}</small>
          <pre>{JSON.stringify(e.detail, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}
