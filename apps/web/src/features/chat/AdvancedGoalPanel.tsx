import { useEffect, useState } from 'react';
import type { Goal, GroupMember, RepositoryBinding } from '@team-agent/contracts';
import { chatApi } from '../../lib/chat-api.js';
import { Field, Button } from '../../components/ui.js';

const stateLabel = (state: string) =>
  (
    ({
      pending: '等待确认',
      accepted: '已接手',
      rejected: '已拒绝',
      expired: '已过期',
      applied: '已生效',
      running: '执行中',
      waiting: '等待依赖',
      completed: '步骤完成',
      blocked: '已阻塞',
      failed: '失败',
      cancelled: '已停止',
      awaiting_verification: '等待集成核验',
      verified: '已核验',
      invalidated: '成果已失效',
      CLAIMED: '人工认领',
      APPROVED: '已批准',
      COMPLETED: '已完成',
      SUCCEEDED: '执行结束',
      RUNNING: '执行中',
      QUEUED: '排队中',
    }) as Record<string, string>
  )[state] || state;

/** 进阶操作仍在原目标侧栏完成，权限和版本以服务端为准。 */
export function AdvancedGoalPanel({
  goal,
  userId,
  members,
  repositories,
  isAdmin,
}: {
  goal: Goal;
  userId: string;
  members: GroupMember[];
  repositories: RepositoryBinding[];
  isAdmin: boolean;
}) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(''),
    [note, setNote] = useState(''),
    [target, setTarget] = useState(''),
    [search, setSearch] = useState(''),
    [matches, setMatches] = useState<any[]>([]),
    [kind, setKind] = useState('depends_on'),
    [to, setTo] = useState(''),
    [title, setTitle] = useState(goal.title),
    [acceptance, setAcceptance] = useState(goal.acceptance.join('\n')),
    [constraints, setConstraints] = useState(goal.constraints.join('\n')),
    [steps, setSteps] = useState([
      {
        name: 'analysis',
        goal: '分析现有代码并给出证据',
        repository_id: repositories[0]?.id || '',
        dependencies: '',
      },
    ]);
  async function load() {
    setData(await chatApi('/goals/' + goal.id + '/coordination'));
  }
  useEffect(() => {
    let live = true;
    const refresh = () =>
      chatApi('/goals/' + goal.id + '/coordination')
        .then((r) => {
          if (live) setData(r);
        })
        .catch((e: Error) => {
          if (live) setError(e.message);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [goal.id]);
  async function action(path: string, body: unknown) {
    setError('');
    try {
      await chatApi(path, body);
      setNote('');
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <section className="c-advanced">
      <h3>分工、依赖与版本</h3>
      {data?.relations.map((r: any) => (
        <p key={r.id}>
          {
            (
              {
                depends_on: '依赖',
                overlap: '部分重叠',
                same: '相同目标',
                port: '移植',
                supersedes: '取代',
              } as any
            )[r.kind]
          }
          ：{r.title} · {stateLabel(r.state)}
        </p>
      ))}
      {!!data?.restricted_relations && (
        <p className="c-muted">存在 {data.restricted_relations} 条当前无权查看的关联。</p>
      )}
      <details>
        <summary>关联已有目标</summary>
        <Field label="搜索可见目标">
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </Field>
        <Button
          variant="secondary"
          onClick={() =>
            void chatApi<any>('/coordination/search?q=' + encodeURIComponent(search))
              .then((r) => setMatches(r.goals.filter((g: any) => g.id !== goal.id)))
              .catch((e: Error) => setError(e.message))
          }
        >
          搜索
        </Button>
        <Field label="关联目标">
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">请选择</option>
            {matches.map((g) => (
              <option value={g.id} key={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="关系">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="depends_on">本目标依赖它</option>
            <option value="overlap">部分重叠</option>
            <option value="port">移植到新版本</option>
            <option value="same">相同目标</option>
          </select>
        </Field>
        <Field label="依据或具体差异">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button
          disabled={!target || note.trim().length < 4}
          onClick={() =>
            void chatApi<any>('/goals/' + target)
              .then((r) =>
                action('/goals/' + goal.id + '/relations', {
                  target_id: target,
                  kind,
                  evidence: note,
                  expected_version: goal.version,
                  target_version: r.goal.version,
                }),
              )
              .catch((e: Error) => setError(e.message))
          }
        >
          保存关联
        </Button>
      </details>
      {goal.state === 'CLAIMED' && goal.claimed_by === userId && (
        <details>
          <summary>交接当前工作</summary>
          <Field label="接手成员">
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">请选择</option>
              {members
                .filter((m) => m.id !== userId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="进度与待办">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button
            disabled={!to || note.trim().length < 4}
            onClick={() =>
              void action('/goals/' + goal.id + '/handoffs', {
                to_user: to,
                note,
                expected_version: goal.version,
              })
            }
          >
            发起交接，等待对方确认
          </Button>
        </details>
      )}
      {data?.handoffs.map((h: any) => (
        <div key={h.id}>
          <p>
            交给 {h.to_name}：{h.note} · {stateLabel(h.state)}
          </p>
          {h.to_user === userId && h.state === 'pending' && (
            <>
              <Button
                onClick={() => void action('/handoffs/' + h.id + '/resolve', { accept: true })}
              >
                确认接手
              </Button>
              <Button
                variant="secondary"
                onClick={() => void action('/handoffs/' + h.id + '/resolve', { accept: false })}
              >
                拒绝交接
              </Button>
            </>
          )}
        </div>
      ))}
      <details>
        <summary>修订目标或验收</summary>
        <p className="c-muted">先停止旧版本执行，保留历史，再重新判断；不会自动回滚文件。</p>
        <Field label="新目标">
          <textarea value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="约束（每行一条）">
          <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} />
        </Field>
        <Field label="验收（每行一条）">
          <textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
        </Field>
        <Field label="修订原因">
          <textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button
          disabled={note.trim().length < 4}
          onClick={() =>
            void action('/goals/' + goal.id + '/revisions', {
              title,
              constraints: constraints.split('\n').filter(Boolean),
              acceptance: acceptance.split('\n').filter(Boolean),
              reason: note,
              expected_version: goal.version,
            })
          }
        >
          提交新版本并停止旧工作
        </Button>
      </details>
      {data?.revisions.map((r: any) => (
        <p className="c-muted" key={r.id}>
          修订 v{r.previous_version}：{r.reason} · {stateLabel(r.state)}
        </p>
      ))}
      {isAdmin && ['CANDIDATE', 'CLARIFYING'].includes(goal.state) && (
        <details>
          <summary>创建只读分工计划</summary>
          <p className="c-muted">
            独立步骤可并行，依赖完成后再推进；所有步骤结束还需人工核验集成结果。
          </p>
          {steps.map((s, i) => (
            <fieldset key={i}>
              <Field label="步骤名称">
                <input
                  value={s.name}
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label="步骤目标">
                <textarea
                  value={s.goal}
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, n) => (n === i ? { ...x, goal: e.target.value } : x)),
                    )
                  }
                />
              </Field>
              <Field label="执行仓库">
                <select
                  value={s.repository_id}
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, n) => (n === i ? { ...x, repository_id: e.target.value } : x)),
                    )
                  }
                >
                  <option value="">请选择</option>
                  {repositories.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="依赖步骤名称（逗号分隔）">
                <input
                  value={s.dependencies}
                  onChange={(e) =>
                    setSteps((old) =>
                      old.map((x, n) => (n === i ? { ...x, dependencies: e.target.value } : x)),
                    )
                  }
                />
              </Field>
            </fieldset>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              setSteps((old) => [
                ...old,
                {
                  name: 'step' + (old.length + 1),
                  goal: '分析相关实现并提供依据',
                  repository_id: repositories[0]?.id || '',
                  dependencies: '',
                },
              ])
            }
          >
            添加步骤
          </Button>
          <Button
            onClick={() =>
              void action('/goals/' + goal.id + '/plans', {
                expected_version: goal.version,
                steps: steps.map((s) => ({
                  ...s,
                  dependencies: s.dependencies
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                })),
              })
            }
          >
            提交执行计划
          </Button>
        </details>
      )}
      {data?.plans.map((p: any) => (
        <div key={p.id}>
          <h4>分工计划 · {stateLabel(p.state)}</h4>
          {data.steps
            .filter((s: any) => s.plan_id === p.id)
            .map((s: any) => (
              <div key={s.id}>
                <p>
                  {s.name}：{stateLabel(s.state)} {s.task_state ? stateLabel(s.task_state) : ''}
                </p>
                {s.task?.artifacts?.map((a: any) => (
                  <details key={a.id}>
                    <summary>{a.title}</summary>
                    <pre>{a.content}</pre>
                  </details>
                ))}
              </div>
            ))}
          {p.state === 'awaiting_verification' && (
            <>
              <Field label="集成核验依据">
                <textarea value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Button
                disabled={note.trim().length < 8}
                onClick={() => void action('/plans/' + p.id + '/verify', { evidence: note })}
              >
                确认集成结果
              </Button>
            </>
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
