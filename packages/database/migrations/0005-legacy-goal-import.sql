INSERT INTO collaboration_goals(id,conversation_id,title,canonical_key,state,decision,reason,task_id,created_at,updated_at)
SELECT 'goal_legacy_'||t.id,t.conversation_id,t.input->>'goal','legacy:'||t.id,
CASE t.state WHEN 'SUCCEEDED' THEN 'COMPLETED' WHEN 'REJECTED' THEN 'REJECTED' WHEN 'CANCELLED' THEN 'STOPPED' WHEN 'FAILED' THEN 'FAILED' WHEN 'EXPIRED' THEN 'FAILED' WHEN 'PENDING_APPROVAL' THEN 'CLARIFYING' WHEN 'DRAFT' THEN 'CANDIDATE' WHEN 'CANCEL_REQUESTED' THEN 'STOPPING' ELSE 'APPROVED' END,
CASE WHEN t.state='REJECTED' THEN 'REJECT' ELSE NULL END,
'迁移前已登记的工作，保留原执行与审批历史；待审批事项需按新版策略复核。',t.id,t.created_at,t.updated_at FROM tasks t
ON CONFLICT DO NOTHING;
