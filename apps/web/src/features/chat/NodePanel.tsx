import { ProjectManager } from '../organization/ProjectControls.js';
import { GovernancePanel } from './GovernancePanel.js';
import { ExecutionControl } from './ExecutionControl.js';
import { useState } from 'react';
import type { ChatBootstrap, NodePolicy } from '@team-agent/contracts';
import { DevicesView } from '../devices/DevicesView.js';
import { Button, Field } from '../../components/ui.js';
import { chatApi } from '../../lib/chat-api.js';
export function NodePanel({
  data,
  onRefresh,
  onError,
}: {
  data: ChatBootstrap;
  onRefresh: () => Promise<void>;
  onError: (s: string) => void;
}) {
  const [policy, setPolicy] = useState<NodePolicy>(data.policy),
    [busy, setBusy] = useState(false);
  const repositories = data.devices
    .filter((d) => d.status !== 'revoked')
    .flatMap((d) => d.repositories);
  async function save() {
    setBusy(true);
    try {
      await chatApi('/node-policy', { ...policy, expected_version: data.policy_version });
      await onRefresh();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="c-node">
      <ProjectManager />
      {data.user.role === 'OWNER' && <GovernancePanel />}
      {data.user.role === 'OWNER' && (
        <ExecutionControl devices={data.devices} onRefresh={onRefresh} />
      )}
      <p className="c-panel-note">
        Owner 是运行主协调 Agent 的服务器设备。项目维护者预设权限，Agent
        在策略内判断和推进；群成员可纠正或请求停止。
      </p>
      <section className="c-policy">
        <h3>主设备执行策略</h3>
        <p className="c-muted">
          {data.coordinator.model_configured
            ? '已配置目标理解模型。'
            : '当前为规则观察：可识别明确委托与认领，尚未启用模型语义理解。'}
        </p>
        {data.user.role === 'OWNER' ? (
          <>
            <label className="c-check">
              <input
                type="checkbox"
                checked={policy.enabled}
                onChange={(e) => setPolicy({ ...policy, enabled: e.target.checked })}
              />
              启用明确委托后的自动执行
            </label>
            <Field label="绑定的代码仓库">
              <select
                value={policy.repository_id}
                onChange={(e) => setPolicy({ ...policy, repository_id: e.target.value })}
              >
                <option value="">请选择已配对设备的仓库</option>
                {repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.branch}
                  </option>
                ))}
              </select>
            </Field>
            <label className="c-check">
              <input
                type="checkbox"
                checked={policy.allow_edit}
                onChange={(e) => setPolicy({ ...policy, allow_edit: e.target.checked })}
              />
              允许在设备报告的目录内修改既有文件
            </label>
            <Field label="单次最长运行秒数">
              <input
                type="number"
                min={10}
                max={900}
                value={policy.wall_time_seconds}
                onChange={(e) =>
                  setPolicy({ ...policy, wall_time_seconds: Number(e.target.value) })
                }
              />
            </Field>
            <Field label="单次模型调用上限">
              <input
                type="number"
                min={1}
                max={20}
                value={policy.max_model_calls}
                onChange={(e) => setPolicy({ ...policy, max_model_calls: Number(e.target.value) })}
              />
            </Field>
            <Button busy={busy} onClick={() => void save()}>
              保存设备策略
            </Button>
          </>
        ) : (
          <p>
            {data.policy.enabled ? '主设备已启用受限自动执行' : '主设备尚未启用自动执行'}；代码修改
            {data.policy.allow_edit ? '按目录限制开放' : '未开放'}。
          </p>
        )}
      </section>
      <DevicesView data={data} onRefresh={onRefresh} />
    </div>
  );
}
