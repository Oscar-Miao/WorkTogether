CREATE INDEX IF NOT EXISTS conversation_history_position ON conversations(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS source_history_position ON sources(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS memory_history_position ON memories(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS task_history_position ON tasks(created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS task_conversation_history ON tasks(conversation_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS task_state_history ON tasks(state,created_at DESC,id DESC);
