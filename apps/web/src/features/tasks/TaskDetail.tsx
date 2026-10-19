import { useEffect, useState } from 'react';
import {
  Check,
  ClipboardList,
  FileDiff,
  FileText,
  GitBranch,
  History,
  LockKeyhole,
  ShieldCheck,
  Square,
  Upload,
  X,
} from 'lucide-react';
import type { Bootstrap, Task, TaskEvent } from '@team-agent/contracts';
import { api, shortId, timeLabel } from '../../lib/api.js';
import { Button, Modal, StatusBadge } from '../../components/ui.js';
import { RetentionPanel } from './RetentionPanel.js';
export function TaskDetail({
  task,
  data,
  onClose,
  onRefresh,
  onRevise,
}: {
  task: Task;
  data: Bootstrap;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onRevise: () => void;
}) {
  const [tab, setTab] = useState('overview'),
    [events, setEvents] = useState<TaskEvent[]>([]),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [rejecting, setRejecting] = useState(false),
    [reason, setReason] = useState('');
  const owner = data.user.role === 'OWNER',
    active = ['DISPATCHING', 'RUNNING', 'CANCEL_REQUESTED', 'RECONCILING'].includes(task.state);
  useEffect(() => {
    setEvents([]);
    const stream = new EventSource('/api/v1/tasks/' + task.id + '/events');
    const receive = (event: MessageEvent) => {
      const item = JSON.parse(event.data) as TaskEvent;
      setEvents((old) => (old.some((e) => e.id === item.id) ? old : [...old, item].slice(-300)));
    };
    stream.addEventListener('task', receive);
    return () => stream.close();
  }, [task.id, task.content_revision]);
  async function act(name: string, path: string, body: unknown = {}) {
    setBusy(name);
    setError('');
    try {
      await api(path, body);
      await onRefresh();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  const repo = data.devices
    .flatMap((d) => d.repositories)
    .find((r) => r.id === task.input.repository_binding_id);
  return (
    <Modal title={'任务 · ' + shortId(task.id)} onClose={onClose} wide>
      <div className="task-detail">
        <div className="task-detail-heading">
          <StatusBadge state={task.state} />
          <span className="subtle">
            {task.creator_name} 发起 · {timeLabel(task.created_at)}
          </span>
          <h2>{task.input.goal}</h2>
        </div>
        <div className="detail-tabs" role="tablist">
          {[
            ['overview', '任务与审批', ClipboardList],
            ['events', '执行记录', History],
            ['artifacts', '成果', FileDiff],
            ['context', '上下文', FileText],
            ...(owner ? [['retention', '数据保留', ShieldCheck]] : []),
          ].map(([id, label, Icon]) => {
            const I = Icon as typeof FileText;
            return (
              <button
                key={id as string}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id as string)}
                className={tab === id ? 'selected' : ''}
              >
                <I size={15} />
                {label as string}
                {id === 'artifacts' && <small>{task.artifacts.length}</small>}
              </button>
            );
          })}
        </div>
        <div className="detail-content">
          {tab === 'overview' && (
            <>
              <div className="detail-meta-grid">
                <div>
                  <small>目标仓库</small>
                  <strong>
                    <GitBranch size={15} />
                    {repo?.name || '已绑定仓库'}
                  </strong>
                  <code>{task.input.base_commit.slice(0, 12)}</code>
                </div>
                <div>
                  <small>执行范围</small>
                  <strong>
                    {task.input.execution_profile === 'code_edit' ? '获准文件修改' : '只读分析'}
                  </strong>
                  <span>最长 {task.input.budget.wall_time_seconds / 60} 分钟</span>
                  {task.input.execution_profile === 'code_edit' && (
                    <code>允许目录：{task.input.allowed_write_prefixes?.join('、') || '无'}</code>
                  )}
                </div>
                <div>
                  <small>输入版本</small>
                  <strong>v{task.input_version}</strong>
                  <span>本次引用与讨论已冻结</span>
                </div>
              </div>
              <section className="detail-section">
                <h3>明确限制</h3>
                <ul className="constraint-list">
                  {task.input.constraints.map((x, i) => (
                    <li key={i}>
                      <LockKeyhole size={14} />
                      {x}
                    </li>
                  ))}
                </ul>
              </section>
              <section className="detail-section">
                <h3>验收条件</h3>
                <ul className="check-list">
                  {task.input.acceptance.map((x, i) => (
                    <li key={i}>
                      <Check size={14} />
                      {x}
                    </li>
                  ))}
                </ul>
              </section>
              <div className="form-notice">
                <ShieldCheck size={19} />
                <p>
                  本任务的模型输出和文件差异先由 Owner
                  核查。未运行测试时，完成状态不表示代码已通过验证。
                </p>
              </div>
              {task.error_code && <div className="inline-error">执行原因：{task.error_code}</div>}
              {task.state === 'RECONCILING' && (
                <div className="inline-error">
                  当前无法确认本机执行状态。需核查原进程与账本，平台不会自动重跑此任务。
                </div>
              )}
              {rejecting && (
                <div className="field">
                  <span>拒绝原因</span>
                  <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                  <Button
                    variant="danger"
                    disabled={!reason.trim()}
                    busy={busy === 'reject'}
                    onClick={() => void act('reject', '/tasks/' + task.id + '/reject', { reason })}
                  >
                    确认拒绝
                  </Button>
                </div>
              )}
            </>
          )}
          {tab === 'events' && (
            <>
              <p className="subtle">
                {owner ? '原始工具输出仅对 Owner 可见。' : '此处仅展示获准共享的阶段与执行状态。'}
              </p>
              <div className="event-list">
                {events.map((event) => (
                  <div key={event.id} className="event-item">
                    <span className="event-dot" />
                    <div>
                      <strong>{event.type}</strong>
                      <pre>
                        {Object.entries(event.payload)
                          .map(
                            ([key, value]) =>
                              key +
                              ': ' +
                              (typeof value === 'string' ? value : JSON.stringify(value)),
                          )
                          .join('\n')}
                      </pre>
                    </div>
                    <time>{timeLabel(event.occurred_at)}</time>
                  </div>
                ))}
                {!events.length && <p className="muted">等待执行事件…</p>}
              </div>
            </>
          )}
          {tab === 'artifacts' && (
            <>
              {!task.artifacts.length ? (
                <div className="small-empty">
                  <FileDiff size={30} />
                  <h3>成果将在这里汇总</h3>
                  <p>
                    {owner
                      ? '任务结束后可审阅报告和文件差异。'
                      : 'Owner 发布后，你可以查看任务成果。'}
                  </p>
                </div>
              ) : (
                task.artifacts.map((artifact) => (
                  <section key={artifact.id} className="artifact-card">
                    <header>
                      <h3>{artifact.title}</h3>
                      <span className={'badge ' + (artifact.published ? 'green' : 'neutral')}>
                        {artifact.published ? '已共享' : '仅 Owner'}
                      </span>
                    </header>
                    <pre className={artifact.kind === 'diff' ? 'diff-output' : 'report-output'}>
                      {artifact.purged_at
                        ? '正文已清理，证据不可用。哈希：' + artifact.content_hash
                        : artifact.content}
                    </pre>
                    {owner && !artifact.published && !artifact.purged_at && (
                      <div className="artifact-publish">
                        <small>发布前请确认内容适合全部项目成员查看。</small>
                        <Button
                          variant="secondary"
                          busy={busy === artifact.id}
                          onClick={() =>
                            void act(
                              artifact.id,
                              '/tasks/' + task.id + '/artifacts/' + artifact.id + '/publish',
                            )
                          }
                        >
                          <Upload size={14} />
                          发布到会话
                        </Button>
                      </div>
                    )}
                  </section>
                ))
              )}
            </>
          )}
          {tab === 'context' && (
            <>
              <div className="detail-meta-grid">
                <div>
                  <small>快照</small>
                  <strong>{shortId(task.snapshot.id)}</strong>
                </div>
                <div>
                  <small>会话截止点</small>
                  <strong>消息 #{task.snapshot.cutoff_seq}</strong>
                </div>
                <div>
                  <small>历史整理</small>
                  <strong>{task.snapshot.compacted ? '原文摘录 + 近期消息' : '保留原文'}</strong>
                </div>
              </div>
              <h3>显式资料引用</h3>
              {task.snapshot.evidence.map((item) => (
                <div className="source-row" key={item.id}>
                  <FileText size={16} />
                  <span>
                    {data.sources.find((s) => s.id === item.id)?.name ||
                      data.memories.find((m) => m.id === item.id)?.title ||
                      item.id}
                  </span>
                  <small>v{item.version}</small>
                </div>
              ))}
              <details className="context-source">
                <summary>查看初始模型输入与精确限制</summary>
                <pre>{task.snapshot.model_input}</pre>
              </details>
              <p className="subtle">
                哈希 {task.snapshot.hash.slice(0, 24)}… · 摘要不授予执行权限。
              </p>
            </>
          )}
          {tab === 'retention' && owner && <RetentionPanel task={task} onRefresh={onRefresh} />}
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="modal-actions detail-actions">
          {(data.user.id === task.creator_id || owner) && !active && (
            <Button variant="secondary" onClick={onRevise}>
              修订 / 再次发起
            </Button>
          )}
          {active &&
            (owner ? (
              <Button
                variant="danger"
                busy={busy === 'cancel'}
                disabled={task.state === 'CANCEL_REQUESTED'}
                onClick={() => void act('cancel', '/tasks/' + task.id + '/cancel')}
              >
                <Square size={14} />
                {task.state === 'CANCEL_REQUESTED' ? '等待停止确认' : '停止执行'}
              </Button>
            ) : (
              <Button
                variant="secondary"
                busy={busy === 'request'}
                onClick={() =>
                  void act('request', '/tasks/' + task.id + '/cancel-requests', {
                    reason: '成员请求停止本任务',
                  })
                }
              >
                请求 Owner 停止
              </Button>
            ))}
          {owner && task.state === 'PENDING_APPROVAL' && (
            <>
              <Button variant="secondary" onClick={() => setRejecting(!rejecting)}>
                <X size={14} />
                拒绝
              </Button>
              <Button
                busy={busy === 'approve'}
                onClick={() =>
                  void act('approve', '/tasks/' + task.id + '/approve', {
                    input_version: task.input_version,
                    version: task.version,
                    snapshot_hash: task.snapshot.hash,
                  })
                }
              >
                <Check size={15} />
                批准本次执行
              </Button>
            </>
          )}
          {owner && task.state === 'QUEUED' && (
            <Button
              variant="danger"
              busy={busy === 'cancel'}
              onClick={() => void act('cancel', '/tasks/' + task.id + '/cancel')}
            >
              取消排队
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
