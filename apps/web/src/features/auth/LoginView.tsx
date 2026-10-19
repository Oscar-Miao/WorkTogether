import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Command, ShieldCheck } from 'lucide-react';
import { api, setCsrf } from '../../lib/api.js';
import { Button, Field } from '../../components/ui.js';
import { PasswordChangeForm } from './PasswordChangeForm.js';

export function LoginView({
  onSuccess,
  initialError = '',
}: {
  onSuccess: () => Promise<void>;
  initialError?: string;
}) {
  const [oidc, setOidc] = useState(false),
    [registration, setRegistration] = useState(false);
  const [mode, setMode] = useState<'login' | 'register' | 'change'>('login');
  const [minimum, setMinimum] = useState(6),
    [notice, setNotice] = useState('');
  const invitation = new URLSearchParams(location.search).get('invite');
  const joining = new URLSearchParams(location.search).has('join');
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [confirm, setConfirm] = useState(''),
    [name, setName] = useState('');
  const [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false),
    [accepted, setAccepted] = useState(false);
  const legacy = !!invitation && !accepted,
    creating = mode === 'register';
  useEffect(() => {
    void api<{ registration_enabled: boolean; password_min_length: number }>('/auth/options')
      .then((v) => {
        setRegistration(v.registration_enabled);
        setMinimum(v.password_min_length);
      })
      .catch(() => {});
    void fetch('/api/v3/auth/oidc/status')
      .then((r) => r.json())
      .then((r) => setOidc(!!r.data?.enabled))
      .catch(() => {});
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (creating && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      if (legacy) {
        await api('/invitations/accept', { token: invitation, name, password });
        setAccepted(true);
        setPassword('');
        history.replaceState({}, '', location.pathname);
        return;
      }
      const result = await api<{ csrf: string }>(
        creating ? '/auth/register' : '/auth/login',
        creating ? { email: email.trim(), name, password } : { email: email.trim(), password },
      );
      setCsrf(result.csrf);
      await onSuccess();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function switchMode(next: 'login' | 'register' | 'change') {
    setNotice('');
    setMode(next);
    setError('');
    setPassword('');
    setConfirm('');
  }
  return (
    <main className="login-layout">
      <section className="login-story">
        <div className="brand">
          <span className="brand-mark">
            <Command size={24} />
          </span>
          <span>
            共域<small>TEAM AGENT</small>
          </span>
        </div>
        <div className="login-copy">
          <span className="eyebrow">THINK TOGETHER. BUILD WITH CONTROL.</span>
          <h1>
            让讨论有上下文，
            <br />
            让协作少些重复。
          </h1>
          <p>
            创建团队，邀请同事，在群聊里共同推进目标。
            <br />
            Agent 连接讨论、分工与执行成果。
          </p>
          <div className="login-line">
            <span />
            <span />
            <span />
          </div>
        </div>
        <div className="login-footer">
          <ShieldCheck size={17} />
          共享讨论 · 明确授权 · 本地执行
        </div>
      </section>
      <section className="login-panel">
        <div className="login-form-wrap">
          <span className="eyebrow">YOUR TEAM STARTS HERE</span>
          <h2>
            {mode === 'change'
              ? '修改密码'
              : legacy
                ? '接受团队邀请'
                : creating
                  ? '创建你的账号'
                  : '回到工作空间'}
          </h2>
          <p className="muted">
            {mode === 'change'
              ? '输入邮箱、当前密码和新密码。修改成功后，请重新登录。'
              : accepted
                ? '邀请已接受，请使用受邀邮箱和刚设置的密码登录。'
                : legacy
                  ? '设置名字与密码，加入邀请你的团队。'
                  : joining
                    ? '你收到了一份团队邀请。注册或登录后，确认团队信息即可加入。'
                    : creating
                      ? '注册后可以创建团队，或通过邀请加入同事的团队。'
                      : '使用你自己的账号，继续团队的讨论与协作。'}
          </p>
          {!legacy && registration && (
            <div className="team-tabs" aria-label="账号入口">
              <button
                type="button"
                aria-pressed={mode === 'login'}
                onClick={() => switchMode('login')}
              >
                登录
              </button>
              <button type="button" aria-pressed={creating} onClick={() => switchMode('register')}>
                注册账号
              </button>
            </div>
          )}
          {notice && (
            <p role="status" className="login-notice">
              {notice}
            </p>
          )}
          {mode === 'change' ? (
            <PasswordChangeForm
              minimum={minimum}
              email={email}
              onBack={() => switchMode('login')}
              onChanged={(value) => {
                setEmail(value);
                setPassword('');
                setConfirm('');
                setMode('login');
                setError('');
                setNotice('密码已修改，原登录会话已失效，请使用新密码登录。');
              }}
            />
          ) : (
            <form onSubmit={submit}>
              {(creating || legacy) && (
                <Field label="你的名字">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={60}
                    autoComplete="name"
                  />
                </Field>
              )}
              {!legacy && (
                <Field label="邮箱">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={254}
                    autoComplete="username"
                    placeholder="你的邮箱"
                  />
                </Field>
              )}
              <Field label={creating || legacy ? '设置密码（至少 ' + minimum + ' 位）' : '密码'}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={creating || legacy ? minimum : 1}
                  maxLength={200}
                  autoComplete={creating || legacy ? 'new-password' : 'current-password'}
                />
              </Field>
              {creating && (
                <Field label="确认密码">
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
              )}
              {error && (
                <div role="alert" className="inline-error">
                  {error}
                </div>
              )}
              <Button type="submit" busy={busy} className="full">
                {legacy ? '接受邀请' : creating ? '注册并继续' : '进入工作空间'}
                <ArrowUpRight size={17} />
              </Button>
            </form>
          )}
          {!legacy && mode === 'login' && (
            <Button variant="ghost" className="full" onClick={() => switchMode('change')}>
              修改密码
            </Button>
          )}
          {oidc && !legacy && mode === 'login' && (
            <a className="button secondary full" href="/api/v3/auth/oidc/start">
              使用组织账号登录
            </a>
          )}
          <div className="login-hint">
            <ShieldCheck size={15} />
            <span>
              {registration
                ? '每位成员使用独立账号；加入团队需要有效邀请。'
                : '此部署已关闭自主注册，请向维护者获取开户邀请。'}
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}
