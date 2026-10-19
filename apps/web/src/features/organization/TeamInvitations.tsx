import { useEffect, useState, type FormEvent } from 'react';
import type { TeamInvitationRecord } from '@team-agent/contracts';
import { Button, Field } from '../../components/ui.js';
import { platform } from '../../lib/platform-api.js';

export function TeamInvitations({ project }: { project: string }) {
  const [rows, setRows] = useState<TeamInvitationRecord[]>([]),
    [email, setEmail] = useState(''),
    [uses, setUses] = useState(1),
    [hours, setHours] = useState(24);
  const [link, setLink] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  const base = '/projects/' + project + '/invitations';
  const load = () => platform<TeamInvitationRecord[]>(base).then(setRows);
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [project]);
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setCopied(false);
    try {
      const invitation = await platform<{ token: string }>(base, {
        ...(email.trim() ? { email: email.trim() } : {}),
        expires_hours: hours,
        max_uses: uses,
      });
      const url = new URL(location.origin + location.pathname);
      url.searchParams.set('join', invitation.token);
      setLink(url.toString());
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="team-invitations">
      <summary>邀请成员加入当前团队与项目</summary>
      <p className="muted">新同事可以先注册，再使用此邀请加入。已有账号可直接接受邀请。</p>
      <form onSubmit={create}>
        <Field label="限定受邀邮箱（可选）">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="留空则持链接者均可加入"
          />
        </Field>
        <div className="team-form-row">
          <Field label="邀请名额">
            <input
              type="number"
              min={1}
              max={100}
              required
              value={uses}
              onChange={(e) => setUses(Number(e.target.value))}
            />
          </Field>
          <Field label="有效小时数">
            <input
              type="number"
              min={1}
              max={168}
              required
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
            />
          </Field>
        </div>
        <Button type="submit" busy={busy}>
          生成团队邀请
        </Button>
      </form>
      {link && (
        <div className="team-share">
          <Field label="团队邀请链接">
            <textarea aria-label="团队邀请链接" value={link} readOnly rows={3} />
          </Field>
          <Button
            variant="secondary"
            onClick={() =>
              void navigator.clipboard
                .writeText(link)
                .then(() => setCopied(true))
                .catch(() => setError('复制失败，请选中链接手动复制'))
            }
          >
            {copied ? '已复制' : '复制邀请链接'}
          </Button>
          <small>链接只在生成时展示，请及时分享给同事。</small>
        </div>
      )}
      <div className="team-invitation-list">
        {rows.map((row) => (
          <div key={row.id}>
            <span>
              {row.email || '持链接加入'} · {row.used_count}/{row.max_uses} 人<br />
              <small>
                {row.revoked_at
                  ? '已撤销'
                  : new Date(row.expires_at).getTime() <= Date.now()
                    ? '已过期'
                    : '有效期至 ' + new Date(row.expires_at).toLocaleString('zh-CN')}
              </small>
            </span>
            {!row.revoked_at && (
              <Button
                variant="ghost"
                onClick={() => {
                  setError('');
                  void platform(base + '/' + row.id + '/revoke', {})
                    .then(() => {
                      setLink('');
                      return load();
                    })
                    .catch((e: Error) => setError(e.message));
                }}
              >
                撤销邀请
              </Button>
            )}
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
    </details>
  );
}
