import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  GitBranch,
  Laptop,
  Link2,
  ShieldCheck,
  UserPlus,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { Bootstrap, WorkspaceMember } from '@team-agent/contracts';
import { projectPrefix, projectId } from '../../lib/project-scope.js';
import { api, timeLabel } from '../../lib/api.js';
import { Button, EmptyState, Field, Modal } from '../../components/ui.js';
export function DevicesView({
  data,
  onRefresh,
}: {
  data: Pick<Bootstrap, 'user' | 'devices'> & { leadership?: { node_id: string | null } };
  onRefresh: () => Promise<void>;
}) {
  const owner = data.user.role === 'OWNER';
  const [pair, setPair] = useState<{ code: string; expires_at: string } | null>(null),
    [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [invite, setInvite] = useState(false),
    [email, setEmail] = useState(''),
    [inviteLink, setInviteLink] = useState(''),
    [copied, setCopied] = useState(false);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  async function loadMembers() {
    setMembers(await api<WorkspaceMember[]>('/members'));
  }
  useEffect(() => {
    if (owner) void loadMembers().catch((error: Error) => setError(error.message));
  }, [owner]);
  async function removeMember(id: string) {
    setBusy(id);
    setError('');
    try {
      await api('/members/' + id + '/remove', {});
      await loadMembers();
      await onRefresh();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  async function createPair() {
    setBusy('pair');
    setError('');
    try {
      setPair(await api('/pairing-codes', {}));
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  async function createInvite() {
    setBusy('invite');
    setError('');
    try {
      const result = await api<{ token: string }>('/invitations', { email });
      setInviteLink(location.origin + '/?invite=' + encodeURIComponent(result.token));
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    setError('');
    try {
      await api('/devices/' + id + '/revoke', {});
      await onRefresh();
    } catch (error: any) {
      setError(error.message);
    } finally {
      setBusy('');
    }
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('复制失败，请手动选择内容复制。');
    }
  }
  const current =
    data.devices.find((d) => d.id === data.leadership?.node_id) ||
    data.devices.find((d) => d.status !== 'revoked');
  return (
    <div className="page-content">
      <div className="page-heading">
        <div>
          <span className="eyebrow">LOCAL EXECUTION</span>
          <h2>主设备与团队</h2>
          <p>连接承载 Agent 的主设备；执行范围由设备策略限定。</p>
        </div>
        {owner && (
          <div className="inline-actions">
            <Button
              variant="secondary"
              onClick={() => {
                setInvite(true);
                setInviteLink('');
                setError('');
              }}
            >
              <UserPlus size={16} />
              邀请成员
            </Button>
            <Button onClick={() => void createPair()} busy={busy === 'pair'}>
              <Link2 size={16} />
              连接设备
            </Button>
          </div>
        )}
      </div>
      {!current ? (
        <EmptyState
          icon={<Laptop size={32} />}
          title="还没有连接本地设备"
          description="维护者在主设备启动 Bridge，绑定团队允许使用的 Git 仓库。"
          action={
            owner && (
              <Button variant="secondary" onClick={() => void createPair()}>
                生成一次性配对码
              </Button>
            )
          }
        />
      ) : (
        <article className="device-card">
          <div className="device-illustration">
            <Laptop size={48} strokeWidth={1.2} />
            <span
              className={current.status === 'online' ? 'online-indicator' : 'offline-indicator'}
            />
          </div>
          <div className="device-information">
            <div className="device-heading">
              <h2>{current.name}</h2>
              <span className={'badge ' + (current.status === 'online' ? 'green' : 'neutral')}>
                {current.status === 'online' ? <Wifi size={13} /> : <WifiOff size={13} />}{' '}
                {current.status === 'online' ? '在线' : '离线'}
              </span>
            </div>
            <p>
              {current.runtime === 'pi'
                ? 'Pi Agent · 可调用本机配置的模型'
                : '确定性只读检查 · 不调用 AI 模型'}
            </p>
            <small>
              {current.last_seen
                ? '最近连接 ' + timeLabel(current.last_seen)
                : '等待 Bridge 首次连接'}
            </small>
            <div className="repo-bindings">
              {current.repositories.map((repo) => (
                <div key={repo.id}>
                  <GitBranch size={16} />
                  <strong>{repo.name}</strong>
                  <span>{repo.branch}</span>
                  <code>{repo.base_commit.slice(0, 10)}</code>
                </div>
              ))}
            </div>
          </div>
          {owner && (
            <Button
              variant="ghost"
              busy={busy === current.id}
              onClick={() => void revoke(current.id)}
            >
              撤销设备
            </Button>
          )}
        </article>
      )}
      {data.devices
        .filter((d) => d.status !== 'revoked' && d.id !== current?.id)
        .map((d) => (
          <article key={d.id} className="device-card">
            <div>
              <h3>{d.name} · Runner</h3>
              <p>
                {d.status === 'online' ? '在线' : '离线'} ·{' '}
                {d.repositories.map((r) => r.name).join('、')}
              </p>
            </div>
            {owner && (
              <Button variant="ghost" onClick={() => void revoke(d.id)}>
                撤销此 Runner
              </Button>
            )}
          </article>
        ))}
      <div className="info-grid">
        <article>
          <ShieldCheck size={21} />
          <h3>每次执行都可审查</h3>
          <p>任务明确关联资料版本与代码基线。批准请求不会开放整个本机环境。</p>
        </article>
        <article>
          <GitBranch size={21} />
          <h3>独立任务目录</h3>
          <p>每个任务使用单独 worktree，保留差异供核查，取消也不会自动回滚文件。</p>
        </article>
      </div>
      {owner && (
        <section className="members-panel">
          <header>
            <div>
              <h2>空间成员</h2>
              <p>
                {members.filter((m) => m.active).length} / 10 位有效成员 ·
                权限由维护者配置，执行判断由主 Agent 作出
              </p>
            </div>
            <Button
              variant="ghost"
              aria-label="刷新成员"
              onClick={() => void loadMembers().catch((error: Error) => setError(error.message))}
            >
              刷新
            </Button>
          </header>
          <div role="list" aria-label="空间成员">
            {members.map((member) => (
              <div role="listitem" key={member.id} className="member-row">
                <div>
                  <strong>{member.name}</strong>
                  <small>{member.email}</small>
                </div>
                <span className={'badge ' + (member.active ? 'green' : 'neutral')}>
                  {member.role === 'OWNER' ? '项目维护者' : member.active ? 'Member' : '已移除'}
                </span>
                {member.active && member.role === 'MEMBER' && (
                  <Button
                    variant="ghost"
                    busy={busy === member.id}
                    onClick={() => void removeMember(member.id)}
                  >
                    移除
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {error && !pair && !invite && <div className="inline-error">{error}</div>}
      {pair && (
        <Modal title="连接 Owner 主设备" onClose={() => setPair(null)} wide>
          <div className="modal-body">
            <div className="form-notice">
              <ShieldCheck size={20} />
              <p>
                配对码仅使用一次，5 分钟有效。请在你自己的电脑上运行下面的命令，并替换仓库路径。
              </p>
            </div>
            <ol className="setup-steps">
              <li>在 demo 工程根安装依赖，并确认目标目录已是 Git 仓库。</li>
              <li>运行 Bridge。先用只读检查验证链路，再切换为已配置模型的 Pi。</li>
            </ol>
            <div className="code-panel">
              <code>
                {'pnpm bridge -- --pair ' +
                  pair.code +
                  ' --api "' +
                  location.origin +
                  projectPrefix() +
                  '" --repo "D:/your-repo" --runtime inspection --data-dir ".local/bridge/' +
                  projectId() +
                  '-' +
                  pair.code.slice(0, 8) +
                  '"'}
              </code>
              <button
                className="icon-button"
                aria-label="复制连接命令"
                onClick={() =>
                  void copy(
                    'pnpm bridge -- --pair ' +
                      pair.code +
                      ' --api "' +
                      location.origin +
                      projectPrefix() +
                      '" --repo "D:/your-repo" --runtime inspection --data-dir ".local/bridge/' +
                      projectId() +
                      '-' +
                      pair.code.slice(0, 8) +
                      '"',
                  )
                }
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </button>
            </div>
            <p className="subtle">
              有效期至 {timeLabel(pair.expires_at)}。Pi 模式与模型凭证配置见工程 README。
            </p>
            {error && <div className="inline-error">{error}</div>}
            <div className="modal-actions">
              <Button
                onClick={() => {
                  setPair(null);
                  void onRefresh();
                }}
              >
                已在本机运行
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {invite && (
        <Modal title="邀请团队成员" onClose={() => setInvite(false)}>
          <form
            className="modal-body"
            onSubmit={(event) => {
              event.preventDefault();
              void createInvite();
            }}
          >
            <p className="muted">
              成员可建群、讨论、认领、委托 Agent、纠正判断和请求停止；执行受主设备策略约束。
            </p>
            <Field label="受邀邮箱">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
            {inviteLink && (
              <div className="invite-result">
                <span className="badge green">邀请已生成 · 24 小时有效</span>
                <div className="code-panel">
                  <code>{inviteLink}</code>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="复制邀请链接"
                    onClick={() => void copy(inviteLink)}
                  >
                    <Copy size={16} />
                  </button>
                </div>
                <p className="subtle">请将链接发送给对应成员；该链接只能使用一次。</p>
              </div>
            )}
            {error && <div className="inline-error">{error}</div>}
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setInvite(false)}>
                关闭
              </Button>
              <Button type="submit" busy={busy === 'invite'}>
                生成邀请链接
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
