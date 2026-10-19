import { useEffect, useState, type FormEvent } from 'react';
import type { Group } from '@team-agent/contracts';
import { Modal, Field, Button } from '../../components/ui.js';
import { chatApi } from '../../lib/chat-api.js';
export function GroupDialog({
  onClose,
  onJoined,
}: {
  onClose: () => void;
  onJoined: (id: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<'create' | 'join' | 'discover'>('create'),
    [title, setTitle] = useState(''),
    [description, setDescription] = useState(''),
    [visibility, setVisibility] = useState('public'),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [groups, setGroups] = useState<Group[]>([]);
  useEffect(() => {
    if (tab === 'discover')
      void chatApi<Group[]>('/groups?discover=true')
        .then(setGroups)
        .catch((e) => setError(e.message));
  }, [tab]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await chatApi<{ id: string }>(
        tab === 'create' ? '/groups' : '/group-invites/join',
        tab === 'create' ? { title, description, visibility } : { token },
      );
      await onJoined(r.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="创建或加入群聊" onClose={onClose}>
      <div className="modal-body">
        <div className="c-tabs">
          {(['create', 'join', 'discover'] as const).map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              onClick={() => {
                setTab(t);
                setError('');
              }}
            >
              {t === 'create' ? '创建群聊' : t === 'join' ? '邀请码加入' : '发现群聊'}
            </button>
          ))}
        </div>
        {tab === 'discover' ? (
          <div>
            {groups
              .filter((g) => !g.joined)
              .map((g) => (
                <div className="c-member" key={g.id}>
                  <div>
                    <strong>{g.title}</strong>
                    <small>
                      {g.member_count} 位成员 · {g.description || '项目公开群'}
                    </small>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void chatApi<{ id: string }>('/groups/' + g.id + '/join', {})
                        .then((r) => onJoined(r.id))
                        .catch((e) => setError(e.message))
                    }
                  >
                    加入
                  </Button>
                </div>
              ))}
            {!groups.some((g) => !g.joined) && (
              <p className="c-muted">暂无可加入的公开群；私有群需要邀请码。</p>
            )}
          </div>
        ) : (
          <form onSubmit={submit}>
            {tab === 'create' ? (
              <>
                <Field label="群聊名称">
                  <input
                    required
                    value={title}
                    maxLength={100}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="例如：产品研发组"
                  />
                </Field>
                <Field label="群聊简介">
                  <textarea
                    value={description}
                    maxLength={500}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <Field label="加入方式">
                  <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    <option value="public">项目内公开，可自主加入</option>
                    <option value="private">私有，仅邀请码加入</option>
                  </select>
                </Field>
                <p className="c-muted">
                  主设备 Agent 将观察本群讨论。其他未加入成员不能读取私群内容。
                </p>
              </>
            ) : (
              <Field label="群邀请码">
                <input required value={token} onChange={(e) => setToken(e.target.value.trim())} />
              </Field>
            )}
            <div className="modal-actions">
              <Button variant="secondary" onClick={onClose}>
                取消
              </Button>
              <Button type="submit" busy={busy}>
                {tab === 'create' ? '创建并进入' : '加入群聊'}
              </Button>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
