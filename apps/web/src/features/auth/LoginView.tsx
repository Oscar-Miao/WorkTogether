import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Command, ShieldCheck } from 'lucide-react';
import { api, setCsrf } from '../../lib/api.js';
import { Button, Field } from '../../components/ui.js';
export function LoginView({
  onSuccess,
  initialError = '',
}: {
  onSuccess: () => Promise<void>;
  initialError?: string;
}) {
  const [oidc, setOidc] = useState(false);
  useEffect(() => {
    void fetch('/api/v3/auth/oidc/status')
      .then((r) => r.json())
      .then((r) => setOidc(!!r.data?.enabled))
      .catch(() => {});
  }, []);
  const invitation = new URLSearchParams(location.search).get('invite');
  const [email, setEmail] = useState('owner@team.local'),
    [password, setPassword] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState(initialError),
    [busy, setBusy] = useState(false),
    [accepted, setAccepted] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (invitation && !accepted) {
        await api('/invitations/accept', { token: invitation, name, password });
        setAccepted(true);
        setPassword('');
        history.replaceState({}, '', location.pathname);
        return;
      }
      const result = await api<{ csrf: string }>('/auth/login', { email, password });
      setCsrf(result.csrf);
      await onSuccess();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
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
            让执行有边界。
          </h1>
          <p>
            团队在同一处讨论、提出任务、审阅结果。
            <br />
            你的 Agent，始终由你掌控。
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
          <span className="eyebrow">YOUR SHARED WORKSPACE</span>
          <h2>{invitation && !accepted ? '加入团队' : '回到工作空间'}</h2>
          <p className="muted">
            {accepted
              ? '邀请已接受，请使用受邀邮箱和刚设置的密码登录。'
              : invitation
                ? '设置你的名字与密码，开始协作。'
                : '登录后继续团队的讨论与任务。'}
          </p>
          <form onSubmit={submit}>
            {invitation && !accepted ? (
              <Field label="你的名字">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={60}
                  autoComplete="name"
                />
              </Field>
            ) : (
              <Field label="邮箱">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="username"
                />
              </Field>
            )}
            <Field label={invitation && !accepted ? '设置密码（至少 12 位）' : '密码'}>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={invitation && !accepted ? 12 : 1}
                autoComplete={invitation && !accepted ? 'new-password' : 'current-password'}
              />
            </Field>
            {error && (
              <div role="alert" className="inline-error">
                {error}
              </div>
            )}
            <Button type="submit" busy={busy} className="full">
              {invitation && !accepted ? '接受邀请' : '进入工作空间'}
              <ArrowUpRight size={17} />
            </Button>
          </form>
          {oidc && !invitation && (
            <a className="btn full" href="/api/v3/auth/oidc/start">
              使用组织账号登录
            </a>
          )}
          {new URLSearchParams(location.search).has('project') && (
            <a className="btn full" href="/">
              返回默认项目
            </a>
          )}
          <div className="login-hint">
            <Check size={15} />
            <span>邀请制空间。首次使用请向项目维护者获取访问方式。</span>
          </div>
        </div>
      </section>
    </main>
  );
}
