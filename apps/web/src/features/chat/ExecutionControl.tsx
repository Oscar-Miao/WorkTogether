import { useEffect, useState } from 'react';
import type { Device } from '@team-agent/contracts';
import { chatApi } from '../../lib/chat-api.js';
import { Field, Button } from '../../components/ui.js';
export function ExecutionControl({
  devices,
  onRefresh,
}: {
  devices: Device[];
  onRefresh: () => Promise<void>;
}) {
  const [data, setData] = useState<any>(null),
    [maxDevices, setMaxDevices] = useState(1),
    [parallel, setParallel] = useState(1),
    [node, setNode] = useState(''),
    [error, setError] = useState('');
  async function load() {
    const r = await chatApi<any>('/execution/control');
    setData(r);
    setMaxDevices(r.limits.max_devices);
    setParallel(r.limits.max_parallel);
    setNode(r.leadership.node_id || '');
  }
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, []);
  async function save(path: string, body: unknown) {
    try {
      await chatApi(path, body);
      await load();
      await onRefresh();
    } catch (e: any) {
      setError(e.message);
    }
  }
  return (
    <details className="c-advanced">
      <summary>多设备、并发与主节点代次</summary>
      <p className="c-muted">
        并发只开放给无资源冲突的步骤；代码写入排他，未知执行继续占用资源。主节点切换必须先核清原执行。
      </p>
      <Field label="活动设备配额">
        <input
          type="number"
          min={1}
          max={10}
          value={maxDevices}
          onChange={(e) => setMaxDevices(+e.target.value)}
        />
      </Field>
      <Field label="项目执行并发上限">
        <input
          type="number"
          min={1}
          max={10}
          value={parallel}
          onChange={(e) => setParallel(+e.target.value)}
        />
      </Field>
      <Button onClick={() => void save('/execution/limits', { devices: maxDevices, parallel })}>
        保存配额
      </Button>
      <Field label="项目 Owner 主设备">
        <select value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="">请选择</option>
          {devices
            .filter((d) => d.status !== 'revoked')
            .map((d) => (
              <option value={d.id} key={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </Field>
      <p className="c-muted">
        当前代次：{data?.leadership.epoch || 1}；切换不代表原进程已自动停止。
      </p>
      <Button
        disabled={!node || !data}
        onClick={() =>
          void save('/execution/node-binding', {
            node_id: node,
            expected_epoch: data.leadership.epoch,
          })
        }
      >
        绑定或更新主节点
      </Button>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
