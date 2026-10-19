import { useState } from 'react';
import { ChevronRight, ClipboardList, Plus, ShieldCheck, Sparkles } from 'lucide-react';
import type { Bootstrap, TaskSummary } from '@team-agent/contracts';
import { timeLabel } from '../../lib/api.js';
import { usePagedList } from '../../lib/use-paged-list.js';
import { Button, EmptyState, StatusBadge } from '../../components/ui.js';
export function TaskListView({
  data,
  approvals,
  onOpen,
  onCreate,
}: {
  data: Bootstrap;
  approvals: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const state = approvals ? 'pending' : filter;
  const list = usePagedList<TaskSummary>('/tasks?state=' + state);
  const stats = data.task_stats;
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{approvals ? 'OWNER CONTROL' : 'EXECUTION OVERVIEW'}</span>
          <h1>{approvals ? '审批台' : '任务中心'}</h1>
          <p>
            {approvals
              ? '审阅输入、资料与执行范围，再决定是否交给本机 Agent。'
              : '从请求到交付，每一步都有清楚的状态和依据。'}
          </p>
        </div>
        <Button onClick={onCreate}>
          <Plus size={16} />
          发起任务
        </Button>
      </div>
      <div className="stats-row">
        <div>
          <span>全部任务</span>
          <strong>
            {stats.total}
            <small>项</small>
          </strong>
        </div>
        <div>
          <span>待 Owner 审阅</span>
          <strong>
            {stats.pending}
            <small>项</small>
          </strong>
        </div>
        <div>
          <span>进行中</span>
          <strong>
            {stats.active}
            <small>项</small>
          </strong>
        </div>
        <div>
          <span>已完成</span>
          <strong>
            {stats.succeeded}
            <small>项</small>
          </strong>
        </div>
      </div>
      {!approvals && (
        <div className="filter-tabs">
          {[
            ['all', '全部'],
            ['pending', '待审批'],
            ['running', '进行中'],
            ['done', '已结束'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setFilter(id)}
              className={filter === id ? 'active' : ''}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {list.error && (
        <p className="inline-error" role="alert">
          {list.error}
        </p>
      )}
      {!list.items.length ? (
        list.loading ? (
          <p className="muted">正在加载任务…</p>
        ) : (
          <EmptyState
            icon={approvals ? <ShieldCheck size={30} /> : <ClipboardList size={30} />}
            title={approvals ? '没有待处理的请求' : '这里还没有任务'}
            description={
              approvals
                ? '新的执行请求到达后，会在这里等待你的审阅。'
                : '明确目标、约束和验收条件，发起第一项任务。'
            }
          />
        )
      ) : (
        <div className="task-list">
          {list.items.map((task) => (
            <button className="task-list-row" key={task.id} onClick={() => onOpen(task.id)}>
              <div className="task-symbol">
                <Sparkles size={19} />
              </div>
              <div className="task-list-main">
                <h3>{task.input.goal}</h3>
                <p>
                  {task.creator_name} · {timeLabel(task.created_at)}
                </p>
              </div>
              <span className="task-mode">
                {task.input.execution_profile === 'code_edit' ? '文件修改' : '只读分析'}
              </span>
              <StatusBadge state={task.state} />
              <ChevronRight size={17} />
            </button>
          ))}
        </div>
      )}
      {list.page?.has_more && (
        <div className="load-more">
          <Button variant="secondary" busy={list.loading} onClick={() => void list.more()}>
            加载更多任务
          </Button>
        </div>
      )}
    </div>
  );
}
