import { Sparkles, Link2, Square, ChevronRight, UserRound } from 'lucide-react';
import type { Goal } from '@team-agent/contracts';
export const goalLabels: Record<Goal['state'], string> = {
  CANDIDATE: '候选目标',
  CLARIFYING: '待澄清',
  APPROVED: 'Agent 已获准',
  CLAIMED: '人工推进中',
  REJECTED: '避免重复',
  STOPPING: '正在停止',
  STOPPED: '已停止',
  COMPLETED: '已完成 · 可核查',
  FAILED: '执行未完成',
};
export type GoalAction = 'detail' | 'claim' | 'review' | 'stop' | 'complete';
export function GoalCard({
  goal,
  onAction,
  compact = false,
}: {
  goal: Goal;
  onAction: (g: Goal, a: GoalAction) => void;
  compact?: boolean;
}) {
  const labels: Record<string, string> = {
    QUEUED: '排队等待执行器',
    DISPATCHING: '准备执行',
    RUNNING: '执行中',
    RECONCILING: '待核查原执行',
    CANCEL_REQUESTED: '等待停止回执',
  };
  return (
    <article
      className={'c-goal ' + (compact ? 'compact ' : '') + goal.state.toLowerCase()}
      data-goal-id={goal.id}
    >
      <div className="c-goal-meta">
        <span>{goal.id.slice(-7).toUpperCase()}</span>
        <span className="c-pill">{labels[goal.task_state || ''] || goalLabels[goal.state]}</span>
      </div>
      <button className="c-goal-title" onClick={() => onAction(goal, 'detail')}>
        {goal.title}
      </button>
      {!compact && <p>{goal.reason}</p>}
      <div className="c-goal-owner">
        {goal.claimed_by ? <UserRound size={13} /> : <Sparkles size={13} />}
        <span>{goal.assignee_name || '主设备 Agent'}</span>
        {goal.engine === 'rules' && !compact && <small>规则协调</small>}
      </div>
      {!compact && (
        <div className="c-goal-actions">
          {goal.related && (
            <button onClick={() => onAction({ ...goal, id: goal.related!.id }, 'detail')}>
              <Link2 size={12} />
              查看已有工作
            </button>
          )}
          {['CANDIDATE', 'CLARIFYING'].includes(goal.state) && (
            <button onClick={() => onAction(goal, 'claim')}>我来做</button>
          )}
          {['CANDIDATE', 'CLARIFYING', 'REJECTED', 'FAILED', 'STOPPED'].includes(goal.state) && (
            <button onClick={() => onAction(goal, 'review')}>补充差异 / 复核</button>
          )}
          {goal.state === 'CLAIMED' && (
            <button onClick={() => onAction(goal, 'complete')}>登记完成</button>
          )}
          {['APPROVED', 'STOPPING', 'CANDIDATE', 'CLAIMED', 'CLARIFYING'].includes(goal.state) && (
            <button onClick={() => onAction(goal, 'stop')}>
              <Square size={11} />
              停止
            </button>
          )}
          <button onClick={() => onAction(goal, 'detail')}>
            查看依据
            <ChevronRight size={12} />
          </button>
        </div>
      )}
    </article>
  );
}
