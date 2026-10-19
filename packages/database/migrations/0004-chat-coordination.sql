ALTER TABLE conversations ADD COLUMN visibility text NOT NULL DEFAULT 'project';
ALTER TABLE conversations ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN observed_seq integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]';
CREATE TABLE group_members (
 conversation_id text NOT NULL REFERENCES conversations(id), user_id text NOT NULL REFERENCES users(id),
 joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(conversation_id,user_id)
);
INSERT INTO group_members(conversation_id,user_id) SELECT c.id,u.id FROM conversations c CROSS JOIN users u WHERE u.active;
CREATE TABLE group_invites (
 token_hash text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id),
 created_by text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE coordinator_control (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), policy jsonb NOT NULL DEFAULT '{"enabled":false,"repository_id":"","allow_edit":false,"wall_time_seconds":300,"max_model_calls":8}', version integer NOT NULL DEFAULT 1
);
INSERT INTO coordinator_control(id) VALUES(true);
CREATE TABLE collaboration_goals (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), message_id text REFERENCES messages(id),
 title text NOT NULL, constraints jsonb NOT NULL DEFAULT '[]', acceptance jsonb NOT NULL DEFAULT '[]',
 canonical_key text NOT NULL, state text NOT NULL, decision text, reason text NOT NULL,
 related_goal_id text REFERENCES collaboration_goals(id), task_id text REFERENCES tasks(id), claimed_by text REFERENCES users(id),
 version integer NOT NULL DEFAULT 1, engine text NOT NULL DEFAULT 'rules', scope jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_effect_claim ON collaboration_goals(canonical_key) WHERE state IN ('CLAIMED','APPROVED','COMPLETED','STOPPING');
CREATE INDEX goal_group_order ON collaboration_goals(conversation_id,created_at,id);
CREATE TABLE goal_events (
 id bigserial PRIMARY KEY, goal_id text NOT NULL REFERENCES collaboration_goals(id), actor_id text NOT NULL,
 kind text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE observation_jobs (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversations(id), message_id text UNIQUE REFERENCES messages(id),
 actor_id text NOT NULL REFERENCES users(id), payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending',
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pending_observations ON observation_jobs(status,created_at);
