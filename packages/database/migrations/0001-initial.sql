CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK (role IN ('OWNER','MEMBER')), active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS single_owner ON users ((role)) WHERE role='OWNER' AND active;
CREATE TABLE IF NOT EXISTS sessions (
 id text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), csrf text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invitations (id text PRIMARY KEY,email text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz,created_by text NOT NULL REFERENCES users(id));
CREATE TABLE IF NOT EXISTS conversations (id text PRIMARY KEY,title text NOT NULL,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS messages (
 id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES conversations(id),seq integer NOT NULL,author_id text NOT NULL REFERENCES users(id),
 body text NOT NULL,client_message_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,seq),UNIQUE(conversation_id,author_id,client_message_id)
);
CREATE TABLE IF NOT EXISTS sources (id text PRIMARY KEY,name text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('shared','owner')),current_version integer NOT NULL DEFAULT 1,created_by text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS source_versions (source_id text NOT NULL REFERENCES sources(id),version integer NOT NULL,content text NOT NULL,content_hash text NOT NULL,PRIMARY KEY(source_id,version));
CREATE TABLE IF NOT EXISTS memories (id text PRIMARY KEY,title text NOT NULL,content text NOT NULL,status text NOT NULL DEFAULT 'candidate',source_refs jsonb NOT NULL,created_by text NOT NULL REFERENCES users(id),confirmed_by text REFERENCES users(id),version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS pairing_codes (id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE IF NOT EXISTS devices (
 id text PRIMARY KEY,owner_id text NOT NULL REFERENCES users(id),name text NOT NULL,public_key text NOT NULL,runtime text NOT NULL,
 adapter_version text NOT NULL,revoked boolean NOT NULL DEFAULT false,last_seen timestamptz,repositories jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS single_active_device ON devices ((revoked)) WHERE NOT revoked;
CREATE TABLE IF NOT EXISTS device_challenges (id text PRIMARY KEY,device_id text NOT NULL REFERENCES devices(id),nonce text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE IF NOT EXISTS device_sessions (id text PRIMARY KEY,device_id text NOT NULL REFERENCES devices(id),expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
 id text PRIMARY KEY,conversation_id text NOT NULL REFERENCES conversations(id),creator_id text NOT NULL REFERENCES users(id),state text NOT NULL,
 input_version integer NOT NULL DEFAULT 1,version integer NOT NULL DEFAULT 1,input jsonb NOT NULL,snapshot jsonb NOT NULL,approval jsonb,
 attempt_id text,error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS execution_attempts (
 id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id),device_id text NOT NULL REFERENCES devices(id),status text NOT NULL,
 last_seq integer NOT NULL DEFAULT 0,lease_until timestamptz,started_at timestamptz,stopped_at timestamptz,stop_evidence text,
 descriptor jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS single_unresolved_attempt ON execution_attempts ((true)) WHERE status IN ('dispatching','running','cancelling','uncertain');
CREATE TABLE IF NOT EXISTS execution_events (
 id bigserial PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id),attempt_id text REFERENCES execution_attempts(id),seq integer,
 type text NOT NULL,visibility text NOT NULL CHECK(visibility IN ('shared','owner')),payload jsonb NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(attempt_id,seq)
);
CREATE INDEX IF NOT EXISTS task_event_order ON execution_events(task_id,id);
CREATE TABLE IF NOT EXISTS artifacts (id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id),attempt_id text NOT NULL REFERENCES execution_attempts(id),kind text NOT NULL,title text NOT NULL,content text NOT NULL,published boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS audit_logs (id bigserial PRIMARY KEY,actor_id text NOT NULL,action text NOT NULL,object_id text NOT NULL,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS idempotency_records (scope text NOT NULL,key text NOT NULL,body_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(scope,key));
CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
