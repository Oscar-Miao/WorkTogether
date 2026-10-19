import { useState } from 'react';
import { chatApi } from '../../lib/chat-api.js';
import { Button, Field } from '../../components/ui.js';
export function GovernancePanel() {
  const [data, setData] = useState<any>(null),
    [coverage, setCoverage] = useState<any[]>([]),
    [audit, setAudit] = useState<any[]>([]),
    [cases, setCases] = useState<any[]>([]),
    [error, setError] = useState('');
  async function load() {
    try {
      const [m, c, a, e] = await Promise.all([
        chatApi('/governance/metrics'),
        chatApi<any[]>('/coordination/coverage'),
        chatApi<any>('/governance/audit'),
        chatApi<any[]>('/evaluations/coordination'),
      ]);
      setData(m);
      setCoverage(c);
      setAudit(a.items);
      setCases(e);
    } catch (e: any) {
      setError(e.message);
    }
  }
  function download() {
    const blob = new Blob(
      [JSON.stringify({ metrics: data, coverage, audit, evaluation_cases: cases }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '共域-当前可见范围审计.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <details
      className="c-advanced"
      onToggle={(e) => {
        if (e.currentTarget.open && !data) void load();
      }}
    >
      <summary>观察覆盖、质量与审计</summary>
      <p className="c-muted">
        只统计当前有权查看的群。缺失用量显示未知；合成评测与真实试用分开记录。
      </p>
      <Button variant="secondary" onClick={() => void load()}>
        刷新报告
      </Button>
      {data && (
        <>
          <h4>观察覆盖</h4>
          {coverage.map((c) => (
            <p key={c.id}>
              {c.title}：{c.covered ? '观察中' : '未覆盖'}，积压 {c.lag} 条
            </p>
          ))}
          <h4>模型实际用量</h4>
          {data.usage.length ? (
            data.usage.map((u: any) => (
              <p key={u.layer}>
                {u.layer === 'execution' ? '执行' : '目标理解'}：{u.responses} 个响应，输入{' '}
                {u.input_tokens ?? '未知'} / 输出 {u.output_tokens ?? '未知'} tokens，估算费用{' '}
                {u.cost_usd ?? '未知'} USD（另有 {u.unknown_cost || 0} 项费用未知）
              </p>
            ))
          ) : (
            <p>尚无已记录的模型用量。</p>
          )}
          <p>当前可见范围有 {data.uncertain.length} 项待核清执行。</p>
          <h4>质量记录</h4>
          <p>
            {cases.filter((c) => !c.synthetic).length} 条真实记录 /{' '}
            {cases.filter((c) => c.synthetic).length} 条合成记录。
          </p>
          <h4>最近协作审计</h4>
          {audit.slice(-20).map((a) => (
            <p key={a.id}>
              {a.action} · {new Date(a.created_at).toLocaleString()}
            </p>
          ))}
          <Button onClick={download}>导出当前可见范围 JSON</Button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
