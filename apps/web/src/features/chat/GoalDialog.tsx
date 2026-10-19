import { useState } from 'react';
import type { Goal } from '@team-agent/contracts';
import { Modal, Field, Button } from '../../components/ui.js';
import { chatApi } from '../../lib/chat-api.js';
import type { GoalAction } from './GoalCard.js';
export function GoalDialog({
  goal,
  action,
  onClose,
  onDone,
}: {
  goal: Goal;
  action: GoalAction;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [title, setTitle] = useState(goal.title),
    [constraints, setConstraints] = useState(goal.constraints.join('\n')),
    [acceptance, setAcceptance] = useState(goal.acceptance.join('\n')),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const label =
    action === 'review'
      ? '补充差异并复核'
      : action === 'stop'
        ? '请求停止'
        : action === 'complete'
          ? '登记人工完成'
          : '确认人工认领';
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await chatApi(
        '/goals/' + goal.id + '/' + action,
        action === 'review'
          ? {
              title,
              constraints: constraints.split('\n').filter(Boolean),
              acceptance: acceptance.split('\n').filter(Boolean),
              reason,
              expected_version: goal.version,
            }
          : action === 'stop'
            ? { reason }
            : action === 'complete'
              ? { version: goal.version, evidence: reason }
              : { version: goal.version },
      );
      await onDone();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={label} onClose={onClose}>
      <form
        className="modal-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="c-dialog-goal">{goal.title}</p>
        {action === 'review' && (
          <>
            <Field label="修正后的目标">
              <textarea
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={2000}
              />
            </Field>
            <Field label="约束（每行一项）">
              <textarea value={constraints} onChange={(e) => setConstraints(e.target.value)} />
            </Field>
            <Field label="验收条件（每行一项）">
              <textarea
                required
                value={acceptance}
                onChange={(e) => setAcceptance(e.target.value)}
              />
            </Field>
          </>
        )}
        {action !== 'claim' && (
          <Field label={action === 'complete' ? '成果链接或完成证据' : '原因 / 与既有工作的差异'}>
            <textarea
              required
              minLength={action === 'complete' ? 4 : 1}
              maxLength={1000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        )}
        {action === 'stop' && (
          <p className="c-muted">先保存停止意图，待执行器确认后显示已停止；已有修改和成果保留。</p>
        )}
        {action === 'claim' && (
          <p className="c-muted">确认后将登记你负责此范围，主 Agent 会将它纳入重复工作比对。</p>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" busy={busy}>
            {label}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
