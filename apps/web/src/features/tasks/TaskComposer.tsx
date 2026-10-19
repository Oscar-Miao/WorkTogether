import { useRef, useState, type FormEvent } from 'react';
import { FileText, ShieldCheck, Sparkles } from 'lucide-react';
import type { Bootstrap, Task, TaskInput, SourceSummary, Memory } from '@team-agent/contracts';
import { usePagedList } from '../../lib/use-paged-list.js';
import { api } from '../../lib/api.js';
import { Button, Field, Modal } from '../../components/ui.js';
export function TaskComposer({
  data,
  conversationId,
  revision,
  onClose,
  onCreated,
}: {
  data: Bootstrap;
  conversationId: string;
  revision?: Task;
  onClose: () => void;
  onCreated: (id: string) => Promise<void>;
}) {
  const repositories = data.devices
    .filter((d) => d.status !== 'revoked')
    .flatMap((d) => d.repositories.map((r) => ({ ...r, device: d })));
  const [goal, setGoal] = useState(revision?.input.goal || ''),
    [constraints, setConstraints] = useState(
      revision?.input.constraints.join('\n') || '不得提交或推送代码\n未运行测试时必须明确说明',
    ),
    [acceptance, setAcceptance] = useState(
      revision?.input.acceptance.join('\n') || '给出有依据的结论\n说明已完成与未验证的内容',
    );
  const [repositoryId, setRepositoryId] = useState(
      revision?.input.repository_binding_id || repositories[0]?.id || '',
    ),
    [profile, setProfile] = useState<'code_review' | 'code_edit'>(
      revision?.input.execution_profile || 'code_review',
    );
  const [sourceRefs, setSourceRefs] = useState<string[]>(
      revision?.input.source_refs.map((s) => s.source_id) || [],
    ),
    [memoryRefs, setMemoryRefs] = useState<string[]>(
      revision?.input.memory_refs.map((s) => s.memory_id) || [],
    );
  const sources = usePagedList<SourceSummary>('/sources?visibility=shared');
  const memories = usePagedList<Memory>('/memories?status=confirmed');
  const versions = useRef({
    sources: new Map(revision?.input.source_refs.map((ref) => [ref.source_id, ref.version])),
    memories: new Map(revision?.input.memory_refs.map((ref) => [ref.memory_id, ref.version])),
  });
  const [requestKey] = useState(() => crypto.randomUUID());
  const [minutes, setMinutes] = useState(15),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const repo = repositories.find((r) => r.id === repositoryId);
  const toggle = (
    id: string,
    version: number,
    list: string[],
    setter: (value: string[]) => void,
    map: Map<string, number>,
  ) => {
    if (list.includes(id)) {
      map.delete(id);
      setter(list.filter((value) => value !== id));
    } else {
      map.set(id, version);
      setter([...list, id]);
    }
  };
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!repo) return;
    setBusy(true);
    setError('');
    const input: TaskInput = {
      conversation_id: conversationId,
      goal,
      constraints: constraints
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      acceptance: acceptance
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      repository_binding_id: repo.id,
      base_commit: repo.base_commit,
      execution_profile: profile,
      budget: { wall_time_seconds: minutes * 60, max_model_calls: 60 },
      // Selection versions persist when paging/polling; an unloaded reference must never disappear.
      source_refs: sourceRefs.map((id) => ({
        source_id: id,
        version: versions.current.sources.get(id) ?? 0,
      })),
      memory_refs: memoryRefs.map((id) => ({
        memory_id: id,
        version: versions.current.memories.get(id) ?? 0,
      })),
    };
    try {
      const result = await api<{ id: string }>(
        revision ? '/tasks/' + revision.id + '/revisions' : '/tasks',
        input,
        { key: requestKey },
      );
      await onCreated(result.id);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={revision ? '修订任务' : '发起 AI 任务'} onClose={onClose} wide>
      <form onSubmit={submit} className="modal-body task-form">
        <div className="form-notice">
          <ShieldCheck size={19} />
          <div>
            <strong>先审阅，再执行</strong>
            <p>任务提交后会冻结本次讨论与引用资料，由 Owner 审核执行范围。</p>
          </div>
        </div>
        <Field label="你希望完成什么？">
          <textarea
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="例如：分析支付回调是否存在重复处理，说明依据与修改建议。"
            required
            minLength={4}
            maxLength={8000}
            autoFocus
          />
        </Field>
        <div className="form-grid">
          <Field label="目标仓库">
            <select value={repositoryId} onChange={(e) => setRepositoryId(e.target.value)} required>
              <option value="" disabled>
                选择已绑定仓库
              </option>
              {repositories.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.device.status === 'online' ? '在线' : '离线'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="执行方式">
            <select value={profile} onChange={(e) => setProfile(e.target.value as typeof profile)}>
              <option value="code_review">只读分析</option>
              <option value="code_edit" disabled={!repo?.capabilities.includes('file_edit')}>
                允许修改获准文件
              </option>
            </select>
          </Field>
        </div>
        {!repositories.length && (
          <p className="inline-error">还没有已绑定仓库，请先由 Owner 在“本地 Agent”中连接设备。</p>
        )}
        {repo && (
          <p className="subtle">
            代码基线 {repo.base_commit.slice(0, 10)} ·{' '}
            {repo.device.runtime === 'pi' ? 'Pi Agent' : '确定性只读检查（不调用模型）'}
          </p>
        )}
        {profile === 'code_edit' && (
          <p className="subtle">
            本次可修改目录：{repo?.write_prefixes?.join('、') || '无'}
            ；该范围会随输入一起冻结供审批。
          </p>
        )}
        <div className="form-grid">
          <Field label="明确限制" hint="每行一条；执行前保持原文。">
            <textarea
              rows={4}
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
            />
          </Field>
          <Field label="验收条件" hint="每行一条，帮助 Owner 判断成果是否达成。">
            <textarea rows={4} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} />
          </Field>
        </div>
        <div className="field">
          <span>显式引用的项目资料</span>
          <div className="reference-list">
            {sources.items
              .filter((s) => s.visibility === 'shared')
              .map((s) => (
                <label key={s.id} className="reference-item">
                  <input
                    type="checkbox"
                    checked={sourceRefs.includes(s.id)}
                    onChange={() =>
                      toggle(s.id, s.version, sourceRefs, setSourceRefs, versions.current.sources)
                    }
                  />
                  <FileText size={16} />
                  <span>{s.name}</span>
                  <small>
                    v{versions.current.sources.get(s.id) ?? s.version}
                    {sourceRefs.includes(s.id) && versions.current.sources.get(s.id) !== s.version
                      ? ' · 已改版，请重新选择'
                      : ''}
                  </small>
                </label>
              ))}
            {!sources.items.some((s) => s.visibility === 'shared') && (
              <p className="subtle">没有额外引用时，仅使用当前会话。</p>
            )}
          </div>
        </div>
        {sources.page?.has_more && (
          <Button variant="ghost" busy={sources.loading} onClick={() => void sources.more()}>
            更多可引用资料
          </Button>
        )}
        <p className="subtle">已选 {sourceRefs.length} 份资料；分页不会移除已选引用。</p>
        {(sources.error || memories.error) && (
          <p className="inline-error">{sources.error || memories.error}</p>
        )}
        {memories.items.some((m) => m.status === 'confirmed') && (
          <div className="field">
            <span>已确认的项目结论</span>
            <div className="reference-list">
              {memories.items
                .filter((m) => m.status === 'confirmed')
                .map((m) => (
                  <label key={m.id} className="reference-item">
                    <input
                      type="checkbox"
                      checked={memoryRefs.includes(m.id)}
                      onChange={() =>
                        toggle(
                          m.id,
                          m.version,
                          memoryRefs,
                          setMemoryRefs,
                          versions.current.memories,
                        )
                      }
                    />
                    <Sparkles size={16} />
                    <span>{m.title}</span>
                  </label>
                ))}
            </div>
          </div>
        )}
        {memories.page?.has_more && (
          <Button variant="ghost" busy={memories.loading} onClick={() => void memories.more()}>
            更多已确认结论
          </Button>
        )}
        <Field label="最长执行时间">
          <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
            <option value={5}>5 分钟</option>
            <option value={15}>15 分钟</option>
            <option value={30}>30 分钟</option>
          </select>
        </Field>
        {error && (
          <div role="alert" className="inline-error">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" busy={busy} disabled={!repo}>
            提交给 Owner
          </Button>
        </div>
      </form>
    </Modal>
  );
}
