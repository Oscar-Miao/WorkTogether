import { useEffect, useState } from 'react';
import type { Source } from '@team-agent/contracts';
import { api } from '../../lib/api.js';
import { Button, Field } from '../../components/ui.js';
export function ResourcePanel({
  id,
  version,
  canEdit,
  onRefresh,
  onVersion,
}: {
  id: string;
  version: number;
  canEdit: boolean;
  onRefresh: () => Promise<void>;
  onVersion: (source: Source) => void;
}) {
  const [source, setSource] = useState<Source | null>(null),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false),
    [content, setContent] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setError('');
    setEditing(false);
    void api<Source>('/sources/' + id + '?version=' + version)
      .then((r) => {
        if (!cancelled) setSource(r);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id, version]);
  async function save() {
    if (!source) return;
    setBusy(true);
    setError('');
    try {
      const value = await api<Source>('/sources/' + id + '/versions', {
        content,
        version: source.version,
      });
      setSource(value);
      setEditing(false);
      onVersion(value);
      await onRefresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {source ? (
        <>
          <h3>
            {source.name} · v{source.version}
          </h3>
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Field label="资料正文">
                <textarea
                  required
                  rows={16}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </Field>
              <div className="modal-actions">
                <Button variant="secondary" onClick={() => setEditing(false)}>
                  取消编辑
                </Button>
                <Button type="submit" busy={busy}>
                  保存为新版本
                </Button>
              </div>
            </form>
          ) : (
            <>
              <pre className="c-resource">{source.content}</pre>
              {canEdit && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setContent(source.content);
                    setEditing(true);
                  }}
                >
                  编辑资料
                </Button>
              )}
            </>
          )}
        </>
      ) : (
        !error && <p>正在读取资料…</p>
      )}
    </div>
  );
}
