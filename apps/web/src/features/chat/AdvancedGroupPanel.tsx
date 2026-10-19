import { useState } from 'react';
import type { Group, GroupMember } from '@team-agent/contracts';
import { chatApi } from '../../lib/chat-api.js';
import { Button, Field } from '../../components/ui.js';

export function AdvancedGroupPanel({
  group,
  userId,
  onRefresh,
  onChoose,
  members = [],
}: {
  group: Group;
  members?: GroupMember[];
  userId: string;
  onRefresh: () => Promise<void>;
  onChoose: (id: string) => void;
}) {
  const [title, setTitle] = useState(group.title + ' · 方案讨论'),
    [reason, setReason] = useState('从当前讨论形成独立方案'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [manager, setManager] = useState('');
  const created = (group.manager_id || group.created_by) === userId;
  async function action(input: unknown) {
    setBusy(true);
    setError('');
    try {
      const r = await chatApi<{ id: string }>('/groups/' + group.id + '/lifecycle', input);
      await onRefresh();
      if ((input as any).action === 'fork') onChoose(r.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const policy = group.agent_policy || { observe: true, muted: false, mode: 'observe' as const };
  return (
    <details className="c-advanced">
      <summary>群设置与讨论分叉</summary>
      <p className="c-muted">
        {group.archived_at
          ? '此群已归档，可读取历史。'
          : '讨论分叉会保留截止点与当时成员，之后的消息分别推进。'}
      </p>
      {created && (
        <>
          <label className="c-check">
            <input
              type="checkbox"
              checked={policy.observe}
              onChange={(e) =>
                void chatApi('/groups/' + group.id + '/agent-policy', {
                  ...policy,
                  observe: e.target.checked,
                })
                  .then(onRefresh)
                  .catch((e: Error) => setError(e.message))
              }
            />
            持续观察讨论
          </label>
          <Button
            busy={busy}
            variant="secondary"
            onClick={() => void action({ action: group.archived_at ? 'restore' : 'archive' })}
          >
            {group.archived_at ? '恢复群聊' : '归档群聊并停止旧执行'}
          </Button>
        </>
      )}
      {(created || group.manager_active === false) && (
        <>
          <Field label="移交群管理给">
            <select value={manager} onChange={(e) => setManager(e.target.value)}>
              <option value="">请选择</option>
              {members
                .filter((m) => m.id !== userId || group.manager_active === false)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
          </Field>
          <Button
            disabled={!manager}
            onClick={() => void action({ action: 'transfer_manager', user_id: manager })}
          >
            移交群管理
          </Button>
        </>
      )}
      {!group.archived_at && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action({ action: 'fork', title, reason });
          }}
        >
          <Field label="分叉群名称">
            <input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </Field>
          <Field label="方案说明">
            <input value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          <Button type="submit" busy={busy}>
            从当前消息分叉
          </Button>
        </form>
      )}
      {!created && group.visibility !== 'project' && (
        <Button variant="secondary" busy={busy} onClick={() => void action({ action: 'leave' })}>
          退出群聊
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
