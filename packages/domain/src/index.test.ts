import { describe, expect, it } from 'vitest';
import {
  approvalFingerprint,
  assertTransition,
  canonical,
  compactMessages,
  renderContext,
} from './index.js';
import type { Message, TaskInput } from '@team-agent/contracts';

const input: TaskInput = {
  conversation_id: 'conv_test',
  goal: '审阅退款逻辑',
  constraints: ['禁止外发代码'],
  acceptance: ['只给出有证据的结论'],
  source_refs: [],
  memory_refs: [],
  repository_binding_id: 'repo_test',
  base_commit: 'a'.repeat(40),
  execution_profile: 'code_review',
  budget: { wall_time_seconds: 60, max_model_calls: 5 },
};
describe('authorization and state invariants', () => {
  it('binds approvals to scope, code baseline, budget and result audience', () => {
    const original = approvalFingerprint(input, 'snapshot-a', 'device-a');
    for (const changed of [
      { goal: '修改退款逻辑' },
      { base_commit: 'b'.repeat(40) },
      { constraints: [] },
      { conversation_id: 'conv_other' },
      { budget: { wall_time_seconds: 120, max_model_calls: 5 } },
      { execution_profile: 'code_edit' },
    ]) {
      expect(
        approvalFingerprint({ ...input, ...changed } as TaskInput, 'snapshot-a', 'device-a'),
      ).not.toBe(original);
    }
    expect(approvalFingerprint(input, 'snapshot-b', 'device-a')).not.toBe(original);
    expect(approvalFingerprint(input, 'snapshot-a', 'device-b')).not.toBe(original);
  });
  it('keeps terminal states final and unknown execution out of the queue', () => {
    expect(() => assertTransition('SUCCEEDED', 'RUNNING')).toThrow();
    expect(() => assertTransition('RECONCILING', 'QUEUED')).toThrow();
    expect(() => assertTransition('CANCEL_REQUESTED', 'CANCELLED')).not.toThrow();
    expect(() => assertTransition('RECONCILING', 'FAILED')).not.toThrow();
  });
  it('canonicalizes object ordering without changing array meaning', () => {
    expect(canonical({ b: 2, a: { y: 4, x: 3 } })).toBe(canonical({ a: { x: 3, y: 4 }, b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
});

const criticalCases = [
  '禁止使用生产数据库',
  '不得推送远程分支',
  '撤销上次自动执行建议',
  '之前的方案已否决',
  '当前实现未验证',
  '测试失败，不能宣布通过',
  '确认只读分析，不修改代码',
  '约束：仅检查 src 目录',
  '改为先核查再执行',
  '从未确认可删除数据',
  'never execute shell commands',
  'must preserve the approved scope',
  'reject the earlier proposal',
  'build failed before tests ran',
  '报价未经确认',
  '不允许读取其他项目资料',
  '删除建议没有被确认',
  '失败结果不得作为成功记忆',
  '禁止分享原始私有输出',
  '约束变更需要重新审批',
  '未验证跨平台行为',
  '撤销设备后停止续租',
  '改为逐项人工核查',
  '不覆盖 Owner 日常工作目录',
  '模型建议不构成许可',
  '确认测试状态为未运行',
  '禁止将会话分叉当 Git 分支',
  '未确认进程停止不能重派',
  '约束：当前消息只是候选意见',
  '不允许摘要扩大资料权限',
];
describe('compression provenance regression examples', () => {
  for (const [index, critical] of criticalCases.entries()) {
    it('retains exact critical evidence ' + (index + 1), () => {
      const messages: Message[] = Array.from({ length: 14 }, (_, i) => ({
        id: 'msg_' + i,
        conversation_id: 'conv_test',
        seq: i + 1,
        author_id: 'user_test',
        author_name: '成员',
        body: i === 0 ? '普通背景\n' + critical : '普通讨论 ' + i,
        created_at: new Date(0).toISOString(),
      }));
      const compacted = compactMessages(messages);
      expect(compacted.recent_messages).toHaveLength(12);
      expect(compacted.historical_excerpts[0].excerpt).toBe(critical);
      expect(compacted.historical_excerpts[0].message_id).toBe('msg_0');
      const context = renderContext({
        id: 'ctx_test',
        conversation_id: 'conv_test',
        cutoff_seq: 14,
        goal: input.goal,
        constraints: input.constraints,
        acceptance: input.acceptance,
        evidence: [],
        ...compacted,
      });
      expect(context).toContain('禁止外发代码');
      expect(context).toContain('历史摘录并不代表已确认决策');
    });
  }
  it('cannot drop a late prohibition behind a long background paragraph', () => {
    const message = {
      id: 'late',
      conversation_id: 'conv_test',
      seq: 1,
      author_id: 'member',
      author_name: '成员',
      created_at: new Date(0).toISOString(),
      body: '方案背景'.repeat(600) + '，禁止删除现有付款记录；先核对再推进。',
    } as Message;
    expect(compactMessages([message], 0).historical_excerpts[0].excerpt).toContain(
      '禁止删除现有付款记录',
    );
  });
  it('blocks new execution when exact critical material cannot fit the summary budget', () => {
    const message = {
      id: 'overflow',
      conversation_id: 'conv_test',
      seq: 1,
      author_id: 'member',
      author_name: '成员',
      created_at: new Date(0).toISOString(),
      body: '禁止删除。'.repeat(4000),
    } as Message;
    expect(() => compactMessages([message], 0)).toThrow('关键限制超过整理预算');
  });
  it('keeps long critical text intact rather than dropping later constraints', () => {
    const message = {
      id: 'msg_long',
      conversation_id: 'conv_test',
      seq: 1,
      author_id: 'user_test',
      author_name: '成员',
      body: '禁止外发。'.repeat(1000),
      created_at: new Date(0).toISOString(),
    };
    const compacted = compactMessages([message], 0);
    expect(compacted.omitted_message_ids).not.toContain(message.id);
    expect(compacted.historical_excerpts[0].excerpt).toBe(message.body);
    expect(compacted.recent_messages).toHaveLength(0);
  });
});
