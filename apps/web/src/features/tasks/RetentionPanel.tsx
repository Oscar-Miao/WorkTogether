import { useEffect, useState } from 'react';
import type { RetentionPreview, Task } from '@team-agent/contracts';
import { api } from '../../lib/api.js';
import { Button } from '../../components/ui.js';

export function RetentionPanel({
  task,
  onRefresh,
}: {
  task: Task;
  onRefresh: () => Promise<void>;
}) {
  const [preview, setPreview] = useState<RetentionPreview>();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    api<RetentionPreview>('/tasks/' + task.id + '/retention')
      .then((value) => {
        if (current) {
          setPreview(value);
          setError('');
        }
      })
      .catch((error) => {
        if (current) setError(error.message);
      });
    return () => {
      current = false;
    };
  }, [task.id, task.version]);
  async function change(action: 'retention-hold' | 'cleanup') {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      // The displayed version binds the action to this preview; stale previews fail closed.
      await api('/tasks/' + task.id + '/' + action, {
        version: preview.version,
        reason,
        ...(action === 'retention-hold' ? { hold: !preview.retention_hold } : {}),
      });
      await onRefresh();
      setPreview(await api<RetentionPreview>('/tasks/' + task.id + '/retention'));
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="detail-section">
      <h3>保留与清理</h3>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!preview ? (
        <p>正在读取影响范围…</p>
      ) : (
        <>
          <p>{preview.scope}</p>
          <p>
            原始日志 {preview.raw_events} 条（{preview.raw_event_bytes} 字节），未共享成果{' '}
            {preview.private_artifacts.length} 份。
          </p>
          {preview.private_artifacts.map((item) => (
            <p key={item.id}>
              {item.title} · {item.bytes} 字节
            </p>
          ))}
          <p>
            {preview.retention_hold
              ? '已暂停清理：' + preview.retention_hold_reason
              : '未设置保留标记'}
          </p>
          {!preview.enabled && (
            <p className="form-notice">清理执行默认关闭，当前可预览范围和标记保留。</p>
          )}
          <label className="field">
            <span>操作原因</span>
            <textarea
              rows={2}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <Button
              variant="secondary"
              busy={busy}
              disabled={!reason.trim()}
              onClick={() => void change('retention-hold')}
            >
              {preview.retention_hold ? '解除保留标记' : '标记保留'}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={!reason.trim() || !preview.can_clean}
              onClick={() => void change('cleanup')}
            >
              清理上述正文
            </Button>
          </div>
          <p className="subtle">
            正文清理后无法从平台回读；活动执行及待核查任务受保护。每次操作均记录原因。
          </p>
        </>
      )}
    </section>
  );
}
