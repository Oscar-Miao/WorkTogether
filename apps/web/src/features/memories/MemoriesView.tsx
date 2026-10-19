import { useRef, useState, type FormEvent } from 'react';
import { Check, Lightbulb, Plus, Sparkles } from 'lucide-react';
import type { Bootstrap, Memory, SourceSummary } from '@team-agent/contracts';
import { usePagedList } from '../../lib/use-paged-list.js';
import { api } from '../../lib/api.js';
import { Button, EmptyState, Field, Modal } from '../../components/ui.js';
export function MemoriesView({
  data,
  onRefresh,
}: {
  data: Bootstrap;
  onRefresh: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(''),
    [content, setContent] = useState(''),
    [refs, setRefs] = useState<string[]>([]),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const refVersions = useRef(new Map<string, number>());
  const list = usePagedList<Memory>('/memories');
  const sources = usePagedList<SourceSummary>('/sources?visibility=shared', creating);
  async function action(id: string, operation: string) {
    setBusy(id);
    setError('');
    try {
      await api('/memories/' + id + '/' + operation, {});
      await onRefresh();
      await list.reload();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy('create');
    setError('');
    try {
      await api('/memories', {
        title,
        content,
        source_refs: refs.map((id) => ({
          source_id: id,
          version: refVersions.current.get(id) ?? 0,
        })),
      });
      await onRefresh();
      await list.reload();
      setCreating(false);
      setTitle('');
      setContent('');
      setRefs([]);
      refVersions.current.clear();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">SHARED KNOWLEDGE</span>
          <h1>项目结论</h1>
          <p>值得复用的决定与验证事实，经过确认后再进入下一次任务。</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          提出结论
        </Button>
      </div>
      {list.error && <p className="inline-error">{list.error}</p>}
      {!list.items.length ? (
        <EmptyState
          icon={<Lightbulb size={30} />}
          title="让有价值的结论留下来"
          description="一次讨论中的提议不会自动成为团队共识。提出候选结论，再由 Owner 核查来源并确认。"
        />
      ) : (
        <div className="memory-list">
          {list.items.map((memory) => (
            <article className="memory-card" key={memory.id}>
              <div className="memory-card-icon">
                <Sparkles size={20} />
              </div>
              <div className="memory-card-main">
                <div className="memory-title">
                  <h3>{memory.title}</h3>
                  <span
                    className={
                      'badge ' +
                      (memory.status === 'confirmed'
                        ? 'green'
                        : memory.status === 'candidate'
                          ? 'amber'
                          : 'neutral')
                    }
                  >
                    {memory.status === 'confirmed'
                      ? '已确认'
                      : memory.status === 'candidate'
                        ? '候选结论'
                        : '已废弃'}
                  </span>
                </div>
                <p>{memory.content}</p>
                <small>
                  {memory.source_refs.length} 个资料来源 · 版本 {memory.version}
                </small>
              </div>
              {data.user.role === 'OWNER' && memory.status === 'candidate' && (
                <Button
                  variant="secondary"
                  busy={busy === memory.id}
                  onClick={() => void action(memory.id, 'confirm')}
                >
                  <Check size={14} />
                  确认
                </Button>
              )}
              {data.user.role === 'OWNER' && memory.status === 'confirmed' && (
                <Button
                  variant="ghost"
                  busy={busy === memory.id}
                  onClick={() => void action(memory.id, 'deprecate')}
                >
                  废弃
                </Button>
              )}
            </article>
          ))}
        </div>
      )}
      {list.page?.has_more && (
        <div className="load-more">
          <Button variant="secondary" busy={list.loading} onClick={() => void list.more()}>
            加载更多结论
          </Button>
        </div>
      )}
      {error && !creating && <div className="inline-error">{error}</div>}
      {creating && (
        <Modal title="提出项目结论" onClose={() => setCreating(false)}>
          <form className="modal-body" onSubmit={create}>
            <Field label="结论标题">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={120}
              />
            </Field>
            <Field label="内容与适用范围">
              <textarea
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="说明已确认的事实、适用版本，以及仍需核实的部分。"
                required
              />
            </Field>
            <div className="field">
              <span>关联来源</span>
              {sources.items
                .filter((s) => s.visibility === 'shared')
                .map((source) => (
                  <label className="reference-item" key={source.id}>
                    <input
                      type="checkbox"
                      checked={refs.includes(source.id)}
                      onChange={() => {
                        if (refs.includes(source.id)) {
                          refVersions.current.delete(source.id);
                          setRefs(refs.filter((id) => id !== source.id));
                        } else {
                          refVersions.current.set(source.id, source.version);
                          setRefs([...refs, source.id]);
                        }
                      }}
                    />
                    {source.name}
                    <small>
                      v{refVersions.current.get(source.id) ?? source.version}
                      {refs.includes(source.id) &&
                      refVersions.current.get(source.id) !== source.version
                        ? ' · 已改版，请重新选择'
                        : ''}
                    </small>
                  </label>
                ))}
            </div>
            {sources.page?.has_more && (
              <Button variant="ghost" busy={sources.loading} onClick={() => void sources.more()}>
                更多可关联资料
              </Button>
            )}
            {sources.error && <p className="inline-error">{sources.error}</p>}
            {error && <div className="inline-error">{error}</div>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCreating(false)}>
                取消
              </Button>
              <Button type="submit" busy={busy === 'create'}>
                保存为候选结论
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
