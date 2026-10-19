import { useEffect, useState, type FormEvent } from 'react';
import type { AccountOverview, TeamInvitationPreview } from '@team-agent/contracts';
import { Button, Field } from '../../components/ui.js';
import { platform, enterProject, teamToken } from '../../lib/platform-api.js';

export function TeamWelcome({
  account,
  compact = false,
}: {
  account: AccountOverview;
  compact?: boolean;
}) {
  const initial = new URLSearchParams(location.search).get('join') || '';
  const [tab, setTab] = useState<'join' | 'create' | 'projects'>(
    initial ? 'join' : account.projects.length ? 'projects' : 'join',
  );
  const [input, setInput] = useState(initial),
    [preview, setPreview] = useState<TeamInvitationPreview | null>(null);
  const [name, setName] = useState(''),
    [project, setProject] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const token = teamToken(input);
  async function inspect(e?: FormEvent) {
    e?.preventDefault();
    setError('');
    setBusy(true);
    setPreview(null);
    try {
      setPreview(await platform<TeamInvitationPreview>('/team-invitations/preview', { token }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (initial) void inspect();
  }, []);
  async function accept() {
    setBusy(true);
    setError('');
    try {
      const result = await platform<{ project_id: string }>('/team-invitations/accept', { token });
      enterProject(result.project_id);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await platform<{ project_id: string }>('/teams', {
        name,
        project_name: project,
      });
      enterProject(result.project_id);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <section className={compact ? 'team-welcome compact' : 'team-welcome'}>
      {!compact && (
        <>
          <span className="eyebrow">共域 · 开始协作</span>
          <h1>你好，{account.user.name}</h1>
          <p className="muted">加入同事的团队，或创建你的团队和首个项目。</p>
        </>
      )}
      <div className="team-tabs" aria-label="团队入口">
        <button
          type="button"
          aria-pressed={tab === 'join'}
          onClick={() => {
            setTab('join');
            setError('');
          }}
        >
          加入团队
        </button>
        <button
          type="button"
          aria-pressed={tab === 'create'}
          onClick={() => {
            setTab('create');
            setError('');
          }}
        >
          创建团队
        </button>
        {!!account.projects.length && (
          <button
            type="button"
            aria-pressed={tab === 'projects'}
            onClick={() => {
              setTab('projects');
              setError('');
            }}
          >
            我的团队
          </button>
        )}
      </div>
      {tab === 'projects' && (
        <div className="team-projects">
          {account.projects.map((p) => (
            <button className="team-project" key={p.id} onClick={() => enterProject(p.id)}>
              <strong>{p.workspace}</strong>
              <span>
                {p.name} · {p.role === 'admin' ? '维护者' : '成员'}
              </span>
            </button>
          ))}
        </div>
      )}
      {tab === 'join' && (
        <>
          <form onSubmit={inspect}>
            <Field label="团队邀请链接或邀请码">
              <textarea
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setPreview(null);
                }}
                required
                rows={2}
                maxLength={2000}
                placeholder="粘贴维护者发来的邀请链接或邀请码"
              />
            </Field>
            <Button type="submit" busy={busy}>
              查看邀请
            </Button>
          </form>
          {preview && (
            <div className="team-invite-preview">
              <span>你将加入</span>
              <h3>{preview.workspace}</h3>
              <p>项目：{preview.project}</p>
              <small>
                有效期至 {new Date(preview.expires_at).toLocaleString('zh-CN')} · 剩余{' '}
                {preview.remaining_uses} 个名额
              </small>
              {preview.email_required && <p>此邀请限定受邀邮箱，请确认当前账号正确。</p>}
              <p className="muted">使用 {account.user.email} 加入，仅获得此项目的成员权限。</p>
              <Button busy={busy} onClick={() => void accept()}>
                确认加入并进入项目
              </Button>
            </div>
          )}
        </>
      )}
      {tab === 'create' && (
        <form onSubmit={create}>
          <Field label="团队名称">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
              placeholder="例如：共域产品团队"
            />
          </Field>
          <Field label="首个项目名称">
            <input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              required
              maxLength={100}
              placeholder="例如：协作平台研发"
            />
          </Field>
          <p className="muted">
            你将成为此团队和项目的维护者，可以邀请成员。Owner 主设备在进入项目后另行配对。
          </p>
          <Button type="submit" busy={busy}>
            创建团队并进入
          </Button>
        </form>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
