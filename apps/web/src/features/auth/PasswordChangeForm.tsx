import { useState, type FormEvent } from 'react';
import { api, setCsrf } from '../../lib/api.js';
import { Button, Field } from '../../components/ui.js';

/** 登录页凭当前密码完成改密，不依赖邮箱验证码，也不提供免验证的密码重置。 */
export function PasswordChangeForm({
  minimum,
  email: initialEmail,
  onChanged,
  onBack,
}: {
  minimum: number;
  email: string;
  onChanged: (email: string) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState(initialEmail),
    [current, setCurrent] = useState(''),
    [next, setNext] = useState(''),
    [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (next !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', {
        email: email.trim(),
        current_password: current,
        new_password: next,
      });
      setCsrf('');
      onChanged(email.trim());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <Field label="邮箱">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          maxLength={254}
          autoComplete="username"
        />
      </Field>
      <Field label="当前密码">
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
          maxLength={200}
          autoComplete="current-password"
        />
      </Field>
      <Field label={'新密码（至少 ' + minimum + ' 位）'}>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={minimum}
          maxLength={200}
          autoComplete="new-password"
        />
      </Field>
      <Field label="确认新密码">
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={minimum}
          maxLength={200}
          autoComplete="new-password"
        />
      </Field>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      <Button type="submit" busy={busy} className="full">
        确认修改密码
      </Button>
      <Button variant="ghost" onClick={onBack} disabled={busy}>
        返回登录
      </Button>
    </form>
  );
}
