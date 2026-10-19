import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountOverview } from '@team-agent/contracts';
import { api, ApiError, setCsrf } from '../../lib/api.js';
import { platform } from '../../lib/platform-api.js';
import { projectId } from '../../lib/project-scope.js';
import { LoginView } from './LoginView.js';
import { TeamWelcome } from '../organization/TeamWelcome.js';
import { Button } from '../../components/ui.js';

/** 先确定个人身份及团队资格，再挂载聊天；无团队账号不会请求默认项目的数据。 */
export function AccountGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountOverview | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const next = await platform<AccountOverview>('/account');
      if (epoch !== generation.current) return;
      setCsrf(next.user.csrf);
      setAccount(next);
      setError('');
    } catch (e) {
      if (epoch !== generation.current) return;
      setAccount(null);
      setCsrf('');
      if (!(e instanceof ApiError && e.status === 401)) setError((e as Error).message);
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const change = () => void load();
    window.addEventListener('team-agent:identity-change', change);
    return () => {
      generation.current++;
      window.removeEventListener('team-agent:identity-change', change);
    };
  }, [load]);
  if (loading)
    return (
      <div className="boot-screen">
        <p>正在连接团队…</p>
      </div>
    );
  if (!account) return <LoginView onSuccess={load} initialError={error} />;
  const selected = account.projects.some((p) => p.id === projectId());
  const join = new URLSearchParams(location.search).has('join');
  if (!selected || join)
    return (
      <main className="team-onboarding">
        <TeamWelcome account={account} />
        <div className="team-account-actions">
          <span>{account.user.email}</span>
          <Button variant="ghost" onClick={() => void api('/auth/logout', {}).then(load)}>
            切换账号
          </Button>
        </div>
      </main>
    );
  return <>{children}</>;
}
