import { useEffect, useState } from 'react';
import type { ProjectScope } from '@team-agent/contracts';
import { csrfToken, ApiError } from '../../lib/api.js';
import { projectId } from '../../lib/project-scope.js';
import { Button, Field, Modal } from '../../components/ui.js';

async function platform<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch('/api/v3' + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok)
    throw new ApiError(
      value.error?.code || 'HTTP_ERROR',
      value.error?.message || '操作失败',
      response.status,
    );
  return value.data;
}
function switchProject(id: string) {
  // 整页重建隔离旧侧栏、草稿引用和后台请求，避免跨项目响应覆盖新范围。
  const next = new URL(location.href);
  next.searchParams.set('project', id);
  location.assign(next);
}
export function ProjectSelector() {
  const [projects, setProjects] = useState<ProjectScope[]>([]),
    [open, setOpen] = useState(false);
  useEffect(() => {
    void platform<ProjectScope[]>('/projects')
      .then(setProjects)
      .catch(() => {});
  }, []);
  if (projects.length < 2) return null;
  return (
    <>
      <button className="c-icon" aria-label="切换空间或项目" onClick={() => setOpen(true)}>
        ⇄
      </button>
      {open && (
        <Modal title="切换空间与项目" onClose={() => setOpen(false)}>
          <div className="modal-body">
            {projects.map((p) => (
              <button
                className="c-advanced-choice"
                key={p.id}
                onClick={() => switchProject(p.id)}
                aria-current={p.id === projectId() ? 'true' : undefined}
              >
                {p.workspace} / {p.name}
                {p.id === projectId() ? ' · 当前' : ''}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
export function ProjectManager() {
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; role: string }[]>([]);
  const [projects, setProjects] = useState<ProjectScope[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [workspace, setWorkspace] = useState(''),
    [name, setName] = useState(''),
    [newWorkspace, setNewWorkspace] = useState(''),
    [email, setEmail] = useState(''),
    [members, setMembers] = useState<any[]>([]);
  const load = async () => {
    const [p, w] = await Promise.all([
      platform<ProjectScope[]>('/projects'),
      platform<{ id: string; name: string; role: string }[]>('/workspaces'),
    ]);
    setProjects(p);
    setWorkspaces(w);
  };
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, []);
  const current = projects.find((p) => p.id === projectId());
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      let id = workspace || current?.workspace_id || 'workspace_default';
      if (newWorkspace.trim())
        id = (await platform<{ id: string }>('/workspaces', { name: newWorkspace })).id;
      const p = await platform<{ id: string }>('/workspaces/' + id + '/projects', { name });
      switchProject(p.id);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await platform('/projects/' + projectId() + '/members', { email, role: 'member' });
      setEmail('');
      setMembers(await platform<any[]>('/projects/' + projectId() + '/members'));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="c-advanced">
      <summary>空间、项目与成员范围</summary>
      <p className="c-muted">
        每个项目独立保存群聊、资料、执行策略和设备。已有账号需要显式加入其他项目。
      </p>
      {projects.map((p) => (
        <button key={p.id} className="c-advanced-choice" onClick={() => switchProject(p.id)}>
          {p.workspace} / {p.name} · {p.role === 'admin' ? '维护者' : '成员'}
        </button>
      ))}
      <form onSubmit={create}>
        <Field label="在已有空间创建">
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">当前空间</option>
            {workspaces.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="或创建新空间">
          <input
            value={newWorkspace}
            onChange={(e) => setNewWorkspace(e.target.value)}
            placeholder="留空则使用上方空间"
          />
        </Field>
        <Field label="新项目名称">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        </Field>
        <Button type="submit" busy={busy}>
          创建项目并进入
        </Button>
      </form>
      {current?.role === 'admin' && (
        <>
          <form onSubmit={add}>
            <Field label="添加已有团队账号">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="成员邮箱"
              />
            </Field>
            <Button type="submit" busy={busy}>
              加入当前项目
            </Button>
          </form>
          <Button
            variant="secondary"
            onClick={() =>
              void platform<any[]>('/projects/' + projectId() + '/members')
                .then(setMembers)
                .catch((e: Error) => setError(e.message))
            }
          >
            查看项目成员
          </Button>
          {members.map((m) => (
            <div className="c-advanced-row" key={m.id}>
              {m.name} · {m.email}
              {m.role !== 'admin' && (
                <button
                  onClick={() =>
                    void platform('/projects/' + projectId() + '/members/' + m.id + '/remove', {})
                      .then(() => setMembers((old) => old.filter((x) => x.id !== m.id)))
                      .catch((e: Error) => setError(e.message))
                  }
                >
                  移出项目
                </button>
              )}
            </div>
          ))}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
