CREATE TABLE oidc_login_states(state_hash text PRIMARY KEY,nonce text NOT NULL,verifier text NOT NULL,expires_at timestamptz NOT NULL,used_at timestamptz);
CREATE TABLE oidc_identities(issuer text NOT NULL,subject text NOT NULL,user_id text NOT NULL REFERENCES users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(issuer,subject));
CREATE TABLE model_usage(id bigserial PRIMARY KEY,conversation_id text NOT NULL REFERENCES conversations(id),task_id text REFERENCES tasks(id),layer text NOT NULL CHECK(layer IN ('observation','execution')),model text NOT NULL,input_tokens bigint,output_tokens bigint,cost_usd numeric,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX usage_group_date ON model_usage(conversation_id,created_at);
-- 升级时保留既有未核清执行的资源占用，不因启用并行而绕过它们。
INSERT INTO execution_resource_claims(attempt_id,resource_key,mode,epoch)
 SELECT id,'project-code',CASE WHEN descriptor->>'execution_profile'='code_edit' THEN 'write' ELSE 'read' END,1
 FROM execution_attempts WHERE status IN ('dispatching','running','cancelling','uncertain')
 ON CONFLICT DO NOTHING;
