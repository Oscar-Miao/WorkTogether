import { useState, type FormEvent } from 'react';
import { FilePlus2, FileText, LockKeyhole, Upload } from 'lucide-react';
import type { Bootstrap, Source, SourceSummary } from '@team-agent/contracts';
import { usePagedList } from '../../lib/use-paged-list.js';
import { api } from '../../lib/api.js';
import { Button, EmptyState, Field, Modal } from '../../components/ui.js';
export function SourcesView({
  data,
  onRefresh,
}: {
  data: Bootstrap;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Source | 'new' | null>(null),
    [name, setName] = useState(''),
    [content, setContent] = useState(''),
    [visibility, setVisibility] = useState<'shared' | 'owner'>('shared'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const owner = data.user.role === 'OWNER';
  const list = usePagedList<SourceSummary>('/sources');
  async function open(summary: SourceSummary | 'new') {
    setError('');
    try {
      const source =
        summary === 'new'
          ? 'new'
          : await api<Source>('/sources/' + summary.id + '?version=' + summary.version);
      setEditing(source);
      setName(source === 'new' ? '' : source.name);
      setContent(source === 'new' ? '' : source.content);
      setVisibility(source === 'new' ? 'shared' : source.visibility);
    } catch (error: any) {
      setError(error.message);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(
        editing === 'new' ? '/sources' : '/sources/' + editing!.id + '/versions',
        editing === 'new' ? { name, content, visibility } : { content, version: editing!.version },
      );
      await onRefresh();
      await list.reload();
      setEditing(null);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">PROJECT CONTEXT</span>
          <h1>项目资料</h1>
          <p>把依据放在一起，在任务中明确选择需要引用的版本。</p>
        </div>
        {owner && (
          <Button onClick={() => open('new')}>
            <FilePlus2 size={16} />
            添加资料
          </Button>
        )}
      </div>
      {(list.error || (error && !editing)) && (
        <p className="inline-error" role="alert">
          {list.error || error}
        </p>
      )}
      {!list.items.length ? (
        <EmptyState
          icon={<FileText size={29} />}
          title="为团队准备第一份资料"
          description="需求、接口说明和架构约定都可以成为任务依据。添加后仍需在任务中显式引用。"
          action={
            owner && (
              <Button variant="secondary" onClick={() => open('new')}>
                添加项目资料
              </Button>
            )
          }
        />
      ) : (
        <div className="resource-grid">
          {list.items.map((source) => (
            <button key={source.id} className="resource-card" onClick={() => open(source)}>
              <div className="resource-icon">
                <FileText size={21} />
              </div>
              <span className={'badge ' + (source.visibility === 'shared' ? 'blue' : 'neutral')}>
                {source.visibility === 'shared' ? '项目共享' : 'Owner 私有'}
              </span>
              <h3>{source.name}</h3>
              <p>{source.preview.slice(0, 120)}</p>
              <footer>
                <span>版本 {source.version}</span>
                <span>{source.character_count.toLocaleString()} 字符</span>
              </footer>
            </button>
          ))}
        </div>
      )}
      {list.page?.has_more && (
        <div className="load-more">
          <Button variant="secondary" busy={list.loading} onClick={() => void list.more()}>
            加载更多资料
          </Button>
        </div>
      )}
      {editing && (
        <Modal
          title={editing === 'new' ? '添加项目资料' : name}
          onClose={() => setEditing(null)}
          wide
        >
          <form className="modal-body" onSubmit={save}>
            {editing === 'new' && (
              <Field label="资料名称">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={120}
                />
              </Field>
            )}
            {owner && editing === 'new' && (
              <Field label="可见范围">
                <select
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as typeof visibility)}
                >
                  <option value="shared">项目成员可见</option>
                  <option value="owner">仅 Owner 可见</option>
                </select>
              </Field>
            )}
            {owner && (
              <label className="file-upload">
                <Upload size={15} />
                从文本文件导入
                <input
                  type="file"
                  accept=".txt,.md,.json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 10485760) {
                      setError('单份文本资料最多 10 MiB');
                      return;
                    }
                    void file.text().then((text) => {
                      setContent(text);
                      if (!name) setName(file.name);
                    });
                  }}
                />
              </label>
            )}
            <Field
              label="资料正文"
              hint="支持文本、Markdown 和 JSON；编辑后生成新版本，关联的待执行审批需要重新核查。"
            >
              <textarea
                className="source-editor"
                rows={16}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                required
                readOnly={!owner}
                maxLength={10485760}
              />
            </Field>
            {visibility === 'owner' && (
              <p className="privacy-note">
                <LockKeyhole size={15} />
                私有资料不会被直接加入团队共享任务。
              </p>
            )}
            {error && (
              <div className="inline-error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setEditing(null)}>
                关闭
              </Button>
              {owner && (
                <Button busy={busy} type="submit">
                  {editing === 'new' ? '添加资料' : '保存为新版本'}
                </Button>
              )}
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
