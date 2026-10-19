-- 保留 created_by 的历史含义，群管理移交使用独立字段。
ALTER TABLE conversations ADD COLUMN manager_id text REFERENCES users(id);
UPDATE conversations SET manager_id=created_by;
