import { useEffect, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { X, LoaderCircle } from 'lucide-react';
import type { TaskState } from '@team-agent/contracts';
export function Button({
  children,
  variant = 'primary',
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={busy || props.disabled}
      className={'button ' + variant + ' ' + (props.className || '')}
    >
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={'modal ' + (wide ? 'wide' : '')}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
const states: Record<TaskState, [string, string]> = {
  DRAFT: ['草稿', 'neutral'],
  PENDING_APPROVAL: ['待审批', 'amber'],
  REJECTED: ['已拒绝', 'neutral'],
  QUEUED: ['排队中', 'blue'],
  DISPATCHING: ['准备执行', 'blue'],
  RUNNING: ['执行中', 'green'],
  CANCEL_REQUESTED: ['正在取消', 'amber'],
  RECONCILING: ['待核查', 'red'],
  SUCCEEDED: ['已完成', 'green'],
  FAILED: ['执行失败', 'red'],
  CANCELLED: ['已取消', 'neutral'],
  EXPIRED: ['审批已过期', 'neutral'],
};
export function StatusBadge({ state }: { state: TaskState }) {
  const [label, tone] = states[state];
  return (
    <span className={'badge ' + tone}>
      <span className={state === 'RUNNING' ? 'status-dot pulse' : 'status-dot'} />
      {label}
    </span>
  );
}
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span className={'avatar ' + (small ? 'small' : '')}>{name.slice(0, 1).toUpperCase()}</span>
  );
}
